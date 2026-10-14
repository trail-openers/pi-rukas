#!/usr/bin/env bun
/**
 * #1151 — the CRITICAL open-point gate, split out of test-intent-criticality.ts
 * to keep that file under the 500-line gate. Reads the Open points section,
 * parks the security class, caps other points, and round-trips the gap gate's
 * own rendered section.
 */

import { openPointsSection } from "../src/plan-gap-disclosure.ts";
import type { PlanGap } from "../src/plan-types.ts";
import { criticalOpenPoints, openPointText } from "../src/work-driver-intent-criticality.ts";
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import { type NormalisedSpec, renderAssumptions } from "../src/work-driver-intent.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const spec = (over: Partial<NormalisedSpec> = {}): NormalisedSpec => ({
  intent: "Preserve the requested intent while applying the change.",
  deliverables: [
    {
      id: "d1",
      description: "apply the requested change",
      paths: ["extension/src/work-driver-intent.ts"],
    },
  ],
  acceptanceCriteria: ["the requested behavior is preserved"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "proceed",
  rationale: "the requested change is actionable",
  ...over,
});

/** The gate over raw CRITICAL point texts, as a filed issue carries them. */
const applyOpenPointGate = (s: NormalisedSpec, points: string[]): NormalisedSpec =>
  finaliseSpecVerdict(
    s,
    [
      "## Open points (unresolved at the gap-gate cap)",
      "",
      ...points.map((p) => `- [CRITICAL] ${p}`),
    ].join("\n"),
  );

// ------------------------------------------- CRITICAL open points (#1151)

{
  // A filed issue's "Open points" section lists the CRITICAL points the gap
  // gate could not resolve. Extraction reads only that section, and only the
  // bullets tagged [CRITICAL].
  const body = [
    "## Context",
    "- [CRITICAL] not a point: outside the section",
    "",
    "## Open points (unresolved at the gap-gate cap)",
    "",
    "The gap gate reached its iteration cap with these CRITICAL points still unresolved.",
    "",
    "- [CRITICAL] Which timeout wins when both are set — proposal: the shorter one",
    "- [HIGH] A HIGH point is not gated here",
    "- **[CRITICAL]** Whether the retry ceiling is per-provider — proposal: global",
    "",
    "## Open Questions",
    "- (none)",
  ].join("\n");
  const points = criticalOpenPoints(body).map(openPointText);
  assert(
    points.length === 2 &&
      points[0] === "Which timeout wins when both are set — proposal: the shorter one" &&
      points[1] === "Whether the retry ceiling is per-provider — proposal: global",
    "criticalOpenPoints reads only CRITICAL bullets in the Open points section",
  );
  assert(
    criticalOpenPoints("## Open Questions\n- [CRITICAL] wrong section").length === 0,
    "criticalOpenPoints ignores CRITICAL bullets outside the Open points section",
  );
}

{
  // An unresolved CRITICAL point caps a proceed at proceed-with-assumptions,
  // and each point is named as an assumption so it reaches the PR body.
  const resolved = applyOpenPointGate(spec({ verdict: "proceed" }), [
    "Which timeout wins when both are set",
  ]);
  assert(
    resolved.verdict === "proceed-with-assumptions",
    "an open CRITICAL point caps proceed at proceed-with-assumptions",
  );
  assert(
    resolved.assumptions.some((a) => a.text.includes("Which timeout wins when both are set")),
    "each open CRITICAL point is named as an assumption",
  );
  const rendered = renderAssumptions(resolved);
  assert(
    rendered.includes("Which timeout wins when both are set"),
    "the named point reaches the rendered PR-body assumptions",
  );
}

