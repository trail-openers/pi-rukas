#!/usr/bin/env bun
/**
 * #1698 — the fix-pass fence admits (a) a file this cycle already created that
 * a finding names, and (b) the file a driver-dispatched corrective round's own
 * evidence named, while still refusing an unrelated new file, a protected
 * path, and a finding-named file in a non-anchored directory.
 *
 * The two reproductions (orchard #316 and run 6c / #1064): a develop round 1
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
  correctiveEvidenceFrom,
  planFixPass,
  postPassFault,
} from "../src/work-driver-adversarial-fix-scope.ts";
import { pendingFixes, runAdversarialFixPass } from "../src/work-driver-adversarial-fix.ts";
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

// 2b — the fence-level half of (b): the same admission read from the round's
// events, and its boundedness — an unnamed corrective stray still parks.
{
  const dir = repoWithFile("1698-corrective-fence");
  try {
    const st = fixState(dir, ["a.txt"], "a.txt: change one to two");
    const planned = await planFixPass(defaultExec, dir, st.pipelineState, [
      { workstreamId: "default", findings: "a.txt: change one to two" },
    ]);
    assert(planned.ok, `2b: the pre-pass reads succeeded (${planned.ok ? "" : planned.reason})`);
    if (planned.ok) {
      devCommit(dir, "a.txt", "two\n");
      commitNew(dir, "lib/ordered.ts", "export const o = 2;\n");
      const events: WorkState["eventLog"] = [
        {
          kind: "corrective-round",
          at: 1,
          step: "develop",
          workstreamId: "default",
          attempt: 1,
          command: "sh check.sh",
          evidenceLines: ["\u2717 lib/ordered.ts:12 expected two"],
        },
      ];
      const map = correctiveEvidenceFrom(events);
      assert(
        (map.default ?? "").includes("lib/ordered.ts"),
        `2b: correctiveEvidenceFrom keys the evidence by workstream (got ${JSON.stringify(map)})`,
      );
      const withEvidence = await postPassFault(defaultExec, planned.value, st.pipelineState.baseSha ?? "", map);
      assert(
        withEvidence.reason === undefined,
        `2b: the evidence-named corrective file is admitted (got "${withEvidence.reason}")`,
      );
      assert(
        withEvidence.admissions.some((a) => a.includes("lib/ordered.ts")),
        `2b: the admission is disclosed (got ${JSON.stringify(withEvidence.admissions)})`,
      );
      // Boundedness: the same pass with a file no evidence names still parks.
      const dir2 = repoWithFile("1698-corrective-stray");
      try {
        const st2 = fixState(dir2, ["a.txt"], "a.txt: change one to two");
        const planned2 = await planFixPass(defaultExec, dir2, st2.pipelineState, [
          { workstreamId: "default", findings: "a.txt: change one to two" },
        ]);
        if (!planned2.ok) throw new Error(planned2.reason);
        devCommit(dir2, "a.txt", "two\n");
        commitNew(dir2, "lib/wandered.ts", "export const w = 1;\n");
        const post2 = await postPassFault(
          defaultExec,
          planned2.value,
          st2.pipelineState.baseSha ?? "",
          map,
        );
        assert(
          post2.reason?.includes("lib/wandered.ts") === true,
          `2b: a corrective developer that wanders off its evidence still parks (got "${post2.reason}")`,
        );
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
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
    const planned = await planFixPass(defaultExec, dir, st.pipelineState, [
      { workstreamId: "default", findings: "a.txt: fix; agents.json: and this" },
    ]);
    assert(planned.ok, `4: the pre-pass reads succeeded (${planned.ok ? "" : planned.reason})`);
    if (planned.ok) {
      devCommit(dir, "a.txt", "two\n");
      devCommit(dir, "agents.json", '{"auto": true}\n');
      const post = await postPassFault(
        defaultExec,
        planned.value,
        st.pipelineState.baseSha ?? "",
        correctiveEvidenceFrom([
          {
            kind: "corrective-round",
            at: 1,
            step: "develop",
            workstreamId: "default",
            attempt: 1,
            command: "sh check.sh",
            evidenceLines: ["\u2717 agents.json:3 must stay {}"],
          },
        ]),
      );
      assert(
        post.reason?.includes("agents.json") === true,
        `4: a protected path is refused even when the finding and the corrective evidence name it (got "${post.reason}")`,
      );
    }
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

console.log(`\nexit ${exit}`);
process.exit(exit);
