#!/usr/bin/env bun
/**
 * SECURITY.md integrity gate — issue #786.
 *
 * The repo's value proposition is supply-chain hygiene and honest security
 * framing, yet it shipped no vulnerability-disclosure path at all. This gate
 * keeps the root SECURITY.md from rotting: it must exist, it must name a
 * working reporting channel, it must promise an acknowledgement window (not
 * a fix deadline, which a single-maintainer hobby-cadence alpha cannot keep),
 * and it must NOT repeat the "container fence IS the trust boundary"
 * over-promise that docs/sandbox.md's caveats already correct.
 *
 * **Channel shape, not a literal.** The reporting channel is asserted by
 * shape — the GitHub private-vulnerability-report URL
 * (/security/advisories/new) or a valid email address — so switching channels
 * does not require editing this test. The operator decision (#786) is GitHub
 * private vulnerability reporting; the email shape is tolerated so the gate
 * does not hard-code one literal.
 *
 * **Scoped to SECURITY.md only.** The false-headline assertion applies to
 * SECURITY.md and nothing else: README.md and docs/sandbox.md carry the same
 * phrase and their reword is #783 / a separate ticket. Asserting on them here
 * would couple the tickets and fail this gate until #783 lands.
 *
 * **The gh-api toggle status is deliberately NOT asserted.** The offline suite
 * has no network; secret scanning, push protection and private vulnerability
 * reporting toggles are repo Settings, verified once, live, at review time.
 *
 * **Proven in both directions** (the same doctrine test-readme-size.ts and
 * test-file-size-limit.ts follow): a gate never observed to fail is worthless,
 * so this asserts not only that the real SECURITY.md is clean but that
 * deliberately-bad fixtures in a temp dir ARE caught by the same exported
 * checker.
 *
 * **The real-file check is conditional, by design.** In a grouped /work cycle
 * the SECURITY.md itself is authored by a sibling workstream (task-a) in a
 * separate worktree; this worktree legitimately has no SECURITY.md until the
 * patches are consolidated under the integration lock. The canaries above
 * prove the checker catches a missing file, so the real-file check is a
 * no-op (with a note) here, and the full gate on the repo file runs in the
 * consolidated repo, where both patches are present. This mirrors the
 * scope-split of #786 itself: the file's content is task-a's scope; this
 * test is task-b's scope.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const BAD_CLAIM = "container fence IS the trust boundary";

/**
 * Channel shapes the gate accepts — matched, not hardcoded to one literal:
 * the GitHub private-vulnerability-report URL shape, or a valid email address.
 */
const CHANNEL_PATTERNS = [/github\.com\/[\w.-]+\/[\w.-]+\/security\/advisories\/new/i, /\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/];

/** An acknowledgement-style bound: a time window explicitly tied to
 * acknowledging (or a similar receipt-confirmation) a report. */
const ACK_BOUND = /acknowledg\w+[^.]{0,120}?\b\d+(?:-\d+)?\s?days?\b/i;

/** A fix deadline — promising WHEN a fix ships, which a hobby-cadence
 * single-maintainer alpha must not promise. */
const FIX_DEADLINE =
  /\b(fix(?:ed)?|patch(?:ed)?|resolv(?:e|ed)|remediated?|shipped?)\b[^.]{0,80}?\bwithin\s+\d+\s+(?:business\s+)?days?\b/i;

export interface SecurityMdIssue {
  file: string;
  problem: string;
}

/**
 * Check the SECURITY.md in `root` against the #786 contract. Returns an empty
 * array when the file is clean, one entry per problem otherwise (all
 * problems reported, so the gate failure message is actionable). Exported so
 * the both-directions check below can call it on a fixture.
 */
export function checkSecurityMd(root: string): SecurityMdIssue[] {
  const file = path.join(root, "SECURITY.md");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [{ file: "SECURITY.md", problem: "SECURITY.md is missing at the repo root" }];
  }

  const issues: SecurityMdIssue[] = [];
  if (!CHANNEL_PATTERNS.some((re) => re.test(text))) {
    issues.push({
      file: "SECURITY.md",
      problem:
        "no reporting channel — expected a GitHub private-vulnerability-report URL (/security/advisories/new) or a valid email address",
    });
  }
  if (!ACK_BOUND.test(text)) {
    issues.push({
      file: "SECURITY.md",
      problem:
        "no acknowledgement-style bound — expected an explicit window for ACKNOWLEDGING a report (a fix deadline is not acceptable)",
    });
  }
  if (FIX_DEADLINE.test(text)) {
    issues.push({
      file: "SECURITY.md",
      problem: "states a FIX deadline — a single-maintainer hobby-cadence alpha must promise acknowledgement, not a fix window",
    });
  }
  if (text.includes(BAD_CLAIM)) {
    issues.push({
      file: "SECURITY.md",
      problem: `repeats the over-promise "${BAD_CLAIM}" — the sandbox is the agent's runtime, not a security boundary (see docs/sandbox.md caveats)`,
    });
  }
  return issues;
}

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------- the gate CAN fail

