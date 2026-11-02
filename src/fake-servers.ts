// Local stand-ins for Linear and T3 Code, for tests that run the CLI as a separate process.
import { createHash } from "node:crypto";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

export interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
  /** Linear priority: 0 No priority, 1 Urgent … 4 Low. Default 0. */
  priority?: number;
  /** ISO timestamp. Default the epoch. */
  createdAt?: string;
  /** Team key. When set, the issue only matches queries filtered to this team. */
  team?: string;
  /** Workflow status name, one of the team's statuses. Default "Todo". */
  status?: string;
  /** Label names, each one of the team's labels. */
  labels?: string[];
  /** The assignee's email. Unset: unassigned. */
  assignee?: string;
}

/** A workflow status of the fake team. */
export interface FakeStatus {
  name: string;
  type: "triage" | "backlog" | "unstarted" | "started" | "completed" | "canceled";
}

/** The key of the one team the fake has statuses and labels for. */
export const FAKE_TEAM = "ENG";

export const FAKE_STATUSES: FakeStatus[] = [
  { name: "Backlog", type: "backlog" },
  { name: "Todo", type: "unstarted" },
  { name: "In Progress", type: "started" },
  { name: "Done", type: "completed" },
];

/** The user who owns the fake Linear's token. */
export const FAKE_VIEWER = { id: "user-1", name: "Ada", email: "ada@example.com" };

class UnsupportedFilter extends Error {}

/** One field's comparator: `{ eq }`, `{ eqIgnoreCase }` or `{ in }`, nothing else. */
function compare(value: string, comparator: unknown, path: string): boolean {
  const entries = Object.entries(comparator as Record<string, unknown>);
  return entries.every(([op, operand]) => {
    if (op === "eq") return value === operand;
    if (op === "eqIgnoreCase" && typeof operand === "string") {
      return value.toLowerCase() === operand.toLowerCase();
    }
    if (op === "in" && Array.isArray(operand)) return operand.includes(value);
    throw new UnsupportedFilter(`${path}.${op}`);
  });
}

/**
 * Whether `issue` matches a Linear `IssueFilter`. Only the criteria the Daemon sends are
 * understood; any other throws, so a filter the fake can't read never matches everything.
 */
function matches(issue: FakeIssue, filter: unknown, statuses: FakeStatus[]): boolean {
  return Object.entries((filter ?? {}) as Record<string, unknown>).every(([field, value]) => {
    const criteria = value as Record<string, unknown>;
    switch (field) {
      case "and":
        return (value as unknown[]).every((clause) => matches(issue, clause, statuses));
      case "or":
        return (value as unknown[]).some((clause) => matches(issue, clause, statuses));
      case "team":
        return Object.entries(criteria).every(([key, comparator]) => {
          if (key !== "key") throw new UnsupportedFilter(`team.${key}`);
          return issue.team === undefined || compare(issue.team, comparator, "team.key");
        });
      case "state": {
        const name = issue.status ?? "Todo";
        const status = statuses.find((s) => s.name === name);
        if (!status) throw new Error(`Fake issue ${issue.identifier} has unknown status ${name}`);
        return Object.entries(criteria).every(([key, comparator]) => {
          if (key === "name") return compare(name, comparator, "state.name");
          if (key === "type") return compare(status.type, comparator, "state.type");
          throw new UnsupportedFilter(`state.${key}`);
        });
      }
      case "labels":
        return Object.entries(criteria).every(([key, labelFilter]) => {
          if (key !== "some") throw new UnsupportedFilter(`labels.${key}`);
          return (issue.labels ?? []).some((label) =>
            Object.entries(labelFilter as Record<string, unknown>).every(
              ([labelKey, comparator]) => {
                if (labelKey !== "name") throw new UnsupportedFilter(`labels.some.${labelKey}`);
                return compare(label, comparator, "labels.some.name");
              },
            ),
          );
        });
      case "assignee":
        return Object.entries(criteria).every(([key, comparator]) => {
          if (key === "null") return (issue.assignee === undefined) === comparator;
          if (issue.assignee === undefined) return false;
          if (key === "email") return compare(issue.assignee, comparator, "assignee.email");
          if (key === "isMe") {
            const { eq, ...rest } = comparator as { eq?: unknown };
            if (typeof eq !== "boolean" || Object.keys(rest).length > 0) {
              throw new UnsupportedFilter("assignee.isMe");
            }
            return (issue.assignee === FAKE_VIEWER.email) === eq;
          }
          throw new UnsupportedFilter(`assignee.${key}`);
        });
      case "priority":
        return Object.entries(criteria).every(([op, operand]) => {
          const priority = issue.priority ?? 0;
          if (op === "gte" && typeof operand === "number") return priority >= operand;
          if (op === "lte" && typeof operand === "number") return priority <= operand;
          throw new UnsupportedFilter(`priority.${op}`);
        });
      default:
        throw new UnsupportedFilter(field);
    }
  });
}

