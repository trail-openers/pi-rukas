#!/usr/bin/env bun
/**
 * #1153 — the driver's git plumbing has one typed entry point, and the
 * "commits ahead of base, and can we tell?" question has one answer.
 *
 * 1. CANARY — no driver git call in the listed modules passes a command
 *    string. Every call goes through `execGit` (argv + timeout). The control
 *    proves the scanner can fail.
 * 2. REAL GIT — `aheadOfBase` returns each of its five kinds against a real
 *    repository, and `refResolves` separates "absent" from "unknown".
 * 3. FIXTURES — a killed/timed-out probe is `unknown`, never `absent` (#1153
 *    review): a `code: 1` produced by the harness says nothing about the ref.
 *    A probe that EXITS 0 WITHOUT AN OBJECT ID is `unknown` too (#1153 round
 *    3): a zero exit from a shim that printed nothing is not a resolution.
 * 4. COVERAGE — every module that imports `./git-range.ts` is in the canary's
 *    LISTED set, so a new caller cannot join the "argv only" rule by silence.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { aheadOfBase, errorText, execGit, refResolves } from "../src/git-range.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── 1. canary ────────────────────────────────────────────────────────────────

const LISTED = [
  "git-range.ts",
  "work-driver-diff.ts",
  "work-driver-verify.ts",
  "work-driver-verify-pr17.ts",
  "comment-retention.ts",
];

/** A git command string handed to an exec call: a `(` then a literal beginning `git `. */
const COMMAND_STRING = /\([ \t]*["'`]git[ \t]/;

function commandStringLines(source: string): string[] {
  return source.split("\n").filter((line) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
    return COMMAND_STRING.test(line);
  });
}

const srcDir = path.join(import.meta.dir, "..", "src");
for (const f of LISTED) {
  const hits = commandStringLines(readFileSync(path.join(srcDir, f), "utf8"));
  assert(hits.length === 0, `${f}: no git command string (${hits.length} found)`);
}
assert(
  commandStringLines('await exec("git diff HEAD", {})').length === 1,
  "control: the scanner flags a git command string",
);

// Every module that imports git-range must be one the canary actually scans.
// A caller that joins later and is not added to LISTED gets argv discipline
// by imitation only — nothing fails when it passes a command string.
{
  const importers = [];
  for (const entry of readdirSync(srcDir)) {
    if (!entry.endsWith(".ts")) continue;
    const source = readFileSync(path.join(srcDir, entry), "utf8");
    if (/from "\.\/git-range\.ts"/.test(source)) importers.push(entry);
  }
  const unlisted = importers.filter((f) => !LISTED.includes(f));
  assert(
    unlisted.length === 0,
    `canary covers every git-range importer (unlisted: ${unlisted.join(", ") || "none"})`,
  );
  // The control: a scanner blind to a real importer would pass silently.
  assert(
    LISTED.includes("work-driver-diff.ts"),
    "control: LISTED covers a known git-range importer",
  );
}

// ── 2. real git ──────────────────────────────────────────────────────────────

const execP = promisify(execFile);
const exec: ExecFn = async (cmd, opts) => {
  const { stdout, stderr } = await execP(cmd, opts?.argv ?? [], {
    cwd: opts?.cwd,
    maxBuffer: opts?.maxBuffer ?? 1024 * 1024,
    timeout: opts?.timeout,
    encoding: "utf8",
  });
  return { stdout, stderr };
};

const dir = mkdtempSync(path.join(tmpdir(), "git-range-1153-"));
const git = (args: string[]) =>
  execGit(exec, dir, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);

try {
  await git(["init", "-q", "-b", "main"]);
  writeFileSync(path.join(dir, "a.txt"), "a\n");
  await git(["add", "a.txt"]);
  await git(["commit", "-q", "-m", "base"]);
  // The base is what origin/main would point at.
  const base = (await git(["rev-parse", "HEAD"])).trim();
  await git(["update-ref", "refs/remotes/origin/main", base]);
  // Two commits on the feature branch, pushed as origin/feat.
  await git(["checkout", "-q", "-b", "feat"]);
  for (const n of [1, 2]) {
    writeFileSync(path.join(dir, `f${n}.txt`), `${n}\n`);
    await git(["add", `f${n}.txt`]);
    await git(["commit", "-q", "-m", `c${n}`]);
  }
  await git(["update-ref", "refs/remotes/origin/feat", "HEAD"]);

  const ahead = await aheadOfBase(exec, dir, "origin/main", "origin/feat");
  assert(
    ahead.kind === "ahead" && ahead.n === 2,
    `ahead: two commits ahead (got ${JSON.stringify(ahead)})`,
  );

  const empty = await aheadOfBase(exec, dir, "origin/feat", "origin/feat");
  assert(empty.kind === "empty", `empty: head equals base (got ${JSON.stringify(empty)})`);

  const unpushed = await aheadOfBase(exec, dir, "origin/main", "origin/nope");
  assert(
    unpushed.kind === "unpushed",
    `unpushed: head ref absent (got ${JSON.stringify(unpushed)})`,
  );

  const unresolved = await aheadOfBase(exec, dir, "origin/nomain", "origin/feat");
  assert(
    unresolved.kind === "unresolved",
    `unresolved: base ref absent (got ${JSON.stringify(unresolved)})`,
  );

  const notARepo = mkdtempSync(path.join(tmpdir(), "git-range-1153-norepo-"));
  try {
    const unknown = await aheadOfBase(exec, notARepo, "origin/main", "origin/feat");
    assert(
      unknown.kind === "unknown",
      `unknown: git cannot run in a non-repo (got ${JSON.stringify(unknown)})`,
    );
    const probe = await refResolves(exec, notARepo, "origin/feat");
    assert(probe.state === "unknown", "refResolves: a non-repo is unknown, not absent");
  } finally {
    rmSync(notARepo, { recursive: true, force: true });
  }

  const absent = await refResolves(exec, dir, "origin/nope");
  assert(
    absent.state === "absent",
    `refResolves: a missing ref is absent — git's wording, not the code (got ${JSON.stringify(absent)})`,
  );
  const resolves = await refResolves(exec, dir, "origin/feat");
  assert(resolves.state === "resolves", "refResolves: a present ref resolves");

  // #1153 fix round — `absent` requires git's OWN WORDS, not just exit 1.
  // The real-git half of that: a missing ref in a real repo must reach absent
  // through the wording clause (git printed "not a valid object name"), not
  // through the exit code alone. The non-repo case is asserted once above
  // against a real directory, for both `aheadOfBase` and `refResolves`; the
  // synthetic half (the exact stderr shapes) is in section 3.
  assert(
    await refSaysAbsentForMissingRefInFreshRepo(),
    "refResolves: real git — a missing ref in a real repo is absent",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── 3. fixtures: a killed probe is never "absent" ───────────────────────────

/** An exec that rejects with a caller-supplied error shape. */
const failingExec =
  (err: unknown): ExecFn =>
  async () => {
    throw err;
  };

/**
 * The real-git half of the wording rule, against a repository created here
 * rather than the shared fixture above: a ref that genuinely does not exist
 * must reach `absent` (which now needs git's wording, not just exit 1), and
 * one that does must `resolve`.
 */
async function refSaysAbsentForMissingRefInFreshRepo(): Promise<boolean> {
  const fresh = mkdtempSync(path.join(tmpdir(), "git-range-1153-fresh-"));
  try {
    const g = (args: string[]) =>
      execGit(exec, fresh, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    await g(["init", "-q", "-b", "main"]);
    writeFileSync(path.join(fresh, "a.txt"), "a\n");
    await g(["add", "a.txt"]);
    await g(["commit", "-q", "-m", "base"]);
    const missing = await refResolves(exec, fresh, "refs/remotes/origin/never-pushed");
    const present = await refResolves(exec, fresh, "HEAD");
    return missing.state === "absent" && present.state === "resolves";
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

{
  // node's child_process reports a killed child as `code: 1` + `killed: true`
  // + a `signal`. Reading that as "git says the ref does not exist" would tell
  // the operator the branch was never pushed, about a ref nobody read.
  // A killed probe on the real exec: `execFile`'s timeout kills the child,
  // which lands `code: null` + `killed: true` + a signal — so the code test
  // alone rejects it. The load-bearing fixture is the one below, where the
  // harness reports git's OWN numeric code alongside `killed: true`.
  const killed = await refResolves(
    failingExec({ code: 1, killed: true, signal: "SIGTERM", message: "killed" }),
    "/repo",
    "origin/feat",
  );
  assert(
    killed.state === "unknown",
    `refResolves: a killed probe is unknown (got ${JSON.stringify(killed)})`,
  );

  const signalled = await refResolves(
    failingExec({ code: 1, killed: false, signal: "SIGKILL", message: "signalled" }),
    "/repo",
    "origin/feat",
  );
  assert(
    signalled.state === "unknown",
    `refResolves: a probe that died of a signal is unknown (got ${JSON.stringify(signalled)})`,
  );

  // No numeric code at all — a spawn failure (`ENOENT`), not a git verdict.
  const noCode = await refResolves(
    failingExec({ code: "ENOENT", message: "spawn git ENOENT" }),
    "/repo",
    "origin/feat",
  );
  assert(
    noCode.state === "unknown",
    `refResolves: an error with no numeric code is unknown (got ${JSON.stringify(noCode)})`,
  );

  // The control: git's OWN exit 1, with nothing killed AND its own wording
  // saying the ref is missing, IS absent.
  const gitSaysNo = await refResolves(
    failingExec({
      code: 1,
      killed: false,
      signal: null,
      message: "Command failed: git rev-parse",
      stderr: "fatal: not a valid object name 'origin/feat'\n",
    }),
    "/repo",
    "origin/feat",
  );
  assert(
    gitSaysNo.state === "absent",
    `control: a clean git exit 1 with the missing-ref wording is absent (got ${JSON.stringify(gitSaysNo)})`,
  );

  // #1153 fix round — exit 1 alone is NOT absent: git's wording has to say
  // the ref is missing. An exit 1 with an EMPTY stderr is not evidence about
  // the ref (node rejects on the code alone, so a silent git would otherwise
  // be read as "this branch was never pushed").
  const silentExitOne = await refResolves(
    failingExec({ code: 1, killed: false, signal: null, message: "Command failed", stderr: "" }),
    "/repo",
    "origin/feat",
  );
  assert(
    silentExitOne.state === "unknown",
    `refResolves: exit 1 with no stderr is unknown, not absent (got ${JSON.stringify(silentExitOne)})`,
  );

  // Each of git's missing-ref wordings is absent. The fourth is git's own
  // wording for a name that is not in the object store at all
  // (`rev-parse --verify` on a non-revision), which the regex matches on
  // `not a valid object name` — listed here so a future narrowing of the
  // pattern has to account for it rather than silently dropping it.
  for (const wording of [
    "fatal: not a valid object name 'origin/feat'",
    "fatal: ambiguous argument 'origin/feat': unknown revision or path not in the working tree.",
    "fatal: needed a single revision",
    "fatal: Not a valid object name refs/remotes/origin/feat",
  ]) {
    const r = await refResolves(
      failingExec({
        code: 1,
        killed: false,
        signal: null,
        message: "Command failed",
        stderr: wording,
      }),
      "/repo",
      "origin/feat",
    );
    assert(
      r.state === "absent",
      `refResolves: wording "${wording.slice(0, 40)}…" is absent (got ${r.state})`,
    );
  }

  // Clone-level failures that DO exit 1 are still about the clone, not the
  // ref, so they stay unknown. These are the shapes the reviewer named.
  for (const shape of [
    "fatal: not a git repository (or any of the parent directories): .git",
    "fatal: detected dubious ownership in repository at '/home/dev/project'\nTo add an exception for this directory, call:",
  ]) {
    const r = await refResolves(
      failingExec({
        code: 1,
        killed: false,
        signal: null,
        message: "Command failed",
        stderr: shape,
      }),
      "/repo",
      "origin/feat",
    );
    assert(
      r.state === "unknown",
      `refResolves: "${shape.slice(0, 34)}…" on exit 1 is unknown, not absent (got ${JSON.stringify(r)})`,
    );
    assert(
      r.state === "unknown" && r.error.startsWith("fatal:"),
      `refResolves: the clone-level reason survives in the error text (got ${JSON.stringify(r)})`,
    );
  }

  // git exits 128 (not 1) for a non-repo; either way it is unknown. This is
  // the real-git shape for a non-repo directory. The verdict is the FIRST
  // line here (git prints no advice after it), which is the other side of the
  // last-informative-line rule in `errorText`.
  const notGitRepo = await refResolves(
    failingExec({
      code: 128,
      killed: false,
      signal: null,
      message: "Command failed",
      stderr: "fatal: not a git repository (or any parent up to mount point /)\n",
    }),
    "/repo",
    "origin/feat",
  );
  assert(
    notGitRepo.state === "unknown",
    `refResolves: exit 128 is unknown (got ${JSON.stringify(notGitRepo)})`,
  );
  assert(
    notGitRepo.state === "unknown" &&
      notGitRepo.error.startsWith("fatal: not a git repository"),
    `refResolves: the exit-128 reason survives in the error text (got ${JSON.stringify(notGitRepo)})`,
  );

  // errorText prefers the captured stderr over the generic node message, so
  // the note the operator reads names git's reason rather than the command.
  const stderrCarrying = await refResolves(
    failingExec({
      code: "ENOENT",
      message: "Command failed: git rev-parse --verify",
      stderr: "  fatal: not a git repository (or any of the parent directories): .git  \n",
    }),
    "/repo",
    "origin/feat",
  );
  assert(
    stderrCarrying.state === "unknown" &&
      stderrCarrying.error.startsWith("fatal: not a git repository") &&
      !stderrCarrying.error.includes("Command failed"),
    `errorText: stderr is preferred over message (got ${JSON.stringify(stderrCarrying)})`,
  );

  // A stderr longer than the bound is sliced, never interpolated whole. Built
  // through `errorText` directly rather than through a probe: the point here is
  // the bound, and an all-`fatal:` stream would trip `gitSaysAbsent` into
  // `absent`, which has no `error` field to measure.
  const long = errorText({ stderr: "x".repeat(500) });
  assert(
    long.length === 200,
    `errorText: bounded to 200 chars (got ${long.length})`,
  );

  // aheadOfBase propagates the distinction: a killed head probe is unknown,
  // not the "the branch was not pushed from here" reading `absent` produces.
  const aheadKilled = await aheadOfBase(
    failingExec({ code: 1, killed: true, signal: "SIGTERM", message: "killed" }),
    "/repo",
    "origin/main",
    "origin/feat",
  );
  assert(
    aheadKilled.kind === "unknown",
    `aheadOfBase: a killed probe is unknown, not unpushed (got ${JSON.stringify(aheadKilled)})`,
  );
}

// ── 4. fixtures: exit 0 without an object id is not a resolution ────────────

{
  /** An exec that resolves with a caller-supplied payload (exit 0). */
  const okExec =
    (stdout: string): ExecFn =>
    async () => ({ stdout, stderr: "" });

  // The shape node's child_process leaves behind when a wrapper swallowed the
  // output, and the shape a git shim that only checks the exit code prints.
  // Both exit 0 and say nothing about the ref; `resolves` here would tell the
  // caller "the branch is pushed" on the word of a process that printed
  // nothing.
  for (const [label, stdout] of [
    ["empty stdout", ""],
    ["whitespace only", "  \n"],
    ["a name instead of an id", "origin/feat\n"],
    ["a short hex string", "deadbeef\n"],
    ["a warning line", "warning: something\n"],
    ["two ids, one per line", "0".repeat(40) + "\n" + "1".repeat(40)],
  ] as const) {
    const r = await refResolves(okExec(stdout), "/repo", "origin/feat");
    assert(
      r.state === "unknown" && r.error === "git exited 0 without an object id",
      `refResolves: exit 0 with ${label} is unknown, not resolves (got ${JSON.stringify(r)})`,
    );
  }

  // The control: the payload a real `rev-parse --verify` prints — 40 hex for
  // SHA-1, 64 for a SHA-256 object — does resolve.
  for (const hex of ["0".repeat(40), "a".repeat(64)]) {
    const r = await refResolves(okExec(`${hex}\n`), "/repo", "origin/feat");
    assert(
      r.state === "resolves",
      `control: exit 0 with a ${hex.length}-char object id resolves (got ${JSON.stringify(r)})`,
    );
  }

  // And the real-git control: a genuine probe of a real ref reaches resolves
  // through this same shape check, so the check has not broken the honest path
  // (the fresh-repo probe in section 3 covers the absent side).
  const realRepo = mkdtempSync(path.join(tmpdir(), "git-range-1153-sha-"));
  try {
    const g = (args: string[]) =>
      execGit(exec, realRepo, ["-c", "user.name=t", "-c", "user.email=t@t", ...args]);
    await g(["init", "-q", "-b", "main"]);
    writeFileSync(path.join(realRepo, "a.txt"), "a\n");
    await g(["add", "a.txt"]);
    await g(["commit", "-q", "-m", "base"]);
    const r = await refResolves(exec, realRepo, "HEAD");
    assert(
      r.state === "resolves",
      `refResolves: real git still resolves a present ref (got ${JSON.stringify(r)})`,
    );
  } finally {
    rmSync(realRepo, { recursive: true, force: true });
  }

  // errorText takes the LAST line, and prefers git's VERDICT line over it:
  // `rev-parse --verify` ends with the bare advice line (`pass argument …`, a
  // `fatal:` above it), so last-non-empty alone would report the advice. A
  // stream with no verdict marker still falls back to the last line.
  const multiLine = await refResolves(
    failingExec({
      code: "ENOENT",
      killed: false,
      signal: null,
      message: "Command failed: git rev-parse",
      stderr:
        "fatal: Needed a single revision\nhint: See 'git help repo'\nhint: try something else\n",
    }),
    "/repo",
    "origin/feat",
  );
  assert(
    multiLine.state === "unknown" && multiLine.error === "fatal: Needed a single revision",
    `errorText: the verdict line wins over the advice below it (got ${JSON.stringify(multiLine)})`,
  );
  assert(
    !multiLine.error.includes("hint:"),
    "errorText: the informational lines below the verdict do not reach the note",
  );

  // The other side: git's dubious-ownership error has no `fatal:` after the
  // first line, and the whole tail is remediation advice. The verdict line is
  // what survives it — reporting `git config --global …` as the REASON a probe
  // failed would be a note about a command nobody ran.
  const adviceTail = await refResolves(
    failingExec({
      code: 128,
      killed: false,
      signal: null,
      message: "Command failed",
      stderr:
        "fatal: detected dubious ownership in repository at '/home/dev/project'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory /home/dev/project\n",
    }),
    "/repo",
    "origin/feat",
  );
  assert(
    adviceTail.state === "unknown" &&
      adviceTail.error.startsWith("fatal: detected dubious ownership"),
    `errorText: a fatal line survives the advice block below it (got ${JSON.stringify(adviceTail)})`,
  );

  // And the fallback: with no verdict marker anywhere, the last non-empty line
  // is the most informative thing the process said.
  assert(
    errorText({ stderr: "one\ntwo\n  three  \n" }) === "three",
    `errorText: no verdict marker → the last non-empty line (got ${JSON.stringify(errorText({ stderr: "one\ntwo\n  three  \n" }))})`,
  );

  // A non-string field that stringifies usefully is coerced rather than cast
  // away, and one that does not still yields a string rather than throwing.
  for (const [label, stderr] of [
    ["an object with toString", { toString: () => "fatal: coerced" }],
    ["a number", 42],
    ["a nested object", { a: 1 }],
  ] as const) {
    const r = await refResolves(
      failingExec({ code: "ENOENT", message: "m", stderr }),
      "/repo",
      "origin/feat",
    );
    assert(
      r.state === "unknown" && typeof r.error === "string" && r.error.length > 0,
      `errorText: ${label} is coerced to a non-empty string, not cast (got ${JSON.stringify(r)})`,
    );
  }
}

process.exit(exit);
