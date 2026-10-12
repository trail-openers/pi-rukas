#!/usr/bin/env bun
/**
 * #1114 — the adversarial fix pass fails closed. Every read the fence needs
 * (HEAD, the base tree, the worktree diff, comment retention) either succeeds
 * or parks the pass with a named reason before (or after) the developer runs;
 * a finding widens the fence only within a declared or already-changed
 * directory, and never onto a protected path (protectedPathsIn).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import {
  interpretReview,
  namedPaths,
  pendingFixes,
  runAdversarialFixPass,
} from "../src/work-driver-adversarial-fix.ts";
import {
  devCommit,
  execFailing,
  fixCtx,
  fixState,
  git,
  repoWithFile,
} from "./lib/adversarial-fix-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP = "0";

/** Runs a fix pass and reports the parked evidence (undefined when it applied) and the handoff notes. */
async function passOf(
  dir: string,
  st: ReturnType<typeof fixState>,
  onDev: (d: string) => void,
  verifyExecFn?: Parameters<typeof fixCtx>[2],
): Promise<{ parked?: string; applied: boolean; devs: number; notes: string[] }> {
  let devs = 0;
  const ctx = fixCtx(
    dir,
    (d) => {
      devs++;
      onDev(d);
    },
    verifyExecFn,
  );
  const out = await runAdversarialFixPass(ctx, st, pendingFixes(st.eventLog), Date.now());
  const tail = out.eventLog[out.eventLog.length - 1];
  const applied = out.eventLog.some((e) => e.kind === "adversarial-fix-applied");
  return {
    parked: tail?.kind === "cap-hit" ? tail.evidence : undefined,
    applied,
    devs,
    notes: (out.pipelineState.plumbReports ?? []).map((r) => r.body),
  };
}

