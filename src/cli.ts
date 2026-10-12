import { readFileSync } from "node:fs";
import { Command } from "commander";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const program = new Command("linear-t3").version(pkg.version).action(() => program.help());

program.parse();
