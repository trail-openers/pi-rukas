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
import { fixPassFence, gateFenceView } from "../src/work-driver-fix-pass-admission.ts";
import { fanoutLimitFor } from "../src/work-driver-scope-fanout.ts";
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
// ── #1849 item 9 — the ceiling a helper is judged against ───────────────────
//
// `postPassFault` asks the anchored-helper route with `admit.admittedSlotCount()`
// as the denominator's slot term, but the fence OBJECT it hands the same call
// carries the `ceiling` `planFixPass` built at PLAN time, when the slot count was
// necessarily zero (a slot admits a file only once the pass runs). Those are two
// readings of one rule, and they are not equal: `fanoutLimitFor(1 + 5)` is 18,
// while the object the gate holds says 6. The one ceiling PM decision #1846-3
// asked for is the one the refusal must have been computed from, so the gate's
// view now carries the slot count that was actually used — and this asserts it
// with the real functions rather than an assertion about prose.
console.log("# the helper route's ceiling is computed from the slots it counted");
{
  // The ceiling rule is `max(declared × factor, minimum)`, so a test that wants
  // to see the slot term MOVE the ceiling has to take the floor out: with the
  // defaults (factor 3, minimum 6) one declared path and one slot both give 6 and
  // the assertion below would pass for the wrong reason.
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR = "3";
  process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN = "1";
  const slots = [{ deliverableId: "d1", slot: "src", glob: "src/*.ts" }] as never[];
  const { createSpecAdmitter } = await import("../src/work-driver-spec-slot-admission.ts");
  const admitter = createSpecAdmitter({
    slots,
    source: "test",
    isFenced: () => false,
    onAdmit: () => {},
  });
  admitter.admit("default", "src/a.ts", ["src/x.ts"]);
  admitter.admit("default", "src/b.ts", ["src/x.ts"]);
  const counted = admitter.admittedSlotCount("default");
  assert(counted === 1, `one slot that admitted two files counts as ONE (${counted})`);

  // What the plan-time object says, and what the gate must be judged by.
  const planTime = fixPassFence(
    { id: "default", declared: ["src/x.ts"], named: [], alreadyChanged: [], outOfScope: [], admittingSlots: 0 },
    fanoutLimitFor,
  );
  const withSlots = fixPassFence(
    {
      id: "default",
      declared: ["src/x.ts"],
      named: [],
      alreadyChanged: [],
      outOfScope: [],
      admittingSlots: counted,
    },
    fanoutLimitFor,
  );
  assert(
    planTime.ceiling === fanoutLimitFor(1 + 0) && withSlots.ceiling === fanoutLimitFor(1 + counted),
    `each ceiling is the documented rule over its own denominator (${planTime.ceiling} vs ${withSlots.ceiling})`,
  );
  // THE assertions. (1) A spread of the counted slots onto the plan-time view
  // changes nothing, because `ceiling` is DERIVED inside `fixPassFence` and never
  // read back off the object — which is exactly why `postPassFault` must go
  // through a spread rather than the gate's own builder. (2) `gateFenceView` —
  // the function `postPassFault` itself composes, so the numbers below ARE the
  // ones the gate is judged by — widens the ceiling to the same number the
  // standalone `fixPassFence` call produces from the same denominator.
  const gateView = gateFenceView(planTime, ["src/x.ts"], new Set(["src"]), counted);

  // A slot count is meaningless without its denominator, so the pass-level check
  // must read the accounting the VIEW was built with, not recount it. Two slots
  // over one declared path is a wider pass than zero slots over the same path,
  // and the object that carries the wider ceiling has to carry the wider count.
  const twoSlots = gateFenceView(planTime, ["src/x.ts"], new Set(["src"]), 2);
  assert(
    twoSlots.admittingSlots === 2 &&
      twoSlots.ceiling === fanoutLimitFor(1 + 2) &&
      twoSlots.ceiling > gateView.ceiling,
    `the view that reports ${twoSlots.admittingSlots} admitting slots is also the one bounded by them (${twoSlots.ceiling} over the single-slot ${gateView.ceiling})`,
  );
  const zeroSlots = gateFenceView(planTime, ["src/x.ts"], new Set(["src"]), 0);
  assert(
    zeroSlots.admittingSlots === 0,
    "and a view built with no admitting slot reports zero, which is what keeps the plan-time number honest",
  );
  const spread = { ...planTime, admittingSlots: counted };
  assert(
    spread.ceiling === planTime.ceiling,
    "spreading the counted slots onto the fence changes nothing, so a spread would have been the bug",
  );
  assert(
    gateView.ceiling === withSlots.ceiling && gateView.ceiling > planTime.ceiling,
    `the SAME pass is bounded at ${planTime.ceiling} by the plan-time ceiling and ${gateView.ceiling} once the counted slot is derived in — that gap is what item 9 closes`,
  );
  assert(
    gateView.ceilingBasis === withSlots.ceilingBasis &&
      gateView.ceilingBasis.includes("1 admitting slot"),
    `the disclosure line the gate would print says the slot it was bounded by (${gateView.ceilingBasis})`,
  );
  // A zero-slot pass is unaffected: the helper route's ceiling has to stay put
  // when there is nothing to account for.
  const unchanged = gateFenceView(planTime, [], new Set(["src"]), 0);
  assert(
    unchanged.ceiling === planTime.ceiling && unchanged.ceilingBasis === planTime.ceilingBasis,
    "with no admitting slot the re-derivation is the identity",
  );
  delete process.env.PI_ENSEMBLE_SCOPE_FANOUT_FACTOR;
  delete process.env.PI_ENSEMBLE_SCOPE_FANOUT_MIN;
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
