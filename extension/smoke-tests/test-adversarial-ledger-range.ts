#!/usr/bin/env bun
/**
 * #1360 — the review ledger binds a tool-path row to the range it reviewed.
 *
 * The bug: the ledger recorded the FULL working-tree patch id regardless of
 * the base/head range the review actually covered, so an approving review of a
 * narrowed range left a row the merge guard read as covering the whole branch.
 * These arms build real clones, drive the REAL writers and the REAL guard, and
 * assert on the row each produced.
 *
 * The fixture + guard machinery is in lib/adversarial-ledger-harness.ts (the
 * 500-line gate). What is asserted HERE is the binding decision itself:
 * which rows pass, which are refused, and what each refusal says.
 */

import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import {
  APPROVED,
  BINDING_REFUSAL_PREFIXES,
  BRANCH,
  branchAt,
  commitOnBranch,
  editTracked,
  honestBinding,
  latest,
  readRawLedger,
  readRawLedgerFile,
  setupRepo,
  sh,
  toolArm,
} from "./lib/adversarial-ledger-harness.ts";

delete process.env.PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE;
delete process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE;
process.env.PI_ENSEMBLE_FORGE = "github";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Every refusal this module may emit is a member of the exported vocabulary —
 * the same array the guard's renderer and the spec read, so a detail the guard
 * would not recognise as a binding refusal cannot slip through these arms. */
function startsWithBindingPrefix(detail: string | undefined): boolean {
  return (
    typeof detail === "string" &&
    BINDING_REFUSAL_PREFIXES.some((prefix) => detail.startsWith(`${prefix}: `))
  );
}

