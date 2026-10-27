/**
 * #1852 — the fence module's own contract.
 *
 * The prompt/gate equality is pinned in `test-lens-fix-prompt-fence.ts`; this
 * file pins the two rules the LENS fix adds on top of the fix pass's fence, and
 * that no fix-pass test can see:
 *
 *   - the base is the ROUND TIP, not the cycle base (PM decision #1852-2), so
 *     the round's own earlier commits are not strays;
 *   - the workstream whose recorded tree IS the lens tree is the one whose
 *     declared paths fence the fixer (#1852-8), which is a lookup by realpath
 *     and not by position in a record.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultExec } from "../src/work-driver-adversarial-fix-git.ts";
import {
  lensFixFenceLines,
  lensFixPassPlan,
  lensFixWorkstreamId,
} from "../src/work-driver-lens-fix-fence.ts";
import { initialState } from "../src/workflow-state.ts";
import { git, repoWithFile } from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FINDINGS = '[{"path":"a.txt","severity":"MEDIUM","title":"t","suggestion":"s"}]';

console.log("# the round tip is the base, so the round's own commits are not strays");
{
  const repoRoot = repoWithFile("fence-tip");
  const tree = `${repoRoot}/.worktrees/issue-1852`;
  git(repoRoot, "worktree add -q --detach .worktrees/issue-1852 HEAD");
  writeFileSync(`${tree}/a.txt`, "develop\n");
  git(tree, "add -A");
  git(tree, 'commit -q -m "develop: the feature"');
  const roundTip = git(tree, "rev-parse HEAD").trim();
  const cycleBase = git(repoRoot, "rev-parse main").trim();
  assert(roundTip !== cycleBase, "non-vacuity: the round tip differs from the cycle base");
  const s = initialState(1852, 1_000_000);
  const ps = {
    ...s.pipelineState,
    baseSha: cycleBase,
    worktrees: { default: tree },
    workstreams: {
      default: { id: "default", scope: "fix", paths: ["a.txt"], outOfScope: ["b.txt"] },
    },
  };
  const planned = await lensFixPassPlan(defaultExec, repoRoot, ps, {
    id: "default",
    worktree: tree,
    roundTip,
    findings: FINDINGS,
  });
  assert(planned.ok, `the plan builds (reason: ${planned.ok ? "" : planned.reason})`);
  if (planned.ok) {
    assert(
      planned.value.headBefore === roundTip,
      "headBefore is the round tip, not the cycle base",
    );
    // The develop commit changed a.txt against the cycle base but NOTHING
    // against the round tip: measuring the delta from the wrong end would
    // report the cycle's own earlier work as a change this fixer made.
    assert(
      planned.value.candidates.has("a.txt"),
      "candidates (the provenance route) come from the CYCLE base, independent of the round tip the delta is measured from",
    );
    const lines = lensFixFenceLines(planned.value);
    assert(
      lines.some((l) => l.includes("a.txt")) && lines.some((l) => l.includes("b.txt")),
      "the render names both the declared path and the out-of-scope entry",
    );
  }
  rmSync(repoRoot, { recursive: true, force: true });
}

console.log("# the workstream is found by its recorded tree, not by position");
{
  const a = mkdtempSync(path.join(tmpdir(), "1852-wt-"));
  assert(
    lensFixWorkstreamId({ wsB: "/x/.worktrees/b", wsA: "/x/.worktrees/a" }, "/x/.worktrees/a") ===
      "wsA",
    "the id whose path names the lens tree wins, whatever order the record is in",
  );
  // A path that differs only in spelling — a trailing slash, a `..` segment —
  // is the same tree, and a fence keyed on the lexical form would silently find
  // no workstream and dispatch unfenced.
  assert(
    lensFixWorkstreamId({ default: "/x/.worktrees/a/" }, "/x/.worktrees/a") === "default",
    "a trailing slash on the recorded path still matches",
  );
  assert(
    lensFixWorkstreamId({ default: "/x/.worktrees/a" }, "/x/.worktrees/issue-1852/../a") ===
      "default",
    "a `..` segment in the lens tree path still matches (compared by resolve)",
  );
  assert(
    lensFixWorkstreamId({ default: "/x/.worktrees/a" }, "/x/.worktrees/b") === undefined,
    "no match yields undefined rather than guessing the first key",
  );
  assert(lensFixWorkstreamId({}, "/x") === undefined, "an empty map yields undefined");
  rmSync(a, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
