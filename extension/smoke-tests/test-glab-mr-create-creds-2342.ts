#!/usr/bin/env bun
/**
 * #2342 — the `glab mr create` runs with the run's OWN credentials.
 *
 * The create is a driver exec, not a helper subagent. The helper-subagent
 * credential strip (`forgeReadChildEnv`) deletes the five forge token variables
 * and redirects `GH_CONFIG_DIR` / `GLAB_CONFIG_DIR` at a fresh empty directory,
 * which is exactly right for a spawned child and fatal for a create: the MR
 * create reached GitLab with no token and no config root, and a private project
 * answered 404. `glab auth login` cannot work around it either, because the
 * redirected config dir is not the operator's.
 *
 * Pinned here, from the two sides of the same module:
 *  1. the create's env carries `GITLAB_TOKEN`, `GLAB_CONFIG_DIR` and
 *     `GITLAB_HOST` verbatim from the source env, plus the two non-interactive
 *     flags the argv's `-y` is paired with;
 *  2. the SPAWN strip still removes the token from a helper child, so the fix
 *     above is not a regression of #2214.
 */

import { createForge } from "../src/forge.ts";
import type { ForgeExecFn } from "../src/forge-types.ts";
import { glDetection } from "./forge-fixtures.ts";
import { forgeReadChildEnv } from "../src/child-forge-env.ts";
import { withEnv } from "./lib/env-scope.ts";

let exit = 0;
function assert(cond: unknown, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const TITLE = "fix(glab): the create keeps the run's credentials";
const BRANCH = "fix/issue-2342-glab-create-env";
const BODY = "a body that is not empty\n";
const MR_URL = "https://gitlab.example/acme/widget/-/merge_requests/41\n";

const TOKEN = "tok-x";
const CONFIG_DIR = "/operator/glab-config";
const HOST = "gitlab.example";

/** The create's env as the exec actually received it. */
async function envOfTheCreate(
  source: Record<string, string>,
): Promise<Record<string, string> | undefined> {
  let seen: Record<string, string> | undefined;
  const fn: ForgeExecFn = async (_cmd, opts) => {
    seen = opts?.env as Record<string, string> | undefined;
    return { stdout: MR_URL };
  };
  const forge = createForge(glDetection("acme", "widget"), { execFn: fn });
  await forge.prCreate(TITLE, BRANCH, BODY, { baseBranch: "main" });
  return seen;
}

// ── 1. the create carries the run's own credentials ────────────────────────

// The suite process must not decide the outcome of this row: the variables are
// pinned for the duration of the body and restored exactly on the way out.
await withEnv(
  { GITLAB_TOKEN: TOKEN, GLAB_CONFIG_DIR: CONFIG_DIR, GITLAB_HOST: HOST },
  async () => {
    const env = await envOfTheCreate(process.env as Record<string, string>);
    assert(env !== undefined, "the GitLab create ran with an explicit env");
    assert(
      env?.GITLAB_TOKEN === TOKEN,
      `the create carries the run's GITLAB_TOKEN (got ${String(env?.GITLAB_TOKEN)})`,
    );
    assert(
      env?.GLAB_CONFIG_DIR === CONFIG_DIR,
      `the create carries the run's GLAB_CONFIG_DIR (got ${String(env?.GLAB_CONFIG_DIR)})`,
    );
    assert(
      env?.GITLAB_HOST === HOST,
      `the create carries the run's GITLAB_HOST (got ${String(env?.GITLAB_HOST)})`,
    );
    assert(env?.CI === "1", "and it still says non-interactive (CI=1)");
    assert(
      env?.GIT_TERMINAL_PROMPT === "0",
      `and git is told not to prompt (got ${String(env?.GIT_TERMINAL_PROMPT)})`,
    );
  },
);

// The other three token variables are part of the same login and are deleted by
// the strip, so they get the same row.
await withEnv(
  {
    GH_TOKEN: "gh-x",
    GITHUB_TOKEN: "ghy-x",
    GH_ENTERPRISE_TOKEN: "ghe-x",
    GITLAB_ACCESS_TOKEN: "gla-x",
  },
  async () => {
    const env = await envOfTheCreate(process.env as Record<string, string>);
    for (const [k, v] of [
      ["GH_TOKEN", "gh-x"],
      ["GITHUB_TOKEN", "ghy-x"],
      ["GH_ENTERPRISE_TOKEN", "ghe-x"],
      ["GITLAB_ACCESS_TOKEN", "gla-x"],
    ]) {
      assert(env?.[k] === v, `the create carries ${k} unchanged (got ${String(env?.[k])})`);
    }
  },
);

// The parent's forge_read broker pair is the parent's OWN credential surface: a
// `glab` child holds no forge_read tool and no socket to dial, so forwarding the
// pair would hand a driver exec a path to the parent's broker. It is deleted
// here while every real credential stays.
await withEnv(
  {
    GITLAB_TOKEN: TOKEN,
    GLAB_CONFIG_DIR: CONFIG_DIR,
    PI_ENSEMBLE_FORGE_READ_SOCKET: "/run/parent/broker.sock",
    PI_ENSEMBLE_FORGE_READ_SECRET: "0".repeat(64),
  },
  async () => {
    const env = await envOfTheCreate(process.env as Record<string, string>);
    assert(
      !("PI_ENSEMBLE_FORGE_READ_SOCKET" in (env ?? {})),
      `the create carries no parent broker socket (got ${String(env?.PI_ENSEMBLE_FORGE_READ_SOCKET)})`,
    );
    assert(
      !("PI_ENSEMBLE_FORGE_READ_SECRET" in (env ?? {})),
      `the create carries no parent broker secret (got ${String(env?.PI_ENSEMBLE_FORGE_READ_SECRET)})`,
    );
    assert(
      env?.GITLAB_TOKEN === TOKEN,
      `deleting the broker pair leaves GITLAB_TOKEN in place (got ${String(env?.GITLAB_TOKEN)})`,
    );
  },
);

// ── 2. the helper-child strip is NOT regressed ─────────────────────────────

{
  const child = forgeReadChildEnv(
    { GITLAB_TOKEN: TOKEN, GLAB_CONFIG_DIR: CONFIG_DIR, GITLAB_HOST: HOST, PATH: "/usr/bin" },
    "developer",
    "/run/parent/broker.sock",
    undefined,
    "0".repeat(64),
  );
  assert(!("GITLAB_TOKEN" in child), "a helper child still gets no GITLAB_TOKEN");
  assert(
    child.GLAB_CONFIG_DIR !== CONFIG_DIR,
    `a helper child's config root is not the operator's (got ${String(child.GLAB_CONFIG_DIR)})`,
  );
  assert(
    child.GITLAB_HOST === HOST,
    "the strip removes credentials only — GITLAB_HOST is not one",
  );
}

console.log(
  `\n${exit === 0 ? "glab mr create creds green" : "glab mr create creds RED"} — exit ${exit}`,
);
process.exit(exit);
