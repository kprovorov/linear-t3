import type { ModelSelection } from "./config.ts";
import { stableUuid } from "./uuid.ts";

// Minimal client for the T3 Code server's WebSocket RPC (Effect RPC, JSON serialization).
//
// Auth: a bearer token (from `t3 auth session issue`) is exchanged for a one-time
// websocket ticket, which is passed as `?wsTicket=` when opening `/ws`.
//
// These are internal T3 Code APIs reverse-engineered from the web client
// (orchestration.subscribeShell / orchestration.launchThread); they may change
// between T3 Code releases.

export interface T3Project {
  id: string;
  title: string;
  workspaceRoot: string;
  defaultModelSelection: ModelSelection | null;
}

/** A thread in the shell snapshot, with the fields that tell whether it's a Running thread. */
export interface T3Thread {
  id: string;
  projectId: string;
  status: string;
  // preparing | starting | running | waiting (draining after the turn), or null when idle.
  activityRunStatus: string | null;
  // An approval or user-input wait. On its own it doesn't make a thread Running.
  pendingRuntimeRequest: unknown;
  pendingBackgroundTasks?: { kind: string }[];
}

// Background work that keeps a completed thread Running (T3's "background work holds completion").
const HOLDING_TASK_KINDS = new Set(["subagent", "monitor", "background_task"]);

/** Whether a snapshot thread is a Running thread (see CONTEXT.md). */
export function isRunningThread(thread: T3Thread): boolean {
  if (thread.activityRunStatus != null || thread.status === "queued") return true;
  return (
    thread.status === "completed" &&
    (thread.pendingBackgroundTasks ?? []).some((task) => HOLDING_TASK_KINDS.has(task.kind))
  );
}

/** The id `launchThread` gives the thread it starts under `idempotencyKey`. */
export function threadIdFor(idempotencyKey: string): string {
  return stableUuid(`${idempotencyKey}:thread`);
}

export interface T3Shell {
  projects: T3Project[];
  threads: T3Thread[];
}

export type WorkspaceStrategy =
  | { type: "root"; branch?: string }
  | { type: "worktree"; baseRef: string; branch?: string; startFromOrigin?: boolean };

export interface LaunchThreadInput {
  // Stable key for this launch. Retrying with the same key reuses the thread instead of creating another.
  idempotencyKey: string;
  projectId: string;
  title: string;
  modelSelection: ModelSelection;
  runtimeMode: string;
  interactionMode: string;
  workspaceStrategy: WorkspaceStrategy;
  message: string;
}

type ServerMessage =
  | { _tag: "Chunk"; requestId: string; values: unknown[] }
  | {
      _tag: "Exit";
      requestId: string;
      exit: { _tag: "Success"; value: unknown } | { _tag: "Failure"; cause: unknown };
    }
  | { _tag: "Defect"; defect: unknown }
  | { _tag: "ClientProtocolError"; error: unknown }
  | { _tag: "Pong" };