// B1 — an unreadable HEAD parks before the developer runs.
{
  const dir = repoWithFile("fc-head");
  try {
    const r = await passOf(
      dir,
      fixState(dir, ["a.txt"]),
      () => devCommit(dir, "a.txt", "two\n"),
      execFailing("git rev-parse HEAD"),
    );
    assert(r.devs === 0, "B1: an unreadable HEAD dispatches no developer");
    assert(
      r.parked?.includes("scope could not be verified") === true && r.parked.includes("rev-parse"),
      `B1: an unreadable HEAD parks with a named reason (got ${r.parked})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// B3 — an unreadable base tree parks with the git reason, never as an empty set.
{
  const dir = repoWithFile("fc-tracked");
  try {
    const r = await passOf(
      dir,
      fixState(dir, ["a.txt"], "b.txt: fix it"),
      () => devCommit(dir, "b.txt", "two\n"),
      execFailing("git ls-tree"),
    );
    assert(r.devs === 0, "B3: an unreadable base tree dispatches no developer");
    assert(
      r.parked?.includes("scope could not be verified") === true && r.parked.includes("ls-tree"),
      `B3: an unreadable base tree parks with the git reason (got ${r.parked})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// B6 — a git diff error parks the pass; the two sides are never compared as "".
{
  const dir = repoWithFile("fc-diff");
  try {
    const r = await passOf(
      dir,
      fixState(dir, ["a.txt"]),
      () => devCommit(dir, "a.txt", "two\n"),
      execFailing("git diff --name-only"),
    );
    assert(
      r.devs === 0 && r.parked !== undefined,
      "B6: a git diff error parks before the developer runs",
    );
    assert(
      r.parked?.includes("scope could not be verified") === true,
      `B6: the diff error is a named park reason (got ${r.parked})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// B4 — a pending workstream with no recorded worktree parks; it never falls
// back to repoRoot.
{
  const dir = repoWithFile("fc-noworktree");
  try {
    const st = fixState(dir, ["a.txt"]);
    const noWorktree = { ...st, pipelineState: { ...st.pipelineState, worktrees: {} } };
    const r = await passOf(dir, noWorktree, () => devCommit(dir, "a.txt", "two\n"));
    assert(r.devs === 0, "B4: a workstream with no worktree dispatches no developer");
    assert(
      r.parked?.includes("no worktree is recorded for default") === true,
      `B4: the park names the missing worktree (got ${r.parked})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// B2 — a comment-retention read that cannot run is not cleared. The pass
// removes an origin/main comment line, so the check must read the head tree;
// that read (git grep) fails, and the pass parks as NOT CHECKED. The develop
// gate treats an infra error as a note, never a failure, so this park is the
// fix pass's own.
{
  const dir = repoWithFile("fc-comment");
  try {
    mkdirSync(path.join(dir, "extension", "src"), { recursive: true });
    writeFileSync(
      path.join(dir, "extension", "src", "x.ts"),
      "export const x = 1;\n// keep this comment about the parser\nexport const y = 2;\n",
    );
    git(dir, "add -A");
    git(dir, 'commit -q -m "x"');
    const r = await passOf(
      dir,
      fixState(dir, ["extension/src/x.ts"]),
      () => devCommit(dir, "extension/src/x.ts", "export const x = 1;\nexport const y = 2;\n"),
      execFailing("git grep"),
    );
    assert(
      r.parked?.includes("comment retention could not be checked") === true &&
        r.parked.includes("NOT CHECKED") &&
        !r.applied,
      `B2: an unavailable comment check parks as NOT CHECKED (got ${r.parked})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// B2b — the operator's kill switch is not a failed check: the pass proceeds,
// and the handoff records that the check was NOT CHECKED.
{
  const dir = repoWithFile("fc-hatch");
  process.env.PI_ENSEMBLE_COMMENT_RETENTION = "0";
  try {
    const r = await passOf(dir, fixState(dir, ["a.txt"]), () => devCommit(dir, "a.txt", "two\n"));
    assert(
      r.applied && r.parked === undefined,
      `B2b: PI_ENSEMBLE_COMMENT_RETENTION=0 does not park a fix pass (got ${r.parked})`,
    );
    assert(
      r.notes.some((n) => n.includes("NOT CHECKED (PI_ENSEMBLE_COMMENT_RETENTION=0)")),
      "B2b: the handoff records the comment check as NOT CHECKED",
    );
  } finally {
    delete process.env.PI_ENSEMBLE_COMMENT_RETENTION;
    rmSync(dir, { recursive: true, force: true });
  }
}

// B5 — a reportOnly review that succeeded but carries no parsed round record is
// infra, never an approval.
{
  const ok = {
    role: "adversarial-loop",
    ok: true,
    exitCode: 0,
    text: "APPROVED",
    toolUses: [],
    ms: 1,
  };
  const noRecord = interpretReview(ok as DispatchResult, 1);
  assert(
    noRecord.infra && !noRecord.ok,
    "B5: a successful review with no round record is infra, not an approval",
  );
  const unparsed = interpretReview(
    {
      ...ok,
      adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: false }],
    } as DispatchResult,
    1,
  );
  assert(unparsed.infra && !unparsed.ok, "B5: an unparsed verdict is infra, not an approval");
  const approved = interpretReview(
    {
      ...ok,
      adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
    } as DispatchResult,
    1,
  );
  assert(approved.ok && !approved.infra, "B5: a parsed APPROVED is still an approval");
  const emptyFix = interpretReview(
    {
      ...ok,
      text: "  ",
      adversarialRounds: [{ round: 1, status: "ISSUES_FOUND", verdictParsed: true }],
    } as DispatchResult,
    1,
  );
  assert(
    emptyFix.infra && !emptyFix.fixRequested,
    "B5: a parsed ISSUES_FOUND with an empty body is infra, not a fix pass with no findings",
  );
}

// C — a finding-named path widens the fence only within a declared or
// already-changed directory, and never onto a protected path. `agents.json`
// shares the root directory with the declared `a.txt`, so only the protection
// check (protectedPathsIn) keeps it out of scope.
{
  const dir = repoWithFile("fc-protected");
  try {
    mkdirSync(path.join(dir, "extension", "src"), { recursive: true });
    writeFileSync(path.join(dir, "agents.json"), "{}\n");
    writeFileSync(path.join(dir, "extension", "src", "x.ts"), "export {};\n");
    git(dir, "add -A");
    git(dir, 'commit -q -m "protected"');
    const tracked = ["a.txt", "b.txt", "agents.json", ".github/workflows/ci.yml", "extension/src/x.ts"];
    const findings = "agents.json .github/workflows/ci.yml extension/src/x.ts b.txt a.txt";
    const widened = namedPaths(findings, tracked, ["a.txt"]).join(",");
    // The repo root is not an anchor: a root-declared a.txt widens nothing.
    assert(
      widened === "",
      `C: a root-level anchor widens no root file (got ${widened})`,
    );
    const st = fixState(dir, ["a.txt"], "a.txt: fix it; agents.json: and this; extension/src/x.ts: and that");
    const r = await passOf(dir, st, (d) => {
      writeFileSync(path.join(d, "a.txt"), "two\n");
      writeFileSync(path.join(d, "agents.json"), '{"auto": true}\n');
      writeFileSync(path.join(d, "extension", "src", "x.ts"), "export const x = 2;\n");
      git(d, "add -A");
      git(d, 'commit -q -m "fix"');
    });
    assert(
      !r.applied && r.parked?.includes("agents.json") === true,
      `C: a finding naming a protected path does not widen the fence (got ${r.parked})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
