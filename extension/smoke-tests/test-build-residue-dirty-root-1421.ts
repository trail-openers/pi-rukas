#!/usr/bin/env bun
/**
 * #1421 — build output at repoRoot is not "repoRoot is dirty".
 *
 * The incident (example-owner/orchard#248, cycle `cycle-id`, one cargo
 * workspace at the repo root). Develop finished green, the adversarial gate
 * ran, the fix pass committed — then the outcome gate refused the step:
 *
 *   consolidated verify was refused — repoRoot is dirty (target/.rustc_info.json,
 *   target/CACHEDIR.TAG, target/debug/.cargo-*-lock) …
 *
 * Cargo's own build output and lock files, written at the root by the driver's
 * OWN root-level gate run, unignored because the base's `.gitignore` covers
 * `/console/target/` and nothing covers `/target/`. The change whose whole
 * point was the root build was refused verification by residue the driver
 * produced, and the park carried `verify-failed:develop` — the cap pi-rukas
 * reserves for a gate that judged the code. 2.8 h and 16.3M tokens, no PR, and
 * `err.txt` empty.
 *
 * Four assertions, in the order the failure happened:
 *
 *   1. THE CLASSIFIER — `git status --ignored=matching` is the only source, so
 *      an untracked path git declares ignored is residue and a tracked
 *      modification is not, whatever the pattern file says. An unreadable read
 *      classifies EVERYTHING as dirt (fail closed = the pre-#1421 shape).
 *   2. THE GATE — cargo's `target/` at the root no longer refuses the batch:
 *      the probe runs, and nothing is cleaned. Asserted at N>1, where #1240's
 *      duplicate-run skip cannot apply, so "passed" cannot be the skip doing
 *      the work; and with a genuine verify failure beside it, which still
 *      reports `failed` and is never decorated with the residue label.
 *   3. THE CAP — `[build-residue]` alone parks `verify-env:develop`, one real
 *      failure beside it keeps `verify-failed:develop`, and the cap-hit carries
 *      the paths as evidence (the incident's empty err.txt is not repeated).
 *   4. THE HANDOFF — a declined consolidation names the driver's reason AND the
 *      worktrees + HEAD SHAs where the reviewed commits still are, instead of
 *      the fixed "consolidation infeasible (work remains on its worktree
 *      detached HEADs)" that said nothing about either.
 *
 * Offline: temp git repos, real git for the ignore semantics (the whole point
 * is git's opinion of the path, not a pattern list this driver maintains).
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { appendDevelopVerifyFailure } from "../src/work-develop-verify-failure.ts";
import { reportConsolidatedVerifyOutcome } from "../src/work-driver-consolidated-verify-report.ts";
import { runConsolidatedVerify } from "../src/work-driver-consolidated-verify.ts";
import type { ConsolidatedVerifyResult } from "../src/work-driver-consolidated-verify.ts";
import {
  BUILD_RESIDUE_LABEL,
  buildResidueFailure,
  classifyRootDirt,
  readIgnoredPaths,
} from "../src/work-driver-dirty-root-classify.ts";
import { consolidateWorktreesToBranch } from "../src/work-driver-handoff-consolidate.ts";
import { makeHandoffEmittedEvent } from "../src/work-driver-handoff-post.ts";
import type { HandoffCommittedWorkEntry } from "../src/work-driver-handoff-post.ts";
import { verifyCapFor } from "../src/work-driver-verify-develop-helpers.ts";
import { humanActionFor } from "../src/work-queue.ts";
import type { WorkCapLiteral } from "../src/workflow-state-events-caps.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { realExec } from "./lib/exec-fake.ts";

const execFileP = promisify(execFile);
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
const gitOut = async (cwd: string, args: string[]): Promise<string> =>
  (await git(cwd, args)).stdout.trim();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const RESIDUE = [
  "target/.rustc_info.json",
  "target/CACHEDIR.TAG",
  "target/debug/.cargo-lock",
] as const;

/** A repo whose `.gitignore` covers the residue — the state the classifier can prove. */
async function makeRepo(repo: string): Promise<string> {
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  writeFileSync(path.join(repo, ".gitignore"), "/console/target/\n/target/\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  return gitOut(repo, ["rev-parse", "HEAD"]);
}

/** Cargo's build output, exactly as the incident left it. */
function writeResidue(repo: string) {
  for (const rel of RESIDUE) {
    const abs = path.join(repo, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      rel.endsWith(".json") ? "{}" : rel.includes("CACHEDIR") ? "Signature: 8a" : "",
    );
  }
}

/** A worktree at `baseSha` with one commit of its own. */
async function worktreeWithCommit(repo: string, name: string, baseSha: string, file: string) {
  const wt = path.join(repo, ".worktrees", name);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, file), `// ${file}\n`);
  await git(wt, ["add", file]);
  await git(wt, ["commit", "-q", "-m", `feat: ${file}`]);
  return wt;
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1421-"));

