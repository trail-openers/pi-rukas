/**
 * test-reviewer-unisolated-roots-2352 — a reviewer that was NOT isolated may not
 * write into the tree it was pointed at (#2352 C2).
 *
 * `reviewer-tree.ts` fails open: a HEAD that will not resolve, or a tree git refused
 * to make, leaves the child running in the reviewed cwd. That cwd is one of the
 * guard's two roots, so on exactly the path where isolation was lost the guard judged
 * the child as if it had a throwaway tree — and the field's four shapes (a copy into
 * the project's live state dir, a redirect into it, a move of it into scratch, a
 * plant inside it) all ran.
 *
 * The spawn stamps `PI_ENSEMBLE_REVIEWER_UNISOLATED=1` on such a child (see
 * test-reviewer-unisolated-spawn-2352.ts); here is the other half — the guard reads
 * it and drops the cwd root, leaving only the child's own scratch (and the scratch
 * HOME under it) writable. An isolated reviewer, with the variable absent, keeps its
 * tree writable: this is a narrowing for the fail-open, not a new bound on a review.
 */

import assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CHILD_TMP_ENV } from "../src/write-fence-deletion.ts";
import { safeResolve } from "../src/write-fence-path.ts";
import {
  firstReviewerWriteOutside,
  registerReviewerWriteGuard,
  reviewerRootsFrom,
} from "../src/write-fence-reviewer.ts";

/** The env name the spawn writes on a fail-open (asserted literally, below). */
const UNISOLATED = "PI_ENSEMBLE_REVIEWER_UNISOLATED";

const root = mkdtempSync(path.join(tmpdir(), "uniso-2352-"));
const target = path.join(root, "target");
const state = path.join(target, ".state");
const childTmp = path.join(root, "ct");
const scratchHome = path.join(childTmp, "home");
for (const d of [state, childTmp, scratchHome]) await Bun.write(path.join(d, ".keep"), "");
await Bun.write(path.join(state, "memory.json"), '{"rows":1}');

/** The four shapes the field ran while the child sat in the reviewed tree. */
const fieldShapes = [
  `cp /etc/hostname ${state}/x`,
  `echo x > ${state}/x`,
  `mv ${state} ${childTmp}/st`,
  `touch ${state}/p`,
];

console.log("── the roots the var narrows ──");
const isolated = reviewerRootsFrom({ [CHILD_TMP_ENV]: childTmp }, target);
assert.ok(
  isolated.labels.includes(target),
  "with the var absent the cwd is a root (an isolated reviewer keeps its tree)",
);
const unisolated = reviewerRootsFrom({ [CHILD_TMP_ENV]: childTmp, [UNISOLATED]: "1" }, target);
// `allowed` is the pair of realpaths (the fixture's tmpdir is itself under a symlinked
// root), so the comparison is against the resolved scratch, not the name it was given.
assert.deepEqual(
  unisolated.allowed,
  [safeResolve(childTmp) as string],
  "the fail-open's child keeps ONLY its scratch — the reviewed cwd is the root it lost",
);
assert.ok(
  !unisolated.labels.includes(target),
  "and the reviewed cwd is not among the roots it names to the child",
);
assert.equal(
  reviewerRootsFrom({ [CHILD_TMP_ENV]: childTmp, [UNISOLATED]: "0" }, target).labels.length,
  isolated.labels.length,
  'only the literal "1" narrows, the same convention every other switch uses',
);

console.log("── the judge, with the var set ──");
for (const command of fieldShapes) {
  assert.ok(
    firstReviewerWriteOutside(command, unisolated) !== undefined,
    `refused: ${command}`,
  );
}
for (const command of fieldShapes) {
  assert.equal(
    firstReviewerWriteOutside(command, isolated),
    undefined,
    `the same command runs when the child really was isolated: ${command}`,
  );
}
assert.equal(
  firstReviewerWriteOutside(`touch ${childTmp}/notes.md`, unisolated),
  undefined,
  "its own scratch stays writable",
);
assert.equal(
  firstReviewerWriteOutside(`mkdir -p ${scratchHome}/.local/state/foo`, unisolated),
  undefined,
  "and so does the scratch HOME under it",
);
assert.equal(
  firstReviewerWriteOutside(`cat ${state}/memory.json`, unisolated),
  undefined,
  "reading the reviewed tree is still a review",
);
assert.equal(
  firstReviewerWriteOutside(`git -C ${target} status --porcelain`, unisolated),
  undefined,
  "and its git status too",
);

console.log("── the registered hook honours it too ──");
type Handler = (event: { toolName: string; input?: unknown }) => Promise<
  { block: boolean; reason?: string } | undefined
>;
const install = (env: Record<string, string>) => {
  const hooks: Handler[] = [];
  registerReviewerWriteGuard(
    { on: (_e: string, h: Handler) => hooks.push(h) } as never,
    {
      env: {
        [CHILD_TMP_ENV]: childTmp,
        PI_ENSEMBLE_ROLE: "adversarial-developer",
        PI_ENSEMBLE_WRITE_SCRATCH: childTmp,
        ...env,
      } as never,
      cwd: target,
    },
  );
  return hooks;
};

const bare = install({});
assert.equal(bare.length, 1);
for (const command of fieldShapes) {
  assert.equal(
    await bare[0]({ toolName: "bash", input: { command } }),
    undefined,
    `a child that was isolated runs it: ${command}`,
  );
}

const narrowed = install({ [UNISOLATED]: "1" });
assert.equal(narrowed.length, 1, "the hook is registered either way");
for (const command of fieldShapes) {
  const verdict = await narrowed[0]({ toolName: "bash", input: { command } });
  assert.equal(verdict?.block, true, `blocked after the fail-open: ${command}`);
  assert.ok(verdict?.reason?.startsWith("Refused:"), "with a reason the child can act on");
}
assert.equal(
  await narrowed[0]({ toolName: "bash", input: { command: `touch ${childTmp}/notes.md` } }),
  undefined,
  "the scratch is still its own",
);
const planted = await narrowed[0]({ toolName: "bash", input: { command: `touch ${target}/x` } });
assert.equal(planted?.block, true, "a plant at the reviewed tree's root is blocked too");
assert.ok(
  planted?.reason?.includes(childTmp) && !planted?.reason?.includes(target),
  "the refusal names the root it kept and never echoes the target",
);

rmSync(root, { recursive: true, force: true });
console.log("\nreviewer unisolated roots (#2352 C2): all groups passed");
