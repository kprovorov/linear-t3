import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Config } from "./config.ts";
import type { T3Project } from "./t3.ts";

/** A folder path compared by where it leads: symlinks resolved, no trailing slash. */
function normalizeFolder(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // T3 may know folders this machine can't reach.
    return resolve(path);
  }
}

const describeProjects = (projects: T3Project[]) =>
  projects.length === 0
    ? "T3 has no projects"
    : `Known projects: ${projects.map((p) => `"${p.title}" (${p.workspaceRoot})`).join(", ")}`;

/**
 * The T3 project to watch: the one `project` names, by id, unique title or folder path, or else
 * the one whose folder is the Git root (or the working directory outside Git).
 */
export function findProject(projects: T3Project[], config: Pick<Config, "project">): T3Project {
  const { project } = config;
  // A relative path is relative to the Config file that set it.
  const folder = "ref" in project ? resolve(project.base, project.ref) : project.folder;
  const normalized = normalizeFolder(folder);
  const matches = projects.filter((p) => normalizeFolder(p.workspaceRoot) === normalized);
  if ("ref" in project) {
    const byId = projects.find((p) => p.id === project.ref);
    if (byId) return byId;
    // An absolute path names its folder outright, ahead of any title spelled the same.
    if (isAbsolute(project.ref) && matches.length === 1) return matches[0]!;
    // Titles aren't unique; launching into the wrong workspace is worse than failing.
    const byTitle = projects.filter((p) => p.title === project.ref);
    if (byTitle.length === 1) return byTitle[0]!;
    if (byTitle.length > 1) {
      const roots = byTitle.map((p) => p.workspaceRoot).join(", ");
      throw new Error(
        `Several T3 projects are titled "${project.ref}" (${roots}); use the id or workspace path instead`,
      );
    }
  }
  if (matches.length === 1) return matches[0]!;
  const fix = 'set "project" in the Local Config';
  if (matches.length > 1) {
    const ids = matches.map((p) => `"${p.title}" (id ${p.id})`).join(", ");
    throw new Error(`Several T3 projects have the folder ${folder}: ${ids}. ${fix} to one's id`);
  }
  if ("ref" in project) {
    throw new Error(`No T3 project matches "${project.ref}". ${describeProjects(projects)}`);
  }
  throw new Error(
    `No T3 project has the folder ${folder}. Add it in T3, or ${fix}. ${describeProjects(projects)}`,
  );
}
