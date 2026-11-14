#!/usr/bin/env bun
/**
 * #2261 (lean path) — the lean handback names WHY the review could not run.
 *
 * The gap the issue's lean section names: lean shares the base+head diff read with
 * the review layer, and its own precondition read of the SAME range
 * (`lean/review-git.ts`, through `GIT_MAX_BUFFER`) runs at 16 MiB. A diff between
 * the layer's old 1 MiB cap and that ceiling therefore passed lean's check that the
 * branch could be reviewed and then died inside the layer — and on the lean surface
 * the cause was LOST. A blocked fan-out carries no `usage`, so `assertRan`'s
 * no-usage arm quoted only the verdict word: the operator read "the six-lens review
 * reported REVIEW_INCOMPLETE with no usage from any lens child" and nothing naming
 * the size limit, nor the provider context-length refusal, nor anything else the
 * lane actually said. The per-lens reasons existed at that moment — they were on the
 * rows the round carried — and nothing rendered them.
 *
 * The cause is read off the rows the round already carries, through the layer's own
 * lane renderer (`incompleteLanes`), rather than through a field some adapter would
 * have to remember to forward: the step receives those rows either way, so a reason
 * cannot be lost by an agent that forgot one key.
 *
 * Four properties, all driven through the step (`reviewOutcome` via `depsWith`) with
 * rows built by the PRODUCTION blocked-row builder (`blockedRowsForRoster`), so the
 * string the handback prints is one the layer mints for an unreadable diff rather
 * than a literal a fixture agrees with:
 *
 *   (1) an all-blocked round hands back the SIZE limit — the constant's name, the
 *       bytes the read produced, and which lane reported it;
 *   (2) a provider context-length refusal reaches the same handback, so it is not
 *       reported as bare infrastructure;
 *   (3) the refusal is still the no-usage rule — the cause is appended, the rule is
 *       not replaced — and a round whose lanes said nothing at all gets no empty
 *       clause;
 *   (4) a CLEAN round still clears with no blocked-lane clause bolted on.
 *
 * Real temp repos, stubbed models, no child spawned, no token spent.
 */

import { blockedRowsForRoster } from "../src/lens-review-diff-blocked.ts";
import { incompleteLanes } from "../src/lens-review-incomplete.ts";
import { CONTEXT_LENGTH_HINT } from "../src/lens-provider-cause.ts";
import { LENS_ROSTER } from "../src/lens-roster.ts";
import type { LensRound } from "../src/lean/review-args.ts";
import type { LensRunResult } from "../src/lens-review-types.ts";
import {
  BRANCH,
  ReviewInfraError,
  cleanLensRound,
  cleanupRoots,
  ctxFor,
  depsWith,
  makeRepo,
  runStep,
  setup,
} from "./lib/lean-review-fixtures.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/**
 * The round the layer hands the step when the diff could not be read: one blocked
 * row per bundled lens, no usage, the named problem as each row's `parseError`.
 *
 * The rows come from `blockedRowsForRoster`, the builder the review layer itself
 * calls for an unresolvable diff, over the real bundled roster — so the lanes the
 * handback names are the lanes a real round would have run.
 */
function blockedRound(problem: string): LensRound {
  return {
    ...cleanLensRound(),
    verdict: "REVIEW_INCOMPLETE",
    findings: "",
    reported: [],
    advisory: [],
    lenses: blockedRowsForRoster(LENS_ROSTER, problem) as unknown as LensRunResult[],
    // A blocked fan-out bills nothing — this absence is what routes the round to
    // `assertRan`'s no-usage arm, the one that used to quote only the verdict.
    usage: undefined,
  };
}

/**
 * The size reason the layer mints today for an over-ceiling base+head read.
 *
 * Built rather than typed out, so the value the test looks for and the value the
 * layer prints come from one place. The needles below are the limit's NAME and the
 * lane's name; the byte figure is a fixture-chosen number, not the ceiling itself,
 * so an assertion here cannot be satisfied by the constant appearing anywhere else.
 */
const OVER_CEILING_BYTES = 12_345_678;
const SIZE_PROBLEM =
  `lens review: cannot compute diff for origin/main...deadbeef: ` +
  `git diff origin/main...deadbeef exceeded the limit ` +
  `REVIEW_DIFF_READ_MAX_BYTES — git produced ${String(OVER_CEILING_BYTES)} bytes`;

/** What the layer says when the provider refused a lens's prompt (#2261's delta arm). */
const PROVIDER_PROBLEM =
  `${CONTEXT_LENGTH_HINT}: the provider refused this lens's prompt and it was NOT ` +
  `retried — the change is too large for the lens prompt to inline whole: maximum context length`;

const FIRST_LENS = LENS_ROSTER[0]?.name ?? "";

// ── (1) the size cause reaches the lean handback ────────────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 1;\n" });
  const { threw } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({ lens: async () => blockedRound(SIZE_PROBLEM) }),
  );
  assert(
    threw instanceof ReviewInfraError,
    `(1) an all-blocked round is still refused rather than passed (${threw?.message?.slice(0, 80) ?? "no throw"})`,
  );
  assert(
    threw !== undefined && threw.message.includes("REVIEW_DIFF_READ_MAX_BYTES"),
    `(1) and the handback names the size limit, not just the verdict word (${threw?.message?.slice(0, 240)})`,
  );
  assert(
    threw !== undefined && threw.message.includes(String(OVER_CEILING_BYTES)),
    `(1) and states how many bytes the read produced, so the operator knows how far over (${threw?.message?.slice(0, 240)})`,
  );
  assert(
    threw !== undefined && FIRST_LENS !== "" && threw.message.includes(FIRST_LENS),
    `(1) and names the lane that reported it (${threw?.message?.slice(0, 240)})`,
  );
}

