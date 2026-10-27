/**
 * work-driver-fix-pass-fence-render — the fix pass's fence block, rendered as
 * the prompt prints it (#1846-5, #1849 item 9).
 *
 * Split from `work-driver-fix-pass-admission.ts` for the AGENTS.md §12 size cap,
 * along a seam that already existed: that module ANSWERS "is this file inside
 * the fence" (`admitFixPassFile`, `postPassFault`'s inputs), while everything
 * here only SAYS the fence out loud to the fixer. The two are gated
 * differently — a wrong answer there is a wrong park, a wrong rendering here is
 * a prompt the fixer misreads — and the renderer needs no worktree, no git and
 * no pass delta to test.
 *
 * The contract the split must not weaken is the one
 * `test-fix-pass-prompt-fence.ts` pins: the set the prompt prints is the set
 * the gate reads, because both come from the ONE `FixPassFence` value
 * `planFixPass` built. This module takes that value as its only argument and
 * derives nothing from it, so the equality the test asserts is still an
 * equality between two readers of one object rather than between two
 * computations.
 *
 * #1852 — the renderer is PASS-NEUTRAL (PM decision #1852-3). The lens-fix step
 * runs the same fence through the same builder, and a prompt that said "this fix
 * pass" and named cap `fix-pass-park` while printed in a LENS-FIX dispatch told
 * the fixer the wrong gate: the cap its own strays park under is
 * `lens-fix-scope`. So the pass noun and the cap id are parameters now, and
 * `fixPassFenceLines` passes the words the fix pass has always printed — its
 * rendered text is byte-identical to before this change.
 */

import { neutraliseMarkdownField } from "./comment-evidence.ts";
import { tickSafe } from "./plan-fence-render.ts";
import type { FixPassFence } from "./work-driver-fix-pass-admission.ts";

/** How many paths the printed fence names for one rule before it says "more". */
const PRINTED_PATHS = 12;

/**
 * One path as the prompt prints it (#1849 item 9).
 *
 * Every path in the rendered fence came through the planner, and the planner read
 * the issue body — so a path is developer-influenced text that this module prints
 * into a prompt the fixer acts on. `neutraliseMarkdownField` is what the revert's
 * disclosure line already does for the very same names (`fixPassRevertNote`), and
 * the fence block is the other half of that disclosure: an unclosed backtick or an
 * injected heading in a declared path changes what the fixer is told it may touch.
 * The backticks stay — they mark the token as a path — and the content between
 * them is neutralised.
 *
 * `tickSafe` is the second half, and the one `neutraliseMarkdownField` does not
 * provide: it collapses only runs of three or more backticks, so a path named
 * `` a`b.ts `` used to print as `` `a`b.ts` `` — the developer's single backtick
 * closed the driver's opening span, and every character after it left the code
 * span and became prompt prose. A path is the one field a fixer reads as an
 * instruction about files, so a backtick inside one is not cosmetic: it moves the
 * rest of the line out of the span the driver intended. `tickSafe` swaps every
 * backtick for `'` before the wrapping span is added, the same rule
 * `neutraliseFenceEntry` applies to a declared path (#1744).
 */
const shown = (paths: readonly string[]): string => {
  const head = paths
    .slice(0, PRINTED_PATHS)
    .map((p) => `\`${tickSafe(neutraliseMarkdownField(p))}\``)
    .join(", ");
  return paths.length > PRINTED_PATHS ? `${head}, … (${paths.length} total)` : head;
};

/**
 * The fence block the fix prompt prints (#1846-3), rendered from the SAME
 * `FixPassFence` the fence reads. It states the four things the acceptance
 * criterion names: the admitted set, the finding-named widening inside it, the
 * two admission rules with their ceiling, and the outOfScope list.
 */
export function fixPassFenceLines(
  fence: FixPassFence,
  /** What to call the dispatch under the fence, in the heading and the refusal
   *  line. Defaults to the adversarial fix pass's own words, so the fix pass's
   *  rendered fence is unchanged; the lens-fix step passes "this lens fix". */
  passNoun = "this fix pass",
  /** The cap the fence parks the cycle under. Named so the fixer can be told
   *  the gate that will actually stop it (PM decision #1852-3). */
  capName = "fix-pass-park",
): string[] {
  const basis =
    fence.declared.length > 0
      ? "the declared paths and the files the findings name"
      : "the files this worktree already changed and the files the findings name";
  const lines = [
    "",
    `## The fence ${passNoun} is judged against`,
    "",
    `The post-pass scope fence refuses ${passNoun} (cap \`${capName}\`) unless every file you change sits in one of these:`,
    `- **admitted directly** (${basis}): ${shown(fence.admits)}`,
    "- **admitted as a coupled test**: any test file whose name couples to one of those files — its stem contains the file's whole basename (so `tests/foo.test.ts` is coupled to `pkg/foo.ts`). Always allowed; never refused for the file count.",
    `- **admitted as an anchored helper**: an undeclared file in the same directory as one of the files you are allowed to change, while the pass's total stays within ${fence.ceiling} file(s) for its ${fence.ceilingBasis}`,
  ];
  lines.push(
    fence.outOfScope.length > 0
      ? `- **never admitted**: this workstream's out-of-scope fence — ${shown(fence.outOfScope)} — and any protected path (\`.github/\`, \`.pi/\`, \`CODEOWNERS\`, \`agents.json\`). Either parks the cycle.`
      : "- **never admitted**: this workstream's out-of-scope fence (none declared) and any protected path (`.github/`, `.pi/`, `CODEOWNERS`, `agents.json`) — either parks the cycle.",
  );
  lines.push(
    "",
    `Anything outside those routes is a stray: the driver preserves it under a ref and a patch, reverts it and continues — one stray set does not park ${passNoun}, a second one does.`,
  );
  return lines;
}
