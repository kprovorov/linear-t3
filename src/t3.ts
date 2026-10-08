import { randomUUID } from "node:crypto";
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
  | { _tag: "Exit"; requestId: string; exit: { _tag: "Success"; value: unknown } | { _tag: "Failure"; cause: unknown } }
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

/**
 * The server answered with a failure, so the request definitely did not succeed.
 * Other errors (timeouts, dropped sockets) leave the outcome unknown.
 */
export class T3RpcFailure extends Error {}

export class T3Client {
  private readonly ws: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private closedError: Error | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (event) => this.onMessage(event.data));
    ws.addEventListener("close", (event) => {
      this.closedError = new Error(`T3 socket closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`);
      for (const p of this.pending.values()) p.reject(this.closedError);
      this.pending.clear();
    });
  }

  /** Connects to the T3 server. `signal` aborts the connection attempt. */
  static async connect(baseUrl: string, token: string, signal: AbortSignal): Promise<T3Client> {
    const res = await fetch(new URL("/api/auth/websocket-ticket", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]),
    });
    if (!res.ok) {
      throw new Error(`T3 websocket ticket request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
    const { ticket } = (await res.json()) as { ticket: string };

    const url = new URL("/ws", baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const handshake = AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT_MS)]);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve(), { once: true });
        ws.addEventListener("error", () => reject(new Error(`Could not connect to T3 at ${baseUrl}`)), { once: true });
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

  private call(tag: string, payload: unknown, onChunk?: (values: unknown[]) => void): Promise<unknown> {
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

  /** Reads the current project list from the first shell snapshot. */
  async listProjects(): Promise<T3Project[]> {
    const requestId = String(this.nextId);
    return new Promise((resolve, reject) => {
      this.call("orchestration.subscribeShell", {}, (values) => {
        for (const value of values as { kind: string; snapshot?: { projects: T3Project[] } }[]) {
          if (value.kind === "snapshot" && value.snapshot) {
            this.interrupt(requestId);
            resolve(value.snapshot.projects);
            return;
          }
        }
      }).then(() => reject(new Error("T3 shell subscription ended without a snapshot")), reject);
    });
  }

  async launchThread(input: LaunchThreadInput): Promise<{ threadId: string; resumed: boolean }> {
    const result = (await this.call("orchestration.launchThread", {
      commandId: randomUUID(),
      creationSource: "server",
      // Same scheme as the T3 web client: a pre-allocated thread id plus reuseExistingThread
      // makes a retry after a lost response return the existing thread.
      threadId: stableUuid(`${input.idempotencyKey}:thread`),
      reuseExistingThread: true,
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      workspaceStrategy: input.workspaceStrategy,
      initialMessage: { messageId: stableUuid(`${input.idempotencyKey}:message`), text: input.message, attachments: [] },
    })) as { threadId: string; resumed: boolean };
    return { threadId: result.threadId, resumed: result.resumed };
  }
}
