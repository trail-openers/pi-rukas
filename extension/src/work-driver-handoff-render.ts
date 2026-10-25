/**
 * work-driver-handoff-render — the handoff body's render-and-write step, split
 * out of `work-driver-handoff.ts` for the §12 500-line gate.
 *
 * `runHandoff` composes the body once and threads that one string to every
 * consumer: the bytes the body file carries, the bytes the in-process fallback
 * posts and compares, and the bytes the `handoff-emitted` event records (#1327).
 * This module owns exactly that segment — resolve the forge, ask the driver seam,
 * write the file — and returns both the string and the path, so the step handler
 * keeps the routing and none of it has to agree with a reader about what the body
 * was.
 *
 * The public/private decision and the fold come from the ONE driver seam
 * (`work-driver-lens-cap-hygiene.ts`), not from a local copy of the rule: a
 * handoff on a private repository must keep its exact paths, and only the seam
 * resolves visibility the way every other driver publish does (#1820). A refusal
 * writes NO file — a comment the matcher refused must not sit on disk looking
 * like something the driver is about to post.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { handoffCommentBody } from "./work-driver-handoff-body.ts";
import { handoffForge } from "./work-driver-handoff-forge.ts";
import { scratchDir } from "./work-driver-workspace.ts";
import type { WorkState } from "./workflow-state.ts";

/** What the render produced: the body to publish, its path, and the refusal. */
export interface HandoffRender {
  /** The bytes the matcher judged: the text to publish, or the text it rejected. */
  body: string;
  /** Where the body file lives (the ops child's post surface, and the recovery print). */
  bodyPath: string;
  /** The matcher's category/line when the body was refused — never the term. */
  refusal?: string;
}

/**
 * Render the handoff body through the driver seam and write it to the cycle's
 * scratch dir, in one step, before any dispatch is paid for.
 */
export async function renderHandoffBody(
  ctx: CycleContext,
  state: WorkState,
): Promise<HandoffRender> {
  const forge = ctx.forge ?? (await handoffForge(ctx.repoRoot));
  const bodyPath = path.join(scratchDir(ctx.repoRoot, ctx.issue), "handoff-comment.md");
  const bodyCheck = await handoffCommentBody(
    state,
    ctx,
    forge,
    ctx.handoffVisibility,
    ctx.verifyExecFn ?? execp,
  );
  if (bodyCheck.refusal !== undefined) {
    // The comment carries text the matcher refused. NO FILE is written — a comment
    // the matcher refused must not sit on disk looking like something the driver is
    // about to post — and the caller gates every post on `refusal`, so the
    // not-posted path runs unchanged. The reason is traced as the matcher's
    // category and line — never the matched term, which is the private thing
    // itself. The refused text still comes back: the host channel posts nothing and
    // its result body is the only carrier of the report (#1743).
    trace(
      `work-driver: handoff body refused for #${ctx.issue}: ${bodyCheck.refusal.slice(0, 160)}`,
    );
    return { body: bodyCheck.body, bodyPath, refusal: bodyCheck.refusal };
  }
  const body = bodyCheck.body;
  try {
    await fs.mkdir(path.dirname(bodyPath), { recursive: true });
    await fs.writeFile(bodyPath, body, "utf8");
  } catch (err) {
    trace(`work-driver: failed to write handoff body file: ${(err as Error).message}`);
  }
  return { body, bodyPath };
}
