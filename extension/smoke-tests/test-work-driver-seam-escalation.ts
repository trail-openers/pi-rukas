#!/usr/bin/env bun
/**
 * Smoke test for issue #280 §B — round-1 seam escalation routing.
 *
 * End-to-end: round-1 seam detection routes to step-back.
 * Round ≥2 does NOT re-escalate. Env kill-switch restores previous behaviour.
 * Pure-fn fixtures live in test-repeat-seam.ts.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { initialState, readState, writeState } from "../src/workflow-state.ts";
import { mkLensSummary, setupSpawnGuard } from "./test-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Minimal ExtensionAPI stub.
function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

const mockIssueBodyOk = async (issue: number, _cwd: string) => ({
  stdout: `title:\tmock issue #${issue}\nstate:\tOPEN\n\nmock body for issue #${issue}`,
});

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

setupSpawnGuard();

// ─── §B — Round-1 seam escalation routes to step-back ───────────────────────

{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-seam-escalation-r1-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    const origin = path.join(dir, "origin.git");
    await execp("git init -q --bare --initial-branch=main origin.git", { cwd: dir });
    const root = path.join(dir, "root");
    await execp("git init -q --initial-branch=main root", { cwd: dir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: root,
      shell: "/bin/bash",
    });
    writeFileSync(path.join(dir, "root", ".git", "info", "exclude"), "\n.pi/\n");
    await fs.writeFile(path.join(root, "base.txt"), "hello\n");
    await execp("git add base.txt && git commit -q -m initial", { cwd: root, shell: "/bin/bash" });
    await execp(`git remote add origin ${JSON.stringify(origin)}`, { cwd: root });
    await execp("git push -q -u origin main", { cwd: root });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: root,
    });
    await execp("git checkout -qb feature/seam-escalation", { cwd: root });
    await fs.writeFile(path.join(root, "feature1.txt"), "code\n");
    await execp("git add feature1.txt && git commit -q -m 'feature'", {
      cwd: root,
      shell: "/bin/bash",
    });
    await execp("git push -q -u origin feature/seam-escalation", { cwd: root });

    const s = initialState(280, 1_000_000);
    const seamFindings = [
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "src/auth/token.ts",
        title: "Missing null check in src/auth/token.ts",
        description: "None",
        suggestion: "Handle null",
      },
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "src/api/user.ts",
        title: "Missing null check in src/api/user.ts",
        description: "None",
        suggestion: "Handle null",
      },
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "src/workers/email.ts",
        title: "Missing null check in src/workers/email.ts",
        description: "None",
        suggestion: "Handle null",
      },
    ];
    const state = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-review",
        worktrees: { default: root },
        workstreams: {
          default: { id: "default", scope: "test", paths: ["src/auth/token.ts"], outOfScope: [] },
        },
        branchName: "feature/seam-escalation",
        prNumber: 2800,
        reviewRound: 0,
      },
      eventLog: [],
    };
    await writeState(root, state);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: root,
      issue: 280,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "explore:step-back") {
          return mkResult({
            role: "explore",
            ok: true,
            text:
              "sddElement: scope boundaries\n" +
              "diagnosis: the spec does not require defensive null checks across modules\n" +
              "proposedRevision: add explicit null-handling requirements",
          });
        }
        if (opts?.label === "ops:handoff") {
          return mkResult({ role: "ops", text: "Posted." });
        }
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
      adversarialLoopFn: async () => {
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          loopOutcome: "approved",
          text: "Adversarial APPROVED.",
        });
      },
      lensReviewFn: async () => {
        return mkLensSummary({
          verdict: "ISSUES_FOUND",
          findings: seamFindings,
          totalFindings: 3,
        });
      },
    };

    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(root, 280);
    assert(after !== null, "state file survived");

    const stepBackTriggered = after?.eventLog.find((e) => e.kind === "step-back-triggered");
    assert(stepBackTriggered !== undefined, "step-back-triggered event present");
    if (stepBackTriggered) {
      assert(
        (stepBackTriggered as { theme: string }).theme.includes("SIMPLICITY"),
        `  theme names the lens+pattern (got: ${(stepBackTriggered as { theme: string }).theme})`,
      );
    }

    const capHit = after?.eventLog.find(
      (e) => e.kind === "cap-hit" && e.cap === "repeat-finding-seam",
    );
    assert(capHit !== undefined, "cap-hit with cap='repeat-finding-seam' present");
    if (capHit && capHit.kind === "cap-hit") {
      assert(
        capHit.nextStep === "step-back",
        `cap-hit nextStep is "step-back" (got: ${capHit.nextStep})`,
      );
    }

    const dispatchStarted = after?.eventLog.find(
      (e) => e.kind === "dispatch-started" && e.step === "step-back",
    );
    assert(
      dispatchStarted !== undefined,
      "step-back dispatch was emitted (explore @explore dispatch fired)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── §B — Round ≥2 does NOT re-escalate ─────────────────────────────────────

{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-seam-escalation-r2-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    const origin = path.join(dir, "origin.git");
    await execp("git init -q --bare --initial-branch=main origin.git", { cwd: dir });
    const root = path.join(dir, "root");
    await execp("git init -q --initial-branch=main root", { cwd: dir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: root,
      shell: "/bin/bash",
    });
    writeFileSync(path.join(dir, "root", ".git", "info", "exclude"), "\n.pi/\n");
    await fs.writeFile(path.join(root, "base.txt"), "hello\n");
    await execp("git add base.txt && git commit -q -m initial", { cwd: root, shell: "/bin/bash" });
    await execp(`git remote add origin ${JSON.stringify(origin)}`, { cwd: root });
    await execp("git push -q -u origin main", { cwd: root });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: root,
    });
    await execp("git checkout -qb feature/seam-r2", { cwd: root });
    await fs.writeFile(path.join(root, "feature.txt"), "code\n");
    await execp("git add feature.txt && git commit -q -m 'feature'", {
      cwd: root,
      shell: "/bin/bash",
    });
    await execp("git push -q -u origin feature/seam-r2", { cwd: root });

    const s = initialState(281, 1_000_000);
    const seamFindings = [
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "src/auth/token.ts",
        title: "Missing null check in src/auth/token.ts",
        description: "None",
        suggestion: "Handle null",
      },
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "src/api/user.ts",
        title: "Missing null check in src/api/user.ts",
        description: "None",
        suggestion: "Handle null",
      },
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "src/workers/email.ts",
        title: "Missing null check in src/workers/email.ts",
        description: "None",
        suggestion: "Handle null",
      },
    ];
    const state = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-review",
        worktrees: { default: root },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/seam-r2",
        prNumber: 2810,
        reviewRound: 1,
      },
      eventLog: [],
    };
    await writeState(root, state);

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: root,
      issue: 281,
      issueBodyFetcherFn: mockIssueBodyOk,
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label?.startsWith("developer:lens-fix")) {
          return mkResult({ role: "developer", ok: true, text: "Fixed one finding." });
        }
        if (opts?.label === "ops:handoff") {
          return mkResult({ role: "ops", text: "Posted." });
        }
        throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
      },
      adversarialLoopFn: async () => {
        return mkResult({
          role: "adversarial-loop",
          ok: true,
          loopOutcome: "approved",
          text: "Adversarial APPROVED.",
        });
      },
      lensReviewFn: async () => {
        return mkLensSummary({
          verdict: "ISSUES_FOUND",
          findings: seamFindings,
          totalFindings: 3,
        });
      },
    };

    await runWorkDriver(ctx).catch(() => {});

    const after = await readState(root, 281);
    assert(after !== null, "state file survived round 2 test");

    const stepBackTriggered = after?.eventLog.find((e) => e.kind === "step-back-triggered");
    assert(
      stepBackTriggered === undefined,
      "round 2 with same cluster does NOT re-escalate (no step-back-triggered)",
    );

    const capHit = after?.eventLog.find(
      (e) => e.kind === "cap-hit" && e.cap === "repeat-finding-seam",
    );
    assert(capHit === undefined, "round 2 does not emit repeat-finding-seam cap-hit");

    const dispatchStarted = after?.eventLog.find(
      (e) => e.kind === "dispatch-started" && e.step === "lens-fix",
    );
    assert(dispatchStarted !== undefined, "round 2 routes to lens-fix (normal fix loop)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── Env kill-switch: SEAM_ESCALATION=0 restores previous behaviour ─────────

{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-seam-killswitch-"));
  try {
    const fs = await import("node:fs/promises");
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);

    const origin = path.join(dir, "origin.git");
    await execp("git init -q --bare --initial-branch=main origin.git", { cwd: dir });
    const root = path.join(dir, "root");
    await execp("git init -q --initial-branch=main root", { cwd: dir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: root,
      shell: "/bin/bash",
    });
    writeFileSync(path.join(dir, "root", ".git", "info", "exclude"), "\n.pi/\n");
    await fs.writeFile(path.join(root, "base.txt"), "hello\n");
    await execp("git add base.txt && git commit -q -m initial", { cwd: root, shell: "/bin/bash" });
    await execp(`git remote add origin ${JSON.stringify(origin)}`, { cwd: root });
    await execp("git push -q -u origin main", { cwd: root });
    await execp("git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main", {
      cwd: root,
    });
    await execp("git checkout -qb feature/killswitch", { cwd: root });
    await fs.writeFile(path.join(root, "feature.txt"), "code\n");
    await execp("git add feature.txt && git commit -q -m 'feature'", {
      cwd: root,
      shell: "/bin/bash",
    });
    await execp("git push -q -u origin feature/killswitch", { cwd: root });

    const s = initialState(282, 1_000_000);
    const seamFindings = [
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "src/auth/token.ts",
        title: "Missing null check in src/auth/token.ts",
        description: "None",
        suggestion: "Handle null",
      },
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "src/api/user.ts",
        title: "Missing null check in src/api/user.ts",
        description: "None",
        suggestion: "Handle null",
      },
      {
        lens: "SIMPLICITY",
        severity: "MEDIUM",
        path: "src/workers/email.ts",
        title: "Missing null check in src/workers/email.ts",
        description: "None",
        suggestion: "Handle null",
      },
    ];
    const state = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "lens-review",
        worktrees: { default: root },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/killswitch",
        prNumber: 2820,
        reviewRound: 0,
      },
      eventLog: [],
    };
    await writeState(root, state);

    const origEnv = process.env.PI_ENSEMBLE_SEAM_ESCALATION;
    process.env.PI_ENSEMBLE_SEAM_ESCALATION = "0";
    try {
      const ctx: DriverContext = {
        pi: makeFakePi().pi,
        repoRoot: root,
        issue: 282,
        issueBodyFetcherFn: mockIssueBodyOk,
        dispatchFn: async (_pi, spec, opts) => {
          if (opts?.label?.startsWith("developer:lens-fix")) {
            return mkResult({ role: "developer", ok: true, text: "Fixed." });
          }
          if (opts?.label === "ops:handoff") {
            return mkResult({ role: "ops", text: "Posted." });
          }
          throw new Error(`unexpected dispatch: ${spec.role} / ${opts?.label}`);
        },
        adversarialLoopFn: async () => {
          return mkResult({
            role: "adversarial-loop",
            ok: true,
            loopOutcome: "approved",
            text: "Adversarial APPROVED.",
          });
        },
        lensReviewFn: async () => {
          return mkLensSummary({
            verdict: "ISSUES_FOUND",
            findings: seamFindings,
            totalFindings: 3,
          });
        },
      };

      await runWorkDriver(ctx).catch(() => {});

      const after = await readState(root, 282);
      assert(after !== null, "state file survived kill-switch test");

      const stepBackTriggered = after?.eventLog.find((e) => e.kind === "step-back-triggered");
      const seamCap = after?.eventLog.find(
        (e) => e.kind === "cap-hit" && e.cap === "repeat-finding-seam",
      );
      assert(stepBackTriggered === undefined, "SEAM_ESCALATION=0 — no step-back-triggered");
      assert(seamCap === undefined, "SEAM_ESCALATION=0 — no repeat-finding-seam cap");
    } finally {
      process.env.PI_ENSEMBLE_SEAM_ESCALATION = origEnv ?? "";
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
