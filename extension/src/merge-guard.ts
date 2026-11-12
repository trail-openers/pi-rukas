/**
 * merge-guard — the mode-independent `tool_call` hook that refuses agent-run
 * PR/MR merges until the review ledger shows the branch's changes passed
 * adversarial_loop AND dispatch_lens_review.
 *
 * #912. The incident (a sibling project, 2026-09-27): a PM managing work
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
 *      only). If set, every gate below is inert for the whole session EXCEPT the
 *      merge-author gate (10), which no override reaches.
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
 *   9. CI evidence (#2106), LAST, after the ledger rows and the round-cap
 *      path: `gatherMergeEvidence` (the driver's own executed-evidence gate)
 *      must report `ok` for the PR. A failing, pending, skipped or neutral
 *      check, a `mergeStateStatus` that is not `CLEAN`, zero rows, or an
 *      unreadable read all refuse. GitHub only — the glab path is unchanged.
 *  10. Merge author (#2181), beside the head equality: the PR's author must be
 *      listed in `.pi/merge-authors` **at the base commit**. An author the forge
 *      did not report, an allowlist that is unreadable or empty, and a login that
 *      is not on it all refuse (an ABSENT file is the repository not opting in —
 *      see merge-author-allowlist.ts). **No override reaches it, step 2 included**:
 *      with the hatch set this hook stays registered and runs this gate alone — the
 *      hatch waives the reviews and says nothing about who opened the PR. The driver's
 *      switches do not reach the guard at all. The read and the refusal are in
 *      merge-guard-author.ts (`guardMergeAuthorRefusal`), which is also where the
 *      base-commit rule for this path is written out.
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
 * (exactly the `registerIssueCreationGuard` placement), and ahead of everything else
 * this hook does when the escape hatch is set. In trust mode
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
import { type MergeCommand, readMergeCommand } from "./merge-allowlist.ts";
import { MERGE_AUTHORS_FILE } from "./merge-author-allowlist.ts";
import { guardMergeAuthorRefusal } from "./merge-guard-author.ts";
import { guardMergeLedger } from "./merge-guard-ledger.ts";
import { protectedMergeRefusal } from "./merge-guard-protected.ts";
import { guardFetchAndHead, guardMainline, guardMainlineOid } from "./merge-guard-reads-git.ts";
import { mergeIdentityAgainstMainline } from "./merge-identity.ts";
import { analyseRefusal, clipCheckNames } from "./merge-refusal-render.ts";
import { GLAB_AUTO_MERGE_REFUSAL, holdReasonText, renderHold } from "./merge-refusals.ts";
import {
  type MergeExecFn,
  type MergeTarget,
  isCarveOut,
  readMergeTarget,
  resolvePrNumber,
} from "./merge-target.ts";
import {
  type LedgerEntry,
  cloneLedgerPathFor,
  latestEntry,
  ledgerPathFor,
  readLedgerAt,
  remoteName,
} from "./review-ledger.ts";
import { trace, traceWarn } from "./trace.ts";
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
  // A4: the hatch waives the REVIEWS, not the author rule. With it set the hook still
  // registers and runs `authorGateOnly` alone, so every gate below stays exactly as
  // disabled as the hatch has always made them. Returning here used to switch the
  // author gate off with the rest, which is how an operator who set the hatch to get
  // one command through also landed strangers.
  const hatch = unreviewedMergeAllowed();
  if (hatch) {
    trace(
      "merge-guard: PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 — review gates waived; the merge-author gate still applies",
    );
  }
  pi.on("tool_call", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    // The one gate the hatch cannot waive, ahead of every read the hatch disables.
    if (hatch) return authorGateOnly(event, opts);
    const command = (event.input as { command?: string })?.command ?? "";
    // #1417 — one place that records a hold, so the log can show how often
    // the guard blocks work instead of protecting it. A HOLD is a refusal of
    // a command the guard could not read as a merge; the merge refusals below
    // are not recorded, because those are the guard doing its job.
    //
    // #1417 LOW — the line carries the REASON CODE and the command LENGTH
    // only, never the command text. It used to trace 240 chars of the
    // rendered refusal, and the rendered refusal quotes the held command:
    // command strings routinely carry tokens, and this stream is ungated
    // stderr, captured by the headless console writer and the run transcript
    // with no redaction in front of it. The comment no longer claims to
    // COUNT anything — counting was never wired (notice-counter.ts is the
    // live-view badge for async report deliveries, a different concern), so
    // what remains is the trace, which is where a false hold gets reported
    // from.
    const held = (rendered: { block: true; reason: string }, code: string, cmd: string) => {
      traceWarn(
        `merge-guard: HELD (not a merge) reason=${code || "form"} commandLength=${cmd.length}`,
      );
      return rendered;
    };
    // Fail closed: a throw out of the tool_call hook would let the command
    // run, so anything the reader throws refuses.
    let analysis: MergeCommand;
    try {
      analysis = readMergeCommand(command);
    } catch (err) {
      // #1417 — the reader threw. That says the CLASSIFIER failed, not that
      // the command merges, so the text names the classifier as the suspect
      // and does not offer the merge hatch: an operator setting it here has
      // switched the whole review gate off to get one command through.
      return held(
        renderHold(
          {
            kind: "unanalysable",
            reasonText: `the classifier threw (${analyseRefusal(err)}) — nothing in the command was read`,
          },
          command,
        ),
        "classifier-threw",
        command,
      );
    }
    if (analysis.kind === "none") return;
    // #962: a command that names a forge and a merge but is not the one plain
    // merge form the guard checks (see merge-allowlist.ts).
    //
    // #1417 — a `refused` here is a HOLD, not a merge verdict: the classifier
    // recognised merge-adjacent text it could not read, and nothing merged.
    // So this refusal names WHAT was held (`analysis.reason` — the bare
    // code — with `analysis.detail`, the trigger word or the offending word)
    // and never names the merge escape hatch. The twelve refusals of #1417
    // all told an agent reading an issue's label history to "issue the merge
    // as a plain `gh pr merge`, or set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1":
    // wrong twice, and the only remedy offered weakened merge protection to
    // unblock a read. The hatch belongs in the MERGE refusals (below, past
    // `readMergeTarget`), where a merge is genuinely at stake and an operator
    // who reviewed elsewhere can decide.
    if (analysis.kind === "refused") {
      // #1417 LOW — `reason` is a bare code, so this comparison is exact
      // rather than a prefix match against a code-plus-clause string.
      if (analysis.reason === "glab-auto-merge") {
        // A real merge in the accepted form, refused for deferring itself to
        // the pipeline: an operator decision, so it keeps the hatch.
        return block(GLAB_AUTO_MERGE_REFUSAL);
      }
      return held(
        renderHold(
          {
            kind: "form",
            reasonText: holdReasonText(analysis.reason, analysis.detail),
          },
          command,
        ),
        analysis.reason ?? "form",
        command,
      );
    }
    const merging = analysis.forge === "gitlab" ? "glab mr merge" : "gh pr merge";
    const repoValue = analysis.repo;
    let prNumber = analysis.prNumber;

    // #1417 — one refusal builder for every step that runs BEFORE a merge is
    // known to be the command at hand. Two readings of "could not decide", and
    // the second is what the cycles hit: a `gh api … --jq` read whose
    // classification fell through to the merge path. A step failure before
    // this point does not prove the command merges anything, so the text says
    // so, names the shape that would be a merge, and never offers the hatch.
    // Once the command has parsed as a merge (after `readMergeTarget` /
    // the forge check below), the refusals DO name the hatch — there the
    // command is a merge and the operator may genuinely override the reviews.
    //
    // #1417 round 2 — the trace CODE is a parameter, not a constant. It used
    // to hardcode `unresolved-pr-number`, the code of the one call site that
    // existed when the helper was written, so every later early failure —
    // `analysis.kind === "refused"` reaching here with `too-large`,
    // `body-indirect` or `brace-expansion` — was logged under a cause that did
    // not occur, which is precisely the log a false hold gets reported from.
    // The log still carries the reason code and the command LENGTH only (see
    // `held` above): branch, cwd and command text stay out of the hold
    // telemetry deliberately, because command strings routinely carry tokens
    // and this stream is ungated stderr.
    const earlyRefuse = (code: string, reason: string) =>
      held(
        renderHold({ kind: "not-a-merge", reasonText: reason }, `\`${merging}\` …`),
        code,
        command,
      );

    const cwd = process.cwd();
    // The injectable exec seam: `opts.execFn` (tests drive the real hook
    // through it); production uses execp.
    const execFn: MergeExecFn = opts.execFn ?? execp;

    // No number in the command → fall back to current-branch resolution.
    // #1417 — everything between here and `readMergeTarget` still only knows
    // the command LOOKED merge-adjacent to the classifier; it has not read a
    // merge. Those refusals go through `earlyRefuse` and do not name the
    // hatch. Below `readMergeTarget` the command has parsed as a merge in the
    // accepted form, so those refusals keep it: there an operator who has
    // reviewed by other means genuinely decides.
    if (prNumber === undefined) {
      prNumber = await resolvePrNumber(execFn, cwd, undefined, undefined, repoValue);
    }
    if (prNumber === undefined) {
      return earlyRefuse(
        "unresolved-pr-number",
        `its words read like the merge form \`${merging}\`, but the PR/MR number could not be resolved from the command or the current branch (repo: ${repoValue ?? "none"}; fallback cwd: ${cwd})`,
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
    // #1529 — the mainline, resolved ONCE here and handed to every git read
    // below (the fetch, the head OID, the protected-path read, the patch
    // identity). One resolution keeps them on the same commit; see
    // merge-guard-reads-git.ts for the invariant and the fail-closed refusal.
    const mainline = await guardMainline(cwd, execFn);
    if (!mainline.ok) return mainline.block;

    // Fetch the head, the base and the mainline, then pin the fetched head to
    // the PR's own headOid (#1305). Both reads and their refusals live in
    // merge-guard-reads-git.ts, which is also where the argv form and the
    // bounded, non-interactive network git call are kept (#1279, #1095).
    // `fetchedHead` is the OID the round-cap head check and the CI pin below
    // use — the one value every later read describes.
    const fetch = await guardFetchAndHead(
      execFn,
      cwd,
      remote,
      target,
      mainline.value,
      EXEC_TIMEOUT_MS,
    );
    if (!fetch.ok) return fetch.block;
    const fetchedHead = fetch.value;

    // The merge-author gate (#2181): one call, one refusal, beside the head
    // equality and ahead of the protected-path and ledger reads below. The rule,
    // the base-commit choice and why no override reaches it are in
    // merge-guard-author.ts.
    const authorBlock = await guardMergeAuthorRefusal(
      execFn,
      cwd,
      `${remote}/${mainline.value}`,
      target,
    );
    if (authorBlock) return authorBlock;

    // The protected-path gate, immediately after the head equality and beside
    // the patch identity below: a PR whose own commits touch `.github/`,
    // `.pi/`, `CODEOWNERS` or `agents.json` is not merged by an agent, whatever
    // the ledger says. Both OIDs are pinned here — the fetched head this handler
    // verified against the PR's `headOid`, and `<remote>/<mainline>` resolved
    // once — so the gate diffs the commit the merge would land rather than
    // re-resolving a ref that may have moved since the fetch.
    const baseOid = await guardMainlineOid(execFn, cwd, remote, mainline.value, EXEC_TIMEOUT_MS);
    if (!baseOid.ok) return baseOid.block;
    const protectedGate = await protectedMergeRefusal(execFn, cwd, fetchedHead, baseOid.value);
    if (protectedGate) return protectedGate;

    // The current identity, built as the ledger writers build theirs (#1305):
    // merge-base of the head against `<remote>/<mainline>`, diffed to the
    // head. A moved main leaves it unchanged; a change to the branch's own
    // content changes it. A PR whose base is not the mainline has nothing
    // recorded to match and fails closed (see mergeIdentity).
    const identity = await mergeIdentityAgainstMainline(
      execFn,
      cwd,
      target.headBranch,
      target.baseBranch,
      mainline.value,
      remote,
    );
    if (!identity.ok) {
      return block(
        `could not compute the patch-id for ${target.headBranch}: ${identity.reason} — the merge guard refuses by default (set PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE=1 to override)`,
      );
    }
    const currentPatchId = identity.patchId;

    // Read the ledger. #1360/#973/#2106/#2107 — the adversarial row, the lens row and
    // the round-cap path, and the single CI exit every allow path falls through to,
    // live in merge-guard-ledger.ts; the order rules and the redirected-write
    // diagnostic's contract are that module's header.
    const ledgerBlock = await guardMergeLedger({
      execFn,
      cwd,
      target,
      prNumber,
      repoValue,
      currentPatchId,
      fetchedHead,
      timeoutMs: EXEC_TIMEOUT_MS,
    });
    if (ledgerBlock) return ledgerBlock;
  });
}

function block(reason: string): { block: true; reason: string } {
  return { block: true, reason };
}

/**
 * The one gate the escape hatch cannot waive: resolve the PR, apply the author check,
 * answer nothing else.
 *
 * A separate handler rather than a flag threaded through the hook above, so "only the
 * author gate survives the hatch" is a shape a reader can see — the review, head,
 * protected-path, ledger and CI reads are simply not in this function, and adding a
 * gate to the hook above cannot silently widen what the hatch disables.
 *
 * It mirrors the hook's own reads exactly (same classifier, same PR resolution, same
 * forge check, same remote and mainline resolution) so the login compared here belongs
 * to the PR the merge would actually land, and it mirrors the hook's FAIL-CLOSED reads
 * too: a classifier that throws and a PR number that will not resolve both refuse, so
 * a merge is never landed on a command or a target this gate could not read. It stops
 * where the hook stops: a command the classifier will not read as a merge is not refused
 * here (that hold, and its telemetry, belong to the hook the hatch waives), but a PR
 * whose author could not be established IS refused — that is this gate failing closed,
 * not a review gate. The release-please / dependabot carve-out applies at the position
 * the hook applies it, so this path is never stricter than the hook on a bot PR.
 */
