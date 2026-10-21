/**
 * adversarial-ledger — the adversarial loop's review-ledger write, split
 * from adversarial.ts (AGENTS.md §12 file-size limit).
 *
 * #912. A completed adversarial review records a `{ branch, patchId, passed }`
 * entry so the merge guard (merge-guard.ts) can refuse an agent-run merge
 * with no passing review on file. Failure isolation: every fault here is
 * swallowed and traced — the loop's DispatchResult comes back byte-identical
 * whether the write ran or threw.
 *
 * The patchId comes from `workingTreePatchId` (review-ledger.ts) — the ONE
 * shared base/patchId computation both writers use. It diffs the working tree
 * against the merge-base of HEAD and `<remote>/<mainline>` (resolved via
 * `detectMainline` — mainline.ts since #1387 — plus the forge remote, never a
 * hardcoded `origin/main`), so
 * the entry covers the uncommitted fixes the loop made; when those fixes are
 * committed unchanged, the id the guard recomputes at merge time matches.
 *
 * #1360 — on the TOOL path (`toolPath: true`, set by `adversarial-tool.ts` and
 * nothing else) that working-tree identity alone is not enough evidence that
 * the review covered the branch: a narrowed `base` produced a full-branch row.
 * A tool-path row now passes the range/head/tree bindings in
 * `adversarial-ledger-binding.ts` or it is written NON-PASSING with a named
 * detail. The `/work` driver path never sets `toolPath` and is unchanged.
 */

import {
  type LedgerBinding,
  decideToolPathRow,
  namedHeadIsTip,
  toolPathFields,
} from "./adversarial-ledger-binding.ts";
import { execp } from "./exec.ts";
import { resolveReviewBranch } from "./review-branch.ts";
import { resolveHeadSha } from "./review-head-sha.ts";
import { identityBase } from "./review-ledger-path.ts";
import {
  type LedgerEntry,
  adversarialPassed,
  appendLedgerEntry,
  workingTreePatchId,
} from "./review-ledger.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

/**
 * Write an adversarial-review entry to the review ledger. Fire-and-forget:
 * the caller does not await this; the function is safe to call on every
 * exit path of `runAdversarialLoop`.
 *
 * #1161 — the returned promise never rejects (the caller may ignore it).
 *
 * #1161 — `callerSuppliedDiff`: the review judged a diff string the caller
 * pasted, not one the tool computed from base+head. Such a review is recorded
 * as `passed: false` with detail "<outcome> (caller-supplied diff)", so the
 * merge guard refuses it; the same review via base+head is recorded normally.
 *
 * #1360 — `toolPath` + `binding` + `base`: the tool path's provenance marker
 * and the range/content the approving round actually judged. `toolPath` is set
 * ONLY by `adversarial-tool.ts` after the raw params spread, so a caller cannot
 * set it; the driver's rows carry none and keep their pre-#1360 semantics.
 *
 * #1449 — the return widens from `Promise<void>` to an outcome, because the
 * adversarial half of the ledger had no way to say anything about where its row
 * landed: every skip was trace-only, so a misdirected adversarial row was
 * invisible even after the lens side reported its own. The shape mirrors
 * `LensLedgerOutcome` (see lens-ledger.ts for why a redirect is `recorded: true`
 * with a `landedAtPath`, never `recorded: false`). The promise still never
 * rejects and the loop still never awaits it — the caller that wants the report
 * threads a `note` callback (adversarial-ledger-capture.ts `makeLedgerWrite`).
 */
export type AdversarialLedgerOutcome =
  | { recorded: true; landedAtPath?: string }
  | { recorded: false; reason: string };