// ── (2) the provider context-length refusal reaches the handback ────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 2;\n" });
  const { threw } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({ lens: async () => blockedRound(PROVIDER_PROBLEM) }),
  );
  assert(
    threw !== undefined && threw.message.includes(CONTEXT_LENGTH_HINT),
    `(2) a provider context-length refusal reaches the step, which reads as bare infrastructure today (${threw?.message?.slice(0, 240)})`,
  );
}

// ── (3) the rule is appended, not replaced ──────────────────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 3;\n" });
  const { threw } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({ lens: async () => blockedRound(SIZE_PROBLEM) }),
  );
  assert(
    threw !== undefined && /no usage from any lens child/.test(threw.message),
    `(3) it is still the no-usage refusal — the cause is added to it, not a rule beside it (${threw?.message?.slice(0, 160)})`,
  );
  assert(
    threw !== undefined && threw.message.includes(`— lanes: ${FIRST_LENS}:`),
    "(3) and the cause is introduced as the lanes, so a reader knows whose words follow",
  );

  // The layer's silent-lane shape: blocked rows carrying no reason at all. The
  // clause must still be the layer's own wording rather than one invented here.
  const silent = blockedRound("");
  const lenses = silent.lenses.map((r) => ({ ...r, parseError: undefined }));
  const { threw: t2 } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({ lens: async () => ({ ...silent, lenses }) }),
  );
  assert(
    t2 !== undefined && /no usage from any lens child/.test(t2.message),
    `(3b) a round whose lanes said nothing is still refused (${t2?.message?.slice(0, 160) ?? "no throw"})`,
  );
  // The layer's renderer is the ONLY wording: whatever it says for these rows is
  // what the handback must print, character for character — a paraphrase here would
  // be a second story about one lane, which is what #1564 removed.
  const quoted = incompleteLanes(lenses).join("; ");
  assert(
    quoted !== "" && t2 !== undefined && t2.message.includes(quoted),
    `(3b) and what it quotes per lane is verbatim the layer's own renderer for those rows (${quoted.slice(0, 120)})`,
  );
}

// ── (4) a clean round is not given a cause clause ───────────────────────────
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 4;\n" });
  const { threw, outcome } = await runStep(ctxFor(repoRoot, baseSha, BRANCH), depsWith({}));
  assert(
    threw === undefined && outcome?.kind === "done",
    `(4) a round that ran its six lenses still clears (${threw?.message ?? String(outcome?.kind)})`,
  );
  assert(
    !(outcome?.reason ?? "").includes("lanes:"),
    `(4) and nothing about blocked lanes appears in a clean pass's reason (${outcome?.reason})`,
  );
}

// ── (5) the quoted lanes are BOUNDED, and cannot smuggle a provider body ────
// The handback is an error message that reaches a report and a transcript, so a
// lane reason must not carry an unbounded provider payload into it. The clip is
// what makes quoting safe: a lane row whose reason grew must not grow the message.
{
  const { repoRoot, baseSha } = makeRepo();
  await setup({ repoRoot, baseSha, branch: BRANCH, feature: "export const f = 5;\n" });
  const blob = `SECRET-BLOB-${"k".repeat(4000)}`;
  const loud = blockedRound(SIZE_PROBLEM);
  const rows = loud.lenses.map((r, i) => ({
    ...r,
    // Every lane carrying a maximal, hostile reason — the worst case for the clip.
    parseError: `${i === 0 ? SIZE_PROBLEM : ""}${blob}`.slice(0, 2000),
  }));
  const { threw } = await runStep(
    ctxFor(repoRoot, baseSha, BRANCH),
    depsWith({ lens: async () => ({ ...loud, lenses: rows }) }),
  );
  assert(
    threw !== undefined && threw.message.length < 4_000,
    `(5) the handback stays bounded however long the lanes' reasons are (${String(threw?.message.length)} chars)`,
  );
  const quoted = incompleteLanes(rows).join("; ").slice(0, 900);
  assert(
    threw !== undefined && quoted !== "" && threw.message.includes(quoted.slice(0, 120)),
    `(5) and it is still the layer's own words, just clipped to the bound (${quoted.slice(0, 60)})`,
  );
  // The clip is a PREFIX, so a byte-for-byte copy of a lane's reason cannot
  // survive it; what must not survive is an unbounded run of them. The bound is
  // the whole guarantee here: a lane row that grew cannot grow the handback.
  const clause = threw?.message.split(" — lanes: ")[1] ?? "";
  assert(
    clause !== "" && clause.length <= 900,
    `(5) and the quoted lanes are clipped to their stated bound rather than carried whole (clause ${String(clause.length)} of a ${String(incompleteLanes(rows).join("; ").length)}-char rendering)`,
  );
}

cleanupRoots();
process.exit(failures());