interface Pending {
  onChunk?: (values: unknown[]) => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

const REQUEST_TIMEOUT_MS = 120_000;
const CONNECT_TIMEOUT_MS = 15_000;
const ORCHESTRATION_PROTOCOL = 2;

/**
 * The server answered with a failure, so the request definitely did not succeed.
 * Other errors (timeouts, dropped sockets) leave the outcome unknown.
 */
export class T3RpcFailure extends Error {}

/** A launch failed and T3's state confirms the thread doesn't exist (never created, or deleted). */
export class T3ThreadNotCreated extends Error {}

interface ShellSnapshot extends T3Shell {
  // Only in some T3 versions; archived threads also come from getArchivedShellSnapshot.
  archivedThreads?: { id: string }[];
}

/** Asks T3 for a one-time websocket ticket: the first step of authenticating a bearer token. */
export function requestWebsocketTicket(
  baseUrl: string,
  token: string,
  signal: AbortSignal,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  return fetchFn(new URL("/api/auth/websocket-ticket", baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
}

/** An error message for a ticket response that wasn't a success, with the start of its body. */
export async function describeTicketFailure(res: Response): Promise<string> {
  return `T3 websocket ticket request failed (${res.status}): ${(await res.text()).slice(0, 300)}`;
}

export class T3Client {
  private readonly ws: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private closedError: Error | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => this.onMessage(event.data));
    ws.addEventListener("close", (event) => {
      this.closedError = new Error(
        `T3 socket closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
      );
      for (const p of this.pending.values()) p.reject(this.closedError);
      this.pending.clear();
    });
  }

  /** Connects to the T3 server. `signal` aborts the connection attempt. */
  static async connect(baseUrl: string, token: string, signal: AbortSignal): Promise<T3Client> {
    const res = await requestWebsocketTicket(
      baseUrl,
      token,
      AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
    );
    if (!res.ok) throw new Error(await describeTicketFailure(res));
    const { ticket } = (await res.json()) as { ticket: string };

    const url = new URL("/ws", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket);
    // Servers reject sockets that don't declare a protocol they support (426 orchestration_protocol_incompatible).
    url.searchParams.set("orchestrationProtocol", String(ORCHESTRATION_PROTOCOL));
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const handshake = AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener(
          "error",
          () => reject(new Error(`Could not connect to T3 at ${baseUrl}`)),
          { once: true },
        );
        handshake.addEventListener("abort", () => reject(handshake.reason), { once: true });
      });
    } catch (error) {
      ws.close();
      throw error;
    }
    return new T3Client(ws);
  }

  close(): void {
    this.ws.close();
  }

  private send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  private onMessage(data: unknown): void {
    const text = typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer);
    const parsed = JSON.parse(text) as ServerMessage | ServerMessage[];
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) {
      switch (msg._tag) {
        case "Chunk": {
          this.pending.get(msg.requestId)?.onChunk?.(msg.values);
          this.send({ _tag: "Ack", requestId: msg.requestId });
          break;
        }
        case "Exit": {
          const p = this.pending.get(msg.requestId);
          if (!p) break;
          this.pending.delete(msg.requestId);
          if (msg.exit._tag === "Success") p.resolve(msg.exit.value);
          else p.reject(new T3RpcFailure(`T3 RPC failed: ${JSON.stringify(msg.exit.cause)}`));
          break;
        }
        case "Defect":
        case "ClientProtocolError": {
          const error = new Error(`T3 RPC protocol error: ${JSON.stringify(msg)}`);
          for (const p of this.pending.values()) p.reject(error);
          this.pending.clear();
          break;
        }
      }
    }
  }

  private call(
    tag: string,
    payload: unknown,
    onChunk?: (values: unknown[]) => void,
  ): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`T3 RPC ${tag} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        onChunk,
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send({ _tag: "Request", id, tag, payload, headers: [] });
    });
  }

  private interrupt(requestId: string): void {
    // Settle the call so its timeout timer is cleared.
    this.pending.get(requestId)?.resolve(undefined);
    this.pending.delete(requestId);
    this.send({ _tag: "Interrupt", requestId, interruptors: [] });
  }

  /** Reads the first snapshot of a shell subscription, then stops it. */
  private shellSnapshot(): Promise<ShellSnapshot> {
    const requestId = String(this.nextId);
    return new Promise((resolve, reject) => {
      this.call("orchestration.subscribeShell", {}, (values) => {
        for (const value of values as { kind: string; snapshot?: ShellSnapshot }[]) {
          if (value.kind === "snapshot" && value.snapshot) {
            this.interrupt(requestId);
            resolve(value.snapshot);
            return;
          }
        }
      }).then(() => reject(new Error("T3 shell subscription ended without a snapshot")), reject);
    });
  }

  /** T3's projects and unarchived threads, from one snapshot. */
  async readShell(): Promise<T3Shell> {
    const { projects, threads } = await this.shellSnapshot();
    return { projects, threads };
  }

  /** Whether T3 has the thread, active or archived. Deleted threads are absent from both snapshots. */
  private async threadExists(threadId: string): Promise<boolean> {
    const active = await this.shellSnapshot();
    const archived = (await this.call("orchestration.getArchivedShellSnapshot", {})) as {
      threads: { id: string }[];
    };
    return [...active.threads, ...(active.archivedThreads ?? []), ...archived.threads].some(
      (t) => t.id === threadId,
    );
  }

  /**
   * Starts a thread. Throws T3ThreadNotCreated only when the launch failed and the thread is
   * confirmed absent, so it's safe to retry under a new idempotency key. Any other error means
   * the thread may exist, and a retry must reuse the same key.
   */
  async launchThread(input: LaunchThreadInput): Promise<{ threadId: string; resumed: boolean }> {
    const threadId = threadIdFor(input.idempotencyKey);
    try {
      return await this.launch(threadId, input);
    } catch (error) {
      if (error instanceof T3RpcFailure && !(await this.threadExists(threadId).catch(() => true))) {
        throw new T3ThreadNotCreated(error.message);
      }
      throw error;
    }
  }

  private async launch(
    threadId: string,
    input: LaunchThreadInput,
  ): Promise<{ threadId: string; resumed: boolean }> {
    const result = (await this.call("orchestration.launchThread", {
      // T3 keeps a receipt per command id, so retrying with the same id after a lost response
      // returns the thread the first attempt created instead of creating another.
      // (Don't send reuseExistingThread: it means "start a run in an existing empty thread".)
      commandId: stableUuid(`${input.idempotencyKey}:command`),
      creationSource: "server",
      threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      workspaceStrategy: input.workspaceStrategy,
      initialMessage: {
        messageId: stableUuid(`${input.idempotencyKey}:message`),
        text: input.message,
        attachments: [],
      },
    })) as { threadId: string; resumed: boolean };
    return { threadId: result.threadId, resumed: result.resumed };
  }
}
