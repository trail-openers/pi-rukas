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
 * `git push` to the base branch, a GraphQL merge mutation) — those are
 * CONSCIOUSLY out of scope (branch protection covers pushes; parsing
 * GraphQL is a large surface with little to gain). See
 * docs/troubleshooting.md for the full statement.
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
import { type MergeAnalysis, analyseMergeCommand } from "./merge-analyse.ts";
import {
  lensNotEvaluatedRefusal,
  mergeIdentity,
  readPrCommentBodies,
} from "./merge-guard-reads.ts";
import { evaluateRoundCapMerge } from "./merge-guard-round-cap.ts";
import { exceedsAnalysisBound } from "./merge-size.ts";
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
    // #955 (fail closed): wrap all parse/match calls in try/catch. The
    // matcher and its helpers (`analyseMergeCommand`, merge-analyse.ts) can throw on
    // pathological input (a ~30k-level nested `$(…)` throws RangeError:
    // Maximum call stack size exceeded). An uncaught throw OUT of the
    // tool_call hook is a crash — the command passes the guard and runs.
    // Catching it and blocking is fail-closed: the guard cannot analyse
    // the command, so it refuses.
    // #955 lens round 6: a merge-bearing command over the size bound is
    // REFUSED explicitly ("too large to analyse") — it must not fall
    // through to current-branch PR resolution, which would verify the
    // ledger for a different PR than the one the (unanalysable) command
    // would merge. It is checked first, so no walk runs over such a command.
    if (exceedsAnalysisBound(command)) {
      return block(
        "merge refused: command is too large to analyse — the merge guard will not walk a command this large (it could hide a merge behind a long value); split or simplify the command, or set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override",
      );
    }
    let analysis: MergeAnalysis;
    try {
      analysis = analyseMergeCommand(command);
    } catch (err) {
      return block(
        `merge guard could not analyse this command (${analyseRefusal(err)}) — refusing; split or simplify the command`,
      );
    }
    if (analysis.kind === "none") return;
    // #955 lens fix 1 (HIGH): an invalid repo value (e.g. `o/r; touch
    // /tmp/x`) is a shell injection. The guard refuses and NEVER
    // interpolates it into any exec string — nor echoes it back (it can
    // carry shell metacharacters the agent typed).
    if (analysis.kind === "unsafe") {
      return block(
        "merge refused: unsafe repo value (contains characters outside owner/repo) — the guard will not interpolate this value into a forge command; set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override",
      );
    }
    // #962: the command's raw text and the words bash executes (after
    // quote removal) name different merge targets — the guard cannot tell
    // which PR it would be checking, so it checks none.
    if (analysis.kind === "ambiguous") {
      return block(
        "merge refused: ambiguous merge target — the command's quoting or escaping changes which PR/repo it names; write the PR number and repo plainly, or set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override",
      );
    }
    if (analysis.kind === "multiple") {
      return block(
        "merge refused: the command runs more than one merge — the guard verifies one PR per command; run each merge as its own command, or set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override",
      );
    }
    const merging = analysis.span;
    const repoValue = analysis.repo;
    let prNumber = analysis.prNumber;

    const cwd = process.cwd();
    // The injectable exec seam: `opts.execFn` (tests drive the real hook
    // through it); production uses execp.
    const execFn: MergeExecFn = opts.execFn ?? execp;

    // No number in the tail → fall back to current-branch resolution.
    if (prNumber === undefined) {
      prNumber = await resolvePrNumber(execFn, cwd, undefined, undefined, repoValue);
    }
    if (prNumber === undefined) {
      return block(
        `could not resolve the PR number for \`${merging}\` (parsed number: ${prNumber ?? "none"}; repo: ${repoValue ?? "none"}; matched span: \`${merging}\`; fallback cwd: ${cwd}) — the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)`,
      );
    }

    // Read the merge target (gh/glab). Fail-closed on unreadable. `repo`
    // is the VERB door's repo (the -R/--repo flag or PR-URL of the matched
    // merge verb): the REST doors name the repo in the endpoint path (and
    // glab's `mr view <n>` does not take a `-R` in the same shape), so the
    // REST path verifies in the CWD's repo — an agent merging via REST from
    // its CWD is merging its own PR.
    const targetResult = await readMergeTarget(execFn, cwd, prNumber, undefined, repoValue);
    if (!targetResult.ok) {
      return block(`merge refused: ${targetResult.reason}`);
    }
    const target = targetResult.target;

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
