import type { EnvFile } from "./env-file.ts";

export type Failure = { status: "unauthorized" | "unreachable"; message?: string };
export type CheckResult = { status: "valid"; identity?: string } | Failure;

/** Which token a check was for: the one already in `.env`, or one just obtained. */
export type Step = "existing" | "new";

/** On a failed check: get a (another) new token, or stop the service with an error. */
export type FailureAction = "obtain" | "abort";

/** A service `connect` can set up: where its token lives, how to get one and how to check it. */
export interface Service {
  /** Display name, e.g. "T3". */
  name: string;
  /** The `.env` key the token is saved under. */
  envKey: string;
  /** Gets a new token, e.g. by prompting for it or issuing one. */
  obtain(ui: Ui): Promise<string>;
  check(token: string): Promise<CheckResult>;
  /** Defaults to `obtain` for an existing token and `abort` for a new one. */
  onFailure?(step: Step, result: Failure): FailureAction;
}

/** The prompts the flow needs, so it can run without a terminal in tests. */
export interface Ui {
  /** Resolves to the answer; rejects with `CancelledError` if the user cancels. */
  confirm(message: string): Promise<boolean>;
  /** Asks for a secret without echoing it; rejects with `CancelledError` if the user cancels. */
  password(message: string): Promise<string>;
  spin<T>(message: string, work: () => Promise<T>): Promise<T>;
  success(message: string): void;
  warn(message: string): void;
}

export interface Outcome {
  service: string;
  action: "kept" | "saved";
  identity?: string;
}

/** A service could not be connected; the message is meant for the user. */
export class ConnectError extends Error {}

/** The user cancelled a prompt. */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
  }
}

const defaultOnFailure = (step: Step): FailureAction => (step === "existing" ? "obtain" : "abort");

function describeFailure(name: string, result: Failure): string {
  if (result.message) return result.message;
  return result.status === "unauthorized"
    ? `${name} rejected the token`
    : `${name} is not reachable`;
}

/**
 * Runs the shared connect flow for one service: check the token already in `.env` and offer to
 * keep it, otherwise get a new one and save it only once its check passes.
 */
export async function connectService(service: Service, env: EnvFile, ui: Ui): Promise<Outcome> {
  const handleFailure = (step: Step, result: Failure) => {
    const action = service.onFailure?.(step, result) ?? defaultOnFailure(step);
    const message = describeFailure(service.name, result);
    if (action === "abort") throw new ConnectError(message);
    ui.warn(message);
  };

  const check = async (step: Step, token: string) => {
    const result = await ui.spin(
      `Checking ${step === "existing" ? "saved" : "new"} ${service.name} token`,
      () => service.check(token),
    );
    if (result.status === "valid" && result.identity)
      ui.success(`Authenticated as ${result.identity}`);
    return result;
  };

  const existing = env.get(service.envKey);
  if (existing !== undefined) {
    const result = await check("existing", existing);
    if (result.status !== "valid") {
      handleFailure("existing", result);
    } else if (!(await ui.confirm(`${service.name} token is already valid, replace it?`))) {
      return { service: service.name, action: "kept", identity: result.identity };
    }
  }

  for (;;) {
    const token = await service.obtain(ui);
    const result = await check("new", token);
    if (result.status === "valid") {
      env.set({ [service.envKey]: token });
      return { service: service.name, action: "saved", identity: result.identity };
    }
    handleFailure("new", result);
  }
}

/** A service that is listed but whose flow hasn't been built yet. */
export interface PendingService {
  name: string;
}

/** Connects each service in order and stops at the first one that fails. */
export async function connect(
  services: (Service | PendingService)[],
  env: EnvFile,
  ui: Ui,
): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const service of services) {
    if (!("check" in service)) {
      throw new ConnectError(`Connecting ${service.name} is not implemented yet`);
    }
    outcomes.push(await connectService(service, env, ui));
  }
  return outcomes;
}
