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
 *     step applies a label, and no `bodyFile`, since nothing in `lean/` writes one;
 *   - the CHANNEL is read from the step, never from `PI_ENSEMBLE_HANDOFF_CHANNEL`
 *     again: the pair "the host owns it" / "nothing was sent" is one fact written
 *     by the step that decided whether to post, so a run that reported on the host
 *     channel keeps its body even when the env says `forge` by the time the
 *     projection runs, and a run whose FORGE post was refused keeps its
 *     not-delivered pair even when the env says `host`.
 *
 * Both files drive the same fixture (`lib/lean-result-fixture.ts`) through the
 * real `work-lean` verb, so neither is testing a hand-built projection.
 */

import type { Step } from "../src/lean/state.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import {
  CHILDREN,
  URL,
  driveLean,
  leanLog,
  stepWith,
  withReason,
} from "./lib/lean-result-fixture.ts";

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

// ── (3g) a long reason still leaves a body. The reason is clipped ONCE, to the
// room the composed body has left after the marker line: clipping it to the whole
// budget and letting the shared reader bound the body again cut the reason away
// entirely the moment the marker was added, so a 480-char report published a
// marker and nothing else.
{
  // The marker is `<!-- pi-rukas:handoff issue=7 cap=none -->` — 45 chars; the
  // reason is a sentence of words, so nothing redacts, and the body must carry it.
  const long = "defect ".repeat(68).trim();
  const steps = log({ prUrl: URL, draft: false });
  steps[steps.length - 1] = withReason(steps[steps.length - 1] as Step, long);
  const r = await drive("handed-back", 10, steps);
  assert(r.violations.length === 0, `long-reason: output contract (${r.violations.join("; ")})`);
  const i = r.issue ?? {};
  const handoff = i.handoff as Record<string, unknown>;
  const body = handoff.body as string | undefined;
  assert(
    typeof body === "string" && body.length > 0 && body.includes(handoff.marker as string),
    `long-reason: the body survives and carries its marker (got ${JSON.stringify(body)?.slice(0, 80)})`,
  );
  assert(
    typeof body === "string" && body.includes("defect"),
    `long-reason: and the reason itself, not just the marker (got ${String(body?.length)} chars)`,
  );
  assert(
    typeof body === "string" && body.length <= 500,
    `long-reason: and the composed body is inside the bound (got ${String(body?.length)})`,
  );
}

// ── (3g′) the HOST channel's body is redacted like the forge's. The forge post is
// the leg that carries the public-hygiene check; on the host channel the result
// document IS the delivery, so a projection that published the report unredacted
// would hand the host the credential bytes the forge was about to refuse — and a
// host that posts the document verbatim puts them on a public issue.
{
  const steps = log({ prUrl: URL, draft: false });
  // A GitHub token welded into the report the step built — the shape a child's
  // pasted output takes. `report` is untrusted text by contract.
  (steps[steps.length - 1] as Step).outcome = {
    kind: "done",
    posted: false,
    channel: "host",
    reason: "handback comment posted",
    report: `still needed: push with ghp_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8v_0 first`,
  };
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "forge";
  const r = await drive("handed-back", 10, steps);
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  const handoff = (r.issue ?? {}).handoff as Record<string, unknown>;
  const body = handoff.body as string | undefined;
  assert(
    typeof body === "string" && body.includes("still needed"),
    `(3g′) the host is handed the report (got ${JSON.stringify(String(body).slice(0, 60))})`,
  );
  assert(
    typeof body === "string" && !body.includes("ghp_aB3dE5fG7hJ9kL1mN2pQ4rS6tU8v_0"),
    `(3g′) and NOT the token welded to it (got ${JSON.stringify(String(body).slice(0, 120))})`,
  );
  assert(
    typeof body === "string" && body.includes("[REDACTED"),
    `(3g′) the secret is replaced by the redaction marker (got ${JSON.stringify(String(body).slice(0, 120))})`,
  );
  delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
}

