#!/usr/bin/env bun
/**
 * The WORKING branch of a review's patch identity vs. the PRODUCTION mainline.
 *
 * The shape this pins is a project whose release flow is
 * `feature → staging → (operator publishes prod from main by hand)`: every PR
 * is opened against `staging` while `origin/HEAD` still points at `main`.
 *
 * Two sides, and they must NOT share one rule:
 *
 *   - the WORKING side (`workingTreePatchId`, the round budget, the ledger
 *     writer) keys its identity on the PR's own base branch. Taking it against
 *     the production mainline instead makes the diff EMPTY whenever the
 *     checkout sits at/below main — the fixture below is a branch whose CI fix
 *     has since landed, so HEAD is a true ancestor of `origin/main` and
 *     `git diff <merge-base>` yields nothing. No diff ⇒ no patch id ⇒ the
 *     round cannot be recorded ⇒ admission refuses fail closed (#1127) and the
 *     review cannot run at all.
 *   - the PRODUCTION side (`mergeIdentity`, merge-guard-reads.ts) keeps
 *     requiring `baseBranch === mainline`. That is the #1305 rule and is
 *     unchanged here: a PR that does not merge to mainline has no mainline
 *     identity for the guard to match, so it still fails closed by name.
 *
 * The empty-diff refusal is pinned too. It must name the base ref and say HEAD
 * sits at/below it, and must NOT blame the round cap or offer its override as
 * the remedy: #1140 made the caps WARN rather than refuse, so presenting
 * `PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE=1` as the fix for an empty diff points
 * the operator at a knob that cannot produce a diff.
 *
 * No live spawn: setupSpawnGuard() forbids it; nothing here dispatches a lens.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "lens-working-branch-"));
const ledgerFile = path.join(root, "review-ledger.json");
// The override short-circuits git for the ledger path (see ledgerPathFor), so
// the ledger is private to this test and never touches the real clone's.
process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = ledgerFile;
process.env.PI_ENSEMBLE_SKILLS_DIR = path.join(root, "no-skills");
mkdirSync(path.join(root, "no-skills"), { recursive: true });
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

const repo = path.join(root, "repo");
mkdirSync(repo);
const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: repo, stdio: "pipe" }).toString();
git("init -q -b main");
git("config user.email t@example.com");
git("config user.name t");
writeFileSync(path.join(repo, "a.txt"), "one\n");
git("add -A");
git('commit -q -m "seed"');

const remote = path.join(root, "remote.git");
// `-b main` pins the bare remote's HEAD to the production mainline, so `git
// fetch` sets origin/HEAD → origin/main whatever the host's
// init.defaultBranch is. That IS the operator's flow: origin/HEAD means PROD
// while every PR is opened against staging.
execSync(`git init -q --bare -b main ${remote}`);
git(`remote add origin ${remote}`);
// staging diverges: it holds work main does not have.
git("checkout -q -b staging");
writeFileSync(path.join(repo, "staging-only.txt"), "staging work\n");
git("add -A");
git('commit -q -m "staging work"');
// The PR branch: one commit on top of staging — the PR's real content.
git("checkout -q -b feature/pet");
writeFileSync(path.join(repo, "pet.txt"), "pet\n");
git("add -A");
git('commit -q -m "pet"');
// The CI-fix branch was cut from the feature tip and has since landed on main,
// so main DESCENDS from HEAD: the feature tip is a true ancestor of
// origin/main and its mainline diff is empty.
git("checkout -q -b ci-fix");
writeFileSync(path.join(repo, "ci.txt"), "ci\n");
git("add -A");
git('commit -q -m "ci job fix"');
git("checkout -q main");
git("merge -q --no-ff --no-edit ci-fix");
git("push -q origin main");
git("push -q origin staging");
git("push -q origin feature/pet");
git("fetch -q origin");
git("checkout -q feature/pet");

const featureHead = git("rev-parse HEAD").trim();

// -------------------------------------------------------- the fixture itself
assert(
  git("symbolic-ref --short refs/remotes/origin/HEAD").trim() === "origin/main",
  "fixture: origin/HEAD points at the production mainline while PRs target staging",
);
let ancestor = true;
try {
  git("merge-base --is-ancestor HEAD origin/main");
} catch {
  ancestor = false;
}
assert(
  ancestor && git("merge-base HEAD origin/main").trim() === featureHead,
  "fixture: the checkout is a true ancestor of origin/main, so a mainline diff is empty",
);
assert(
  git("merge-base HEAD origin/staging").trim() !== featureHead,
  "fixture: the PR's own base (staging) is NOT the checkout's ancestor — it has real content to review",
);

const { admitLensRound } = await import("../src/lens-round-cap.ts");
const { workingTreePatchId } = await import("../src/review-ledger.ts");
const { mergeIdentity } = await import("../src/merge-guard-reads.ts");
const { execp } = await import("../src/exec.ts");
const { writeLensLedgerEntry } = await import("../src/lens-ledger.ts");

// ---------- (a2) the PR's base comes from the forge when only `pr` is known
//
// This is the operator's actual call: `dispatch_lens_review` with a `pr` and
// no base branch. `admitLensRound` asks the forge for the PR's base, so a PATH
// stub answers the two reads that question makes (`gh` for GitHub, `glab` for
// GitLab) — the point is that the base drives the identity, not the CLI.
const bin = path.join(root, "bin");
mkdirSync(bin, { recursive: true });
const stub = (name: string, json: string) => {
  const file = path.join(bin, name);
  writeFileSync(
    file,
    `#!/bin/sh\ncase "$*" in\n*--json*) printf '%s' '${json}' ;;\n*) printf '%s' '${json}' ;;\nesac\n`,
  );
  execSync(`chmod +x ${file}`);
};
stub("gh", '{"baseRefName":"staging","headRefName":"feature/pet","target_branch":"staging"}');
stub("glab", '{"target_branch":"staging","source_branch":"feature/pet"}');
const savedPath = process.env.PATH;
const savedForge = process.env.PI_ENSEMBLE_FORGE;
process.env.PATH = `${bin}:${savedPath ?? ""}`;
process.env.PI_ENSEMBLE_FORGE = "github";
try {
  const prRun = await admitLensRound({ cwd: repo, pr: 7 });
  assert(
    prRun.admitted && prRun.baseBranch === "staging",
    "a `pr`-only run resolves the PR's base branch from the forge and is admitted on it",
  );
  if (prRun.admitted) await prRun.release();
} finally {
  process.env.PATH = savedPath;
  if (savedForge === undefined) delete process.env.PI_ENSEMBLE_FORGE;
  else process.env.PI_ENSEMBLE_FORGE = savedForge;
}

// ---------- (c) regression guard: no baseBranch supplied → mainline, as today
const asMainline = await workingTreePatchId(execp, repo);
assert(
  !asMainline.patchId && !!asMainline.warning,
  "unchanged default: with no base branch the identity is still taken against the mainline, and an empty one yields no patch id",
);
assert(
  /origin\/main/.test(asMainline.warning ?? ""),
  "the mainline-path warning names the ref the identity was taken against",
);

// ---------- (a) a PR based on a non-mainline integration branch admits
const withStaging = await workingTreePatchId(execp, repo, { baseBranch: "staging" });
assert(
  !!withStaging.patchId && !!withStaging.diffSha256 === false,
  "workingTreePatchId against the PR's base branch computes an id where the mainline one is empty",
);
assert(
  (await workingTreePatchId(execp, repo, { baseBranch: "feature/pet" })).patchId === undefined,
  "a base that IS the branch is still empty — naming a base is not a way to fabricate an identity",
);

const admission = await admitLensRound({ cwd: repo, baseBranch: "staging" });
assert(
  admission.admitted && admission.baseBranch === "staging",
  "the review is admitted when the budget is keyed on the PR's base branch, and the admission carries it",
);
if (admission.admitted) await admission.release();

const noBase = await admitLensRound({ cwd: repo });
assert(
  !noBase.admitted && noBase.refusal.verdict === "ROUND_CAP_REACHED",
  "unchanged fail-closed behaviour: with no base branch the same checkout is still refused",
);

// ---------- (b) the empty-diff refusal tells the truth
assert(
  !/ROUND_CAP_REACHED —/.test(noBase.refusal.note ?? "") &&
    !/PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE/.test(noBase.refusal.note ?? ""),
  "the empty-diff refusal does not blame the round cap or offer its override as the remedy (#1140: the caps warn, they do not refuse)",
);
assert(
  /origin\/main/.test(noBase.refusal.note ?? "") &&
    /at or below|ancestor/i.test(noBase.refusal.note ?? ""),
  "the empty-diff refusal names the base ref and says HEAD sits at/below it",
);
// With a base branch supplied, the empty case stays distinguishable from a
// wrong base: it is still refused (nothing to review is nothing to review) and
// still names the ref it diffed against.
const emptyAdmission = await admitLensRound({ cwd: repo, baseBranch: "feature/pet" });
assert(
  !emptyAdmission.admitted &&
    /feature\/pet/.test(emptyAdmission.refusal.note ?? "") &&
    !/PI_ENSEMBLE_LENS_ROUND_CAP_OVERRIDE/.test(emptyAdmission.refusal.note ?? ""),
  "a genuinely empty diff against a CORRECT base is still refused, naming the base ref, with no override remedy",
);

// ---------- (d) production mergeIdentity still refuses a non-mainline base
const prodStaging = await mergeIdentity(execp, repo, "feature/pet", "staging");
assert(
  prodStaging.ok === false && /not the mainline/.test(prodStaging.reason ?? ""),
  "mergeIdentity still refuses a PR based on a non-mainline branch (the #1305 production rule is intact)",
);
// The working-base option must not reach the production gate: a caller cannot
// make the guard accept an integration branch by way of the review side.
const prodMain = await mergeIdentity(execp, repo, "feature/pet", "main");
assert(
  prodMain.ok === false && /empty/.test(prodMain.reason ?? ""),
  "mergeIdentity against the real mainline reports the honest empty diff rather than passing",
);

// ---------- the ledger writer records against the PR base when one is supplied
const rows = (): Record<string, unknown>[] =>
  existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, "utf8")).entries : [];
writeFileSync(ledgerFile, JSON.stringify({ entries: [] }));
const recorded = await writeLensLedgerEntry(
  "APPROVED",
  "MEDIUM",
  repo,
  "feature/pet",
  false,
  featureHead,
  undefined,
  "feature/pet",
  false,
  "staging",
);
assert(recorded.recorded === true, "the lens writer records the round when given the PR's base");
assert(
  rows().some((e) => e.kind === "lens" && e.branch === "feature/pet" && !!e.patchId),
  "the recorded row carries the patch id computed against the PR base",
);
// The same writer with no base branch writes NOTHING for this checkout (the
// mainline diff is empty) — so (a) is the fix taking effect, not a difference
// in the fixture between the two calls.
const unbaseled = await writeLensLedgerEntry(
  "APPROVED",
  "MEDIUM",
  repo,
  // A DIFFERENT key: `dedupeLatest` keeps one row per (branch, kind), so
  // writing under the key used above would replace that row and the
  // no-base-branch case would be judged on the previous write's evidence.
  "feature/unbaseled",
  false,
  featureHead,
  undefined,
  "feature/unbaseled",
);
assert(
  unbaseled.recorded === false &&
    /no patch id|is empty/.test(unbaseled.reason ?? "") &&
    /origin\/main/.test(unbaseled.reason ?? ""),
  "without a base branch the same write still records nothing, naming the empty diff against the mainline",
);
assert(
  !rows().some((e) => e.branch === "feature/unbaseled"),
  "and it writes no row at all (fail closed, not a blank identity)",
);
// And the recorded identity is the PR-base one: recomputing against the PR base
// matches the stored row.
const stored = rows().find((e) => e.kind === "lens")?.patchId as string;
const againStaging = await workingTreePatchId(execp, repo, { baseBranch: "staging" });
assert(
  !!stored && stored === againStaging.patchId,
  "the stored patchId IS the PR-base identity (a later run recomputes the same number)",
);

process.exit(exit);
