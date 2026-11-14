/**
 * #2223 (L-lean) — lean's review step must not inherit the incomplete-round lie.
 *
 * lean buys the six-lens pass through `createReviewDeps().lens`, which is the real
 * `runLensReview` with only its six model children stubbed (`ReviewDeps.lensChildFn`,
 * the harness seam for exactly this). So the step reads the same ledger the layer
 * writes and its delta base is the one the layer resolves: an incomplete round wrote a
 * row carrying the head it never reviewed, and the step's next round — same head, no
 * new commit — came back through the layer's empty-delta arm as `noReview: true` with
 * no lens behind it, which `assertRan` refuses.
 *
 * That is a handback with no verdict on the path every `/work-lean` run takes, and the
 * only reason it is reachable is a ledger row read as evidence it is not. The fix lands
 * on the SHARED path (L2, `lens-review-auto-delta.ts`), which is why the step is
 * unchanged — and why the case is driven through the step: a reader-side fix that lean
 * could not see would still pass the reader's own test.
 *
 * The grain is deliberate. `lensEngine` would stub the layer and prove nothing about
 * which base the layer resolves, so the engine runs for real and only the six children
 * are stubbed — the blocked rows are what an EDQUOT / quota / missing-skills round looks
 * like from the fan-out.
 *
 * WHY THE STEP IS DRIVEN TWICE IN ONE PROCESS AND THE LEDGER IS HAND-BUILT BETWEEN THE
 * PASSes. The step hands the layer `cwd = repoRoot`, where lean's run checkout sits at
 * its base commit (the branch lives in the run's worktree), so the layer's own ledger
 * write resolves NO patch-id there — `workingTreePatchId` cannot build a diff between a
 * checkout and a mainline it does not contain — and nothing is recorded. That is the
 * layer failing closed, correctly, and it also means a harness that drove two rounds and
 * read the delta base out of the layer's own write would assert on a ledger the first
 * round never wrote: silently vacuous, not red. So pass 1 drives the REAL engine and
 * takes its summary; the row the round would have recorded is then written through the
 * PRODUCTION writer (`appendLedgerEntry` + `bumpLensRound`, no hand-edited fields) with
 * the identity the writer itself computes at the reviewed head — the same pair the
 * non-lean harness (`lib/lens-incomplete-round-fixture.ts`) produces by running the
 * layer where a real identity does resolve. Pass 2 then runs the step again, so the
 * claim under test is the step's: the round the layer hands the step after an
 * incomplete round is a full review, never the no-review outcome.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { LensRunResult } from "../src/lens-review-types.ts";
import { runLensReview } from "../src/lens-review.ts";
import { execp } from "../src/exec.ts";
import type { LensArgs, LensRound } from "../src/lean/review-args.ts";
import {
  type LedgerEntry,
  appendLedgerEntry,
  latestEntry,
  readLedgerAt,
  workingTreePatchId,
} from "../src/review-ledger.ts";
import {
  ReviewInfraError,
  cleanLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  makeRepo,
  result,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const BRANCH = "lean/issue-7";
const FEATURE = "export const f = 1;\n";

/** The stub the real engine calls: every lens child blocked before it started. */
const allBlocked = async (a: { lens: { name: string } }): Promise<LensRunResult> =>
  ({
    lens: a.lens.name,
    ok: false,
    ms: 0,
    startMs: Date.now(),
    findings: [],
    // `attempts: 0` is a lens that NEVER started — a spawn that died on a quota
    // error, not a child that answered and got discounted. Only that shape makes
    // the round incomplete rather than merely clean.
    attempts: 0,
    blocked: true,
    parseError: "lens child spawn failed: quota exceeded",
    toolUses: [],
  }) as unknown as LensRunResult;

/** What one round of the layer produced, as the step saw it. */
type Round = { verdict: string; noReview?: boolean; since?: string; head?: string };

/** One harness run: both rounds the step took, and where it landed. */
interface Run {
  rounds: Round[];
  threw: (Error | undefined)[];
  kinds: (string | undefined)[];
  /** The branch's lens rows after both passes. */
  rows: () => LedgerEntry[];
  /** The head pass 1 reviewed. */
  head: string;
  ledger: string;
  repoRoot: string;
}

/**
 * Run the step twice over ONE repo and ONE ledger: pass 1 with all six lens children
 * blocked (the incomplete round), pass 2 a fresh attempt at the same head with no new
 * commit — the re-dispatch that used to be refused. Between them, the row pass 1's
 * round stands for is written through the production writer (see the file header).
 */
