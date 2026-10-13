// Local stand-ins for Linear and T3 Code, for tests that run the CLI as a separate process.
import { createHash } from "node:crypto";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

export interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A Linear GraphQL API that answers every issue query with `issues`. */
export async function fakeLinear(issues: FakeIssue[]) {
  const queries: string[] = [];
  const server = createServer(async (req, res) => {
    const { query } = JSON.parse(await readBody(req)) as { query: string };
    queries.push(query);
    const nodes = issues.map((issue) => ({
      ...issue,
      url: `https://linear.app/acme/issue/${issue.identifier}`,
      description: null,
      branchName: issue.identifier.toLowerCase(),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      // The SDK's Issue model reads these unconditionally.
      sharedAccess: { isShared: false, sharedWithCount: 0, sharedWithUsers: [] },
      reactions: [],
    }));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        data: {
          issues: { nodes, pageInfo: { hasNextPage: false, hasPreviousPage: false } },
        },
      }),
    );
  });
  const url = await listen(server);
  return { url: `${url}/graphql`, queries, close: () => server.close() };
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

export interface FakeT3Options {
  projects: { id: string; title: string; workspaceRoot: string }[];
  /** Called for each launch; the launch succeeds once it resolves. */
  onLaunch?: (payload: Record<string, unknown>) => Promise<void>;
}

/** A T3 Code server: the websocket ticket endpoint plus the shell and launch RPCs. */
export async function fakeT3({ projects, onLaunch }: FakeT3Options) {
  const requests: string[] = [];
  const launches: Record<string, unknown>[] = [];
  const sockets = new Set<Duplex>();
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.method === "POST" && req.url === "/api/auth/websocket-ticket") {
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
        if (message.tag === "orchestration.subscribeShell") {
          const snapshot = { projects, threads: [] };
          send({ _tag: "Chunk", requestId: message.id, values: [{ kind: "snapshot", snapshot }] });
        } else if (message.tag === "orchestration.launchThread") {
          launches.push(message.payload);
          void (onLaunch?.(message.payload) ?? Promise.resolve()).then(() =>
            exit(message.id, { threadId: message.payload.threadId, resumed: false }),
          );
        }
      }
    });
    socket.on("error", () => {});
  });

  const url = await listen(server);
  return {
    url,
    requests,
    launches,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}
