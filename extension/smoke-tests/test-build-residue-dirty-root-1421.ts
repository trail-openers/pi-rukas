#!/usr/bin/env bun
/**
 * #1421 — build output at repoRoot is not "repoRoot is dirty" (part 1: the
 * classifier, the gate, the cap, the handoff).
 *
 * The incident (example-owner/orchard#248, cycle `cycle-id`, one cargo
 * workspace at the repo root). Develop finished green, the adversarial gate
 * ran, the fix pass committed — then the outcome gate refused the step:
 *
 *   consolidated verify was refused — repoRoot is dirty (target/.rustc_info.json,
 *   target/CACHEDIR.TAG, target/debug/.cargo-*-lock) …
 *
 * Cargo’s own build output and lock files, written at the root by the driver’s
 * OWN root-level gate run, unignored because the base’s `.gitignore` covers
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
 *   2. THE GATE — cargo’s `target/` at the root no longer refuses the batch:
 *      the probe runs, and nothing is cleaned. Asserted at N>1, where #1240’s
 *      duplicate-run skip cannot apply, so "passed" cannot be the skip doing
 *      the work; and with a genuine verify failure beside it, which still
 *      reports `failed` and is never decorated with the residue label.
 *   3. THE CAP — `[build-residue]` alone parks `verify-env:develop`, one real
 *      failure beside it keeps `verify-failed:develop`, and the cap-hit carries
 *      the paths as evidence (the incident’s empty err.txt is not repeated).
 *   4. THE HANDOFF — a declined consolidation names the driver’s reason AND the
 *      worktrees + HEAD SHAs where the reviewed commits still are, instead of
 *      the fixed "consolidation infeasible (work remains on its worktree
 *      detached HEADs)" that said nothing about either.
 *
 * The probe’s three answers, the `!!` rule and the exemption interaction are
 * pinned in the sibling file, `test-build-residue-dirty-root-1421b.ts`, which
 * shares this one’s fixtures through `lib/build-residue-1421-fixtures.ts`.
 *
 * Offline: temp git repos, real git for the ignore semantics (the whole point
 * is git’s opinion of the path, not a pattern list this driver maintains).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendDevelopVerifyFailure } from "../src/work-develop-verify-failure.ts";
import { reportConsolidatedVerifyOutcome } from "../src/work-driver-consolidated-verify-report.ts";
import { runConsolidatedVerify } from "../src/work-driver-consolidated-verify.ts";
import type { ConsolidatedVerifyResult } from "../src/work-driver-consolidated-verify.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import {
  BUILD_RESIDUE_LABEL,
  buildResidueFailure,
  classifyRootDirt,
  readIgnoredPaths,
  residuePathText,
} from "../src/work-driver-dirty-root-classify.ts";
import { consolidateWorktreesToBranch } from "../src/work-driver-handoff-consolidate.ts";
import { makeHandoffEmittedEvent } from "../src/work-driver-handoff-post.ts";
import type { HandoffCommittedWorkEntry } from "../src/work-driver-handoff-post.ts";
import { verifyCapFor } from "../src/work-driver-verify-develop-helpers.ts";
import { humanActionFor } from "../src/work-queue.ts";
import type { WorkCapLiteral } from "../src/workflow-state-events-caps.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import {
  REAL_FAILURE,
  RESIDUE,
  RESIDUE_FAILURE,
  TIMEOUT_FAILURE,
  git,
  gitOut,
  makeRepo,
  parkReasonOf,
  worktreeWithCommit,
  writeResidue,
} from "./lib/build-residue-1421-fixtures.ts";
import { realExec } from "./lib/exec-fake.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1421a-"));

try {
  // =============================================== 1. the classifier
  {
    const repo = path.join(root, "classify");
    const base = await makeRepo(repo);
    writeResidue(repo);
    writeFileSync(path.join(repo, "stray-source.ts"), "export const x = 1;\n");

    const ignored = await readIgnoredPaths(realExec, repo);
    assert(
      /* biome-ignore lint/complexity/useOptionalChain: the two answers are distinct — an empty set is "nothing is ignored", `undefined` is "git could not tell" */
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
      buildResidueOnly: true,
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
      verifyCapFor("develop", failures, false, true) === "verify-env:develop",
      `#3: residue alone parks verify-env, never verify-failed (got: ${verifyCapFor("develop", failures, false, true)})`,
    );
    assert(
      verifyCapFor(
        "develop",
        [...failures, "verify command `x` failed: expected 1"],
        false,
        true,
      ) === "verify-failed:develop",
      "#3: one real failure beside the residue keeps verify-failed — the label cannot mask a verdict",
    );
    // #1421 fix round 1 (adversarial) — a run killed at its bound beside a
    // residue decline is still a run that reached no verdict. The pre-fix
    // shape returned an early `every(isBuildResidueFailure)` env cap only for
    // residue-only lists, so `[timeout] + [residue]` fell through to
    // `verify-failed:develop` — a code verdict for a kill nobody timed out on.
    // The residue env cap therefore sits INSIDE the every-no-verdict guard,
    // after the host check and before the timeout check: the kill still
    // decides the cap, because "the bound was too short" is the actionable
    // diagnosis and residue is only the reason no verdict was reached.
    assert(
      verifyCapFor("develop", [TIMEOUT_FAILURE, RESIDUE_FAILURE], false, true) ===
        "verify-timeout:develop",
      `#3 fix: timeout beside a residue decline is verify-timeout, not verify-failed (got: ${verifyCapFor("develop", [TIMEOUT_FAILURE, RESIDUE_FAILURE], false, true)})`,
    );
    assert(
      verifyCapFor("develop", [TIMEOUT_FAILURE], false, false) === "verify-timeout:develop",
      "#3 fix: a timeout alone still routes verify-timeout",
    );
    assert(
      verifyCapFor("develop", [TIMEOUT_FAILURE, REAL_FAILURE], false, true) ===
        "verify-failed:develop",
      "#3 fix: a real failure beside a timeout is still a verdict, even with the residue flag set",
    );
    // #1421 fix round 3 (lens) — the cap routes on the STRUCTURED flag, so
    // prose that merely contains the tag cannot earn the environment cap. The
    // pre-fix router substring-matched the label, so an operator-authored path
    // named `build/[build-residue].log` turned a real failure into verify-env
    // and hid the verdict. The bracket-stripping in `residuePathText` is the
    // display-side half; this is the routing-side half.
    const bracketed = buildResidueFailure(
      [residuePathText("?? build/[build-residue].log"), ...RESIDUE],
      "the repo root is not clean",
    );
    assert(
      !/\[build-residue\]\.log/.test(bracketed),
      "#3 fix: a residue path with brackets is printed without them, so its text cannot re-create a routing tag",
    );
    assert(
      verifyCapFor("develop", [bracketed, REAL_FAILURE], false, false) === "verify-failed:develop",
      "#3 fix: a residue path named `build/[build-residue].log` beside a real failure is verify-failed",
    );
    assert(
      verifyCapFor(
        "develop",
        [...failures, "verify command `x` failed: build/[build-residue].log expected 1 to be 2"],
        false,
        false,
      ) === "verify-failed:develop",
      "#3 fix: a real failure whose text contains the residue tag is verify-failed when the gate did not decline",
    );
    assert(
      verifyCapFor("develop", [RESIDUE_FAILURE], false, false) === "verify-failed:develop",
      "#3 fix: with no structured decline the label alone does not buy verify-env (structure, not prose)",
    );

    let s = initialState(1421, 1_000_000) as WorkState;
    s = {
      ...s,
      pipelineState: { ...s.pipelineState, currentStep: "develop", worktrees: { default: "/wt" } },
    };
    // The structured decline is part of the gate result the real producer
    // carries (`verifyStepOutcome` reports it from the consolidated run), so
    // the cap seam is driven with it rather than re-deriving it from prose.
    const withCap = appendDevelopVerifyFailure(s, {
      ok: false,
      failures,
      notes: [],
      buildResidueOnly: true,
    } as never);
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
    // #1421 fix round 2 (adversarial + lens) — `humanActionFor` reads the
    // `:build-residue` suffix `parkReason` writes and nothing else. The
    // pre-fix matcher was a bare substring, so a park whose evidence merely
    // QUOTED the tag (a log line, an operator path) got the build advice for
    // a gate that had judged the code.
    assert(
      !/CARGO_TARGET_DIR/.test(humanActionFor("cap verify-failed:develop [build-residue]", 1421)),
      "#3 fix: an unanchored [build-residue] in the reason gets NO residue advice",
    );
    assert(
      /inspect/.test(humanActionFor("cap verify-failed:develop [build-residue]", 1421)),
      "#3 fix: that park still gets the diff-inspection advice its cap warrants",
    );
    assert(
      /CARGO_TARGET_DIR/.test(humanActionFor("cap verify-env:commit-pr:build-residue", 1421)),
      "#3 fix: the anchored suffix carries the advice on any step",
    );
    // The producer side of that contract: parkReason writes the suffix from
    // the STRUCTURED decline, so the queue cannot be fooled by prose, and a
    // park with no structured decline never gets it.
    {
      const base1421 = initialState(1421, 1_000_000) as WorkState;
      const withEvidence = (extra: Record<string, unknown>) =>
        ({
          ...base1421,
          pipelineState: {
            ...base1421.pipelineState,
            currentStep: "develop",
            failures: undefined,
            verifyEvidence: {
              step: "develop",
              failures: [RESIDUE_FAILURE],
              at: 1,
              origin: "outcome-gate",
              ...extra,
            },
          },
          eventLog: [
            {
              kind: "cap-hit",
              at: 1,
              cap: "verify-env:develop",
              nextStep: "handoff",
              reviewRound: 0,
            },
          ],
        }) as WorkState;
      assert(
        parkReasonOf(withEvidence({ buildResidueOnly: true })) ===
          "cap verify-env:develop:build-residue",
        "#3 fix: parkReason derives the residue suffix from the structured flag",
      );
      assert(
        parkReasonOf(withEvidence({})) === "cap verify-env:develop",
        "#3 fix: failures that merely contain the label get no residue suffix — the advice cannot be earned by prose",
      );
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