/** One page holding every node, as a Linear connection. */
const connection = <T>(nodes: T[]) => ({
  nodes,
  pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null },
});

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * A Linear GraphQL API for one team that answers the viewer query with a fixed user, creates
 * comments, lists the team's workflow statuses and labels, and answers every other query with the
 * `issues` that match its filter. With `apiKey` set, any other key gets Linear's authentication
 * error.
 */
export async function fakeLinear(
  issues: FakeIssue[],
  {
    apiKey,
    statuses = FAKE_STATUSES,
    labels = [],
    users = [FAKE_VIEWER],
  }: {
    apiKey?: string;
    statuses?: FakeStatus[];
    labels?: string[];
    /** The workspace's users, found by email. */
    users?: { id: string; email: string }[];
  } = {},
) {
  const queries: string[] = [];
  // The input of each comment created.
  const comments: { id?: string; issueId?: string; body?: string }[] = [];
  // The API key each request was sent with.
  const apiKeys: (string | undefined)[] = [];
  // The filter each issues query was sent with.
  const filters: unknown[] = [];
  const server = createServer(async (req, res) => {
    const { query, variables } = JSON.parse(await readBody(req)) as {
      query: string;
      variables?: unknown;
    };
    queries.push(query);
    apiKeys.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    if (apiKey !== undefined && req.headers.authorization !== apiKey) {
      res.statusCode = 400;
      const extensions = { type: "authentication error", code: "AUTHENTICATION_ERROR" };
      res.end(JSON.stringify({ errors: [{ message: "Authentication required", extensions }] }));
      return;
    }
    if (/\bviewer\b/.test(query)) {
      res.end(JSON.stringify({ data: { viewer: FAKE_VIEWER } }));
      return;
    }
    if (/\bcommentCreate\b/.test(query)) {
      const { input } = variables as { input: (typeof comments)[number] };
      comments.push(input);
      const commentCreate = { success: true, lastSyncId: 0, comment: { id: input.id } };
      res.end(JSON.stringify({ data: { commentCreate } }));
      return;
    }
    if (/\busers\b/.test(query)) {
      const { email } = variables as { email?: string };
      const nodes = users
        .filter((user) => user.email.toLowerCase() === email?.toLowerCase())
        .map(({ id }) => ({ id }));
      res.end(JSON.stringify({ data: { users: connection(nodes) } }));
      return;
    }
    if (/\bworkflowStates\b/.test(query)) {
      const { team } = variables as { team?: string };
      const nodes = team === FAKE_TEAM ? statuses : [];
      res.end(JSON.stringify({ data: { workflowStates: connection(nodes) } }));
      return;
    }
    if (/\bissueLabels\b/.test(query)) {
      const { team } = variables as { team?: string };
      const nodes = team === FAKE_TEAM ? labels.map((name) => ({ name })) : [];
      res.end(JSON.stringify({ data: { issueLabels: connection(nodes) } }));
      return;
    }
    const filter = (variables as { filter?: unknown } | undefined)?.filter;
    filters.push(filter);
    let matching: FakeIssue[];
    try {
      matching = issues.filter((issue) => matches(issue, filter, statuses));
    } catch (error) {
      if (!(error instanceof UnsupportedFilter)) throw error;
      res.statusCode = 400;
      const message = `The fake Linear doesn't support the filter criterion ${error.message}`;
      res.end(JSON.stringify({ errors: [{ message }] }));
      return;
    }
    const nodes = matching.map((issue) => ({
      url: `https://linear.app/acme/issue/${issue.identifier}`,
      description: null,
      branchName: issue.identifier.toLowerCase(),
      priority: 0,
      createdAt: new Date(0).toISOString(),
      ...issue,
      // These aren't the SDK's team, state and label objects, so leave them out.
      team: undefined,
      status: undefined,
      labels: undefined,
      assignee: undefined,
      updatedAt: new Date(0).toISOString(),
      // The SDK's Issue model reads these unconditionally.
      sharedAccess: { isShared: false, sharedWithCount: 0, sharedWithUsers: [] },
      reactions: [],
    }));
    res.end(
      JSON.stringify({
        data: {
          issues: { nodes, pageInfo: { hasNextPage: false, hasPreviousPage: false } },
        },
      }),
    );
  });
  const url = await listen(server);
  return {
    url: `${url}/graphql`,
    queries,
    apiKeys,
    comments,
    filters,
    close: () => server.close(),
  };
}

