/**
 * lean: a routed handback whose process died MID-REPORTING-STEP still resumes (#2264).
 *
 * Split from `test-lean-verified-handback-deadline.ts` for the 500-line cap (AGENTS.md §12),
 * along the seam between "what the routed run says" (that file) and "what its record survives"
 * (this one). The rig is shared, unchanged: the same crossing clock, the same scripted walk,
 * the same production reporting wiring.
 *
 * `runHandbackReport` appends the report's visit to its IN-MEMORY copy of the run and saves
 * the visit, its verdict and the terminal stamp only AFTER the handler returns, so the file on
 * disk while the handler runs is the pre-drive record: no `handback` entry at all. A process
 * killed at that instant leaves exactly those bytes, and a run resumed from them must still
 * report — the fold reaches `handback` through `isReportRoute`, the loop stands on the blank
 * visit the routing writes ahead, and no WORK step starts past the line. A record that failed
 * this would be a timed-out issue that can never be re-run: the loader runs before the
 * routing's switch is read, so no env value brings such a run back.
 */

import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LeanHandlers } from "../src/lean/engine.ts";
import { runLean } from "../src/lean/engine.ts";
import { reportHandlers } from "../src/lean/report-handlers.ts";
import type { LeanRun } from "../src/lean/state.ts";
import { leanStateFile, loadRun } from "../src/lean/state.ts";
import { makeAssert } from "./headless-verb-harness.ts";
import { recording, withEnv } from "./lib/lean-host-contract-fixture.ts";
import { ENV, driveToDeadline, walkToReview } from "./lib/lean-verified-handback-deadline-rig.ts";
import { ISSUE } from "./lib/lean-verified-handback-fixture.ts";
import { repoWithFixHead } from "./lib/lean-verified-handback-repo.ts";

const { assert, state } = makeAssert();

