#!/usr/bin/env bun
/**
 * #1920 slice B — the lean result reports ONLY what the run observed.
 *
 * The sibling file, `test-headless-work-lean-result.ts`, pins the three endings
 * apart by `prState`/`status`/`cap`. This one pins the other half of the same
 * projection, the half that failed review: a field a host acts on must be a
 * report of something the run SAW, never a plausible inference.
 *
 *   - a budget breach gets `failure.kind: "timeout"` and NO cap. The one published
 *     cap name that sounds like it, `lens-review-timeout`, belongs to the classic
 *     driver's six-pass review loop — a budget lean run never ran — and a lean
 *     `budget` outcome is one step's ceiling on its own child. The typed trio
 *     (its `limit`/`value`/`used`) is what says what broke, and `handback` reads
 *     the same trio for the comment it posts;
 *   - a breach the run SURVIVED is not its cause. Since #1883 a `challenge`
 *     breach routes on to `verify`, so position in the log — not prose — decides,
 *     which is `lean/handback.ts`'s rule restated for a typed field;
 *   - a handback whose comment the forge refused says it was NOT delivered. The
 *     step ends `done` either way, so `posted` on its outcome is the only record,
 *     and `HandoffResult`'s own not-delivered pair (`bodyError: "not-recorded"`,
 *     no `body`) is what carries it — plus `labelApplied: false`, since no lean
 *     step applies a label, and no `bodyFile`, since nothing in `lean/` writes one.
 *
 * Both files drive the same fixture (`lib/lean-result-fixture.ts`) through the
 * real `work-lean` verb, so neither is testing a hand-built projection.
 */

import { makeAssert } from "./headless-verb-harness.ts";
import { CHILDREN, URL, driveLean, leanLog, stepWith } from "./lib/lean-result-fixture.ts";

const { assert, state } = makeAssert();

const drive = driveLean;
const log = leanLog;

// ── (3c) a step that blew its OWN budget: `failure.kind` is `timeout` and no
// cap is invented for it. `lens-review-timeout` is the classic driver's six-pass
// review budget — a lean run has no such loop, so borrowing that name would put
// a cap on the host's `switch` that this run never hit. The typed budget outcome
// (its `limit`) is what says what broke.
{
  const steps = [
    stepWith("ready", { kind: "ok" }),
    stepWith("build", {
      kind: "budget",
      limit: "minutes",
      value: 15,
      used: 26,
      dispatches: CHILDREN,
    }),
    stepWith("handback", { kind: "done", posted: true, reason: "handback comment posted" }),
  ];
  const r = await drive("handed-back", 10, steps);
  assert(r.violations.length === 0, `budget: output contract (${r.violations.join("; ")})`);
  const i = r.issue ?? {};
  const failure = i.failure as Record<string, unknown>;
  assert(
    failure?.kind === "timeout",
    `budget: the breach is a timeout failure (got ${JSON.stringify(failure)})`,
  );
  assert(
    String(failure?.message).includes("minutes budget 15"),
    `budget: the message names the typed limit (got ${String(failure?.message)})`,
  );
  assert(
    i.cap !== "lens-review-timeout",
    `budget: no borrowed lens-review cap for a lean budget (got ${String(i.cap)})`,
  );
  assert(i.cap === undefined, `budget: and no cap at all (got ${String(i.cap)})`);
}

// ── (3d) the run survived a budget breach, so it is not its cause: a `challenge`
// breach routes on to `verify` (#1883), and the gate's red verdict is what the
// run died on. Position, not prose, is the test — the same rule `handback`'s own
// `neededFromLog` applies.
{
  const steps = [
    stepWith("challenge", { kind: "budget", limit: "turns", value: 3, used: 99 }),
    stepWith("verify", { kind: "red", reason: "acceptance test y is red" }),
    stepWith("handback", { kind: "done", posted: true, reason: "handback comment posted" }),
  ];
  const r = await drive("handed-back", 10, steps);
  const i = r.issue ?? {};
  const failure = i.failure as Record<string, unknown>;
  assert(
    failure?.kind === "verify" && String(failure.message).includes("acceptance test y"),
    `survived-budget: the red gate is the cause, not the ceiling (got ${JSON.stringify(failure)})`,
  );
  assert(i.cap === undefined, `survived-budget: no cap (got ${String(i.cap)})`);
}

// ── (3e) a handback whose comment never reached the forge says SO in the
// handoff: the step still ends `done` (the run's verdict does not turn on a
// comment), so `posted` on its outcome is the only record of the failure — and a
// result that printed "delivered" would send a host to look at a comment nobody
// posted. `labelApplied` is false on every lean path: no lean step applies one.
{
  const r = await drive(
    "handed-back",
    10,
    log({ prUrl: URL, draft: true, dispatches: CHILDREN, posted: false }),
  );
  assert(r.violations.length === 0, `unposted: output contract (${r.violations.join("; ")})`);
  const i = r.issue ?? {};
  const handoff = i.handoff as Record<string, unknown>;
  assert(handoff !== undefined, "unposted: the report is still carried");
  assert(
    handoff.channel === "forge" && handoff.delivery === undefined,
    `unposted: the address stays the forge's and no delivery is asserted (got ${JSON.stringify([handoff.channel, handoff.delivery])})`,
  );
  assert(
    handoff.bodyError === "not-recorded" && handoff.body === undefined,
    `unposted: the contract's own "published nothing" fields (got ${JSON.stringify([handoff.bodyError, handoff.body])})`,
  );
  assert(
    handoff.labelApplied === false,
    `unposted: no label was applied (got ${String(handoff.labelApplied)})`,
  );
  assert(
    handoff.labelSkipped === undefined,
    `unposted: not the host channel's DECLINE either — the post failed (got ${String(handoff.labelSkipped)})`,
  );
  assert(
    handoff.bodyFile === undefined,
    `unposted: no body file is named, because lean writes none (got ${String(handoff.bodyFile)})`,
  );
}

// ── (3f) a delivered report is the forge channel, and STILL claims no label —
// there is no label step in the lean machine, so `true` would be a claim from a
// run that has no step to make it.
{
  const r = await drive("handed-back", 10, log({ prUrl: URL, draft: false, dispatches: CHILDREN }));
  const i = r.issue ?? {};
  const handoff = i.handoff as Record<string, unknown>;
  assert(
    handoff.channel === "forge",
    `posted: a delivered report is the forge channel (got ${String(handoff.channel)})`,
  );
  assert(
    handoff.labelApplied === false,
    `posted: lean applies no needs-human-attention label (got ${String(handoff.labelApplied)})`,
  );
  assert(
    handoff.bodyFile === undefined,
    `posted: and names no body file (got ${String(handoff.bodyFile)})`,
  );
}


process.exit(state.exit);
