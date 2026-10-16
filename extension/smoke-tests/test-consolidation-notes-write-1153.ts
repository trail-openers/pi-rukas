#!/usr/bin/env bun
/**
 * #1153 — `pipelineState.consolidationNotes` is written by the commit-pr
 * events writer, validated by the state validator, and escaped by the handoff
 * renderer. Four things the field has to get right, none of which the
 * render-only test (test-consolidation-notes-1153.ts) exercises:
 *
 *   A. WRITE — a skipped consolidation check lands on
 *      `pipelineState.consolidationNotes` through the real writer
 *      (`runCommitPrPostDispatchGates`), not just on the returned result.
 *   B. CLEAR — a clean run (the check ran, produced no notes) clears notes an
 *      earlier commit-pr attempt left behind. Stale notes would tell the
 *      operator a check was skipped that in fact ran.
 *   C. VALIDATE — a non-array, or an array with a non-string entry, is
 *      reported by `validateDiscriminants`; a well-formed array is not.
 *   D. ESCAPE — the renderer bounds, flattens, coerces, and fences a note so
 *      its own backticks cannot break out of the code span it is rendered into.
 *
 * The consolidation read uses the real executors (work-driver-verify.ts's
 * `execp` is not injectable), so each case builds a real repository and makes
 * exactly ONE git fact false — the `origin/<branch>` ref probe — rather than
 * stubbing the executor. A repo whose HEAD is an unreadable commit object
 * makes `rev-parse --verify` fail exactly there, and the probe sees it.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCommitPrPostDispatchGates } from "../src/work-driver-commit-pr-events.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { renderNoteBullet } from "../src/work-driver-handoff-markdown.ts";
import { verifyConsolidation } from "../src/work-driver-verify.ts";
import { validateDiscriminants } from "../src/workflow-state-validate.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const BRANCH = "feature/issue-1153-consolidation-notes";
/** Every consolidation note the writer is expected to persist starts with this. */
const SKIPPED_PREFIX = "consolidation check skipped: ";
const STALE = "consolidation check skipped: no branch recorded";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * A clone with a baseline on main (origin/main + origin/HEAD) and the branch
 * pushed. `unreadableBranchHead` destroys the branch tip's COMMIT object, so
 * the `rev-parse --verify` probe still resolves (git reads the ref, not the
 * object) while every read that must WALK the history — the consolidation
 * diff, the ahead-count — fails. That is the "the check could not run" shape,
 * produced from a real repository rather than a stubbed executor, which is
 * what `verifyConsolidation` needs: its executor comes from `ctx.verifyExecFn`,
 * and a fabricated one would not be the production path.
 */
function mkRepo(dir: string, opts: { unreadableBranchHead: boolean }) {
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "T");
  git(dir, "commit", "-q", "--allow-empty", "-m", "baseline");
  git(dir, "update-ref", "refs/remotes/origin/main", "HEAD");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  git(dir, "checkout", "-qb", BRANCH);
  for (const f of ["src/a.ts", "src/b.ts"]) {
    const fp = path.join(dir, f);
    mkdirSync(path.dirname(fp), { recursive: true });
    writeFileSync(fp, `content of ${f}\n`);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "committed work");
  git(dir, "update-ref", `refs/remotes/origin/${BRANCH}`, "HEAD");
  if (opts.unreadableBranchHead) {
    // Delete the tip's object so the probe of `origin/<branch>` cannot
    // complete. Which tri-state branch that lands on is git-version detail;
    // what this test pins is that whichever branch it is, the writer
    // PERSISTS the resulting note (see the assertions below, which accept
    // either "could not check" or "diff ... failed" and reject silence).
    git(dir, "update-ref", "refs/tip", `refs/remotes/origin/${BRANCH}`);
    const tip = git(dir, "rev-parse", `refs/remotes/origin/${BRANCH}`);
    rmSync(path.join(dir, ".git", "objects", tip.slice(0, 2), tip.slice(2)));
  }
}

