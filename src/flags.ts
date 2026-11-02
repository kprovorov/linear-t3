import { InvalidArgumentError, Option } from "commander";
import { KEYS, type Key, type KeyDeclaration, type Values, flagName } from "./config.ts";

const keys = Object.keys(KEYS) as Key[];

/** The keys that get a flag: all but the machine settings, which only the Global Config holds. */
const flagKeys = keys.filter((key) => KEYS[key].scope !== "global");

/** Turns what was typed after a flag into the key's value, or says what's wrong with it. */
function parse(declaration: KeyDeclaration, text: string, previous: unknown): unknown {
  let value: unknown = text;
  switch (declaration.type) {
    case "boolean":
      if (text !== "true" && text !== "false") throw new InvalidArgumentError("Use true or false.");
      value = text === "true";
      break;
    case "integer":
      if (!/^-?\d+$/.test(text)) throw new InvalidArgumentError("Use a whole number.");
      value = Number(text);
      break;
    case "json":
      try {
        value = JSON.parse(text);
      } catch (error) {
        throw new InvalidArgumentError(`Invalid JSON: ${(error as Error).message}`);
      }
      break;
    case "list":
      // Repeated flags add up; together they replace the files' list.
      value = [...((previous as unknown[] | undefined) ?? []), text];
      break;
  }
  const result = declaration.schema.safeParse(value);
  if (!result.success) {
    throw new InvalidArgumentError(result.error.issues.map((issue) => issue.message).join("; "));
  }
  return result.data;
}

/** What help says a key defaults to. */
function helpDefault(declaration: KeyDeclaration): string {
  if (declaration.unset !== undefined) return declaration.unset;
  return String(declaration.fallback);
}

/** One option per non-global key, for `run`: `--start-from-origin [true|false]` and so on. */
export function configOptions(): Option[] {
  return flagKeys.map((key) => {
    const declaration: KeyDeclaration = KEYS[key];
    const arg = declaration.type === "boolean" ? "[true|false]" : (declaration.arg ?? "<value>");
    const help = `${declaration.description} (default: ${helpDefault(declaration)}; scope: ${declaration.scope})`;
    // A bare boolean flag means `true`, which is what commander gives an optional value left out.
    return new Option(`--${flagName(key)} ${arg}`, help).argParser((text, previous) =>
      parse(declaration, text, previous),
    );
  });
}

/** The keys among a command's parsed options. Commander names each one after its key. */
export function configFlags(options: Record<string, unknown>): Values {
  return Object.fromEntries(
    flagKeys.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]),
  ) as Values;
}
