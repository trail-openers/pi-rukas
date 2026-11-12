/**
 * headless-s5-results — the dispatch result and event shapes the headless S5
 * fixture hands back, split out of `headless-s5-fixture.ts` for the §12 cap.
 *
 * The fixture composes the merge gates rather than unit-testing them, and these are
 * the values its seams return: a reduced `DispatchResult` for the stubbed
 * `dispatchFn`, and a `cap-hit` event shaped the way the driver writes one. They
 * live here rather than inline for one reason each, and both are type-level:
 *
 *   - `okResult` is a checked literal, not an `as never` cast, so a field the driver
 *     starts reading off a dispatch result (`.summary`, for the mechanized-vs-LLM
 *     merge-commit parse) is a compile error here rather than an undefined at
 *     runtime;
 *   - `capHitEvent` replaces the two casts the exit-code cases used to carry, which
 *     is exactly where a renamed or newly required field stops being a compile
 *     error and silently projects the wrong exit code.
 */

import type { DispatchResult } from "../../src/types.ts";
import type { WorkCapLiteral } from "../../src/workflow-state-events-caps.ts";
import type { WorkEvent } from "../../src/workflow-state.ts";

/**
 * The reduced `DispatchResult` a stubbed `dispatchFn` returns.
 */
export function okResult(
	text = "",
	over: Partial<Pick<DispatchResult, "role" | "ok" | "exitCode">> = {},
): DispatchResult {
	return {
		role: over.role ?? "ops",
		ok: over.ok ?? true,
		text,
		toolUses: [],
		ms: 10,
		exitCode: over.exitCode ?? 0,
		transcriptPath: "/tmp/s5.json",
	};
}

/**
 * A `cap-hit` event shaped the way the driver writes one.
 */
export function capHitEvent(
	cap: WorkCapLiteral,
	opts: { at: number; evidence?: string },
): WorkEvent {
	return {
		kind: "cap-hit",
		at: opts.at,
		cap,
		reviewRound: 0,
		nextStep: "handoff",
		...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
	};
}
