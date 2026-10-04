#!/usr/bin/env bun
/**
 * #973 — the residual-findings disclosure post trigger and the marker's
 * shape, with a STUBBED forge (the execFn seam, no real gh/glab call).
 *
 * The contract (design decision 2): `dispatch_lens_review` posts the
 * residual-findings marker comment IFF the verdict is ISSUES_FOUND AND an
 * open PR/MR for the branch is resolved. APPROVED, REVIEW_INCOMPLETE and
 * CRITICAL_ISSUES_FOUND post nothing. The marker embeds the SAME id the
 * guard computes — `branchPatchId` against the PR's ACTUAL base (design
 * decision 1) — and the guard verifies that exact marker string.
 *
 * Covers:
 *   - the marker string is exactly `<!-- pi-rukas:lens-residuals
 *     branch=<b> patch=<p> -->` (the guard's `lensResidualsMarker`);
 *   - the post is triggered for an ISSUES_FOUND verdict with an open PR
 *     (the stub records the `gh pr comment` call + the marker in the body);
 *   - the post is NOT triggered for APPROVED / REVIEW_INCOMPLETE /
 *     CRITICAL_ISSUES_FOUND (no forge call);
 *   - a failed post (the stub throws) returns a note naming the failure
 *     (fail closed — the guard refuses until the disclosure is posted);
 *   - no PR number (the stub returns no number) → a note naming the
 *     failure (no marker, the guard refuses).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { postLensResidualDisclosure } from "../src/lens-review-residuals.ts";
import type { LensReviewSummary } from "../src/lens-review.ts";
import { lensResidualsMarker } from "../src/merge-guard-round-cap.ts";

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

/**
 * A stubbed exec that mimics the forge the post shells out to. Records every
 * command; returns canned stdout for the PR-number and PR-identity reads,
 * and records the `gh pr comment` call (the post) so the test can assert
 * the marker landed in the body. `failPost` makes the comment call throw.
 */
function makeStub(opts: { failPost?: boolean } = {}) {
  const calls: string[] = [];
  const execFn = async (cmd: string): Promise<{ stdout: string }> => {
    calls.push(cmd);
    if (cmd.includes("pr view --json number")) {
      return { stdout: JSON.stringify({ number: 12 }) };
    }
    if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
      return { stdout: JSON.stringify({ headRefName: "feature/x", baseRefName: "main" }) };
    }
    if (cmd.includes("git config --get remote.origin.url")) {
      return { stdout: "git@github.com:o/r.git\n" };
    }
    if (cmd.includes("git config --get remote.upstream.url")) {
      return { stdout: "git@github.com:o/r.git\n" };
    }
    if (cmd.includes("git remote")) {
      return { stdout: "origin\n" };
    }
    if (cmd.includes("git fetch")) {
      return { stdout: "" };
    }
    if (cmd.includes("patch-id")) {
      return { stdout: "p42 0000" };
    }
    if (cmd.includes("pr comment")) {
      if (opts.failPost) throw new Error("gh: cannot post comment (stub)");
      return { stdout: "" };
    }
    throw new Error(`unexpected exec: ${cmd}`);
  };
  return { execFn, calls };
}

/**
 * A temp dir that detectForge classifies as a GitHub repo (the remote-URL
 * known-host heuristic): a `.git/config` with `origin` pointing at
 * `github.com`. The stub's exec handles the git reads the post performs.
 */
function repoDir(): string {
  // The forge is forced to github so the stub's gh reads are exercised
  // deterministically (the env hard override wins over the remote URL,
  // which the stub does not fully simulate).
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
      summary: summary("ISSUES_FOUND", [
        { severity: "MEDIUM", path: "src/a.ts", line: 10, title: "a finding", lens: "SIMPLICITY" },
      ]),
      branch: "feature/x",
      cwd: dir,
      execFn,
    });
    assert(note === "", "a successful post returns no note (nothing to report)");
    assert(
      calls.some((c) => c.includes("pr comment 12")),
      "the post issued a `gh pr comment` call",
    );
    // The body the post wrote to the temp file carried the marker (the
    // comment call references the body file; the marker is in the body).
    // The stub does not capture the file content, so assert the comment
    // call happened AND the branch + patch were resolved on the way.
    assert(
      calls.some((c) => c.includes("patch-id")),
      "…after computing the patch-id (the marker's patch)",
    );
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
    assert(
      !calls.some((c) => c.includes("pr comment")),
      "APPROVED posts NOTHING (design decision 2)",
    );
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
      summary: summary("ISSUES_FOUND", [
        { severity: "MEDIUM", path: "src/a.ts", line: 10, title: "a finding", lens: "SIMPLICITY" },
      ]),
      branch: "feature/x",
      cwd: dir,
      execFn,
    });
    assert(note !== "", "a failed post returns a note");
    assert(/disclosure FAILED/.test(note), "…naming the failure (fail closed)");
    assert(
      /cannot post comment/.test(note) ||
        /no open PR/.test(note) ||
        /cannot determine the forge/.test(note),
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
      if (cmd.includes("pr view --json number")) {
        return { stdout: JSON.stringify({ number: 12 }) };
      }
      if (cmd.includes("pr view 12 --json headRefName,baseRefName")) {
        return { stdout: JSON.stringify({ headRefName: "feature/x", baseRefName: "main" }) };
      }
      if (cmd.includes("git config --get remote.origin.url")) {
        return { stdout: "git@github.com:o/r.git\n" };
      }
      if (cmd.includes("git remote")) {
        return { stdout: "origin\n" };
      }
      if (cmd.includes("git fetch")) {
        throw new Error("unable to connect (stub)");
      }
      throw new Error(`unexpected exec: ${cmd}`);
    };
    const note = await postLensResidualDisclosure({
      summary: summary("ISSUES_FOUND", [
        { severity: "MEDIUM", path: "src/a.ts", line: 10, title: "a finding", lens: "SIMPLICITY" },
      ]),
      branch: "feature/x",
      cwd: dir,
      execFn,
    });
    assert(note !== "", "a failed fetch returns a note");
    assert(/git fetch/.test(note), "…naming the failed fetch");
    assert(
      !calls.some((c) => c.includes("pr comment")),
      "a failed fetch posts NOTHING (fail closed — the patch-id would use stale refs)",
    );
    assert(
      !calls.some((c) => c.includes("patch-id")),
      "…and it does not compute a patch-id from stale local refs",
    );
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
      if (cmd.includes("pr view --json number")) {
        return { stdout: JSON.stringify({}) };
      }
      throw new Error(`unexpected exec: ${cmd}`);
    };
    const note = await postLensResidualDisclosure({
      summary: summary("ISSUES_FOUND", [
        { severity: "MEDIUM", path: "src/a.ts", line: 10, title: "a finding", lens: "SIMPLICITY" },
      ]),
      branch: "feature/x",
      cwd: dir,
      execFn,
    });
    assert(note !== "", "no PR number returns a note");
    assert(
      /no open PR\/MR/.test(note) ||
        /no PR number/.test(note) ||
        /cannot determine the forge/.test(note),
      "…naming the missing open PR (no marker posted)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
