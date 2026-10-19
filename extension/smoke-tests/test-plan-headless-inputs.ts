#!/usr/bin/env bun
/**
 * #1642 — the /work plan step works headless. Four fixes, one test each:
 *
 *   1. the plan child is told where its inputs are (the cached issue body, the
 *      explore report) and gets the spec's deliverables inline — the primary
 *      prompt AND the corrective prompts that wrap it;
 *   2. a deliverable whose every path is protected (`isProtectedPath`) and not
 *      granted by `--allow-protected` is deferred, not an uncovered deliverable;
 *      a grant naming it makes coverage required again;
 *   3. the explore role may run `ls` (read-only listing), so a headless child
 *      can see the tmp/ dir its inputs live in;
 *   4. the unfence reads `git show <ref>:<path>` with the ref prefixed ONCE —
 *      `git grep <ref>` already prints `<ref>:<path>` and the doubled prefix
 *      made every fence read fail.
 */

import { readFileSync } from "node:fs";
import { resolveToolPermission } from "../src/permission-guard.ts";
import { type NormalisedSpec, renderAssumptions } from "../src/work-driver-intent.ts";
import { planPromptInputsOf } from "../src/work-driver-plan-inputs.ts";
import {
	findUncoveredDeliverables,
	planSpecMismatchReason,
	protectedDeferralsOf,
} from "../src/work-driver-plan-spec-coverage.ts";
import { withProtectedDeferralAssumptions } from "../src/work-driver-plan-deferral-notice.ts";
import { planCorrectivePrompt } from "../src/work-driver-plan-timeout.ts";
import {
	definingFiles,
	readAtRef,
} from "../src/work-driver-plan-unfence-git.ts";
import { inlinePlanPrompt } from "../src/work-driver-prompts-plan.ts";
import { initialState } from "../src/workflow-state-update.ts";
import type { WorkEvent, WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
	if (cond) console.log(`✓ ${msg}`);
	else {
		console.error(`✗ ${msg}`);
		exit = 1;
	}
}

const BODY_PATH = "/repo/.pi/work-state/1557/issue-body.txt";
const EXPLORE_PATH = "/repo/.pi/work-state/1557/j1-explore.txt";

const SPEC: NormalisedSpec = {
	intent: "fix the plan",
	deliverables: [
		{
			id: "d1",
			description: "the plan prompt names its inputs",
			paths: ["extension/src/a.ts"],
		},
		{ id: "d2", description: "no-diff settings toggle", paths: [] },
	],
	acceptanceCriteria: [],
	outOfScope: [],
	assumptions: [],
	openQuestions: [],
	evidence: [],
	verdict: "proceed",
	rationale: "",
};

const EXPLORE_EVENT: WorkEvent = {
	kind: "dispatch-completed",
	step: "explore",
	role: "explore",
	jobId: "j1",
	label: "explore",
	ok: true,
	ms: 1,
	at: 1,
	artifactPath: EXPLORE_PATH,
};

function stateWith(
	extra: Partial<WorkState["pipelineState"]>,
	events: WorkEvent[],
): WorkState {
	const base = initialState(1557, 1);
	return {
		...base,
		pipelineState: { ...base.pipelineState, ...extra },
		eventLog: events,
	};
}

// ----------------------------------------- 1. the plan child is told its inputs

{
	const state = stateWith(
		{ issueBodyArtifact: BODY_PATH, normalisedSpec: SPEC },
		[EXPLORE_EVENT],
	);
	const inputs = planPromptInputsOf(state, "/repo");
	assert(
		inputs.issueBodyPath === BODY_PATH,
		"inputs: the issue body artifact path comes from state",
	);
	assert(
		inputs.explorePath === EXPLORE_PATH,
		"inputs: the explore artifact path comes from the explore completion",
	);
	const prompt = inlinePlanPrompt([1557], "/repo/tmp/issue-1557", inputs);
	assert(
		prompt.includes(BODY_PATH),
		"primary prompt: names the cached issue body path",
	);
	assert(
		prompt.includes(EXPLORE_PATH),
		"primary prompt: names the explore report path",
	);
	assert(
		prompt.includes(
			"d1: the plan prompt names its inputs [paths: extension/src/a.ts]",
		),
		"primary prompt: lists each deliverable inline with its paths",
	);
	assert(
		prompt.includes("d2: no-diff settings toggle") &&
			!prompt.includes("d2: no-diff settings toggle ["),
		"primary prompt: a deliverable with no paths is listed without a paths tag",
	);
	assert(
		!prompt.includes("UNAVAILABLE"),
		"primary prompt: nothing is reported unavailable when state carries every input",
	);
	const corrective = planCorrectivePrompt(
		prompt,
		"## Corrective re-dispatch\n\nre-plan",
	);
	assert(
		corrective.includes(BODY_PATH) && corrective.includes(EXPLORE_PATH),
		"corrective prompt: inherits the input paths (it wraps the primary prompt)",
	);
	assert(
		corrective.includes("d1: the plan prompt names its inputs"),
		"corrective prompt: inherits the deliverable list",
	);

	// Inline explore report: no artifact file, the summary stays in state.
	const inline = stateWith({ issueBodyArtifact: BODY_PATH }, [
		{
			...EXPLORE_EVENT,
			artifactPath: undefined,
			summary: "EXPLORE REPLY TEXT",
		},
	]);
	const inlinePrompt = inlinePlanPrompt(
		[1557],
		"/repo/tmp",
		planPromptInputsOf(inline, "/repo"),
	);
	assert(
		inlinePrompt.includes("EXPLORE REPLY TEXT") &&
			inlinePrompt.includes("reproduced here"),
		"inline explore report: the summary is reproduced in the prompt, not claimed as a file",
	);
}