async function twice(): Promise<Run> {
  const { repoRoot, baseSha } = makeRepo();
  const head = await setup({ repoRoot, baseSha, branch: BRANCH, feature: FEATURE });
  const dir = mkdtempSync(path.join(os.tmpdir(), "lean2223-"));
  const file = path.join(dir, "review-ledger.json");
  writeFileSync(file, '{"entries":[]}', "utf8");
  const prior = [process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE, process.env.PI_ENSEMBLE_SKILLS_DIR];
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = file;
  // The repository's own bundled lens skills, so no lens is blocked by the HOST's
  // missing install — the blocked rows must come from the stub alone.
  process.env.PI_ENSEMBLE_SKILLS_DIR = path.resolve(import.meta.dirname, "..", "..", "skill");
  const rounds: Round[] = [];
  const threw: (Error | undefined)[] = [];
  const kinds: (string | undefined)[] = [];
  try {
    for (const attempt of [1, 2]) {
      const { outcome, threw: t } = await runStep(
        ctxFor(repoRoot, baseSha, BRANCH),
        depsWith({
          adversarial: async () => result({ loopOutcome: "approved" }),
          dispatch: async () => result({ role: "developer" }),
          ...(attempt === 1 ? { lensChildFn: allBlocked } : {}),
          lens: async (a) => {
            // Pass 1 runs the REAL layer with only its six children stubbed — the
            // grain that lets a case ask which base the layer resolved; stubbing the
            // layer would answer that from a fixture. Pass 2 answers from the harness's
            // own clean round so the step's pass arm stays reachable with no model
            // child behind it, as in every other lean case.
            const round = attempt === 1 ? await engineRound(a) : await cleanLensRoundAsync();
            rounds.push({
              verdict: round.verdict,
              ...(round.noReview === true ? { noReview: true } : {}),
              ...(round.deltaReview === undefined
                ? {}
                : { since: round.deltaReview.since, head: round.deltaReview.head }),
            });
            if (attempt === 1) await recordIncompleteRound(a.cwd, file, round);
            return round;
          },
        }),
      );
      threw.push(t);
      kinds.push(outcome?.kind);
    }
  } finally {
    const [ledger, skills] = prior;
    if (ledger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledger;
    if (skills === undefined) delete process.env.PI_ENSEMBLE_SKILLS_DIR;
    else process.env.PI_ENSEMBLE_SKILLS_DIR = skills;
  }
  return {
    rounds,
    threw,
    kinds,
    head,
    ledger: file,
    repoRoot,
    rows: () => readLedgerAt(file).filter((e) => e.kind === "lens" && e.branch === BRANCH),
  };
}

/** One round through the real review layer, its six model children stubbed. */
async function engineRound(a: LensArgs): Promise<LensRound> {
  const pending: Promise<unknown>[] = [];
  const s = await runLensReview({
    base: a.base,
    head: a.head,
    cwd: a.cwd,
    branch: a.branch,
    ...(a.pr === undefined ? {} : { pr: a.pr }),
    ...(a.since === undefined ? {} : { since: a.since }),
    ...(a.full === true ? { full: true } : {}),
    ...(a.threshold === undefined ? {} : { threshold: a.threshold }),
    ...(a.context === undefined ? {} : { context: a.context }),
    onLedgerWrite: (p) => {
      pending.push(p);
    },
    lensChildFn: allBlocked as never,
  });
  // The round's ledger write is fire-and-forget by contract; the case awaits the
  // layer's own seam rather than a delay that is only ever a race that passes.
  await Promise.all(pending);
  return {
    verdict: s.verdict,
    findings: "",
    reported: s.findings,
    advisory: s.advisory ?? [],
    lenses: s.lenses,
    // A blocked fan-out bills nothing, and the step's `assertRan` reads an absent
    // aggregate as "a verdict bought for free" and refuses it. Reporting the rows the
    // layer reported is honest; the step still refuses, on its OWN incomplete-verdict
    // arm, which is what (1) asserts.
    ...(s.usage === undefined ? {} : { usage: s.usage }),
    ...(s.noReview === true ? { noReview: true } : {}),
    ...(s.deltaReview === undefined ? {} : { deltaReview: s.deltaReview }),
  } as LensRound;
}

const cleanLensRoundAsync = async (): Promise<LensRound> => cleanLensRound();

/**
 * Record the row the incomplete round stands for, through the PRODUCTION writer.
 *
 * Only `headSha` and the identity are supplied by the case, and the identity is the one
 * the writer itself computes at the reviewed head — never a literal. `bumpLensRound`
 * supplies `round` and `incompleteRuns`, and it is the function that drops the head
 * under an incomplete verdict (#2223), so the row this ledger holds is the row the fix
 * produces rather than the row the case wants.
 */
async function recordIncompleteRound(
  cwd: string,
  file: string,
  round: LensRound,
): Promise<void> {
  // The identity is computed where it CAN be: the run's worktree, the tree at the
  // reviewed head. The step hands the layer `cwd = repoRoot`, a checkout parked at the
  // base commit, where a diff against the mainline cannot be built at all — so a
  // writer run there returns no patch-id and records nothing, and the case would be
  // asserting on an empty ledger. That is the layer failing closed, correctly; it is
  // simply not the place to ask the question.
  const tree = path.join(cwd, ".worktrees", "lean-7");
  const identity = await workingTreePatchId(execp, tree, { digest: true });
  if (!identity.patchId || !identity.diffSha256) {
    throw new Error(
      `fixture: no writer identity for the reviewed head (${identity.warning ?? "unknown"}) — the row would not be one any reader can consult`,
    );
  }
  // The head is named only when the round says which commit it reviewed. A round
  // that ranged over nothing reports no `deltaReview`, and naming the head anyway
  // would be the fixture handing the writer the very claim under test — that an
  // incomplete round knows the head it reviewed. The layer's own write path passes
  // the resolved head in, so a round that DID review one supplies it here too.
  const reviewed = round.deltaReview?.head;
  const entry = {
    branch: BRANCH,
    kind: "lens",
    patchId: identity.patchId,
    diffSha256: identity.diffSha256,
    passed: false,
    at: Date.now(),
    detail: round.verdict,
    hasCritical: false,
    ...(reviewed === undefined ? {} : { headSha: reviewed }),
  } as unknown as LedgerEntry;
  const stamped: { current: LedgerEntry; landedAtPath?: string } = { current: entry };
  const failure = await appendLedgerEntry(entry, execp, cwd, stamped);
  if (failure) throw new Error(`fixture: the writer refused the row (${failure})`);
  if (!readLedgerAt(file).some((e) => e.at === entry.at)) {
    throw new Error("fixture: the row did not land in the file the readers open");
  }
}

// ── (1) the premise: an all-blocked round really is an incomplete round, and
//     the step refuses it ────────────────────────────────────────────────────
// Without this arm, (2)'s "no refusal" assertion would be a clean run agreeing with
// itself: the case would pass whether or not any round was ever incomplete.
{
  const r = await twice();
  assert(
    r.rounds[0]?.verdict === "REVIEW_INCOMPLETE",
    `(1) the all-blocked round came back REVIEW_INCOMPLETE from the real layer (got ${String(r.rounds[0]?.verdict)})`,
  );
  assert(
    r.threw[0] instanceof ReviewInfraError &&
      /REVIEW_INCOMPLETE|ran no lens/.test(r.threw[0]?.message ?? ""),
    `(1) and the step refuses it rather than passing on it (${r.threw[0]?.message?.slice(0, 70) ?? "no throw"})`,
  );
  // The row the next round reads: one, incomplete, and NOT carrying the head whose
  // lenses never ran. This is the premise (2) depends on, asserted rather than assumed.
  const rows = r.rows();
  assert(rows.length === 1, `(1) one lens row on the branch after the incomplete round (got ${String(rows.length)})`);
  assert(
    rows[0]?.detail === "REVIEW_INCOMPLETE",
    `(1) and it is the incomplete round's row (${String(rows[0]?.detail)})`,
  );
  assert(
    rows[0]?.headSha !== r.head,
    `(1) …so the row the next round reads does not name the head no lens ran (${String(rows[0]?.headSha)?.slice(0, 12)} vs ${r.head.slice(0, 12)})`,
  );
}

// ── (2) the field shape: the re-dispatch at the SAME head with no new commit
//     resolves a full round and clears ───────────────────────────────────────
// Before the fix, pass 2's round came back `noReview: true` — the layer's
// empty-delta answer against the head the incomplete round recorded — and the step
// refused it for running nobody. The run died with no verdict at all.
{
  const r = await twice();
  // (1)'s premise again, on this run: if the row still named the unrun head, the
  // delta reader was never given the chance to be wrong or right, and the two
  // assertions below would be measuring a clean branch.
  assert(
    r.rows()[0]?.detail === "REVIEW_INCOMPLETE" && r.rows()[0]?.headSha !== r.head,
    "(2) the run really carries an incomplete round at the head it is about to re-review",
  );
  const second = r.rounds[1];
  assert(r.rounds.length === 2, `(2) both attempts ran a round (${String(r.rounds.length)})`);
  assert(
    second?.noReview !== true,
    `(2) the re-dispatch at the same head is NOT the no-review outcome (verdict ${String(second?.verdict)}, noReview=${String(second?.noReview)})`,
  );
  assert(
    second?.since === undefined,
    `(2) and the round the step bought is whole-branch, not a delta from a head whose lenses never ran (since ${String(second?.since)?.slice(0, 12)})`,
  );
  assert(
    r.threw[1] === undefined && (r.kinds[1] === "done" || r.kinds[1] === "fixed"),
    `(2) so the step clears on the round that judged the branch (${r.threw[1]?.message?.slice(0, 80) ?? `kind ${String(r.kinds[1])}`})`,
  );
  // The proof the delta reader was actually consulted: an absent ledger resolves no
  // base for any code, so a run whose ledger never held a row would pass (2) by
  // accident. Reading the row back out of the file the reader opens is what makes the
  // arm mean "the reader looked at an incomplete row and still asked for a full round".
  const read = latestEntry(readLedgerAt(r.ledger), BRANCH, "lens");
  assert(
    read?.detail === "REVIEW_INCOMPLETE",
    `(2) and the reader did have an incomplete row to skip (${String(read?.detail)})`,
  );
}

cleanupRoots();
process.exit(failures.length > 0 ? 1 : 0);
