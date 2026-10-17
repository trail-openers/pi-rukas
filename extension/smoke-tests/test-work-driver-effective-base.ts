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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyDevelopOutcome } from "../src/work-driver-verify-develop.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { isNulDiffRead, isNulStatusRead, nulNameStatus, nulStatus } from "./lib/nul-porcelain.ts";
import { initialState } from "../src/workflow-state.ts";

type StubPi = Pick<ExtensionAPI, "sendUserMessage">;
const stubPi: DriverContext["host"] = { sendUserMessage: () => {} } as StubPi;

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
    host: stubPi,
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
    const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, opts) => {
      const line = commandOf(cmd, opts);
      if (isNulStatusRead(line)) return { stdout: "" }; // clean tree
      if (line.startsWith("git rev-list --count")) return { stdout: "1\n" };
      if (isNulDiffRead(line)) return { stdout: nulNameStatus("src/foo.ts") };
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
    const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, opts) => {
      const line = commandOf(cmd, opts);
      if (isNulStatusRead(line)) return { stdout: nulStatus(" M src/foo.css") };
      if (line.startsWith("git rev-list --count")) return { stdout: "0\n" };
      if (isNulDiffRead(line)) return { stdout: "" };
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
    const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, opts) => {
      const line = commandOf(cmd, opts);
      if (isNulStatusRead(line)) return { stdout: nulStatus(" M src/foo.css") };
      if (line.startsWith("git rev-list --count")) return { stdout: "0\n" };
      if (isNulDiffRead(line)) return { stdout: "" };
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
  //
  // #1378 round 3 — the wording dropped `effective`: the note names the ref it
  // actually compared against, whether or not that ref happens to be the global
  // base. Asserting the sha it resolved is what keeps the note useful.
  {
    const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, opts) => {
      const line = commandOf(cmd, opts);
      if (isNulStatusRead(line)) return { stdout: "" };
      if (line.startsWith("git rev-list --count")) throw new Error("unknown revision");
      if (isNulDiffRead(line)) return { stdout: "" };
      return { stdout: "" };
    };
    const s = makeState({ baseSha: undefined, workstreamBaseShas: { dep: DEPS_BASE } });
    const failures: string[] = [];
    const notes: string[] = [];
    await verifyDevelopOutcome(mkCtx(execFn), s, execFn, failures, notes);
    assert(
      notes.some((n) => n.includes(`rev-list failed against base ${DEPS_BASE} in dep`)),
      `#1378 round 3: a rev-list read that failed is never silent, #1378 round 3 — the note names the effective base it compared against (got: ${notes.join("; ")})`,
    );
  }

  // (5) #1378 round 3 — the same read failing against the GLOBAL baseSha is
  // recorded too. It used to be silenced by an `effBase !== baseSha` guard, so
  // the common case (N=1, effBase === baseSha) left `assessed` true on a
  // worktree whose commits were never counted, and a CSS-only union of the
  // survivors could then skip the verify chain. The note is unconditional now,
  // and the failure counts as a failed git read (which suppresses the
  // frontend-only skip).
  {
    const execFn: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, opts) => {
      const line = commandOf(cmd, opts);
      if (isNulStatusRead(line)) return { stdout: "" };
      if (line.startsWith("git rev-list --count")) throw new Error("unknown revision");
      if (isNulDiffRead(line)) return { stdout: "" };
      return { stdout: "" };
    };
    const s = makeState({ baseSha: VALID_SHA_40 });
    const failures: string[] = [];
    const notes: string[] = [];
    await verifyDevelopOutcome(mkCtx(execFn), s, execFn, failures, notes);
    assert(
      notes.some((n) => n.includes(`rev-list failed against base ${VALID_SHA_40} in dep`)),
      `#1378 round 3: a rev-list read that failed is never silent, #1378 round 3 — the note is present at the global baseSha too (got: ${notes.join("; ")})`,
    );
    // The observable consequence of the flag: the read failure must reach
    // `gitReadFailedAnyWorktree`, the third argument to
    // shouldSkipVerifyForFrontendOnly. Observed end-to-end rather than by
    // poking the helper directly, so the assertion means "the gate set the
    // flag", not "the helper honours its parameter".
    //
    // The control: with the skip ENABLED (globs set + a derived-only command
    // and no .pi/verify-cmd) the very same CSS-only shape SKIPS. So a green
    // `skip suppressed` note here cannot be the classifier saying no — it can
    // only be the failed git read. Without the globs the note reads "not
    // enabled" and proves nothing about the flag.
    const cssOnly: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, opts) => {
      const line = commandOf(cmd, opts);
      if (isNulStatusRead(line)) return { stdout: nulStatus(" M src/ui/hero.css") };
      if (line.startsWith("git rev-list --count")) return { stdout: "1\n" };
      if (isNulDiffRead(line)) return { stdout: nulNameStatus("src/ui/hero.css") };
      return { stdout: "" };
    };
    const prevGlobs = process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS;
    process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = ".css";
    const ctxDir = mkdtempSync(path.join(tmpdir(), "verify-effbase-ctx-"));
    writeFileSync(path.join(ctxDir, "Cargo.toml"), "[package]\nname='x'\n");
    try {
      const mkCtxAt = (exec: NonNullable<DriverContext["verifyExecFn"]>): DriverContext =>
        ({
          host: stubPi,
          issue: 725,
          repoRoot: ctxDir,
          verifyExecFn: exec,
        }) as unknown as DriverContext;
      // (a) control — commits read fine, CSS-only union, skip enabled → skip.
      // Asserting the SKIP fired (not merely that some note exists) is what
      // makes this a control: the positive branch must be reachable, or a green
      // assertion here would say nothing about the flag in (b).
      const controlNotes: string[] = [];
      await verifyDevelopOutcome(
        mkCtxAt(cssOnly),
        makeState({ baseSha: VALID_SHA_40 }),
        cssOnly,
        [],
        controlNotes,
      );
      assert(
        controlNotes.some((n) => /derived verify command skipped/.test(n)),
        `#1378 round 3: control — the same CSS-only shape DOES skip the derived chain when every git read succeeded (notes: ${controlNotes.join("; ")})`,
      );
      // (b) the case under test — the rev-list read throws, the skip is suppressed.
      const failing: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, opts) => {
        if (commandOf(cmd, opts).startsWith("git rev-list --count"))
          throw new Error("unknown revision");
        return cssOnly(cmd, opts);
      };
      const notes2: string[] = [];
      await verifyDevelopOutcome(
        mkCtxAt(failing),
        makeState({ baseSha: VALID_SHA_40 }),
        failing,
        [],
        notes2,
      );
      assert(
        notes2.some((n) => /frontend-only skip suppressed: a git read failed/.test(n)),
        `#1378 round 3: a rev-list read that failed is never silent, #1378 round 3 — the failure counts as a failed git read and suppresses the frontend-only skip (notes: ${notes2.join("; ")})`,
      );
    } finally {
      if (prevGlobs === undefined)
        Reflect.deleteProperty(process.env, "PI_ENSEMBLE_FRONTEND_ONLY_GLOBS");
      else process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = prevGlobs;
      rmSync(ctxDir, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
