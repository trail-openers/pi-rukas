#!/usr/bin/env bun
/**
 * #1005 — the plan-time coupling merge. Two workstreams are coupled when
 * their file lists overlap (Jaccard ≥ 0.5), when one declares `depends-on`
 * the other, or when a symbol defined in one's files is referenced in the
 * other's (rule 3 — the argv-form grep). Coupled workstreams are merged
 * (the shared fold in workstream-fold.ts: union of paths, outOfScope union
 * minus the merged paths, scope annotated, dependsOn re-pointed). Genuinely
 * separate workstreams (no shared files or symbols) are NOT merged.
 */

import {
  type CouplingWorkstream,
  mergeCoupledWorkstreams,
} from "../src/work-driver-plan-coupling.ts";
import { foldTwo } from "../src/workstream-fold.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// The `ws` helper builds a workstreams map. The `id` and `scope` fields are
// fixed (set before the spread); a partial entry CANNOT override `id` (the
// LOW finding: the pre-#1005 helper spread `...v` last, so a partial could
// override `id` and produce a map whose key did not match its value's id).
const ws = (e: Record<string, Partial<CouplingWorkstream>>): Record<string, CouplingWorkstream> =>
  Object.fromEntries(
    Object.entries(e).map(([id, v]) => [
      id,
      {
        id,
        scope: v.scope ?? id,
        paths: v.paths ?? [],
        outOfScope: v.outOfScope ?? [],
        ...(v.dependsOn ? { dependsOn: v.dependsOn } : {}),
        ...(v.integrationTest ? { integrationTest: v.integrationTest } : {}),
      },
    ]),
  );

// ── Rule 1: file overlap (Jaccard ≥ 0.5) ──────────────────────────────
{
  const result = await mergeCoupledWorkstreams(
    ws({
      a: { paths: ["src/a.ts", "src/b.ts"], outOfScope: ["src/c.ts"] },
      b: { paths: ["src/b.ts", "src/c.ts"], outOfScope: ["src/a.ts"] },
    }),
  );
  // a and b share src/b.ts; jaccard = 1/3 = 0.33 < 0.5 → NOT merged by rule 1.
  // But they also share no depends-on. So no merge.
  assert(result.changed === false, "rule 1: jaccard 1/3 < 0.5 → not merged");
  assert(Object.keys(result.workstreams).length === 2, "rule 1: both workstreams remain");
}

{
  // Higher overlap: a = {a,b,c}, b = {b,c,d} → inter=2, union=4, j=0.5 → merged
  const result = await mergeCoupledWorkstreams(
    ws({
      a: { paths: ["src/a.ts", "src/b.ts", "src/c.ts"], outOfScope: [] },
      b: { paths: ["src/b.ts", "src/c.ts", "src/d.ts"], outOfScope: [] },
    }),
  );
  assert(result.changed === true, "rule 1: jaccard 0.5 → merged");
  assert(Object.keys(result.workstreams).length === 1, "rule 1: only one workstream remains");
  const merged = Object.values(result.workstreams)[0];
  assert(merged?.paths.length === 4, "rule 1: merged paths = union of both (4 files)");
  assert(merged?.scope.includes("+merged: b"), "rule 1: scope annotated with absorbed id");
}

{
  // Identical file sets → jaccard 1.0 → merged
  const result = await mergeCoupledWorkstreams(
    ws({
      a: { paths: ["src/x.ts", "src/y.ts"], outOfScope: [] },
      b: { paths: ["src/x.ts", "src/y.ts"], outOfScope: [] },
    }),
  );
  assert(result.changed === true, "rule 1: identical file sets → merged");
  assert(Object.keys(result.workstreams).length === 1, "rule 1: one workstream after merge");
}

// ── Rule 2: explicit depends-on ─────────────────────────────────────────
{
  const result = await mergeCoupledWorkstreams(
    ws({
      a: { paths: ["src/a.ts"], outOfScope: [] },
      b: { paths: ["src/b.ts"], dependsOn: ["a"], outOfScope: [] },
    }),
  );
  assert(result.changed === true, "rule 2: depends-on → merged");
  assert(Object.keys(result.workstreams).length === 1, "rule 2: one workstream after merge");
  const merged = Object.values(result.workstreams)[0];
  assert(merged?.paths.length === 2, "rule 2: merged paths = union");
  // The merged workstream's dependsOn should be empty (a depends on a → self-ref removed)
  assert(
    merged?.dependsOn === undefined || merged.dependsOn.length === 0,
    "rule 2: self-referencing dependsOn removed after merge",
  );
  // #1005 — the reason names the ACTUAL directed edge (b → a), not every
  // dependsOn entry in the two-workstream union.
  assert(
    result.merges[0]?.reason.includes("b → a") === true,
    `rule 2: the reason names the actual directed edge (got: ${result.merges[0]?.reason})`,
  );
}

