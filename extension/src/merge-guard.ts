/**
 * merge-guard — the mode-independent `tool_call` hook that refuses agent-run
 * PR/MR merges until the review ledger shows the branch's changes passed
 * adversarial_loop AND dispatch_lens_review.
 *
 * #912. The incident (sibling project meadow, 2026-09-27): a PM managing work
 * OUTSIDE the /work driver merged two PRs on a developer's self-report plus
 * green CI, skipping both reviews. Prompt doctrine demanded both; the prompt
 * layer is what failed. This hook is the structural floor.
 *
 * ## What it checks (in order, all fail-closed)
 *
 *   1. Is this command a merge? (`readMergeCommand`, merge-allowlist.ts).
 *      A command naming no forge and no merge word is inert; one that names
 *      both must be the single plain `gh pr merge` / `glab mr merge` form, or
 *      it is refused.
 *   2. Escape hatch: `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1` (operator-set
 *      only). If set, the hook is inert for the whole session.
 *   3. Resolve the merge target: `gh pr view N --json …` (or `glab mr view
 *      N --output json`). A missing/unreadable `gh` AND `glab` both refuse.
 *   4. Carve-out: release-please / dependabot identities pass through.
 *   5. Fetch the branch: `git fetch <remote> <headRef>` where `<remote>` is
 *      resolved like forge detection (`origin` → `upstream` → first remote;
 *      no remote → refuse) — fail-closed on error.
 *   6. Head OID check: the fetched head must equal the PR's `headOid`.
 *      A mismatch means the branch moved after the PR was opened; refuse.
 *      This is a FRESHNESS gate: it confirms the branch is where the PR
 *      says it is at this instant. It is NOT atomic with the merge — a
 *      concurrent push between the check and the merge is not detectable
 *      here, and branch protection is the git-level control for that.
 *   7. Adversarial ledger: the LATEST adversarial entry for this branch
 *      must be `passed: true` AND its `patchId` must equal the current
 *      patchId — computed as the writers compute theirs (#1305): the diff from
 *      the merge-base of `<remote>/<head>` and `<remote>/<mainline>` to the
 *      head (`mergeIdentity`). Main moving does not change it; a change
 *      to the branch's own content does → refuse. A PR whose base branch is
 *      not the mainline has no matching recorded identity and is refused,
 *      named (fail closed; see docs/troubleshooting.md → "A merge was
 *      refused: review ledger").
 *   8. Lens ledger: the LATEST lens entry for this branch must be
 *      `passed: true` (any patchId — a passing lens entry may predate a
 *      later commit; a later FAILING lens entry is what the latest-ness
 *      protects against). The lens `passed` boolean follows the project's
 *      review threshold (the same bar the driver's verdict used — see
 *      `lensBlockedByThreshold` / `lensPassed` in review-ledger.ts).
 *
 * ## What this guard is — and is not
 *
 * This is a SAFEGUARD against an agent that FORGETS the gates — a PM who
 * merges on a developer's self-report plus CI without running the reviews.
 * It is NOT a security boundary: anything with shell access to this clone
 * can write or delete the ledger file (it is a plain JSON file under the
 * git common dir), and the head check is not atomic with the merge. The
 * threat model is the honest-but-forgetful agent, not an adversary: an
 * agent with credentials can always merge by other means (a direct
 * `git push` to the base branch, a merge spelled entirely from shell
 * expansions) — those are CONSCIOUSLY out of scope (branch protection
 * covers pushes). REST and GraphQL merges that spell the word are refused
 * outright rather than checked. See docs/troubleshooting.md for the full
 * statement.
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execp } from "./exec.ts";
import { FORGE_EXEC_TIMEOUT_MS } from "./forge-detect.ts";
import {
  GLAB_AUTO_MERGE_REFUSAL,
  type MergeCommand,
  mergeFormRefusal,
  readMergeCommand,
} from "./merge-allowlist.ts";
import {
  adversarialRefusal,
  lensNotEvaluatedRefusal,
  mergeIdentity,
  readPrCommentBodies,
} from "./merge-guard-reads.ts";
import { evaluateRoundCapMerge } from "./merge-guard-round-cap.ts";
import {
  type MergeExecFn,
  type MergeTarget,
  isCarveOut,
  readMergeTarget,
  resolvePrNumber,
} from "./merge-target.ts";
import {
  type LedgerEntry,
  latestEntry,
  ledgerPathFor,
  readLedgerAt,
  remoteName,
} from "./review-ledger.ts";
import { trace } from "./trace.ts";
import { netRefProblem, runNetGit } from "./work-driver-net-git.ts";

/** Per-exec timeout for the guard's gh/git calls. */
const EXEC_TIMEOUT_MS = FORGE_EXEC_TIMEOUT_MS;

