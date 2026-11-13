#!/usr/bin/env bun
/**
 * #2200 — EVERY `-exec` clause of a `find` is judged, not just the first. Split out of
 * `test-write-fence-deletion-shapes-2200.ts` by the repo's file-size cap; that file owns the
 * rest of the shapes, this one the clause walk.
 *
 * `find <wt> -exec rm {} + -exec rm -rf <shared> \;` is two actions and GNU `find` runs both.
 * Reading only the clause that started at the first `-exec` — and cutting it at the first
 * terminator — left the second clause unjudged, so an in-tree start path vouched for a sweep of
 * the shared root. A clause whose command is not a remover removes nothing, so a printing clause
 * in front of the remover (`-exec ls`) must not hide it either, nor may a wrapper (`sudo`) in
 * front of one.
 *
 * The two terminator spellings are both pinned, because they reach the reader by different
 * routes. A quoted `\;` is one WORD, so the whole `find` is one segment and the walk must step
 * past each terminator to the clause after it. An unquoted `;` is what bash consumes to END the
 * command, so the reader sees `find <wt> -exec rm {}` and a separate `-exec rm -rf <shared>`:
 * the tail is still the same `find`'s expression and must be judged with it, not as a `-exec`
 * that named no start path (which real `find` runs anyway, deleting the shared tree).
 *
 * The pipe path agrees: a `find` counts as printing nothing only when NO clause prints, so a
 * silent first clause must not launder the matches a later printing clause hands downstream.
 *
 * Observed RED on the code before this change: every refuse row below.
 */

import {
  CHILD_TMP_ENV,
  deletionRootsFrom,
  firstDeletionOutside,
} from "../src/write-fence-deletion.ts";
import {
  buildDeletionFixture,
  deletionHost,
  withDeletionHost,
} from "./lib/write-fence-deletion-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const fx = buildDeletionFixture("exec-clauses");
const HOST = deletionHost(fx.base);
await withDeletionHost(HOST, async () => {
  const { base, wt, scratch, childTmp, sharedTmp, siblingTmp } = fx;

  /** The roots a fenced develop child's dispatch gives it; the child works in the worktree. */
  const FENCED_ENV = {
    PI_ENSEMBLE_WRITE_ROOT: wt,
    PI_ENSEMBLE_WRITE_REPO: base,
    PI_ENSEMBLE_WRITE_SCRATCH: scratch,
    [CHILD_TMP_ENV]: childTmp,
  };
  const fenced = deletionRootsFrom(FENCED_ENV, wt);

  /** The refusal reason the rule gives this command, or undefined when it runs. */
  function refused(command: string): string | undefined {
    return firstDeletionOutside(command, fenced)?.reason;
  }

  const refusedRows: Array<[string, string]> = [
    [`find ${wt} -exec rm {} + -exec rm -rf ${sharedTmp} \\;`, "a second `-exec rm` clause"],
    [`find ${wt} -exec ls {} + -exec rm -rf ${sharedTmp} \\;`, "a printing clause then a remover"],
    [`find ${wt} -exec rm {} + -exec shred -u ${sharedTmp}/p \\;`, "a second clause that shreds"],
    [`find ${wt} -exec rm {} \; -exec rm -rf ${sharedTmp} \;`, "both clauses `;`-terminated"],
    [`find ${wt} -exec rm {} \; -exec rm -rf ${sharedTmp} +`, "an unquoted then a quoted terminator"],
    [`find ${wt} -exec rm {} + -exec sudo rm -rf ${sharedTmp} \\;`, "a wrapped remover in the clause"],
    [`find ${wt} -execdir rm {} + -exec rm -rf ${sharedTmp} \\;`, "a chained clause behind `-execdir`"],
    [`find ${wt} -exec ls {} + | xargs rm -rf ${siblingTmp}`, "a printing clause feeds the pipe outward"],
  ];
  for (const [command, why] of refusedRows) {
    assert(refused(command) !== undefined, `A9b refuse: ${why} — \`${command}\``);
  }

  // The clauses with nothing harmful in any of them stay the ordinary cleanup they were, in both
  // terminator spellings — which is what makes the refusals above a judgement about the path.
  const allowedRows: Array<[string, string]> = [
    [`find ${wt} -exec ls {} + -exec grep x {} +`, "two printing clauses: neither removes anything"],
    [`find ${wt}/dist -type f -exec rm {} +`, "the build-dir cleanup"],
    [`find ${wt} -exec rm -rf {} +`, "an `-exec rm` whose only operands are braces"],
    [`find ${wt} -exec ls {} + -exec rm -rf ${wt}/build \\;`, "a chained remover that stays in the worktree"],
    [`find ${wt} -exec rm {} \; -exec rm -rf ${wt}/build \;`, "the same with unquoted terminators"],
  ];
  for (const [command, why] of allowedRows) {
    assert(refused(command) === undefined, `A9b allow: ${why} — \`${command}\``);
  }

  // The fold that judges a `;`-split tail with its `find` must not fold an ORDINARY second
  // command into the `find` before it: `find <wt> ; rm -rf <shared>` is two commands and the `rm`
  // is judged on its own literal, while `find <wt> ; echo hi` deletes nothing.
  assert(
    refused(`find ${wt} ; rm -rf ${sharedTmp}`) !== undefined,
    "A9b refuse: a real command after an unquoted `;` is still judged on its own path",
  );
  assert(
    refused(`find ${wt} ; echo hi`) === undefined,
    "A9b allow: a non-remover after an unquoted `;` is not folded into the `find`",
  );
});

console.log(`\nexit ${exit}`);
process.exit(exit);
