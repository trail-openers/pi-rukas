#!/usr/bin/env bun
/**
 * #813 — a consolidation failure with NO fence record must state what was
 * OBSERVED, not assert that the decomposition is incoherent.
 *
 * The pre-#813 diagnosis guessed: when the consolidated verify could not
 * combine the workstreams' commits and the develop fence had recorded
 * nothing, both operator surfaces (`reportConsolidatedVerifyOutcome`'s
 * failure string and `explainCap("consolidated-verify-conflict")`) claimed
 * "two workstreams edited the same lines; the decomposition is incoherent".
 * With #1005 merging genuinely coupled workstreams at plan time, the pair
 * that still collides is usually coupled through TYPES while declaring
 * disjoint paths (the #792 DeliverableStatus/ConvergeEvidence shape) — and
 * re-splitting is no longer the fix for that.
 *
 * The two surfaces each own a renderer, so the no-fence branch is covered
 * for BOTH (the acceptance criteria), plus the reporter's `#1005`
 * "likely coupled" branch that fires when the failure names a file another
 * workstream declared. The BATCH layer — what `cherryPickWorkstreams` records
 * and how `conflictedFile` is extracted from git's output — is
 * test-consolidation-conflict-batch-813.ts. The STACKED cap renderer and the
 * sibling-only attribution are in test-consolidation-conflict-stacked-813.ts
 * (split for the §12 file-size cap).
 *
 * The conflict branch of the reporter is driven through the REAL
 * `runConsolidatedVerify` with an injected executor that aborts the batch,
 * so the string asserted here is the string production produces — including
 * `cons.detail`, which the reporter embeds verbatim.
 */

import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describeSiblingFenceViolations } from "../src/work-develop-fence-verdicts.ts";
import { reportConsolidatedVerifyOutcome } from "../src/work-driver-consolidated-verify-report.ts";
import type { ConsolidatedVerifyResult } from "../src/work-driver-consolidated-verify-types.ts";
import { runConsolidatedVerify } from "../src/work-driver-consolidated-verify.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import type { FenceViolationRecord } from "../src/work-driver-scope-fence.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * A fake executor that behaves like a real git checkout/branch sequence and
 * then FAILS the batch the way `cherryPickWorkstreams` does when a pick
 * conflicts: `git cherry-pick --no-commit <sha>` throws for workstream `b`,
 * the abort runs, and no verify command is ever reached.
 */
