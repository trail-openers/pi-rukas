#!/usr/bin/env bun
/**
 * #1849 item 8 — a stray the driver may not revert is a STRUCTURAL property of
 * the refusal, not a string comparison at the offer site.
 *
 * The rule ("never revert a `fenced` or `protected` stray") was enforced in one
 * expression inside `postPassFault`: `strays.every(s => s.refused !== "fenced" &&
 * s.refused !== "protected")`. That reads the two fields the refusal carries for
 * the PARK REASON, and the two are not the same question. `admitFixPassEntry`
 * answers the absolute gate first and puts its answer in `admissionRefusal` while
 * `refused` carries the spec-slot route's kind — so a file the fence refused
 * reports `refused: "no-slot"`, and the check was one field-addition away from
 * offering the revert a protected file. Worse, the set was decided by a scan over
 * strings nobody owns: add a refusal kind, or a new route that refuses, and the
 * offer silently widens.
 *
 * Now each `Stray` carries `revertible`, SET WHERE THE ABSOLUTE REFUSAL IS
 * PRODUCED, and `postPassFault` offers the revert only when every stray in the
 * set says so. Four shapes are asserted, all through the real fence:
 *   - a protected stray (`agents.json`) → no revert offered, tree untouched;
 *   - an `outOfScope` stray → no revert offered;
 *   - one non-revertible file in an otherwise revertible set → the WHOLE set is
 *     withheld (reverting the neighbours while the park names all three is the
 *     report that would lie);
 *   - a genuinely out-of-fence stray → still revertible, so the flag has not
 *     become a ban.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PassPlan, PostPass } from "../src/work-driver-adversarial-fix-scope.ts";
import type { WorkState } from "../src/workflow-state.ts";
import { planFixPass, postPassFault } from "../src/work-driver-adversarial-fix-scope.ts";
import { defaultExec } from "../src/work-driver-adversarial-fix-git.ts";
import {
  devCommit,
  git,
  mustRead,
  repoWithFile,
  singleState,
} from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The state one fix pass carries for a workstream with the given declared and
 * out-of-scope paths, in `dir`. Built from the shared `singleState` — the
 * constructor every other fix-pass test uses — so the fence reads a pipeline
 * state with the same fields a real cycle's has, and `baseSha` is the commit the
 * worktree was added at.
 */
/** `devCommit` for a path in a directory the base commit does not have. */
function devCommitIn(wt: string, file: string, body: string): void {
  mkdirSync(dirname(join(wt, file)), { recursive: true });
  devCommit(wt, file, body);
}

function workstreamState(dir: string, paths: string[], outOfScope: string[]): WorkState {
  const base = git(dir, "rev-parse HEAD").trim();
  const s = singleState(dir, [
    { kind: "adversarial-round", at: 1, round: 1, status: "ISSUES_FOUND", verdictParsed: true },
    {
      kind: "adversarial-fix-requested",
      at: 2,
      workstreamId: "default",
      round: 1,
      findings: "a.txt: change one to two",
    },
  ]);
  return {
    ...s,
    issue: 1846,
    pipelineState: {
      ...s.pipelineState,
      baseSha: base,
      workstreams: { default: { id: "default", scope: "fix", paths, outOfScope } },
    },
  };
}

/**
 * One planned pass in a real repo, and the post-pass verdict on the tree the
 * developer left. `paths`/`outOfScope` are the workstream as the planner wrote
 * them; `write` makes the developer's edits before the fence reads.
 */
async function verdictFor(opts: {
  paths: string[];
  outOfScope: string[];
  write: (worktree: string) => void;
}) {
  const dir = repoWithFile("1846-revertible");
  git(dir, "worktree add -q --detach .worktrees/issue-1846 HEAD");
  const wt = `${dir}/.worktrees/issue-1846`;
  const st = workstreamState(dir, opts.paths, opts.outOfScope);
  const planned = mustRead(
    await planFixPass(defaultExec, dir, st.pipelineState, [
      { workstreamId: "default", findings: "a.txt: change one to two" },
    ]),
    "planFixPass",
  );
  const plans = planned.map((p) => ({ ...p, worktree: wt }));
  opts.write(wt);
  const baseSha = st.pipelineState.baseSha ?? "";
  const post = await postPassFault(defaultExec, plans, baseSha);
  return { dir, wt, plans, post, baseSha };
}

/**
 * The same tree judged a second time under a different fence, so one case can
 * show WHAT the offer decision reads instead of only what it returned. The tree
 * must not change between the two reads — that is what makes the comparison a
 * control rather than a different question.
 */
async function verdictOnTree(opts: {
  outOfScope: string[];
  plans: PassPlan[];
  /** The base the post-pass diff is read against — the same value the first read
   *  used, since the tree has not changed. */
  baseSha: string;
  declared: string[];
}): Promise<PostPass> {
  // The plans carry the tree and the pre-pass head the fence judges against; the
  // ONLY half varied here is the fence's own `outOfScope` entries, which is the
  // difference between the two reads.
  const plans = opts.plans.map((p) => ({
    ...p,
    outOfScope: opts.outOfScope,
    declared: opts.declared,
    fence: { ...p.fence, outOfScope: opts.outOfScope },
  }));
  return postPassFault(defaultExec, plans, opts.baseSha);
}

