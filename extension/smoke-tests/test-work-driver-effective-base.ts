#!/usr/bin/env bun
/**
 * #725 (six-lens round 2, ERROR_HANDLING) — the `changed` decision and the
 * "uncommitted but no commit" diagnostic must derive from the SAME ref the
 * diff block tested: the workstream's EFFECTIVE base
 * (`workstreamBaseShas[id]`, falling back to the global `baseSha`), never the
 * global baseSha alone.
 *
 * The bug: for a dependent workstream with a valid `workstreamBaseShas` entry
 * but an ABSENT/invalid global `baseSha`, the diff block ran (it tests
 * `isValidSha(effBase)`) while the `changed` computation and the diagnostic
 * tested `isValidSha(baseSha)` — the guards disagreed. A worktree with genuine
 * commits was not counted as changed, and the diagnostic cited baseSha when
 * the ref actually tested was the effective base.
 *
 * These cases pin the coherent behaviour.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyDevelopOutcome } from "../src/work-driver-verify-develop.ts";
import { initialState } from "../src/workflow-state.ts";

type StubPi = Pick<ExtensionAPI, "sendUserMessage">;
const stubPi: DriverContext["pi"] = { sendUserMessage: () => {} } as StubPi;

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const VALID_SHA_40 = "a".repeat(40); // a valid [0-9a-f]{40}
const DEPS_BASE = "b".repeat(40); // the dependency's post-commit SHA (valid)

const tmpDir = mkdtempSync(path.join(tmpdir(), "verify-effbase-"));

function makeState(overrides: {
  baseSha?: string;
  workstreamBaseShas?: Record<string, string>;
}) {
  let s = initialState(725, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      worktrees: { dep: tmpDir },
      baseSha: overrides.baseSha,
      workstreamBaseShas: overrides.workstreamBaseShas,
      workstreams: {
        dep: { id: "dep", scope: "dependent work", paths: ["src/foo.ts"], outOfScope: [] },
      },
    },
  };
  return s;
}

const mkCtx = (execFn: NonNullable<DriverContext["verifyExecFn"]>): DriverContext =>
  ({
    pi: stubPi,
    issue: 725,
    repoRoot: tmpDir,
    verifyExecFn: execFn,
  }) as unknown as DriverContext;

try {
  // (1) Dependent with a valid workstreamBaseShas entry and an ABSENT global
  // baseSha: the worktree has genuine commits ahead of the effective base.
  // Pre-fix, `changed` tested the absent baseSha → false, so the worktree was
  // silently dropped (and the generic empty-diff failure fired instead).
  // Post-fix, the committed work counts.
  {
    const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
      if (cmd === "git status --porcelain") return { stdout: "" }; // clean tree
      if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" };
      if (cmd.startsWith("git diff --name-only")) return { stdout: "src/foo.ts\n" };
      return { stdout: "" };
    };
    const s = makeState({ baseSha: undefined, workstreamBaseShas: { dep: DEPS_BASE } });
    const failures: string[] = [];
    const notes: string[] = [];
    await verifyDevelopOutcome(mkCtx(execFn), s, execFn, failures, notes);
    assert(
      failures.length === 0,
      `#725 effBase: dependent with valid workstreamBaseShas + absent global baseSha, committed work → no failures (got: ${failures.join("; ")})`,
    );
    assert(
      !failures.some((f) => /empty diff/.test(f)),
      `#725 effBase: the genuine commit is counted as changed (no spurious empty-diff) (got: ${failures.join("; ")})`,
    );
  }

  // (2) Same shape but the work is left UNCOMMITTED: the diff block ran
  // against the effective base, so the diagnostic must name THAT ref — not
  // the absent global baseSha the pre-fix guard tested.
  {
    const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
      if (cmd === "git status --porcelain") return { stdout: " M src/foo.ts\n" };
      if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
      if (cmd.startsWith("git diff --name-only")) return { stdout: "" };
      return { stdout: "" };
    };
    const s = makeState({ baseSha: undefined, workstreamBaseShas: { dep: DEPS_BASE } });
    const failures: string[] = [];
    const notes: string[] = [];
    await verifyDevelopOutcome(mkCtx(execFn), s, execFn, failures, notes);
    const diag = failures.find((f) => /uncommitted changes but no commit/.test(f));
    assert(
      diag !== undefined,
      `#725 effBase: uncommitted work with a valid effective base still fails (got: ${failures.join("; ")})`,
    );
    assert(
      diag !== undefined && diag.includes(DEPS_BASE),
      `#725 effBase: the diagnostic names the effective base it actually compared against (got: ${diag})`,
    );
  }

  // (3) Dependent whose valid global baseSha EQUALS the effective base: the
  // pre-existing #453/#621 message is unchanged (no spurious SHA leak into a
  // message that pins wording).
  {
    const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
      if (cmd === "git status --porcelain") return { stdout: " M src/foo.ts\n" };
      if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
      if (cmd.startsWith("git diff --name-only")) return { stdout: "" };
      return { stdout: "" };
    };
    const s = makeState({ baseSha: VALID_SHA_40, workstreamBaseShas: { dep: VALID_SHA_40 } });
    const failures: string[] = [];
    const notes: string[] = [];
    await verifyDevelopOutcome(mkCtx(execFn), s, execFn, failures, notes);
    const diag = failures.find((f) => /uncommitted changes but no commit/.test(f));
    assert(
      diag !== undefined &&
        diag.includes("no commit ahead of base " + VALID_SHA_40) &&
        diag.includes("git add -A && git commit"),
      `#725 effBase: the committed-work-required message stays actionable when the effective base is the global baseSha (got: ${diag})`,
    );
  }

  // (4) The rev-list catch must NOT silently absorb a failed measurement when
  // it resolved a non-global effective base: a note naming the ref lands in
  // `notes` (the #384 silent-degradation class, made diagnosable).
  {
    const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
      if (cmd === "git status --porcelain") return { stdout: "" };
      if (cmd.startsWith("git rev-list --count")) throw new Error("unknown revision");
      if (cmd.startsWith("git diff --name-only")) return { stdout: "" };
      return { stdout: "" };
    };
    const s = makeState({ baseSha: undefined, workstreamBaseShas: { dep: DEPS_BASE } });
    const failures: string[] = [];
    const notes: string[] = [];
    await verifyDevelopOutcome(mkCtx(execFn), s, execFn, failures, notes);
    assert(
      notes.some((n) => n.includes(`rev-list failed against effective base ${DEPS_BASE}`)),
      `#725 effBase: a rev-list failure against a non-global effective base is recorded in notes (got: ${notes.join("; ")})`,
    );
  }

  // (5) The rev-list catch stays silent for the global baseSha (pre-existing
  // behaviour: an absent global base in the worktree's history is not
  // evidence either way — no note spam).
  {
    const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
      if (cmd === "git status --porcelain") return { stdout: "" };
      if (cmd.startsWith("git rev-list --count")) throw new Error("unknown revision");
      if (cmd.startsWith("git diff --name-only")) return { stdout: "" };
      return { stdout: "" };
    };
    const s = makeState({ baseSha: VALID_SHA_40 });
    const failures: string[] = [];
    const notes: string[] = [];
    await verifyDevelopOutcome(mkCtx(execFn), s, execFn, failures, notes);
    assert(
      !notes.some((n) => /rev-list failed against effective base/.test(n)),
      `#725 effBase: a rev-list failure against the GLOBAL baseSha stays silent (unchanged) (got: ${notes.join("; ")})`,
    );
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
