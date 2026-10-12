import { LinearClient, LinearDocument, type Issue } from "@linear/sdk";

export { LinearClient, type Issue, type LinearDocument };

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * A Linear client whose requests time out, and abort when `signal` does. The SDK sets no timeout,
 * so a stalled connection would hang the poll loop forever.
 */
export function createLinearClient(apiKey: string, signal: AbortSignal): LinearClient {
  const client = new LinearClient({ apiKey });
  // The SDK spreads `options` into every fetch() call, so a getter yields a fresh signal per request.
  Object.defineProperty(client.options, "signal", {
    enumerable: true,
    get: () => AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  return client;
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
