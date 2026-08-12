#!/usr/bin/env bun
/**
 * Smoke test for the /work driver, split out of test-work-driver.ts
 * (#171, AGENTS.md §12 file-size limit).
 *
 * Covers: sections 54-57: PR13 inline issue body in explore prompt, multi-issue inlining, 16KiB truncation, empty-body halt ordering.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { readState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Minimal ExtensionAPI stub — only the methods runWorkDriver actually calls.
function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

// Fake DispatchResult builder.
function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub explore output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

// #297 — transient retries are exercised by dedicated tests below; zero the
// inter-attempt backoff so persistent-failure tests don't sleep 5-10s per
// retry.
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";

// Offline-suite safety net: a few flow tests deliberately reach the
// adversarial / lens steps without injecting a loopFn. Cap any such
// accidental live spawn at 2s so the suite stays deterministic and fast.
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";

// PR17 — the outcome-verification gate is disabled globally here; dedicated
// gate tests re-enable it with an injected verifyExecFn.
process.env.PI_ENSEMBLE_VERIFY = "0";

// 54. PR13 — runExplore embeds the fetched issue body inline in the
// explore dispatch prompt. Empirical v0.12.12 incident (/work 563 565)
// halted on false NEEDS_CLARIFICATION because the agent's verdict
// committed BEFORE the parallel gh fetch settled and the prompt never
// referenced the body. After PR13, the body is in the prompt — agent
// reads it directly.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-explore-inline-body-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let capturedPrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 940,
      // PR13 — fetcher returns a body with a unique marker we can scan
      // for in the captured prompt.
      issueBodyFetcherFn: async (n, _cwd) => ({
        stdout: `title:\tBug in foo\nstate:\tOPEN\n\nMARKER_BODY_47x9 — body for issue #${n}\n\n## Acceptance criteria\n- thing X works`,
      }),
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "explore") {
          capturedPrompt = spec.prompt;
          // Halt the cycle after the explore dispatch so the test runs
          // fast — we only need to assert the prompt content.
          return mkResult({
            role: "explore",
            text: "VERDICT: NEEDS_WORK\n\n## Workstreams\n\n### default — fix it\n- paths: src/foo.ts\n- out-of-scope: docs",
          });
        }
        // Halt before plan executes for free.
        throw new Error(`halt-at: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    assert(
      capturedPrompt.includes("MARKER_BODY_47x9"),
      "PR13 §A: explore prompt contains the inlined body marker (no body race)",
    );
    assert(
      /### Issue #940/.test(capturedPrompt),
      "PR13 §B: explore prompt has 'Issue #940' body section header",
    );
    assert(
      capturedPrompt.includes("## Acceptance criteria"),
      "PR13 §A: explore prompt contains the full body content (acceptance criteria included)",
    );
    assert(
      /driver has fetched and embedded each issue body below/i.test(capturedPrompt),
      "PR13 §B: explore prompt instruction tells agent to read the embedded bodies",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 55. PR13 — multi-issue cycle inlines all bodies with per-issue headers.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-explore-multi-bodies-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let capturedPrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 950,
      issues: [950, 951, 952],
      issueBodyFetcherFn: async (n, _cwd) => ({
        stdout: `title:\tIssue ${n}\nstate:\tOPEN\n\nBODY_FOR_${n} — specific marker so the test can find this body in the prompt.`,
      }),
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "explore") {
          capturedPrompt = spec.prompt;
          return mkResult({
            role: "explore",
            text: `## Verdict
- #950: NEEDS_WORK
- #951: NEEDS_WORK
- #952: NEEDS_WORK

## Workstreams

### default — fix all 3
- paths: src/foo.ts
- out-of-scope: docs
`,
          });
        }
        throw new Error(`halt-at: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    for (const n of [950, 951, 952]) {
      assert(
        capturedPrompt.includes(`BODY_FOR_${n}`),
        `PR13 §B: explore prompt contains body marker for #${n}`,
      );
      assert(
        new RegExp(`### Issue #${n}`).test(capturedPrompt),
        `PR13 §B: explore prompt has per-issue header for #${n}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 56. PR13 — body > 16 KiB is truncated inline + truncation marker
// references the cached artifact (so the agent can cat for the rest).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-explore-truncated-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    const hugeBody = "A".repeat(17 * 1024); // 17 KiB > 16 KiB cap
    let capturedPrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 960,
      issueBodyFetcherFn: async (_n, _cwd) => ({ stdout: hugeBody }),
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "explore") {
          capturedPrompt = spec.prompt;
          return mkResult({
            role: "explore",
            text: "VERDICT: NEEDS_WORK\n## Workstreams\n### default — x\n- paths: x\n- out-of-scope: y",
          });
        }
        throw new Error(`halt-at: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx).catch(() => {});
    assert(
      /truncated/i.test(capturedPrompt),
      "PR13 §B: large body prompt includes truncation marker",
    );
    // The prompt should NOT contain the full 17 KiB body — confirm by
    // counting 'A' characters. Inline cap is 16 KiB so we expect ≤ 16384.
    const aCount = (capturedPrompt.match(/A/g) ?? []).length;
    assert(
      aCount <= 16 * 1024 + 50,
      `PR13 §B: inline body capped at ~16 KiB (got ${aCount} 'A' chars in prompt)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 57. PR13 — empty-body halt fires BEFORE the explore dispatch. Pre-PR13
// the halt fired after the dispatch (wasted tokens on a doomed cycle).
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-explore-halt-before-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let exploreDispatched = false;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 970,
      issueBodyFetcherFn: async (_n, _cwd) => ({ stdout: "" }), // all empty
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "explore") exploreDispatched = true;
        if (opts?.label === "ops:handoff") return mkResult({ role: "ops", text: "Posted." });
        return mkResult({ role: spec.role, text: "stub" });
      },
    };
    await runWorkDriver(ctx);
    assert(
      exploreDispatched === false,
      "PR13 §A: explore dispatch is NOT called when bodies are empty (halt fires above dispatch)",
    );
    const after = await readState(dir, 970);
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "explore-bodies-empty",
      "PR13 §A: cap-hit 'explore-bodies-empty' synthesised before any explore tokens consumed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
