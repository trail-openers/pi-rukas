#!/usr/bin/env bun
/**
 * #1394 regression tests: worktree provisioning REPORTS a fault, it never
 * rejects and never accuses the wrong party.
 *
 * AGENTS.md §7 — "Provisioning never fails the branch step" — is a promise about
 * the SHAPE of a failure, not just its visibility. A non-ENOENT errno on a
 * dependency source (chmod-000, a locked tree) escaped as a rejected promise
 * from the precondition probe, `worktreeCreate` propagated it, the mechanized
 * branch setup failed, and the branch step fell to the LLM ops fallback or
 * halted `commit-pr`. And when a fault WAS reported, two things came out wrong:
 * a probe fault was labelled `hookFailed` (an accusation against the project's
 * hook the evidence did not support), and the chatty half of a failed-hook
 * `problem` decided how much of the quiet half survived, so the
 * `git check-ignore:` tail — the only thing saying the hook's exit status is not
 * the whole story — was cut.
 *
 * Real git, real `git worktree add`, real `.git/index` corruption, and a real
 * chmod-000 source (skipped as root, where chmod is a no-op).
 */
import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { geteuid } from "node:process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { missingDepsFailure } from "../src/work-driver-deps-gate.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { ignoredStatus, provisionWorktree } from "../src/worktree-provision.ts";
import { runHookProvisioning } from "../src/worktree-provision-hook.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { realExec } from "./lib/exec-fake.ts";

