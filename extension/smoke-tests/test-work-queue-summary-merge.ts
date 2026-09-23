#!/usr/bin/env bun
/**
 * #808 — the queue summary is an accumulating index, and single-issue
 * cycles write to it.
 *
 * Under the pre-#808 shape `writeQueueSummary` did a whole-file overwrite
 * whose only caller was `runWorkQueue` (the grouped path). Consequences:
 *   - a single-issue cycle never wrote the file (its outcome was invisible
 *     to /work-status and /start);
 *   - a later grouped run erased every earlier outcome.
 *
 * These tests assert the merge rule at the seam:
 *   1. sequential writes (grouped then single) keep both rows
 *   2. a re-run of the same issues replaces its own row, not others'
 *   3. single-issue writes land a row with the same shape the readers expect
 *   4. notStarted rows for issues the merge touches are pruned, others kept
 *   5. single → grouped: the grouped merge keeps the earlier single row
 *   6. grouped → single: the single merge keeps the grouped rows
 *   7. grouped re-run of the same issues replaces its own rows only
 *   8. recordSingleCycleOutcome swallows an internal error (best-effort)
 */

import os from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  mergeQueueSummaryEntries,
  mergeQueueSummaryEntry,
  readQueueSummary,
  writeQueueSummary,
} from "../src/work-queue-summary.ts";
import { recordSingleCycleOutcome } from "../src/work-entry.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const dir = mkdtempSync(path.join(os.tmpdir(), "pi-808-queue-summary-"));
try {
  // ---------------------------------------------------------------------
  // 1. Sequential writes: grouped run, then a single-issue cycle.
  // ---------------------------------------------------------------------
  {
    const grouped = {
      entries: [
        { groupId: "g1", issues: [901, 902], outcome: "merged" as const },
        {
          groupId: "g2",
          issues: [903],
          outcome: "parked" as const,
          reason: "cap round-cap",
          humanAction: "review the PR",
        },
      ],
      merged: 1,
      parked: 1,
      notStarted: ["g3 (#904, #905)"],
    };
    await writeQueueSummary(dir, grouped, 1000);
    await mergeQueueSummaryEntry(dir, {
      groupId: "single-906",
      issues: [906],
      outcome: "parked",
      reason: "cap intent-park:underspecified",
      humanAction: "revise the issue",
    });

    const after = await readQueueSummary(dir);
    const ids = (after?.entries ?? []).map((e) => e.groupId).sort();
    assert(
      JSON.stringify(ids) === JSON.stringify(["g1", "g2", "single-906"]),
      "sequential write: the earlier grouped rows are PRESERVED (not overwritten)",
    );
    const single = after?.entries.find((e) => e.groupId === "single-906");
    assert(single?.issues.join(",") === "906", "single-issue row is present with its issue");
    assert(after?.merged === 1 && after?.parked === 2, "totals reflect the merged union");
    // `notStarted` is run-scoped: it names the groups THIS run never reached.
    // A single-issue cycle reaches everything it runs, so it resets the list
    // (the old "g3 (#904, #905)" group was never reached BY ITS OWN run, and
    // resurrecting it after a new run would be a lie).
    assert(
      (after?.notStarted ?? []).length === 0,
      "notStarted: the run-scoped list is reset by a newer run, not resurrected",
    );
  }

  // ---------------------------------------------------------------------
  // 2. A re-run of the same issues replaces its own row only.
  // ---------------------------------------------------------------------
  {
    await mergeQueueSummaryEntry(dir, {
      groupId: "single-906",
      issues: [906],
      outcome: "merged",
    });
    const after = await readQueueSummary(dir);
    const rows906 = (after?.entries ?? []).filter((e) => e.issues.includes(906));
    assert(rows906.length === 1, "re-run: the issue's own row is REPLACED, not duplicated");
    assert(rows906[0]?.outcome === "merged", "re-run: the replacement carries the new outcome");
    assert(
      (after?.entries ?? []).some((e) => e.groupId === "g1"),
      "re-run: unrelated rows are untouched",
    );
  }

  // ---------------------------------------------------------------------
  // 3. A single-issue write into an EMPTY store lands a clean, reader-shaped row.
  // ---------------------------------------------------------------------
  {
    const dir2 = mkdtempSync(path.join(os.tmpdir(), "pi-808-queue-summary-2-"));
    try {
      assert((await readQueueSummary(dir2)) === undefined, "empty store: no summary yet");
      await mergeQueueSummaryEntry(dir2, {
        groupId: "single-765",
        issues: [765],
        outcome: "parked",
        reason: "cap step-failed:commit-pr",
        failedStep: "commit-pr",
        humanAction: "inspect the state file",
      });
      const back = (await readQueueSummary(dir2))!;
      assert(back.entries.length === 1 && back.entries[0]?.groupId === "single-765",
        "single-issue cycle leaves a row in queue-summary.json");
      assert(back.parked === 1 && back.merged === 0 && back.refused === 0,
        "single-issue row counts in the summary totals");
      assert(Array.isArray(back.notStarted) && back.notStarted.length === 0,
        "single-issue row leaves no phantom notStarted groups");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------
  // 4. notStarted pruning: a merge for issue 904 drops its group's row.
  // ---------------------------------------------------------------------
  {
    await mergeQueueSummaryEntry(dir, {
      groupId: "single-904",
      issues: [904],
      outcome: "parked",
      reason: "cap wall-clock",
    });
    const after = await readQueueSummary(dir);
    assert(
      !(after?.notStarted ?? []).some((s) => s.includes("#904")),
      "notStarted: the merged group's never-started name is pruned",
    );
  }

  // ---------------------------------------------------------------------
  // 5. Single → grouped: the grouped merge keeps the earlier single row.
  // ---------------------------------------------------------------------
  {
    const dir3 = mkdtempSync(path.join(os.tmpdir(), "pi-808-queue-summary-3-"));
    try {
      await mergeQueueSummaryEntry(dir3, {
        groupId: "single-910",
        issues: [910],
        outcome: "merged",
      });
      await mergeQueueSummaryEntries(
        dir3,
        [
          { groupId: "g1", issues: [911, 912], outcome: "merged" },
          {
            groupId: "g2",
            issues: [913],
            outcome: "parked",
            reason: "cap round-cap",
            humanAction: "review the PR",
          },
        ],
        ["g3 (#914)"],
      );
      const after = await readQueueSummary(dir3);
      const ids = (after?.entries ?? []).map((e) => e.groupId).sort();
      assert(
        JSON.stringify(ids) === JSON.stringify(["g1", "g2", "single-910"]),
        "single → grouped: the earlier single-issue row is PRESERVED by the grouped merge",
      );
      assert(
        after?.merged === 2 && after?.parked === 1 && after?.refused === 0,
        "single → grouped: totals recomputed over the union",
      );
      assert(
        after?.notStarted.join() === "g3 (#914)",
        "single → grouped: notStarted is the run's own list, not a stale union",
      );
    } finally {
      rmSync(dir3, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------
  // 6. Grouped → single: the single merge keeps the grouped rows.
  // ---------------------------------------------------------------------
  {
    const dir4 = mkdtempSync(path.join(os.tmpdir(), "pi-808-queue-summary-4-"));
    try {
      await writeQueueSummary(
        dir4,
        {
          entries: [
            { groupId: "g1", issues: [921, 922], outcome: "merged" },
            { groupId: "g2", issues: [923], outcome: "not-started", reason: "live cycle" },
          ],
          merged: 1,
          parked: 0,
          notStarted: ["g3 (#924)"],
        },
        1000,
      );
      await mergeQueueSummaryEntry(dir4, {
        groupId: "single-925",
        issues: [925],
        outcome: "parked",
        reason: "cap intent-park:underspecified",
      });
      const after = await readQueueSummary(dir4);
      const ids = (after?.entries ?? []).map((e) => e.groupId).sort();
      assert(
        JSON.stringify(ids) === JSON.stringify(["g1", "g2", "single-925"]),
        "grouped → single: the earlier grouped rows are PRESERVED by the single merge",
      );
      assert(
        after?.merged === 1 && after?.parked === 1 && after?.refused === 1,
        "grouped → single: totals recomputed over the union",
      );
      assert(
        after?.notStarted.length === 0,
        "grouped → single: the run-scoped notStarted list is not resurrected",
      );
    } finally {
      rmSync(dir4, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------
  // 7. Grouped re-run of the same issues replaces its own rows only.
  // ---------------------------------------------------------------------
  {
    const dir5 = mkdtempSync(path.join(os.tmpdir(), "pi-808-queue-summary-5-"));
    try {
      await mergeQueueSummaryEntries(
        dir5,
        [
          { groupId: "g1", issues: [931, 932], outcome: "merged" },
          { groupId: "g2", issues: [933], outcome: "parked", reason: "cap round-cap" },
        ],
        ["g3 (#934)"],
      );
      await mergeQueueSummaryEntries(
        dir5,
        [
          // Same issues as g1 → replace g1's row; 935 is new → add a row.
          { groupId: "g1-rerun", issues: [931, 932], outcome: "parked", reason: "cap wall-clock" },
          { groupId: "g4", issues: [935], outcome: "merged" },
        ],
        ["g5 (#936)"],
      );
      const after = await readQueueSummary(dir5);
      const entries = after?.entries ?? [];
      const by931 = entries.filter((e) => e.issues.includes(931));
      assert(by931.length === 1, "grouped re-run: the same-issue row is REPLACED, not duplicated");
      assert(
        by931[0]?.groupId === "g1-rerun" && by931[0]?.outcome === "parked",
        "grouped re-run: the replacement carries the new group id and outcome",
      );
      assert(
        entries.some((e) => e.groupId === "g2" && e.outcome === "parked"),
        "grouped re-run: this run's other rows and the untouched rows are both kept",
      );
      assert(
        entries.length === 3,
        "grouped re-run: union is old-untouched (1) + new run (2), no phantom rows",
      );
      assert(
        after?.merged === 1 && after?.parked === 2,
        "grouped re-run: totals recomputed over the union",
      );
      assert(
        after?.notStarted.join() === "g5 (#936)",
        "grouped re-run: notStarted is the new run's list",
      );
    } finally {
      rmSync(dir5, { recursive: true, force: true });
    }
  }

  // ---------------------------------------------------------------------
  // 8. recordSingleCycleOutcome is best-effort: a failure inside the read/
  //    map/merge path is caught, traced, and never propagates.
  // ---------------------------------------------------------------------
  {
    const dir6 = mkdtempSync(path.join(os.tmpdir(), "pi-808-queue-summary-6-"));
    try {
      mkdirSync(path.join(dir6, "work-state"), { recursive: true });
      // A corrupt (non-JSON) state file makes readState THROW (not return
      // undefined); singleCycleQueueEntry does not catch that.
      writeFileSync(path.join(dir6, "work-state", "940.json"), "cor{rupt{", "utf8");
      let threw = false;
      try {
        await recordSingleCycleOutcome(dir6, 940);
      } catch {
        threw = true;
      }
      assert(!threw, "recordSingleCycleOutcome: a broken state file does NOT throw to the caller");
      const after = await readQueueSummary(dir6);
      assert(
        after === undefined || (after?.entries ?? []).length === 0,
        "recordSingleCycleOutcome: a failed record leaves no phantom row",
      );
    } finally {
      rmSync(dir6, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