function conflictingExec(failedId: "a" | "b", opts?: { gitOutputWithoutFile?: boolean }) {
  const calls: string[] = [];
  // The file git names on the aborted pick's stderr. The batch extracts it
  // into `conflictedFile` so the reporter can name the colliding file without
  // parsing free prose.
  //
  // #813 fix round: it is the file a SIBLING declared. The pick that failed is
  // `failedId`, so git's named file belongs to the OTHER workstream — which is
  // the shape the coupling clause reads (a conflicted workstream colliding
  // with its own file proves nothing about the pair; see case 3).
  const CONFLICTED_FILE = failedId === "b" ? "src/a.ts" : "src/b.ts";
  const exec = async (cmd: string): Promise<{ stdout: string }> => {
    calls.push(cmd);
    if (cmd.startsWith("git rev-list")) {
      const wt = cmd.match(/--reverse --first-parent (\S+)\.\.HEAD/)?.[1] ?? "";
      const id = wt.endsWith("wt-a") ? "a" : wt.endsWith("wt-b") ? "b" : "?";
      // The SHAs must differ per workstream: `cherryPickWorkstreams` skips a
      // pick whose SHA matches a recorded `commitShas` entry, so one shared
      // SHA would have made BOTH picks skip and no conflict would ever fire.
      const sha =
        id === "a"
          ? "1111111111111111111111111111111111111111"
          : "2222222222222222222222222222222222222222";
      return { stdout: `${sha}\n` };
    }
    if (cmd.startsWith("git rev-parse HEAD"))
      return { stdout: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n" };
    if (cmd.startsWith("git rev-parse --verify")) return { stdout: "", ...{} };
    if (cmd.includes("cat-file -e")) throw new Error("not on branch");
    if (cmd.startsWith("git cherry-pick --no-commit")) {
      const sha = cmd.match(/--no-commit (\S+)/)?.[1] ?? "";
      const pickIndex = calls.filter((c) => c.startsWith("git cherry-pick --no-commit")).length;
      if (cmd.includes("--no-commit") && pickIndex >= 2) {
        const e = new Error(`could not apply ${sha}`) as Error & { stderr?: string };
        // git's empty-cherry-pick abort: the same failure whose output names
        // no path — the field must then stay absent rather than be invented.
        e.stderr =
          opts?.gitOutputWithoutFile === true
            ? "error: The previous cherry-pick is now empty, possibly due to conflict resolution"
            : `CONFLICT (content): Merge conflict in ${CONFLICTED_FILE}`;
        throw e;
      }
      return { stdout: "" };
    }
    return { stdout: "" };
  };
  return { exec, calls };
}

function runReporter(
  cons: ConsolidatedVerifyResult,
  opts: {
    worktrees: Record<string, string>;
    workstreams?: Record<
      string,
      { id: string; scope: string; paths: string[]; outOfScope: string[] }
    >;
    fenceViolations?: FenceViolationRecord[];
  },
): string[] {
  const failures: string[] = [];
  const notes: string[] = [];
  reportConsolidatedVerifyOutcome(cons, {
    cmd: "bun test",
    failures,
    notes,
    ctx: { repoRoot: "/repo" },
    worktrees: opts.worktrees,
    // #813 — the declared paths are what license the "likely coupled" clause.
    ...(opts.workstreams !== undefined ? { workstreams: opts.workstreams } : {}),
    perWorktreeFailuresByWs: {},
    singlePerWs: undefined,
    singlePerAssertion: undefined,
    ...(opts.fenceViolations !== undefined ? { fenceViolations: opts.fenceViolations } : {}),
  });
  return failures;
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-813-"));

try {
  // ──────────────────────────────────────────────────────────────────────
  // Case 1 — the REAL consolidated run, no fence record.
  //
  // Observed: the batch aborted on workstream `b` after `a` picked cleanly.
  // Required: the failure string says which pick failed and does NOT claim
  // the decomposition is incoherent.
  // ──────────────────────────────────────────────────────────────────────
  {
    const { exec } = conflictingExec("b");
    const cons = await runConsolidatedVerify(exec, {
      repoRoot: "/repo",
      baseSha: "abc1234",
      worktrees: { a: "/w/wt-a", b: "/w/wt-b" },
      scratchDir: path.join(root, "scratch-1"),
      verifyCmd: "bun test",
      timeoutMs: 60_000,
    });
    assert(
      cons.status === "conflict" && cons.kind === "conflict",
      `case 1: the injected executor produces a genuine conflict outcome (got: ${JSON.stringify(cons).slice(0, 160)})`,
    );
    const failures = runReporter(cons, {
      worktrees: { a: "/w/wt-a", b: "/w/wt-b" },
      workstreams: {
        a: { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] },
        b: { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] },
      },
    });
    const conflictFailure = failures.find((f) => /could not combine/.test(f));
    assert(
      !!conflictFailure,
      `case 1: a conflict failure string is produced (got: ${failures.join("; ")})`,
    );
    assert(
      !!conflictFailure && !/incoherent/.test(conflictFailure),
      `case 1 reporter: the no-fence failure does NOT assert "incoherent" (got: ${conflictFailure?.slice(0, 260)})`,
    );
    assert(
      !!conflictFailure && !/Two workstreams edited the same lines/.test(conflictFailure),
      `case 1 reporter: the no-fence failure does NOT assert "two workstreams edited the same lines" (got: ${conflictFailure?.slice(0, 260)})`,
    );
    assert(
      !!conflictFailure && /cherry-pick|patch-apply/.test(conflictFailure),
      `case 1 reporter: the failure states what was observed — a pick/apply that failed (got: ${conflictFailure?.slice(0, 260)})`,
    );
    assert(
      !!conflictFailure &&
        /the pick for workstream 'b' failed after 'a' applied cleanly/.test(conflictFailure),
      `case 1 reporter: the failure names WHICH pick failed (got: ${conflictFailure?.slice(0, 260)})`,
    );
    assert(
      !!conflictFailure &&
        /do NOT re-split on this alone|merge the pair|merge-and-retry/.test(conflictFailure),
      `case 1 reporter: the failure tells the operator re-splitting is not the fix (got: ${conflictFailure?.slice(0, 260)})`,
    );
    // Case 1's git output names a file and that file is a declared path, so
    // the coupling branch is the one that runs here — which is why the
    // neutral "do NOT re-split" sentence is absent. Case 1b covers the
    // branch where git named no file at all.
    assert(
      !!conflictFailure && /likely coupled/i.test(conflictFailure),
      `case 1 reporter: git's named file makes the run report the pair as coupled (got: ${conflictFailure?.slice(0, 260)})`,
    );
    assert(
      !!conflictFailure && /verified restored/.test(conflictFailure),
      `case 1 reporter: the #750 verified-restore claim still rides on the string (got: ${conflictFailure?.slice(0, 260)})`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 1b — git named NO file for the aborted pick (an empty-cherry-pick
  // abort, a index write failure: output with no path in it). The text must
  // then say so and run the neutral diagnosis — it must not invent a file.
  // ──────────────────────────────────────────────────────────────────────
  {
    const { exec: noFileExec } = conflictingExec("b", { gitOutputWithoutFile: true });
    const cons = await runConsolidatedVerify(noFileExec, {
      repoRoot: "/repo",
      baseSha: "abc1234",
      worktrees: { a: "/w/wt-a", b: "/w/wt-b" },
      scratchDir: path.join(root, "scratch-1b"),
      verifyCmd: "bun test",
      timeoutMs: 60_000,
    });
    assert(
      cons.status === "conflict" && cons.conflictedFile === undefined,
      `case 1b: output naming no path leaves the field absent (got: ${JSON.stringify(cons).slice(0, 200)})`,
    );
    const failures = runReporter(cons, {
      worktrees: { a: "/w/wt-a", b: "/w/wt-b" },
      workstreams: {
        a: { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] },
        b: { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] },
      },
    });
    const f = failures.find((x) => /could not combine/.test(x));
    assert(
      !!f && !/likely coupled/i.test(f) && /do NOT re-split on this alone/.test(f),
      `case 1b reporter: no file observed → no coupling claim, the neutral diagnosis runs (got: ${f?.slice(0, 300)})`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 3 — the pick failed in a file another workstream DECLARED → the
  // "likely coupled" diagnosis + the #1005 pointer (reporter side).
  //
  // The real observation behind "these two workstreams touch the same file"
  // is `conflictedFile`: what the batch pulled out of git's own conflict
  // output ("could not apply src/b.ts") and handed back as a field. The
  // reporters scan that field, never `cons.detail` — free prose deciding the
  // diagnosis is the #813 defect again (that is case 3b's point).
  //
  // #813 FIX ROUND — the file the pick was applying belongs to a SIBLING. The
  // fixture used to name workstream b's OWN declared path (`src/b.ts`) and the
  // assertions below pinned the clause rendering "which workstream b declared"
  // alongside `conflictedWorkstream: "b"`. That is SELF-attribution: the
  // conflicted workstream's own commit colliding with its own file is what a
  // conflict always is, so the sentence reported a tautology as a finding. The
  // clause now skips `id === conflictedWorkstream`, so this fixture names a
  // file SIBLING `a` declared — the shape the clause exists to recognise.
  // So: `src/b.ts` → `src/a.ts` here, and the three file-naming assertions
  // moved with it. This is the case the brief expected not to pin
  // self-attribution; it did, in its fixture as well as its assertions.
  // ──────────────────────────────────────────────────────────────────────
  {
    const cons: ConsolidatedVerifyResult = {
      status: "conflict",
      kind: "conflict",
      detail: "cherry-pick conflict — the batch aborted; verified restored",
      conflictedWorkstream: "b",
      appliedBeforeConflict: ["a"],
      conflictedFile: "src/a.ts",
    };
    const failures = runReporter(cons, {
      worktrees: { a: "/w/a", b: "/w/b" },
      // Workstream a — the SIBLING of the failed pick — declared the file the
      // pick was applying. That is the observation licensing the coupling claim.
      workstreams: {
        a: { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] },
        b: { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] },
      },
    });
    const f = failures.find((x) => /could not combine/.test(x));
    assert(!!f, `case 3: a conflict failure string is produced (got: ${failures.join("; ")})`);
    assert(
      !!f && !/incoherent/.test(f),
      `case 3 reporter: no "incoherent" claim (got: ${f?.slice(0, 260)})`,
    );
    assert(
      !!f && /workstream 'b' failed/.test(f) && /src\/a\.ts/.test(f),
      `case 3 reporter: names the file and its declaring workstream (got: ${f?.slice(0, 300)})`,
    );
    // The structured file is what licenses the claim — so it must render.
    assert(
      !!f && /conflict names `src\/a\.ts`/.test(f),
      `case 3 reporter: attributes the named file to its declaring workstream (got: ${f?.slice(0, 300)})`,
    );
    // And it must name the SIBLING, never the workstream whose own pick failed.
    assert(
      !!f && !/which workstream b declared/.test(f),
      `case 3 reporter: no self-attribution to the conflicted workstream (got: ${f?.slice(0, 300)})`,
    );
    assert(
      !!f && /likely coupled/i.test(f),
      `case 3 reporter: says the workstreams are LIKELY COUPLED (got: ${f?.slice(0, 260)})`,
    );
    assert(
      !!f && /#1005/.test(f) && /merge/i.test(f),
      `case 3 reporter: points at the #1005 merge behaviour (got: ${f?.slice(0, 260)})`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 3b — ungoverned prose alone does NOT license the coupling claim.
  //
  // Same conflict, same declared paths, but the batch recorded nothing about
  // which pick failed and the file name appears only inside `cons.detail`
  // (an ungoverned message the reporter embeds, never scans). Asserting
  // "likely coupled" here would be the #813 defect wearing a different hat:
  // a diagnosis presented as an observation it never made.
  // ──────────────────────────────────────────────────────────────────────
  {
    const cons: ConsolidatedVerifyResult = {
      status: "conflict",
      kind: "conflict",
      detail: "cherry-pick conflict on src/a.ts",
    };
    const failures = runReporter(cons, {
      worktrees: { a: "/w/a", b: "/w/b" },
      workstreams: {
        a: { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] },
        b: { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] },
      },
    });
    const f = failures.find((x) => /could not combine/.test(x));
    assert(!!f, `case 3b: a conflict failure string is produced (got: ${failures.join("; ")})`);
    assert(
      !!f && !/likely coupled/i.test(f),
      `case 3b reporter: a path in ungoverned detail prose does NOT assert coupling (got: ${f?.slice(0, 260)})`,
    );
    assert(
      !!f && /do NOT re-split on this alone/.test(f),
      `case 3b reporter: the neutral observed diagnosis runs instead (got: ${f?.slice(0, 260)})`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 5 — the fence-recorded branch is UNCHANGED by this fix (regression
  // guard for the pre-existing #814 attribution, reporter side; the cap
  // renderer's half of the same guard is
  // test-consolidation-conflict-cap-813.ts case 3).
  // ──────────────────────────────────────────────────────────────────────
  {
    const fence: FenceViolationRecord[] = [
      { workstreamId: "b", file: "src/a.ts", declaredById: "a", kind: "sibling-declared" },
    ];
    const cons: ConsolidatedVerifyResult = {
      status: "conflict",
      kind: "conflict",
      detail:
        "cherry-pick conflict — two workstreams edited the same lines; verified restored to abc1234",
    };
    const failures = runReporter(cons, {
      worktrees: { a: "/w/a", b: "/w/b" },
      workstreams: {
        a: { id: "a", scope: "x", paths: ["src/a.ts"], outOfScope: ["src/b.ts"] },
        b: { id: "b", scope: "y", paths: ["src/b.ts"], outOfScope: ["src/a.ts"] },
      },
      fenceViolations: fence,
    });
    const f = failures.find((x) => /could not combine/.test(x));
    assert(
      !!f && f.includes(describeSiblingFenceViolations(fence) ?? "«never»"),
      `case 5 reporter: the sibling-declared attribution still renders verbatim (got: ${f?.slice(0, 260)})`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Case 6 — the dirty-root refusal keeps its OWN wording (the routing the
  // #725 discriminator protects must not move when the conflict text moves).
  // ──────────────────────────────────────────────────────────────────────
  {
    const cons: ConsolidatedVerifyResult = {
      status: "conflict",
      kind: "dirty-root",
      detail: "repoRoot dirty: M src/x.ts",
    };
    const failures = runReporter(cons, { worktrees: { a: "/w/a" } });
    assert(
      failures.some((f) => /was refused/.test(f) && !/could not combine/.test(f)),
      `case 6: a dirty-root refusal is still reported as a refusal, not a conflict (got: ${failures.join("; ")})`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
