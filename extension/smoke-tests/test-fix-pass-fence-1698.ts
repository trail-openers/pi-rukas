#!/usr/bin/env bun
/**
 * #1698 — the fix-pass fence admits (a) a file this cycle already created that
 * a finding names, and (b) the file a driver-dispatched corrective round's own
 * evidence named, while still refusing an unrelated new file, a protected
 * path, and a finding-named file in a non-anchored directory.
 *
 * The two reproductions (tehas #316 and run 6c / #1064): a develop round 1
 * creates a file; the adversarial finding names it; the fix pass edits it to
 * satisfy the finding — and `namedPaths` refused, because the candidate set
 * was the tree tracked AT base and a file the cycle created is never in it.
 * And in run 6c the driver dispatched a corrective round whose evidence told
 * the child to change a file, then capped the cycle for changing it, because
 * `headBefore` predates the round and the round's commit landed in the
 * fix-pass stray set.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import type { CycleContext, DriverContext } from "../src/work-driver-context.ts";
import { defaultExec } from "../src/work-driver-adversarial-fix-git.ts";
import {
  planFixPass,
  postPassFault,
} from "../src/work-driver-adversarial-fix-scope.ts";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
import { parkFixPass } from "../src/work-driver-adversarial-plumb.ts";
import type { CorrectiveRoundEvent } from "../src/workflow-state-events-corrective.ts";
import type { WorkState } from "../src/workflow-state.ts";
import {
  devCommit,
  devOk,
  fixState,
  git,
  repoWithFile,
} from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** devCommit for a file in a directory the fixture repo does not have yet. */
function commitNew(dir: string, file: string, body: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  devCommit(dir, file, body);
}

/** The commit a worktree is at right now — what a corrective record stores. */
const headNow = (dir: string): string => git(dir, "rev-parse HEAD").trim();

/** One `corrective-round` record as the driver writes it, baseline included. */
function round(id: string, lines: string[], headAtRound?: string): CorrectiveRoundEvent {
  return {
    kind: "corrective-round",
    at: 1,
    step: "develop",
    workstreamId: id,
    attempt: 1,
    command: "sh check.sh",
    evidenceLines: lines,
    ...(headAtRound === undefined ? {} : { headAtRound }),
  };
}

/**
 * An early assert for a fence read that must succeed: a failed pre-pass read
 * means the FIXTURE is broken, not the rule under test, so there is nothing
 * left to assert and the case stops here instead of reading a `planned.value`
 * that does not exist.
 */