/** Opt-out for an operator who has reviewed by other means. */
function unreviewedMergeAllowed(): boolean {
  return process.env.PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE === "1";
}

/**
 * Register the mode-independent merge guard.
 *
 * Call BEFORE the sandbox short-circuit, the subagent-mode branch, and the
 * trust-mode bypass in `registerPermissionGuard` / `registerSubagentGuard`.
 *
 * `opts.execFn` replaces the shell executor for the guard's gh/git calls
 * (tests drive the REAL hook through this option with a stub; production
 * uses `execp`).
 */
export function registerMergeGuard(pi: ExtensionAPI, opts: { execFn?: MergeExecFn } = {}): void {
  if (unreviewedMergeAllowed()) {
    trace("merge-guard: PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 — unreviewed merges permitted");
    return;
  }
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: string })?.command ?? "";
    // Fail closed: a throw out of the tool_call hook would let the command
    // run, so anything the reader throws refuses.
    let analysis: MergeCommand;
    try {
      analysis = readMergeCommand(command);
    } catch (err) {
      return block(
        `merge guard could not analyse this command (${analyseRefusal(err)}) — refusing; split or simplify the command`,
      );
    }
    if (analysis.kind === "none") return;
    // #962: a command that names a forge and a merge but is not the one plain
    // merge form the guard checks (see merge-allowlist.ts).
    if (analysis.kind === "refused") {
      return block(
        analysis.reason === "glab-auto-merge"
          ? GLAB_AUTO_MERGE_REFUSAL
          : mergeFormRefusal(analysis.reason),
      );
    }
    const merging = analysis.forge === "gitlab" ? "glab mr merge" : "gh pr merge";
    const repoValue = analysis.repo;
    let prNumber = analysis.prNumber;

    const cwd = process.cwd();
    // The injectable exec seam: `opts.execFn` (tests drive the real hook
    // through it); production uses execp.
    const execFn: MergeExecFn = opts.execFn ?? execp;

    // No number in the command → fall back to current-branch resolution.
    if (prNumber === undefined) {
      prNumber = await resolvePrNumber(execFn, cwd, undefined, undefined, repoValue);
    }
    if (prNumber === undefined) {
      return block(
        `could not resolve the PR number for \`${merging}\` (repo: ${repoValue ?? "none"}; fallback cwd: ${cwd}) — the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)`,
      );
    }

    // Read the merge target (gh/glab) in the command's -R/--repo repo, or
    // the CWD's. Fail-closed on unreadable.
    const targetResult = await readMergeTarget(execFn, cwd, prNumber, undefined, repoValue);
    if (!targetResult.ok) {
      return block(`merge refused: ${targetResult.reason}`);
    }
    const target = targetResult.target;
    // The PR read follows this repo's forge; a merge aimed at the other forge
    // would act on a different PR/MR than the one just read.
    if (target.forge !== analysis.forge) {
      return block(
        `merge refused: \`${merging}\` merges on ${analysis.forge} but this repo's forge is ${target.forge} — the guard would check a different PR/MR than the one merged; set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override`,
      );
    }

    // Carve-out: release-please / dependabot are not agent merges.
    if (isCarveOut(target)) {
      trace(`merge-guard: carve-out — ${target.headBranch} (PR #${prNumber})`);
      return;
    }

    // Resolve the git remote the same way forge detection does
    // (origin → upstream → first remote). Never hardcoded `origin`:
    // a repo whose remote has another name must still resolve the same
    // ref both here and in the writers' patchId. Fail-closed on none.
    const remote = await remoteName(execFn, cwd);
    if (!remote) {
      return block(
        "no git remote found (origin/upstream/first) — the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)",
      );
    }

    // Fetch the head AND the base. Fail-closed on error. The remote and
    // branches come from the PR and the git config: validated and passed as
    // argv, never shell text. The base is fetched so the merge-base below is
    // taken against the same fresh refs the marker poster uses (#1305).
    const refProblem = netRefProblem(remote, target.headBranch, target.baseBranch);
    if (refProblem !== undefined) {
      return block(
        `git fetch refused: ${refProblem} — the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)`,
      );
    }
    try {
      await runNetGit(execFn, "git", {
        cwd,
        maxBuffer: 64 * 1024,
        timeoutMs: EXEC_TIMEOUT_MS,
        argv: ["fetch", remote, target.headBranch, target.baseBranch],
      });
    } catch (err) {
      return block(
        `git fetch failed: ${analyseRefusal(err, 120)} — the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)`,
      );
    }

    // Check the fetched head OID against the PR's headOid.
    let fetchedHead: string;
    try {
      const { stdout } = await execFn(`git rev-parse ${remote}/${target.headBranch}`, {
        cwd,
        maxBuffer: 8 * 1024,
        timeout: EXEC_TIMEOUT_MS,
      });
      fetchedHead = stdout.trim();
    } catch (err) {
      return block(
        `could not read ${remote}/${target.headBranch}: ${analyseRefusal(err, 120)} — the merge guard refuses by default`,
      );
    }
    if (fetchedHead !== target.headOid) {
      return block(
        `stale branch: fetched head ${fetchedHead.slice(0, 8)} ≠ PR headOid ${target.headOid.slice(0, 8)} — the branch moved after the PR was opened; re-run the reviews`,
      );
    }

    // The current identity, built as the ledger writers build theirs (#1305):
    // merge-base of the head against `<remote>/<mainline>`, diffed to the
    // head. A moved main leaves it unchanged; a change to the branch's own
    // content changes it. A PR whose base is not the mainline has nothing
    // recorded to match and fails closed (see mergeIdentity).
    const identity = await mergeIdentity(execFn, cwd, target.headBranch, target.baseBranch);
    if (!identity.ok) {
      return block(
        `could not compute the patch-id for ${target.headBranch}: ${identity.reason} — the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)`,
      );
    }
    const currentPatchId = identity.patchId;

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
    // #1360 — a non-passing row's `detail` is quoted in the refusal, so an
    // operator told "no passing review" can see the review DID run and why its
    // row does not count (a narrowed range, a moved head, an edited tree).
    const adv = latestEntry(entries, branch, "adversarial");
    if (!adv || !adv.passed) {
      return block(adversarialRefusal(branch, adv));
    }
    if (adv.patchId !== currentPatchId) {
      return block(
        `adversarial review is stale: ledger patchId ${adv.patchId.slice(0, 8)} ≠ current ${currentPatchId.slice(0, 8)} — the branch changed after the review; re-run adversarial_loop`,
      );
    }

    // Lens: the strict rule first — the LATEST entry must be `passed`
    // (any patchId). When it refuses, the #973 round-cap path is consulted:
    // an ISSUES_FOUND entry with no CRITICAL, >= 3 rounds, an approving
    // adversarial review (already checked above), and the residual findings
    // disclosed on the PR (marker + matching patch) allows the merge — the
    // same rule AGENTS.md §1 and work-driver-lens-cap.ts apply to the
    // driver's own cycles. A refusal from either path names the failed
    // condition (see evaluateRoundCapMerge for the full matrix).
    const lens = latestEntry(entries, branch, "lens");
    if (!lens || !lens.passed) {
      const lensComments = await readPrCommentBodies(execFn, cwd, target, prNumber, repoValue);
      // #973 review — the round-cap path's headSha check (condition 6) uses
      // the PR's current head: the fetched OID, which the guard has already
      // verified equals the PR's `headOid` (a mismatch is the earlier
      // "stale branch" refusal above). A lens review of an older commit
      // cannot satisfy the cap.
      const capDecision = evaluateRoundCapMerge(
        entries,
        branch,
        currentPatchId,
        lensComments,
        fetchedHead,
      );
      if (capDecision.applies && capDecision.allowed) {
        trace(
          `merge-guard: PR #${prNumber} ${branch} — round-cap path allows the merge (ISSUES_FOUND, no CRITICAL, round ${lens?.round}, disclosed on the PR)`,
        );
        return;
      }
      if (capDecision.applies) {
        return block(
          `merge refused: ${capDecision.failedCondition ?? "the round-cap conditions are not met"} — the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)`,
        );
      }
      // The round-cap path does not apply (no entry, or a passing entry the
      // strict rule should have allowed — unreachable here, or a legacy
      // entry without a verdict detail): the strict rule's original refusal
      // text, with the branch named for the operator.
      return lensNotEvaluatedRefusal(branch, lens); // #1000 — "the round-cap path was not evaluated" (see lensNotEvaluatedRefusal)
    }

    trace(`merge-guard: PR #${prNumber} ${branch} — adversarial + lens both pass, merge allowed`);
  });
}

function block(reason: string) {
  return { block: true, reason };
}

/**
 * One message builder for every throw the guard catches (#955 lens round 6).
 * The catches must not themselves throw: a thrown `null`/`undefined` value
 * makes `(err as Error).constructor.name` throw OUT of the catch, which
 * fails the guard OPEN (the command passes). `typeof` narrowing handles
 * every throwable value — no casts — and `String(err)` renders null and
 * undefined as the strings `null`/`undefined`.
 */
export function analyseRefusal(err: unknown, limit = 100): string {
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, limit)}`;
  return String(err).slice(0, limit);
}
