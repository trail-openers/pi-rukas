#!/usr/bin/env bun
/**
 * Smoke test for #1134 follow-up guards:
 *   G1  resolveMainline is total: a throw / undefined / unexpected shape is an
 *       unresolved result, never an escaping exception or TypeError.
 *   G2  readIntegratedDiff + verifyStepOutcome(commit-pr) map an unresolved
 *       mainline to their explicit failure outcome.
 *   G3  a branch that was never pushed from this clone is a NAMED failure /
 *       note, not an "unverifiable" reading.
 *   G4  verifyConsolidation: no recorded branch → explicit note; argv reaches
 *       git verbatim (a shell metacharacter in the branch name is data).
 *   G5  the commit-pr count runs through argv in production (no verifyExecFn):
 *       a pushed branch with commits ahead counts without a failure.
 *   G6  verifyConsolidation: unresolved mainline → named note, no origin/main diff.
 *
 * Real git repos throughout, so the commands the gates run are the ones git sees.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { consolidationNote } from "../src/work-driver-consolidation-note.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { readIntegratedDiff } from "../src/work-driver-diff.ts";
import { resolveMainline } from "../src/work-driver-git.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { verifyConsolidation } from "../src/work-driver-verify.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_VERIFY = "1";
process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = "";

const BRANCH = "feature/issue-1134-guards";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A clone with a baseline on main (origin/main + origin/HEAD set) and a branch. */
function mkRepo(dir: string, branch: string, committed: string[], pushed: boolean) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  git(dir, "commit", "-q", "--allow-empty", "-m", "baseline");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(dir, "checkout", "-qb", branch);
  for (const f of committed) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), `content of ${f}\n`);
  }
  if (committed.length > 0) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "committed work");
  }
  if (pushed) git(dir, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
}

function stateFor(
  branch: string | undefined,
  workstreams: Record<string, { id: string; scope: string; paths: string[]; outOfScope: string[] }>,
): WorkState {
  const s = initialState(1134, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      branchName: branch,
      prNumber: undefined,
      worktrees: Object.fromEntries(
        Object.keys(workstreams).map((id) => [id, `/tmp/no-such-${id}`]),
      ),
      workstreams,
    },
  };
}

function ctxFor(dir: string): DriverContext {
  return {
    host: {} as unknown as DriverContext["host"],
    repoRoot: dir,
    issue: 1134,
  };
}

const ws = (id: string, paths: string[]) => ({
  id,
  scope: `task-${id}`,
  paths,
  outOfScope: [],
});

// ── G1: resolveMainline totality ─────────────────────────────────────────────
{
  const noExec = async () => ({ stdout: "" });
  const threw = await resolveMainline("/x", noExec, async () => {
    throw new Error("boom");
  });
  assert(
    !("branch" in threw) && threw.reason.includes("threw"),
    "G1 detector throw → unresolved with reason",
  );
  const undef = await resolveMainline("/x", noExec, (async () => undefined) as never);
  assert(
    !("branch" in undef) && undef.reason.includes("unexpected"),
    "G1 undefined result → unresolved, no TypeError",
  );
  const empty = await resolveMainline("/x", noExec, async () => ({
    ok: true as const,
    branch: "",
  }));
  assert(
    !("branch" in empty) && empty.reason.includes("unexpected"),
    "G1 empty branch → unresolved",
  );
  const reasoned = await resolveMainline("/x", noExec, async () => ({
    ok: false as const,
    reason: "nope",
  }));
  assert(
    !("branch" in reasoned) && reasoned.reason === "nope",
    "G1 detector reason passes through",
  );
  const ok = await resolveMainline("/x", noExec, async () => ({
    ok: true as const,
    branch: "main",
  }));
  assert("branch" in ok && ok.branch === "main", "G1 resolved branch passes through");
}

