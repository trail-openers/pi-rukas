#!/usr/bin/env bun
/**
 * lean `ci` — the GitLab `allow_failure` ruling (#2226), as a callable suite.
 *
 * Split out of `test-lean-ci-gl.ts` for the AGENTS.md §12 cap. The seam is the
 * ruling itself: it is a contract SHARED with the land gate rather than one more
 * poll case, so it reads better as its own module than as a block inside the poll
 * matrix. Same recorder, same fixture MR, same `run()`.
 *
 * Exported as a function rather than as top-level assertions on purpose: the
 * caller owns the exit code, and a sibling that called `process.exit` itself
 * would let the parent report green with the ruling red — the one shape a gate
 * must not have. It answers whether anything failed.
 *
 * What it pins: a `manual`/`skipped` job the pipeline is allowed to fail is
 * EXEMPT and reads green (GitLab makes manual jobs allow-failure by default and
 * its commit-status machine calls such a pipeline `success`, so refusing on one
 * reddened a green pipeline and parked the run at `land` over a button nobody was
 * expected to press), while an allow-failure row that FAILED stays red — an
 * exemption that reached a row that ran would hand anyone who can edit
 * `.gitlab-ci.yml` a switch for the gate. The table's own words are pinned in
 * `test-forge-gl-grade.ts`; the land gate's half by the GitLab CI-evidence matrix.
 */

import { run } from "./lean-ci-recorder.ts";

/** The assertion seam the caller uses, so failures land in its counter. */
export type Assert = (cond: boolean, msg: string) => void;

/**
 * One GitLab job row, in the snake_case shape the REST API answers with — the
 * same shape the parent matrix builds, kept here so this suite stands alone.
 */
const job = (status: string, name = "build"): Record<string, unknown> => ({ name, status });

/** Run the ruling's cases. Returns true when any assertion failed. */
export async function runAllowFailureCases(say: Assert): Promise<boolean> {
	let failed = false;
	const check = (cond: boolean, msg: string): void => {
		if (!cond) failed = true;
		say(cond, msg);
	};

	// (g6b) begins here.
	// ── (g6b) `allow_failure: true` exempts the never-ran states, and only those ──
	// The ruling (#2226, binding for `ci` and the land gate alike): a job the
	// pipeline is allowed to fail is not a gate, so GitLab's two never-ran states —
	// `manual` and `skipped` — PASS when the row carries `allow_failure: true`. GitLab
	// makes manual jobs allow-failure by default and its commit-status machine calls
	// such a pipeline `success`, which is what a normal GitLab pipeline with a
	// human-triggered deploy job looks like. Refusing on those rows (what this suite
	// asserted before the ruling) turned a green pipeline red in `ci` and parked the
	// run at `land` over a button nobody was expected to press.
	//
	// The exemption stops where a verdict begins: a `failed` allow-failure row stays
	// RED (the row ran and said something about this code — an exemption that reached
	// it would be a `.gitlab-ci.yml` switch for the gate), and a row still in flight
	// is waited, never passed.
	{
	  // THE ruling case, in one assertion: build success plus a manual allow-failure
	  // deploy job must read GREEN — the pipeline a GitLab project actually has.
	  const r = await run({
	    full: "true",
	    forge: "gitlab",
	    jobs: [
	      job("success", "build"),
	      { name: "deploy-production", status: "manual", allow_failure: true },
	    ],
	    clockMs: 0,
	    waitTimeoutMs: 60_000,
	  });
	  check(
	    r.outcome?.kind === "green",
	    `(g6b) build success + a manual allow_failure deploy job reads GREEN (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
	  );
	  check(
	    r.tierRuns === 1,
	    `(g6b) and the exempt deploy job does not hold the full tier back (${String(r.tierRuns)})`,
	  );
	}
	for (const [label, jobs, wantGreen] of [
	  [
	    "a skipped allow-failure job",
	    [
	      job("success", "build"),
	      { name: "optional-gate", status: "skipped", allow_failure: true },
	    ],
	    true,
	  ],
	  [
	    // The other half of the ruling, kept as the negative: an allow-failure row
	    // that FAILED is still red. Deleting this assertion is how the exemption
	    // silently grows into a switch for the gate.
	    "an allow-failure failure",
	    [
	      job("success", "build"),
	      { name: "optional-gate", status: "failed", allow_failure: true },
	    ],
	    false,
	  ],
	] as const) {
	  const r = await run({ full: "true", forge: "gitlab", jobs, clockMs: 0, waitTimeoutMs: 60_000 });
	  check(
	    (r.outcome?.kind === "green") === wantGreen,
	    `(g6b) ${label} reads ${wantGreen ? "green" : "red"} (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
	  );
	  check(
	    r.tierRuns === (wantGreen ? 1 : 0),
	    `(g6b) and ${label} runs the full tier ${wantGreen ? "once" : "not at all"}`,
	  );
	}
	{
	  // A `manual` row whose `allow_failure` the API never answered is NOT exempt:
	  // a row that did not answer the question is not a row that answered "allowed",
	  // and `glJobIsBlocking` reads the absence as GitLab's own default (blocking).
	  const r = await run({
	    full: "true",
	    forge: "gitlab",
	    jobs: [job("success", "build"), job("manual", "deploy-production")],
	    clockMs: 0,
	    waitTimeoutMs: 60_000,
	  });
	  check(
	    r.outcome?.kind !== "green",
	    `(g6b) a manual job with no allow_failure answer is still refused (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
	  );
	  check(r.tierRuns === 0, "(g6b) and it runs no full tier");
	}
	// The other arm of the same word: a blocking success alongside an exempt one
	// still passes, so this is the flag deciding and not the suite passing everything.
	//
	// Note what is deliberately NOT asserted here: lean `ci` has no "at least one job
	// actually ran" rule, and the ruling does not give it one — that rule is named for
	// the LAND gate (see `test-merge-guard-ci-evidence-gitlab.ts`), where the merge is
	// irreversible. A poll that waits on a pipeline whose only job is an exempt manual
	// one costs a poll, not a commit, and (g9)'s "exactly 100 successes is green"
	// already fixes what this step requires of its rows.
	{
	  const r = await run({
	    full: "true",
	    forge: "gitlab",
	    jobs: [
	      { name: "build", status: "success" },
	      { name: "optional-gate", status: "success", allow_failure: false },
	    ],
	  });
	  check(
	    r.outcome?.kind === "green",
	    `(g6b) a blocking success still grades green (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
	  );
	}

	return failed;
}

// Standalone entry: running this file directly runs the cases and exits on the
// result, so the suite is runnable on its own as well as from the parent. The
// parent keeps its own counter and ignores this one. Entry is detected by
// comparing argv[1] to this module's path, because `import.meta.main` is not in
// this tsconfig's lib.
if (process.argv[1] === import.meta.filename) {
	const anyFailed = await runAllowFailureCases((cond, msg) => {
		if (cond) console.log(`✓ ${msg}`);
		else console.error(`✗ ${msg}`);
	});
	process.exit(anyFailed ? 1 : 0);
}