{
  // Reverse direction: a depends on b
  const result = await mergeCoupledWorkstreams(
    ws({
      a: { paths: ["src/a.ts"], dependsOn: ["b"], outOfScope: [] },
      b: { paths: ["src/b.ts"], outOfScope: [] },
    }),
  );
  assert(result.changed === true, "rule 2 (reverse): depends-on in either direction → merged");
  assert(Object.keys(result.workstreams).length === 1, "rule 2 (reverse): one workstream");
}

// ── Rule 3: symbol cross-reference (via execFn, argv form) ───────────────
{
  // Disjoint paths (so rule 1 cannot fire); the exec stub returns a hit for
  // the symbol grep → merged by rule 3. The stub records the argv it was
  // called with: the path must arrive as ONE verbatim element (the H1
  // finding — a shell-built command would re-parse `$(…)`/backticks/`;`).
  // The `worktrees` map (3rd arg) is what threads the grep's cwd in
  // production; the stub's cwd is asserted below (the #1005 cwd finding).
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const stubDir = mkdtempSync(path.join(tmpdir(), "coupling-rule3-stub-"));
  try {
    const recorded: Array<{ cmd: string; argv?: string[]; cwd?: string }> = [];
    const execFn: NonNullable<Parameters<typeof mergeCoupledWorkstreams>[1]> = async (
      cmd,
      opts,
    ) => {
      recorded.push({ cmd, argv: opts?.argv, cwd: opts?.cwd });
      return { stdout: "src/alpha.ts\n" };
    };
    const evilPath = "src/$(touch /tmp/pwned1005).ts";
    const result = await mergeCoupledWorkstreams(
      ws({
        a: { paths: ["src/alpha.ts"], outOfScope: [] },
        b: { paths: [evilPath], outOfScope: [] },
      }),
      execFn,
      { a: stubDir, b: stubDir },
    );
    assert(result.changed === true, "rule 3: disjoint paths, exec stub returns a hit → merged");
    assert(result.merges.length === 1, "rule 3: one merge recorded");
    // H1 — the argv form: the path is passed verbatim as ONE argv element,
    // and the command is `grep` (argv form, no shell).
    assert(
      recorded.length > 0 && recorded[0]?.cmd === "grep",
      `rule 3: the grep runs in argv form (cmd=argv[0], got: ${recorded[0]?.cmd})`,
    );
    const allArgs = recorded.flatMap((r) => r.argv ?? []);
    assert(
      allArgs.includes(evilPath),
      `rule 3: the path with $(…) arrives verbatim as one argv element (argv: ${JSON.stringify(allArgs)})`,
    );
    assert(
      !allArgs.some((a) => a.includes("touch /tmp/pwned1005") && a !== evilPath),
      "rule 3: nothing is shell-interpolated (the $(…) payload is data, not a command)",
    );
    // #1005 cwd finding — the grep is pointed at the workstream's tree via
    // the worktrees map, never the process cwd. Every call carries the
    // tree path as `cwd`.
    assert(
      recorded.every((r) => r.cwd === stubDir),
      `rule 3: the grep runs in the workstream's tree (cwd: ${recorded[0]?.cwd})`,
    );
  } finally {
    rmSync(stubDir, { recursive: true, force: true });
  }
}

{
  // No symbol overlap → not merged (rule 3 negative): the stub returns
  // nothing.
  const execFn = async () => ({ stdout: "" });
  const result = await mergeCoupledWorkstreams(
    ws({
      a: { paths: ["src/alpha.ts"], outOfScope: [] },
      b: { paths: ["src/beta.ts"], outOfScope: [] },
    }),
    execFn,
  );
  assert(result.changed === false, "rule 3 (negative): no symbol overlap → not merged");
  assert(
    Object.keys(result.workstreams).length === 2,
    "rule 3 (negative): both workstreams remain",
  );
}