/** Two workstreams: N=1 short-circuits consolidation by design, so N must be ≥2. */
function consolidationState(staleNotes?: string[]): WorkState {
  const s = initialState(1153, 1_000_000);
  return {
    ...s,
    eventLog: [
      {
        kind: "dispatch-completed",
        at: 1_000_100,
        jobId: "j-notes",
        step: "commit-pr",
        role: "ops",
        ok: true,
        summary: "Done.\npr: 1397",
      },
    ],
    pipelineState: {
      ...s.pipelineState,
      currentStep: "commit-pr",
      branchName: BRANCH,
      // Unreadable worktrees: consolidation's per-workstream cumulative read
      // is not what this test is about, and it fails closed (touched) rather
      // than inventing coverage.
      worktrees: { a: "/tmp/no-such-wt-a", b: "/tmp/no-such-wt-b" },
      workstreams: {
        a: { id: "a", scope: "task-a", paths: ["src/a.ts"], outOfScope: [] },
        b: { id: "b", scope: "task-b", paths: ["src/b.ts"], outOfScope: [] },
      },
      // No acceptance criteria → the coverage gate skips and stays out of the
      // way of the notes assertion.
      normalisedSpec: {
        intent: "i",
        deliverables: [],
        acceptanceCriteria: [],
        outOfScope: [],
        assumptions: [],
        openQuestions: [],
        evidence: [],
        verdict: "proceed",
        rationale: "",
      },
      ...(staleNotes ? { consolidationNotes: staleNotes } : {}),
    },
  };
}

/** A single-workstream state: consolidation structurally does not apply. */
function singleWorkstreamState(staleNotes?: string[]): WorkState {
  const s = consolidationState(staleNotes);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      workstreams: { a: { id: "a", scope: "task-a", paths: ["src/a.ts"], outOfScope: [] } },
      worktrees: { a: "/tmp/no-such-wt-a" },
    },
  };
}