{
	// Nothing in state: every input is said to be unavailable, in the primary
	// prompt and in a corrective built on it. No path is guessed.
	const bare = initialState(1557, 1);
	const prompt = inlinePlanPrompt(
		[1557],
		"/repo/tmp",
		planPromptInputsOf(bare, "/repo"),
	);
	assert(
		prompt.split("UNAVAILABLE").length - 1 === 3,
		"no state: the issue body, explore report and spec are each reported UNAVAILABLE",
	);
	assert(
		!prompt.includes("cached by the driver"),
		"no state: the prompt does not claim the issue body is cached",
	);
	assert(
		planCorrectivePrompt(prompt, "steer").includes("UNAVAILABLE"),
		"no state: the corrective prompt carries the same UNAVAILABLE statements",
	);
	const legacy = inlinePlanPrompt([1557], "/repo/tmp");
	assert(
		legacy.includes("UNAVAILABLE") && legacy.includes("Spec deliverables"),
		"no inputs argument: the prompt still says what is unavailable",
	);
}

// -------------------- 2. protected-only deliverables are deferred, not uncovered

{
	const D5 = { id: "d5", paths: [".pi/verify-cmd"] };
	const D6 = { id: "d6", paths: [".pi/verify-cmd", "extension/src/b.ts"] };
	const spec = { deliverables: [D5, D6] };
	const ws = { default: { paths: ["extension/src/a.ts"] } };

	const ungranted = findUncoveredDeliverables(ws, spec, []);
	assert(
		!ungranted.uncovered.some((u) => u.id === "d5"),
		"protected deliverable, no grant: d5 (.pi/verify-cmd only) is NOT an uncovered deliverable",
	);
	// #1642 review — when EVERY measurable deliverable is deferred, nothing was
	// judged: the gate must not pass silently. It names the path and the grant.
	const allDeferred = planSpecMismatchReason(ws, { deliverables: [D5] }, []);
	assert(
		allDeferred?.kind === "uncovered-deliverables" &&
			(allDeferred.evidence ?? "").includes(".pi/verify-cmd") &&
			(allDeferred.evidence ?? "").includes("--allow-protected"),
		"protected deliverable, no grant, nothing else checkable: a mismatch that names the path and --allow-protected",
	);
	assert(
		protectedDeferralsOf(spec, []).some(
			(d) => d.id === "d5" && d.paths.includes(".pi/verify-cmd"),
		),
		"protected deliverable, no grant: it is recorded as deferred (protectedDeferralsOf)",
	);
	assert(
		ungranted.uncovered.some(
			(u) => u.id === "d6" && u.paths.join() === "extension/src/b.ts",
		),
		"mixed deliverable: the unprotected half still needs coverage, and only that half is named",
	);

	const granted = findUncoveredDeliverables(ws, spec, [".pi/verify-cmd"]);
	assert(
		granted.uncovered.some((u) => u.id === "d5"),
		"a grant naming the protected path makes coverage required again (d5 uncovered)",
	);
	assert(
		protectedDeferralsOf(spec, [".pi/verify-cmd"]).length === 0,
		"a grant naming the path: nothing is deferred",
	);

	const covered = findUncoveredDeliverables(
		{
			default: {
				paths: ["extension/src/a.ts", "extension/src/b.ts", ".pi/verify-cmd"],
			},
		},
		spec,
		[".pi/verify-cmd"],
	);
	assert(
		covered.uncovered.length === 0,
		"a granted plan that declares the protected path is covered",
	);
}

// ------------------------------------------ 3. the explore role may list (ls)

{
	const agents = JSON.parse(
		readFileSync(new URL("../../agents.json", import.meta.url), "utf8"),
	).agent as Record<string, { permission?: Record<string, unknown> }>;
	const verdict = (cmd: string) =>
		resolveToolPermission("bash", "explore", {}, {}, agents, cmd);
	assert(
		verdict("ls tmp/issue-1557") === "allow",
		"explore: `ls tmp/issue-1557` resolves to allow",
	);
	assert(
		verdict("ls") === "allow",
		"explore: bare `ls` resolves to allow",
	);
	assert(
		verdict("lsof -i :8080") !== "allow",
		"explore: `lsof` is NOT allowed (the key is the exact binary, not a prefix)",
	);
	assert(
		verdict("cat tmp/issue-1557/x.txt") === "allow",
		"explore: `cat` is still allowed",
	);
	assert(
		verdict("rm -rf tmp") !== "allow",
		"explore: an unrelated destructive command is not allowed",
	);
}

