#!/usr/bin/env bun
/**
 * #948 — comment-retention gate.
 *
 * Real-git scratch repos exercise `findLostComments` (lost / moved-verbatim /
 * deleted-with-code exempt / reworded / block comment / 25-lost truncation),
 * and the develop-gate wiring (fake ExecFn through `verifyStepOutcome`) proves
 * the `verify-failed:develop` cap fires with the lost-line evidence, plus the
 * `PI_ENSEMBLE_COMMENT_RETENTION=0` note. Both directions are asserted (the
 * lossy diff fails, the clean diff passes) — a gate never observed to fail is
 * worthless.
 *
 * Deliberately NOT named `*-live.ts` (that suffix spawns Pi children and is
 * excluded from the pre-push gate). This costs nothing but a few git forks.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  findLostComments,
  formatLostComments,
  buildCommentsLine,
} from "../src/comment-retention.ts";
import type { ExecFn } from "../src/worktree.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Real shell exec, matching the driver's ExecFn contract. */
const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

// Minimal ExtensionAPI stub (only what verifyStepOutcome touches).
function makeFakePi() {
  const sent: string[] = [];
  return {
    sent,
    pi: {
      sendUserMessage: (content: unknown) => {
        sent.push(typeof content === "string" ? content : JSON.stringify(content));
      },
    } as unknown as ExtensionAPI,
  };
}