{
  // A plain proceed-with-assumptions is not downgraded, and a park stays a park.
  const withAssumption = spec({ verdict: "proceed-with-assumptions" });
  assert(
    applyOpenPointGate(withAssumption, ["Which timeout wins"]).verdict ===
      "proceed-with-assumptions",
    "an open point keeps proceed-with-assumptions",
  );
  const parked = spec({
    verdict: "park",
    parkReason: "already-implemented",
    parkReasonSource: "parsed",
  });
  assert(
    applyOpenPointGate(parked, ["Which timeout wins"]).parkReason === "already-implemented",
    "an existing park is not rewritten by an open point",
  );
}

// An open point that touches authentication, authorization, secrets or
// permissions is not something the driver may decide: park as security-open-point.
for (const point of [
  "Who may call the retry endpoint — authentication is undecided",
  "Which role has authorization to rotate keys",
  "Where the API secrets live — proposal: env var",
  "What permissions the worker needs on the bucket",
]) {
  const resolved = applyOpenPointGate(spec({ verdict: "proceed" }), [point]);
  assert(
    resolved.verdict === "park" && resolved.parkReason === "security-open-point",
    `an authorization-class open point parks as security-open-point: ${point.slice(0, 40)}`,
  );
}
assert(
  applyOpenPointGate(spec({ verdict: "proceed" }), ["Which timeout wins"]).verdict ===
    "proceed-with-assumptions",
  "canary: a non-authorization open point does not park",
);

{
  // No open points: the spec passes through untouched.
  const plain = spec({ verdict: "proceed" });
  const gated = applyOpenPointGate(plain, []);
  assert(
    gated.verdict === "proceed" && gated.assumptions.length === 0,
    "no open points leaves the spec unchanged",
  );
}

// ----------------------------------- authorization class canaries (#1151 widened)

{
  // One canary per widened class: each CRITICAL point touching it parks.
  const classes: Array<[string, string]> = [
    ["credential", "Where the credential is read from \u2014 proposal: env"],
    ["token", "Which token lifetime applies \u2014 proposal: one hour"],
    ["api key", "Whether the api key rotates \u2014 proposal: monthly"],
    ["password", "Whether the password is hashed \u2014 proposal: bcrypt"],
    ["encrypt", "Whether the payload is encrypted at rest \u2014 proposal: yes"],
    ["decrypt", "Who may decrypt the export \u2014 proposal: the owner"],
    ["tls", "Whether the TLS config is pinned \u2014 proposal: yes"],
    ["certificate", "Which certificate chain is trusted \u2014 proposal: system store"],
    ["crypto", "Which crypto library to use \u2014 proposal: node:crypto"],
    ["sanitize", "Whether input is sanitized before logging \u2014 proposal: yes"],
    ["validate", "Whether schema validation is strict \u2014 proposal: strict"],
    ["inject", "Whether prompt injection is guarded \u2014 proposal: yes"],
    ["sandbox", "Whether the sandbox is enabled for the child \u2014 proposal: yes"],
    ["privilege", "Which privilege level the worker runs at \u2014 proposal: least"],
    ["access control", "Who is covered by the access control list \u2014 proposal: admins"],
    ["delete", "Whether records are deleted or soft-deleted \u2014 proposal: soft"],
    ["data loss", "Whether this risks data loss on rollback \u2014 proposal: none"],
    ["secret", "Where the secrets live \u2014 proposal: env var"],
    ["auth", "Whether auth is required on the retry endpoint \u2014 proposal: yes"],
    ["oauth", "OAuth scopes for the webhook \u2014 proposal: read-only"],
    ["jwt", "JWT expiry for the worker \u2014 proposal: 15 minutes"],
    ["acl", "ACL for the bucket \u2014 proposal: private"],
    ["rbac", "RBAC mapping for reviewers \u2014 proposal: maintainer"],
    ["role", "which role may rotate keys \u2014 proposal: admins"],
    ["session", "How long a session stays valid \u2014 proposal: 1 hour"],
    ["login", "Whether login is rate limited \u2014 proposal: yes"],
    ["signing key", "Where the signing key is stored \u2014 proposal: KMS"],
    ["private key", "Whether the private key is rotated \u2014 proposal: yearly"],
  ];
  for (const [cls, point] of classes) {
    const resolved = applyOpenPointGate(spec({ verdict: "proceed" }), [point]);
    assert(
      resolved.verdict === "park" && resolved.parkReason === "security-open-point",
      `canary: a ${cls} open point parks as security-open-point`,
    );
  }
  // Non-security CRITICAL points are still carried as assumptions, not parked.
  const perProvider = applyOpenPointGate(spec({ verdict: "proceed" }), [
    "Whether the retry ceiling is per-provider \u2014 proposal: global",
  ]);
  assert(
    perProvider.verdict === "proceed-with-assumptions",
    "canary: a non-security CRITICAL point caps proceed to proceed-with-assumptions",
  );
}

