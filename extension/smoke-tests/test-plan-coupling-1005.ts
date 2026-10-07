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
  const recorded: Array<{ cmd: string; argv?: string[] }> = [];
  const execFn: NonNullable<Parameters<typeof mergeCoupledWorkstreams>[1]> = async (cmd, opts) => {
    recorded.push({ cmd, argv: opts?.argv });
    return { stdout: "src/alpha.ts\n" };
  };
  const evilPath = "src/$(touch /tmp/pwned1005).ts";
  const result = await mergeCoupledWorkstreams(
    ws({
      a: { paths: ["src/alpha.ts"], outOfScope: [] },
      b: { paths: [evilPath], outOfScope: [] },
    }),
    execFn,
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
