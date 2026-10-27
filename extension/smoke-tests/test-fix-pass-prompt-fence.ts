#!/usr/bin/env bun
/**
 * #1846 PM decision 5 — the fence printed in the fix prompt IS the fence the
 * post-pass gate reads, and a test asserts EQUALITY, not mere presence.
 *
 * Before this, `overlayWorkstreams` handed the developer a workstream whose
 * `paths` came from one reading (`plan.declared ∪ plan.widened`) while
 * `postPassFault` rebuilt its own `allowed` list from a second reading
 * (`declared.map(cleaned) ∪ named`, or `before.names ∪ named` when nothing was
 * declared). Two renderings of one rule is exactly how a fixer is told one set
 * and refused by another — the field shape this issue reports: a pass told to
 * "resolve the listed findings and change nothing else", parked for a file the
 * prompt never named and the gate never admitted.
 *
 * Both sides now read ONE `FixPassFence` object built in `planFixPass`. These
 * cases assert the two-sided contract:
 *
 *   1. the prompt block names exactly `plan.fence.admits` — every entry, and
 *      nothing the fence does not admit (a printed path the gate refuses is the
 *      more expensive direction of the same drift);
 *   2. the printed ceiling equals the value the fan-out check computes;
 *   3. the prompt block states both admission routes and the outOfScope list;
 *   4. the routes the prompt describes are the routes `admitFixPassFile`
 *      actually takes, on the same fence, for a coupled test and a helper.
 */

import { mkdirSync, rmSync } from "node:fs";
import {
  type FixPassFence,
  admitFixPassFile,
  fixPassFence,
  fixPassFenceLines,
} from "../src/work-driver-fix-pass-admission.ts";
import {
  overlayWorkstreams,
  planFixPass,
} from "../src/work-driver-adversarial-fix-scope.ts";
import { defaultExec } from "../src/work-driver-adversarial-fix-git.ts";
import { fanoutLimitFor } from "../src/work-driver-scope-fanout.ts";
import { inlineDevelopPrompt } from "../src/work-driver-prompts-early.ts";
import { devCommit, fixState, repoWithFile } from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The fence block as the fix prompt renders it, from the overlay the pass builds. */
function fenceBlock(fence: FixPassFence): string {
  // Positional order is `… fixFindings, interruptedNote, fastVerifyCmd, options`;
  // the two notes are `undefined` and the fence rides in `options`.
  return inlineDevelopPrompt(
    [1846],
    "/tmp/scratch",
    { id: "default", scope: "fix the findings", paths: [], outOfScope: [] },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "a.txt: change one to two",
    undefined,
    undefined,
    { fixFenceLines: fixPassFenceLines(fence) },
  );
}

