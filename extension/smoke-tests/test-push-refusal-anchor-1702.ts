#!/usr/bin/env bun
/**
 * #1702 — the push-refusal recognition is ANCHORED to forge-authored lines, and the refusal
 * text it produces is REDACTED before it is bounded.
 *
 * Two defects, both HIGH, both in `work-driver-push-refusal.ts`:
 *
 *   1. ANCHORING. The pre-fix matcher tested the WHOLE concatenated stream (`stderr` +
 *      `message` + `stdout`), so any line naming `GH013` / `push protection` /
 *      `repository rule violations` / `non-fast-forward` made the whole failure a refusal. A
 *      project's own output that merely mentions one of those tokens — a test fixture, a
 *      changelog line, a lint rule, a doc string — was read as the forge's verdict: the
 *      cycle parked as `push-refused:<step>`, blamed a remote that never spoke, and skipped
 *      the ops fallback that could actually have worked around the real failure. Git and
 *      GitHub put the server's verdict on `remote:`-prefixed lines and the rejected ref on
 *      `! [rejected]` / `! [remote rejected]` / `error: failed to push some refs`; only those
 *      may carry it.
 *
 *   2. REDACTION. `pushRefusalEvidence` is the text that lands on the cap's `evidence`, on
 *      `pipelineState.verifyEvidence.failures`, and in the commit-pr plumb-report body — and
 *      through them the handoff comment, the PR and the state file. A GH013 refusal quotes
 *      the very content push protection flagged, so a credential on that path is not
 *      hypothetical: without a redaction pass the driver republished the secret it was
 *      refused for. Redaction runs BEFORE the bound (`redactThenBound`), so the clip cannot
 *      cut a token into a fragment no pattern recognises.
 *
 * The token is assembled from fragments at runtime, never written as a literal in this file
 * — the same rule the project's own fixtures follow, and the reason GitHub push protection
 * is what refuses the commits that carry a literal.
 *
 * The step-level counterpart (the cap's evidence, `verifyEvidence`, and the plumb body all
 * redacted on a real `runCommitPr`) is in `test-push-refused-commit-pr-1439.ts`.
 */

import { isPushRefusal, pushRefusalEvidence } from "../src/work-driver-push-refusal.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const TOKEN = ["gh", "p_", "aB3dE5fG7hJ9kL1mN2pQ4rS6tU8v"].join("");
const REDACTED = "[REDACTED]";
const UNBLOCK = "https://github.com/o/r/security/secret_scanning/unblock-secret/3Kvj3Vlk";

// ---------------------------------------------------------------------------
// 1. Recognition is anchored to the lines git and the FORGE write.

// The shapes that ARE a refusal, each on a line the forge authored.
assert(
  isPushRefusal("remote: error: GH013: Repository rule violations found for refs/heads/x"),
  "a `remote:` GH013 line is a refusal",
);
assert(isPushRefusal("! [rejected] main -> main (non-fast-forward)"), "`! [rejected]` is one");
assert(
  isPushRefusal("remote: ! [remote rejected] feature/x -> feature/x (non-fast-forward)"),
  "`! [remote rejected]` is one",
);
assert(
  isPushRefusal(
    [
      "To https://github.com/o/r.git",
      " ! [rejected]        feature/x -> feature/x (non-fast-forward)",
      "error: failed to push some refs to 'https://github.com/o/r.git'",
    ].join("\n"),
  ),
  "git's own `! [rejected] … (non-fast-forward)` + `error: failed to push` shape is one",
);

// The shapes that are NOT — the control the anchor must not lose.
assert(
  !isPushRefusal("fatal: could not read from remote repository"),
  "an SSH transport failure is NOT a refusal (that one IS the ops fallback's job)",
);
assert(!isPushRefusal(""), "empty text is not a refusal");
assert(!isPushRefusal(undefined), "undefined is not a refusal");

// The regression this fix exists for: the SAME tokens, in the project's OWN output.
assert(
  !isPushRefusal(
    [
      "test merge_policy ... FAILED",
      "assertion failed: the changelog mentions non-fast-forward in its body",
      "note: our docs describe non-fast-forward as a rejection reason",
    ].join("\n"),
  ),
  "#1702: project output mentioning `non-fast-forward` outside a forge line is NOT a refusal",
);
assert(
  !isPushRefusal("GH013 appears in our own test fixture name: tests/GH013-branch.ts"),
  "#1702: a project line naming GH013 without a forge prefix is not the forge speaking",
);
assert(
  !isPushRefusal(
    [
      "Compiling 42 crates",
      "warning: `push protection` is mentioned in src/policy.rs doc comments",
      "error[E0308]: mismatched types",
    ].join("\n"),
  ),
  "#1702: a compiler error whose log quotes `push protection` in prose is not a refusal either",
);
// A `hint:` line — git prints the non-fast-forward explanation there, and the hint is not
// the verdict. The verdict lines above still catch the real case.
assert(
  !isPushRefusal("hint: Updates were rejected because the remote contains work (non-fast-forward)"),
  "#1702: a bare `hint:` line is git's advice, not the forge's verdict",
);

// ---------------------------------------------------------------------------
// 2. The evidence is redacted BEFORE it is bounded, and the operator's URL survives.

const GH013_WITH_TOKEN = [
  "remote: error: GH013: Repository rule violations found for refs/heads/feature/x.",
  "remote: - GITHUB PUSH PROTECTION",
  `remote:   flagged: ${TOKEN} in src/fixtures/stripe.ts`,
  `remote:     * Push the commit again to allow the secret: ${UNBLOCK}`,
].join("\n");

{
  const ev = pushRefusalEvidence(GH013_WITH_TOKEN);
  assert(
    !ev.includes(TOKEN) && ev.includes(REDACTED),
    "#1702: pushRefusalEvidence redacts a token riding a `remote:` line",
  );
  assert(
    ev.includes("unblock-secret/3Kvj3Vlk") && ev.includes("GH013"),
    "#1702: the redaction keeps the verdict and the allow-the-secret URL intact",
  );
  assert(
    ev.includes("GITHUB PUSH PROTECTION"),
    "#1702: the refusal prose a person needs to recognise the case is not redacted away",
  );
}

{
  // Redact-then-clip, never clip-then-redact: a token whose tail falls past the bound must
  // leave no recognisable fragment either, and no un-redacted head.
  const straddling = `remote: GH013 flagged ${"z".repeat(1160)}${TOKEN}`;
  const clipped = pushRefusalEvidence(straddling, 1200);
  assert(
    !clipped.includes(TOKEN),
    "#1702: a token crossing the bound is redacted BEFORE the clip, so no fragment survives",
  );
  assert(
    !clipped.includes("ghp_"),
    "#1702: the clip leaves no prefix of the credential behind either",
  );
}

{
  // A `key=value` shape on a fallback-path line (no `remote:` prefix — a forge that does
  // not prefix falls back to the whole text, and that text is redacted too).
  const kv = [
    "server: repository rule violations found",
    `config dumped: api_key=${TOKEN}-abcdefghij`,
  ].join("\n");
  const ev = pushRefusalEvidence(kv);
  assert(
    !ev.includes(TOKEN) && ev.includes(REDACTED),
    "#1702: the unprefixed fallback text is redacted as well, not just `remote:` lines",
  );
}

process.exit(exit);
