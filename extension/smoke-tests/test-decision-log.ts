#!/usr/bin/env bun
/**
 * The decision log and the evidence check's path confinement (#1308).
 *
 *   - one JSONL record per decide() call, at the operator-chosen location:
 *     `.pi/work-state/<lowest issue>/decisions.jsonl` inside a cycle,
 *     `.pi/decisions.jsonl` otherwise, always under the main checkout;
 *   - secrets are redacted with the vipune.ts patterns and counted;
 *   - a failed append never changes the decision;
 *   - a cited file is read only inside the repo root, after realpath, bounded.
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_EVIDENCE_FILE_BYTES, verifyEvidence } from "../src/decision-evidence.ts";
import { REDACTED, decisionLogPath, redactSecrets } from "../src/decision-log.ts";
import { decide } from "../src/decision-seam.ts";
import { looksLikeSecret } from "../src/vipune.ts";
import {
  envKey,
  fixtureSpec,
  makeAssert,
  registerFixture,
  stubBackend,
  tmpDir,
} from "./lib/decision-fixtures.ts";

const { assert, state } = makeAssert();
const seam = registerFixture(
  fixtureSpec({ id: "fixture-log", composition: "may-add-only", ruleDefault: "ok" }),
);
process.env[envKey("PI_ENSEMBLE_DECISION_MODE", "fixture-log")] = "enforce";
const lines = (f: string) =>
  existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : [];

// ---------------------------------------------- one record per call, located

{
  const root = tmpDir("log");
  const b = stubBackend({
    ok: true,
    answer: "flag",
    usage: { input: 3, output: 2, totalTokens: 5 },
  });
  for (let i = 0; i < 3; i++) {
    await decide(
      seam,
      { state: { i }, question: "q", rule: "ok" },
      { repoRoot: root, backends: [b] },
    );
  }
  const global = path.join(root, ".pi", "decisions.jsonl");
  assert(
    lines(global).length === 3,
    "three decide() calls outside a cycle → three records in .pi/decisions.jsonl",
  );
  const rec = JSON.parse(lines(global)[0] ?? "{}");
  for (const k of [
    "seam",
    "stateHash",
    "state",
    "ruleAnswer",
    "backends",
    "final",
    "compositionResult",
    "redactions",
  ]) {
    assert(k in rec, `the record carries '${k}'`);
  }
  assert(
    rec.backends[0].answer === "flag" &&
      rec.backends[0].usage.totalTokens === 5 &&
      typeof rec.backends[0].latencyMs === "number",
    "...each backend tried with its answer, usage and latency",
  );
  assert(
    rec.final.answer === "flag" && rec.final.source === "llm",
    "...and the final answer with its source",
  );

  await decide(
    seam,
    { state: {}, question: "q", rule: "ok" },
    { repoRoot: root, issues: [12, 7, 30], backends: [b] },
  );
  const cycle = path.join(root, ".pi", "work-state", "7", "decisions.jsonl");
  assert(
    lines(cycle).length === 1,
    "inside a grouped cycle → .pi/work-state/<lowest issue>/decisions.jsonl",
  );
  assert(lines(global).length === 3, "...and nothing extra in the global log");

  process.env.PI_ENSEMBLE_DECISIONS = "0";
  await decide(seam, { state: {}, question: "q", rule: "ok" }, { repoRoot: root, backends: [b] });
  delete process.env.PI_ENSEMBLE_DECISIONS;
  assert(lines(global).length === 4, "a rule-only (kill-switched) call still writes its record");
  const failed = stubBackend({ ok: false, error: "provider 500" });
  await decide(
    seam,
    { state: {}, question: "q", rule: "ok" },
    { repoRoot: root, backends: [failed] },
  );
  const last = JSON.parse(lines(global).at(-1) ?? "{}");
  assert(
    last.backends[0].error === "provider 500" && last.final.abstained === true,
    "a backend error is logged with the abstention",
  );
}

// ---------------------------------------------- the main checkout, not a worktree

{
  const main = tmpDir("main");
  mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
  const wt = path.join(main, ".worktrees", "wt");
  mkdirSync(wt, { recursive: true });
  writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
  assert(
    decisionLogPath(wt, [5]) === path.join(main, ".pi", "work-state", "5", "decisions.jsonl"),
    "a linked worktree's root maps to the main checkout's log",
  );
}

// ---------------------------------------------- redaction

{
  const root = tmpDir("redact");
  const secret = `ghp_${"A1b2C3d4".repeat(4)}`;
  const b = stubBackend({ ok: false, error: `auth failed for token=${"z9".repeat(10)}` });
  await decide(
    seam,
    { state: { env: `GITHUB_TOKEN ${secret}` }, question: "q", rule: "ok" },
    { repoRoot: root, backends: [b] },
  );
  const raw = readFileSync(path.join(root, ".pi", "decisions.jsonl"), "utf8");
  assert(
    !raw.includes(secret) && raw.includes(REDACTED),
    "a secret in the state is replaced by the marker in the log",
  );
  assert(!looksLikeSecret(raw), "...no span in the record still looks like a secret");
  assert((JSON.parse(raw).redactions ?? 0) >= 2, "...and the record counts its redactions");
  const r = redactSecrets(`a ${secret} b sk-ant-api03-${"x".repeat(20)} c`);
  assert(
    r.count === 2 && !r.text.includes("ghp_"),
    "redactSecrets replaces every match, not just the first",
  );
}

// ---------------------------------------------- a failed append changes nothing

{
  const notADir = path.join(tmpDir("file"), "plain-file");
  writeFileSync(notADir, "x");
  const b = stubBackend({ ok: true, answer: "flag" });
  const d = await decide(
    seam,
    { state: {}, question: "q", rule: "ok" },
    { repoRoot: notADir, backends: [b] },
  );
  assert(d.answer === "flag", "an unwritable log location leaves the decision unchanged");
}

// ---------------------------------------------- a symlinked .pi cannot carry the log out

{
  const root = tmpDir("symlog");
  const elsewhere = tmpDir("elsewhere");
  symlinkSync(elsewhere, path.join(root, ".pi"));
  const b = stubBackend({ ok: true, answer: "flag" });
  const d = await decide(
    seam,
    { state: {}, question: "q", rule: "ok" },
    { repoRoot: root, backends: [b] },
  );
  assert(
    d.answer === "flag",
    "a log directory escaping the repo root leaves the decision unchanged",
  );
  assert(
    !existsSync(path.join(elsewhere, "decisions.jsonl")),
    "...and nothing is written outside the root",
  );
  const d2 = await decide(
    seam,
    { state: {}, question: "q", rule: "ok" },
    { repoRoot: root, issues: [9], backends: [b] },
  );
  assert(
    d2.answer === "flag" && !existsSync(path.join(elsewhere, "work-state")),
    "...not even the cycle's directories are created through the symlink",
  );
}

// ---------------------------------------------- evidence path confinement

{
  const root = tmpDir("ev");
  const outside = tmpDir("outside");
  const Q = "Agents may merge once CI is green and review approved.";
  writeFileSync(path.join(root, "POLICY.md"), `# Policy\n\n${Q}\n`);
  writeFileSync(path.join(outside, "evil.md"), `${Q}\n`);
  symlinkSync(path.join(outside, "evil.md"), path.join(root, "link.md"));
  writeFileSync(path.join(root, "huge.md"), `${Q}\n${"x".repeat(MAX_EVIDENCE_FILE_BYTES)}`);
  const check = { repoRoot: root, texts: [] };
  const ok = async (cited: string) => (await verifyEvidence(check, Q, cited)).passed;
  assert(await ok("POLICY.md"), "a quote in a file inside the repo root verifies");
  assert(!(await ok(path.join(outside, "evil.md"))), "an absolute path outside the root does not");
  assert(!(await ok(`../${path.basename(outside)}/evil.md`)), "a ../ traversal does not");
  assert(!(await ok("link.md")), "a symlink that escapes the root does not (realpath)");
  assert(!(await ok("huge.md")), "a file over the size bound is not read");
  assert(!(await ok("missing.md")), "a missing file does not");
  assert(
    !(await verifyEvidence({ texts: [] }, Q, "POLICY.md")).passed,
    "with no repo root, a cited file is never read",
  );
  assert(!(await verifyEvidence(undefined, Q, undefined)).passed, "no evidence check → no pass");
  const vouched = { texts: [{ name: "AGENTS.md", text: Q }] };
  assert(
    (await verifyEvidence(vouched, Q, undefined)).passed,
    "an uncited quote verifies against a text the caller vouched for",
  );
  assert(
    !(await verifyEvidence({}, Q, undefined)).passed,
    "...but never against the raw state: a quote of injected state text cannot justify a replace",
  );
  assert(
    !(await verifyEvidence(vouched, "short", undefined)).passed,
    "a trivially short quote is not evidence",
  );
}

console.log(`\nexit ${state.exit}`);
process.exit(state.exit);
