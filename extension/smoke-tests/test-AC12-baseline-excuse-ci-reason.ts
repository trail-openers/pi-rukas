#!/usr/bin/env bun
/**
 * #2042 — the `ci` full tier's red reason is bounded before it reaches the log.
 *
 * The step log is written as one JSON document, and `build`'s re-entry pastes the
 * newest red reason into a developer prompt. `verify`'s tiers are clipped for that
 * reason (`RED_REASON_CLIP`); `ci`'s full tier is the other place a project's own
 * chatty suite prints thousands of lines into a red, and until now it built its
 * reason from its OWN tail constant rather than the shared helpers, so the tail was
 * taken but the whole was never bounded: one very long line — a minified bundle
 * echoed by a failing diff — sat in the record verbatim.
 *
 * The fix is to build the reason the way `verify`'s tiers do: `tailLines` for the
 * tail, `clipReason` for the whole. Both are asserted here on output no tail bound
 * alone would stop.
 */
import { cleanUp, run } from "./lib/lean-ci-recorder.ts";
import { RED_REASON_CLIP } from "../src/lean/verify-deps.ts";
import { TIER_TAIL_LINES } from "../src/lean/verify-steps.ts";

const SELF = "test-AC12-baseline-excuse-ci-reason.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${SELF}: ${msg}`);
    exit = 1;
  }
}

const FULL = "sh -c 'pnpm test'";

{
  // Past the tail bound AND past the whole-reason bound: 400 short lines, plus one
  // 200 KB line the tail bound alone lets through whole.
  const many = Array.from({ length: 400 }, (_, i) => `line ${String(i)} of a chatty suite`).join("\n");
  const longLine = "x".repeat(200_000);
  const r = await run({ full: FULL, tierExit: 1, tierStdout: `${many}\n${longLine}` });
  const reason = r.outcome?.reason ?? "";
  assert(r.outcome?.kind === "red", `(bounded) a red full tier stays red (got ${r.outcome?.kind ?? `threw: ${r.threw?.message}`})`);
  assert(
    reason.includes("line 399 of a chatty suite"),
    "(bounded) the reason still carries the tier's own tail",
  );
  assert(
    !reason.includes("line 10 of a chatty suite\n"),
    `(bounded) the tail is ${String(TIER_TAIL_LINES)} lines, not 400`,
  );
  assert(
    reason.length <= RED_REASON_CLIP + 8,
    `(bounded) the persisted reason is clipped to RED_REASON_CLIP (${String(reason.length)} chars)`,
  );
  assert(
    !reason.includes(longLine),
    "(bounded) one oversized line cannot carry the whole log into the step record",
  );
}

{
  // A reason under the bound is untouched: the clip is a ceiling, not a rewrite.
  const r = await run({ full: FULL, tierExit: 1, tierStdout: "boom from the full tier\n" });
  const reason = r.outcome?.reason ?? "";
  assert(
    reason.includes("boom from the full tier") && reason.includes("exited 1"),
    `(short) a short red reason is recorded as it was (${reason.slice(0, 80)})`,
  );
}

cleanUp();
console.log(`\nexit ${String(exit)}`);
process.exit(exit);
