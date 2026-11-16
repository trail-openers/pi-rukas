/**
 * lib/lean-review-verified-log — the step log a `review` step can be entered from.
 *
 * `review` is entered only from a green `publish`, and with the acceptance table on
 * it refuses a head its newest green `verify` did not certify. A fixture log with
 * no `verify` therefore describes a run the engine could never have routed here.
 *
 * Its own file because `lib/lean-review-fixtures.ts` sits at the repo's file-size
 * cap. Lives in lib/ so the smoke glob never self-executes it.
 */

import { createHash } from "node:crypto";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";

/**
 * Push the three decided steps a real run leaves behind onto a ctx's log:
 * `specify:ok` carrying one frozen test per criterion, a green `verify` at `head`,
 * and a `publish` that recorded the PR.
 *
 * `tests` is keyed by criterion id because that is the map `testsFromLog` reads; an
 * empty map would make every `test` row read `could-not-run`.
 */
export function seedVerifiedLog(
  ctx: HandlerCtx,
  head: string,
  opts: { pr?: number; tests?: Record<string, string[]> } = {},
): void {
  const decided = (state: string, outcome: Outcome, n: number): Step => ({
    key: `${String(ctx.issue)}:${state}:${String(n)}`,
    state: state as Step["state"],
    startedAt: 1,
    endedAt: 2,
    outcome,
  });
  const tests = opts.tests ?? { AC1: ["tests/AC1.test.ts"] };
  // The table prints paths and never the hash, so this digest stands in for bytes the
  // case never wrote and keeps the 64-hex shape the durable record insists on.
  const frozen: Record<string, string> = {};
  for (const files of Object.values(tests))
    for (const f of files) frozen[f] = createHash("sha256").update(f).digest("hex");
  const prUrl = `https://github.com/o/r/pull/${String(opts.pr ?? 11)}`;
  ctx.steps.push(
    decided("specify", { kind: "ok", frozen, tests }, 0),
    decided("verify", { kind: "green", verifiedHead: head }, 0),
    decided("publish", { kind: "ok", prUrl, publishedHead: head }, 0),
  );
}