async function authorGateOnly(
  event: { toolName?: string; input?: unknown },
  opts: { execFn?: MergeExecFn },
): Promise<{ block: true; reason: string } | undefined> {
  const command = (event.input as { command?: string })?.command ?? "";
  let analysis: MergeCommand;
  try {
    analysis = readMergeCommand(command);
  } catch (err) {
    // Fail closed: a merge is the irreversible act, so a command this gate could not
    // read is not merged. The text names the classifier as the suspect (the hook's
    // own classifier-threw hold) — the reader threw, which says nothing about reviews.
    return block(
      `merge refused: the merge-author gate is not waived by PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE, and the command could not be read to identify the PR it merges — the classifier threw (${analyseRefusal(err)}). If this is not a merge, report it as a false hold: the guard's classifier is the thing to fix.`,
    );
  }
  if (analysis.kind !== "merge") return undefined;
  const cwd = process.cwd();
  const execFn: MergeExecFn = opts.execFn ?? execp;
  let prNumber = analysis.prNumber;
  if (prNumber === undefined) {
    prNumber = await resolvePrNumber(execFn, cwd, undefined, undefined, analysis.repo);
  }
  if (prNumber === undefined) {
    // Fail closed for the same reason: with no PR identified there is no author to
    // check, and an uncheckable author is not an approved one.
    return block(
      `merge refused: the merge-author gate is not waived by PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE, and the PR/MR to be merged could not be identified from the command or the current branch (repo: ${analysis.repo ?? "none"}), so its author could not be checked. Name the number in the merge command.`,
    );
  }
  const targetResult = await readMergeTarget(execFn, cwd, prNumber, undefined, analysis.repo);
  if (!targetResult.ok) {
    return block(
      `merge refused: the merge-author gate is not waived by PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE, and the pull request to be merged could not be read to check its author (${targetResult.reason})`,
    );
  }
  // Carve-out: release-please / dependabot are not agent merges, and the hook lets them
  // through at this same position — ahead of the remote/mainline reads the gate needs.
  if (isCarveOut(targetResult.target)) return undefined;
  // The gate must certify the PR the command actually merges, or the hatch becomes a
  // route for landing an unchecked author on the other forge.
  if (targetResult.target.forge !== analysis.forge) {
    return block(
      `merge refused: the merge-author gate is not waived by PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE, and \`${
        analysis.forge === "gitlab" ? "glab mr merge" : "gh pr merge"
      }\` merges on ${analysis.forge} while this repo's forge is ${targetResult.target.forge} — the author of the PR actually merged could not be checked`,
    );
  }
  const remote = await remoteName(execFn, cwd);
  if (!remote) {
    return block(
      `merge refused: the merge-author gate is not waived by PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE, and no git remote (origin/upstream/first) was found to read ${MERGE_AUTHORS_FILE} at`,
    );
  }
  const mainline = await guardMainline(cwd, execFn);
  if (!mainline.ok) return mainline.block;
  return guardMergeAuthorRefusal(execFn, cwd, `${remote}/${mainline.value}`, targetResult.target);
}
