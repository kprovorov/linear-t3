const ENDPOINT = "https://api.linear.app/graphql";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  branchName: string;
  team: { id: string; key: string };
}

export class LinearClient {
  private readonly apiKey: string;
  private readonly stateIds = new Map<string, Map<string, string>>();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: this.apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length) {
      const detail = body.errors?.map((e) => e.message).join("; ") ?? res.statusText;
      throw new Error(`Linear API error (${res.status}): ${detail}`);
    }
    return body.data as T;
  }

  async listIssues(filter: Record<string, unknown>): Promise<LinearIssue[]> {
    const issues: LinearIssue[] = [];
    let after: string | null = null;
    do {
      const data: {
        issues: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
      } = await this.request(
        `query Issues($filter: IssueFilter, $after: String) {
          issues(filter: $filter, first: 50, after: $after, orderBy: createdAt) {
            nodes { id identifier title description url branchName team { id key } }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter, after },
      );
      issues.push(...data.issues.nodes);
      after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
    } while (after);
    return issues;
  }

  async moveToState(issue: LinearIssue, stateName: string): Promise<void> {
    let states = this.stateIds.get(issue.team.id);
    if (!states) {
      const data = await this.request<{ team: { states: { nodes: { id: string; name: string }[] } } }>(
        `query States($id: String!) { team(id: $id) { states { nodes { id name } } } }`,
        { id: issue.team.id },
      );
      states = new Map(data.team.states.nodes.map((s) => [s.name.toLowerCase(), s.id]));
      this.stateIds.set(issue.team.id, states);
    }
    const stateId = states.get(stateName.toLowerCase());
    if (!stateId) throw new Error(`Team ${issue.team.key} has no workflow state named "${stateName}"`);
    await this.request(
      `mutation Move($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`,
      { id: issue.id, stateId },
    );
  }

  async comment(issueId: string, body: string): Promise<void> {
    await this.request(
      `mutation Comment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }`,
      { issueId, body },
    );
  }
}
