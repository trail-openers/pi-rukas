/*
 * lib/lean-publish-seams — the per-case seams of `lib/lean-publish-fixture.ts`.
 *
 * Split out under the §12 file-size cap, and along the seam the options themselves
 * draw: these are the knobs a case turns to make one git call or one forge reply LIE
 * — a porcelain a push prints, a `prView` that answers something the row does not
 * carry, one read that dies — as against the run's shape (`lean-publish-origin.ts`
 * seeds origin, `PublishOpts`'s remaining fields log the step history).
 *
 * Each field is documented at its own declaration here; `PublishOpts` declares them
 * with the SAME types so a case never sees two spellings of one seam, and the fixture's
 * doc comment below is the authority on what each one is for.
 */

import type { PublishDeps } from "../../src/lean/publish-deps.ts";
import type { FakeForge } from "./lean-publish-forge.ts";
import type { RepublishRecorder } from "./lean-republish-recording-exec.ts";

/** The seams a single case turns to control one call's answer. */
export interface PublishSeams {
  /**
   * Record every executor and forge call the step makes, in call order — the seam the
   * `"0"` arm's byte-identity check needs, and a SPY rather than a stub: every call is
   * still forwarded, so origin keeps deciding what landed.
   */
  execRecorder?: Pick<RepublishRecorder, "wrapExec" | "forge">;
  /**
   * Answer one git call before the fixture's own executor sees it — the seam for
   * a case that must control a push's porcelain output, or fail one read the step makes.
   * Returning nothing means "let the call through".
   */
  execOver?: (
    cmd: string,
    opts?: Parameters<PublishDeps["exec"]>[1],
  ) =>
    | Promise<{ stdout: string; stderr?: string } | undefined>
    | { stdout: string; stderr?: string }
    | undefined;
  /**
   * What `git push` prints, reported by the fake INSTEAD of running the real
   * push — the seam for a case that must control the porcelain, e.g. a rejection
   * printed over a ref origin actually holds.
   */
  pushPorcelain?: string;
  /** Make `prList` reject. */
  listThrows?: boolean;
  /** Make `prView` reject, so the step cannot read a reused PR's draft state. */
  viewThrows?: boolean;
  /**
   * What `prView` reports for a REUSED PR, overriding the `openPrs` row. The
   * list reply the real CLI gives carries no `isDraft`, so a case that means
   * "the PR is ready" without teaching the step that the list answers says it
   * here, on the only reply that can.
   */
  viewIsDraft?: Record<string, boolean>;
  /** Make `prDraft` reject, so a reused PR cannot be put back to draft. */
  draftThrows?: boolean;
  /** Make `prView` reject for these PR numbers only (the read-back after a re-draft). */
  viewThrowsFor?: number[];
  /**
   * What `prView` reports for a number AFTER the step asked to draft it — the
   * seam for a forge that accepted `prDraft` and left the PR ready. A number the
   * map does not carry keeps the state the PR itself reports.
   */
  afterDraft?: Record<number, boolean | undefined>;
  /**
   * What `prView` reports for the PR the step CREATES — the seam for a forge
   * that made a draft and reports it ready (`gh pr create --json` carries no
   * `isDraft`, so the create reply never answers and the step must ask).
   */
  afterCreate?: Record<number, boolean | undefined>;
  /**
   * Report every PR row's `state` as something outside the `PullRequestState`
   * union — the seam for `mapPrListReply`'s `state: ""` row and for an adapter
   * that hands back `"open"`/`"Open"`. The publish step's open-PR check must
   * refuse on all of them.
   */
  stateOver?: string;
  /**
   * Replace the fake forge's methods — the seam for a case that must see the
   * FORGE-CALL SEQUENCE rather than only its counts.
   */
  forgeOver?: Partial<Omit<FakeForge, "prs">>;
}
