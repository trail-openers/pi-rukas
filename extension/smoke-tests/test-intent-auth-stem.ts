#!/usr/bin/env bun
/**
 * #1151 follow-up — the authorization class matches auth words, not "author".
 *
 * The bare `auth\w*` stem swallowed author/authored/authority/authorship, so a
 * CRITICAL point about the issue's author parked as a security decision. The
 * short forms (auth, authn, authz, preauth, reauth, OAuth2) and the long forms
 * (authentication, authorization, unauthorized) must still park.
 */

import { applyOpenPointGate } from "../src/work-driver-intent-criticality.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";

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
  deliverables: [{ id: "d1", description: "apply the requested change", paths: [] }],
  acceptanceCriteria: ["the requested behavior is preserved"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "proceed",
  rationale: "the requested change is actionable",
  ...over,
});

// Ordinary words sharing the auth stem are plain assumptions, not security decisions.
for (const point of [
  "the author of the issue decides \u2014 proposal: the maintainer",
  "authority over the roadmap \u2014 proposal: the PM",
  "which authored changes are in scope \u2014 proposal: all",
]) {
  const resolved = applyOpenPointGate(spec({ verdict: "proceed" }), [point]);
  assert(
    resolved.verdict === "proceed-with-assumptions",
    `author/authority wording does not park: ${point.slice(0, 30)}`,
  );
}

// Short and prefixed auth forms, and the long forms, still park.
for (const point of [
  "auth \u2014 proposal: required",
  "authn provider \u2014 proposal: OIDC",
  "authz model \u2014 proposal: RBAC",
  "OAuth2 scopes \u2014 proposal: read-only",
  "preauth hook \u2014 proposal: none",
  "reauth window \u2014 proposal: 5 minutes",
  "authorization policy \u2014 proposal: owner",
  "unauthorized callers \u2014 proposal: 403",
  "authenticated users only \u2014 proposal: yes",
  "auth_token header \u2014 proposal: bearer",
]) {
  const resolved = applyOpenPointGate(spec({ verdict: "proceed" }), [point]);
  assert(
    resolved.verdict === "park" && resolved.parkReason === "security-open-point",
    `auth-class wording parks: ${point.slice(0, 30)}`,
  );
}

process.exit(exit);