// Just enough of RFC 6455 for one client: unfragmented text frames, client frames masked.
function encodeFrame(text: string): Buffer {
  const payload = Buffer.from(text);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

/** Splits `buffer` into complete frames; returns their opcodes and payloads and the leftover bytes. */
function decodeFrames(buffer: Buffer): {
  frames: { opcode: number; text: string }[];
  rest: Buffer;
} {
  const frames: { opcode: number; text: string }[] = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset]! & 0x0f;
    let length = buffer[offset + 1]! & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }
    const start = offset + headerLength + 4;
    if (buffer.length < start + length) break;
    const mask = buffer.subarray(offset + headerLength, start);
    const payload = Buffer.from(buffer.subarray(start, start + length));
    for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i % 4]!;
    frames.push({ opcode, text: payload.toString("utf8") });
    offset = start + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

interface RpcRequest {
  _tag: string;
  id: string;
  tag: string;
  payload: Record<string, unknown>;
}

/** A thread in the shell snapshot, with T3 0.1.0's run-state fields. */
export interface FakeThread {
  id: string;
  projectId: string;
  status?: string;
  activityRunStatus?: string | null;
  pendingRuntimeRequest?: { kind: string } | null;
  pendingBackgroundTasks?: { taskId: string; kind: string }[];
}

export interface FakeT3Options {
  /** Read at each snapshot, so a test can add projects once it knows their folders. */
  projects: {
    id: string;
    title: string;
    workspaceRoot: string;
    defaultModelSelection?: { instanceId: string; model: string; options?: unknown };
  }[];
  /**
   * The snapshot's threads, read at each snapshot so a test can change them between polls. A
   * launch adds its thread here as running, as T3 does once it creates the thread.
   */
  threads?: FakeThread[];
  /** When set, the ticket endpoint answers 401 to any other bearer token. */
  token?: string;
  /** Called for each launch; the launch succeeds once it resolves. */
  onLaunch?: (payload: Record<string, unknown>) => Promise<void>;
  /**
   * The Git refs `vcs.listRefs` reports for every folder, one page at a time, as T3 0.1.6 does.
   * Defaults to one page holding a default `main`. `null`: a T3 without `vcs.listRefs`.
   */
  refPages?: FakeRef[][] | null;
  /**
   * The Providers `server.getConfig` reports, as T3 0.1.6 does. Defaults to `DEFAULT_PROVIDERS`.
   * `null`: a T3 without `server.getConfig`.
   */
  providers?: FakeProvider[] | null;
}

export interface FakeModel {
  slug: string;
  name: string;
  aliases?: string[];
}

export interface FakeProvider {
  instanceId: string;
  displayName?: string;
  enabled?: boolean;
  models: FakeModel[];
}

/** Claude and Codex, both enabled, with some of their models. */
export const DEFAULT_PROVIDERS: FakeProvider[] = [
  {
    instanceId: "claudeAgent",
    displayName: "Claude",
    models: [
      {
        slug: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        aliases: ["opus", "opus-5.5", "claude-opus-5.5"],
      },
      {
        slug: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        aliases: ["sonnet", "sonnet-5.5", "claude-sonnet-5.5"],
      },
    ],
  },
  { instanceId: "codex", displayName: "Codex", models: [{ slug: "gpt-5.5", name: "GPT-5.5" }] },
];