try {
  // ─────────────────────────────── exact merge-base → passing, guard accepts
  {
    const { dir, mergeBase, tip } = setupRepo();
    try {
      const binding = await honestBinding(dir, mergeBase, "HEAD");
      assert(binding.reviewedBase === mergeBase, "exact merge-base: the capture records the base SHA");
      assert(binding.reviewedHead === tip, "exact merge-base: the capture records the head SHA");
      const { row, block } = await toolArm(dir, {
        base: mergeBase,
        head: "HEAD",
        binding: binding as never,
      });
      assert(row.passed === true, "exact merge-base: an approved tool review writes a PASSING row");
      assert(
        row.reviewedBase === mergeBase && row.reviewedHead === tip,
        "exact merge-base: the row carries reviewedBase and reviewedHead (#1360 identifiable)",
      );
      assert(block === false, "exact merge-base: the merge guard accepts the row");
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ───────────────────────────────── narrower base (HEAD~1) → range-not-branch
  {
    const { dir, parent, tip } = setupRepo();
    try {
      // The bug: the reviewer only saw commit B, the row still carries the
      // whole-branch working-tree identity, and pre-#1360 the guard accepted it.
      const binding = await honestBinding(dir, parent, "HEAD");
      const { row, block, reason } = await toolArm(dir, {
        base: parent,
        head: "HEAD",
        binding: binding as never,
      });
      assert(row.passed === false, "narrowed base (HEAD~1): the row is NON-PASSING");
      assert(
        startsWithBindingPrefix(row.detail) && (row.detail ?? "").startsWith("range-not-branch"),
        `narrowed base: the detail starts "range-not-branch" (got ${JSON.stringify(row.detail)})`,
      );
      assert(
        row.patchId === (await honestBinding(dir, parent, "HEAD")).reviewedTreePatchId,
        "narrowed base: the row's patchId is STILL the full-branch identity (the bug's mechanism)",
      );
      assert(block === true, "narrowed base: the merge guard refuses");
      assert(
        reason.includes("range-not-branch"),
        "narrowed base: the guard's refusal quotes the row's detail verbatim",
      );
      assert(
        reason.includes(tip.slice(0, 8)) || reason.includes(parent.slice(0, 8)),
        "narrowed base: the refusal names the reviewed range",
      );
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ─────────────────────── a base the branch does not descend from → refused
  // A base on a side branch the feature branch never contained. The range the
  // caller names reaches commits the branch does not have, so the reviewed
  // range is not the branch's and no working-tree identity can carry it.
  {
    const { dir, parent } = setupRepo();
    try {
      branchAt(dir, "side-base", parent);
      const binding = await honestBinding(dir, "side-base", "HEAD");
      const { row } = await toolArm(dir, {
        base: "side-base",
        head: "HEAD",
        binding: binding as never,
      });
      assert(
        row.passed === false && startsWithBindingPrefix(row.detail) && (row.detail ?? "").startsWith("range-not-branch"),
        `base on a branch the feature never contained: NON-PASSING range-not-branch (got passed=${row.passed}, detail=${JSON.stringify(row.detail)})`,
      );
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ───────────── a base that is still the merge-base passes after main moves
  // The #1305 counterpart to the arm above, pinned so the range gate cannot be
  // tightened into "the base must equal a fixed SHA": a moved mainline must
  // never stale a review whose base is the branch's real merge-base.
  {
    const { dir, mergeBase } = setupRepo();
    try {
      sh(dir, "checkout", "-q", "main");
      editTracked(dir, "mainline-only.txt", "mainline moves\n");
      sh(dir, "add", "-A");
      sh(dir, "commit", "-qm", "mainline moves on");
      sh(dir, "push", "-q", "origin", "main");
      sh(dir, "checkout", "-q", "feature/x");
      const binding = await honestBinding(dir, mergeBase, "HEAD");
      const { row, block } = await toolArm(dir, {
        base: mergeBase,
        head: "HEAD",
        binding: binding as never,
      });
      assert(
        row.passed === true,
        `mainline moved, base is still the merge-base: PASSING (got passed=${row.passed}, detail=${JSON.stringify(row.detail)})`,
      );
      assert(block === false, "mainline moved: the guard still accepts the review");
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ───────────────────────────────────────────────── base omitted → refused
  {
    const { dir } = setupRepo();
    try {
      const binding = await honestBinding(dir, undefined, "HEAD");
      const { row, block, reason } = await toolArm(dir, {
        head: "HEAD",
        binding: binding as never,
      });
      assert(row.passed === false, "base omitted: the row is NON-PASSING");
      assert(
        startsWithBindingPrefix(row.detail) && (row.detail ?? "").startsWith("range-not-branch"),
        "base omitted: the detail starts \"range-not-branch\"",
      );
      assert(block === true && reason.includes("range-not-branch"), "base omitted: the guard refuses with the detail");
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ─────────────────────────────── base on a non-mainline branch → refused
  {
    const { dir, parent } = setupRepo();
    try {
      // A branch whose tip IS a branch commit but is not the mainline and is
      // not the merge-base: `side-commit` sits one commit behind the tip.
      await branchAt(dir, "side-commit", parent);
      const binding = await honestBinding(dir, "side-commit", "HEAD");
      const { row } = await toolArm(dir, {
        base: "side-commit",
        head: "HEAD",
        binding: binding as never,
      });
      assert(
        row.passed === false && startsWithBindingPrefix(row.detail) && (row.detail ?? "").startsWith("range-not-branch"),
        "base on a non-mainline branch: NON-PASSING range-not-branch",
      );
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ───────────────────────────────── unresolvable base → range-unverifiable
  {
    const { dir } = setupRepo();
    try {
      const binding = await honestBinding(dir, "no-such-ref-1360", "HEAD");
      const { row, block, reason } = await toolArm(dir, {
        base: "no-such-ref-1360",
        head: "HEAD",
        binding: binding as never,
      });
      assert(row.passed === false, "unresolvable base: the row is NON-PASSING");
      assert(
        startsWithBindingPrefix(row.detail) && (row.detail ?? "").startsWith("range-unverifiable"),
        `unresolvable base: the detail starts "range-unverifiable" (got ${JSON.stringify(row.detail)})`,
      );
      assert(block === true && reason.includes("range-unverifiable"), "unresolvable base: the guard refuses with the detail");
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ───────────────────────── head moved after the approving round → head-moved
  {
    const { dir, mergeBase } = setupRepo();
    try {
      const binding = await honestBinding(dir, mergeBase, "HEAD");
      // The reviewer approved; then the branch moved before the write ran.
      commitOnBranch(dir, "late.txt", "late\n", "moved after the review");
      const { row, block, reason } = await toolArm(dir, {
        base: mergeBase,
        head: "HEAD",
        binding: binding as never,
      });
      assert(
        row.passed === false && startsWithBindingPrefix(row.detail) && (row.detail ?? "").startsWith("head-moved"),
        `head moved after the approving round: NON-PASSING head-moved (got ${JSON.stringify(row.detail)})`,
      );
      assert(block === true && reason.includes("head-moved"), "head moved: the guard refuses with the detail");
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ───────────────────── explicit older head at entry → head-not-current
  // The caller named a head that is not the branch tip. Nothing moved — the
  // review simply was never of the tip — so the detail must say "not current",
  // not "moved" (the settlement's distinction).
  //
  // The head the caller named is a commit the branch does NOT contain — an
  // older tip from a branch of its own — so the range gate has no reason to
  // refuse it (its merge-base against the mainline is itself) and only the
  // head binding can: the row's identity comes from the worktree's HEAD, which
  // is not what this review covered. The discrimination the settlement asks
  // for is the WORD: "not current", because nothing moved — the review was
  // never of the tip.
  {
    const { dir, mergeBase } = setupRepo();
    try {
      sh(dir, "checkout", "-q", "-b", "old-tip", mergeBase);
      commitOnBranch(dir, "other.txt", "a different line of work\n", "a commit the feature branch does not contain");
      const olderHead = sh(dir, "rev-parse", "HEAD");
      sh(dir, "checkout", "-q", "feature/x");
      const binding = await honestBinding(dir, mergeBase, olderHead);
      const { row, reason } = await toolArm(dir, {
        base: mergeBase,
        head: olderHead,
        binding: binding as never,
      });
      assert(
        row.passed === false && startsWithBindingPrefix(row.detail) && (row.detail ?? "").startsWith("head-not-current"),
        `explicit older head: NON-PASSING head-not-current (got ${JSON.stringify(row.detail)})`,
      );
      assert(reason.includes("head-not-current"), "explicit older head: the guard quotes the detail");
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ─────────────────────────── tree edited after the review → tree-changed
  {
    const { dir, mergeBase } = setupRepo();
    try {
      const binding = await honestBinding(dir, mergeBase, "HEAD");
      // No commit — an edit to a TRACKED file after the reviewer looked.
      editTracked(dir, "b.txt", "b\nunreviewed edit\n");
      const { row, reason } = await toolArm(dir, {
        base: mergeBase,
        head: "HEAD",
        binding: binding as never,
      });
      assert(
        row.passed === false && startsWithBindingPrefix(row.detail) && (row.detail ?? "").startsWith("tree-changed"),
        `tree edited after the review: NON-PASSING tree-changed (got ${JSON.stringify(row.detail)})`,
      );
      assert(reason.includes("tree-changed"), "tree edited: the guard quotes the detail");
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ───────────────── a check that cannot run → range-unverifiable, row written
  {
    const { dir, mergeBase } = setupRepo();
    try {
      const { row } = await toolArm(dir, {
        base: mergeBase,
        head: "HEAD",
        binding: { bindingUnavailable: "the range/head capture threw (git exploded)" },
      });
      assert(
        row.passed === false && startsWithBindingPrefix(row.detail) && (row.detail ?? "").startsWith("range-unverifiable"),
        "a check that cannot run: NON-PASSING range-unverifiable, and a row IS written",
      );
      assert(
        (row.detail ?? "").includes("git exploded"),
        "a check that cannot run: the reason the check gave is preserved",
      );
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ────────────────── no capture reached the writer → unverifiable, never pass
  // The fail-closed half of the design read off the FILE rather than the parsed
  // row: a silent skip here would leave whatever older passing row the clone
  // already held as the latest one, which is the whole defect re-opened.
  {
    const { dir, mergeBase } = setupRepo();
    try {
      const { row, ledgerPath } = await toolArm(dir, { base: mergeBase, head: "HEAD" });
      assert(
        row.passed === false && startsWithBindingPrefix(row.detail) && (row.detail ?? "").startsWith("range-unverifiable"),
        "no capture at all: the tool row is NON-PASSING, never a silent pass",
      );
      const raw = readRawLedgerFile(ledgerPath);
      const advRows = (raw.entries as Array<Record<string, unknown>>).filter(
        (e) => e.kind === "adversarial",
      );
      assert(
        advRows.length === 1 && advRows[0]?.passed === false,
        `no capture at all: the ledger file really holds the refused row (entries=${JSON.stringify(raw.entries.map((e) => (e as { kind?: string; passed?: boolean }).kind))})`,
      );
      assert(
        (advRows[0]?.detail as string | undefined) === undefined ||
          (advRows[0]?.detail as string).startsWith("range-unverifiable: "),
        "no capture at all: the row on disk carries the refusal, not a bare outcome",
      );
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ───────────────────────── the /work driver path is unchanged → passing
  {
    const { dir, mergeBase } = setupRepo();
    try {
      // The driver's shape: a `diff` string + getDiff, reportVerdict "routed",
      // NO toolPath, and no capture it never took. Provenance must never be
      // inferred from the presence of a diff.
      const { row, block } = await toolArm(dir, { driverPath: true });
      assert(
        row.passed === true,
        "driver path (no toolPath): an approving review still writes a PASSING row",
      );
      assert(
        row.reviewedBase === undefined && row.reviewedHead === undefined,
        "driver path: the row keeps its pre-#1360 shape (no reviewedBase/reviewedHead)",
      );
      assert(block === false, "driver path: the merge guard accepts the driver's row");
      void mergeBase;
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ───────── a non-main mainline (`trunk`) classifies from the resolved mainline
  // #1360 lens 2: `headPrefix` used to hardcode main/master, so on a `trunk` or
  // `develop` repo a caller that named the tip by its mainline name was refused
  // `head-not-current` for a review that WAS of the tip. Both spellings of the
  // tip must read as "nothing moved", exactly as `HEAD` does.
  {
    const { dir, mergeBase, tip } = setupRepo("trunk");
    try {
      for (const [label, named] of [
        ["`trunk`", "trunk"],
        ["`origin/trunk`", "origin/trunk"],
        ["`HEAD`", "HEAD"],
      ] as const) {
        // The tip under review is the FEATURE tip, so the capture is taken
        // against the branch — and the head check must read every spelling of
        // "the tip I am standing on" as the same thing `HEAD` means. Naming the
        // MAINLINE as the head would be a review of the mainline commit, and
        // `head-not-current` would be the right refusal (the arm below proves
        // that discrimination still fires).
        const binding = await honestBinding(dir, mergeBase, named);
        const { row, block, reason } = await toolArm(dir, { baseBranch: "trunk",
          base: mergeBase,
          head: named,
          binding: binding as never,
        });
        assert(
          row.passed === true &&
            row.reviewedBase === mergeBase &&
            row.reviewedHead === tip,
          `trunk mainline, head named ${label}: PASSING row bound to the branch range (got passed=${row.passed}, detail=${JSON.stringify(row.detail)})`,
        );
        assert(block === false, `trunk mainline, head named ${label}: the guard accepts the row (reason=${reason})`);
      }
      // And the discrimination still works on a non-main mainline: a head that
      // is NOT the tip is still `head-not-current`, not `head-moved`.
      sh(dir, "checkout", "-q", "-b", "old-tip", mergeBase);
      commitOnBranch(dir, "other.txt", "a different line of work\n", "not the feature tip");
      const olderHead = sh(dir, "rev-parse", "HEAD");
      sh(dir, "checkout", "-q", "feature/x");
      const binding = await honestBinding(dir, mergeBase, olderHead);
      const { row } = await toolArm(dir, {
        base: mergeBase,
        head: olderHead,
        binding: binding as never,
      });
      assert(
        row.passed === false &&
          startsWithBindingPrefix(row.detail) &&
          (row.detail ?? "").startsWith("head-not-current"),
        `trunk mainline, an older head named explicitly: NON-PASSING head-not-current (got ${JSON.stringify(row.detail)})`,
      );
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ─────────── the writer's execFn reaches the binding's git reads (one seam)
  // #1360 lens 6: capture and write share one injectable exec (the shape
  // `commentExecFn` already sets for the comment check). Counting the git calls
  // the injected executor sees proves the binding did NOT fall back to the real
  // executor behind the caller's back.
  {
    const { dir, mergeBase } = setupRepo();
    try {
      let gitCalls = 0;
      const real = execp as unknown as (cmd: string, o?: { argv?: string[] }) => Promise<{ stdout: string }>;
      const { row } = await toolArm(dir, {
        base: mergeBase,
        head: "HEAD",
        binding: (await honestBinding(dir, mergeBase, "HEAD")) as never,
        execFn: async (cmd, o) => {
          if (cmd === "git" || cmd.startsWith("git ")) gitCalls++;
          return real(cmd, o);
        },
      });
      assert(row.passed === true, `injected execFn: the bound row still passes (detail=${JSON.stringify(row.detail)})`);
      assert(gitCalls > 0, `injected execFn: the write's git reads went through it (${gitCalls} calls)`);
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }

  // ───────── the refusal RENDERER lives in test-adversarial-refusal-render.ts
  // (the 500-line cap, not a removed assertion): that file covers the detail
  // quoting, the no-detail row, the legacy non-string detail, the newline/tab
  // collapse, the clamp, and the no-row override mention.
  // ───────────── a rejected verdict keeps its own detail, not a binding one
  {
    const { dir, mergeBase } = setupRepo();
    try {
      const { row } = await toolArm(dir, {
        base: mergeBase,
        head: "HEAD",
        result: { ok: false, loopOutcome: "rejected" },
        binding: {},
      });
      assert(
        row.passed === false && row.detail === "rejected",
        `a rejected tool review keeps its verdict detail (got ${JSON.stringify(row.detail)})`,
      );
      assert(
        row.reviewedBase === undefined,
        "a rejected row is not decorated with binding fields it was never checked against",
      );
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  }
} finally {
  // nothing global to restore — each arm owns its repo and its ledger
}

console.log(`\nexit ${exit}`);
process.exit(exit);