// ── G2: unresolved mainline is an explicit outcome, not an exception ─────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "g2-nomain-"));
  try {
    mkRepo(dir, BRANCH, ["src/a.ts"], true);
    // Drop origin/HEAD so symbolic-ref cannot resolve the mainline.
    git(dir, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    const r = await readIntegratedDiff(dir, BRANCH);
    assert(
      !r.ok && r.reason.includes("could not resolve mainline"),
      "G2 readIntegratedDiff: unresolved mainline → ok:false with reason",
    );
    const state = stateFor(BRANCH, {});
    const gate = await verifyStepOutcome(ctxFor(dir), state, "commit-pr");
    assert(
      gate.failures.some((f) => f.includes("the mainline is unresolved")),
      "G2 verifyStepOutcome(commit-pr): unresolved mainline → named failure",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── G3: never-pushed branch is a named failure ───────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "g3-unpushed-"));
  try {
    mkRepo(dir, BRANCH, ["src/a.ts"], false);
    const gate = await verifyStepOutcome(ctxFor(dir), stateFor(BRANCH, {}), "commit-pr");
    assert(
      gate.failures.includes(
        `origin/${BRANCH} not found in this clone — the branch was not pushed from here`,
      ),
      "G3 commit-pr: missing origin/<branch> → named failure",
    );
    assert(
      !gate.failures.some((f) => f.includes("unverifiable")),
      "G3 commit-pr: no generic 'unverifiable' wording",
    );
    const cons = await verifyConsolidation(
      ctxFor(dir),
      stateFor(BRANCH, { a: ws("a", ["src/a.ts"]), b: ws("b", ["src/b.ts"]) }),
    );
    assert(
      cons.missing.length === 0 &&
        cons.notes.length === 1 &&
        cons.notes[0]?.includes("not found in this clone"),
      "G3 consolidation: missing origin/<branch> → best-effort result + named note",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── G4a: no branch recorded → explicit note ──────────────────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "g4a-nobranch-"));
  try {
    mkRepo(dir, BRANCH, ["src/a.ts"], true);
    const cons = await verifyConsolidation(
      ctxFor(dir),
      stateFor(undefined, {
        a: ws("a", ["src/a.ts"]),
        b: ws("b", ["src/b.ts"]),
      }),
    );
    assert(
      cons.missing.length === 0 &&
        cons.notes.join("|") === "consolidation check skipped: no branch recorded",
      "G4a no branch → visible note 'consolidation check skipped: no branch recorded'",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── G4b: argv reaches git — a metacharacter branch name is data, not a shell ──
{
  const dir = mkdtempSync(path.join(tmpdir(), "g4b-argv-"));
  const marker = "PWNED-1134";
  // git refuses spaces and colons in a ref; `$(>MARKER)` is a legal name that
  // creates MARKER if a shell ever expands it.
  const meta = `feature/issue-1134-$(>${marker})`;
  try {
    mkRepo(dir, meta, ["src/a.ts", "src/b.ts"], true);
    const ok = await verifyConsolidation(
      ctxFor(dir),
      stateFor(meta, {
        a: ws("a", ["src/a.ts", "src/b.ts"]),
        b: ws("b", ["src/b.ts"]),
      }),
    );
    assert(
      ok.missing.length === 0 && ok.notes.length === 0,
      "G4b committed paths read through argv → covered, no note",
    );
    // Negative control: a declared path that never shipped must still be caught,
    // so the empty result above is a real diff read and not a silent pass.
    const dropped = await verifyConsolidation(
      ctxFor(dir),
      stateFor(meta, {
        a: ws("a", ["src/a.ts", "src/zzz.ts"]),
        b: ws("b", ["src/b.ts"]),
      }),
    );
    assert(
      dropped.missing.some((m) => m.id === "a"),
      "G4b negative control: undelivered path is still uncovered",
    );
    assert(
      !existsSync(path.join(dir, marker)),
      "G4b branch name with $(...) never reached a shell",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── G5: production commit-pr count runs through argv (no verifyExecFn) ───────
{
  const dir = mkdtempSync(path.join(tmpdir(), "g5-count-"));
  try {
    mkRepo(dir, BRANCH, ["src/a.ts"], true);
    const gate = await verifyStepOutcome(ctxFor(dir), stateFor(BRANCH, {}), "commit-pr");
    const countFailures = gate.failures.filter(
      (f) => f.includes("could not count") || f.includes("not found in this clone"),
    );
    assert(
      countFailures.length === 0,
      "G5 pushed branch with commits ahead counts via argv (no bare-git failure)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── G6: unresolved mainline → named note, and no `origin/main` diff is issued ─
{
  const dir = mkdtempSync(path.join(tmpdir(), "g6-nomain-consol-"));
  try {
    mkRepo(dir, BRANCH, ["src/a.ts"], true);
    // origin/main and origin/<branch> both resolve; only the mainline is unknown.
    git(dir, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    // `src/zzz.ts` never shipped: a diff against origin/main WOULD flag workstream
    // `a` as missing, so an empty `missing` proves no such diff was issued.
    const cons = await verifyConsolidation(
      ctxFor(dir),
      stateFor(BRANCH, {
        a: ws("a", ["src/a.ts", "src/zzz.ts"]),
        b: ws("b", ["src/b.ts"]),
      }),
    );
    assert(
      cons.missing.length === 0 &&
        cons.notes.length === 1 &&
        cons.notes[0]?.startsWith("consolidation check skipped: mainline unresolved: ") === true,
      "G6 consolidation: unresolved mainline → best-effort result + named note, no origin/main diff",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── G7: the note composer is one contract, not five sites ─────────────────────
//
// Every skip site in `verifyConsolidation` composes through
// `consolidationNote`, which is where redaction, flattening and the bound live.
// Before round 3 each site did its own `replaceAll` + slice (and three did
// neither), so a note from the less-defended site carried the host path and a
// multi-line stderr into the state file and the forge comment. These are the
// properties the G3/G4a/G6 notes above do not exercise.
{
  const dir = mkdtempSync(path.join(tmpdir(), "g7-note-composer-"));
  try {
    // The un-redacted path is the whole point of the assertion, so the fixture
    // is a real directory (a fake `/repo` would pass a redaction bug that
    // misses one spelling).
    const real = realpathSync(dir);
    const note = consolidationNote(
      `diff of origin/main...origin/x failed at ${dir}: hint: look here\n${real} again\r\nfatal: bad object \u0007\u2028line`,
      { repoRoot: dir },
    );
    assert(
      note.startsWith("consolidation check skipped: "),
      `G7 composer: every note carries the skipped-check prefix (got ${JSON.stringify(note)})`,
    );
    assert(
      !note.includes(dir) && !note.includes(real),
      `G7 composer: both repoRoot spellings are redacted (got ${JSON.stringify(note)})`,
    );
    assert(
      note.includes("<repo>"),
      "G7 composer: the redaction leaves a marker rather than deleting the path",
    );
    assert(
      !/[\r\n\u2028\u2029\u0085]/.test(note),
      `G7 composer: every line terminator collapses (got ${JSON.stringify(note)})`,
    );
    assert(!note.includes("\u0007"), "G7 composer: C0 controls are stripped");
    assert(
      note.length <= "consolidation check skipped: ".length + 500,
      `G7 composer: the note is bounded to 500 content chars (got ${note.length})`,
    );

    // The bound is applied to the content, so an unbounded stderr cannot
    // stretch the note past it however long the path prefix is.
    const huge = consolidationNote(`x${"y".repeat(10_000)}${dir}`, { repoRoot: dir });
    assert(
      huge.length === "consolidation check skipped: ".length + 500,
      `G7 composer: a megabyte stderr is bounded at the source (got ${huge.length})`,
    );
    // Control: the same call with nothing to redact and nothing to flatten is
    // returned verbatim, so the composer is not mangling honest notes.
    assert(
      consolidationNote("no branch recorded", { repoRoot: dir }) ===
        "consolidation check skipped: no branch recorded",
      "G7 composer: control — a plain note passes through unchanged",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(exit);