const pexec = promisify(execFile);
const REAL_HOOK = path.resolve(import.meta.dirname, "..", "..", ".pi", "worktree-setup");
let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A git repo shaped like pi-rukas, with a detached worktree under `.worktrees/`. */
async function repoShapedFixture(hook: string | undefined): Promise<{ root: string; wt: string }> {
  const root = mkdtempSync(path.join(tmpdir(), "wt-provision-1394-"));
  const files: Record<string, string> = {
    ".gitignore": "node_modules/\nextension/node_modules/\ndist/prompts/\n.worktrees/\n",
    "package.json": JSON.stringify({
      name: "fixture",
      scripts: {
        build: "mkdir -p dist/prompts/standard && touch dist/prompts/standard/explore.md",
      },
    }),
    "extension/package.json": '{"name": "ext"}\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  if (hook !== undefined) {
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    if (hook === REAL_HOOK) copyFileSync(REAL_HOOK, path.join(root, ".pi", "worktree-setup"));
    else writeFileSync(path.join(root, ".pi", "worktree-setup"), hook);
  }
  const git = (...args: string[]) => pexec("git", args, { cwd: root });
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "test");
  await git("add", "-A");
  await git("commit", "-q", "-m", "init");
  mkdirSync(path.join(root, "node_modules", ".cache", "jiti"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", ".cache", "jiti", "a.mjs"), "x\n");
  mkdirSync(path.join(root, "extension", "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(root, "extension", "node_modules", "dep", "index.js"), "x\n");
  const wt = path.join(root, ".worktrees", "issue-1-default");
  await git("worktree", "add", "-q", "--detach", wt, "HEAD");
  return { root, wt };
}
// ---- the chatty half does not decide how much of the quiet half survives (#1394)
//
// The failed-hook `problem` joins two parts: the hook's own cause, and the list
// of candidates `git check-ignore` could not classify. They used to share one
// budget, so the chatty part decided how much of the quiet part survived — a
// 300+-char build banner plus a realistic probe-failure list pushed the
// `git check-ignore:` tail (the only thing saying the hook's exit status is not
// the whole story) past the cap, and the operator read a bare hook failure.
// Each part now has its own budget (300 + 80), so BOTH survive.
//
// Driven through `runHookProvisioning` with a hook that exits non-zero WITHOUT
// running its own `git check-ignore` — a no-op hook that dies early — plus a
// corrupt `.git/index`, so the probe failures are real git errors from the
// driver's own probe rather than a hand-written array. (With the real hook the
// hook's own probe dies first and the driver never reaches its own, so the
// named list would legitimately be empty and this case would test nothing.)
{
  const { root, wt } = await repoShapedFixture(
    "#!/bin/sh\necho 'worktree-setup: nothing to do'\nexit 0\n",
  );
  try {
    const chatter = "configuring toolchain for the hundredth time\n".repeat(20); // >300 chars
    const longStderr = `Command failed: sh .pi/worktree-setup\n$ bun run build\n${chatter}worktree-setup: ERROR: link step aborted\n`;
    const indexPath = path.join(root, ".git", "index");
    const realIndex = readFileSync(indexPath);
    writeFileSync(indexPath, "garbage");
    let result: Awaited<ReturnType<typeof runHookProvisioning>> | undefined;
    try {
      // ONLY the hook call fails (with the chatty stderr and a non-zero exit);
      // everything else runs for real — including the driver's own
      // `git check-ignore` against the corrupt index, which is what populates
      // the named list.
      const noisy: typeof realExec = async (cmd, opts) => {
        if (commandOf(cmd, opts).startsWith("sh ")) {
          throw Object.assign(new Error(`Command failed: sh .pi/worktree-setup\n${longStderr}`), {
            code: 3,
            stderr: longStderr,
            stdout: "",
          });
        }
        return realExec(cmd, opts);
      };
      result = await runHookProvisioning(noisy, root, wt, path.join(root, ".pi", "worktree-setup"));
    } finally {
      writeFileSync(indexPath, realIndex);
    }
    assert(
      result?.hookFailed === true,
      `a non-zero hook exit is still a failed hook alongside a probe fault (hookFailed: ${result?.hookFailed})`,
    );
    assert(
      result?.problem?.includes("link step aborted") === true,
      `the hook's own cause survives the chatty stderr (problem: ${result?.problem})`,
    );
    assert(
      result?.problem?.includes("git check-ignore:") === true &&
        result?.problem?.includes("node_modules") === true,
      `...and the probe-failure names survive ALONGSIDE it, not truncated by it (problem: ${result?.problem})`,
    );
    // 300 (cause) + 80 (named), each with its own ellipsis, plus the prefix.
    assert(
      (result?.problem?.length ?? 0) <=
        ".pi/worktree-setup failed (exit 3): ".length + 300 + 1 + 80 + 1,
      `...and the combined problem stays bounded by the two budgets (length: ${result?.problem?.length})`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---- provisioning never rejects: an unreadable source dir is a reported problem (#1394)
//
// AGENTS.md §7: "Provisioning never fails the branch step." A non-ENOENT errno
// on a dependency SOURCE (chmod-000, so `readdir` gives EACCES) used to escape
// as a rejected promise from the precondition probe, which sat OUTSIDE the try.
// Rejection is the failure mode the contract forbids — so these assert the
// promise RESOLVES and that the errno is what the operator reads.
{
  // chmod-000 is a no-op for root, so the block would silently pass on a
  // root-run CI container. Skip it loudly rather than assert nothing.
  if (geteuid() === 0) {
    console.log("· running as root — the chmod-000 unreadable-source checks are skipped");
  } else {
    // Hook path: the precondition probe (`anyLinkableSharedSource`).
    const { root, wt } = await repoShapedFixture(REAL_HOOK);
    try {
      chmodSync(path.join(root, "extension", "node_modules"), 0o000);
      const result = await provisionWorktree(realExec, root, wt);
      assert(
        result.problem !== undefined && result.problem.includes("EACCES") === true,
        `hook path: an unreadable source dir is a problem naming EACCES, not a throw (problem: ${result.problem})`,
      );
      assert(
        result.hookFailed !== true,
        `...and a probe fault is NOT reported as a failed hook — the hook's exit is not the cause here (hookFailed: ${result.hookFailed})`,
      );
      assert(
        result.problem?.includes("extension/node_modules") === true,
        `...and the problem names WHICH tree could not be read (problem: ${result.problem})`,
      );
    } catch (err) {
      assert(false, `hook path: provisionWorktree must never reject (threw: ${err})`);
    } finally {
      chmodSync(path.join(root, "extension", "node_modules"), 0o755);
      rmSync(root, { recursive: true, force: true });
    }

    // Symlink path (no hook): `findDepDirs` collects the same fault.
    const { root: root2, wt: wt2 } = await repoShapedFixture(undefined);
    try {
      chmodSync(path.join(root2, "node_modules"), 0o000);
      const result = await provisionWorktree(realExec, root2, wt2);
      assert(
        result.problem !== undefined && result.problem.includes("EACCES") === true,
        `symlink path: an unreadable source dir is a problem naming EACCES, not a throw (problem: ${result.problem})`,
      );
    } catch (err) {
      assert(false, `symlink path: provisionWorktree must never reject (threw: ${err})`);
    } finally {
      chmodSync(path.join(root2, "node_modules"), 0o755);
      rmSync(root2, { recursive: true, force: true });
    }

    // The develop gate reads the same probe — fail-open, never a throw.
    const { root: root3, wt: wt3 } = await repoShapedFixture(undefined);
    try {
      chmodSync(path.join(root3, "node_modules"), 0o000);
      const failure = await missingDepsFailure(
        realExec,
        { eventLog: [] } as unknown as WorkState,
        root3,
        wt3,
        "v",
      );
      assert(
        typeof failure === "string" ? failure.includes("EACCES") : true,
        `the deps gate reports the fault rather than throwing (got: ${failure})`,
      );
    } catch (err) {
      assert(false, `the deps gate must never reject (threw: ${err})`);
    } finally {
      chmodSync(path.join(root3, "node_modules"), 0o755);
      rmSync(root3, { recursive: true, force: true });
    }
  }
}

// ---- ignoredStatus: argv form, four states, no shell in between (#1394)
//
// The probe is the safety check that stops a TRACKED directory being shadowed,
// so its four answers (0 / 1 / >=2 / no code at all) are load-bearing. The argv
// form is what keeps a candidate path with shell metacharacters out of `sh -c`.
{
  const cases: Array<{ code: number | undefined; want: string; why: string }> = [
    { code: 0, want: "ignored", why: "exit 0 is the only linkable answer" },
    { code: 1, want: "not-ignored", why: "exit 1 means tracked — never link over it" },
    { code: 128, want: "git-error", why: "exit >=2 is git itself failing" },
    {
      code: undefined,
      want: "git-error",
      why: "no exit code at all (a spawn failure) is never read as 'not ignored'",
    },
  ];
  for (const c of cases) {
    const calls: string[] = [];
    let sawOpts: { cwd?: string; argv?: string[] } | undefined;
    const stub = async (cmd: string, opts: { cwd?: string; argv?: string[] }) => {
      calls.push(commandOf(cmd, opts));
      sawOpts = opts;
      if (c.code === undefined) throw new Error("spawn ENOENT");
      if (c.code !== 0) throw Object.assign(new Error(`exit ${c.code}`), { code: c.code });
      return { stdout: "", stderr: "" };
    };
    const got = await ignoredStatus(stub, "/repo", "extension/node$(id) modules");
    assert(got === c.want, `ignoredStatus: ${c.why} (code ${c.code} -> ${got})`);
    assert(
      calls[0] === "git check-ignore -q -- 'extension/node$(id) modules'",
      `...and the candidate went as ONE argv element, never re-parsed by a shell (saw: ${calls[0]})`,
    );
    assert(
      sawOpts?.cwd === "/repo",
      `...and the probe ran in the repo it was asked about (cwd: ${sawOpts?.cwd})`,
    );
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
