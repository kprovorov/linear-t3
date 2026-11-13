import { loadProjectConfig } from "./config.ts";
import { EnvFile } from "./env-file.ts";
import type { Paths } from "./paths.ts";
import { t3Projects } from "./preflight.ts";
import { findProject } from "./project.ts";
import {
  type InstalledDaemon,
  type ServiceManager,
  type ServicePlatform,
  ServiceError,
  pinnedTo,
} from "./service.ts";
import type { T3Project } from "./t3.ts";

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const NOT_INSTALLED =
  "The Daemon isn't installed as a background service; run `linear-t3 start`";

/** How a command names the Daemon to act on: the flags `start` resolves the project with. */
export interface TargetOptions {
  project?: string;
  /** `--config`, or `false` for `--no-config`. */
  config?: string | false;
}

/** The Daemon a command acts on, with its T3 project's title when T3 could say. */
export interface Target {
  manager: ServiceManager;
  title?: string;
}

/** `"title" (id)`, or the id alone when the title isn't known. */
export const describeProject = (id: string, title?: string) =>
  title === undefined ? id : `"${title}" (${id})`;

/** The installed Daemons, one per line, for a message asking to pick one. */
function listDaemons(daemons: InstalledDaemon[], projects: T3Project[] | undefined): string {
  return daemons
    .map(({ project, unit }) => {
      const title = projects?.find((p) => p.id === project)?.title;
      const local = pinnedTo(unit).localConfig;
      return `  ${describeProject(project, title)}${local ? `, Local Config ${local}` : ""}`;
    })
    .join("\n");
}

/**
 * The background Daemon a command acts on. It's the Daemon of the T3 project `start` would resolve
 * here: `--project`, then the Local Config, then the repository's T3 project. When none resolves,
 * it's the only installed Daemon; with several, this fails and lists them.
 */
export async function pickDaemon(
  platform: ServicePlatform,
  paths: Paths,
  options: TargetOptions,
): Promise<Target> {
  const installed = platform.list();
  if (installed.length === 0) throw new ServiceError(NOT_INSTALLED);
  const daemon = (id: string, title?: string): Target | undefined =>
    installed.some((d) => d.project === id) ? { manager: platform.daemon(id), title } : undefined;
  // An installed Daemon's id needs neither the Config nor T3, so it works with either broken.
  const byId = options.project === undefined ? undefined : daemon(options.project);
  if (byId) return byId;

  const named = options.project !== undefined || typeof options.config === "string";
  let config: Awaited<ReturnType<typeof loadProjectConfig>> | undefined;
  try {
    config = await loadProjectConfig({
      global: paths.globalConfig,
      local: options.config,
      cwd: process.cwd(),
      flags: options.project === undefined ? {} : { project: options.project },
    });
  } catch (error) {
    // A broken Config shouldn't keep you from stopping the Daemon it would start.
    if (named) throw new ServiceError(message(error));
  }

  // A Config that names the project by an installed Daemon's id needs no T3.
  if (config && "ref" in config.project) {
    const pinned = daemon(config.project.ref);
    if (pinned) return pinned;
  }

  let projects: T3Project[] | undefined;
  let t3Problem: string | undefined;
  if (config) {
    const token = process.env.T3_TOKEN || new EnvFile(paths.credentials).get("T3_TOKEN");
    if (token) {
      projects = await t3Projects(config.t3Url, token).catch((error: unknown) => {
        t3Problem = message(error);
        return undefined;
      });
    } else {
      t3Problem = "Missing T3_TOKEN: run `linear-t3 connect t3`";
    }
  }

  if (config && "ref" in config.project && !projects) {
    throw new ServiceError(`Could not look up T3 project "${config.project.ref}": ${t3Problem}`);
  }

  if (config && projects) {
    let project: T3Project | undefined;
    try {
      project = findProject(projects, config);
    } catch (error) {
      // A project that was named but isn't there is a mistake; one inferred from a folder T3 doesn't
      // know just means this isn't a project's repository.
      if ("ref" in config.project) throw new ServiceError(message(error));
    }
    if (project) {
      const found = daemon(project.id, project.title);
      if (found) return found;
      throw new ServiceError(
        [
          `T3 project ${describeProject(project.id, project.title)} has no background Daemon; run \`linear-t3 start\` for it, or pass --project for one of:`,
          listDaemons(installed, projects),
        ].join("\n"),
      );
    }
  }

  if (installed.length === 1) {
    const [only] = installed;
    return daemon(only!.project, projects?.find((p) => p.id === only!.project)?.title)!;
  }
  throw new ServiceError(
    [
      "Several background Daemons are installed and no T3 project resolves here; pass --project with one of:",
      listDaemons(installed, projects),
      ...(t3Problem ? [`(T3 couldn't say which project this is: ${t3Problem})`] : []),
    ].join("\n"),
  );
}