function must<T>(read: { ok: true; value: T } | { ok: false; reason: string }, label: string): T {
  if (!read.ok) {
    assert(false, `${label}: the read failed (${read.reason})`);
    throw new Error(`${label}: ${read.reason}`);
  }
  assert(true, `${label}: the pre-pass reads succeeded`);
  return read.value;
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

async function runPass(dir: string, st: WorkState, onDev: (d: string, call: number) => void) {
  let calls = 0;
  const ctx: DriverContext = {
    host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
    repoRoot: dir,
    issue: 1698,
    issueBodyFetcherFn: async () => ({ stdout: "mock" }),
    dispatchFn: async (_pi, spec) => {
      if (spec.role === "developer") {
        calls++;
        onDev(dir, calls);
      }
      return devOk(spec.role) as DispatchResult;
    },
  };
  // The develop-side ctx the fix pass needs is a CycleContext; the fixture
  // builds the driver-shaped half, as every sibling fix-pass test does.
  const out = await runAdversarialFixPass(
    ctx as unknown as CycleContext,
    st,
    pendingFixes(st.eventLog),
    Date.now(),
  );
  const tail = out.eventLog[out.eventLog.length - 1];
  return {
    out,
    applied: tail?.kind === "adversarial-fix-applied",
    parked: tail?.kind === "cap-hit" ? (tail.evidence ?? "") : "",
  };
}

// 1 — round 1 created pkg/new.ts (a commit after base); a finding names it;
// the fix pass edits it. The pass applies: the cycle-created file is a
// widening candidate because `committedChanges(base..headBefore)` joins the
// tree tracked at base. Before #1698 this parked fix-pass-park.
{
  const dir = repoWithFile("1698-cycle-created");
  try {
    mkdirSync(path.join(dir, "pkg"), { recursive: true });
    writeFileSync(path.join(dir, "pkg", "existing.ts"), "export {};\n");
    git(dir, "add -A");
    git(dir, "commit -q -m \"the declared scope\"");
    // fixState records base at THIS commit; the round-1 commit below is after it.
    const st = fixState(dir, ["pkg/existing.ts"], "pkg/existing.ts: fix; pkg/new.ts: and this");
    devCommit(dir, "pkg/new.ts", "export const n = 1;\n");
    const r = await runPass(dir, st, (d) => devCommit(d, "pkg/new.ts", "export const n = 2;\n"));
    assert(
      r.applied,
      `1: a finding naming a file this cycle created admits the fix-pass edit (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2 — a corrective round the driver dispatched INSIDE the fix pass edits the
// file its own evidence named. The cycle does not park: the driver cannot
// order the edit and then cap the cycle for making it. The verify command is
// the #1667 stand-in shape: it fails with a ✗ line naming tools/fixme.ts
// until that file exists; the corrective developer (the second developer
// dispatch) writes exactly that file.
{
  const dir = repoWithFile("1698-corrective");
  try {
    writeFileSync(
      path.join(dir, "check.sh"),
      '#!/bin/sh\n# Green at base (a.txt is still "one"); fails only once the fix pass\n# made its declared edit, until the file the verify output names exists.\nif [ "$(cat a.txt)" = "two" ] && ! grep -q two tools/fixme.ts 2>/dev/null; then\n  echo "FAILED: fixme"\n  echo "\u2717 tools/fixme.ts:57 expected two"\n  exit 1\nfi\nexit 0\n',
    );
    writeFileSync(path.join(dir, ".pi", "verify-cmd"), "sh check.sh\n");
    git(dir, "add -A");
    git(dir, "commit -q -m \"the verify stand-in\"");
    const st = fixState(dir, ["a.txt"], "a.txt: change one to two");
    const r = await runPass(dir, st, (d, call) => {
      if (call === 1) devCommit(d, "a.txt", "two\n");
      else commitNew(d, path.join("tools", "fixme.ts"), "two\n");
    });
    assert(
      r.out.eventLog.some((e) => e.kind === "corrective-round"),
      "2: the corrective round actually ran (the fixture exercises the real path)",
    );
    assert(
      r.applied,
      `2: the corrective round's evidence-named file is not a fix-pass stray (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2b — the fence-level half of (b), and its two bounds. The corrective file is
// committed AFTER the `corrective-round` record's `headAtRound`, which is what
// makes it the round's own work; a file committed BEFORE the round, or a file
// the evidence never named, is still a stray.
{
  const dir = repoWithFile("1698-corrective-fence");
  try {
    const st = fixState(dir, ["a.txt"], "a.txt: change one to two");
    const planned = must(
      await planFixPass(defaultExec, dir, st.pipelineState, [
        { workstreamId: "default", findings: "a.txt: change one to two" },
      ]),
      "2b",
    );
    // The fix pass's own edit, then the round's record, then the round's edit.
    devCommit(dir, "a.txt", "two\n");
    const baseline = headNow(dir);
    const events = [round("default", ["\u2717 lib/ordered.ts:12 expected two"], baseline)];
    commitNew(dir, "lib/ordered.ts", "export const o = 2;\n");
    const withEvidence = await postPassFault(defaultExec, planned, st.pipelineState.baseSha ?? "", events);
    assert(
      withEvidence.reason === undefined,
      `2b: a file the round named AND committed after its baseline is admitted (got "${withEvidence.reason}")`,
    );
    assert(
      withEvidence.admissions.some((a) => a.includes("lib/ordered.ts")),
      `2b: the admission is disclosed (got ${JSON.stringify(withEvidence.admissions)})`,
    );
    // Boundedness 1 — the same pass with a file no evidence names still parks.
    const dir2 = repoWithFile("1698-corrective-stray");
    try {
      const st2 = fixState(dir2, ["a.txt"], "a.txt: change one to two");
      const planned2 = must(
        await planFixPass(defaultExec, dir2, st2.pipelineState, [
          { workstreamId: "default", findings: "a.txt: change one to two" },
        ]),
        "2b (unnamed)",
      );
      devCommit(dir2, "a.txt", "two\n");
      commitNew(dir2, "lib/wandered.ts", "export const w = 1;\n");
      const post2 = await postPassFault(
        defaultExec,
        planned2,
        st2.pipelineState.baseSha ?? "",
        events,
      );
      assert(
        post2.reason?.includes("lib/wandered.ts") === true,
        `2b: a corrective developer that wanders off its evidence still parks (got "${post2.reason}")`,
      );
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
    // Boundedness 2 — a file the evidence names but that was committed BEFORE
    // the round started is not the round's work: the pass wrote it. It parks,
    // and the park says so rather than blaming the slot.
    const dir3 = repoWithFile("1698-corrective-pre-round");
    try {
      const st3 = fixState(dir3, ["a.txt"], "a.txt: change one to two");
      const planned3 = must(
        await planFixPass(defaultExec, dir3, st3.pipelineState, [
          { workstreamId: "default", findings: "a.txt: change one to two" },
        ]),
        "2b (pre-round)",
      );
      // Named by the evidence, changed by the PASS — before the baseline.
      commitNew(dir3, "lib/early.ts", "export const e = 1;\n");
      devCommit(dir3, "a.txt", "two\n");
      const baseline3 = headNow(dir3);
      const post3 = await postPassFault(defaultExec, planned3, st3.pipelineState.baseSha ?? "", [
        round("default", ["\u2717 lib/early.ts:1 expected two", "\u2717 lib/ordered.ts:2 two"], baseline3),
      ]);
      // ...and committed after the baseline it WOULD be admitted, so plant the
      // post-round file too and assert the pre-round one is the one refused.
      commitNew(dir3, "lib/ordered.ts", "export const o = 2;\n");
      const post3b = await postPassFault(defaultExec, planned3, st3.pipelineState.baseSha ?? "", [
        round("default", ["\u2717 lib/early.ts:1 expected two", "\u2717 lib/ordered.ts:2 two"], baseline3),
      ]);
      assert(
        post3.reason?.includes("lib/early.ts") === true,
        `2b: a file named by the evidence but committed BEFORE the round still parks (got "${post3.reason}")`,
      );
      assert(
        post3b.reason?.includes("lib/early.ts") === true &&
          !post3b.admissions.some((a) => a.includes("lib/early.ts")),
        `2b: the pre-round file is refused while its post-round sibling is admitted (reason "${post3b.reason}", admissions ${JSON.stringify(post3b.admissions)})`,
      );
      assert(
        post3b.reason?.includes("not committed after the corrective round") === true,
        `2b: the park names the corrective bound it refused under (got "${post3b.reason}")`,
      );
    } finally {
      rmSync(dir3, { recursive: true, force: true });
    }
    // Boundedness 3 — no baseline at all (a record from before #1698(b), or a
    // HEAD the driver could not read) admits nothing, and says which.
    const dir4 = repoWithFile("1698-corrective-no-baseline");
    try {
      const st4 = fixState(dir4, ["a.txt"], "a.txt: change one to two");
      const planned4 = must(
        await planFixPass(defaultExec, dir4, st4.pipelineState, [
          { workstreamId: "default", findings: "a.txt: change one to two" },
        ]),
        "2b (no baseline)",
      );
      devCommit(dir4, "a.txt", "two\n");
      commitNew(dir4, "lib/ordered.ts", "export const o = 2;\n");
      const post4 = await postPassFault(defaultExec, planned4, st4.pipelineState.baseSha ?? "", [
        round("default", ["\u2717 lib/ordered.ts:12 expected two"]),
      ]);
      assert(
        post4.reason?.includes("lib/ordered.ts") === true &&
          post4.reason?.includes("no usable HEAD baseline") === true,
        `2b: a round with no valid headAtRound admits nothing and names it (got "${post4.reason}")`,
      );
    } finally {
      rmSync(dir4, { recursive: true, force: true });
    }
    // Boundedness 4 — one round is a bounded authorisation: the fourth
    // evidence-named file is refused with the cap named, never taken silently.
    const dir5 = repoWithFile("1698-corrective-cap");
    try {
      const st5 = fixState(dir5, ["a.txt"], "a.txt: change one to two");
      const planned5 = must(
        await planFixPass(defaultExec, dir5, st5.pipelineState, [
          { workstreamId: "default", findings: "a.txt: change one to two" },
        ]),
        "2b (cap)",
      );
      devCommit(dir5, "a.txt", "two\n");
      const baseline5 = headNow(dir5);
      const named = ["lib/one.ts", "lib/two.ts", "lib/three.ts", "lib/four.ts"];
      for (const f of named) commitNew(dir5, f, "export const v = 1;\n");
      const post5 = await postPassFault(defaultExec, planned5, st5.pipelineState.baseSha ?? "", [
        round(
          "default",
          named.map((f) => `\u2717 ${f}:1 two`),
          baseline5,
        ),
      ]);
      assert(
        named.some((f) => post5.reason?.includes(f)) === true &&
          post5.reason?.includes("already admitted its 3") === true,
        `2b: the fourth evidence-named file is refused with the cap named (got "${post5.reason}")`,
      );
      assert(
        post5.admissions.length === 3 &&
          named.filter((f) => post5.admissions.some((a) => a.includes(f))).length === 3,
        `2b: exactly CORRECTIVE_ADMIT_MAX admissions are disclosed (got ${JSON.stringify(post5.admissions)})`,
      );
    } finally {
      rmSync(dir5, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 3 — the fix pass's own NEW file, named by no finding and no spec slot and
// outside the declared paths, is still refused: (a) admits only what the
// cycle already committed, not what the pass invents.
{
  const dir = repoWithFile("1698-unrelated-new");
  try {
    mkdirSync(path.join(dir, "pkg"), { recursive: true });
    writeFileSync(path.join(dir, "pkg", "existing.ts"), "export {};\n");
    git(dir, "add -A");
    git(dir, "commit -q -m \"the declared scope\"");
    const st = fixState(dir, ["pkg/existing.ts"], "pkg/existing.ts: fix it");
    const r = await runPass(dir, st, (d) => {
      devCommit(d, "pkg/existing.ts", "export const e = 2;\n");
      commitNew(d, path.join("tests", "pass-own.test.ts"), "export const t = 1;\n");
    });
    assert(
      !r.applied && r.parked.includes("pass-own.test.ts"),
      `3: the fix pass's own new file outside the declared paths is still refused (got "${r.parked}")`,
    );
    assert(
      !r.applied && r.parked.includes("No finding names"),
      `3: the park says no finding names the invented file (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4 — protected paths stay refused even when a finding names them AND the
// corrective round's evidence names them: neither widening reaches them.
{
  const dir = repoWithFile("1698-protected");
  try {
    writeFileSync(path.join(dir, "agents.json"), "{}\n");
    git(dir, "add -A");
    git(dir, 'commit -q -m "protected file"');
    const st = fixState(dir, ["a.txt"], "a.txt: fix; agents.json: and this");
    const planned = must(
      await planFixPass(defaultExec, dir, st.pipelineState, [
        { workstreamId: "default", findings: "a.txt: fix; agents.json: and this" },
      ]),
      "4",
    );
    devCommit(dir, "a.txt", "two\n");
    devCommit(dir, "agents.json", '{"auto": true}\n');
    const post = await postPassFault(
      defaultExec,
      planned,
      st.pipelineState.baseSha ?? "",
      [
        round(
          "default",
          ["\u2717 agents.json:3 must stay {}"],
          git(dir, "rev-parse HEAD~1").trim(),
        ),
      ],
    );
    assert(
      post.reason?.includes("agents.json") === true,
      `4: a protected path is refused even when the finding and the corrective evidence name it (got "${post.reason}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 5 — a finding naming a tracked file in a NON-anchored directory still parks:
// the directory-anchor condition survives the widening.
{
  const dir = repoWithFile("1698-unanchored");
  try {
    mkdirSync(path.join(dir, "lib"), { recursive: true });
    writeFileSync(path.join(dir, "lib", "verify.ts"), "export {};\n");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "a.ts"), "export {};\n");
    git(dir, "add -A");
    git(dir, 'commit -q -m "dirs"');
    const st = fixState(dir, ["src/a.ts"], "src/a.ts: fix; lib/verify.ts: and this");
    const r = await runPass(dir, st, (d) => {
      devCommit(d, "src/a.ts", "export const a = 2;\n");
      devCommit(d, "lib/verify.ts", "export const v = 2;\n");
    });
    assert(
      !r.applied && r.parked.includes("lib/verify.ts"),
      `5: a finding-named file in a non-anchored directory still parks (got "${r.parked}")`,
    );
    assert(
      !r.applied && r.parked.includes("does not widen the fence"),
      `5: the park states the widening rule it refused under (got "${r.parked}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 6 — a PARKED pass still discloses what it admitted. The refusals reach the
// handoff through the park reason; the authorisations reached it through
// nothing at all, so a fence that widened looked identical to one that did not.
{
  const dir = repoWithFile("1698-admissions-survive-park");
  try {
    const st = fixState(dir, ["a.txt"], "a.txt: fix");
    const parked = parkFixPass(
      st,
      [{ workstreamId: "default", round: 1, findings: "a.txt: change one to two" }],
      "the pass changed something outside its fence",
      Date.now(),
      ["default: lib/ordered.ts admitted — the corrective round's evidence named it"],
    );
    const report = (parked.pipelineState.plumbReports ?? []).at(-1)?.body ?? "";
    assert(
      report.includes("lib/ordered.ts") && report.includes("What the pass admitted"),
      `6: the parked report carries the admission alongside the refusal (got "${report}")`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