// The capture drive is a repo of its own because a finished run cannot be re-driven: its
// record carries a `result`, which `runLean` returns verbatim, so a drive of that file would
// judge the first drive's stamp rather than drive anything. Here the same scripted walk is
// driven once more, past the arm, with the engine's real reporting step wrapped to snapshot
// the on-disk record while it runs — the only code that can produce a mid-handler kill's
// bytes, because that instant is their sole writer.
const capture = repoWithFixHead();
await withEnv(ENV, async () => {
  const midHandler = join(capture.repoRoot, "mid-handler.json");
  const calls: string[] = [];
  const routedHandler = async (ctx: Parameters<NonNullable<LeanHandlers["handback"]>>[0]) => {
    calls.push("handback");
    const real = reportHandlers(capture.repoRoot, ISSUE).handback;
    if (real === undefined) throw new Error("no reporting handler built");
    return real(ctx);
  };
  const captured = await driveToDeadline(
    capture.repoRoot,
    walkToReview({
      kind: "green",
      verifiedHead: capture.baseSha,
      reason: `all frozen tests green at ${capture.baseSha}`,
    }),
    capture.baseSha,
    {
      handback: async (ctx) => {
        // The crash snapshot: the record exactly as it stands on disk WHILE the routed
        // reporting step runs.
        copyFileSync(leanStateFile(capture.repoRoot, ISSUE), midHandler);
        return routedHandler(ctx);
      },
    },
  );
  assert(
    captured.state === "handed-back" &&
      captured.reason.includes("cycle deadline reached at verify"),
    `the capture drive was routed into its report by the deadline (got ${captured.state}: ${JSON.stringify(captured.reason)})`,
  );
  const crashed = JSON.parse(readFileSync(midHandler, "utf8")) as LeanRun;
  assert(
    crashed.steps.every((s) => s.state !== "handback") && crashed.result === undefined,
    `the record as the handler found it holds no report entry and no stamp — the bytes a kill here leaves (${JSON.stringify(crashed.steps.map((s) => `${s.key}=${s.outcome?.kind ?? "?"}`))})`,
  );

  copyFileSync(midHandler, leanStateFile(capture.repoRoot, ISSUE));
  const resumed = await runLean({
    repoRoot: capture.repoRoot,
    issue: ISSUE,
    handlers: {
      ...reportHandlers(capture.repoRoot, ISSUE),
      // Dry queues for the work steps: reaching one throws inside the handler and the engine
      // stamps a handler `error`, whose sentence these assertions can tell from the report's.
      // A step started past the line is therefore loud rather than plausible.
      ...recording(calls, { verify: [] }),
      handback: routedHandler,
    },
    // The same clock that stopped the first drive, still past the arm the record persists.
    now: () => captured.armPast,
  });
  const resumedRecord = loadRun(capture.repoRoot, ISSUE);
  assert(
    resumed.state === "handed-back" && resumed.code === 10,
    `the mid-handler record resumes to handed-back at exit 10 rather than refusing (got ${resumed.state} exit ${resumed.code}: ${resumed.run.result?.reason})`,
  );
  assert(
    resumedRecord?.result?.reason.includes("cycle deadline reached at verify") === true,
    `and it resumes by ROUTING into the report, whose sentence names the refused step (${JSON.stringify(resumedRecord?.result?.reason)})`,
  );
  assert(
    calls.filter((c) => c === "handback").length === 2,
    `the reporting step ran once on the capture drive and once on the resume — a blank visit is re-run, not skipped (calls ${JSON.stringify(calls)})`,
  );
  assert(
    calls.filter((c) => c !== "handback").length === 0,
    `and NO drive started a work step past the deadline (calls ${JSON.stringify(calls)})`,
  );
  // The blank visit re-runs as the SAME entry (same key, same `startedAt`), so the record
  // carries one report entry, not two, and it ends with its verdict.
  assert(
    resumedRecord?.steps.filter((s) => s.state === "handback").length === 1 &&
      resumedRecord?.steps.find((s) => s.state === "handback")?.outcome?.kind === "done",
    `the resumed record ends as any handback's: the report's entry with its verdict (${JSON.stringify(resumedRecord?.steps.filter((s) => s.state === "handback"))})`,
  );
});

// ── a routed report that THROWS: the run still gets a stamp, and the operator is told ──
//
// The throw is a handler bug, and its cost is real: the run loses its report — no comment,
// no rewind, no head fields — and falls back to the plain deadline stamp. `engine-report.ts`
// therefore discloses it on the UNGATED `traceWarn` channel rather than the
// `PI_ENSEMBLE_DEBUG` one: a warning nobody sees unless they thought to switch debugging on
// is not a disclosure of an outcome change. This arm runs with debugging OFF and captures
// stderr, so a `trace` left in that catch is caught here rather than passing unnoticed.
{
  const throwing = repoWithFixHead();
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  await withEnv({ ...ENV, PI_ENSEMBLE_DEBUG: "0" }, async () => {
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderr.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const ran = await driveToDeadline(
        throwing.repoRoot,
        walkToReview({
          kind: "green",
          verifiedHead: throwing.baseSha,
          reason: `all frozen tests green at ${throwing.baseSha}`,
        }),
        throwing.baseSha,
        {
          handback: async () => {
            throw new Error("the reporting step blew up");
          },
        },
      );
      assert(
        ran.state === "handed-back" && ran.outcome === undefined,
        `a routed report that threw leaves the plain deadline stamp and no report outcome (got ${ran.state}: ${JSON.stringify(ran.reason)}, outcome ${JSON.stringify(ran.outcome)})`,
      );
    } finally {
      process.stderr.write = write;
    }
  });
  const warned = stderr.filter((l) => l.includes("[pi-rukas] WARN") && l.includes("threw"));
  assert(
    warned.length === 1,
    `the thrown routed report is disclosed on the ungated traceWarn channel with debug OFF (warn lines ${JSON.stringify(warned)})`,
  );
}

process.exit(state.exit);
