import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const isKeyLine = (line: string, key: string) => line.startsWith(`${key}=`);

/**
 * Returns `contents` with each key in `updates` set: existing `KEY=` lines are replaced in
 * place, missing keys are appended. Every other line, including commented-out keys, is kept.
 */
export function upsertEnv(contents: string, updates: Record<string, string>): string {
  const lines = contents === "" ? [] : contents.replace(/\n$/, "").split("\n");
  for (const [key, value] of Object.entries(updates)) {
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if (isKeyLine(lines[i]!, key)) {
        lines[i] = `${key}=${value}`;
        found = true;
      }
    }
    if (!found) lines.push(`${key}=${value}`);
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** A `KEY=value` file, such as the Credentials file, that is always written with mode 0600. */
export class EnvFile {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** The key's value in the file, or `undefined` if the file or the key is missing or empty. */
  get(key: string): string | undefined {
    if (!existsSync(this.path)) return undefined;
    let value: string | undefined;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (isKeyLine(line, key)) value = line.slice(key.length + 1).trim();
    }
    return value || undefined;
  }

  set(updates: Record<string, string>): void {
    let current = "";
    if (existsSync(this.path)) {
      // Tighten an existing file before the new secret goes in; `mode` below only applies on create.
      chmodSync(this.path, 0o600);
      current = readFileSync(this.path, "utf8");
    } else {
      mkdirSync(dirname(this.path), { recursive: true });
    }
    writeFileSync(this.path, upsertEnv(current, updates), { mode: 0o600 });
  }
}