// ------------------------- 4. the unfence ref is prefixed once, not doubled

{
	const calls: Array<{ argv: string[] }> = [];
	// `git grep <ref> …` prints `<ref>:<path>`; this stub does the same.
	const exec = async (_cmd: string, opts?: { argv?: string[] }) => {
		const argv = opts?.argv ?? [];
		calls.push({ argv });
		if (argv[0] === "grep") {
			const ref = argv[6] ?? "";
			return {
				stdout: `${ref}:extension/smoke-tests/lib/arms/loop-behaviour.ts\0${ref}:extension/src/x.ts\0`,
			};
		}
		return { stdout: "" };
	};
	const files = await definingFiles("dispatchCore", exec, "/repo", "HEAD");
	assert(
		files.join() ===
			"extension/smoke-tests/lib/arms/loop-behaviour.ts,extension/src/x.ts",
		"definingFiles: returns repo paths, with the `<ref>:` prefix stripped",
	);
	await readAtRef(files[0] ?? "", exec, "/repo", "HEAD");
	const show = calls[calls.length - 1]?.argv ?? [];
	assert(
		show.join(" ") ===
			"show HEAD:extension/smoke-tests/lib/arms/loop-behaviour.ts",
		"unfence read: the argv is `show HEAD:<path>` (the ref appears once)",
	);
	assert(
		!show.join(" ").includes("HEAD:HEAD:"),
		"unfence read: no HEAD:HEAD: doubling",
	);

	const shaFiles = await definingFiles(
		"dispatchCore",
		exec,
		"/repo",
		"abc1234",
	);
	assert(
		shaFiles.join() ===
			"extension/smoke-tests/lib/arms/loop-behaviour.ts,extension/src/x.ts",
		"a sha ref is stripped the same way",
	);

	// #1642 item 4 \u2014 `-z` output: NUL-terminated, so names with spaces or a
	// newline come back whole, and a leading space is part of the name (no trim).
	const nul = await definingFiles(
		"x",
		async () => ({
			stdout: "HEAD:docs/my file.md\0HEAD: lead.ts\0HEAD:a\nb.ts\0",
		}),
		"/repo",
		"HEAD",
	);
	assert(
		JSON.stringify(nul) ===
			JSON.stringify(["docs/my file.md", " lead.ts", "a\nb.ts"]),
		"definingFiles: NUL-split names keep spaces, leading spaces and newlines",
	);
}

// ----------- 5. a deferred protected half is disclosed on the spec (PR body)

{
	const MIXED: NormalisedSpec = {
		...SPEC,
		deliverables: [
			{
				id: "d6",
				description: "gate config and the source file",
				paths: [".pi/verify-cmd", "extension/src/b.ts"],
			},
		],
	};
	const planned = { default: { paths: ["extension/src/b.ts"] } };
	assert(
		planSpecMismatchReason(planned, MIXED, []) === undefined,
		"mixed deliverable: the plan covering its unprotected half passes the gate",
	);
	const TEXT =
		"Deferred d6 path .pi/verify-cmd: protected; this cycle has no --allow-protected grant for it, so it was not changed. Re-run with --allow-protected .pi/verify-cmd to include it.";
	const state = stateWith({ normalisedSpec: MIXED }, []);
	const disclosed = withProtectedDeferralAssumptions(state, MIXED, []);
	const once = disclosed.pipelineState.normalisedSpec;
	assert(
		once?.assumptions.some((a) => a.text === TEXT) === true,
		"ungranted protected half: one assumption per deferred path lands in the state",
	);
	assert(
		once?.verdict === "proceed-with-assumptions",
		"ungranted protected half: a plain proceed is promoted, as the intent step does",
	);
	assert(
		renderAssumptions(once as NormalisedSpec).includes(TEXT),
		"ungranted protected half: the PR-body renderer prints the deferral",
	);
	const again = withProtectedDeferralAssumptions(disclosed, MIXED, []);
	assert(
		again.pipelineState.normalisedSpec?.assumptions.length === once?.assumptions.length,
		"re-running the pass does not duplicate the deferral assumption",
	);
	assert(
		withProtectedDeferralAssumptions(state, MIXED, [".pi/verify-cmd"]) === state,
		"a grant naming the protected path: nothing is deferred, the state is untouched",
	);
	const bare = stateWith({}, []);
	assert(
		withProtectedDeferralAssumptions(bare, MIXED, []) === bare,
		"no normalised spec in state: nowhere to write, the trace stays the only record",
	);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
