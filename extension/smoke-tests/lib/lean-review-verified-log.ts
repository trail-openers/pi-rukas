/**
 * lib/lean-review-verified-log — the step log a `review` step can be entered from.
 *
 * `review` is entered only from a green `publish`, and with
 * `PI_ENSEMBLE_LEAN_REVIEW_ACCEPTANCE` on it refuses a head its newest green
 * `verify` did not certify (`review-acceptance.ts`'s entry guard). So a fixture log
 * with no `verify` describes a run that could never have reached this step, and the
 * guard is right to refuse it — the fix is not to weaken the guard but to give the
 * case a log the engine could actually have produced.
 *
 * Its own file because `lib/lean-review-fixtures.ts` is at the repo's file-size cap:
 * the harness (repo, branch, commits, stub deps) is one concern and the log a run
 * leaves behind is another.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

import { createHash } from "node:crypto";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import type { Outcome, Step } from "../../src/lean/state.ts";

/**
 * Push the three decided steps a real run leaves behind onto a ctx's log:
 * `specify:ok` carrying one frozen test per criterion, a green `verify` at `head`,
 * and a `publish` that recorded the PR.
 *
 * A case that wants the guard's REFUSAL instead — a moved head, an absent `verify` —
 * builds its own log and says so; that is what
 * `test-lean-review-acceptance-briefs.ts` does with cases (c) and (c2).
 *
 * `tests` is keyed by criterion id because that is the map the table reads
 * (`testsFromLog`); an empty map would make every `test` row read `could-not-run`,
 * which is the right cell for a criterion nobody covered and the wrong one for a
 * fixture that simply forgot to record a file.
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
  // A real frozen record is a content hash of the file's bytes; the table prints
  // paths and never the hash, so the digest here stands in for the bytes the case
  // never wrote, and stays a 64-hex of the shape the durable record insists on.
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
