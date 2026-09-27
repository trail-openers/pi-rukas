/**
 * merge-guard — the mode-independent `tool_call` hook that refuses agent-run
 * PR/MR merges until the review ledger shows the branch's changes passed
 * adversarial_loop AND dispatch_lens_review.
 *
 * #912. The incident (sibling project lievo, 2026-09-27): a PM managing work
 * OUTSIDE the /work driver merged two PRs on a developer's self-report plus
 * green CI, skipping both reviews. Prompt doctrine demanded both; the prompt
 * layer is what failed. This hook is the structural floor.
 *
 * ## What it checks (in order, all fail-closed)
 *
 *   1. Is this command a merge? (`mergesPr` — the matcher in
 *      bash-command-parser.ts). If not, the hook is inert.
 *   2. Escape hatch: `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1` (operator-set
 *      only). If set, the hook is inert for the whole session.
 *   3. Resolve the merge target: `gh pr view N --json …` (or `glab mr view
 *      N --output json`). A missing/unreadable `gh` AND `glab` both refuse.
 *   4. Carve-out: release-please / dependabot identities pass through.
 *   5. Fetch the branch: `git fetch origin <headRef>` — fail-closed on
 *      error.
 *   6. Head OID check: the fetched head must equal the PR's `headOid`.
 *      A mismatch means the branch moved after the PR was opened; refuse.
 *   7. Adversarial ledger: the LATEST adversarial entry for this branch
 *      must be `passed: true` AND its `patchId` must equal the current
 *      patchId (computed from `origin/<base>..origin/<head>`). A new commit
 *      since the review changes the patchId → refuse.
 *   8. Lens ledger: the LATEST lens entry for this branch must be
 *      `passed: true` (any patchId — a passing lens entry may predate a
 *      later commit; a later FAILING lens entry is what the latest-ness
 *      protects against).
 *
 * ## Mode-independence
 *
 * Registered BEFORE the sandbox short-circuit, the subagent-mode branch, and
 * the trust-mode bypass in `registerPermissionGuard` / `registerSubagentGuard`
 * (exactly the `registerIssueCreationGuard` placement). In trust mode
 * (the interactive default), sandbox mode (the container default), and
 * strict/headless mode, code after those bypasses never runs — so the guard
 * must fire before them.
 *
 * ## Exemptions
 *
 * - The driver's mechanized merge (work-driver-merged-mechanized.ts) is an
 *   in-process `execp` call, not a `tool_call` — it does not pass through
 *   this hook (exempt by construction, exactly like the plan driver's
 *   `gh issue create`).
 * - A human typing `gh pr merge` in their own terminal does not pass
 *   through this hook (it's a `tool_call` hook, not a shell interceptor).
 *
 * ## Async hook
 *
 * The `tool_call` handler is `async` and AWAITS every exec (PR read, git
 * fetch, patch-id) before deciding, with a 30s timeout per exec. A timeout
 * or error refuses (fail-closed).
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mergesPr } from "./bash-merges-pr.ts";
import { type MergeExecFn, isCarveOut, readMergeTarget, resolvePrNumber } from "./merge-target.ts";
import {
  type LedgerEntry,
  branchPatchId,
  latestEntry,
  ledgerPathFor,
  readLedgerAt,
} from "./review-ledger.ts";
import { trace } from "./trace.ts";

const execp = promisify(exec);

/** Per-exec timeout for the guard's gh/git calls. */
const EXEC_TIMEOUT_MS = 30_000;

/** Opt-out for an operator who has reviewed by other means. */
function unreviewedMergeAllowed(): boolean {
  return process.env.PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE === "1";
}

/**
 * Register the mode-independent merge guard.
 *
 * Call BEFORE the sandbox short-circuit, the subagent-mode branch, and the
 * trust-mode bypass in `registerPermissionGuard` / `registerSubagentGuard`.
 */
