#!/usr/bin/env bun
/**
 * Nothing may create a GitHub issue except the operator or the driver.
 *
 * PM filed three non-trivial issues inline in one session (#591, #592, #594)
 * through a self-judged "triviality test" with no oracle. The fix is the
 * mode-independent `tool_call` hook in issue-creation-guard.ts plus the
 * `createsIssue` predicate here. The predicate has four bypass shapes
 * that each actually appeared (or were one `&&` away):
 *
 *   - the `oo` prefix (ops holds an `oo gh …` / `oo glab …` grants; PM runs
 *     both bare),
 *   - chained commands (`cd x && gh issue create`),
 *   - the gh REST door: `gh api repos/o/r/issues` — gh api DEFAULTS TO POST
 *     when body fields are passed, so a "read" without `--method GET` is a
 *     write,
 *   - the glab REST door: `glab api /projects/i/issues` — method-AWARE:
 *     glab api does NOT default to POST, so only an EXPLICIT POST (`-X POST`,
 *     `--method POST`) or body fields (`-f`/`-F`/`--field`) are a write;
 *     an unqualified call or an explicit GET stays open,
 *   - quoted mentions (`echo "gh issue create"` must NOT be blocked — it
 *     creates nothing).
 *
 * The predicate is forge-agnostic (#611): the same two doors for `gh` and
 * `glab`, running on the QUOTE-STRIPPED command, scan-not-anchor, exactly
 * like `discardsUncommittedWork`.
 */

import { createsIssue } from "../src/bash-command-parser.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------ it catches

for (const cmd of [
  // The plain verb, with the shapes agents actually emit.
  "gh issue create --title t",
  "gh issue create --title 'fix: x' --body-file tmp/body.md",
  "oo gh issue create -t x",
  // Chained commands — the predicate scans, it does not anchor.
  "cd x && gh issue create --title t",
  "gh issue list && gh issue create --title t",
  "git status; gh issue create --title t",
  // The REST door: POST to the issues COLLECTION (gh api's default when body
  // fields are present).
  "gh api repos/o/r/issues -f title=x -f body=y",
  "oo gh api repos/o/r/issues -f title=t",
  "curl x; gh api repos/o/r/issues -f title=t",
  // The glab verb door — same four shapes as gh (bare, oo, chained, quoted
  // arguments).
  "glab issue create --title t",
  "oo glab issue create -t x",
  "cd x && glab issue create --title t",
  "glab issue list; glab issue create --title t",
  // The glab REST door — blocked only when the command EXPLICITLY posts: an
  // explicit POST method or body fields (glab converts `-f`/`-F`/`--field`
  // into a write). Unlike gh api, glab api does NOT default to POST.
  "glab api /projects/123/issues -X POST -f title=x",
  "glab api /projects/123/issues --method POST -f title=x",
  "oo glab api /projects/123/issues -f title=t",
  "curl x; glab api /projects/123/issues -F body=y",
  "glab api /projects/123/issues --field title=x",
]) {
  assert(createsIssue(cmd) !== undefined, `canary: blocked — ${cmd}`);
}

// -------------------------------------------------- and it does not overreach

for (const cmd of [
  // A command that merely MENTIONS the verb inside a quoted string creates
  // nothing — stripQuotedSegments removes the segment first.
  'echo "gh issue create"',
  "gh pr comment 5 --body 'do not run gh issue create here'",
  // Read verbs on issues stay open.
  "gh issue list --limit 15",
  "gh issue view 123",
  "gh issue edit 123 --body-file x.md",
  "gh issue comment 123 --body hi",
  // A specific issue via REST is a read, not the collection POST.
  "gh api repos/o/r/issues/123",
  "gh api repos/o/r/issues/123 -X GET",
  // The explicit GET on the collection is a read too — inverted default.
  "gh api repos/o/r/issues --method GET -f state=open",
  "gh api repos/o/r/issues --method GET",
  // Non-issue REST endpoints stay open.
  "gh api repos/o/r/pulls/42",
  "gh api user",
  // Unrelated gh verbs.
  "gh pr list",
  "gh pr create --title x --body-file y.md",
  // The glab REST door: glab api does NOT default to POST the way gh api
  // does, so the read shapes stay open — the door is method-aware.
  // Unqualified: a read.
  "glab api /projects/123/issues",
  // Explicit GET: a read.
  "glab api /projects/123/issues --method GET -f state=opened",
  "glab api /projects/123/issues -X GET",
  // A SPECIFIC issue via REST is a read, not the collection write.
  "glab api /projects/123/issues/456",
  // glab issue reads stay open.
  "glab issue list --limit 15",
  "glab issue view 123",
  "glab issue edit 123 --description-file x.md",
  "glab issue comment 123 -m hi",
  // MR verbs are not the issue door.
  "glab mr create --title x --description-file y.md",
  // Quoted mentions of the glab verb create nothing.
  "echo \"glab issue create\"",
  // Non-issue glab REST endpoints stay open.
  "glab api /projects/123/mr/42",
  "glab api user",
]) {
  assert(createsIssue(cmd) === undefined, `allowed — ${cmd}`);
}

// -------------------- the hook is registered BEFORE the trust-mode bypass

{
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const pg = readFileSync(path.join(SRC, "permission-guard.ts"), "utf8");
  const sub = readFileSync(path.join(SRC, "permission-subagent-guard.ts"), "utf8");
  const ig = readFileSync(path.join(SRC, "issue-creation-guard.ts"), "utf8");

  // Parent guard: registered ahead of the trust-mode early return.
  const guardIdx = pg.indexOf("registerIssueCreationGuard(pi)");
  const trustIdx = pg.indexOf("isInTrustMode(ctx.hasUI === true)");
  assert(guardIdx > 0, "canary: parent guard registers the issue-creation guard");
  assert(
    guardIdx < trustIdx,
    `it is registered BEFORE the trust-mode return (guard=${guardIdx}, trust=${trustIdx}) — in trust mode (the interactive default), code after that return never runs`,
  );
  // Sandbox short-circuit is also a default (container); the guard must beat it
  // in the subagent process, where registerSubagentGuard is the entry point.
  const subGuardIdx = sub.indexOf("registerIssueCreationGuard(pi)");
  const subSandboxIdx = sub.indexOf("PI_ENSEMBLE_SANDBOX_MODE");
  const subTrustIdx = sub.indexOf("PI_ENSEMBLE_TRUST_MODE");
  assert(subGuardIdx > 0, "canary: subagent guard registers the issue-creation guard");
  assert(
    subGuardIdx < subSandboxIdx && subGuardIdx < subTrustIdx,
    `...and BEFORE both bypasses in the subagent path (guard=${subGuardIdx}, sandbox=${subSandboxIdx}, trust=${subTrustIdx})`,
  );
  // The guard itself: all roles (no role check), all modes, escape hatch.
  assert(
    !/PI_ENSEMBLE_ROLE/.test(ig),
    "canary: the guard is role-agnostic — it fires for PM, explore, ops, developer alike",
  );
  assert(
    !/PI_ENSEMBLE_TRUST_MODE|PI_ENSEMBLE_SANDBOX_MODE|PI_ENSEMBLE_SUBAGENT_MODE/.test(ig),
    "the guard is mode-agnostic — it is the hook registered before the bypasses, not a branch inside them",
  );
  assert(
    /PI_ENSEMBLE_ALLOW_DIRECT_ISSUE_CREATE === "1"/.test(ig),
    "escape hatch: PI_ENSEMBLE_ALLOW_DIRECT_ISSUE_CREATE=1 opens the door for a human",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
