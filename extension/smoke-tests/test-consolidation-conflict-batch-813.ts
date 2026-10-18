#!/usr/bin/env bun
/**
 * #813 (batch layer) — the observation a conflicted cherry-pick batch makes,
 * and the one field that carries it out: `conflictedFile`.
 *
 * The companion file, test-consolidation-conflict-attribution-813.ts, covers
 * the two OPERATOR renderers (the develop gate's failure string and
 * `explainCap("consolidated-verify-conflict")`). This one covers the layer
 * below them, which is where the #813 diagnosis actually gets its evidence:
 *
 * `cherryPickWorkstreams` is the only place that ever sees git's own output
 * for the aborted pick. If the file name stayed inside that blob, every
 * caller upstream would have to parse prose to name a file — and a message
 * deciding the diagnosis is exactly the defect #813 is about (the renderer
 * tests assert that it does NOT parse prose). So the batch extracts the path
 * itself and hands it back as a structured field, and the renderers read the
 * field.
 *
 * Both halves are pinned: the batch records what git named, and
 * `conflictedFileFrom` reads git's three conflict phrasings and NOTHING else
 * — a blob that names no path leaves the field absent rather than invented.
 */

import { cherryPickWorkstreams } from "../src/work-driver-cherry-pick-batch.ts";
import { conflictedFileFrom } from "../src/work-driver-cherry-pick-conflict.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Case 1 — a real content collision aborts the batch, and the conflict it
// returns carries WHICH pick failed, WHAT applied cleanly, and the FILE git
// named. `isCommitOnBranch` answers false (via a read error) so the pick is
// attempted rather than skipped as already on the branch.
// ──────────────────────────────────────────────────────────────────────────
{
  const cpExec = async (cmd: string): Promise<{ stdout: string }> => {
    if (cmd.startsWith("git rev-list")) {
      return { stdout: "1111111111111111111111111111111111111111\n" };
    }
    if (cmd.startsWith("git cat-file")) throw new Error("not on branch");
    if (cmd.startsWith("git cherry-pick --no-commit")) {
      const e = new Error(
        "Command failed: git cherry-pick --no-commit 11111111\nThe previous cherry-pick is now empty",
      ) as Error & { stderr?: string };
      // Verbatim git shape for a content collision on the pick.
      e.stderr =
        "error: could not apply 1111111... workstream b\nCONFLICT (content): Merge conflict in src/shared/types.ts";
      throw e;
    }
    return { stdout: "" };
  };
  const result = await cherryPickWorkstreams(cpExec, {
    repoRoot: "/repo",
    branchName: "integrate",
    worktrees: { b: "/w/wt-b" },
    commitShas: {},
    baseSha: "abc1234",
  });
  assert(
    "__conflict" in result && result.conflictedAt === "b",
    `case 1: a content collision aborts the batch with the discriminator (got: ${JSON.stringify(result).slice(0, 160)})`,
  );
  assert(
    "__conflict" in result && result.conflictedFile === "src/shared/types.ts",
    `case 1: the batch records the file git named, as a field (got: ${JSON.stringify(result).slice(0, 220)})`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Case 2 — git named no path (its empty-cherry-pick abort says so). The
// field stays ABSENT: an observation the batch did not make must not appear
// in the object the renderers trust, or the coupling clause fires on nothing.
// ──────────────────────────────────────────────────────────────────────────
{
  const cpExec = async (cmd: string): Promise<{ stdout: string }> => {
    if (cmd.startsWith("git rev-list")) {
      return { stdout: "1111111111111111111111111111111111111111\n" };
    }
    if (cmd.startsWith("git cat-file")) throw new Error("not on branch");
    if (cmd.startsWith("git cherry-pick --no-commit")) {
      const e = new Error("Command failed: git cherry-pick --no-commit 11111111") as Error & {
        stderr?: string;
      };
      e.stderr = "error: The previous cherry-pick is now empty, possibly due to conflict resolution";
      throw e;
    }
    return { stdout: "" };
  };
  const result = await cherryPickWorkstreams(cpExec, {
    repoRoot: "/repo",
    branchName: "integrate",
    worktrees: { b: "/w/wt-b" },
    commitShas: {},
    baseSha: "abc1234",
  });
  assert(
    "__conflict" in result && result.conflictedAt === "b" && result.conflictedFile === undefined,
    `case 2: output naming no path leaves the field absent (got: ${JSON.stringify(result).slice(0, 220)})`,
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Case 3 — `conflictedFileFrom` reads git's conflict phrasings and nothing
// else. The negative rows are the load-bearing ones: a commit abbreviation
// ("abc1234...") and a bare word are NOT paths, and an invented file is the
// #813 defect reintroduced one layer down.
// ──────────────────────────────────────────────────────────────────────────
{
  const read = (s: string) => String(conflictedFileFrom(s));
  assert(
    conflictedFileFrom("error: could not apply abc1234... src/foo/bar.ts") === "src/foo/bar.ts",
    `case 3: 'could not apply <path>' is read (got: ${read("error: could not apply abc1234... src/foo/bar.ts")})`,
  );
  assert(
    conflictedFileFrom("CONFLICT (content): Merge conflict in extension/src/x.ts") ===
      "extension/src/x.ts",
    `case 3: 'Merge conflict in <path>' is read (got: ${read("CONFLICT (content): Merge conflict in extension/src/x.ts")})`,
  );
  assert(
    conflictedFileFrom("The previous cherry-pick is now empty") === undefined,
    `case 3: output naming no path yields undefined (got: ${read("The previous cherry-pick is now empty")})`,
  );
  assert(
    conflictedFileFrom("") === undefined,
    `case 3: empty output yields undefined (got: ${read("")})`,
  );
  assert(
    conflictedFileFrom("could not apply notapath") === undefined,
    `case 3: a bare word that is not a path yields undefined (got: ${read("could not apply notapath")})`,
  );
  assert(
    conflictedFileFrom("error: could not apply abc1234... workstream b") === undefined,
    `case 3: a commit abbreviation is not a file (got: ${read("error: could not apply abc1234... workstream b")})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
