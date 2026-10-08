import { LinearClient, LinearDocument, type Issue } from "@linear/sdk";

export { LinearClient, type Issue };

export async function listIssues(client: LinearClient, filter: LinearDocument.IssueFilter): Promise<Issue[]> {
  const issues = await client.issues({ filter, first: 50, orderBy: LinearDocument.PaginationOrderBy.CreatedAt });
  // fetchNext() appends the next page to `nodes`.
  while (issues.pageInfo.hasNextPage) await issues.fetchNext();
  return issues.nodes;
}

const stateIdsByTeam = new Map<string, Map<string, string>>();

export async function moveToState(client: LinearClient, issue: Issue, stateName: string): Promise<void> {
  const teamId = issue.teamId;
  if (!teamId) throw new Error(`Issue ${issue.identifier} has no team`);
  let states = stateIdsByTeam.get(teamId);
  if (!states) {
    const { nodes } = await (await client.team(teamId)).states();
    states = new Map(nodes.map((s) => [s.name.toLowerCase(), s.id]));
    stateIdsByTeam.set(teamId, states);
  }
  const stateId = states.get(stateName.toLowerCase());
  if (!stateId) throw new Error(`Issue ${issue.identifier}'s team has no workflow state named "${stateName}"`);
  await client.updateIssue(issue.id, { stateId });
}
