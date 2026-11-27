/**
 * smoke-tests/lib/lean-build-reask-cases — the shared shapes of the #2661 build re-ask suites.
 *
 * The one test file that held every case spent 62 s in CI against a 30 s ceiling because EACH case
 * builds a real git repo and worktree through `runBuild` (the fixture's claim is a git claim, so a
 * stub would test the stub). The cases now sit in sibling files, one seam per file, and this module
 * holds only what those files would otherwise copy: the field's cut turn, the session-path formatter,
 * the act the resumed child performs, and the assert sink.
 *
 * Nothing here drives the step: `runBuild` stays the only way a case reaches production. A shared
 * driver would hide the dispatch count and the fold behind a fixture assumption.
 */
import os from "node:os";
import path from "node:path";
import type { DispatchResult } from "../../src/types.ts";
import { put } from "./lean-build-fixture.ts";

/** A failing assertion flips this; each case file ends with `process.exit(exit)`. */
export let exit = 0;

export function assert(cond: boolean, msg: string): void {
	if (cond) console.log(`✓ ${msg}`);
	else {
		console.error(`✗ ${msg}`);
		exit = 1;
	}
}

/** The field's own first turn: cut at the cap, no tool call, its usage recorded. */
export const CUT: Partial<DispatchResult> = {
	ok: true,
	exitCode: 0,
	stopReason: "length",
	toolUses: [],
	observedToolCalls: 0,
	usage: {
		input: 900,
		output: 16384,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0.4,
		turns: 1,
	},
};

/** A session path shaped the way `transcriptPathFor` writes one — same env root, same dated
 *  directory, same `<runId>-<role…>.json` leaf. Built from the PRODUCTION formatter's own rules so a
 *  case cannot pin a path the seam would never have been given, and cannot drift when the layout
 *  moves. */
export function sessionFor(issue: number, n: number): string {
	const piAgentDir =
		process.env.PI_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
	const date = new Date().toISOString().slice(0, 10);
	return path.join(
		piAgentDir,
		"ensemble-runs",
		date,
		`170000000000${String(n)}-run-dev-${String(issue)}.json`,
	);
}

/** The resumed child's act: write the implementation the first turn never touched. */
export const WROTE = (wt: string) =>
	put(wt, "src/retry.ts", "export const retry = () => 1;\n");
