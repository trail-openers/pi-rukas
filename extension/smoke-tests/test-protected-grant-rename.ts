#!/usr/bin/env bun
/**
 * #1378 — the two protected-path cases a grant can never paper over.
 *
 * Split out of test-protected-grant.ts (#1090's file) because the checks are
 * about the READ, not the grant:
 *
 *   - a rename AWAY from a protected path. `git mv .github/workflows/ci.yml
 *     src/ci.yml` moves a workflow out of the way; `git diff --name-only`
 *     collapsed the rename to its destination, so under the old read the deleted
 *     workflow never appeared in the change set. Under `-z --name-status -M`
 *     both sides arrive as their own token, and both are checked.
 *   - a protected path whose name git C-quotes. `-z` carries the bytes
 *     verbatim, so the halt names the real path — and `SAFE_PATH_RE` then
 *     refuses to print a grant command for a path its own parser would reject,
 *     which makes `PI_ENSEMBLE_PROTECTED_PATHS=0` the only escape the message
 *     can honestly offer.
 *
 * Companion: test-work-driver-protected-paths-read.ts runs the same two cases
 * against a real repository; this file pins the gate's prose and grant surface
 * through the scripted fake.
 */

import { parseWorkArgs } from "../src/work-args.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { SAFE_PATH_RE, isProtectedPath } from "../src/work-driver-doctrine.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { commandOf } from "./lib/argv-shell.ts";
import { isNulDiffRead, isNulStatusRead, nulNameStatus, nulStatus } from "./lib/nul-porcelain.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const CI = ".github/workflows/ci.yml";

process.env.PI_ENSEMBLE_VERIFY = "1";
delete process.env.PI_ENSEMBLE_PROTECTED_PATHS;

function stateWith(extra: Partial<WorkState["pipelineState"]> = {}): WorkState {
  const s = initialState(1378, 1000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      worktrees: { "task-a": "/nonexistent/wt" },
      baseSha: "a".repeat(40),
      ...extra,
    },
  };
}

function ctx(porcelain: string, grant?: string[], committed = ""): DriverContext {
  return {
    host: { sendUserMessage: () => {} } as unknown as DriverContext["host"],
    repoRoot: "/nonexistent",
    issue: 1378,
    protectedGrant: grant,
    // Same argv-aware fake as test-protected-grant.ts: the gate issues both reads
    // in argv form, so a fake that string-matched the old plain command would fall
    // through to `{stdout:""}` and every assertion would pass vacuously.
    verifyExecFn: async (cmd, opts) => {
      const line = commandOf(cmd, opts);
      if (isNulStatusRead(line)) return { stdout: nulStatus(...porcelain.split("\n")) };
      if (isNulDiffRead(line)) return { stdout: nulNameStatus(...committed.split("\n")) };
      return { stdout: "" };
    },
  };
}

const isProtectedFailure = (f: string) => /protected path/.test(f);

{
  // #1378 — the source side. `git mv .github/workflows/ci.yml src/ci.yml` moves a
  // workflow out of the way; the destination is an ordinary src path, so a gate
  // that saw only destinations passed. Under `-z` both sides arrive as their own
  // tokens.
  const movedAway = await verifyStepOutcome(
    ctx(`R  ${CI} -> src/ci.yml\n`),
    stateWith(),
    "develop",
  );
  assert(
    movedAway.failures.some((f) => isProtectedFailure(f) && f.includes(`— ${CI}`)),
    "#1378: an uncommitted rename AWAY from a protected path halts, naming the source",
  );
  const committedAway = await verifyStepOutcome(
    ctx("", undefined, `R\t${CI}\tsrc/ci.yml\n`),
    stateWith(),
    "develop",
  );
  assert(
    committedAway.failures.some((f) => isProtectedFailure(f) && f.includes(CI)),
    "#1378: a COMMITTED rename away from a protected path halts — the case `--name-only` collapsed",
  );
  const grantNamesSource = await verifyStepOutcome(
    ctx("", [CI], `R\t${CI}\tsrc/ci.yml\n`),
    stateWith(),
    "develop",
  );
  assert(
    !grantNamesSource.failures.some(isProtectedFailure) &&
      grantNamesSource.notes.some((n) => n.includes("--allow-protected") && n.includes(CI)),
    "#1378: a grant naming the rename SOURCE admits it, and the admission is noted (#1090)",
  );
  const ordinaryRename = await verifyStepOutcome(
    ctx("", undefined, "R\tsrc/a.ts\tsrc/b.ts\n"),
    stateWith(),
    "develop",
  );
  assert(
    !ordinaryRename.failures.some(isProtectedFailure),
    "#1378: a rename between two unprotected paths adds no protected failure — the widened read is not a blanket rename alarm",
  );
  const committedDelete = await verifyStepOutcome(
    ctx("", undefined, ".pi/verify-cmd\n"),
    stateWith(),
    "develop",
  );
  assert(
    committedDelete.failures.some((f) => isProtectedFailure(f) && f.includes(".pi/verify-cmd")),
    "a committed deletion of a protected file still halts (the `D` record is a first-class path)",
  );

  // #1378 — a name git C-quotes. `-z` carries the bytes verbatim, so the halt names
  // the real path and SAFE_PATH_RE correctly refuses to print a grant for it.
  const NON_ASCII = ".github/workflows/wörkflows.yml";
  assert(
    isProtectedPath(NON_ASCII),
    "#1378: a non-ASCII name under .github/ is still a protected path",
  );
  assert(
    !SAFE_PATH_RE.test(NON_ASCII),
    "#1378: ...but SAFE_PATH_RE rejects it, so it can never be granted",
  );
  const ungrantableParse = parseWorkArgs(`7 --allow-protected ${NON_ASCII}`);
  assert(
    "error" in ungrantableParse,
    "#1378: --allow-protected refuses the non-ASCII path rather than accepting a grant it cannot match",
  );
  const quoted = await verifyStepOutcome(ctx(`?? ${NON_ASCII}\n`), stateWith(), "develop");
  const quotedHit = quoted.failures.find(isProtectedFailure) ?? "";
  assert(
    quotedHit.includes(NON_ASCII),
    "#1378: the decoded non-ASCII path is what the failure names (no quotes, no octal escapes)",
  );
  assert(
    !quotedHit.includes("\\303") && !quotedHit.includes('"'),
    "#1378: no C-quoted bytes leak into the operator-facing message",
  );
  assert(
    quotedHit.includes("cannot be granted") &&
      !quotedHit.includes("--restart --allow-protected"),
    "#1378: no copy-paste grant command is printed for a path the parser would refuse",
  );
  assert(
    quotedHit.includes("PI_ENSEMBLE_PROTECTED_PATHS=0"),
    "#1378: ...and the only escape the message offers is the process-wide one",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
