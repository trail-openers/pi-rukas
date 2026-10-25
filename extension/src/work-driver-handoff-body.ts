/**
 * work-driver-handoff-body — the handoff comment's bytes, assembled once
 * (#1788 follow-up).
 *
 * The handoff body is the driver's largest publish: it quotes transcript paths,
 * worktree paths and verify-log paths, all of which are the HOST's filesystem,
 * and the generic hygiene set refuses a personal home path in public text.
 *
 * ## Normalise once, at the top of the publish path
 *
 * The body is published from a FILE: `runHandoff` writes `handoff-comment.md`,
 * the ops child posts that file, and the in-process fallback, the idempotency
 * comparison (`postHandoffWithRetry`'s `expectedBody`) and the `handoff-emitted`
 * event all read or carry a rendering of it. Normalising at a reader would mean
 * several readers agreeing on a rewrite independently — and the comparison in
 * particular would then treat a comment that carries the NORMALISED text as not
 * yet posted, because it was compared against the raw render. So the rewrite
 * happens here, once, before the file is written, and the caller threads this
 * one string to every one of those consumers: the file's bytes, the fallback's
 * `body`/`expectedBody`, and the event's `body`.
 *
 * ## The same public-only rule as every other publish
 *
 * A POSITIVE private answer leaves the exact paths — nothing is published, and a
 * reader of a private repository's own handoff wants the real path. Every other
 * answer (public, unknown, a lookup that failed) normalises, as it does at the
 * driver seam. `PI_ENSEMBLE_PUBLIC_HYGIENE=0` skips the rewrite just as it skips
 * the check.
 *
 * ## Order
 *
 * The marker is added AFTER the normalisation so the rewrite can never touch the
 * `<!-- pi-rukas: … -->` span a host parses to find and extend this comment, and
 * the note is added last so a body with nothing to rewrite is byte-identical to
 * what it was before this module existed. Text that never reaches a forge — the
 * chat message, the local `/work-status` recovery block — is NOT rewritten
 * through this module: it calls `renderHandoffMarkdown` directly.
 */

import type { Forge } from "./forge.ts";
import { hygieneGuardDisabled } from "./public-hygiene-config.ts";
import {
  normaliseDriverPublishPaths,
  withPathNormalisationNote,
} from "./public-hygiene-normalise.ts";
import { type VisibilityFn, isPrivateTarget } from "./public-hygiene-visibility.ts";
import { withHandoffMarker } from "./work-driver-handoff-channel.ts";
import { renderHandoffMarkdown } from "./work-driver-handoff-markdown.ts";
import type { WorkState } from "./workflow-state.ts";

/**
 * The handoff comment body for this state: rendered, its host paths normalised
 * for a publish out of `ctx.repoRoot`, marker-prefixed, and annotated when a
 * rewrite actually happened.
 *
 * AWAITED because the normalisation is conditional on the visibility question
 * the driver seam asks everywhere (see the module header). The caller writes the
 * returned string to the body file and passes THAT string — not a re-read of the
 * file — to the in-process fallback, the idempotency comparison, and the
 * `handoff-emitted` event.
 */
export async function handoffCommentBody(
  state: WorkState,
  ctx: { repoRoot: string },
  forge: Forge | undefined,
  visibility?: VisibilityFn,
): Promise<string> {
  const rendered = renderHandoffMarkdown(state, forge?.forge);
  if (hygieneGuardDisabled()) return withHandoffMarker(rendered, state);
  const target =
    forge !== undefined && forge.owner !== "" && forge.repo !== ""
      ? { owner: forge.owner, repo: forge.repo, host: forge.host }
      : undefined;
  const isPrivate =
    target !== undefined &&
    (await isPrivateTarget(target, { lookup: visibility }).catch(() => false));
  if (isPrivate) return withHandoffMarker(rendered, state);
  const normalised = normaliseDriverPublishPaths(rendered, { repoRoot: ctx.repoRoot });
  return withPathNormalisationNote(withHandoffMarker(normalised.text, state), normalised.rewritten);
}