// -------------------------- open-point producer round trip (#1151 shared constants)

{
  // The gap gate renders the section; criticalOpenPoints must read it back.
  const gaps: PlanGap[] = [
    {
      severity: "CRITICAL",
      description: "Which timeout wins when both are set",
      resolution: "use the shorter one",
    },
    {
      severity: "HIGH",
      description: "A HIGH residual that never gates",
      resolution: "later",
    },
    {
      severity: "CRITICAL",
      description: "Whether the retry ceiling is per-provider",
      resolution: "address during /work plan phase",
    },
  ];
  const points = criticalOpenPoints(openPointsSection(gaps)).map(openPointText);
  assert(
    points.length === 2 &&
      points[0] === "Which timeout wins when both are set \u2014 proposed: use the shorter one" &&
      points[1] === "Whether the retry ceiling is per-provider \u2014 no proposed resolution",
    "round trip: the rendered open-points section parses back to its CRITICAL points",
  );
}

// ------------------- finaliseSpecVerdict: reconcile first, then the open-point gate

{
  // A complete spec refutes an underspecified park, and the authorization open
  // point must still park it afterwards. The order is the point of the function.
  const complete = spec({
    verdict: "park",
    parkReason: "underspecified",
    parkReasonSource: "parsed",
    evidence: [
      {
        claim: "the retry ceiling is unimplemented",
        source: "x.ts:1",
        verdict: "confirmed",
      },
    ],
  });
  const body =
    "## Open points (unresolved at the gap-gate cap)\n\n- [CRITICAL] Who may call the endpoint \u2014 authentication is undecided\n";
  const finalised = finaliseSpecVerdict(complete, body);
  assert(
    finalised.verdict === "park" && finalised.parkReason === "security-open-point",
    "finalise: an authorization open point parks a spec that reconciliation had lifted",
  );
  assert(
    finaliseSpecVerdict(complete, "## Notes\n\nnothing open").verdict ===
      "proceed-with-assumptions",
    "finalise: a complete spec with no open points is lifted to proceed-with-assumptions",
  );
}

{
  // Primary body not read: the gate cannot run. That is recorded, not skipped.
  // A blank body parks a proceed: the driver cannot say the issue is clean (#1171).
  for (const blank of [undefined, "", "   \n"]) {
    const proceed = finaliseSpecVerdict(spec({ verdict: "proceed" }), blank);
    assert(
      proceed.verdict === "park" &&
        proceed.parkReason === "underspecified" &&
        proceed.assumptions.some((a) => a.text === "Open-point gate did not run: issue body blank"),
      `unchecked gate: a blank body parks proceed as underspecified (${JSON.stringify(blank)})`,
    );
    const parked = spec({
      verdict: "park",
      parkReason: "already-implemented",
      parkReasonSource: "parsed",
    });
    assert(
      finaliseSpecVerdict(parked, blank).parkReason === "already-implemented",
      "unchecked gate: an existing park stays a park",
    );
  }
  // Reconciliation runs first and would lift this complete spec's underspecified park.
  // The unchecked-body park is applied after it, so nothing lifts it.
  const liftable = spec({
    verdict: "park",
    parkReason: "underspecified",
    parkReasonSource: "parsed",
    evidence: [
      { claim: "the retry ceiling is unimplemented", source: "x.ts:1", verdict: "confirmed" },
    ],
  });
  assert(
    finaliseSpecVerdict(liftable, "## Notes\n\nnothing open").verdict ===
      "proceed-with-assumptions",
    "precondition: the complete spec is lifted when the body is read",
  );
  const unchecked = finaliseSpecVerdict(liftable, "  \n");
  assert(
    unchecked.verdict === "park" && unchecked.parkReason === "underspecified",
    "unchecked gate: a lift by reconciliation does not survive a blank body",
  );
  // No Open points section: nothing is gated, so a park keeps its reason.
  const parkedNoSection = spec({
    verdict: "park",
    parkReason: "already-implemented",
    parkReasonSource: "parsed",
  });
  assert(
    finaliseSpecVerdict(parkedNoSection, "## Notes\n\nnothing open").parkReason ===
      "already-implemented",
    "no open-points section: an existing park stays a park",
  );
}

