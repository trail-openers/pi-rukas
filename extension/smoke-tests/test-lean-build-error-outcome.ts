#!/usr/bin/env bun
/**
 * lean/build — what a dead developer costs the run, and where its rows may go.
 *
 * Split out of `test-lean-build.ts` for the §12 size cap along the seam that
 * case (n) already drew: these two cases are about the ERROR path, not about the
 * commit the step makes. They are also the only cases here that assert on the
 * shape of an `{kind:"error"}` outcome, which is a `state-outcome` question
 * wearing a build costume.
 *
 *   (n) a dispatch that resolved and then died -> the child's cost row survives
 *       the step's throw and reaches the state file the engine writes
 *   (o) rows are carried ONLY for a step that owns `dispatches` — a `publish`
 *       throw with rows on it must not make the run's own state file unloadable
 *   (p) a throw carrying more rows than the validator allows still loads — the
 *       engine clips to the bound instead of producing an unreadable record
 *
 * (n) runs against the same real repo as the build suite, so the row it follows
 * out of the step is one a real dispatch produced, and is read back through
 * `loadRun` — the only path that proves a row is durable, and the place a
 * malformed one is refused.
 */

import { BuildInfraError } from "../src/lean/build-errors.ts";
import { type LeanHandlers, runLean } from "../src/lean/engine.ts";
import { errorOutcome } from "../src/lean/error-outcome.ts";
import { loadRun } from "../src/lean/state.ts";
import { DISPATCHES_MAX_ROWS } from "../src/lean/state-outcome.ts";
import { ROOTS, runBuild } from "./lib/lean-build-fixture.ts";
import { tempDir } from "./lib/lean-engine-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------- (n) a dispatch that resolved and then died still costs the run
//
// The step's throw records no outcome of its own, so the child's cost row rides
// on the error and the ENGINE puts it on the `{kind:"error"}` outcome it writes
// (#1920 A). Asserted here where a real dispatch happened: the rows are read
// back out of the state file through `loadRun`, the only path that proves they
// are durable — load is also where a malformed row would be refused.
{
  const r = await runBuild({ issue: 130, dispatchOk: false });
  assert(
    r.threw instanceof BuildInfraError,
    `(n) a dead child throws infra, it is not a verdict (got ${r.threw?.name})`,
  );
  assert(
    r.deadDispatches?.length === 1 && r.deadDispatches[0]?.role === "developer",
    `(n) the throw carries the row of the child that reported before dying (got ${JSON.stringify(r.deadDispatches)})`,
  );
  const { dir, cleanup } = tempDir();
  try {
    const rows = r.deadDispatches ?? [];
    const handlers: LeanHandlers = {
      ready: async () => ({ kind: "ok" }),
      specify: async () => ({ kind: "ok" }),
      build: async () => {
        throw Object.assign(new Error("build dispatch failed: exit 1"), { dispatches: rows });
      },
    };
    const crashed = await runLean({ repoRoot: dir, issue: 130, handlers });
    assert(
      crashed.state === "handed-back" && crashed.code === 10,
      `(n) the run whose build died ends handed-back 10 (got ${crashed.state} ${crashed.code})`,
    );
    const errored = loadRun(dir, 130)?.steps.find(
      (s) => s.state === "build" && s.outcome?.kind === "error",
    );
    assert(errored !== undefined, "(n) the engine recorded an error outcome for the throw");
    assert(
      errored?.outcome?.dispatches?.length === 1 &&
        errored.outcome.dispatches[0]?.role === "developer" &&
        errored.outcome.dispatches[0]?.usage.input === 11,
      `(n) the recorded error outcome carries the dead child's rows after loadRun (got ${JSON.stringify(errored?.outcome?.dispatches)})`,
    );
  } finally {
    cleanup();
  }
}

// ------------------- (o) an error outcome carries rows ONLY where they belong
//
// `dispatches` belongs to `specify`/`build`/`challenge` (`OWNER_OF_FIELD` in
// `state-outcome.ts`), so an engine that copied rows onto a `publish` throw
// would leave the run's own state file refusing to load. The helper drops them.
{
  const rows = [
    {
      role: "developer",
      ms: 1000,
      ok: false,
      usage: { input: 11, output: 2, cacheRead: 3, cacheWrite: 1, cost: 0.5, turns: 4 },
    },
  ];
  const owned = errorOutcome("build", Object.assign(new Error("died"), { dispatches: rows }));
  const unowned = errorOutcome("publish", Object.assign(new Error("died"), { dispatches: rows }));
  const notAnArray = errorOutcome("build", Object.assign(new Error("died"), { dispatches: "x" }));
  const badRow = errorOutcome(
    "build",
    Object.assign(new Error("died"), { dispatches: [{ role: "developer" }] }),
  );
  assert(
    owned.kind === "error" && owned.message === "died" && owned.dispatches?.length === 1,
    `(o) a dispatching step's throw keeps its rows (got ${JSON.stringify(owned)})`,
  );
  assert(
    unowned.dispatches === undefined,
    `(o) a step that owns no dispatches records none (got ${JSON.stringify(unowned)})`,
  );
  assert(
    notAnArray.dispatches === undefined && badRow.dispatches === undefined,
    "(o) a non-array and an unusable row are dropped, never written to the record",
  );
}

// -------------------- (p) too many rows on a throw still leave the run loadable
//
// `dispatchesProblem` REFUSES a `dispatches` array over `DISPATCHES_MAX_ROWS`,
// so an engine that copied a fat throw's rows straight onto the record would
// write a state file `loadRun` rejects — a run that hit one infra throw would
// lose its whole durable record. The helper clips to the bound instead, and
// keeps the TAIL: rows arrive in dispatch order and the child that ran last is
// the one that decided the step.
{
  const many = Array.from({ length: DISPATCHES_MAX_ROWS + 1 }, (_, i) => ({
    role: `role-${String(i)}`,
    ms: 1000,
    ok: false,
    usage: { input: 11, output: 2, cacheRead: 3, cacheWrite: 1, cost: 0.5, turns: 4 },
  }));
  const clipped = errorOutcome("build", Object.assign(new Error("died"), { dispatches: many }));
  assert(
    clipped.dispatches?.length === DISPATCHES_MAX_ROWS,
    `(p) a throw carrying ${String(DISPATCHES_MAX_ROWS + 1)} rows records at most ${String(DISPATCHES_MAX_ROWS)} (got ${String(clipped.dispatches?.length)})`,
  );
  assert(
    clipped.dispatches?.[DISPATCHES_MAX_ROWS - 1]?.role === `role-${String(DISPATCHES_MAX_ROWS)}`,
    `(p) the clip keeps the TAIL, so the child that decided the step is recorded (got ${String(clipped.dispatches?.[DISPATCHES_MAX_ROWS - 1]?.role)})`,
  );
  const { dir, cleanup } = tempDir();
  try {
    const handlers: LeanHandlers = {
      ready: async () => ({ kind: "ok" }),
      specify: async () => ({ kind: "ok" }),
      build: async () => {
        throw Object.assign(new Error("build dispatch failed: exit 1"), { dispatches: many });
      },
    };
    const crashed = await runLean({ repoRoot: dir, issue: 131, handlers });
    assert(
      crashed.state === "handed-back" && crashed.code === 10,
      `(p) the run whose build threw over-sized rows ends handed-back 10 (got ${crashed.state} ${crashed.code})`,
    );
    const loaded = loadRun(dir, 131);
    assert(
      loaded !== undefined,
      "(p) a throw carrying 17 rows still lets loadRun load the run's state file",
    );
  } finally {
    cleanup();
  }
}

for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
process.exit(exit);
