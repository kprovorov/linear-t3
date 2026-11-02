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

// Deactivated users still hold issues, so they count.
const USERS_BY_EMAIL = `query UsersByEmail($email: String!, $after: String) {
  users(filter: { email: { eqIgnoreCase: $email } }, includeDisabled: true, first: 250, after: $after) {
    nodes { id }
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
 * Checks `config`'s status, label and setStatus names against the team, ignoring case, and an
 * assignee email against the workspace's users, before the first poll. Returns `setStatus` as the
 * team spells it, and the `IssueFilter` for the team's issues that are in any of `status`, carry
 * all of `label`, have `assignee` (`me`, `none` or an email) and are at `priority` or more urgent,
 * ANDed with `filter`. The filter names statuses and labels rather than holding their ids, so one
 * deleted and made again still matches.
 */
export async function checkTeam(
  client: LinearClient,
  {
    team,
    status,
    label,
    assignee,
    priority,
    filter,
    setStatus,
  }: {
    team: string;
    status?: string[];
    label?: string[];
    assignee?: string;
    priority?: number;
    filter?: Record<string, unknown>;
    setStatus: string | false;
  },
  signal: AbortSignal,
): Promise<{ filter: LinearDocument.IssueFilter; setStatus: string | false }> {
  const read = (field: string, query: string) =>
    readAll<{ name: string }>(client, field, query, { team }, signal).then((nodes) =>
      nodes.map((node) => node.name),
    );
  const email = assignee !== "me" && assignee !== "none" ? assignee : undefined;
  const [statuses, labels, users] = await Promise.all([
    status !== undefined || setStatus !== false ? read("workflowStates", TEAM_STATUSES) : undefined,
    label && read("issueLabels", TEAM_LABELS),
    email && readAll<{ id: string }>(client, "users", USERS_BY_EMAIL, { email }, signal),
  ]);
  // Every team has workflow statuses, so none means there's no such team.
  if (statuses?.length === 0) throw new Error(`No Linear team has the key "${team}"`);
  if (users?.length === 0) throw new Error(`No Linear user has the email "${email}"`);
  const statusNames = { one: "status", many: "statuses", team };

  const clauses: Record<string, unknown>[] = [{ team: { key: { eq: team } } }];
  if (status && statuses) {
    clauses.push({ state: { name: { in: resolveNames(status, statuses, statusNames) } } });
  }
  if (label && labels) {
    for (const name of resolveNames(label, labels, { one: "label", many: "labels", team })) {
      clauses.push({ labels: { some: { name: { eqIgnoreCase: name } } } });
    }
  }
  if (assignee === "me") clauses.push({ assignee: { isMe: { eq: true } } });
  else if (assignee === "none") clauses.push({ assignee: { null: true } });
  else if (assignee) clauses.push({ assignee: { email: { eqIgnoreCase: assignee } } });
  // Linear's "No priority" is 0, so starting at 1 leaves it out.
  if (priority) clauses.push({ priority: { gte: 1, lte: priority } });
  clauses.push(filter ?? {});

  let resolvedSetStatus: string | false = false;
  if (setStatus && statuses) {
    try {
      [resolvedSetStatus] = resolveNames([setStatus], statuses, statusNames);
    } catch (error) {
      throw new Error(
        `${(error as Error).message}. Pick the status to move launched issues to with --set-status <name>, or leave it alone with --set-status false`,
      );
    }
  }
  return { filter: { and: clauses } as LinearDocument.IssueFilter, setStatus: resolvedSetStatus };
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

const ISSUE_TEAM_STATUSES = `query IssueTeamStatuses($id: String!) {
  issue(id: $id) {
    identifier
    team { states(first: 250) { nodes { id name } } }
  }
}`;

const MOVE_ISSUE = `mutation MoveIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`;

/**
 * Moves an issue to the workflow status of its team named `statusName`, matched ignoring case. The
 * team's statuses are read each time, so a status renamed since the launch is reported, not
 * guessed.
 */
export async function moveToState(
  client: LinearClient,
  issueId: string,
  statusName: string,
): Promise<void> {
  type Statuses = {
    issue: { identifier: string; team: { states: { nodes: { id: string; name: string }[] } } };
  };
  const { data } = await client.client.rawRequest<Statuses, { id: string }>(ISSUE_TEAM_STATUSES, {
    id: issueId,
  });
  if (!data?.issue) throw new Error(`Linear has no issue ${issueId}`);
  const { identifier, team } = data.issue;
  const wanted = statusName.toLowerCase();
  const stateId = team.states.nodes.find((s) => s.name.toLowerCase() === wanted)?.id;
  if (!stateId)
    throw new Error(`${identifier}'s team has no workflow status named "${statusName}"`);
  const response = await client.client.rawRequest<
    { issueUpdate: { success: boolean } },
    { id: string; stateId: string }
  >(MOVE_ISSUE, { id: issueId, stateId });
  if (!response.data?.issueUpdate.success) {
    throw new Error(`Linear did not apply the status change for ${identifier}`);
  }
}
