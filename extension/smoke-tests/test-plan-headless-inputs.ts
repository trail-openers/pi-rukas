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
import type { NormalisedSpec } from "../src/work-driver-intent.ts";
import { planPromptInputsOf } from "../src/work-driver-plan-inputs.ts";
import {
	findUncoveredDeliverables,
	planSpecMismatchReason,
	protectedDeferralsOf,
} from "../src/work-driver-plan-spec-coverage.ts";
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

	const ungranted = findUncoveredDeliverables(ws, spec);
	assert(
		!ungranted.uncovered.some((u) => u.id === "d5"),
		"protected deliverable, no grant: d5 (.pi/verify-cmd only) is NOT an uncovered deliverable",
	);
	assert(
		planSpecMismatchReason(ws, { deliverables: [D5] }) === undefined,
		"protected deliverable, no grant: the plan-to-spec gate does not reject the plan for it",
	);
	assert(
		protectedDeferralsOf(spec).some(
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
			const ref = argv[5] ?? "";
			return {
				stdout: `${ref}:extension/smoke-tests/lib/arms/loop-behaviour.ts\n${ref}:extension/src/x.ts\n`,
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
}

console.log(`\nexit ${exit}`);
process.exit(exit);
