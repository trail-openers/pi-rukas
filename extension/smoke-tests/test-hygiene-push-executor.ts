/**
 * test-hygiene-push-executor.ts — the PRODUCTION executor of the public hygiene
 * guard (#1788 round 2), split out of `test-public-hygiene-guard.ts` along the
 * seam of one fixture per mechanism (AGENTS.md §12: split, never compress).
 *
 * Both real registration sites — `subagent-guard-guards.ts` and
 * `parent-guards.ts` — call `registerPublicHygieneGuard(pi)` with options, and
 * those options carry the executor. Before the executor was wired (defaulted to
 * the repo's standard `execp`, the way `merge-guard.ts` does), `exec` was
 * undefined in production, the push half of the guard never asked git a single
 * question, and every push was judged on the words it carried in its own argv.
 * A push whose dirt sat in a COMMIT message or an added diff line went out
 * unscanned while the guard reported itself as working — the silent no-op a
 * guard that looks registered produces, and the reason this fixture registers
 * the hook the way production does and points it at a REAL repository.
 *
 * `PI_ENSEMBLE_PUBLIC_DENYLIST` is pinned to a temp file for the whole block
 * (never the operator's real default path) and git children get `gitTestEnv()`'s
 * isolated HOME, so a test cannot read the host's list. Terms are synthetic.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execp } from "../src/exec.ts";
import { resetDenylistCacheForTests } from "../src/public-denylist.ts";
import {
  pushGitCwd,
  registerPublicHygieneGuard,
  resetPublicHygieneRegistrationForTests,
} from "../src/public-hygiene-guard.ts";
import { withEnv } from "./lib/env-scope.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = ["example", "private", "host"].join("-");
const PUSH = ["pu", "sh"].join("");
/** The push command the hook is asked about, assembled from pieces. */
const pushCommand = (rest = "origin main"): string => ["git", PUSH, rest].join(" ").trim();

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

const root = mkdtempSync(path.join(tmpdir(), "hygiene-prod-"));
const originDir = path.join(root, "origin.git");
const work = path.join(root, "work");
const list = path.join(root, "public-denylist");
writeFileSync(list, `# synthetic terms\n${TERM}\n`, "utf8");
const gitEnv = gitTestEnv();

const gitRun = (...args: string[]): Promise<string> =>
  execp("git", {
    argv: args,
    cwd: work,
    env: { ...gitEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid" },
    timeout: 30_000,
  } as never).then((r) => r.stdout);

await execp("git", { argv: ["init", "-q", "--bare", originDir], cwd: root, env: gitEnv } as never);
await execp("git", { argv: ["clone", "-q", originDir, "work"], cwd: root, env: gitEnv } as never);
await gitRun("config", "user.email", "t@example.invalid");
await gitRun("config", "user.name", "tester");
await gitRun("branch", "-m", "main");
await gitRun("remote", "set-url", "origin", "https://github.com/example-owner/example-repo.git");
writeFileSync(path.join(work, "a.txt"), "seed\n", "utf8");
await gitRun("add", "a.txt");
await gitRun("commit", "-q", "-m", "chore: seed");
const seed = (await gitRun("rev-parse", "HEAD")).trim();
await gitRun("update-ref", "refs/remotes/origin/main", seed);
await gitRun("update-ref", "refs/remotes/origin/HEAD", seed);

/** A hook built exactly the way production builds it: the executor at the call site. */
function prodHook(): (
  command: string,
) => Promise<{ block?: boolean; reason?: string } | undefined> {
  const handlers: Handler[] = [];
  const pi = {
    on(event: string, fn: Handler) {
      if (event === "tool_call") handlers.push(fn);
    },
  } as unknown as ExtensionAPI;
  resetPublicHygieneRegistrationForTests();
  resetDenylistCacheForTests();
  registerPublicHygieneGuard(pi, { execFn: execp });
  return async (command: string) => {
    for (const h of handlers) {
      const r = (await h({ toolName: "bash", input: { command } }, { cwd: work })) as
        | { block?: boolean; reason?: string }
        | undefined;
      if (r?.block) return r;
    }
    return undefined;
  };
}

await withEnv({ ...gitEnv, PI_ENSEMBLE_PUBLIC_DENYLIST: list }, async () => {
  // A dirty commit message in the outgoing range, pushed by name.
  writeFileSync(path.join(work, "dirty.txt"), "public line\n", "utf8");
  await gitRun("add", "dirty.txt");
  await gitRun("commit", "-q", "-m", `chore: wire ${TERM} into the build`);
  const dirty = await prodHook()(pushCommand());
  assert(
    dirty?.block === true,
    "a hook registered the way production registers it reads git and refuses a dirty push",
  );
  assert(
    (dirty?.reason ?? "").includes("commit message"),
    "the refusal names the commit message as the surface, which only a real git read can say",
  );
  assert(
    (dirty?.reason ?? "").includes("2"),
    "and the denylist line, from the temp list rather than any host file",
  );
  assert(
    !(dirty?.reason ?? "").includes(TERM),
    "and the refusal carries no term, only its location",
  );
  // The clean counterpart, so the block is not satisfied by a hook that refuses
  // every push.
  await gitRun("reset", "-q", "--hard", seed);
  await gitRun("update-ref", "refs/remotes/origin/main", seed);
  writeFileSync(path.join(work, "clean.txt"), "public line\n", "utf8");
  await gitRun("add", "clean.txt");
  await gitRun("commit", "-q", "-m", "chore: a perfectly public note");
  assert(
    (await prodHook()(pushCommand())) === undefined,
    "a clean push is allowed by the same hook — it is not refusing everything",
  );
  // And the directory rule the same hook applies: the two shapes that move the
  // git are followed, so the scan reads the clone the push runs in.
  assert(
    pushGitCwd(work, `cd .worktrees/x && ${PUSH} origin main`) === path.join(work, ".worktrees/x"),
    "a cd prefix moves the scan to the directory the push runs in",
  );
  assert(
    pushGitCwd(work, `git -C ../other ${PUSH} origin main`) === path.join(root, "other"),
    "git -C moves it too",
  );
  assert(
    pushGitCwd(work, "gh pr comment 1 --body 'see git push elsewhere'") === work,
    "a command that merely mentions the verb does not move it",
  );
  resetPublicHygieneRegistrationForTests();
});

rmSync(root, { recursive: true, force: true });
process.exit(exit);