export interface FakeRef {
  name: string;
  isDefault?: boolean;
}

/** A T3 Code server: the websocket ticket endpoint plus the shell and launch RPCs. */
export async function fakeT3({
  projects,
  threads = [],
  token,
  onLaunch,
  refPages = [[{ name: "main", isDefault: true }]],
  providers = DEFAULT_PROVIDERS,
}: FakeT3Options) {
  const requests: string[] = [];
  // Every RPC received, in order.
  const rpcs: { tag: string; payload: Record<string, unknown> }[] = [];
  const launches: Record<string, unknown>[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === "POST" && req.url === "/api/auth/websocket-ticket") {
      if (token !== undefined && req.headers.authorization !== `Bearer ${token}`) {
        res.statusCode = 401;
        res.end();
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ticket: "ticket" }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    requests.push(`WS ${req.url}`);
    sockets.add(socket);
    const accept = createHash("sha1")
      .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const send = (message: unknown) => socket.write(encodeFrame(JSON.stringify(message)));
    const exit = (requestId: string, value: unknown) =>
      send({ _tag: "Exit", requestId, exit: { _tag: "Success", value } });

    let buffered: Buffer = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      const { frames, rest } = decodeFrames(Buffer.concat([buffered, data]));
      buffered = rest;
      for (const { opcode, text } of frames) {
        if (opcode === 0x8) {
          socket.end(Buffer.from([0x88, 0]));
          continue;
        }
        if (opcode !== 0x1) continue;
        const message = JSON.parse(text) as RpcRequest;
        if (message._tag !== "Request") continue;
        rpcs.push({ tag: message.tag, payload: message.payload });
        if (message.tag === "orchestration.subscribeShell") {
          const snapshot = {
            projects,
            threads: threads.map((thread) => ({
              status: "completed",
              activityRunStatus: null,
              pendingRuntimeRequest: null,
              ...thread,
            })),
          };
          send({ _tag: "Chunk", requestId: message.id, values: [{ kind: "snapshot", snapshot }] });
        } else if (message.tag === "orchestration.launchThread") {
          launches.push(message.payload);
          const { threadId, projectId } = message.payload as {
            threadId: string;
            projectId: string;
          };
          if (!threads.some((t) => t.id === threadId)) {
            threads.push({ id: threadId, projectId, activityRunStatus: "running" });
          }
          void (onLaunch?.(message.payload) ?? Promise.resolve()).then(() =>
            exit(message.id, { threadId: message.payload.threadId, resumed: false }),
          );
        } else if (message.tag === "vcs.listRefs" && refPages) {
          const { cwd, cursor = 0 } = message.payload as { cwd: string; cursor?: number };
          const page = refPages[cursor] ?? [];
          exit(message.id, {
            isRepo: true,
            hasPrimaryRemote: true,
            refs: page.map((ref) => ({
              current: false,
              isDefault: false,
              worktreePath: ref.isDefault ? cwd : null,
              ...ref,
            })),
            nextCursor: cursor + 1 < refPages.length ? cursor + 1 : null,
            totalCount: refPages.flat().length,
          });
        } else if (message.tag === "server.getConfig" && providers) {
          exit(message.id, {
            providers: providers.map(({ instanceId, displayName, enabled = true, models }) => ({
              instanceId,
              driver: instanceId,
              displayName: displayName ?? instanceId,
              enabled,
              status: enabled ? "ready" : "disabled",
              models: models.map((model) => ({ isCustom: false, capabilities: {}, ...model })),
            })),
            settings: {},
          });
        } else {
          // What T3 0.1.6 answers to a request tag it doesn't have.
          send({
            _tag: "Exit",
            requestId: message.id,
            exit: {
              _tag: "Failure",
              cause: [{ _tag: "Die", defect: `Unknown request tag: ${message.tag}` }],
            },
          });
        }
      }
    });
    socket.on("error", () => {});
  });

  const url = await listen(server);
  return {
    url,
    requests,
    rpcs,
    launches,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}
