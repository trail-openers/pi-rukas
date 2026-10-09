#!/usr/bin/env bun
/**
 * #948/#1040 — comment-retention gate.
 *
 * Real-git scratch repos exercise `findLostComments` (lost / moved-verbatim /
 * deleted-with-code exempt / reworded / block comment / 25-lost truncation),
 * and the develop-gate wiring (fake ExecFn through `verifyStepOutcome`) proves
 * the `verify-failed:develop` cap fires with the lost-line evidence, plus the
 * `PI_ENSEMBLE_COMMENT_RETENTION=0` note. Both directions are asserted (the
 * lossy diff fails, the replaced-only and clean diffs pass) — a gate never
 * observed to fail is worthless. Hunk-level cases live in
 * test-comment-retention-hunks.ts.
 *
 * Deliberately NOT named `*-live.ts` (that suffix spawns Pi children and is
 * excluded from the pre-push gate). This costs nothing but a few git forks.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildCommentsLine,
  findLostComments,
  formatLostComments,
} from "../src/comment-retention.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runCommentRetentionGate } from "../src/work-driver-verify-develop-gates.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";
import {
  execFileP,
  git,
  realExec,
  repoWith,
  repoWithFiles,
  runRetentionIn,
} from "./lib/comment-retention-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const PATHS = ["src"];
const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
type Res = Awaited<ReturnType<typeof runRetentionIn>>;
type OkRes = Extract<Res, { ok: true }>;

/** One real-git case: scratch repo `src/app.ts` base→head, retention over it. */
async function realCase(
  name: string,
  base: string,
  head: string,
  msg: string,
  check: (res: OkRes) => boolean,
) {
  const dir = await repoWith("src/app.ts", base, head);
  try {
    const res = await runRetentionIn(dir);
    assert(res.ok === true, `real-git ${name}: result is ok`);
    assert(res.ok && check(res), `real-git ${name}: ${msg}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Set (or unset, when `v` is undefined) one env var. */
function restore(k: string, v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

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

/** A fake exec for the develop gate: the diff body and the head-tree grep. */
function gateExec(diff: string, headLines: string): NonNullable<DriverContext["verifyExecFn"]> {
  return async (cmd) => {
    if (cmd === "git status --porcelain") return { stdout: "M src/app.ts\n" };
    if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" };
    if (cmd.startsWith("git diff --name-only")) return { stdout: "src/app.ts\n" };
    // comment-retention uses a THREE-dot range; the other gates do not.
    if (cmd.includes("...")) return { stdout: diff };
    if (cmd.startsWith("git grep")) return { stdout: headLines };
    return { stdout: "" };
  };
}

/** Run the develop gate over `dir` with `exec`, as issue `issue`. */
async function developGate(
  issue: number,
  dir: string,
  exec: NonNullable<DriverContext["verifyExecFn"]>,
) {
  let s = initialState(issue, Date.now());
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      worktrees: { default: dir },
      baseSha: BASE_SHA,
    },
  };
  const ctx: DriverContext = {
    pi: makeFakePi().pi,
    repoRoot: dir,
    issue,
    issueBodyFetcherFn: () => ({ stdout: "mock" }),
    verifyExecFn: exec,
  };
  return verifyStepOutcome(ctx, s, "develop");
}

// --- real-git findLostComments cases -------------------------------------
{
  // (a) deleting a comment above unchanged code → reported lost.
  await realCase(
    "(a)",
    `// helpful comment to keep\nfunction add(a: number, b: number) {\n  return a + b;\n}\n`,
    `function add(a: number, b: number) {\n  return a + b;\n}\n`,
    "deleted comment above unchanged code is reported lost",
    (res) => res.lost.length === 1 && res.lost[0] === "// helpful comment to keep",
  );

  // (b) moving a function with its comment verbatim to another file → not lost.
  {
    const code = "// doc for moved\nfunction moved() {\n  return 3;\n}\n";
    const dir = await repoWithFiles({ "src/a.ts": code }, { "src/a.ts": null, "src/b.ts": code });
    try {
      const res = await runRetentionIn(dir);
      assert(
        res.ok === true && res.lost.length === 0,
        "real-git (b): verbatim move of comment is NOT lost",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // (c) deleting a function together with its doc comment → exempt.
  await realCase(
    "(c)",
    `// doc for doomed\nfunction doomed() {\n  return 99;\n}\nfunction keeper() {\n  return 1;\n}\n`,
    `function keeper() {\n  return 1;\n}\n`,
    "comment deleted with its code is exempt",
    (res) => res.lost.length === 0 && res.exempt === 1,
  );

  // (d) rewording a comment above UNCHANGED code, on its own change run → the
  // rewording is in place, so it is REPLACED (a note), not lost.
  await realCase(
    "(d)",
    `// original wording here\nfunction f() {\n  return 1;\n}\n`,
    `// different wording now\nfunction f() {\n  return 1;\n}\n`,
    "in-place rewording above unchanged code is replaced (not lost)",
    (res) =>
      res.lost.length === 0 &&
      res.replaced.length === 1 &&
      res.replaced[0] === "// original wording here",
  );

  // (e) a multi-line block comment removed above unchanged code → lost (block).
  await realCase(
    "(e)",
    `/* block top\n   block middle */\nfunction g() {\n  return 1;\n}\n`,
    `function g() {\n  return 1;\n}\n`,
    "both lines of a removed block comment are reported (block is one unit)",
    (res) => res.lost.length === 2,
  );

  // (f) 25 lost comments → format lists 20 + "5 more".
  const baseF =
    Array.from({ length: 25 }, (_, i) => `// comment number ${i}\n`).join("") +
    `function h() {\n  return 1;\n}\n`;
  await realCase(
    "(f)",
    baseF,
    `function h() {\n  return 1;\n}\n`,
    "all 25 removed comments are lost",
    (res) => {
      const row = formatLostComments(res);
      return (
        res.lost.length === 25 &&
        row.includes("and 5 more") &&
        row.split("\n").filter((l) => l.trim().startsWith("//")).length === 20
      );
    },
  );

  // (g) arithmetic continuation: ` * b;` follows a non-comment line, so it is
  // NOT a comment. The real comment is exempt (its code is also deleted).
  await realCase(
    "(g)",
    `const x = 5;\n// a real comment here\nconst y = a\n * b;\nconst z = 9;\n`,
    `const x = 5;\nconst z = 9;\n`,
    "arithmetic continuation is NOT reported lost; comment is exempt (code also deleted)",
    (res) => res.lost.length === 0,
  );

  // (h0) an empty scoped diff with a non-empty UNSCOPED range: the head commit
  // touches only a file OUTSIDE paths → the gate passes with NO skip note.
  {
    const dirH0 = mkdtempSync(path.join(tmpdir(), "pi-ens-comment-"));
    await execFileP("git", ["init", "-q", "-b", "main"], { cwd: dirH0 });
    await git(dirH0, ["config", "user.email", "t@example.com"]);
    await git(dirH0, ["config", "user.name", "T"]);
    mkdirSync(path.join(dirH0, "src"), { recursive: true });
    writeFileSync(
      path.join(dirH0, "src/app.ts"),
      `// an in-scope comment at base\nfunction a() {\n  return 1;\n}\n`,
    );
    await git(dirH0, ["add", "src"]);
    await git(dirH0, ["commit", "-q", "-m", "base"]);
    mkdirSync(path.join(dirH0, "out-of-scope"), { recursive: true });
    writeFileSync(path.join(dirH0, "out-of-scope/x.txt"), "x\n");
    await git(dirH0, ["add", "out-of-scope"]);
    await git(dirH0, ["commit", "-q", "-m", "head"]);
    const base = (await git(dirH0, ["rev-parse", "HEAD~1"])).stdout.trim();
    const head = (await git(dirH0, ["rev-parse", "HEAD"])).stdout.trim();
    const res = await findLostComments(realExec, dirH0, base, head, PATHS);
    assert(res.ok === true, "real-git (h0): result is ok when only out-of-scope files changed");
    assert(
      res.ok && res.lost.length === 0 && res.exempt === 0,
      "real-git (h0): empty scoped diff + out-of-scope commit → {ok:true, lost:[], exempt:0}",
    );
    const failures: string[] = [];
    const notes: string[] = [];
    await runCommentRetentionGate(
      realExec,
      () => base,
      new Map<string, string>([["default", dirH0]]),
      PATHS,
      failures,
      notes,
    );
    assert(failures.length === 0, "real-git (h0): gate passes (no failure)");
    assert(notes.length === 0, "real-git (h0): gate emits NO skip note");
    rmSync(dirH0, { recursive: true, force: true });
  }

  // (h) arithmetic continuation where the code is RETAINED: the ` * b;` line is
  // NOT a comment, and the `// real` comment above retained code IS lost.
  await realCase(
    "(h)",
    `// a real comment above\nconst y = a\n * b;\nconst z = 9;\n`,
    `const y = a\n * b;\nconst z = 9;\n`,
    "real comment above retained code IS lost; arithmetic continuation is not a comment",
    (res) => res.lost.length === 1 && res.lost[0] === "// a real comment above",
  );
}

// --- injection / safety regressions ---------------------------------------
{
  // (i) ref injection: payload refs are refused before any exec (PR338 class).
  for (const evil of ["HEAD; touch pwned", "$(touch pwned)", "-R HEAD"] as const) {
    const res = await findLostComments(realExec, "/tmp", evil, "HEAD", PATHS);
    assert(
      res.ok === false && res.reason.includes("unsafe ref"),
      `injection: ref ${JSON.stringify(evil)} is refused before exec`,
    );
  }
  // (j) path injection: an env-shape path token (PI_ENSEMBLE_COMMENT_RETENTION_PATHS
  // splits on `,` with no quoting) is refused — NO shell exec of the payload.
  for (const evilPath of [
    "x$(touch /tmp/pi-ens-comment-pwned-948)",
    "a;b",
    "-R HEAD",
    "a b",
    "x\ty",
    "x@y",
  ] as const) {
    const res = await findLostComments(
      realExec,
      "/tmp",
      "abc123def456abc123def456abc123def456",
      "HEAD",
      [evilPath],
    );
    assert(
      res.ok === false && res.reason.includes("unsafe path"),
      `injection: path ${JSON.stringify(evilPath)} is refused before exec`,
    );
  }
  assert(
    !existsSync("/tmp/pi-ens-comment-pwned-948"),
    "injection: no shell side effects from a rejected path",
  );
}

// --- develop-gate wiring via verifyStepOutcome (fake ExecFn) --------------
{
  const KEYS = [
    "PI_ENSEMBLE_VERIFY",
    "PI_ENSEMBLE_COMMENT_RETENTION",
    "PI_ENSEMBLE_SKIP_RATCHET",
    "PI_ENSEMBLE_SMOKE",
  ] as const;
  const prevEnv: Record<string, string | undefined> = {};
  for (const k of KEYS) prevEnv[k] = process.env[k];
  process.env.PI_ENSEMBLE_SKIP_RATCHET = "0";
  process.env.PI_ENSEMBLE_SMOKE = "0";
  process.env.PI_ENSEMBLE_VERIFY = "1";

  const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-comment-gate-"));
  mkdirSync(path.join(dir, ".pi"), { recursive: true });
  writeFileSync(path.join(dir, ".pi", "verify-cmd"), "echo ok\n");
  const headAdd = "HEAD:src/app.ts:function add(a,b){return a+b;}\n";
  try {
    // (i) lossy diff → gate fails with the lost-line evidence.
    {
      process.env.PI_ENSEMBLE_COMMENT_RETENTION = "1";
      const lossy = `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,1 @@\n-// the comment the developer deleted\n function add(a,b){return a+b;}\n`;
      const gate = await developGate(948, dir, gateExec(lossy, headAdd));
      const crFail = gate.failures.find((f) => f.startsWith("comment-retention:"));
      assert(
        !gate.ok && crFail !== undefined,
        "gate: lossy diff fails with a comment-retention failure",
      );
      assert(
        crFail !== undefined && crFail.includes("the comment the developer deleted"),
        "gate: evidence row lists the lost line",
      );
    }
    // (ii) clean diff → passes (both directions).
    {
      process.env.PI_ENSEMBLE_COMMENT_RETENTION = "1";
      const clean = `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,0 +1,1 @@\n+function add(a,b){return a+b;}\n`;
      const gate = await developGate(949, dir, gateExec(clean, headAdd));
      assert(
        gate.ok && !gate.failures.some((f) => f.startsWith("comment-retention:")),
        "gate: clean diff passes (no comment-retention failure)",
      );
    }
    // (iv) replaced-only diff → passes (replaced is a note, not a failure).
    {
      process.env.PI_ENSEMBLE_COMMENT_RETENTION = "1";
      const replacedDiff = `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-// old comment\n-function f(){return 1;}\n+// new comment\n+function f(){return 2;}\n`;
      const headF = "HEAD:src/app.ts:function f(){return 2;}\nHEAD:src/app.ts:// new comment\n";
      const gate = await developGate(951, dir, gateExec(replacedDiff, headF));
      assert(
        gate.ok && !gate.failures.some((f) => f.startsWith("comment-retention:")),
        "gate: replaced-only diff passes (replaced is a note, not a failure)",
      );
      assert(
        gate.notes.some((n) => n.includes("replaced in the same hunk")),
        "gate: replaced-only diff emits a replaced note",
      );
    }
    // (iii) escape hatch → disabled note, no failure.
    {
      process.env.PI_ENSEMBLE_COMMENT_RETENTION = "0";
      const lossy = `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,1 @@\n-// the comment the developer deleted\n function add(a,b){return a+b;}\n`;
      const gate = await developGate(950, dir, gateExec(lossy, headAdd));
      assert(
        gate.notes.some((n) => n.includes("PI_ENSEMBLE_COMMENT_RETENTION=0")),
        "gate: PI_ENSEMBLE_COMMENT_RETENTION=0 emits a disabled note",
      );
      assert(
        !gate.failures.some((f) => f.startsWith("comment-retention:")),
        "gate: disabled gate produces no failure",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const k of KEYS) restore(k, prevEnv[k]);
  }
}

// --- report line (buildCommentsLine) -------------------------------------
{
  // No range → the not-run line.
  const line = await buildCommentsLine(null, "/tmp");
  assert(
    line === "comments: not-run (no base ref)",
    "report: no range → 'comments: not-run (no base ref)'",
  );
  // A fake execFn: a lossy range yields lost=<n> with the line listed.
  const fakeExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
    if (cmd.startsWith("git diff"))
      return {
        stdout: `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,1 @@\n-// gone for good\n function f(){return 1;}\n`,
      };
    if (cmd.startsWith("git grep")) return { stdout: "HEAD:src/app.ts:function f(){return 1;}\n" };
    return { stdout: "" };
  };
  const report = await buildCommentsLine({ base: "abc", head: "def" }, "/tmp", fakeExec, ["src"]);
  assert(report.startsWith("comments: lost=1"), "report: lossy range → 'comments: lost=1'");
  assert(report.includes("gone for good"), "report: the lost line is listed");
  // A fake execFn: a replaced-only range yields lost=0, replaced=<n>.
  const replacedExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
    if (cmd.startsWith("git diff"))
      return {
        stdout: `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-// old comment\n-function f(){return 1;}\n+// new comment\n+function f(){return 2;}\n`,
      };
    if (cmd.startsWith("git grep"))
      return {
        stdout: "HEAD:src/app.ts:function f(){return 2;}\nHEAD:src/app.ts:// new comment\n",
      };
    return { stdout: "" };
  };
  const replacedLine = await buildCommentsLine({ base: "abc", head: "def" }, "/tmp", replacedExec, [
    "src",
  ]);
  assert(
    replacedLine.startsWith("comments: lost=0"),
    "report: replaced-only range → 'comments: lost=0'",
  );
  assert(replacedLine.includes("replaced: 1"), "report: replaced count is listed");
  assert(replacedLine.includes("old comment"), "report: the replaced line is listed");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
