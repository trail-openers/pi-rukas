/*
 * lean/publish-draft — how a PR's DRAFT STATE gets into a publish record.
 *
 * `publish.ts` decides *whether* the head is pushed and the PR opened; this answers one question — "what does
 * the record say about `draft`, and what may it not say". It rests on one CLI fact: neither `gh pr list
 * --json` nor `gh pr create --json` carries `isDraft` — only `gh pr view` does. A guessed `true` over a ready
 * PR tells the host a mergeable PR stands behind unverified bytes.
 *
 * The record may carry what the FORGE was read to say, never what this run asked for; nothing when nobody
 * could tell; and a refusal when the run still had a DECISION to make with the answer (see
 * `reusedDraftState`).
 */
import type { NormalizedPullRequest } from "../forge-types.ts";
import type { PublishForge } from "./publish-deps.ts";
import { PublishInfraError } from "./publish-deps.ts";

/**
 * The state of a PR this step has just CREATED, as the forge reports it.
 *
 * The create reply carries no `isDraft`, so the forge is asked through `draftStateOf`. A forge that will not
 * say is NOT infrastructure here: the PR exists and the head is pushed, so the refusal is swallowed and the
 * outcome records no `draft`. What this run REQUESTED is never recorded in its place.
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
 * The list row's `isDraft` is absent, so returning it untouched puts `undefined` in the record however hard
 * the reads worked — and that field is the publish step's only answer to "is this PR mergeable as it stands".
 *
 * Whether a refusal is fatal depends on what the run still has to DECIDE with the answer. A not-green run
 * must choose between leaving a ready PR behind an unverified head and drafting one already a draft; made
 * blind, both are observations this step did not make, so it asks and refuses. A run with nothing to decide
 * may publish: the unread state costs the record its `draft` field, not the run.
 *
 * A reused PR keeps whatever state the PREVIOUS run left it, so a not-green run finding it ready puts it back
 * to draft — and a `prDraft` that fails is infrastructure, never a no-op.
 */
export async function reusedDraftState(
  f: PublishForge,
  found: NormalizedPullRequest,
  draft: boolean,
): Promise<NormalizedPullRequest> {
  // ONE read, then branch on the answer: the `draft` arm lets a refusal stand (decision to make, no guessing),
  // the other swallows it and records nothing.
  const observed = draft
    ? await draftStateOf(f, found)
    : await draftStateOf(f, found).catch(() => undefined);
  if (!draft) return { ...found, isDraft: observed };
  // Past the refusal above the answer is `true`: already a draft, nothing to put back.
  if (observed === true) return { ...found, isDraft: observed };
  await f.prDraft(found.number).catch((err: unknown) => {
    throw new PublishInfraError(
      `could not put the reused PR #${found.number} back to draft: ${(err as Error)?.message ?? String(err)}`,
    );
  });
  // A `prDraft` that returned without throwing is a CLAIM, not an observation: the head is already pushed, so
  // a forge that accepted the call and left the PR READY hands back `ok` with a mergeable PR behind
  // unverified bytes. Read it back; only `isDraft === true` continues.
  let why: string | undefined;
  const after = await f
    .prView(found.number)
    .then((v) => v?.isDraft)
    .catch((err: unknown) => {
      why = (err as Error)?.message ?? String(err);
      return undefined;
    });
  if (after !== true)
    throw new PublishInfraError(
      `the reused PR #${found.number} does not report itself a draft after prDraft, and a not-green run must not leave it ready${why === undefined ? "" : ` (${why})`}`,
    );
  return { ...found, isDraft: after };
}

/**
 * What the forge says about one PR's draft state, asked of `prView` when the reply the step holds did
 * not carry the flag.
 *
 * Throws when neither reply said. Deciding "already a draft" without evidence is what leaves an unverified PR
 * mergeable, so a caller with a decision to make lets the refusal stand.
 */
async function draftStateOf(f: PublishForge, pr: NormalizedPullRequest): Promise<boolean> {
  if (pr.isDraft !== undefined) return pr.isDraft;
  // The rejection message is kept, not swallowed: the reader of the handoff must tell an unreachable forge
  // from one that answered with neither field.
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
