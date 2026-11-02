import { LinearClient, LinearDocument, type Issue } from "@linear/sdk";

export { LinearClient, type Issue, type LinearDocument };

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * A Linear client whose requests time out, and abort when `signal` does. The SDK sets no timeout,
 * so a stalled connection would hang the poll loop forever.
 */
export function createLinearClient(apiKey: string, signal: AbortSignal): LinearClient {
  // LINEAR_API_URL points the Daemon at another GraphQL endpoint, such as a local fake in tests.
  const client = new LinearClient({ apiKey, apiUrl: process.env.LINEAR_API_URL || undefined });
  // The SDK spreads `options` into every fetch() call, so a getter yields a fresh signal per request.
  Object.defineProperty(client.options, "signal", {
    enumerable: true,
    get: () => AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  return client;
}

/** Every node of a connection the query `field` returns, page by page. */
async function readAll<T>(
  client: LinearClient,
  field: string,
  query: string,
  variables: Record<string, unknown>,
  signal: AbortSignal,
): Promise<T[]> {
  type Page = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
  const nodes: T[] = [];
  let after: string | null = null;
  do {
    signal.throwIfAborted();
    const response: { data?: Record<string, Page> } = await client.client.rawRequest<
      Record<string, Page>,
      Record<string, unknown>
    >(query, { ...variables, after });
    const page: Page | undefined = response.data?.[field];
    if (!page) throw new Error(`Linear returned no ${field}`);
    nodes.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

const TEAM_STATUSES = `query TeamStatuses($team: String!, $after: String) {
  workflowStates(filter: { team: { key: { eq: $team } } }, first: 250, after: $after) {
    nodes { name }
    pageInfo { hasNextPage endCursor }
  }
}`;

// A team's issues can carry its own labels and the workspace's, which belong to no team. A label
// group is never on an issue itself, only its labels are, so groups aren't valid names.
const TEAM_LABELS = `query TeamLabels($team: String!, $after: String) {
  issueLabels(
    filter: {
      or: [{ team: { key: { eq: $team } } }, { team: { null: true } }]
      isGroup: { eq: false }
    }
    first: 250
    after: $after
  ) {
    nodes { name }
    pageInfo { hasNextPage endCursor }
  }
}`;

/**
 * Each of `names` as the team spells it, matched ignoring case. A name that matches nothing is an
 * error listing the valid names.
 */
function resolveNames(
  names: string[],
  valid: string[],
  what: { one: string; many: string; team: string },
): string[] {
  const byLowerCase = new Map(valid.map((name) => [name.toLowerCase(), name]));
  const unknown = names.filter((name) => !byLowerCase.has(name.toLowerCase()));
  if (unknown.length > 0) {
    const list = unknown.map((name) => `"${name}"`).join(", ");
    const sorted = [...byLowerCase.values()].sort((a, b) => a.localeCompare(b));
    throw new Error(
      `Team ${what.team} has no ${what.one} named ${list}. Valid ${what.many}: ${sorted.length > 0 ? sorted.join(", ") : "none"}`,
    );
  }
  return [...new Set(names.map((name) => byLowerCase.get(name.toLowerCase())!))];
}

/**
 * The `IssueFilter` for a team's issues that are in any of `status` and carry all of `label`,
 * ANDed with `filter`. Status and label names are checked against the team first. The filter
 * names them rather than holding their ids, so a status or label deleted and made again still
 * matches.
 */
export async function teamIssueFilter(
  client: LinearClient,
  {
    team,
    status,
    label,
    filter,
  }: { team: string; status?: string[]; label?: string[]; filter?: Record<string, unknown> },
  signal: AbortSignal,
): Promise<LinearDocument.IssueFilter> {
  const read = (field: string, query: string) =>
    readAll<{ name: string }>(client, field, query, { team }, signal).then((nodes) =>
      nodes.map((node) => node.name),
    );
  const [statuses, labels] = await Promise.all([
    status && read("workflowStates", TEAM_STATUSES),
    label && read("issueLabels", TEAM_LABELS),
  ]);
  // Every team has workflow statuses, so none means there's no such team.
  if (statuses?.length === 0) throw new Error(`No Linear team has the key "${team}"`);

  const clauses: Record<string, unknown>[] = [{ team: { key: { eq: team } } }];
  if (status && statuses) {
    const names = resolveNames(status, statuses, { one: "status", many: "statuses", team });
    clauses.push({ state: { name: { in: names } } });
  }
  if (label && labels) {
    for (const name of resolveNames(label, labels, { one: "label", many: "labels", team })) {
      clauses.push({ labels: { some: { name: { eqIgnoreCase: name } } } });
    }
  }
  clauses.push(filter ?? {});
  return { and: clauses } as LinearDocument.IssueFilter;
}

export async function listIssues(
  client: LinearClient,
  filter: LinearDocument.IssueFilter,
  signal: AbortSignal,
): Promise<Issue[]> {
  const issues = await client.issues({
    filter,
    first: 50,
    orderBy: LinearDocument.PaginationOrderBy.CreatedAt,
  });
  // fetchNext() appends the next page to `nodes`.
  while (issues.pageInfo.hasNextPage) {
    signal.throwIfAborted();
    await issues.fetchNext();
  }
  return issues.nodes;
}

/**
 * Creates a comment with a caller-chosen id. Retrying with the same id never duplicates it:
 * if the create fails, it checks whether a comment with that id already exists.
 */
export async function createCommentOnce(
  client: LinearClient,
  id: string,
  issueId: string,
  body: string,
): Promise<void> {
  try {
    const { success } = await client.createComment({ id, issueId, body });
    if (!success) throw new Error("Linear did not create the comment");
  } catch (error) {
    const existing = await client.comment({ id }).catch(() => null);
    if (!existing) throw error;
  }
}

const stateIdsByTeam = new Map<string, Map<string, string>>();

export async function moveToState(
  client: LinearClient,
  issue: Issue,
  stateName: string,
): Promise<void> {
  const teamId = issue.teamId;
  if (!teamId) throw new Error(`Issue ${issue.identifier} has no team`);
  let states = stateIdsByTeam.get(teamId);
  if (!states) {
    const { nodes } = await (await client.team(teamId)).states();
    states = new Map(nodes.map((s) => [s.name.toLowerCase(), s.id]));
    stateIdsByTeam.set(teamId, states);
  }
  try {
    const stateId = states.get(stateName.toLowerCase());
    if (!stateId)
      throw new Error(
        `Issue ${issue.identifier}'s team has no workflow state named "${stateName}"`,
      );
    const { success } = await client.updateIssue(issue.id, { stateId });
    if (!success) throw new Error(`Linear did not apply the state change for ${issue.identifier}`);
  } catch (error) {
    // The team's workflow may have changed; refetch its states on the next attempt.
    stateIdsByTeam.delete(teamId);
    throw error;
  }
}