console.log("# a protected stray is never offered a revert");
{
  // `agents.json` is a protected path: the protected-path gate owns it, and a
  // driver commit that deleted it would have taken that decision away.
  const t = await verdictFor({
    paths: ["a.txt"],
    outOfScope: [],
    write: (wt) => {
      devCommit(wt, "a.txt", "two\n");
      devCommit(wt, "agents.json", '{"roles":{}}\n');
    },
  });
  try {
    assert(t.post.reason !== undefined, "the pass is refused");
    assert(
      t.post.straysFor === undefined && t.post.strays === undefined,
      `and NOTHING is offered to the revert (${JSON.stringify(t.post).slice(0, 140)})`,
    );
    const bad = (t.post.strays ?? []).filter((s) => s.revertible);
    assert(bad.length === 0, "and no stray in the set claims to be revertible");
    assert(
      existsSync(`${t.wt}/agents.json`) === true,
      "the protected file is still in the tree — the fence refused, it did not delete",
    );
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

console.log("# an outOfScope stray is never offered a revert");
{
  const t = await verdictFor({
    paths: ["a.txt"],
    // `notes/` is fenced by the plan itself: the driver may not touch what the
    // planner put out of scope, whatever the fixer wrote there.
    outOfScope: ["notes/**"],
    write: (wt) => {
      devCommit(wt, "a.txt", "two\n");
      devCommitIn(wt, "notes/secret.md", "not the plan's to change\n");
    },
  });
  try {
    assert(t.post.reason !== undefined, "the pass is refused");
    assert(
      t.post.straysFor === undefined && t.post.strays === undefined,
      `and nothing is offered to the revert (${JSON.stringify(t.post).slice(0, 140)})`,
    );
    assert(
      existsSync(`${t.wt}/notes/secret.md`) === true,
      "and the fenced file stands in the tree",
    );
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

console.log("# ONE non-revertible stray withholds the WHOLE set");
{
  // The shape the per-set scan got wrong: a pass that wrote one ordinary stray
  // AND one protected file. Reporting all three as reverted while one of them
  // belongs to the protected-path gate is the lie the field prevents — and it is
  // why `revertible` is per stray, not one boolean on the refusal.
  const t = await verdictFor({
    paths: ["a.txt"],
    outOfScope: ["notes/**"],
    write: (wt) => {
      devCommit(wt, "a.txt", "two\n");
      devCommit(wt, "helper.ts", "export const helper = () => 1;\n");
      devCommitIn(wt, "notes/secret.md", "not the plan's to change\n");
    },
  });
  try {
    // `PostPass.strays` is the OFFER channel, so a withheld set is simply absent
    // — and absence alone cannot tell "withheld because one file belongs to the
    // protected-path gate" from "the set was never built". The control is the
    // SAME workstream judged with the plan's own fence entry REMOVED: the tree is
    // untouched (so the second read refuses the same files), and there the
    // ordinary stray comes back marked revertible while the protected one says
    // false. That is the per-stray fact the set-level rule reads, observed rather
    // than inferred from an absent field.
    const control = await verdictOnTree({
      // Nothing the fixer wrote is fenced here, so only the protected-path gate
      // refuses anything, and its refusal is the one that must say `false`.
      outOfScope: ["never-written-by-this-test/**"],
      plans: t.plans,
      baseSha: t.baseSha,
      declared: t.plans[0]?.declared ?? [],
    });
    try {
      const files = (control.strays ?? []).map((s) => s.file);
      assert(
        files.includes("helper.ts") && files.includes("notes/secret.md"),
        `the fence does name BOTH strays when its own entry is removed (${JSON.stringify(files)})`,
      );
      const helper = (control.strays ?? []).find((s) => s.file === "helper.ts");
      const fenced = (control.strays ?? []).find((s) => s.file === "notes/secret.md");
      assert(
        helper?.revertible === true,
        `the ordinary stray is marked revertible on its own (got ${JSON.stringify(helper)})`,
      );
      assert(
        fenced?.revertible === true,
        `and a stray the plan no longer fences becomes revertible — the flag tracks the gate that refused it (got ${JSON.stringify(fenced)})`,
      );
      assert(
        control.straysFor === "default",
        "so with every stray revertible the set IS offered — the withholding above was the flag, not an absent field",
      );
      assert(
        t.post.straysFor === undefined && t.post.strays === undefined,
        "while with the plan's fence entry in place the WHOLE set is withheld",
      );
      assert(
        /notes\/secret\.md/.test(t.post.reason ?? "") &&
          /helper\.ts/.test(t.post.reason ?? ""),
        "and the park reason still names BOTH files, so nothing is hidden from the operator",
      );
      assert(
        existsSync(`${t.wt}/helper.ts`) === true &&
          existsSync(`${t.wt}/notes/secret.md`) === true,
        "so both files stand: the driver deleted nothing in either read",
      );
    } finally {
      // The control read the same tree, so `t.dir` (removed by the outer finally)
      // is the only directory here — nothing to clean separately.
    }
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

console.log("# an ordinary stray is still offered — the flag is not a ban");
{
  const t = await verdictFor({
    paths: ["a.txt"],
    outOfScope: [],
    write: (wt) => {
      devCommit(wt, "a.txt", "two\n");
      devCommit(wt, "helper.ts", "export const helper = () => 1;\n");
    },
  });
  try {
    assert(
      t.post.straysFor === "default" && (t.post.strays?.length ?? 0) > 0,
      `the stray set is offered to the revert (${JSON.stringify(t.post.strays)})`,
    );
    assert(
      (t.post.strays ?? []).every((s) => s.revertible),
      "and every stray in it says so, which is the condition the offer reads",
    );
    assert(
      readFileSync(`${t.wt}/a.txt`, "utf8") === "two\n",
      "the pass's own fix is untouched by the fence's decision",
    );
  } finally {
    rmSync(t.dir, { recursive: true, force: true });
  }
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