// ── (3h) the channel is the STEP's answer, not the environment's. The handoff
// step is the thing that decided whether to post, so its record is the account of
// what happened; a projection that re-read `PI_ENSEMBLE_HANDOFF_CHANNEL` could
// contradict it, and a host would post a second copy of a comment the forge took
// (or lose the body of one it never did).
//
// The env is moved BETWEEN the run and the projection, because that window is
// where the disagreement can arise: a host that exported `host` for the cycle and
// cleared it (or set it) before reading the document, and a resume boundary that
// re-enters the process with different surroundings. Setting the env BEFORE the
// drive proves nothing — then the step and the projection read the same value and
// both answers agree whatever the projection does. So the step is written under
// one setting and the document built under the OTHER, in both directions.
{
  // A host-channel handback — `posted: false` WITH the typed `channel: "host"`
  // its handler stamped — decided under `host`; the document is built with the env
  // saying `forge`.
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  const steps = log({ prUrl: URL, draft: false });
  steps[steps.length - 1] = withReason(steps[steps.length - 1] as Step, "gate red");
  (steps[steps.length - 1] as Step).outcome = {
    ...((steps[steps.length - 1] as Step).outcome as unknown as Record<string, unknown>),
    kind: "done",
    posted: false,
    channel: "host",
  };
  // The step is recorded; now the environment contradicts it.
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "forge";
  const r = await drive("handed-back", 10, steps);
  const handoff = (r.issue ?? {}).handoff as Record<string, unknown>;
  assert(
    handoff.channel === "host" && handoff.labelSkipped === "host-channel",
    `env-flip: a host-channel step is still addressed to the host (got ${JSON.stringify([handoff.channel, handoff.labelSkipped])})`,
  );
  assert(
    typeof handoff.body === "string" && handoff.body.includes("gate red"),
    `env-flip: and still carries the body the host must post (got ${JSON.stringify(String(handoff.body).slice(0, 60))})`,
  );
  assert(
    handoff.bodyError === undefined,
    `env-flip: not the forge's not-delivered pair (got ${JSON.stringify(handoff.bodyError)})`,
  );

  // A `posted: false` with NO channel is the shape a pre-#1920 record, or a
  // handler that forgot the field, has: the honest answer is the forge's, because
  // nothing on the step claims the host was ever addressed.
  const noChannel = log({ prUrl: URL, draft: false });
  (noChannel[noChannel.length - 1] as Step).outcome = {
    ...((noChannel[noChannel.length - 1] as Step).outcome as unknown as Record<string, unknown>),
    kind: "done",
    posted: false,
    channel: undefined,
  };
  const r3 = await drive("handed-back", 10, noChannel);
  const handoff3 = (r3.issue ?? {}).handoff as Record<string, unknown>;
  assert(
    handoff3.channel === "forge" && handoff3.bodyError === "not-recorded",
    `env-flip: a step that recorded no channel is not addressed to the host (got ${JSON.stringify([handoff3.channel, handoff3.bodyError])})`,
  );

  // The mirror: a FORGE post the forge refused, decided under `forge`; the
  // document is built with the env saying `host`, and the honest answer is still
  // "nothing reached the forge", not a body the host could post.
  delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
  const r2 = await drive("handed-back", 10, log({ prUrl: URL, draft: false, posted: false }));
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  const handoff2 = (r2.issue ?? {}).handoff as Record<string, unknown>;
  assert(
    handoff2.channel === "forge" && handoff2.bodyError === "not-recorded",
    `env-flip: a refused forge post keeps its not-delivered pair (got ${JSON.stringify([handoff2.channel, handoff2.bodyError])})`,
  );
  assert(
    handoff2.body === undefined && handoff2.labelSkipped === undefined,
    `env-flip: and claims no host body or label decline (got ${JSON.stringify([handoff2.body === undefined, handoff2.labelSkipped])})`,
  );
  delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
}

process.exit(state.exit);
