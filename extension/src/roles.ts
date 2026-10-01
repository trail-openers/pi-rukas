import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolves to <repo>/dist/prompts/standard from <repo>/extension/src
const PROMPTS_DIR = path.resolve(
  process.env.PI_ENSEMBLE_PROMPTS_DIR ??
    path.join(__dirname, "..", "..", "dist", "prompts", "standard"),
);

export const ROLE_NAMES = [
  "project-manager",
  "developer",
  "ops",
  "explore",
  "adversarial-developer",
  "code-review-specialist",
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

/**
 * The literal role string for the lens-review child, shared by every site
 * that must match it by name (token budget default in spawn-support.ts,
 * slow-notice's stop-clause branch) so a rename can't strand a comparison.
 */
export const CODE_REVIEW_SPECIALIST_ROLE = "code-review-specialist";

interface RoleDef {
  promptFile: string;
  cwd: "repo" | "worktree";
}

export const ROLES: Record<RoleName, RoleDef> = {
  "project-manager": {
    promptFile: path.join(PROMPTS_DIR, "project-manager.md"),
    cwd: "repo",
  },
  developer: {
    promptFile: path.join(PROMPTS_DIR, "developer.md"),
    cwd: "worktree",
  },
  ops: {
    promptFile: path.join(PROMPTS_DIR, "ops.md"),
    cwd: "repo",
  },
  explore: {
    promptFile: path.join(PROMPTS_DIR, "explore.md"),
    cwd: "repo",
  },
  "adversarial-developer": {
    promptFile: path.join(PROMPTS_DIR, "adversarial-developer.md"),
    cwd: "repo",
  },
  "code-review-specialist": {
    promptFile: path.join(PROMPTS_DIR, "code-review-specialist.md"),
    cwd: "repo",
  },
};

export function isRoleName(s: string): s is RoleName {
  return (ROLE_NAMES as readonly string[]).includes(s);
}