/** Every backticked path the fence block names — the set the fixer is told. */
const printedPaths = (block: string): string[] =>
  [...block.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");

// ── 1/3 — the declared shape: prompt names the fence's own set, verbatim ────
{
  const dir = repoWithFile("prompt-fence-declared");
  try {
    mkdirSync(`${dir}/lib`, { recursive: true });
    devCommit(dir, "lib/a.ts", "export const a = 1;\n");
    const st = fixState(dir, ["lib/a.ts", "a.txt"], "lib/a.ts: fix it; a.txt: and this");
    const planned = await planFixPass(defaultExec, dir, st.pipelineState, [
      { workstreamId: "default", findings: "lib/a.ts: fix it; a.txt: and this" },
    ]);
    if (!planned.ok) {
      assert(false, `the pre-pass read failed (${planned.reason})`);
    } else {
      const plan = planned.value[0] as NonNullable<(typeof planned.value)[number]>;
      const overlay = overlayWorkstreams(st.pipelineState.workstreams, planned.value);
      const lines = overlay.default?.fixFenceLines ?? [];
      assert(lines.length > 0, "1: the fix overlay carries a fence block at all");
      const block = fenceBlock(plan.fence);

      // EQUALITY, one direction: everything the fence admits is printed.
      const printed = printedPaths(block);
      const missing = plan.fence.admits.filter((p) => !printed.includes(p));
      assert(
        missing.length === 0,
        `1: every path the gate admits is printed in the prompt — missing ${JSON.stringify(missing)}`,
      );

      // EQUALITY, the other direction: the fence block's *admitted-directly*
      // line names exactly `fence.admits`. Other backticked tokens in the block
      // are rule vocabulary (`dir/**`, protected-path names), so the assertion
      // reads the admitted line rather than the whole block.
      const admittedLine = lines.find((l) => l.includes("**admitted directly**")) ?? "";
      const linePaths = [...admittedLine.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
      assert(
        linePaths.length === plan.fence.admits.length &&
          plan.fence.admits.every((p) => linePaths.includes(p)),
        `1: the admitted-directly line equals fence.admits exactly (line ${JSON.stringify(linePaths)}, fence ${JSON.stringify(plan.fence.admits)})`,
      );

      // 2: the printed ceiling is the value the fan-out check computes.
      const limit = fanoutLimitFor(plan.declared.length + 0);
      assert(
        block.includes(`within ${limit} file(s)`),
        `2: the prompt states the ceiling the gate enforces (${limit}) — got the block without it`,
      );

      // 3: the prompt states both routes and the fence it never lifts.
      assert(
        /admitted as a coupled test/i.test(block) && /admitted as an anchored helper/i.test(block),
        "3: the prompt states both admission routes by name",
      );
      assert(
        /never admitted/i.test(block) &&
          (plan.outOfScope.length === 0 ||
            plan.outOfScope.every((e) => block.includes(e.split("/").pop() ?? e))),
        "3: the prompt states the out-of-scope entries the pass may not touch",
      );
      assert(
        /protected path/i.test(block) && block.includes("agents.json"),
        "3: the prompt names the protected paths, which no route lifts",
      );

      // 4: the routes the prompt DESCRIBES are the routes the gate TAKES.
      // A coupled test the pass itself created: admitted, and by the route the
      // prompt said would admit it.
      const withDelta: FixPassFence = {
        ...plan.fence,
        passChanged: ["lib/a.ts", "lib/a.test.ts", "lib/helper.ts"],
      };
      const test = admitFixPassFile("lib/a.test.ts", withDelta, 3);
      assert(
        test.admitted && test.route === "coupled-test",
        `4: a test coupled by name to a file this pass changed is admitted as the prompt says (got ${JSON.stringify(test)})`,
      );
      const helper = admitFixPassFile("lib/helper.ts", withDelta, 3);
      assert(
        helper.admitted && helper.route === "anchored-helper",
        `4: a helper beside a file the pass was asked to change is admitted as the prompt says (got ${JSON.stringify(helper)})`,
      );
      // And the prompt's promise about the fence: it is absolute.
      const fencedView: FixPassFence = {
        ...plan.fence,
        outOfScope: ["lib"],
        passChanged: ["lib/a.ts", "lib/secret.ts"],
      };
      assert(
        !admitFixPassFile("lib/secret.ts", fencedView, 1).admitted,
        "4: the prompt's `never admitted` promise holds — a fenced file is refused",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 5 — the prompt-time view admits nothing on its own: routes, not files ───
{
  // The prompt-time fence has no pass delta. If `admitFixPassFile` admitted
  // anything from it, the prompt and the gate would be reading two different
  // sets again and this file's whole premise would be false.
  const fence = fixPassFence(
    {
      id: "default",
      declared: ["lib/a.ts"],
      named: [],
      alreadyChanged: ["lib/a.ts"],
      outOfScope: [],
      admittingSlots: 0,
    },
    fanoutLimitFor,
  );
  assert(
    !admitFixPassFile("lib/a.test.ts", fence, 1).admitted,
    "5: the prompt-time fence (no pass delta) admits nothing — only the gate's delta does",
  );
  assert(
    fence.admits.includes("lib/a.ts"),
    "5: the prompt-time fence still states the direct set the fixer is told",
  );

  // 6: the number the prompt prints for the ceiling is the number the gate will
  // enforce for THAT slot count. The plan-time view is built with zero slots (a
  // pass has not admitted anything yet); recomputing with the slots the pass
  // actually used must move the printed ceiling, or the fixer is told a budget
  // the gate is not using and the ceiling silently widens past what anyone
  // read.
  const withSlots = fixPassFence(
    {
      id: "default",
      declared: ["lib/a.ts"],
      named: [],
      alreadyChanged: ["lib/a.ts"],
      outOfScope: [],
      admittingSlots: 2,
    },
    fanoutLimitFor,
  );
  assert(
    withSlots.ceiling === fanoutLimitFor(1 + 2) && withSlots.ceiling > fence.ceiling,
    `6: the ceiling follows the admitting slots (got ${withSlots.ceiling} vs ${fence.ceiling}; expected ${fanoutLimitFor(3)})`,
  );
  assert(
    fixPassFenceLines(withSlots).some((l) => l.includes(`${withSlots.ceiling} file(s)`)),
    "6: and the printed line states THAT number, not the plan-time one",
  );
}

// ── 7 — a backtick in a declared path cannot close the span it is printed in ──
{
  // #1849 item 4. The fence block wraps every path in `\`…\``. A single backtick
  // survives `neutraliseMarkdownField` (it collapses only runs of three or more,
  // which are code FENCES), so a path named `` src/a`b.ts `` used to print as
  // `` `src/a`b.ts` ``: the developer's backtick closed the driver's opening span
  // and `b.ts` — plus the rest of the line, including the driver's own rule text —
  // left the code span and read as prose the fixer acts on. An ODD count is the
  // breaking case; an even one re-closes and looks harmless, which is why the
  // fixture uses one backtick.
  const ticked = fixPassFence(
    {
      id: "default",
      declared: ["src/a`b.ts", "lib/c``d.ts"],
      named: [],
      alreadyChanged: [],
      outOfScope: ["docs/e`f.md"],
    },
    fanoutLimitFor,
  );
  const lines = fixPassFenceLines(ticked);
  const admitted = lines.find((l) => l.includes("**admitted directly**")) ?? "";
  const never = lines.find((l) => l.includes("**never admitted**")) ?? "";
  for (const [label, line] of [
    ["admitted directly", admitted],
    ["never admitted", never],
  ] as const) {
    // Every span the regex can pair off must be a whole path: if a backtick
    // survived inside one, the pairing itself breaks (an odd number of backticks
    // on the line leaves a dangling span the fixer reads as prose).
    const spans = [...line.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? "");
    assert(
      spans.every((s) => !s.includes("`")) &&
        (line.match(/`/g)?.length ?? 0) % 2 === 0,
      `7: a backtick in a ${label} path cannot close its code span — every span is balanced (${JSON.stringify(line)})`,
    );
  }
  assert(
    admitted.includes("src/a'b.ts") && never.includes("docs/e'f.md"),
    `7: the paths are still printed and readable with the backtick substituted (${JSON.stringify(admitted)}, ${JSON.stringify(never)})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
