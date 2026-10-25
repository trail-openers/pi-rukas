/**
 * work-driver-handoff-body — the handoff comment's bytes, assembled once
 * (#1788 follow-up; the public/private decision belongs to one seam, #1820).
 *
 * The handoff body is the driver's largest publish: it quotes transcript paths,
 * worktree paths and verify-log paths, all of which are the HOST's filesystem,
 * and the generic hygiene set refuses a personal home path in public text.
 *
 * ## Normalise once, at the top of the publish path
 *
 * The body is published from a FILE: `runHandoff` writes `handoff-comment.md`,
 * the ops child posts that file, and the in-process fallback, the idempotency
 * comparison (`postHandoffWithRetry`'s body match) and the `handoff-emitted`
 * event all read or carry a rendering of it. Normalising at a reader would mean
 * several readers agreeing on a rewrite independently — and the comparison in
 * particular would then treat a comment that carries the NORMALISED text as not
 * yet posted, because it was compared against the raw render. So the rewrite
 * happens here, once, before the file is written, and the caller threads this
 * one string to every one of those consumers: the file's bytes, the fallback's
 * `body`, and the event's `body`.
 *
 * ## The same public-only rule as every other publish — from the one seam
 *
 * This module used to decide public-vs-private itself: it called `isPrivateTarget`
 * with whatever resolver the caller happened to pass and no visibility resolver of
 * its own, so a driver handoff on a PRIVATE repository got folded like a public
 * one — the exact decision the driver seam exists to make consistently, made a
 * second time here with less information. It now asks
 * {@link residualDisclosureBody} — the driver seam's normalise path, the same one
 * the round-cap disclosure post uses — which resolves the target, applies the
 * positive-private skip (with `gh` as its own fallback), rewrites, and judges the
 * rewritten bytes. One owner decides; this module just publishes what it returns.
 *
 * A REFUSAL is returned rather than thrown: a handoff whose own text cannot be
 * published is a handoff that does not post a comment, and the caller records the
 * refusal so nothing is marked posted. The reason reaches the trace and the
 * handoff event as the matcher's category and line — never the matched term, which
 * is the thing this module exists to keep out of a public record.
 *
 * ## Order
 *
 * The marker is added AFTER the normalisation so the rewrite can never touch the
 * `<!-- pi-rukas: … -->` span a host parses to find and extend this comment (the
 * seam also masks markers out, so this is belt and braces: the marker the caller
 * receives is byte-identical either way). The note is added last so a body with
 * nothing to rewrite is byte-identical to what it was before this module existed.
 * Text that never reaches a forge — the chat message, the local `/work-status`
 * recovery block — is NOT rewritten through this module: it calls
 * `renderHandoffMarkdown` directly.
 */

import { execp } from "./exec.ts";
import type { Forge } from "./forge.ts";
import { hygieneGuardDisabled } from "./public-hygiene-config.ts";
import { withPathNormalisationNote } from "./public-hygiene-normalise.ts";
import type { VisibilityFn } from "./public-hygiene-visibility.ts";
import { withHandoffMarker } from "./work-driver-handoff-channel.ts";
import { renderHandoffMarkdown } from "./work-driver-handoff-markdown.ts";
import { residualDisclosureBody } from "./work-driver-lens-cap-hygiene.ts";
import type { WorkState } from "./workflow-state.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * What the render produced.
 *
 * `refusal` alone says the comment may NOT be posted. `body` is the text the
 * matcher judged — on a refusal, the text the matcher REJECTED — and it is carried
 * on both branches on purpose: the host channel posts nothing and its result body
 * is the only carrier of the report, so a refusal that dropped the text would lose
 * the park entirely (#1743) while telling the operator nothing about what was
 * refused. A caller must gate every publish on `refusal === undefined`, never on
 * `body !== undefined`.
 */
export type HandoffBodyOutcome = { body: string; refusal?: string };

/**
 * The handoff comment body for this state: rendered, its host paths normalised
 * for a publish out of `ctx.repoRoot` by the driver seam, marker-prefixed, and
 * annotated when a rewrite actually happened.
 *
 * AWAITED because the normalisation is conditional on the visibility question the
 * driver seam asks everywhere (see the module header). The caller writes the
 * returned string to the body file and passes THAT string — not a re-read of the
 * file — to the in-process fallback, the idempotency comparison, and the
 * `handoff-emitted` event.
 */
export async function handoffCommentBody(
  state: WorkState,
  ctx: { repoRoot: string; verifyExecFn?: ExecFn },
  forge: Forge | undefined,
  visibility?: VisibilityFn,
  exec?: ExecFn,
): Promise<HandoffBodyOutcome> {
  const rendered = renderHandoffMarkdown(state, forge?.forge);
  if (hygieneGuardDisabled()) return { body: withHandoffMarker(rendered, state) };
  const execFn = exec ?? ctx.verifyExecFn ?? execp;
  const checked = await residualDisclosureBody(
    { repoRoot: ctx.repoRoot, verifyExecFn: execFn },
    rendered,
    execFn,
    forge,
    visibility,
  );
  if (checked.refusal !== undefined) {
    // Carry the refused bytes with the refusal. The marker is added to the
    // judged text so a reader who recovers the text sees the same first line the
    // comment would have had; nothing here publishes it.
    return { body: withHandoffMarker(checked.text, state), refusal: checked.refusal };
  }
  return {
    body: withPathNormalisationNote(withHandoffMarker(checked.text, state), checked.rewritten),
  };
}
