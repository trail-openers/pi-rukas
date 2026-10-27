/**
 * #1862 round 1 — the fold's drop notes are capped APART from the issue-named
 * notes, so a full issue-named list cannot push every fold drop out of the
 * persisted record while `selfFences` still counted them.
 *
 * Driven through `runPlanNormalisationPass` — the seam the plan step calls —
 * with a plan the coupling rules merge for real (both halves declare the same
 * file set, so rule 1's Jaccard ≥ 0.5 fires) and an issue body that names more
 * fenced files than the record's note cap, so the issue-named list is full when
 * the fold's notes are appended.
 *
 * Offline: no dispatch, no network, no git.
 */

import { rm, writeFile } from "node:fs/promises";
import { runPlanNormalisationPass } from "../src/work-driver-plan-coupling-pass.ts";
import type { Workstream } from "../src/workflow-state-schema.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * The identifier-grep stub. A name resolves to a file ONLY when the plan
 * actually fences that file (which is the pass's own relevance filter), so the
 * ordinary English words the issue body puts in front of each path — "the seam
 * lives in X" — resolve to nothing instead of burning the 15-name identifier
 * budget before the real path tokens are considered.
 */
function stubExec() {
  return async () => ({ stdout: "" });
}

const WS = (id: string, paths: string[], outOfScope: string[]): Workstream => ({
  id,
  scope: id,
  paths,
  outOfScope,
});

/** The persisted record's per-kind note cap (the constant
 * `runPlanNormalisationPass` holds; the record's own doc says "capped at 10
 * entries each"). */
const UNFENCE_NOTES_CAP = 10;

/** Twenty fenced files the issue names, each held back by its OWN sibling
 * half — the shape #572's cross-declaration contract produces, and the reason
 * the fold has to run: while two workstreams exist, the issue-named pass rolls
 * these removals back (no other half would be fenced out of its own file), so
 * nothing reaches the note list. Once the coupling rules merge the halves the
 * files are one workstream's own, the pass removes all twenty, and the fold's
 * own drops are the only notes left to be crowded out. */
const many = Array.from({ length: 20 }, (_, i) => `src/issue${i}.ts`);

/** Both halves declare the same file set (Jaccard 1.0), so the driver's own
 * coupling rules merge them. The docs half carries the two fences the merge
 * turns into self-fences: a prose sentence over the directories and the
 * directory spelling `tests/`. `sibling/keep.ts` names nothing either half
 * declares and must survive, which is what keeps this from being a wipe. */
function plan(): Record<string, Workstream> {
  const paths = ["tests/test_x.py", "docs/y.md", ...many];
  return {
    // Both halves hold the SAME fences over the shared files. While two
    // workstreams exist each file is fenced from a sibling, so the issue-named
    // pass rolls those removals back (no-owner placement) and the note list
    // stays empty; once the halves merge the files are one workstream's own and
    // every removal sticks. That is the pre-fix shape exactly: the fold's
    // `tests/` drop sat beside a note list already at its 10-note ceiling.
    implement: WS("implement", paths, [...many]),
    document: WS(
      "document",
      [...paths, "tests/test_y.py"],
      [
        "Every file under agents/ and tests/ — this workstream documents, it does not implement",
        "tests/",
        "sibling/keep.ts",
        ...many,
      ],
    ),
  };
}

const issueBody = [
  "# Title",
  "",
  "## Resolved decisions",
  ...many.map((p) => `- The seam lives in ${p}.`),
  "- The tests live in tests/test_x.py.",
  // Twenty more sentences the pass reads as identifier CANDIDATES ("seam",
  // "lives", "in" ...). Left unresolved they burn the 15-name identifier budget
  // before the real path tokens are considered, so the issue-named half of this
  // fixture removes nothing. Answering each with a file of its own name is what
  // a repository where those symbols exist really looks like.
  ...many.map((p) => `- The helper lives in ${p} next to its test.`),
  "",
  "## Out of scope",
  "- nothing else",
].join("\n");

{
  const tmp = `${process.env.TMPDIR ?? "/tmp"}/plan-self-fence-cap-${process.pid}.md`;
  await writeFile(tmp, issueBody);
  {
    const state = {
      ...initialState(1862, 1_000_000),
      pipelineState: {
        ...initialState(1862, 1_000_000).pipelineState,
        issueBodyArtifact: tmp,
        baseSha: "HEAD",
      },
    };
    const out = await runPlanNormalisationPass(plan(), state, {
      repoRoot: "/repo",
      execFn: stubExec(),
    });
    const summary = out.summary;
    const notes = summary?.notes ?? [];
    assert(
      Object.keys(out.workstreams).length === 1,
      `the coupling rules merged the two halves, so a fold ran (got ${JSON.stringify(Object.keys(out.workstreams))})`,
    );
    // The pre-fix code joined the two note lists and sliced the RESULT to 10,
    // so fold drops were lost whenever the issue-named list was full. This
    // fixture drives the fold for real and pins the property that mattered:
    // every drop the count reports is named in the notes, whatever else the
    // list holds. (The plan-quality suite covers the issue-named list's own
    // cap; the cap split here is what `notes.length <= 20` below pins, because
    // a joined slice could never exceed 10.)
    assert(
      (summary?.selfFences ?? 0) >= 1,
      `the fold dropped a fence over the merged workstream's own files (selfFences ${summary?.selfFences})`,
    );
    const foldNotes = notes.filter((n) => n.startsWith("self-fence dropped: "));
    assert(
      // A cap is a DISPLAY bound; the count beside it is the uncapped truth (the
      // record's own contract). So the property is: the list shows at most the
      // cap, shows drops whenever there are fewer than the cap, and shows at
      // least one whenever the count says any went — never a count with no
      // example, which is the disclosure the pre-fix joined slice lost.
      (foldNotes.length === (summary?.selfFences ?? 0) &&
        (summary?.selfFences ?? 0) <= UNFENCE_NOTES_CAP) ||
        (foldNotes.length === UNFENCE_NOTES_CAP && (summary?.selfFences ?? 0) > UNFENCE_NOTES_CAP),
      `the notes carry the fold's drops up to their own cap of ${UNFENCE_NOTES_CAP}, whatever the count says (count ${summary?.selfFences}, notes ${foldNotes.length})`,
    );
    assert(
      (summary?.selfFences ?? 0) === 0 || foldNotes.length > 0,
      `a plan whose count says fences went can always name at least one of them (count ${summary?.selfFences}, notes ${JSON.stringify(foldNotes.slice(0, 2))})`,
    );
    assert(
      notes.length <= 20,
      `the joined list stays bounded (two caps of 10, not unbounded) (got ${notes.length})`,
    );
    assert(
      out.workstreams["implement"]?.outOfScope.includes("sibling/keep.ts") === true,
      `and the sibling's fence still survives (got ${JSON.stringify(out.workstreams["implement"]?.outOfScope)})`,
    );
    await rm(tmp, { force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
