#!/usr/bin/env bun
/**
 * #1826 — the SECOND base run of the whole-command base probe, at the seam that
 * pays for it.
 *
 * `test-verify-base-confirm.ts` pins the decision table with an injected probe;
 * this file pins that the probe seam really runs the gate twice, on two FRESH
 * trees, and that a base which fails once and passes once is recorded as the
 * flaky base it is instead of parking the cycle. Ten of twenty /work cycles on
 * one repository parked on a single red run in a day, four inside one 40-minute
 * window, while a fifth cycle in that window ran the same check and merged.
 *
 * Offline: temp git repos, no dispatch, no spawn.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type HostBudget, __setHostBudget } from "../src/host-resources.ts";
import { applyBaseHealthProbe } from "../src/work-driver-verify-base-health.ts";
import {
  CMD,
  RED_GATE,
  branchState,
  execLine,
  keyFor,
  probeRunLabel,
} from "./lib/base-health-probe-fixture.ts";
import {
  GATE_ECHO,
  announceGate,
  commitAll,
  probeFailureExecutor,
} from "./lib/base-health-verdict-fixture.ts";
import { realExec } from "./lib/restore-start-ref-fixtures.ts";
import { redGateFixture } from "./lib/verify-baseline-probe-harness.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-base-two-runs-"));
__setHostBudget({ verifyConcurrency: 0 } as HostBudget);

// ── 1 — the SECOND base run, and the decision rule that reads it (#1826).
//
// The single-run probe parked ten of twenty cycles on one base in a day, four
// inside one 40-minute window, while a fifth cycle in that window ran the same
// check and merged. A red base is now red TWICE, on two fresh trees.
{
  const f = await redGateFixture(root, "flaky", RED_GATE, { "notes.md": "x\n" });
  const adds: string[] = [];
  const gateCwds: string[] = [];
  const out = await applyBaseHealthProbe(
    async (cmd, o) => {
      const line = execLine(cmd, o);
      // The add is counted, not intercepted: the tree is what it is, and the
      // label it carries is what decides which arm this run answers for.
      if (line.includes("git worktree add")) adds.push(line);
      if (!line.startsWith("git ")) {
        gateCwds.push(o?.cwd ?? "");
        // Red the FIRST time, green the SECOND: the shape the four parked cycles
        // were in, and the one that must not park. The label comes from the tree's
        // own name, which is the same name `probeBaselineVerify` builds.
        if (probeRunLabel(o?.cwd ?? "") !== "base2") return await realExec(cmd, o);
        return { stdout: "" };
      }
      return await realExec(cmd, o);
    },
    { host: {}, repoRoot: f.repo, issue: 1765 } as never,
    branchState(f.baseSha),
    CMD,
    await keyFor(f.repo, f.baseSha),
  );
  assert(
    out.ran === true && out.red === undefined,
    `red then green: no red evidence — the base is not established (ran=${String(out.ran)}, red=${String(out.red !== undefined)})`,
  );
  assert(
    out.verdict?.status === "unknown" && out.verdict?.secondRun === "green",
    `red then green: the verdict records the flaky base (status=${out.verdict?.status}, secondRun=${String(out.verdict?.secondRun)})`,
  );
  assert(
    adds.length === 2 && new Set(gateCwds.map((c) => probeRunLabel(c))).size === 2,
    `red then green: two runs in two distinct trees (${JSON.stringify(gateCwds.map((c) => probeRunLabel(c)))})`,
  );
  assert(
    out.notes.some((n) => n.includes("base run 1: FAILED") && n.includes("base run 2: PASSED")),
    `red then green: the notes record the flaky base for the operator (got ${JSON.stringify(out.notes)})`,
  );
}

// ── 1b — a killed first run is not red twice: no second run is paid for.
{
  const f = await redGateFixture(root, "killed-first", RED_GATE, { "notes.md": "x\n" });
  announceGate(path.join(f.repo, "gate.sh"));
  commitAll(f.repo, "chore: announce the gate");
  const announced = (
    await realExec("git", { argv: ["rev-parse", "HEAD"], cwd: f.repo })
  ).stdout.trim();
  const gateRuns: string[] = [];
  const out = await applyBaseHealthProbe(
    probeFailureExecutor({
      shape: "killed",
      gateMarker: GATE_ECHO,
      onGate: (line, cwd) => gateRuns.push(`${line}@${cwd}`),
    }),
    { host: {}, repoRoot: f.repo, issue: 1765 } as never,
    branchState(announced),
    CMD,
    await keyFor(f.repo, f.baseSha),
  );
  assert(
    gateRuns.length === 1,
    `a killed first run: the gate ran ONCE — no second run is paid for to confirm a run that judged nothing (got ${gateRuns.length})`,
  );
  // The killed arm keeps the evidence today's route produced for it: the finding
  // exists, and it is the TIMEOUT's own sentence — which is why cap precedence
  // routes it as `verify-timeout:<step>` (#1404) and why the two-run claim, the
  // `[baseline-red]` finding alone, is not what a killed run raises. What it must
  // never become is a red on a test nobody ran: the arm is reached by `killed`
  // alone, and a killed run supplies no stream for an assertion to be read out of.
  assert(
    out.red !== undefined &&
      out.red.message.includes("[verify-timeout]") &&
      !out.red.message.includes("ALSO FAILS"),
    `a killed first run: its evidence is the timeout's own sentence, not a red-base claim (got ${String(out.red?.message.slice(0, 120))})`,
  );
  assert(
    out.verdict?.timedOut === true,
    `a killed first run: the record still says it was the killed arm (timedOut=${String(out.verdict?.timedOut)})`,
  );
  assert(
    !out.notes.some((n) => n.includes("base run 2")),
    `a killed first run: no second run is named in the notes — none was paid for (got ${JSON.stringify(out.notes)})`,
  );
}

rmSync(root, { recursive: true, force: true });
process.exit(exit);