export function writeAdversarialLedgerEntry(
  result: DispatchResult,
  params: {
    workCwd?: string;
    branch?: string;
    head?: string;
    resolvedBranch?: string;
    callerSuppliedDiff?: boolean;
    /** #1360 — the reviewed base ref, and whether this row came from the
     * `adversarial_loop` tool rather than the /work driver. */
    base?: string;
    toolPath?: boolean;
    /** #1360 — what the approving round captured (range SHAs + the working-tree
     * identity at the time its diff was read). Absent = nothing was captured,
     * which a tool-path row reads as unverifiable, never as a pass. */
    binding?: LedgerBinding;
    /** #1360 — the git executor shared by the capture and this write. The loop
     * threads the SAME function into `captureRound`, so a test (or a caller
     * with its own exec policy) sees one seam for the whole binding, matching
     * `commentExecFn` on the comment check. Defaults to the real executor. */
    execFn?: VerifyExecFn;
    /** #1557 — test-facing row identity: the loop's `orchestratorJobId`
     * stamped onto the row so the smoke arms select their OWN row by nonce
     * match (see `LedgerEntry.rowNonce`). Never a guard key; never read by
     * the merge guard. Omitted (not stored) when the caller supplies none. */
    rowNonce?: string;
  },
): Promise<AdversarialLedgerOutcome> {
  const write = async (): Promise<AdversarialLedgerOutcome> => {
    const c = params.workCwd ?? process.cwd();
    const execFn = params.execFn ?? execp;
    // #980 — the branch comes from the SHARED resolver (review-branch.ts:
    // explicit `branch` → branch-named `head` → rev-parse) — the same one
    // the lens review and the residual poster use — so all three key on the
    // same branch string by construction. `head` is threaded in (the tool
    // path's diff ref may name the branch even when `branch` is absent) so
    // the write resolves identically to the note built in `buildLedgerNote`.
    // #988 — the loop threads in the branch its note resolved (buildLedgerNote
    // resolves ONCE, up front, with the same args + cwd); self-resolution is
    // the fallback for direct callers that did not resolve.
    const branch =
      params.resolvedBranch ??
      (await resolveReviewBranch({ branch: params.branch, head: params.head, cwd: c }, execFn))
        .branch;
    if (!branch) {
      trace("adversarial: ledger write skipped — no branch (detached head, no caller branch)");
      return { recorded: false, reason: "no branch to key the ledger entry on" };
    }
    // The shared working-tree patch id (review-ledger.ts). When untracked
    // files exist the entry is still written for the tracked content, but the
    // gap is traced — see the warning's wording in workingTreePatchId.
    const computed = await workingTreePatchId(execFn, c);
    if (computed.warning) trace(`adversarial: ${computed.warning}`);
    if (!computed.patchId) {
      return {
        recorded: false,
        reason: computed.warning ?? "no patch id for the working tree",
      };
    }
    // #1039 — resolve the head to a full 40-char SHA via the shared
    // resolver (review-head-sha.ts — the same one the lens writer and the
    // diff resolvers use). The adversarial writer takes `head` for branch
    // resolution; now it also uses it (or HEAD) for the headSha field. An
    // unresolvable head leaves headSha undefined (omitted from the entry) —
    // the write succeeds without the field, matching the lens writer's
    // behaviour.
    const headRef = params.head ?? "HEAD";
    const headSha = await resolveHeadSha(c, headRef, execFn);
    // #1360 — what the BINDING compares the round's capture against is always
    // workCwd's own TIP, never whatever ref the caller named, and what the
    // refusal is called depends on whether those two agree. `workingTreePatchId`
    // took this row's identity from the worktree's HEAD and `captureBinding` took
    // the round's from the same place, so they are comparable only against the
    // tip. A caller who named the mainline (`head: "main"`, `origin/main`, or a
    // `trunk` repo's `trunk`) would otherwise have its HEAD compared against the
    // MAINLINE commit and refused `head-moved` for a review of the very checkout
    // it was in. So: resolve the caller's ref too, and let agreement decide the
    // vocabulary — the ref resolving TO the tip means the caller meant the tip
    // and HEAD has since moved (`head-moved`); a ref resolving elsewhere is the
    // review of some older commit (`head-not-current`), which is a refusal the
    // caller's own argument caused and must not be softened.
    const tipSha = await resolveHeadSha(c, "HEAD", execFn);
    const namedRefResolvesToTip = headSha === undefined || headSha === tipSha;
    const callerSupplied = params.callerSuppliedDiff === true;
    const outcome = result.loopOutcome ?? "completed";
    const verdictPassed = adversarialPassed(result);
    const toolPath = params.toolPath === true;
    // #1360 — the binding fields the row stores come from the VERIFIED
    // decision, never from the raw capture: a capture is what a round recorded,
    // a decision is what the module confirmed. Writing a capture whose range
    // check was never run (or that failed) would decorate a row with SHAs the
    // gate did not vouch for — so a refused row carries none.
    //
    // The tool-path bindings themselves are gated on `toolPath` alone, NOT on
    // `adversarialPassed`: a rejection under `reportVerdict: "terminal"` maps
    // to ok:true/loopOutcome "approved" downstream but records `passed: false`,
    // and it still earns an honest range check — it just keeps its own verdict
    // detail rather than a binding one.
    //
    // The identity base is resolved ONCE here and threaded into the decision:
    // `computed.patchId` above was taken against exactly this `{remote,
    // mainline}`, and the range check must compare against the same ref — two
    // resolutions could disagree on a `trunk`/`develop` repo, and the row's
    // pass would then rest on a range nobody computed. Same executor as the
    // capture, same shared helpers, one seam.
    const mainline = await identityBase(execFn, c);
    const binding =
      toolPath && !callerSupplied
        ? await decideToolPathRow({
            workCwd: c,
            baseRef: params.base,
            headRef,
            binding: params.binding ?? {
              bindingUnavailable: "no round capture reached the writer",
            },
            currentTreePatchId: computed.patchId,
            currentHeadSha: tipSha ?? "",
            // #1360 — the caller named a ref that is NOT the checkout's tip and
            // is not one of its spellings, so the head check keeps its teeth: a
            // review of an older commit is refused `head-not-current`, never
            // forgiven as "the HEAD simply moved".
            ...(namedHeadIsTip(headRef, mainline.ok ? mainline : undefined) || namedRefResolvesToTip
              ? {}
              : { namedHeadSha: headSha, namedHeadRef: headRef }),
            ...(mainline.ok ? { mainline } : {}),
            execFn,
          })
        : undefined;
    const refusedByBinding = binding !== undefined && !binding.ok;
    const bound = binding?.ok ? binding : undefined;
    const detail = callerSupplied
      ? `${outcome} (caller-supplied diff)`
      : refusedByBinding && verdictPassed
        ? (binding.detail ?? `${outcome} (review range unverifiable)`)
        : outcome;
    const entry: LedgerEntry = {
      branch,
      kind: "adversarial",
      patchId: computed.patchId,
      passed: verdictPassed && !callerSupplied && !refusedByBinding,
      at: Date.now(),
      detail,
      ...(headSha ? { headSha } : {}),
      // #1557 — the nonce rides on the row verbatim (absent when the caller
      // supplied none, so hand-built and pre-#1557 shapes are untouched).
      ...(params.rowNonce ? { rowNonce: params.rowNonce } : {}),
      ...toolPathFields(bound ?? {}, toolPath),
    };
    // #1449 — the misdirection is answered in TWO places, and the row itself is
    // the second one. Inside the redirecting process the guard reads the same
    // file the writer wrote, so it can notice nothing; but a LATER process (a
    // fresh Pi session, the /work driver, an operator's terminal) reads the
    // clone's real ledger, finds nothing, and needs the write-side provenance to
    // explain why. It travels on the row because that is the one artefact the
    // write produces. The stamp itself is applied by `appendLedgerEntry`
    // (review-ledger.ts) — the one place that knows the resolved path — and handed
    // back through `stamped` rather than read off `entry`, which the writer does
    // not mutate: the outcome's `landedAtPath` and the row's stamp are then the
    // SAME string from the SAME resolution, not two comparisons that could
    // disagree.
    const stamped: { current: LedgerEntry; landedAtPath?: string } = { current: entry };
    const appendFailure = await appendLedgerEntry(entry, execFn, c, stamped);
    if (appendFailure) return { recorded: false, reason: appendFailure };
    return { recorded: true, landedAtPath: stamped.landedAtPath };
  };
  return write().catch((err: unknown): AdversarialLedgerOutcome => {
    // `err instanceof Error ? err.message : String(err)` — never a cast. The
    // writer's own body throws Errors, but `catch` also fires on anything a
    // called function throws: a bare string from a hand-rolled stub, or
    // undefined from a property access on an odd shape. `(err as Error).message`
    // is erased at compile time and throws a TypeError INSIDE this catch on
    // those, which turns "the ledger had a problem" into "the ledger write
    // rejected" — the one contract (#1161) every caller of this function relies
    // on. Same shape as `merge-guard-provenance.ts` and `analyseRefusal`.
    const reason = err instanceof Error ? err.message : String(err);
    trace(`adversarial: ledger write failed: ${reason}`);
    return { recorded: false, reason };
  });
}