export function registerMergeGuard(pi: ExtensionAPI): void {
  if (unreviewedMergeAllowed()) {
    trace("merge-guard: PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 — unreviewed merges permitted");
    return;
  }
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: string })?.command ?? "";
    const merging = mergesPr(command);
    if (!merging) return;

    const cwd = process.cwd();
    // The injectable exec seam: tests stub this via the global;
    // production uses execp. The cast is safe: the test sets a
    // MergeExecFn-shaped function, and execp matches the signature.
    const globalExec = (globalThis as Record<string, unknown>).__mergeGuardExecFn as
      | MergeExecFn
      | undefined;
    const execFn: MergeExecFn = globalExec ?? execp;

    // Resolve the PR number (from the command or the current branch).
    const prNumber = await resolvePrNumberForCommand(execFn, cwd, merging);
    if (prNumber === undefined) {
      return block(
        `could not resolve the PR number for \`${merging}\` — the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)`,
      );
    }

    // Read the merge target (gh/glab). Fail-closed on unreadable.
    const targetResult = await readMergeTarget(execFn, cwd, prNumber);
    if (!targetResult.ok) {
      return block(`merge refused: ${targetResult.reason}`);
    }
    const target = targetResult.target;

    // Carve-out: release-please / dependabot are not agent merges.
    if (isCarveOut(target)) {
      trace(`merge-guard: carve-out — ${target.headBranch} (PR #${prNumber})`);
      return;
    }

    // Fetch the branch. Fail-closed on error.
    try {
      await execFn(`git fetch origin ${target.headBranch}`, {
        cwd,
        maxBuffer: 64 * 1024,
        timeout: EXEC_TIMEOUT_MS,
      });
    } catch (err) {
      return block(
        `git fetch failed: ${(err as Error).message?.slice(0, 120)} — the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)`,
      );
    }

    // Check the fetched head OID against the PR's headOid.
    let fetchedHead: string;
    try {
      const { stdout } = await execFn(`git rev-parse origin/${target.headBranch}`, {
        cwd,
        maxBuffer: 8 * 1024,
        timeout: EXEC_TIMEOUT_MS,
      });
      fetchedHead = stdout.trim();
    } catch (err) {
      return block(
        `could not read origin/${target.headBranch}: ${(err as Error).message?.slice(0, 120)} — the merge guard refuses by default`,
      );
    }
    if (fetchedHead !== target.headOid) {
      return block(
        `stale branch: fetched head ${fetchedHead.slice(0, 8)} ≠ PR headOid ${target.headOid.slice(0, 8)} — the branch moved after the PR was opened; re-run the reviews`,
      );
    }

    // Compute the current patchId.
    const currentPatchId = await branchPatchId(
      execFn,
      cwd,
      `origin/${target.headBranch}`,
      `origin/${target.baseBranch}`,
    );
    if (!currentPatchId) {
      return block(
        `could not compute the patch-id for ${target.headBranch} — the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)`,
      );
    }

    // Read the ledger.
    const ledgerPath = await ledgerPathFor(execFn, cwd);
    if (!ledgerPath) {
      return block(
        "no git common dir found — the review ledger is unavailable; the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)",
      );
    }
    const entries: LedgerEntry[] = readLedgerAt(ledgerPath);
    const branch = target.headBranch;

    // Adversarial: latest entry must be passed AND match the current patchId.
    const adv = latestEntry(entries, branch, "adversarial");
    if (!adv || !adv.passed) {
      return block(
        `no passing adversarial review on file for branch \`${branch}\` (latest: ${adv ? `passed=${adv.passed}, patchId=${adv.patchId.slice(0, 8)}` : "none"}) — run adversarial_loop and let it complete before merging`,
      );
    }
    if (adv.patchId !== currentPatchId) {
      return block(
        `adversarial review is stale: ledger patchId ${adv.patchId.slice(0, 8)} ≠ current ${currentPatchId.slice(0, 8)} — the branch changed after the review; re-run adversarial_loop`,
      );
    }

    // Lens: latest entry must be passed (any patchId).
    const lens = latestEntry(entries, branch, "lens");
    if (!lens || !lens.passed) {
      return block(
        `no passing lens review on file for branch \`${branch}\` (latest: ${lens ? `passed=${lens.passed}` : "none"}) — run dispatch_lens_review and let it complete before merging`,
      );
    }

    trace(`merge-guard: PR #${prNumber} ${branch} — adversarial + lens both pass, merge allowed`);
  });
}

function block(reason: string) {
  return { block: true, reason };
}

/**
 * Extract the PR number from the matched merge command.
 *
 * `gh pr merge 12` → 12. `gh pr merge` → undefined (resolve via gh pr view).
 * `glab mr merge 7` → 7.
 */
function extractPrNumber(command: string): number | undefined {
  // The matched span from mergesPr is the verb + optional number.
  const m = /\b(\d+)\b/.exec(command);
  return m?.[1] ? Number.parseInt(m[1], 10) : undefined;
}

async function resolvePrNumberForCommand(
  execFn: MergeExecFn,
  cwd: string,
  matchedCommand: string,
): Promise<number | undefined> {
  const fromCommand = extractPrNumber(matchedCommand);
  if (fromCommand !== undefined) return fromCommand;
  return resolvePrNumber(execFn, cwd, undefined);
}
