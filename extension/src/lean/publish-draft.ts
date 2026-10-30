/*
 * lean/publish-draft — how a PR's DRAFT STATE gets into a publish record.
 *
 * Split out of `publish.ts` for the §12 size cap along the seam the step had
 * already drawn: `publish.ts` decides *whether* the head is pushed and the PR
 * opened; this file answers one question, "what does the record say about
 * `draft`, and what may it not say". Everything here rests on one fact about the
 * CLI: neither `gh pr list --json` nor `gh pr create --json` carries `isDraft` —
 * only `gh pr view --json …,isDraft,…` does. So a step that never asked could
 * only guess, and a guessed `true` over a ready PR tells the host a mergeable PR
 * stands behind unverified bytes: the lie the whole read-back exists to prevent.
 *
 * What the record may carry:
 *   - what the FORGE was read to say, never what this run asked for;
 *   - nothing at all (the field absent) when nobody could tell — "could not
 *     tell" is never recorded as the state this run wanted;
 *   - and a refusal, rather than either, when the run still had a DECISION to
 *     make with the answer (see `reusePr`: a not-green run over a reused PR must
 *     choose between leaving it ready over an unverified head and drafting one
 *     that was already a draft).
 */
import type { NormalizedPullRequest } from "../forge-types.ts";
import type { PublishForge } from "./publish-deps.ts";
import { PublishInfraError } from "./publish-deps.ts";

/**
 * The state of a PR this step has just CREATED, as the forge reports it.
 *
 * The create reply carries no `isDraft` (`gh pr create` issues
 * `--json number,title,state,url`), so the forge is asked through
 * `draftStateOf` — the same reader a reused PR's state goes through, so one rule
 * says how a draft is established. A forge that will not say is NOT
 * infrastructure here: the PR exists and the head is already pushed, so the
 * refusal is swallowed and the outcome records no `draft` at all. What this run
 * REQUESTED is never recorded in its place.
 */
export async function createdDraftState(
  f: PublishForge,
  created: NormalizedPullRequest,
): Promise<boolean | undefined> {
  return draftStateOf(f, created).catch(() => undefined);
}

/**
 * The state of a PR this step REUSED, carried out on every path the caller takes.
 *
 * The list row's `isDraft` is absent, so returning the row untouched would put
 * `undefined` in the record however hard the reads worked — and that field is a
 * publish step's only answer to "is this PR mergeable as it stands".
 *
 * Whether a refusal to answer is fatal depends on what this run still has to
 * DECIDE with the answer, not on whether a commit went out (the push has already
 * happened either way). A not-green run has to choose between leaving a ready PR
 * standing behind an unverified head and drafting one that was already a draft;
 * both choices made blind are observations this step did not make, so it asks
 * and refuses. A run with nothing to decide may publish: it is not about to
 * leave anything mergeable, so the unread state costs the record its `draft`
 * field and not the run.
 *
 * A reused PR keeps whatever state the PREVIOUS run left it in — `prCreate`'s
 * `draft` option applies only to a PR this step opens — so the not-green run
 * that finds it ready puts it back to draft, and a `prDraft` that fails is
 * infrastructure, never a no-op: silently leaving it ready is the lie this step
 * exists to prevent.
 */
export async function reusedDraftState(
  f: PublishForge,
  found: NormalizedPullRequest,
  draft: boolean,
): Promise<NormalizedPullRequest> {
  const observed = draft
    ? await draftStateOf(f, found)
    : await draftStateOf(f, found).catch(() => undefined);
  if (!draft) return { ...found, isDraft: observed };
  if (observed === false) {
    await f.prDraft(found.number).catch((err: unknown) => {
      throw new PublishInfraError(
        `could not put the reused PR #${found.number} back to draft: ${(err as Error)?.message ?? String(err)}`,
      );
    });
    // A `prDraft` that returned without throwing is a CLAIM, not an observation:
    // the head is already pushed at this point, so a forge that accepted the call
    // and left the PR READY would hand back `ok` with a mergeable PR standing
    // behind unverified bytes. Read it back; only `isDraft === true` is an answer
    // that lets the run continue.
    const after = await f
      .prView(found.number)
      .then((v) => v?.isDraft)
      .catch(() => undefined);
    if (after !== true)
      throw new PublishInfraError(
        `the reused PR #${found.number} does not report itself a draft after prDraft, and a not-green run must not leave it ready`,
      );
    return { ...found, isDraft: after };
  }
  return { ...found, isDraft: observed };
}

/**
 * What the forge says about one PR's draft state, asked of `prView` when the
 * reply the step already holds did not carry the flag.
 *
 * Throws when neither reply said. Deciding "already a draft" (or "already
 * ready") without evidence is exactly what leaves an unverified PR mergeable, so
 * the caller that has a decision to make lets the refusal stand; the callers that
 * are merely recording swallow it and record nothing.
 */
async function draftStateOf(f: PublishForge, pr: NormalizedPullRequest): Promise<boolean> {
  if (pr.isDraft !== undefined) return pr.isDraft;
  // The rejection message is kept rather than swallowed: "could not tell" is
  // true either way, but an operator reading the handoff has to be able to tell
  // a forge that was unreachable from one that answered with neither field.
  let why: string | undefined;
  const viewed = await f
    .prView(pr.number)
    .then((v) => v?.isDraft)
    .catch((err: unknown) => {
      why = (err as Error)?.message ?? String(err);
      return undefined;
    });
  if (viewed !== undefined) return viewed;
  throw new PublishInfraError(
    `could not tell whether PR #${String(pr.number)} is a draft, and a run must not record a draft state it did not read${why === undefined ? "" : ` (${why})`}`,
  );
}