// ── Rule 3 with the PRODUCTION executor (H1 fix + cwd fix verification) ───
{
  // The production executor (work-driver-verify.ts execp) honours argv via
  // execFile. This test exercises the REAL call shape: mergeCoupledWorkstreams
  // + execp + the worktrees map (3rd arg) — no wrapper that injects a cwd
  // the production call site does not supply (that wrapper is what masked
  // the #1005 cwd finding: the test passed against a temp dir it injected,
  // while production's cwd-less grep never resolved the worktree-relative
  // paths and rule 3 silently never fired).
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  // Two separate temp dirs: one per workstream. The planner's paths are
  // relative to each workstream's own tree; the grep must run there.
  const dirA = mkdtempSync(path.join(tmpdir(), "coupling-prod-a-"));
  const dirB = mkdtempSync(path.join(tmpdir(), "coupling-prod-b-"));
  try {
    mkdirSync(path.join(dirA, "src"), { recursive: true });
    mkdirSync(path.join(dirB, "src"), { recursive: true });
    // Workstream A declares src/alpha.ts; workstream B declares src/beta.ts,
    // which references alpha. The shared symbol is what rule 3 detects.
    writeFileSync(path.join(dirA, "src/alpha.ts"), "export function alpha() {}\n");
    writeFileSync(path.join(dirB, "src/beta.ts"), "import { alpha } from './alpha';\n");

    const { execp } = await import("../src/work-driver-verify.ts");
    // The production call shape — NO cwd-injecting wrapper. The worktrees
    // map (3rd arg) points the grep at each tree when it names one; at
    // plan time the map is EMPTY and the grep falls back to repoRoot
    // (4th arg) — the shape runPlan actually passes. The per-worktree tree
    // map (dirA/dirB) is retained here to exercise the per-workstream
    // override (the API-compat path for tests).
    const prodExecFn: NonNullable<Parameters<typeof mergeCoupledWorkstreams>[1]> = (
      cmd,
      opts,
    ) => execp(cmd, opts);

    // Case A: shared symbol alpha between alpha.ts and beta.ts → MERGED.
    const rA = await mergeCoupledWorkstreams(
      ws({
        a: { paths: ["src/alpha.ts"], outOfScope: [] },
        b: { paths: ["src/beta.ts"], outOfScope: [] },
      }),
      prodExecFn,
      { a: dirA, b: dirB },
    );
    assert(
      rA.changed === true,
      `rule 3 (production): shared symbol detected via production execp + worktrees map (got changed=${rA.changed})`,
    );
    assert(
      rA.merges[0]?.reason?.includes("alpha") ?? false,
      `rule 3 (production): the reason names the shared symbol (got: ${rA.merges[0]?.reason})`,
    );

    // Case B (the #1005 adversarial finding, regression): the SAME files
    // with NO worktrees map AND NO repoRoot. The coupling module skips
    // rule 3 when it cannot resolve a tree (a cwd-less grep would run in
    // the process directory, where the declared paths do not exist — the
    // pre-fix silent no-op that made rule 3 unreachable in production).
    // The pair must NOT be merged: no rules 1/2 evidence either, so the
    // result is unchanged. This is the shape the adversarial finding
    // described (the empty worktrees map with no fallback); the fix makes
    // it a visible skip, not a silent miss that looked like "no coupling".
    const rB = await mergeCoupledWorkstreams(
      ws({
        a: { paths: ["src/alpha.ts"], outOfScope: [] },
        b: { paths: ["src/beta.ts"], outOfScope: [] },
      }),
      prodExecFn,
      undefined,
      undefined,
    );
    assert(
      rB.changed === false,
      "rule 3 (no worktrees map, no repoRoot): rule 3 is skipped, not a silent no-op (pre-fix: the cwd-less grep never resolved the paths)",
    );

    // Case C: a $(…) payload in a path must NOT be executed. The file does
    // not exist so grep fails (exit 2) — in argv form the $(…) is one
    // literal string to grep. If the executor used the shell, the payload
    // would run and the marker file would exist.
    const evilName = "$(touch /tmp/pwned-prod-exec1005)";
    const evilPath = `src/${evilName}.ts`;
    writeFileSync(path.join(dirB, "src/gamma.ts"), "export function gamma() {}\n");
    const marker = "/tmp/pwned-prod-exec1005";
    if (existsSync(marker)) rmSync(marker, { force: true });
    const rC = await mergeCoupledWorkstreams(
      ws({
        a: { paths: ["src/alpha.ts"], outOfScope: [] },
        b: { paths: [evilPath, "src/gamma.ts"], outOfScope: [] },
      }),
      prodExecFn,
      { a: dirA, b: dirB },
    );
    assert(
      !existsSync(marker),
      `rule 3 (production): the $(…) payload was NOT executed (marker ${marker} does not exist)`,
    );
    assert(
      rC.changed === false,
      "rule 3 (production): the missing evil path yields no coupling (grep fails closed)",
    );

    // Case D (multi-file coverage): the shared symbol is referenced in
    // b.paths[1], not b.paths[0]. Confirms rule 3's grep (`-e <name> --`
    // with every declared file as a positional argument) searches ALL of
    // the workstream's declared files, so a cross-reference in any of them
    // — not just the first — produces the merge that lets both workstreams
    // pass their gates.
    writeFileSync(path.join(dirB, "src/delta.ts"), "export function delta() {}\n");
    writeFileSync(path.join(dirB, "src/epsilon.ts"), "import { alpha } from './alpha';\n");
    const rD = await mergeCoupledWorkstreams(
      ws({
        a: { paths: ["src/alpha.ts"], outOfScope: [] },
        b: { paths: ["src/delta.ts", "src/epsilon.ts"], outOfScope: [] },
      }),
      prodExecFn,
      { a: dirA, b: dirB },
    );
    assert(
      rD.changed === true,
      `rule 3 (production): a symbol referenced in b.paths[1] IS detected (got changed=${rD.changed})`,
    );
    assert(
      rD.merges[0]?.reason?.includes("alpha") ?? false,
      `rule 3 (production): the reason names the shared symbol (got: ${rD.merges[0]?.reason})`,
    );
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}

// ── Rule 3 with the PRODUCTION call shape (empty worktrees map + repoRoot) ──
// This is the shape runPlan actually uses: the coupling merge runs at plan
// time, BEFORE the branch step, so `pipelineState.worktrees` is an EMPTY
// object. The declared paths exist at the cycle's base commit, which is
// `repoRoot`. Rule 3's grep must resolve in `repoRoot` — the #1005
// adversarial finding was that rule 3 was unreachable in production
// because the empty worktrees map (with no repoRoot fallback) left the
// grep without a cwd.
{
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  // A single temp dir standing in for repoRoot (the base commit checkout).
  // The planner's paths are relative to it; the grep must run there.
  const repoRoot = mkdtempSync(path.join(tmpdir(), "coupling-planshape-"));
  try {
    mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    // Workstream A declares src/alpha.ts; workstream B declares src/beta.ts,
    // which references alpha. Disjoint file sets (rule 1 cannot fire), no
    // depends-on (rule 2 cannot fire) — rule 3 is the only rule that can
    // couple them, and it must fire with an EMPTY worktrees map + repoRoot.
    writeFileSync(path.join(repoRoot, "src/alpha.ts"), "export function alpha() {}\n");
    writeFileSync(path.join(repoRoot, "src/beta.ts"), "import { alpha } from './alpha';\n");

    const { execp } = await import("../src/work-driver-verify.ts");
    const prodExecFn: NonNullable<Parameters<typeof mergeCoupledWorkstreams>[1]> = (
      cmd,
      opts,
    ) => execp(cmd, opts);

    // The EXACT shape runPlan uses: empty worktrees map + repoRoot (4th arg).
    const rPlan = await mergeCoupledWorkstreams(
      ws({
        a: { paths: ["src/alpha.ts"], outOfScope: [] },
        b: { paths: ["src/beta.ts"], outOfScope: [] },
      }),
      prodExecFn,
      {}, // empty — the pre-branch production shape
      repoRoot,
    );
    assert(
      rPlan.changed === true,
      `rule 3 (plan shape): empty worktrees map + repoRoot → grep resolves in repoRoot → shared symbol detected (got changed=${rPlan.changed})`,
    );
    assert(
      rPlan.merges[0]?.reason?.includes("alpha") ?? false,
      `rule 3 (plan shape): the reason names the shared symbol (got: ${rPlan.merges[0]?.reason})`,
    );

    // Negative: the same files, but repoRoot does NOT contain them (the
    // grep finds nothing) → no merge. Proves the grep actually runs in
    // repoRoot (a grep in the process cwd would fail the same way, but
    // this pairs with the positive case to confirm the path is repoRoot).
    const emptyDir = mkdtempSync(path.join(tmpdir(), "coupling-planshape-empty-"));
    try {
      const rEmpty = await mergeCoupledWorkstreams(
        ws({
          a: { paths: ["src/alpha.ts"], outOfScope: [] },
          b: { paths: ["src/beta.ts"], outOfScope: [] },
        }),
        prodExecFn,
        {},
        emptyDir,
      );
      assert(
        rEmpty.changed === false,
        "rule 3 (plan shape, negative): empty repoRoot → grep finds nothing → no merge",
      );
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// ── foldTwo symmetry: both merged ids dropped from both halves ─────────
// #1005 — the pre-#1005 foldTwo was asymmetric: `d !== b.id` for a's list,
// `d !== b.id && d !== a.id` for b's — so a's self-ref survived. The doc
// says "minus the two merged ids"; the fix drops BOTH ids from BOTH halves.
{
  const merged = foldTwo(
    { id: "a", scope: "A", paths: ["src/a.ts"], outOfScope: [], dependsOn: ["b"] },
    { id: "b", scope: "B", paths: ["src/b.ts"], outOfScope: [], dependsOn: ["a"] },
  );
  assert(
    merged.dependsOn === undefined || merged.dependsOn.length === 0,
    `foldTwo symmetry: mutual a↔b → both ids dropped (got: ${JSON.stringify(merged.dependsOn)})`,
  );
  const merged2 = foldTwo(
    { id: "a", scope: "A", paths: ["src/a.ts"], outOfScope: [], dependsOn: ["c", "b"] },
    { id: "b", scope: "B", paths: ["src/b.ts"], outOfScope: [], dependsOn: ["a"] },
  );
  assert(
    merged2.dependsOn?.includes("c") === true,
    "foldTwo symmetry: a's external dep (c) survives the fold",
  );
  assert(
    !merged2.dependsOn?.includes("a") && !merged2.dependsOn?.includes("b"),
    "foldTwo symmetry: a (self) and b (absorbed) ids are both dropped",
  );
}

// ── Genuinely separate workstreams are NOT merged ──────────────────────
{
  const result = await mergeCoupledWorkstreams(
    ws({
      a: { paths: ["src/auth.ts"], outOfScope: ["src/db.ts"] },
      b: { paths: ["src/db.ts"], outOfScope: ["src/auth.ts"] },
    }),
  );
  assert(result.changed === false, "separate: disjoint files, no depends-on → not merged");
  assert(Object.keys(result.workstreams).length === 2, "separate: both workstreams remain");
}

// ── dependsOn re-pointing: third workstream depended on the absorbed one ─
{
  const result = await mergeCoupledWorkstreams(
    ws({
      a: { paths: ["src/a.ts", "src/b.ts", "src/c.ts"], outOfScope: [] },
      b: { paths: ["src/b.ts", "src/c.ts", "src/d.ts"], outOfScope: [] },
      c: { paths: ["src/e.ts"], dependsOn: ["b"], outOfScope: [] },
    }),
  );
  // a and b: jaccard inter={b,c}=2, union={a,b,c,d}=4 → 0.5 → merged
  assert(result.changed === true, "re-point: coupled pair merged");
  // c depended on b; after b is merged into a, c should depend on a
  const cWs = result.workstreams.c;
  assert(
    cWs?.dependsOn?.includes("a") === true,
    `re-point: c's dependsOn now points to the merged id a (got: ${JSON.stringify(cWs?.dependsOn)})`,
  );
}

// ── Idempotency: running the merge twice returns the same result ────────
{
  const input = ws({
    a: { paths: ["src/a.ts", "src/b.ts", "src/c.ts"], outOfScope: [] },
    b: { paths: ["src/b.ts", "src/c.ts", "src/d.ts"], outOfScope: [] },
  });
  const r1 = await mergeCoupledWorkstreams(input);
  assert(r1.changed === true, "idempotency: first pass merges");
  const r2 = await mergeCoupledWorkstreams(r1.workstreams);
  assert(r2.changed === false, "idempotency: second pass finds no more coupled pairs");
  assert(
    JSON.stringify(r1.workstreams) === JSON.stringify(r2.workstreams),
    "idempotency: result is stable across passes",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
