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
 *      patchId (computed from `<remote>/<base>..<remote>/<head>`, the PR's
 *      ACTUAL base branch). A new commit since the review changes the
 *      patchId → refuse. Note the asymmetry with the writers: the ledger
 *      entries are stored against the MERGE-BASE of `<remote>/<mainline>`,
 *      so a PR whose base branch is not the mainline will fail this check
 *      (patchId mismatch) — that is deliberate and fails closed; the
 *      operator re-runs the reviews on the PR's actual base (see
 *      docs/troubleshooting.md → "A merge was refused: review ledger").
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

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripQuotedSegments } from "./bash-command-parser.ts";
import { exceedsAnalysisBound } from "./merge-size.ts";
import { mergesPr } from "./bash-merges-pr.ts";
import { extractMergeNumber, mergeVerbArgs, mergeVerbRepo } from "./merge-parse.ts";
import { type MergeExecFn, isCarveOut, readMergeTarget, resolvePrNumber } from "./merge-target.ts";
import { REPO_VALUE_PATTERN } from "./merge-tokens.ts";
import {
  type LedgerEntry,
  branchPatchId,
  latestEntry,
  ledgerPathFor,
  readLedgerAt,
  remoteName,
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
    // matcher and its helpers (mergesPr, mergeVerbArgs, mergeVerbRepo,
    // extractMergeNumber, extractPrNumber, restRepoFor) can throw on
    // pathological input (a ~30k-level nested `$(…)` throws RangeError:
    // Maximum call stack size exceeded). An uncaught throw OUT of the
    // tool_call hook is a crash — the command passes the guard and runs.
    // Catching it and blocking is fail-closed: the guard cannot analyse
    // the command, so it refuses.
    let merging: string | undefined;
    try {
      merging = mergesPr(command);
    } catch (err) {
      return block(`merge guard could not analyse this command (${analyseRefusal(err)}) — refusing; split or simplify the command`);
    }
    // #955 lens round 6: a merge-bearing command over the size bound is
    // REFUSED explicitly ("too large to analyse") — it must not fall
    // through to current-branch PR resolution, which would verify the
    // ledger for a different PR than the one the (unanalysable) command
    // would merge.
    if (exceedsAnalysisBound(command)) {
      return block(
        "merge refused: command is too large to analyse — the merge guard will not walk a command this large (it could hide a merge behind a long value); split or simplify the command, or set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override",
      );
    }
    if (!merging) return;

    const cwd = process.cwd();
    // The injectable exec seam: `opts.execFn` (tests drive the real hook
    // through it); production uses execp.
    const execFn: MergeExecFn = opts.execFn ?? execp;

    // Resolve the PR number (from the command or the current branch).
    // Resolve the PR number. The verb door (`gh pr merge …` / `glab mr
    // merge …`) carries the number in the arguments AFTER the matched verb
    // (#955: the legacy span-based extraction only saw the verb itself, so
    // every numbered merge fell back to current-branch resolution). The
    // REST doors (`gh api …/pulls/N/merge`) carry the number inside the
    // matched span — `extractPrNumber` (span-scoped) still applies there.
    // The `-R`/`--repo` flag (or a PR-URL) names the repo — threaded to the
    // gh/glab reads so the guard resolves the PR in the right repo.
    let fromVerb: string | undefined;
    let fromRepo: { kind: "repo"; repo: string } | { kind: "unsafe"; raw: string } | undefined;
    try {
      fromVerb = mergeVerbArgs(command);
      // The repo is extracted from the WHOLE command (not just the post-verb
      // tail) because the -R flag can appear BEFORE the verb (`gh -R o/r pr
      // merge 17`). `mergeVerbRepo` handles both positions plus PR-URLs.
      fromRepo = mergeVerbRepo(command);
    } catch (err) {
      return block(`merge guard could not analyse this command (${analyseRefusal(err)}) — refusing; split or simplify the command`);
    }
    // #955 lens fix 1 (HIGH): an invalid repo value (e.g. `o/r; touch
    // /tmp/x`) is a shell injection. The guard refuses and NEVER
    // interpolates it into any exec string.
    if (fromRepo?.kind === "unsafe") {
      // A fixed message — do NOT echo `fromRepo.raw` (it can carry shell
      // metacharacters the agent typed; echoing it back is itself a
      // reflection of untrusted input).
      return block(
        "merge refused: unsafe repo value (contains characters outside owner/repo) — the guard will not interpolate this value into a forge command; set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override",
      );
    }
    let prNumber: number | undefined;
    let repoValue: string | undefined;
    try {
      // The repo the guard verifies the PR in. The verb door's -R/--repo (or
      // PR-URL) value wins when `mergeVerbRepo` yields one. On the REST
      // doors, `mergeVerbRepo` cannot see the command (they use `api`, not
      // the merge verb), so the repo flag carried by the REST invocation
      // (`gh -R o/r api …/pulls/N/merge`) is threaded too — otherwise the
      // guard would verify the PR in the CWD's repo while the merge writes a
      // different one (#955 adversarial round 5, MINOR #1). A REST READ never
      // reaches here (mergesPr returns undefined first), and a verb-door -R
      // already wins above — the scan is anchored to the repo shape, so it
      // fires only on the REST door's own flag.
      repoValue = fromRepo?.kind === "repo" ? fromRepo.repo : restRepoFor(command);
      if (fromVerb !== undefined) {
        // The verb door matched — parse the number from the argument tail.
        prNumber = extractMergeNumber(fromVerb);
      } else {
        // No verb door — try the REST-door span extraction (the number is
        // inside the matched endpoint path for those shapes). The repo is the
        // REST door's own -R/--repo flag (see repoValue above), so the
        // fallback resolves the PR in the same repo the merge writes.
        const fromSpan = extractPrNumber(merging);
        if (fromSpan !== undefined) {
          prNumber = fromSpan;
        }
      }
    } catch (err) {
      return block(`merge guard could not analyse this command (${analyseRefusal(err)}) — refusing; split or simplify the command`);
    }
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

    // Fetch the branch. Fail-closed on error.
    try {
      await execFn(`git fetch ${remote} ${target.headBranch}`, {
        cwd,
        maxBuffer: 64 * 1024,
        timeout: EXEC_TIMEOUT_MS,
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

    // Compute the current patchId against the PR's ACTUAL base branch
    // (`<remote>/<baseBranch>`) — NOT the mainline. The writers store their
    // entries against the mainline's merge-base, so a PR based off a
    // non-mainline branch will not match and fails closed (see the module
    // header, step 7). The guard keeps using the PR's baseBranch because
    // that is the ref the merge will actually run against.
    const currentPatchId = await branchPatchId(
      execFn,
      cwd,
      `${remote}/${target.headBranch}`,
      `${remote}/${target.baseBranch}`,
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

/**
 * The repo flag carried by a REST-door invocation (`gh -R o/r api
 * repos/o/r/pulls/17/merge`), scanned over the quote-stripped command —
 * `mergeVerbRepo` cannot see REST-door commands (they use `api`, not the
 * merge verb), so without this a REST door's `-R` would verify the PR in
 * the CWD's repo while the merge writes a different one (#955 adversarial
 * round 5, MINOR #1). Only the REST doors reach here (the verb door's repo
 * already wins via `mergeVerbRepo`), and only the repo flag is read (the
 * number comes from the endpoint path); the value is anchored to the repo
 * shape (`REPO_VALUE_PATTERN`) so an injected value can never be threaded
 * into an exec string. A REST READ (`…/pulls/17` without the /merge
 * suffix) does not merge — `mergesPr` returns undefined before this is
 * called — so the -R here never fires on a non-merge.
 */
function restRepoFor(command: string): string | undefined {
  const c = stripQuotedSegments(command);
  // No `\b` before the flag: `-R` / `--repo` begin with a non-word
  // character, so a leading word-boundary assertion never matches (the
  // guard would silently read no repo and verify the PR in the CWD's repo).
  const m = new RegExp(
    `(?:^|[;&|\\s])(?:-R|--repo)\\s+(${REPO_VALUE_PATTERN.source.slice(1, -1)})`,
  ).exec(c);
  return m?.[1];
}

/**
 * Extract the PR number from the matched merge span.
 *
 * `gh pr merge 12` → 12. `gh pr merge` → undefined (resolve via gh pr view).
 * `glab mr merge 7` → 7. The number is read from the matched span ONLY —
 * scoping to the whole command would pick up unrelated numbers (a `cd
 * /data/3 && gh pr merge` extracts `3` from the path) and validate the
 * ledger for the wrong PR.
 * #955 — the verb door no longer reaches here: its number is read from the
 * post-verb arguments (merge-parse.ts `extractMergeNumber`); this span-scoped
 * read now covers only the REST doors, whose endpoint path carries the number
 * as a path segment (`gh api …/pulls/12/merge` → 12, `glab api …/mr/7/merge`
 * → 7).
 */
function extractPrNumber(matched: string): number | undefined {
  const m = /\b(\d+)\b/.exec(matched);
  return m?.[1] ? Number.parseInt(m[1], 10) : undefined;
}