{
  // Assumption text is capped and rendered in a code span, so issue text cannot
  // break out of the PR body.
  const long = `Which \`timeout\` wins ${"x".repeat(400)}`;
  const capped = applyOpenPointGate(spec({ verdict: "proceed" }), [long]);
  const text = capped.assumptions.at(-1)?.text ?? "";
  const span = text.match(/`([^`]*)`$/)?.[1] ?? "";
  assert(
    span.length > 0 && span.length <= 300,
    `cap: a CRITICAL point is capped to 300 characters (${span.length})`,
  );
  assert(!span.includes("`"), "cap: a backtick in issue text cannot break the code span");
}

// ------------------------- wrapped open points (#1171): continuation lines

{
  // An indented line wrapped onto a CRITICAL point belongs to that point.
  const wrapped =
    "## Open points (unresolved at the gap-gate cap)\n\n- [CRITICAL] Which timeout wins\n  authentication for the endpoint is undecided\n";
  assert(
    finaliseSpecVerdict(spec({ verdict: "proceed" }), wrapped).parkReason === "security-open-point",
    "continuation: an indented line wrapped onto a CRITICAL point parks it",
  );
  // A wrapped HIGH item cannot swallow a CRITICAL line: the CRITICAL line still gates.
  const wrappedHigh =
    "## Open points (unresolved at the gap-gate cap)\n\n- [HIGH] Which timeout wins\n  [CRITICAL] authentication for the endpoint is undecided\n";
  assert(
    finaliseSpecVerdict(spec({ verdict: "proceed" }), wrappedHigh).parkReason ===
      "security-open-point",
    "continuation: a CRITICAL line under a HIGH item still gates",
  );
}

// #1171 canaries: a continuation that merely mentions "critical" still joins; a nested
// security item under a CRITICAL point is not silently dropped.
{
  const head = "## Open points (unresolved at the gap-gate cap)\n\n";
  const mentionsCritical = `${head}- [CRITICAL] Which retry ceiling applies\n  the api key rotation is critical to decide\n`;
  assert(
    finaliseSpecVerdict(spec(), mentionsCritical).parkReason === "security-open-point",
    "canary: a continuation naming critical joins its point and parks (api key)",
  );
  const nested = `${head}- [CRITICAL] Which timeout wins\n  - authentication is undecided\n`;
  assert(
    finaliseSpecVerdict(spec(), nested).parkReason === "security-open-point",
    "canary: a nested security item under a CRITICAL point parks",
  );
  const nestedBenign = `${head}- [CRITICAL] Which retry ceiling applies\n  - the cache TTL is open\n`;
  const benign = finaliseSpecVerdict(spec(), nestedBenign);
  assert(
    benign.verdict === "proceed-with-assumptions" &&
      !benign.assumptions.some((a) => /could not parse/.test(a.text)),
    "canary: a nested non-security item is not reported as unparsed",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
