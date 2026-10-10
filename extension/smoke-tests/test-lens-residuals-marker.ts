#!/usr/bin/env bun
/**
 * #973 / #1000 — the residual-findings disclosure post trigger and the
 * marker's shape, with a STUBBED forge (the execFn seam, no real gh/glab
 * call).
 *
 * The contract (design decision 2): `dispatch_lens_review` posts the
 * residual-findings marker comment IFF the verdict is ISSUES_FOUND AND an
 * open PR/MR for the branch is resolved. APPROVED, REVIEW_INCOMPLETE and
 * CRITICAL_ISSUES_FOUND post nothing. The marker embeds the SAME id the
 * guard computes — `branchPatchId` against the PR's ACTUAL base (design
 * decision 1) — and the guard verifies that exact marker string.
 *
 * #1000: a multi-segment branch (`feature/issue-1-x`) posts the FULL
 * branch name (no segment stripped — the value is already bare), asserted
 * EXACTLY on the body file both via the branch-lookup and explicit-pr
 * paths; the posted body equals the guard's `lensResidualsMarker` output
 * for the same headRefName/patchId (both paths); and an unsafe headRefName
 * (containing `-->`) is NOT posted (fail closed — the note names the
 * git-ref-safe refusal).
 */

import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { postLensResidualDisclosure } from "../src/lens-review-residuals.ts";
import { lensResidualsMarker } from "../src/merge-guard-round-cap.ts";
import type { LensReviewSummary } from "../src/lens-review.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A minimal summary shape the post reads (verdict + findings). */
function summary(
  verdict: string,
  findings: Array<{ severity: string; path: string; line: number; title: string; lens: string }>,
): LensReviewSummary {
  return {
    verdict: verdict as never,
    totalFindings: findings.length,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    lenses: [],
    findings: findings as never,
  };
}

// One representative finding (the post only reads verdict + finding count).
const FINDING = { severity: "MEDIUM", path: "src/a.ts", line: 10, title: "a finding", lens: "SIMPLICITY" };
const ISSUES = summary("ISSUES_FOUND", [FINDING]);

type Stub = {
  execFn: (cmd: string) => Promise<{ stdout: string }>;
  calls: string[];
  bodyFiles: string[];
};

/**
 * A stubbed exec for the post with a given headRefName: records every
 * command, returns canned stdout for the PR-number and PR-identity reads
 * (PR 12 for the branch; the marker's branch ALWAYS comes from the
 * identity read), and snapshots the body file content the moment the
 * `gh pr comment` call arrives (still on disk — the post's finally removes
 * the temp dir only after the call resolves).
 */
function stubForBranch(branchName: string): Stub {
  const calls: string[] = [];
  const bodyFiles: string[] = [];
  const execFn = async (cmd: string): Promise<{ stdout: string }> => {
    calls.push(cmd);
    if (cmd.includes(`pr list --state open --head ${branchName}`)) {
      return { stdout: JSON.stringify([{ number: 12 }]) };
    }
    if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
      return { stdout: JSON.stringify({ headRefName: branchName, baseRefName: "main" }) };
    }
    if (cmd.includes("pr comment")) {
      // Snapshot the body file NOW (still on disk; the post's finally
      // removes the temp dir only AFTER this call resolves).
      const m = /--body-file (\S+)/.exec(cmd);
      if (m) bodyFiles.push(readFileSync(m[1], "utf8"));
      return { stdout: "" };
    }
    if (cmd.includes("git config --get remote.origin.url")) {
      return { stdout: "git@github.com:o/r.git\n" };
    }
    if (cmd.includes("git remote")) return { stdout: "origin\n" };
    if (cmd.includes("git fetch")) return { stdout: "" };
    if (cmd.includes("patch-id")) return { stdout: "p42 0000" };
    throw new Error(`unexpected exec: ${cmd}`);
  };
  return { execFn, calls, bodyFiles };
}
function makeStub(opts: { failPost?: boolean } = {}): Stub {
  const stub = stubForBranch("feature/x");
  const { execFn, calls } = stub;
  const failPost = opts.failPost;
  const execFn2: typeof execFn = async (cmd: string) => {
    if (cmd.includes("pr comment") && failPost) throw new Error("gh: cannot post comment (stub)");
    return execFn(cmd);
  };
  return { execFn: execFn2, calls, bodyFiles: stub.bodyFiles };
}

