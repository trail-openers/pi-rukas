#!/usr/bin/env bun
/**
 * #380 — merging is the one irreversible act in the cycle, and had no gate.
 *
 * Before this: `grep -rniE "merge.?polic|allowed to merge|automerge|canMerge"`
 * over `src/` returned NOTHING, and the decision to merge came from
 * `text.includes("ci-status: success")` in an LLM's reply. Two things are now
 * required, and both default to "no":
 *
 *   1. Someone explicitly permitted it (the project's documents, or `--merge`).
 *   2. `gh` — not an agent — reports the required checks passed.
 *
 * The exec seam is a fake, so this is offline. Every `gh` invocation the
 * production path makes is asserted, because a gate that never calls `gh` and
 * a gate that calls it and ignores the answer look identical from outside.
 *
 * The forge is named explicitly on every call below. `gatherMergeEvidence`
 * resolves one from the repo when the caller does not, and `/x` is not a repo;
 * an unresolved forge is a tooling refusal rather than a silent fall-through to
 * the gh path (#2226), so an arm that means "this is GitHub" has to say so.
 */

import {
	contradictsSuccess,
	gatherMergeEvidence,
	mergeHoldAction,
	mergeHoldGrantAction,
	mergeHoldToolingNote,
} from "../src/work-driver-merge-authority.ts";
// The evidence split moved the fake and the green fixtures into the sibling
// module; the demotion arms below still read through the same fake, so they import
// it rather than keep a second copy that could drift from the one the evidence
// arms are graded against.
import { fakeGh, GH, GREEN_STATE } from "./lib/merge-authority-evidence-cases.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
	if (cond) {
		console.log(`✓ ${msg}`);
	} else {
		console.error(`✗ ${msg}`);
		exit = 1;
	}
}

// Authority RESOLUTION moved to test-policy-judge.ts in #407: the three
// English regexes are gone, replaced by a judged + citation-verified seam.
// What remains here is the half that never depended on parsing — the
// executed-evidence gate, and how a hold is explained to the operator.

// -------------------------------------------------------- evidence
// ── evidence: runEvidenceCases (§12 cap) ────────────────────────────────────
// The executed-forge-read arms live in `lib/merge-authority-evidence-cases.ts`
// (same fake, same fixtures, same assertions — sliced along this file's own
// section boundary so both halves stay under the cap). The counter is threaded
// through rather than left to the module's own exit: a sibling that called
// `process.exit` itself would let this file report green with the evidence arms
// red, which is the one shape an irreversible-act gate must not have.
{
	const evidence = await import("./lib/merge-authority-evidence-cases.ts");
	if (await evidence.runEvidenceCases(assert)) exit = 1;
}

// ------------------------------------ narration cannot promote, evidence demotes

{
	const { fn } = fakeGh({
		"pr view": GREEN_STATE,
		"pr checks": JSON.stringify([
			{ name: "test", state: "FAILURE", bucket: "fail" },
		]),
	});
	assert(
		contradictsSuccess(await gatherMergeEvidence(fn, "/x", 7, GH)) !== undefined,
		"at the `ci` step, a failing check contradicts an ops agent's claimed success",
	);
}
{
	// At `ci` (unlike the merge gate) an unreadable gh must NOT demote — it
	// would burn the retry budget on a run that genuinely passed. The merge
	// gate is the one that fails closed.
	const { fn } = fakeGh({ "pr view": new Error("network") });
	assert(
		contradictsSuccess(await gatherMergeEvidence(fn, "/x", 7, GH)) === undefined,
		"an unreadable `gh` does NOT demote a claimed success at the ci step",
	);
}

// ------------------------------------------------- operator-facing actions

{
	const denied = mergeHoldAction({ granted: false, source: "none" }, 42);
	assert(/#42/.test(denied), "the human action names the PR");
	// #760 round-3 — the no-authority sentence now names the actual state
	// (no grant exists) instead of "not permitted here as configured", and
	// shares one source (mergeHoldGrantAction) with the queue + handoff
	// surfaces.
	assert(
		/no merge grant exists/.test(denied) && !/as configured/.test(denied),
		"the no-authority action names the missing grant, not a configuration difference",
	);
	assert(
		mergeHoldGrantAction("#42") === denied,
		"the no-authority action IS the shared helper (single source across surfaces)",
	);
	// #745 — when the gate's own gh call errored, the action must not tell the
	// operator to inspect the checks (a CI-flavoured line about a system whose
	// check data was never read).
	const tooling = mergeHoldAction(
		{ granted: true, source: "doctrine" },
		42,
		"tooling",
	);
	assert(
		/gh invocation/.test(tooling) &&
			!/incomplete required checks/.test(tooling),
		"a tooling refusal renders a tooling action, not 'check the checks'",
	);
	const ci = mergeHoldAction({ granted: true, source: "doctrine" }, 42, "ci");
	assert(
		/check the failing/.test(ci),
		"a CI-verdict refusal still points the operator at the checks",
	);
	const legacy = mergeHoldAction({ granted: true, source: "doctrine" }, 42);
	assert(
		/check the failing/.test(legacy),
		"state files without the tag (pre-#745) keep the CI-flavoured action",
	);
	assert(
		/tooling failure/.test(
			mergeHoldAction({ granted: false, source: "none" }, 42, "tooling"),
		) === false,
		"the no-authority action never changes with the tag",
	);
	assert(
		!/state file|--restart/.test(denied),
		"and never says '--restart' — the work is done and pushed; restarting would duplicate it",
	);
	assert(
		/grant the driver authority/.test(denied),
		"it names the fix — grant the driver the authority — not a manual merge",
	);
	assert(
		/then re-run with --merge once the gate passes/.test(
			mergeHoldAction({ granted: true, source: "agents-md" }, 42),
		),
		"with authority granted, the action points at the checks and the driver as the merge actor",
	);
	assert(
		!/then merge[;,]?$/.test(
			mergeHoldAction({ granted: true, source: "agents-md" }, 42),
		),
		"the CI-verdict line does not end with a bare 'then merge' instruction",
	);
}

assert(
	/tooling failure|The gh invocation itself failed/.test(
		mergeHoldToolingNote(true, "tooling"),
	),
	"the shared helper renders the tooling note for a tooling refusal",
);
assert(
	mergeHoldToolingNote(true, "ci") === "" &&
		mergeHoldToolingNote(true, undefined) === "",
	"the shared helper is silent for CI-verdict and untagged refusals",
);
assert(
	mergeHoldToolingNote(false, "tooling") === "",
	"the shared helper is silent when authority was not granted (that line already points correctly)",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
