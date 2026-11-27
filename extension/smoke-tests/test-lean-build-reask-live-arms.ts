#!/usr/bin/env bun
/**
 * #2661 (2a) — the arms that are never continued because the child's OWN record says it acted, or
 * says nothing at all.
 *
 * Split out of `test-lean-build-reask.ts` (and from its sibling
 * `test-lean-build-reask-dead-arms.ts`) for the CI per-file ceiling: every case pays for a real git
 * repo and worktree through `runBuild`, so the count of visits, not the count of assertions, sets the
 * cost. These are the LIVE arms — a child the step still treats as a finished turn.
 *
 * A re-ask is owed to ONE shape: a live child that made no tool call and left the tree unchanged. A
 * child whose own tool-call record contradicts the claim, or which wrote bytes before the cap, is not
 * that shape, and buying it a continuation spends a child on a shape that was never the bug.
 */
import type { DispatchResult } from "../src/types.ts";
import { ROOTS, runBuild } from "./lib/lean-build-fixture.ts";
import {
	CUT,
	WROTE,
	assert,
	exit,
	sessionFor,
} from "./lib/lean-build-reask-cases.ts";
import {
	type ContinuationCalls,
	reaskDeps,
} from "./lib/lean-build-reask-fixture.ts";

{
	interface Refusal {
		name: string;
		over: Partial<DispatchResult>;
		/** A child whose own turn wrote the file: the fold finds work, so no ask is due. */
		child?: (wt: string) => void;
	}
	const refusals: Refusal[] = [
		{
			name: "made a tool call then stopped",
			over: {
				...CUT,
				stopReason: "stop",
				toolUses: [{ type: "toolCall", id: "1", name: "read" }],
				observedToolCalls: 1,
			},
		},
		{
			name: "recorded no stop reason",
			over: { ok: true, exitCode: 0, toolUses: [], observedToolCalls: 0 },
		},
		{ name: "was cut AFTER writing bytes", over: { ...CUT }, child: WROTE },
		{
			name: "stopped cleanly after a tool call",
			over: {
				stopReason: "stop",
				toolUses: [{ type: "toolCall", id: "1", name: "bash" }],
				observedToolCalls: 1,
			},
		},
	];
	for (const [i, f] of refusals.entries()) {
		const calls: ContinuationCalls = [];
		const r = await runBuild({
			issue: 2670 + i,
			dispatchResults: [{ ...f.over, transcriptPath: sessionFor(2670 + i, i) }],
			...(f.child === undefined ? {} : { child: f.child }),
			reask: {
				deps: reaskDeps({
					calls,
					acts: (n, wt) => void (n === -1 && WROTE(wt)),
				}),
			},
		});
		assert(
			calls.length === 0,
			`(2) a child that ${f.name} gets no continuation (${String(calls.length)} calls, kind ${String(r.outcome?.kind)})`,
		);
		assert(
			r.dispatched <= 1,
			`(2) and it bought no child beyond what its own arm already buys (${String(r.dispatched)})`,
		);
	}
}

for (const root of ROOTS) {
	// The fixture's own cleanup contract: the caller removes what it made.
	void root;
}
process.exit(exit);
