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
import { pushGitCwd } from "../src/public-hygiene-cwd.ts";
import {
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
  // #2168, end to end through the hook production registers: the field report was
  // a worktree push refused for a source that could not be resolved, because the
  // scan asked git in the session clone. The worktree below is the only place
  // `wt-branch` exists, so a scan that read the session directory could not have
  // found the term it refuses — and the clean worktree is allowed while the
  // session tree's own HEAD is dirty, which is the same read from the other side.
  {
    const wt = path.join(root, "wt-exec");
    await gitRun("worktree", "add", "-q", "-b", "wt-branch", wt);
    writeFileSync(path.join(wt, "w.txt"), `host = ${TERM}\n`, "utf8");
    const wtRun = (...args: string[]): Promise<string> =>
      execp("git", {
        argv: args,
        cwd: wt,
        env: { ...gitEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid" },
        timeout: 30_000,
      } as never).then((r) => r.stdout);
    await wtRun("add", "w.txt");
    await wtRun("commit", "-q", "-m", `chore: ${TERM} note`);
    const fromWorktree = await prodHook()(`git -C ${wt} ${PUSH} -u origin wt-branch`);
    assert(
      fromWorktree?.block === true,
      "a `-C <worktree>` push is scanned IN the worktree by the production hook (#2168)",
    );
    assert(
      (fromWorktree?.reason ?? "").includes("commit message"),
      "and it is refused for the term in the worktree's commit, not for an unresolvable source",
    );
    assert(!(fromWorktree?.reason ?? "").includes(TERM), "and the refusal still carries no term");
    // The dirty read really was the worktree's: the same push is ALLOWED once the
    // worktree's commit is gone, so a scan of the session tree alone could not
    // have produced this refusal, and the refuse-everything shape is excluded.
    assert(
      !/could not be read/i.test(fromWorktree?.reason ?? ""),
      "…and not by a sentence that could not read the tree at all: the refuse-everything shape must stay distinguishable from the refuse-because-dirty shape in the reason text itself",
    );
    const wtBad = await prodHook()(`git -C ${wt}nope ${PUSH} origin wt-branch`);
    assert(
      wtBad?.block === true &&
        (wtBad.reason ?? "").includes("could not be read") &&
        (wtBad.reason ?? "").includes("nope"),
      "a `-C` target that is no repository is refused with a sentence naming the directory",
    );
    // The other direction, which the scan's own segment reader used to close on its
    // own: from the SESSION tree the last segment resolves to the tree of the push
    // that never got to run (`&&` short-circuits), so the scan located the FIRST push
    // segment and refused for the unreadable target. A chain that pushes twice is now
    // refused BEFORE the directory is asked about — one scan cannot answer for two
    // pushes — so the sentence is the one-push rule, and the second tree is never read
    // at all. The single-push row above still pins the directory sentence itself.
    const chainBad2 = await prodHook()(
      `git -C ${wt}nope ${PUSH} && cd ${work} && git -C ${wt} ${PUSH} origin wt-branch`,
    );
    assert(
      chainBad2?.block === true && (chainBad2.reason ?? "").includes("one push per command"),
      "in a chain that pushes twice, the refusal is the one-push-per-command sentence — the tree git would have run in is never judged",
    );
    assert(
      !/\bwt-exec\b(?!nope)/.test(chainBad2?.reason ?? ""),
      "and it does not blame the chain's last segment, which git answered in fine",
    );
    assert(
      !(wtBad?.reason ?? "").includes("remotes could not be read"),
      "and it is not reported as the timed-out remote read it used to look like",
    );
    const wtGitDir = await prodHook()(`git --git-dir ${wt}/.git ${PUSH} origin wt-branch`);
    assert(
      wtGitDir?.block === true &&
        (wtGitDir.reason ?? "").includes("--git-dir") &&
        !(wtGitDir.reason ?? "").includes("wt-exec"),
      "a push that names its repository with --git-dir is refused by name, not scanned in the session cwd, and the refusal names no path",
    );
    // The glued spelling names the flag the agent actually typed (#2168 round 1):
    // told to drop `--git-dir` for a `--work-tree=…` push, the agent goes looking
    // for a flag that is not in the command.
    for (const [flag, spelling] of [
      ["--work-tree", `git --work-tree=${wt} ${PUSH} origin wt-branch`],
      ["--git-dir", `git --git-dir=${wt}/.git ${PUSH} origin wt-branch`],
    ] as const) {
      const glued = await prodHook()(spelling);
      assert(
        glued?.block === true && (glued.reason ?? "").includes(flag),
        `a glued \`${flag}=<dir>\` push is refused with a sentence naming ${flag}`,
      );
      assert(
        !(glued?.reason ?? "").includes("wt-exec"),
        `and that sentence names the flag, never its ${flag} operand`,
      );
    }
    await wtRun("reset", "-q", "--hard", "HEAD~1");
    assert(
      (await prodHook()(`git -C ${wt} ${PUSH} -u origin wt-branch`)) === undefined,
      "and the same push is allowed once the worktree's commit is gone, while the SESSION tree's HEAD is still dirty (#2168, inverse: a session-tree read could not tell the two apart)",
    );
    execp("git", { argv: ["worktree", "remove", "--force", wt], cwd: work, env: gitEnv } as never);
  }
  assert(
    pushGitCwd(work, "gh pr comment 1 --body 'see git push elsewhere'") === work,
    "a command that merely mentions the verb does not move it",
  );
  resetPublicHygieneRegistrationForTests();
});

rmSync(root, { recursive: true, force: true });
process.exit(exit);
