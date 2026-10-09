#!/usr/bin/env bun
/**
 * #948/#1040 — comment-retention gate (companion: test-comment-retention-hunks.ts).
 *
 * Real-git scratch repos exercise `findLostComments` (lost / moved-verbatim /
 * deleted-with-code exempt / block / 25-lost truncation) plus the replacement
 * shapes (#1017 → replaced, #1019 → lost, mixed hunk). The develop-gate wiring
 * (fake ExecFn through `verifyStepOutcome`) proves the lossy diff fails and the
 * replaced-only diff passes. Deliberately NOT named `*-live.ts` (that suffix spawns
 * Pi children and is excluded from the pre-push gate). Costs only git forks.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";import {
  findLostComments,
  formatLostComments,
  formatReplacedComments,
  buildCommentsLine,
} from "../src/comment-retention.ts";
import type { ExecFn } from "../src/worktree.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { runCommentRetentionGate } from "../src/work-driver-verify-develop-gates.ts";
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
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], { cwd: o?.cwd, maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024 });
  return { stdout };
};
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

// Minimal ExtensionAPI stub (only what verifyStepOutcome touches).
function makeFakePi() {
  const sent: string[] = [];
  return { sent, pi: { sendUserMessage: (c: unknown) => sent.push(typeof c === "string" ? c : JSON.stringify(c)) } as unknown as ExtensionAPI };
}
// Build a scratch repo with a base commit at `src/app.ts`, then a head commit
// applying the given new file content. Returns the repo dir.
async function makeRepo(baseContent: string, headContent?: string, headPath = "src/app.ts") {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-comment-"));
  await execFileP("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await git(dir, ["config", "user.email", "t@example.com"]);
  await git(dir, ["config", "user.name", "T"]);
  if (!existsSync(path.join(dir, "src"))) mkdirSync(path.join(dir, "src"), { recursive: true });
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

// Compact real-git case runner: build a repo, run findLostComments against
// base...head under PATHS, assert ok + `check` holds, clean up.
async function rg(
  name: string,
  base: string,
  head: string,
  msg: string,
  check: (res: Extract<Awaited<ReturnType<typeof findLostComments>>, { ok: true }>) => boolean,
): Promise<void> {
  const dir = await makeRepo(base, head);
  try {
    const b = (await git(dir, ["rev-parse", "HEAD~1"])).stdout.trim();
    const h = (await git(dir, ["rev-parse", "HEAD"])).stdout.trim();
    const res = await findLostComments(realExec, dir, b, h, PATHS);
    assert(res.ok === true, `real-git ${name}: result is ok`);
    if (res.ok) assert(check(res), `real-git ${name}: ${msg}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- real-git findLostComments cases -------------------------------------
{
  // (a) deleting a comment above unchanged code → reported lost.
  await rg(
    "(a)",
    `// helpful comment to keep\nfunction add(a: number, b: number) {\n  return a + b;\n}\n`,
    `function add(a: number, b: number) {\n  return a + b;\n}\n`,
    "deleted comment above unchanged code is reported lost",
    (res) => res.lost.length === 1 && res.lost[0] === "// helpful comment to keep",
  );

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
  await rg(
    "(c)",
    `// doc for doomed\nfunction doomed() {\n  return 99;\n}\nfunction keeper() {\n  return 1;\n}\n`,
    `function keeper() {\n  return 1;\n}\n`,
    "comment deleted with its code is exempt",
    (res) => res.lost.length === 0 && res.exempt === 1,
  );

  // (d) rewording a comment above UNCHANGED code → the old text is still lost
  // (no new comment line in the hunk — condition (b) not met, NOT a
  // replacement; #1019 true-positive shape).
  await rg(
    "(d)",
    `// original wording here\nfunction f() {\n  return 1;\n}\n`,
    `function f() {\n  return 1;\n}\n`,
    "dropped comment above unchanged code (no new comment in hunk) is still lost",
    (res) => res.lost.length === 1 && res.lost[0] === "// original wording here",
  );

  // (d2) reworded comment + code changed + new comment in same hunk → replaced (note, not failure). #1017 shape.
  await rg(
    "(d2)",
    `// original wording here\nfunction f() {\n  return 1;\n}\n`,
    `// different wording now\nfunction f() {\n  return 2;\n}\n`,
    "reworded comment + changed code + new comment in same hunk → replaced (not lost)",
    (res) => res.lost.length === 0 && res.replaced.length === 1 && res.replaced[0] === "// original wording here",
  );

  // (d3) #1017 exact shape: 2-line comment reworded + body changed in the same
  // hunk → replaced (2 lines), zero lost (condition (a) fires hunk-locally).

  await rg(
    "(d3)",
    `// the doc for f, line one\n// the doc for f, line two\nfunction f() {\n  return 1;\n}\n`,
    `// the doc for f, now reworded one\n// the doc for f, now reworded two\nfunction f() {\n  return 2;\n}\n`,
    "#1017 shape (reworded 2-line comment + changed code) → replaced, not lost",
    (res) => res.lost.length === 0 && res.replaced.length === 2 && res.exempt === 0,
  );

  // (d4) #1019 shape: block comment dropped, function UNCHANGED → every
  // comment line lost (no new comment in the hunk → replacement rule cannot
  // fire). Closer is at end-of-line (not a standalone `*/`, which isCommentLine
  // does not classify — a pre-existing limitation).
  await rg(
    "(d4)",
    `/* the doc for g.\n   more detail here */\nfunction g() {\n  return 1;\n}\n`,
    `function g() {\n  return 1;\n}\n`,
    "#1019 shape (dropped block comment on unchanged code, no new comment) → all lines lost",
    (res) => res.lost.length === 2 && res.replaced.length === 0,
  );

  // (d5) mixed hunk: comment A removed with its code changed + a new comment
  // added in the SAME hunk (→ replaced); comment B removed in a DIFFERENT hunk
  // above unchanged code (→ lost). The blank-line gap puts them in separate
  // hunks, so the added comment does not satisfy condition (b) for B.
  await rg(
    "(d5)",
    `// doc for aaa\nfunction aaa() {\n  return 1;\n}\n\n\n\n// doc for bbb\nfunction bbb() {\n  return 2;\n}\n`,
    `// doc for aaa, reworded\nfunction aaa() {\n  return 10;\n}\n\n\n\nfunction bbb() {\n  return 2;\n}\n`,
    "mixed hunk → exactly one lost (B, unchanged code) and one replaced (A, code changed)",
    (res) =>
      res.lost.length === 1 &&
      res.lost[0] === "// doc for bbb" &&
      res.replaced.length === 1 &&
      res.replaced[0] === "// doc for aaa",
  );

  // (e) a multi-line block comment removed above unchanged code → lost (block).
  await rg(
    "(e)",
    `/* block top\n   block middle */\nfunction g() {\n  return 1;\n}\n`,
    `function g() {\n  return 1;\n}\n`,
    "both lines of a removed block comment are reported (block is one unit)",
    (res) => res.lost.length === 2,
  );

  // (f) 25 lost comments → format lists 20 + "5 more".
  const baseF = Array.from({ length: 25 }, (_, i) => `// comment number ${i}\n`).join("") + `function h() {\n  return 1;\n}\n`;
  const dirF = await makeRepo(baseF, `function h() {\n  return 1;\n}\n`);
  {
    const base = (await git(dirF, ["rev-parse", "HEAD~1"])).stdout.trim();
    const head = (await git(dirF, ["rev-parse", "HEAD"])).stdout.trim();
    const res = await findLostComments(realExec, dirF, base, head, PATHS);
    assert(res.ok === true && res.lost.length === 25, "real-git (f): all 25 removed comments are lost");
    if (res.ok) {
      const row = formatLostComments(res.lost, res.exempt);
      assert(row.includes("and 5 more"), "real-git (f): truncation shows '5 more'");
      assert(
        row.split("\n").filter((l) => l.trim().startsWith("//")).length === 20,
        "real-git (f): exactly 20 lines listed",
      );
    }
    rmSync(dirF, { recursive: true, force: true });
  }

  // (g) arithmetic continuation: `const y = a\n * b;` — the ` * b;` line
  // follows a non-comment line, so it is NOT a comment; the real comment is
  // exempt (its code is also deleted). Result: nothing is lost.
  await rg(
    "(g)",
    `const x = 5;\n// a real comment here\nconst y = a\n * b;\nconst z = 9;\n`,
    `const x = 5;\nconst z = 9;\n`,
    "arithmetic continuation is NOT reported lost; comment is exempt (code also deleted)",
    (res) => res.lost.length === 0,
  );

  // (h0) an empty scoped diff with a non-empty UNSCOPED range: the head
  // commit touches only a file OUTSIDE paths (a `makeRepo` head commit
  // re-adds the base file, keeping it in scope), so no in-scope comment can be
  // lost — the gate must pass cleanly (ok:true, lost 0) with NO skip note.
  {
    const dirH0 = await makeRepo(`// an in-scope comment at base\nfunction a() {\n  return 1;\n}\n`);
    mkdirSync(path.join(dirH0, "out-of-scope"), { recursive: true });
    writeFileSync(path.join(dirH0, "out-of-scope/other.txt"), "noise\n");
    await git(dirH0, ["add", "-A"]);
    await git(dirH0, ["commit", "-q", "-m", "out-of-scope change"]);
    const base = (await git(dirH0, ["rev-parse", "HEAD~1"])).stdout.trim();
    const head = (await git(dirH0, ["rev-parse", "HEAD"])).stdout.trim();
    const res = await findLostComments(realExec, dirH0, base, head, PATHS);
    assert(
      res.ok === true && res.lost.length === 0 && res.exempt === 0,
      "real-git (h0): empty scoped diff + out-of-scope commit → {ok:true, lost:[], exempt:0}",
    );
    const failures: string[] = [];
    const notes: string[] = [];
    await runCommentRetentionGate(realExec, () => base, new Map<string, string>([["default", dirH0]]), PATHS, failures, notes);
    assert(failures.length === 0, "real-git (h0): gate passes (no failure)");
    assert(notes.length === 0, "real-git (h0): gate emits NO skip note");
    rmSync(dirH0, { recursive: true, force: true });
  }

  // (h) arithmetic continuation where the code is RETAINED: the ` * b;` line
  // is NOT a comment, and the `// real` comment above retained code IS lost.
  await rg(
    "(h)",
    `// a real comment above\nconst y = a\n * b;\nconst z = 9;\n`,
    `const y = a\n * b;\nconst z = 9;\n`,
    "real comment above retained code IS lost; arithmetic continuation is not a comment",
    (res) => res.lost.length === 1 && res.lost[0] === "// a real comment above",
  );

  // (h1) formatLostComments / formatReplacedComments: when a diff has both
  // replaced and lost comments (separate hunks), the failure row lists only
  // the lost line and the gate's note lists the replaced line(s) separately.
  const dirH1 = await makeRepo(
    `// comment to keep\nfunction x() {\n  return 1;\n}\n\n\n\n\n// comment replaced\nfunction y() {\n  return 1;\n}\n`,
    `function x() {\n  return 1;\n}\n\n\n\n\n// new comment\nfunction y() {\n  return 2;\n}\n`,
  );
  {
    const base = (await git(dirH1, ["rev-parse", "HEAD~1"])).stdout.trim();
    const res = await findLostComments(realExec, dirH1, base, (await git(dirH1, ["rev-parse", "HEAD"])).stdout.trim(), PATHS);
    assert(res.ok === true && res.lost.length === 1 && res.replaced.length === 1, "real-git (h1): one lost + one replaced");
    if (res.ok) {
      const failureRow = formatLostComments(res.lost, res.exempt, res.replaced.length);
      assert(failureRow.includes("comment to keep") && !failureRow.includes("comment replaced") && failureRow.includes("1 replaced"),
        "real-git (h1): failure row lists only the lost line + replaced count");
      const noteRow = formatReplacedComments(res.replaced);
      assert(noteRow.includes("comment replaced") && !noteRow.includes("comment to keep"),
        "real-git (h1): note row lists the replaced line, not the lost line");
      const failures: string[] = [];
      const notes: string[] = [];
      await runCommentRetentionGate(
        realExec,
        () => base,
        new Map<string, string>([["default", dirH1]]),
        PATHS,
        failures,
        notes,
      );
      assert(failures.length === 1 && failures[0].includes("comment to keep"), "real-git (h1): gate failure lists only the lost line");
      assert(notes.length === 1 && notes[0].includes("comment replaced"), "real-git (h1): gate note lists the replaced line separately");
    }
    rmSync(dirH1, { recursive: true, force: true });
  }
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
  // (j) path injection: an env-shape path token is refused — NO shell exec of
  // the payload.
  const safeSha = "abc123def456abc123def456abc123def456";
  for (const p of ["x$(touch /tmp/pi-ens-comment-pwned-948)", "a;b", "-R HEAD", "a b", "x\ty", "x@y"] as const) {
    const res = await findLostComments(realExec, "/tmp", safeSha, "HEAD", [p]);
    assert(
      res.ok === false && res.reason.includes("unsafe path"),
      `injection: path ${JSON.stringify(p)} is refused before exec`,
    );
  }
  assert(
    !existsSync("/tmp/pi-ens-comment-pwned-948"),
    "injection: no shell side effects from a rejected path",
  );
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
    const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-comment-gate-"));
    mkdirSync(path.join(dir, ".pi"), { recursive: true });
    writeFileSync(path.join(dir, ".pi", "verify-cmd"), "echo ok\n");
    const BASE_SHA = "0123456789abcdef0123456789abcdef01234567";
    // Shared fake-exec prefix (status/rev-list/name-only); each case supplies
    // its own `git diff ...` (three-dot) and `git grep` bodies.
    const prefix = (cmd: string) => {
      if (cmd === "git status --porcelain") return { stdout: "M src/app.css\n" };
      if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" };
      if (cmd.startsWith("git diff --name-only")) return { stdout: "src/app.css\n" };
      return undefined;
    };
    const runGate = async (issue: number, exec: NonNullable<DriverContext["verifyExecFn"]>) => {
      process.env.PI_ENSEMBLE_VERIFY = "1";
      let s = initialState(issue, Date.now());
      s = { ...s, pipelineState: { ...s.pipelineState, worktrees: { default: dir }, baseSha: BASE_SHA } };
      const ctx: DriverContext = {
        pi: makeFakePi().pi,
        repoRoot: dir,
        issue,
        issueBodyFetcherFn: () => ({ stdout: "mock" }),
        verifyExecFn: exec,
      };
      return await verifyStepOutcome(ctx, s, "develop");
    };
    try {
      const lostComment = "// the comment the developer deleted";
      const diffBody = (diff: string, grep: string) =>
        `--- a/src/app.ts\n+++ b/src/app.ts\n${diff}`;
      // A fake execFn whose `git diff base...HEAD -- src` returns a removed
      // comment and a head-tree read that does NOT contain it.
      // (i) lossy diff → gate fails with the lost-line evidence.
      const fakeExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
        // comment-retention uses a THREE-dot range (baseRef...HEAD); the other
        // gates use `git diff ${baseRef} -U0`. Disambiguate on the ellipsis.
        const p = prefix(cmd);
        if (p) return p;
        if (cmd.includes("..."))
          return { stdout: diffBody(`@@ -1,2 +1,1 @@\n-${lostComment}\n function add(a,b){return a+b;}\n`, "") };
        if (cmd.startsWith("git grep")) return { stdout: "HEAD:src/app.ts:function add(a,b){return a+b;}\n" };
        return { stdout: "" };
      };
      process.env.PI_ENSEMBLE_COMMENT_RETENTION = "1";
      {
        const gate = await runGate(948, fakeExec);
        const crFail = gate.failures.find((f) => f.startsWith("comment-retention:"));
        assert(!gate.ok && crFail !== undefined, "gate: lossy diff fails with a comment-retention failure");
        assert(crFail !== undefined && crFail.includes("the comment the developer deleted"), "gate: evidence row lists the lost line");
      }
      // (ii) clean diff → passes (both directions).
      {
        const cleanExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          // The scoped `git rev-list --count base..HEAD -- src` must return 0
          // (the clean diff case: no commits under the path). The unscoped
          // form (develop gate) returns 1 via the shared prefix below.
          if (cmd.startsWith("git rev-list --count ") && cmd.includes("-- "))
            return { stdout: "0\n" };
          if (cmd.startsWith("git diff") && !cmd.includes("...")) return { stdout: "" };
          const p = prefix(cmd);
          if (p) return p;
          if (cmd.includes("...")) return { stdout: diffBody(`@@ -1,0 +1,1 @@\n+function add(a,b){return a+b;}\n`, "") };
          if (cmd.startsWith("git grep")) return { stdout: "HEAD:src/app.ts:function add(a,b){return a+b;}\n" };
          return { stdout: "" };
        };
        process.env.PI_ENSEMBLE_COMMENT_RETENTION = "1";
        const gate = await runGate(949, cleanExec);
        assert(gate.ok && !gate.failures.some((f) => f.startsWith("comment-retention:")), "gate: clean diff passes (no comment-retention failure)");
      }
      // (iii) escape hatch → disabled note, no failure.
      {
        process.env.PI_ENSEMBLE_COMMENT_RETENTION = "0";
        const gate = await runGate(950, fakeExec);
        assert(
          gate.notes.some((n) => n.includes("PI_ENSEMBLE_COMMENT_RETENTION=0")),
          "gate: PI_ENSEMBLE_COMMENT_RETENTION=0 emits a disabled note",
        );
        assert(!gate.failures.some((f) => f.startsWith("comment-retention:")), "gate: disabled gate produces no failure");
      }
      // (iv) replaced-only diff → passes (replaced is a note, not a failure).
      {
        const replacedExec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
          const p = prefix(cmd);
          if (p) return p;
          if (cmd.includes("..."))
            return { stdout: diffBody(`@@ -1,2 +1,2 @@\n-// old comment\n-function f(){return 1;}\n+// new comment\n+function f(){return 2;}\n`, "") };
          if (cmd.startsWith("git grep"))
            return { stdout: "HEAD:src/app.ts:function f(){return 2;}\nHEAD:src/app.ts:// new comment\n" };
          return { stdout: "" };
        };
        process.env.PI_ENSEMBLE_COMMENT_RETENTION = "1";
        const gate = await runGate(951, replacedExec);
        assert(
          gate.ok && !gate.failures.some((f) => f.startsWith("comment-retention:")),
          "gate: replaced-only diff passes (replaced is a note, not a failure)",
        );
        assert(
          gate.notes.some((n) => n.includes("replaced in the same hunk")),
          "gate: replaced-only diff emits a replaced note",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    const restore = (k: keyof typeof process.env, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("PI_ENSEMBLE_VERIFY", prevVerify);
    restore("PI_ENSEMBLE_COMMENT_RETENTION", prevRet);
    restore("PI_ENSEMBLE_SKIP_RATCHET", prevRatchet);
    restore("PI_ENSEMBLE_SMOKE", prevSmoke);
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
      if (cmd.startsWith("git diff"))
        return { stdout: `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,1 @@\n-// gone for good\n function f(){return 1;}\n` };
      if (cmd.startsWith("git grep")) return { stdout: "HEAD:src/app.ts:function f(){return 1;}\n" };
      return { stdout: "" };
    };
    const line = await buildCommentsLine({ base: "abc", head: "def" }, "/tmp", fakeExec, ["src"]);
    assert(line.startsWith("comments: lost=1"), "report: lossy range → 'comments: lost=1'");
    assert(line.includes("gone for good"), "report: the lost line is listed");
  }
  // A fake execFn: a replaced-only range yields lost=0, replaced=<n>.
  {
    const fakeExec: ExecFn = async (cmd) => {
      if (cmd.startsWith("git diff"))
        return { stdout: `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-// old comment\n-function f(){return 1;}\n+// new comment\n+function f(){return 2;}\n` };
      if (cmd.startsWith("git grep"))
        return { stdout: "HEAD:src/app.ts:function f(){return 2;}\nHEAD:src/app.ts:// new comment\n" };
      return { stdout: "" };
    };
    const line = await buildCommentsLine({ base: "abc", head: "def" }, "/tmp", fakeExec, ["src"]);
    assert(line.startsWith("comments: lost=0"), "report: replaced-only range → 'comments: lost=0'");
    assert(line.includes("replaced: 1"), "report: replaced count is listed");
    assert(line.includes("old comment"), "report: the replaced line is listed");
  }
  // A timeout-like exec error is an infra error: the gate degrades to a
  // not-run note, never a failure — and the timeout option is actually
  // passed on every git exec (a recording fake asserts that).
  {
    const seenOpts: Array<{ timeout?: number } | undefined> = [];
    const failingExec: ExecFn = async (cmd, opts) => {
      seenOpts.push(opts);
      throw new Error(`etimedout: git ${cmd.split(" ")[1]} timed out after 1000ms (killed)`);
    };
    const line = await buildCommentsLine({ base: "abc", head: "def" }, "/tmp", failingExec, ["src"]);
    assert(line.startsWith("comments: not-run ("), "report: timeout-like exec error → not-run note, not a failure");
    assert(
      seenOpts.length > 0 && seenOpts.every((o) => typeof o?.timeout === "number" && o.timeout > 0),
      "report: every git exec in findLostComments carries a timeout option",
    );
    const res = await findLostComments(failingExec, "/tmp", "abc", "def", ["src"]);
    assert(!res.ok, "findLostComments: a timed-out git diff is an infra failure (ok:false → note)");
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