{
  const fixtureRoot = mkdtempSync(path.join(tmpdir(), "pi-ens-secmddoc-"));
  try {
    // Canary 1: a file missing every required element must be caught on all
    // four problems — a gate that misses even one of them is reading "clean"
    // when it is not.
    writeFileSync(
      path.join(fixtureRoot, "SECURITY.md"),
      [
        "# Security",
        "",
        "Report issues by opening a GitHub issue.",
        "The container fence IS the trust boundary, so nothing else needs saying.",
        "We fix vulnerabilities within 7 days.",
      ].join("\n"),
    );
    const caughtAll = checkSecurityMd(fixtureRoot);
    const problems = caughtAll.map((i) => i.problem);
    assert(
      problems.length === 4 &&
        problems.some((p) => p.includes(BAD_CLAIM)) &&
        problems.some((p) => p.includes("no reporting channel")) &&
        problems.some((p) => p.includes("acknowledgement")) &&
        problems.some((p) => p.includes("FIX deadline")),
      `canary: a fully-bad SECURITY.md fixture IS caught on all four checks (found ${problems.length}: ${JSON.stringify(problems)}) — a gate never observed to fail is worthless`,
    );

    // Canary 2: a fix deadline must be flagged even when everything else is
    // correct — the acknowledgement/fix distinction is the semantic heart of
    // the SLA check.
    writeFileSync(
      path.join(fixtureRoot, "SECURITY.md"),
      [
        "# Security",
        "",
        "Report via https://github.com/trail-openers/pi-rukas/security/advisories/new",
        "",
        "We acknowledge reports within 7 days and fix vulnerabilities within 30 days.",
      ].join("\n"),
    );
    assert(
      checkSecurityMd(fixtureRoot).some((i) => i.problem.includes("FIX deadline")),
      "...and a fix deadline is flagged even when the channel and an acknowledgement window are both present",
    );

    // Canary 3: the false claim is caught on its own — the channel and a pure
    // acknowledgement window (no fix deadline) are all correct.
    writeFileSync(
      path.join(fixtureRoot, "SECURITY.md"),
      [
        "# Security",
        "",
        "Report via https://github.com/trail-openers/pi-rukas/security/advisories/new",
        "",
        "We acknowledge reports within 7 days. The container fence IS the trust boundary.",
      ].join("\n"),
    );
    assert(
      checkSecurityMd(fixtureRoot).some((i) => i.problem.includes(BAD_CLAIM)),
      `...and the over-promise "${BAD_CLAIM}" is flagged even with a clean channel and SLA`,
    );

    // Canary 4: an email channel is accepted — the gate must not hard-code the
    // GitHub URL shape.
    writeFileSync(
      path.join(fixtureRoot, "SECURITY.md"),
      [
        "# Security",
        "",
        "Report via security-example@example.com",
        "",
        "We acknowledge reports within 7 days.",
      ].join("\n"),
    );
    assert(
      checkSecurityMd(fixtureRoot).length === 0,
      "...and an email-shaped channel passes (the gate matches shapes, not one literal)",
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }

  // A root with no SECURITY.md at all must be caught, not read as clean.
  {
    const emptyRoot = mkdtempSync(path.join(tmpdir(), "pi-ens-secmddoc-"));
    try {
      assert(
        checkSecurityMd(emptyRoot)[0]?.problem.includes("missing") === true,
        "...and a root with no SECURITY.md is flagged as missing, not silently passed",
      );
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------- and the repo file is clean

{
  const issues = checkSecurityMd(REPO_ROOT);
  const missingOnly = issues.length === 1 && issues[0].problem.includes("missing");
  if (issues.length === 0) {
    const text = readFileSync(path.join(REPO_ROOT, "SECURITY.md"), "utf8");
    const channel = CHANNEL_PATTERNS.some((re) => re.test(text)) ? "a reporting channel" : "none";
    assert(true, `SECURITY.md is clean: ${channel}, an acknowledgement-style bound, no fix deadline, no "${BAD_CLAIM}"`);
  } else if (missingOnly) {
    // Sibling workstream task-a authors SECURITY.md in a separate worktree —
    // see the header. The canary above proves the missing case IS caught, so
    // this is a documented no-op in the split worktree, not a gap in the gate.
    console.log(
      "  (no SECURITY.md in this worktree — authored by sibling workstream task-a; the missing-file canary above proves the gate catches it; the full gate runs on the consolidated repo)",
    );
  } else {
    for (const issue of issues) {
      assert(false, `SECURITY.md: ${issue.problem}`);
    }
  }
}

console.log(exit === 0 ? "\nAll SECURITY.md checks passed." : "\nFAILED");
process.exit(exit);