// ── A. the writer persists a skipped check onto pipelineState ────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "cn-write-"));
  try {
    mkRepo(dir, { unreadableBranchHead: true });
    const ctx = { host: {} as never, repoRoot: dir, issue: 1153 } as DriverContext;
    const out = await runCommitPrPostDispatchGates(ctx, undefined as never, consolidationState());
    const notes = out.pipelineState.consolidationNotes ?? [];
    assert(
      notes.length === 1 && notes[0]?.startsWith(SKIPPED_PREFIX) && notes[0]?.includes("failed"),
      `writer: the skipped check is persisted on pipelineState (got ${JSON.stringify(notes)})`,
    );
    // #1153 fix round — the note carries GIT'S REASON, not node's argv. The
    // old note was `(err as Error).message.slice(0,120)`, and node's message
    // is `Command failed: git diff --name-status -M --end-of-options …` — so
    // the 120-char budget went on the command name and left one character of
    // the reason. The reason is the only part an operator can act on.
    assert(
      notes.some((n) => /fatal:/.test(n)),
      `note: git's own fatal reason is in the persisted note (got ${JSON.stringify(notes)})`,
    );
    // …and the range in the note is rendered by prRange, so it names the
    // three-dot range the diff was actually asked for.
    assert(
      notes.some((n) => n.includes(`origin/main...origin/${BRANCH}`)),
      `note: the prRange the diff failed on is named (got ${JSON.stringify(notes)})`,
    );
    // The absolute repoRoot is redacted: this note is persisted to the state
    // file and rendered into a forge comment, neither of which is anywhere the
    // operator's host path belongs.
    assert(
      notes.every((n) => !n.includes(dir)),
      `note: the absolute repoRoot is redacted (got ${JSON.stringify(notes)})`,
    );
    assert(
      notes.every((n) => !n.includes("Command failed")),
      "note: node's generic 'Command failed' prefix does not reach the note",
    );
    assert(
      notes.every((n) => typeof n === "string"),
      "writer: every persisted note is a string",
    );
    // The #1153 distinction: an unreadable probe is "could not check", never
    // the "not pushed from here" claim `absent` produces.
    assert(
      !notes.some((n) => n.includes("not pushed from here")),
      "writer: an unreadable probe does not read as an unpushed branch",
    );
    // And the check is recorded as NOT having run, so the validator accepts it.
    assert(
      validateDiscriminants(out).length === 0,
      `writer: the persisted state validates clean (got ${JSON.stringify(validateDiscriminants(out))})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── B. a clean run clears notes from an earlier attempt ──────────────────────
{
  const dir = mkdtempSync(path.join(tmpdir(), "cn-clear-"));
  try {
    mkRepo(dir, { unreadableBranchHead: true });
    const ctx = { host: {} as never, repoRoot: dir, issue: 1153 } as DriverContext;

    // Notes accumulate (deduped) when a later attempt skips a different check.
    const out = await runCommitPrPostDispatchGates(
      ctx,
      undefined as never,
      consolidationState([STALE]),
    );
    const notes = out.pipelineState.consolidationNotes ?? [];
    assert(
      notes.includes(STALE) &&
        notes.some((n) => n.startsWith(SKIPPED_PREFIX)) &&
        notes.length === 2,
      `writer: notes accumulate rather than replace (got ${JSON.stringify(notes)})`,
    );

    // The clean side: consolidation ran and produced nothing, so the note the
    // earlier attempt left is no longer true and must not survive into the
    // handoff of a cycle whose consolidation is genuinely clean.
    const dirty = singleWorkstreamState([STALE]);
    const res = await verifyConsolidation(ctx as never, dirty);
    assert(res.notes.length === 0, "clean: a run that does not apply produces no notes");
    const cleared = await runCommitPrPostDispatchGates(ctx, undefined as never, dirty);
    assert(
      cleared.pipelineState.consolidationNotes === undefined,
      `clean: a run with no notes CLEARS stale ones (got ${JSON.stringify(cleared.pipelineState.consolidationNotes)})`,
    );
    // The control: had the writer left the field alone, the stale note would
    // still be there.
    assert(
      dirty.pipelineState.consolidationNotes?.includes(STALE) === true,
      "control: the stale note was present before the clean run",
    );

    // #1153 fix round — the round trip. "Cleared" here means the property is
    // PRESENT-AND-`undefined`, not deleted, and the state's real life is as
    // JSON on disk: `persistState` serialises it and a resume reads it back.
    // `JSON.stringify` DROPS a key whose value is `undefined`, so the round
    // trip is what proves the clear survives serialisation rather than being
    // an artefact of the in-memory object — and the validator still accepts
    // the field's absence afterwards (an absent field is legitimate: a cycle
    // that never skipped a check has no notes to record).
    // #1153 round 3 — the key is DELETED, not assigned `undefined`. The JSON
    // round trip below would pass either way (`stringify` drops an
    // undefined-valued key), so the in-memory shape is what pins the
    // difference: a present-and-undefined key still reports `in`, which is what
    // the tolerant readers look at.
    const restored: WorkState = JSON.parse(JSON.stringify(cleared));
    assert(
      !("consolidationNotes" in cleared.pipelineState),
      "clean: the cleared key is deleted from the in-memory state, not undefined-valued",
    );
    assert(
      !("consolidationNotes" in restored.pipelineState),
      "round-trip: the cleared field is ABSENT after JSON persist/restore, not undefined-valued",
    );
    assert(
      restored.pipelineState.consolidationNotes === undefined,
      `round-trip: reading the restored state yields no notes (got ${JSON.stringify(restored.pipelineState.consolidationNotes)})`,
    );
    assert(
      validateDiscriminants(restored).length === 0,
      `round-trip: the restored state validates clean (got ${JSON.stringify(validateDiscriminants(restored))})`,
    );
    // And the same round trip with notes still on it keeps them — proving the
    // assertion above is about the clear, not about JSON dropping the field.
    const stillNoted: WorkState = JSON.parse(JSON.stringify(out));
    assert(
      Array.isArray(stillNoted.pipelineState.consolidationNotes) &&
        stillNoted.pipelineState.consolidationNotes?.length === 2,
      `control: JSON round-trip preserves notes that were set (got ${JSON.stringify(stillNoted.pipelineState.consolidationNotes)})`,
    );

    // #1153 round 3 — a LEGACY non-array on the field is cleared too. The
    // predicate used to be `priorNotes?.length`, which is falsy for a string,
    // so a state file written before the validator guarded this field kept its
    // junk note on the field of a cycle the gate had just called clean — the
    // exact stale-note shape the clear exists to remove.
    const legacy = singleWorkstreamState("not an array" as unknown as string[]);
    assert(
      legacy.pipelineState.consolidationNotes !== undefined,
      "control: the legacy non-array note is on the field before the clean run",
    );
    const clearedLegacy = await runCommitPrPostDispatchGates(ctx, undefined as never, legacy);
    assert(
      !("consolidationNotes" in clearedLegacy.pipelineState),
      `clean: a legacy non-array value is CLEARED, not left behind (got ${JSON.stringify(clearedLegacy.pipelineState.consolidationNotes)})`,
    );

    // #1153 round 3 — the PERSISTED list is bounded, newest kept. The renderer
    // has always bounded the comment; the state file had no bound, so a cycle
    // that re-entered commit-pr against a broken git grew without limit.
    const flooded = consolidationState(
      Array.from({ length: 45 }, (_, i) => `${SKIPPED_PREFIX}stale note ${i}`),
    );
    const capped = await runCommitPrPostDispatchGates(ctx, undefined as never, flooded);
    const kept = capped.pipelineState.consolidationNotes ?? [];
    // Newest kept, oldest dropped: the 45 stale notes plus this fixture's one
    // fresh note are 46 distinct strings, so the surviving window is the last
    // 19 stale ones (notes 26…44) followed by the fresh note.
    assert(
      kept.length === 20,
      `writer: the persisted list is bounded to 20 (got ${kept.length})`,
    );
    assert(
      kept[0] === `${SKIPPED_PREFIX}stale note 26` &&
        kept[18] === `${SKIPPED_PREFIX}stale note 44` &&
        kept[19] === notes[1],
      `writer: the NEWEST 20 survive, oldest dropped (got ${JSON.stringify([kept[0], kept[18], kept[19]])})`,
    );
    assert(
      !kept.some((n) => n === `${SKIPPED_PREFIX}stale note 0`),
      "writer: the oldest note is the one that went",
    );
    assert(
      validateDiscriminants(capped).length === 0,
      `writer: the bounded list still validates clean (got ${JSON.stringify(validateDiscriminants(capped))})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── C. the validator rejects a malformed notes field ─────────────────────────
{
  const withNotes = (value: unknown): WorkState => {
    const s = consolidationState();
    (s.pipelineState as Record<string, unknown>).consolidationNotes = value;
    return s;
  };
  assert(
    validateDiscriminants(withNotes(["a note"])).length === 0,
    "validator: an array of strings is accepted",
  );
  assert(
    validateDiscriminants(withNotes(undefined)).length === 0,
    "validator: an absent field is accepted",
  );
  const notArray = validateDiscriminants(withNotes("a note"));
  assert(
    notArray.some((e) => e.includes("consolidationNotes") && e.includes("not an array")),
    `validator: a non-array is reported (got ${JSON.stringify(notArray)})`,
  );
  const badEntry = validateDiscriminants(withNotes(["fine", 42]));
  assert(
    badEntry.some((e) => e.includes("consolidationNotes") && e.includes("non-string")),
    `validator: a non-string entry is reported (got ${JSON.stringify(badEntry)})`,
  );
}

// ── D. the renderer escapes the note ─────────────────────────────────────────
{
  const plain = renderNoteBullet("consolidation check skipped: no branch recorded");
  assert(
    plain.startsWith("- `") && plain.endsWith("`") && !plain.includes("``"),
    `render: a plain note is a single-backtick bullet (got ${plain})`,
  );

  // A note carrying its own backticks must not close its own span: the fence
  // grows past the note's longest run, so the remainder stays data.
  const ticked = renderNoteBullet("git said `` not a repo ` at HEAD");
  assert(
    ticked.startsWith("- ``` ") && ticked.endsWith(" ```"),
    `render: a double-backtick note gets a triple fence (got ${ticked})`,
  );
  assert(
    ticked.includes("`` not a repo ` at HEAD"),
    "render: the note's own backticks survive verbatim inside the fence",
  );

  // Newlines collapse — a multi-line note would break the bullet list.
  const multiline = renderNoteBullet("line one\nline two\r\nline three");
  assert(
    !multiline.includes("\n") && multiline.includes("line one line two line three"),
    `render: newlines collapse to spaces (got ${multiline})`,
  );

  // Length is bounded: a note composed from a git stderr can be megabytes.
  const long = renderNoteBullet("x".repeat(5000));
  assert(
    (long.match(/x/g) ?? []).length === 500,
    `render: the bound is 500 chars (got ${(long.match(/x/g) ?? []).length})`,
  );

  // A non-string survives the render rather than throwing.
  const coerced = renderNoteBullet({ a: 1 });
  assert(
    coerced.startsWith("- `") && coerced.includes("[object Object]"),
    `render: a non-string is coerced (got ${coerced})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
