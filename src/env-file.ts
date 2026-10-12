import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Returns `contents` with each key in `updates` set: existing `KEY=` lines are replaced in
 * place, missing keys are appended. Every other line, including commented-out keys, is kept.
 */
export function upsertEnv(contents: string, updates: Record<string, string>): string {
  const lines = contents === "" ? [] : contents.replace(/\n$/, "").split("\n");
  for (const [key, value] of Object.entries(updates)) {
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.startsWith(`${key}=`)) {
        lines[i] = `${key}=${value}`;
        found = true;
      }
    }
    if (!found) lines.push(`${key}=${value}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** A `.env` file that starts from `.env.example` and is always written with mode 0600. */
export class EnvFile {
  readonly path: string;
  readonly examplePath: string;

  constructor(path: string, examplePath: string) {
    this.path = path;
    this.examplePath = examplePath;
  }

  /** The key's value in `.env`, or `undefined` if the file or the key is missing or empty. */
  get(key: string): string | undefined {
    if (!existsSync(this.path)) return undefined;
    let value: string | undefined;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.startsWith(`${key}=`)) value = line.slice(key.length + 1).trim();
    }
    return value || undefined;
  }

  set(updates: Record<string, string>): void {
    const current = existsSync(this.path)
      ? readFileSync(this.path, "utf8")
      : existsSync(this.examplePath)
        ? readFileSync(this.examplePath, "utf8")
        : "";
    writeFileSync(this.path, upsertEnv(current, updates), { mode: 0o600 });
    // `mode` only applies when the file is created.
    chmodSync(this.path, 0o600);
  }
}