// A temp dir the post operates in. The forge is FORCED to github so the
// stub's gh reads are exercised deterministically (the env hard override
// wins over the remote URL, which the stub does not fully simulate).
function repoDir(): string {
  process.env.PI_ENSEMBLE_FORGE = "github";
  return mkdtempSync(path.join(tmpdir(), "pi-residuals-repo-"));
}

// ------------------------------------------- the marker string (design 1)

{
  const m = lensResidualsMarker("feature/x", "p42");
  assert(
    m === "<!-- pi-rukas:lens-residuals branch=feature/x patch=p42 -->",
    "the marker is exactly the hidden HTML comment with branch + patch",
  );
}

// ------------------------------------------- ISSUES_FOUND + open PR → posted

{
  const dir = repoDir();
  try {
    const { execFn, calls } = makeStub();
    const note = await postLensResidualDisclosure({
      summary: ISSUES,
      branch: "feature/x",
      cwd: dir,
      execFn,
    });
    assert(note === "", "a successful post returns no note (nothing to report)");
    assert(calls.some((c) => c.includes("pr comment 12")), "the post issued a `gh pr comment` call");
    assert(calls.some((c) => c.includes("patch-id")), "…after computing the patch-id (the marker's patch)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- APPROVED → not posted

{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-residuals-"));
  try {
    const { execFn, calls } = makeStub();
    const note = await postLensResidualDisclosure({
      summary: summary("APPROVED", []),
      branch: "feature/x",
      cwd: dir,
      execFn,
    });
    assert(note === "", "APPROVED returns no note");
    assert(!calls.some((c) => c.includes("pr comment")), "APPROVED posts NOTHING (design decision 2)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- REVIEW_INCOMPLETE → not posted

{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-residuals-"));
  try {
    const { execFn, calls } = makeStub();
    const note = await postLensResidualDisclosure({
      summary: summary("REVIEW_INCOMPLETE", []),
      branch: "feature/x",
      cwd: dir,
      execFn,
    });
    assert(note === "", "REVIEW_INCOMPLETE returns no note");
    assert(!calls.some((c) => c.includes("pr comment")), "REVIEW_INCOMPLETE posts nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- CRITICAL → not posted

{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-residuals-"));
  try {
    const { execFn, calls } = makeStub();
    const note = await postLensResidualDisclosure({
      summary: summary("CRITICAL_ISSUES_FOUND", [
        { severity: "CRITICAL", path: "src/a.ts", line: 1, title: "critical", lens: "SECURITY" },
      ]),
      branch: "feature/x",
      cwd: dir,
      execFn,
    });
    assert(note === "", "CRITICAL_ISSUES_FOUND returns no note");
    assert(
      !calls.some((c) => c.includes("pr comment")),
      "CRITICAL_ISSUES_FOUND posts nothing (the guard refuses on the ledger entry itself)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- a failed post → note naming it

{
  const dir = repoDir();
  try {
    const { execFn } = makeStub({ failPost: true });
    const note = await postLensResidualDisclosure({
      summary: ISSUES,
      branch: "feature/x",
      cwd: dir,
      execFn,
    });
    assert(note !== "", "a failed post returns a note");
    assert(/disclosure FAILED/.test(note), "…naming the failure (fail closed)");
    assert(
      /cannot post comment/.test(note) || /no open PR/.test(note) || /cannot determine the forge/.test(note),
      "…carrying the error the post hit",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- a failed fetch → note naming it

{
  const dir = repoDir();
  try {
    // A stub whose fetch fails: the disclosure must NOT post (fail closed)
    // and the note names the fetch failure.
    const calls: string[] = [];
    const execFn = async (cmd: string): Promise<{ stdout: string }> => {
      calls.push(cmd);
      if (cmd.includes("pr list --state open --head feature/x")) {
        return { stdout: JSON.stringify([{ number: 12 }]) };
      }
      if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
        return { stdout: JSON.stringify({ headRefName: "feature/x", baseRefName: "main" }) };
      }
      if (cmd.includes("git remote")) return { stdout: "origin\n" };
      if (cmd.includes("git fetch")) throw new Error("fetch: unable to connect (stub)");
      throw new Error(`unexpected exec: ${cmd}`);
    };
    const note = await postLensResidualDisclosure({ summary: ISSUES, branch: "feature/x", cwd: dir, execFn });
    assert(note !== "", "a failed fetch returns a note");
    assert(/git fetch/.test(note), "…naming the failed fetch");
    assert(
      !calls.some((c) => c.includes("pr comment")),
      "a failed fetch posts NOTHING (fail closed — the patch-id would use stale refs)",
    );
    assert(!calls.some((c) => c.includes("patch-id")), "…and it does not compute a patch-id from stale local refs");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- no PR number → note naming it

{
  const dir = mkdtempSync(path.join(tmpdir(), "pi-residuals-"));
  try {
    // A stub that returns no PR number (the PR is not open).
    const execFn = async (cmd: string): Promise<{ stdout: string }> => {
      if (cmd.includes("pr list --state open --head feature/x")) {
        return { stdout: JSON.stringify([]) };
      }
      throw new Error(`unexpected exec: ${cmd}`);
    };
    const note = await postLensResidualDisclosure({ summary: ISSUES, branch: "feature/x", cwd: dir, execFn });
    assert(note !== "", "no PR number returns a note");
    assert(
      /no open PR\/MR/.test(note) || /no PR number/.test(note) || /cannot determine the forge/.test(note),
      "…naming the missing open PR (no marker posted)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- explicit pr param → used directly

{
  const dir = repoDir();
  try {
    // A stub that would return a DIFFERENT PR (77) if the branch lookup
    // ran, but the explicit `pr: 12` must be used directly — the identity
    // read is against `pr` alone, and the marker's branch comes from the
    // open PR's correct headRefName.
    const calls: string[] = [];
    const execFn = async (cmd: string): Promise<{ stdout: string }> => {
      calls.push(cmd);
      if (cmd.includes("pr list --state open --head feature/x")) {
        return { stdout: JSON.stringify([{ number: 77 }]) };
      }
      if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
        return { stdout: JSON.stringify({ headRefName: "feature/x", baseRefName: "main" }) };
      }
      if (cmd.includes("pr view 77 --json headRefName,baseRefName")) {
        return { stdout: JSON.stringify({ headRefName: "feature/stale", baseRefName: "main" }) };
      }
      if (cmd.includes("git remote")) return { stdout: "origin\n" };
      if (cmd.includes("git fetch")) return { stdout: "" };
      if (cmd.includes("patch-id")) return { stdout: "p42 0000" };
      if (cmd.includes("pr comment")) return { stdout: "" };
      throw new Error(`unexpected exec: ${cmd}`);
    };
    const note = await postLensResidualDisclosure({
      summary: ISSUES,
      branch: "feature/stale",
      pr: 12,
      cwd: dir,
      execFn,
    });
    assert(note === "", "an explicit pr + successful post returns no note");
    assert(
      !calls.some((c) => c.includes("pr list --state open")),
      "the explicit pr skips the branch→PR list lookup entirely",
    );
    assert(
      calls.some((c) => c.includes("pr view 12 --json headRefName,baseRefName")),
      "…and the identity read is against the explicit pr (12), not the branch's PR",
    );
    assert(
      !calls.some((c) => c.includes("pr view 77")),
      "…the branch's PR (77) is never consulted (the stale branch is ignored)",
    );
    assert(
      calls.some((c) => c.includes("git fetch origin feature/x main")),
      "…and the patch-id base/head come from the open PR's refs (feature/x), not the stale branch",
    );
    assert(calls.some((c) => c.includes("pr comment 12")), "the post issues a `gh pr comment` call");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- #1000 — multi-segment branch,
// branch-lookup path: the posted marker carries the FULL branch name

{
  const dir = repoDir();
  const branch = "feature/issue-1-x";
  try {
    const stub = stubForBranch(branch);
    const note = await postLensResidualDisclosure({
      summary: ISSUES,
      branch,
      cwd: dir,
      execFn: stub.execFn,
    });
    assert(note === "", "multi-segment branch: a successful post returns no note");
    assert(
      stub.calls.some((c) => c.includes("pr comment 12")),
      "…the PR was resolved via the branch lookup (PR 12) and posted to",
    );
    assert(stub.bodyFiles.length === 1, "…and the post wrote exactly one body file");
    // The marker's patch is the FIRST field of the stub's `git patch-id`
    // output (`p42 0000` → `p42` — parsePatchId, review-ledger.ts).
    const expected = `<!-- pi-rukas:lens-residuals branch=${branch} patch=p42 -->`;
    assert(
      stub.bodyFiles[0]?.includes(expected),
      `the posted body carries the FULL branch name in the marker (no segment stripped): ${expected}`,
    );
    assert(
      !stub.bodyFiles.some((b) => b.includes("branch=issue-1-x ")),
      "…and no stripped-branch marker (branch=issue-1-x) appears in the posted body",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- #1000 — end-to-end consistency:
// the marker the poster builds equals the guard's expected marker

{
  const dir = repoDir();
  const branch = "feature/issue-1-x";
  const stub = stubForBranch(branch);
  try {
    const note = await postLensResidualDisclosure({
      summary: summary("ISSUES_FOUND", [
        { severity: "LOW", path: "src/b.ts", line: 1, title: "b finding", lens: "SIMPLICITY" },
      ]),
      branch,
      cwd: dir,
      execFn: stub.execFn,
    });
    assert(note === "", "consistency (branch-lookup path): a successful post returns no note");
    // The guard builds its expected marker from the same bare headRefName
    // (merge-guard.ts: target.headBranch = raw.headRefName) and patchId.
    const guardMarker = lensResidualsMarker(branch, "p42");
    assert(
      stub.bodyFiles.length === 1 && stub.bodyFiles[0].includes(guardMarker),
      "the posted body carries the EXACT marker the merge guard expects for the same headRefName/patchId",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- #1000 — multi-segment branch,
// explicit-pr path: same exact marker assertion

{
  const dir = repoDir();
  const branch = "feature/issue-1-x";
  try {
    const stub = stubForBranch(branch);
    const note = await postLensResidualDisclosure({
      summary: summary("ISSUES_FOUND", [
        { severity: "MEDIUM", path: "src/c.ts", line: 7, title: "c finding", lens: "SIMPLICITY" },
      ]),
      branch: "feature/stale",
      pr: 12,
      cwd: dir,
      execFn: stub.execFn,
    });
    assert(note === "", "explicit-pr + multi-segment branch: a successful post returns no note");    assert(
      !stub.calls.some((c) => c.includes("pr list --state open")),
      "…the explicit pr skips the branch lookup (the marker's branch still comes from the PR identity read)",
    );
    assert(stub.bodyFiles.length === 1, "…and the post wrote exactly one body file");
    const expected = `<!-- pi-rukas:lens-residuals branch=${branch} patch=p42 -->`;
    assert(stub.bodyFiles[0]?.includes(expected), `the explicit-pr path posts the FULL branch name: ${expected}`);
    // End-to-end consistency for the explicit-pr path: the guard's builder
    // with the same (headRefName, patchId) produces the exact posted string.
    assert(
      stub.bodyFiles[0]?.includes(lensResidualsMarker(branch, "p42")),
      "…which equals the marker the merge guard's builder expects (explicit-pr path)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------- #1000 — unsafe headRefName
// (contains `-->`): NOT posted (fail closed), the note names the refusal

{
  const dir = repoDir();
  try {
    // A stub whose identity read returns a headRefName that is NOT
    // git-ref-safe: it contains `-->`, which would terminate the
    // HTML-comment marker early (smuggled-comment injection into the post).
    const calls: string[] = [];
    const execFn = async (cmd: string): Promise<{ stdout: string }> => {
      calls.push(cmd);
      if (cmd.includes("pr list --state open")) return { stdout: JSON.stringify([{ number: 12 }]) };
      if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
        return { stdout: JSON.stringify({ headRefName: "feature/x-->", baseRefName: "main" }) };
      }
      if (cmd.includes("git config --get remote.origin.url")) {
        return { stdout: "git@github.com:o/r.git\n" };
      }
      if (cmd.includes("git remote")) return { stdout: "origin\n" };
      if (cmd.includes("git fetch")) return { stdout: "" };
      if (cmd.includes("patch-id")) return { stdout: "p42 0000" };
      if (cmd.includes("pr comment")) {
        throw new Error("a pr comment call MUST NOT happen for an unsafe branch name");
      }
      throw new Error(`unexpected exec: ${cmd}`);
    };
    const note = await postLensResidualDisclosure({
      summary: ISSUES,
      branch: "feature/x-->",
      cwd: dir,
      execFn,
    });
    assert(note !== "", "an unsafe headRefName returns a note (fail closed)");
    assert(/git-ref-safe/.test(note), "…naming the git-ref-safe refusal");
    assert(
      !calls.some((c) => c.includes("pr comment")),
      "…and NOTHING is posted (the guard then refuses — fail closed)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