try {
  // =============================================== 1. the classifier
  {
    const repo = path.join(root, "classify");
    const base = await makeRepo(repo);
    writeResidue(repo);
    writeFileSync(path.join(repo, "stray-source.ts"), "export const x = 1;\n");

    const ignored = await readIgnoredPaths(realExec, repo);
    assert(
      ignored !== undefined && ignored.has("target"),
      "#1: git declares target/ ignored (the fixture is honest)",
    );

    const lines = [...RESIDUE.map((p) => `?? ${p}`), "?? stray-source.ts", " M a.txt"];
    const c = classifyRootDirt(lines, ignored);
    assert(
      c.dirt.length === 2 &&
        c.dirt.some((l) => l.includes("stray-source.ts")) &&
        c.dirt.some((l) => l.startsWith(" M ")),
      `#1: only the unignored untracked file and the tracked edit stay dirt (dirt: ${JSON.stringify(c.dirt)})`,
    );
    assert(
      c.residue.length === 3 && c.residue.every((r) => r.reason === "git-ignored"),
      "#1: all three cargo paths classify as git-ignored residue",
    );
    assert(
      classifyRootDirt(["?? target/x.json"], undefined).dirt.length === 1,
      "#1: an unreadable ignored list means every path is dirt — the fail-closed direction",
    );
    assert(
      classifyRootDirt(["?? target/x.json"], new Set()).dirt.length === 1,
      "#1: an EMPTY ignored list (git answered, nothing is ignored) is not read as an exemption",
    );
    assert(
      classifyRootDirt(["?? tmp/issue-9/x.txt"], new Set(["target"])).dirt.length === 0,
      "#1: the driver's own scratch (tmp/issue-<N>/) is never dirt",
    );
    assert(
      classifyRootDirt(["?? tmp/evil.ts"], new Set(["target"])).dirt.length === 0,
      "#1 (documented): the shared gate predicate already drops any untracked `?? tmp/…` line, so the classifier never sees one — its own scratch list is a backstop for a caller that hands it raw lines, and this pins which of the two is doing the work",
    );
    assert(
      classifyRootDirt(["?? src/evil.ts"], new Set(["target"])).dirt.length === 1,
      "#1: an untracked file outside git's ignore list and outside the driver's prefixes is dirt",
    );
    void base;
  }

  // =============================================== 2. the gate runs despite the residue
  {
    const repo = path.join(root, "gate");
    const base = await makeRepo(repo);
    writeResidue(repo);
    // N>1 so #1240's skip cannot apply and the verify command genuinely runs
    // at repoRoot — the tree the residue is accused of dirtying.
    const a = await worktreeWithCommit(repo, "issue-1421-a", base, "a.rs");
    const b = await worktreeWithCommit(repo, "issue-1421-b", base, "b.rs");

    const cons = await runConsolidatedVerify(realExec, {
      repoRoot: repo,
      baseSha: base,
      worktrees: { a, b },
      scratchDir: path.join(repo, "tmp", "issue-1421"),
      verifyCmd: "true",
      timeoutMs: 5000,
    });
    assert(
      cons.status === "passed" && cons.skipped === undefined,
      `#2: two workstreams + residue — the probe RUNS (not skipped, not refused) (status: ${cons.status})`,
    );
    assert(
      existsSync(path.join(repo, "target", "CACHEDIR.TAG")),
      "#2: the build output SURVIVED — the driver preserves what it does not own",
    );

    // A real verdict beside the residue is still a verdict.
    const consF = await runConsolidatedVerify(realExec, {
      repoRoot: repo,
      baseSha: base,
      worktrees: { a, b },
      scratchDir: path.join(repo, "tmp", "issue-1421"),
      verifyCmd: "test -f no-such-file-at-all",
      timeoutMs: 5000,
    });
    assert(
      consF.status === "failed" && !consF.detail.includes(BUILD_RESIDUE_LABEL),
      `#2: a genuine verify failure still reports failed and is never labelled residue (status: ${consF.status})`,
    );

    // Unignored untracked content still refuses (no over-exemption). Built in
    // a fresh repo: the driver's own restore after the failing run above
    // resets the tree, so residue written there would be gone before the gate
    // read it — and the refusal would report only the dirt, which is exactly
    // what this assertion exists to catch.
    {
      // A refusal must say which of the two it saw. The gate's own dirt read
      // (`git status --porcelain -uall`) collapses a wholly-ignored directory
      // away entirely, so residue never reaches the classifier as a line and
      // the note is absent — correct, and proven by the pass case above. What
      // this pins is the note's own wording: when residue lines ARE in the
      // batch (git lists them by name, as it does for a file under a tracked
      // directory), the refusal counts them and says they were not charged.
      const repo2 = path.join(root, "gate-dirty");
      const base2 = await makeRepo(repo2);
      writeFileSync(path.join(repo2, ".gitignore"), "/dist/bundle.js\n/build/\n");
      mkdirSync(path.join(repo2, "dist"), { recursive: true });
      writeFileSync(path.join(repo2, "dist", "keep.txt"), "tracked\n");
      await git(repo2, ["add", ".gitignore", "dist/keep.txt"]);
      await git(repo2, ["commit", "-q", "-m", "track dist/, ignore the bundler output inside it"]);
      const a2 = await worktreeWithCommit(repo2, "issue-1421-c", base2, "c.rs");
      const b2 = await worktreeWithCommit(repo2, "issue-1421-d", base2, "d.rs");
      writeFileSync(path.join(repo2, "dist", "bundle.js"), "bundle\n");
      writeFileSync(path.join(repo2, "operator-work.ts"), "export const y = 2;\n");

      // The classifier, on the lines the gate's read would have carried had git
      // listed them: the residue is discounted and the dirt survives alone.
      const mixed = classifyRootDirt(
        ["?? dist/bundle.js", "?? operator-work.ts"],
        await readIgnoredPaths(realExec, repo2),
      );
      assert(
        mixed.dirt.length === 1 &&
          mixed.dirt[0].includes("operator-work.ts") &&
          mixed.residue.length === 1 &&
          mixed.residue[0].reason === "git-ignored",
        `#2: given the residue as a line, the classifier discounts it and keeps the dirt (dirt ${JSON.stringify(
          mixed.dirt,
        )}, residue ${JSON.stringify(mixed.residue)})`,
      );

      const consD = await runConsolidatedVerify(realExec, {
        repoRoot: repo2,
        baseSha: base2,
        worktrees: { a: a2, b: b2 },
        scratchDir: path.join(repo2, "tmp", "issue-1421"),
        verifyCmd: "true",
        timeoutMs: 5000,
      });
      assert(
        consD.status === "conflict" && consD.kind === "dirty-root",
        `#2: an UNIGNORED untracked file still refuses as dirty-root (got: ${
          consD.status === "conflict" ? consD.kind : consD.status
        })`,
      );
      assert(
        "detail" in consD && consD.detail.includes("operator-work.ts"),
        "#2: the refusal names the file the operator must decide about",
      );
      assert(
        "detail" in consD &&
          !consD.detail.includes("not counted") &&
          !consD.detail.includes("operator-work.ts, dist/"),
        "#2: the refusal charges only the dirt it can see and never dresses up residue as dirt",
      );
    }
  }

  // =============================================== 3. the cap
  {
    // Built through the gate's own producer so the wording under test is the
    // wording the gate emits (a rename on either side shows up here).
    const detail = buildResidueFailure(
      [...RESIDUE],
      "the consolidated verify was declined because the repo root is not clean",
    );
    const cons: ConsolidatedVerifyResult = {
      status: "conflict",
      kind: "build-residue",
      residuePaths: [...RESIDUE],
      residueReasons: RESIDUE.map(() => "git-ignored" as const),
      detail,
    };
    const failures: string[] = [];
    reportConsolidatedVerifyOutcome(cons, {
      cmd: "bash scripts/verify.sh",
      failures,
      notes: [],
      ctx: { repoRoot: "/repo" },
      worktrees: { default: "/wt" },
      perWorktreeFailuresByWs: {},
      singlePerWs: undefined,
      singlePerAssertion: undefined,
    });
    assert(
      failures.length === 1 && failures[0].includes(BUILD_RESIDUE_LABEL),
      `#3: the reporter pushes one labelled failure (got: ${failures.join(" | ").slice(0, 120)})`,
    );
    assert(
      !/cherry-pick \/ apply conflict|could not combine the workstreams/.test(failures[0]),
      "#3: the refusal never presents as a cherry-pick conflict (that wording routes the decomposition cap)",
    );
    assert(
      verifyCapFor("develop", failures) === "verify-env:develop",
      `#3: residue alone parks verify-env, never verify-failed (got: ${verifyCapFor("develop", failures)})`,
    );
    assert(
      verifyCapFor("develop", [...failures, "verify command `x` failed: expected 1"]) ===
        "verify-failed:develop",
      "#3: one real failure beside the residue keeps verify-failed — the label cannot mask a verdict",
    );

    let s = initialState(1421, 1_000_000) as WorkState;
    s = {
      ...s,
      pipelineState: { ...s.pipelineState, currentStep: "develop", worktrees: { default: "/wt" } },
    };
    const withCap = appendDevelopVerifyFailure(s, { ok: false, failures, notes: [] } as never);
    const hit = [...withCap.eventLog].reverse().find((e) => e.kind === "cap-hit");
    assert(
      hit?.kind === "cap-hit" && hit.cap === ("verify-env:develop" as WorkCapLiteral),
      `#3: the develop step records verify-env:develop (got: ${hit?.kind === "cap-hit" ? hit.cap : "none"})`,
    );
    assert(
      hit?.kind === "cap-hit" && (hit.evidence ?? "").includes("target/"),
      "#3: the cap carries the residue paths as evidence — the handoff is not empty",
    );
    assert(
      /CARGO_TARGET_DIR|build out/i.test(
        humanActionFor("cap verify-env:develop:build-residue", 1421),
      ),
      "#3: the queue action points at the build, not the diff",
    );
  }

  // =============================================== 4. the handoff names the work
  {
    const repo = path.join(root, "consolidate");
    const base = await makeRepo(repo);
    const a = await worktreeWithCommit(repo, "issue-1421-a", base, "a.rs");
    // Dirt the consolidation cannot sweep: an unignored untracked file.
    writeFileSync(path.join(repo, "operator-work.ts"), "export const y = 2;\n");

    let s = initialState(1421, 1_000_000) as WorkState;
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        branchName: "feature/issue-1421-x",
        baseSha: base,
        worktrees: { a },
      },
    };
    const out = await consolidateWorktreesToBranch(
      { repoRoot: repo, issue: 1421, scratchDir: path.join(repo, "tmp", "issue-1421") },
      s,
    );
    assert(
      out.ok === false,
      "#4: a dirty root still refuses consolidation (this half is unchanged)",
    );
    assert(
      out.ok === false && /operator-work\.ts/.test(out.reason ?? ""),
      `#4: the refusal names the dirt (got: ${(out.ok ? "" : (out.reason ?? "")).slice(0, 140)})`,
    );

    const head = await gitOut(a, ["rev-parse", "HEAD"]);
    const committedWork: HandoffCommittedWorkEntry[] = [
      { worktreeId: "a", path: a, headSha: head, ahead: 1 },
    ];
    const ev = makeHandoffEmittedEvent({
      at: Date.now(),
      commentUrl: undefined,
      labelApplied: false,
      handoffBodyPath: "/tmp/body.md",
      consolidated: false,
      consolidationReason: `consolidation did not run — the committed work is NOT lost: ${committedWork
        .map(
          (w) =>
            `worktree ${w.worktreeId} at ${w.path} (HEAD ${w.headSha.slice(0, 8)}, ${w.ahead} commit(s) ahead of the base)}`,
        )
        .join("; ")}. See the recovery steps below for the cherry-pick commands; driver's reason: ${
        out.ok ? "" : out.reason
      }`,
    });
    assert(
      (ev.consolidationReason ?? "").includes("NOT lost") &&
        (ev.consolidationReason ?? "").includes(a) &&
        (ev.consolidationReason ?? "").includes(head.slice(0, 8)),
      "#4: the handoff reason names the worktree path AND the HEAD sha where the commits are",
    );
    assert(
      (ev.consolidationReason ?? "").includes("driver's reason:") &&
        (ev.consolidationReason ?? "").includes("operator-work.ts"),
      "#4: the handoff reason carries the driver's actual cause, not a fixed sentence",
    );
    assert(
      !(ev.consolidationReason ?? "").includes("consolidation infeasible"),
      "#4: the old fixed 'consolidation infeasible' wording is gone",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