// Build a scratch repo with a base commit at `src/app.ts`, then a head commit
// applying the given new file content. Returns the repo dir.
async function makeRepo(baseContent: string, headContent?: string, headPath = "src/app.ts") {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-comment-"));
  await execFileP("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await git(dir, ["config", "user.email", "t@example.com"]);
  await git(dir, ["config", "user.name", "T"]);
  const srcDir = path.join(dir, "src");
  if (!existsSync(srcDir)) mkdirSync(srcDir, { recursive: true });
  writeFileSync(path.join(dir, "src/app.ts"), baseContent);
  await git(dir, ["add", "src"]);
  await git(dir, ["commit", "-q", "-m", "base"]);
  if (headContent !== undefined) {
    writeFileSync(path.join(dir, headPath), headContent);
    await git(dir, ["add", "-A", "src"]);
    await git(dir, ["commit", "-q", "-m", "head"]);
  }
  return dir;
}

const PATHS = ["src"];

// --- real-git findLostComments cases -------------------------------------
{
  // (a) deleting a comment above unchanged code → reported lost.
  const dirA = await makeRepo(
    `// helpful comment to keep\nfunction add(a: number, b: number) {\n  return a + b;\n}\n`,
    `function add(a: number, b: number) {\n  return a + b;\n}\n`,
  );
  {
    const base = (await git(dirA, ["rev-parse", "HEAD~1"])).stdout.trim();
    const head = (await git(dirA, ["rev-parse", "HEAD"])).stdout.trim();
    const res = await findLostComments(realExec, dirA, base, head, PATHS);
    assert(res.ok === true, "real-git (a): result is ok");
    assert(
      res.ok && res.lost.length === 1 && res.lost[0] === "// helpful comment to keep",
      "real-git (a): deleted comment above unchanged code is reported lost",
    );
    rmSync(dirA, { recursive: true, force: true });
  }

  // (b) moving a function with its comment verbatim to another file → not lost.
  const dirB = await makeRepo(
    `// the doc for moveMe\nexport function moveMe() {\n  return 1;\n}\nfunction other() {\n  return 2;\n}\n`,
    `function other() {\n  return 2;\n}\n// the doc for moveMe\nexport function moveMe() {\n  return 1;\n}\n`,
  );
  {
    const base = (await git(dirB, ["rev-parse", "HEAD~1"])).stdout.trim();
    const head = (await git(dirB, ["rev-parse", "HEAD"])).stdout.trim();
    const res = await findLostComments(realExec, dirB, base, head, PATHS);
    assert(res.ok === true, "real-git (b): result is ok");
    assert(res.ok && res.lost.length === 0, "real-git (b): verbatim move of comment is NOT lost");
    rmSync(dirB, { recursive: true, force: true });
  }

  // (c) deleting a function together with its doc comment → exempt.
  const dirC = await makeRepo(
    `// doc for doomed\nfunction doomed() {\n  return 99;\n}\nfunction keeper() {\n  return 1;\n}\n`,
    `function keeper() {\n  return 1;\n}\n`,
  );
  {
    const base = (await git(dirC, ["rev-parse", "HEAD~1"])).stdout.trim();
    const head = (await git(dirC, ["rev-parse", "HEAD"])).stdout.trim();
    const res = await findLostComments(realExec, dirC, base, head, PATHS);
    assert(res.ok === true, "real-git (c): result is ok");
    assert(res.ok && res.lost.length === 0 && res.exempt === 1, "real-git (c): comment deleted with its code is exempt");
    rmSync(dirC, { recursive: true, force: true });
  }

  // (d) rewording a comment → the old text is lost.
  const dirD = await makeRepo(
    `// original wording here\nfunction f() {\n  return 1;\n}\n`,
    `// different wording now\nfunction f() {\n  return 1;\n}\n`,
  );
  {
    const base = (await git(dirD, ["rev-parse", "HEAD~1"])).stdout.trim();
    const head = (await git(dirD, ["rev-parse", "HEAD"])).stdout.trim();
    const res = await findLostComments(realExec, dirD, base, head, PATHS);
    assert(res.ok === true, "real-git (d): result is ok");
    assert(res.ok && res.lost.length === 1, "real-git (d): reworded comment is reported lost");
    rmSync(dirD, { recursive: true, force: true });
  }

  // (e) a multi-line block comment removed above unchanged code → lost (block).
  const dirE = await makeRepo(
    `/* block top\n   block middle */\nfunction g() {\n  return 1;\n}\n`,
    `function g() {\n  return 1;\n}\n`,
  );
  {
    const base = (await git(dirE, ["rev-parse", "HEAD~1"])).stdout.trim();
    const head = (await git(dirE, ["rev-parse", "HEAD"])).stdout.trim();
    const res = await findLostComments(realExec, dirE, base, head, PATHS);
    assert(res.ok === true, "real-git (e): result is ok");
    assert(
      res.ok && res.lost.length === 2,
      "real-git (e): both lines of a removed block comment are reported (block is one unit)",
    );
    rmSync(dirE, { recursive: true, force: true });
  }

  // (f) 25 lost comments → format lists 20 + "5 more".
  const baseF = Array.from({ length: 25 }, (_, i) => `// comment number ${i}\n`).join("") + `function h() {\n  return 1;\n}\n`;
  const dirF = await makeRepo(baseF, `function h() {\n  return 1;\n}\n`);
  {
    const base = (await git(dirF, ["rev-parse", "HEAD~1"])).stdout.trim();
    const head = (await git(dirF, ["rev-parse", "HEAD"])).stdout.trim();
    const res = await findLostComments(realExec, dirF, base, head, PATHS);
    assert(res.ok === true, "real-git (f): result is ok");
    assert(res.ok && res.lost.length === 25, "real-git (f): all 25 removed comments are lost");
    if (res.ok) {
      const row = formatLostComments(res.lost, res.exempt);
      assert(row.includes("and 5 more"), "real-git (f): truncation shows '5 more'");
      assert(row.split("\n").filter((l) => l.trim().startsWith("//")).length === 20, "real-git (f): exactly 20 lines listed");
    }
    rmSync(dirF, { recursive: true, force: true });
  }
}

// --- develop-gate wiring via verifyStepOutcome (fake ExecFn) --------------
{
  const prevVerify = process.env.PI_ENSEMBLE_VERIFY;
  const prevRet = process.env.PI_ENSEMBLE_COMMENT_RETENTION;
  const prevRatchet = process.env.PI_ENSEMBLE_SKIP_RATCHET;
  const prevSmoke = process.env.PI_ENSEMBLE_SMOKE;
  process.env.PI_ENSEMBLE_SKIP_RATCHET = "0";
  process.env.PI_ENSEMBLE_SMOKE = "0";

  try {
    // A fake execFn whose `git diff base...HEAD -- src` returns a removed
    // comment and a head-tree read that does NOT contain it.
    const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-comment-gate-"));
    mkdirSync(path.join(dir, ".pi"), { recursive: true });
    writeFileSync(path.join(dir, ".pi", "verify-cmd"), "echo ok\n");
    try {
      const lostComment = "// the comment the developer deleted";
      const fakeExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
        if (cmd === "git status --porcelain") return { stdout: "M src/app.ts\n" };
        if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" };
        if (cmd.startsWith("git diff --name-only")) return { stdout: "src/app.ts\n" };
        // comment-retention uses a THREE-dot range (baseRef...HEAD); the other
        // gates use `git diff ${baseRef} -U0`. Disambiguate on the ellipsis.
        if (cmd.includes("..."))
          return { stdout: `--- a/src/app.ts\n+++ b/src/app.ts\n-${lostComment}\n function add(a,b){return a+b;}\n` };
        if (cmd.startsWith("git diff")) return { stdout: "" };
        if (cmd.startsWith("git grep")) return { stdout: "HEAD:src/app.ts:function add(a,b){return a+b;}\n" };
        return { stdout: "" };
      };
      // (i) lossy diff → gate fails with the lost-line evidence.
      {
        process.env.PI_ENSEMBLE_VERIFY = "1";
        process.env.PI_ENSEMBLE_COMMENT_RETENTION = "1";
        let s = initialState(948, Date.now());
        s = {
          ...s,
          pipelineState: {
            ...s.pipelineState,
            worktrees: { default: dir },
            baseSha: "0123456789abcdef0123456789abcdef01234567",
          },
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 948,
          issueBodyFetcherFn: () => ({ stdout: "mock" }),
          verifyExecFn: fakeExec,
        };
        const gate = await verifyStepOutcome(ctx, s, "develop");
        const crFail = gate.failures.find((f) => f.startsWith("comment-retention:"));
        assert(!gate.ok && crFail !== undefined, "gate: lossy diff fails with a comment-retention failure");
        assert(crFail !== undefined && crFail.includes("the comment the developer deleted"), "gate: evidence row lists the lost line");
      }
      // (ii) clean diff → passes (both directions).
      {
        const cleanExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          if (cmd === "git status --porcelain") return { stdout: "M src/app.ts\n" };
          if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" };
          if (cmd.startsWith("git diff --name-only")) return { stdout: "src/app.ts\n" };
          if (cmd.includes("..."))
            return { stdout: `--- a/src/app.ts\n+++ b/src/app.ts\n+function add(a,b){return a+b;}\n` };
          if (cmd.startsWith("git diff")) return { stdout: "" };
          if (cmd.startsWith("git grep")) return { stdout: "HEAD:src/app.ts:function add(a,b){return a+b;}\n" };
          return { stdout: "" };
        };
        process.env.PI_ENSEMBLE_VERIFY = "1";
        let s = initialState(949, Date.now());
        s = {
          ...s,
          pipelineState: {
            ...s.pipelineState,
            worktrees: { default: dir },
            baseSha: "0123456789abcdef0123456789abcdef01234567",
          },
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 949,
          issueBodyFetcherFn: () => ({ stdout: "mock" }),
          verifyExecFn: cleanExec,
        };
        const gate = await verifyStepOutcome(ctx, s, "develop");
        assert(gate.ok && !gate.failures.some((f) => f.startsWith("comment-retention:")), "gate: clean diff passes (no comment-retention failure)");
      }
      // (iii) escape hatch → disabled note, no failure.
      {
        process.env.PI_ENSEMBLE_VERIFY = "1";
        process.env.PI_ENSEMBLE_COMMENT_RETENTION = "0";
        let s = initialState(950, Date.now());
        s = {
          ...s,
          pipelineState: {
            ...s.pipelineState,
            worktrees: { default: dir },
            baseSha: "0123456789abcdef0123456789abcdef01234567",
          },
        };
        const ctx: DriverContext = {
          pi: makeFakePi().pi,
          repoRoot: dir,
          issue: 950,
          issueBodyFetcherFn: () => ({ stdout: "mock" }),
          verifyExecFn: fakeExec,
        };
        const gate = await verifyStepOutcome(ctx, s, "develop");
        assert(
          gate.notes.some((n) => n.includes("PI_ENSEMBLE_COMMENT_RETENTION=0")),
          "gate: PI_ENSEMBLE_COMMENT_RETENTION=0 emits a disabled note",
        );
        assert(!gate.failures.some((f) => f.startsWith("comment-retention:")), "gate: disabled gate produces no failure");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    if (prevVerify === undefined) process.env.PI_ENSEMBLE_VERIFY = undefined;
    else process.env.PI_ENSEMBLE_VERIFY = prevVerify;
    if (prevRet === undefined) process.env.PI_ENSEMBLE_COMMENT_RETENTION = undefined;
    else process.env.PI_ENSEMBLE_COMMENT_RETENTION = prevRet;
    if (prevRatchet === undefined) process.env.PI_ENSEMBLE_SKIP_RATCHET = undefined;
    else process.env.PI_ENSEMBLE_SKIP_RATCHET = prevRatchet;
    if (prevSmoke === undefined) process.env.PI_ENSEMBLE_SMOKE = undefined;
    else process.env.PI_ENSEMBLE_SMOKE = prevSmoke;
  }
}

// --- adversarial report line (unit test of the formatter/seam) -----------
{
  // No range → the not-run line.
  {
    const line = await buildCommentsLine(null, "/tmp");
    assert(line === "comments: not-run (no base ref)", "report: no range → 'comments: not-run (no base ref)'");
  }
  // A fake execFn: a lossy range yields lost=<n> with the line listed.
  {
    const fakeExec: ExecFn = async (cmd) => {
      if (cmd.startsWith("git diff")) return { stdout: `--- a/src/app.ts\n+++ b/src/app.ts\n-// gone for good\n function f(){return 1;}\n` };
      if (cmd.startsWith("git grep")) return { stdout: "HEAD:src/app.ts:function f(){return 1;}\n" };
      return { stdout: "" };
    };
    const line = await buildCommentsLine({ base: "abc", head: "def" }, "/tmp", fakeExec, ["src"]);
    assert(line.startsWith("comments: lost=1"), "report: lossy range → 'comments: lost=1'");
    assert(line.includes("gone for good"), "report: the lost line is listed");
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
