/**
 * The ONE composer for a "this consolidation check did not run" note (#1153
 * round 3), extracted from work-driver-verify.ts to keep that module under the
 * file-size cap.
 *
 * A note is UNTRUSTED data with two homes: it is persisted to the state file
 * and rendered into a forge comment. Every skip site composes it out of
 * something it does not control — git's stderr, an operator-supplied branch
 * name, a reason string from the mainline resolver — so the three things that
 * used to be each site's own business are one site's contract here.
 */

import { realpathSync } from "node:fs";

/** How long a persisted consolidation note is allowed to be (see `consolidationNote`). */
const MAX_NOTE_CHARS = 500;

/**
 * Characters a renderer treats as a line break. A bare `\r` re-positions the
 * terminal cursor when an operator reads the comment, and `\u2028`/`\u2029`/
 * `\u0085` are line terminators to some renderers even though they are not to
 * JavaScript's regex engine — so all of them collapse to a single space.
 */
const LINE_TERMINATORS = /[\r\n\u2028\u2029\u0085]+/g;

/**
 * Drop C0 controls (NUL..0x1f) and DEL (0x7f).
 *
 * A character scanner over code points, not a `[\u0000-\u001f]` regex — the same
 * shape `dispatch-deck-line.ts` uses — so no control character appears in the
 * source at all. C1 is deliberately left alone: invisible, not structurally
 * dangerous.
 */
function dropC0Controls(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x20 && code !== 0x7f) out += text[i];
  }
  return out;
}

/**
 * Compose the note for one skipped consolidation check.
 *
 * Every skip site in `verifyConsolidation` goes through here — mainline
 * unresolved, no recorded branch, an unreadable ref probe, an absent ref, a
 * failed diff read. Three guarantees, none of which a call site may re-implement:
 *
 * - **The host path is redacted.** `ctx.repoRoot` is neither useful to a reader
 *   of the state file or the PR comment nor ours to publish. Both spellings are
 *   stripped, because a git error echoes the cwd as git RESOLVED it (the
 *   realpath), which survives a `replaceAll` of the raw string alone. The
 *   realpath lookup is best-effort: a note is composed on exactly the paths
 *   where git reads have already failed, and a note about a check that did not
 *   run must never itself be the thing that throws.
 * - **One note is one line.** A multi-line stderr would break the bullet list
 *   the renderer puts it in; see `LINE_TERMINATORS` and `dropC0Controls`.
 * - **The length is bounded HERE.** The render-side bound in `renderNoteBullet`
 *   protects the comment but not the file, and a git stderr can be megabytes.
 *   The two bounds are complementary, not redundant.
 */
export function consolidationNote(text: string, ctx: { repoRoot: string }): string {
  let out = text;
  const spellings: string[] = [ctx.repoRoot];
  try {
    spellings.push(realpathSync(ctx.repoRoot));
  } catch {
    // An unreadable root has nothing further to redact; the raw spelling above
    // still goes, and the note still gets written.
  }
  for (const root of spellings) {
    if (root.length > 0) out = out.replaceAll(root, "<repo>");
  }
  out = dropC0Controls(out.replace(LINE_TERMINATORS, " ")).trim().slice(0, MAX_NOTE_CHARS);
  return `consolidation check skipped: ${out}`;
}
