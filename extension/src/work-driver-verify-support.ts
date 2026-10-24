/**
 * work-driver-verify-support — the plain vocabulary the two verify-evidence
 * readers share, and nothing else (#1762 round 1).
 *
 * Why this exists rather than a direct import. `work-driver-verify-failures.ts`
 * (the table, the cut) and `work-driver-verify-inner-line.ts` (what a reader is
 * SHOWN for a harness-wrapped failure) each needed something from the other: the
 * cut needed the residue strip, and the strip needed `splitLines` and the shape
 * test from the classifier. That is a cycle, and the module graph is meant to be a
 * DAG. The classifier now owns the cut and passes its own shape test INTO the
 * strip, which is the direction the data actually flows; what remains shared is
 * vocabulary — a line break, and the leading run of stream separators a cut can
 * leave behind — and living here, in a module neither reader imports through the
 * other, it cannot close a cycle.
 *
 *   - **Separator padding.** A harness command string or cwd that carries `: ` of
 *     its own makes the stream the cut produced start with `: : : ` before the
 *     gate's line, and both the cut and the reader's strip have to agree on what
 *     that padding is before either can remove it.
 */

/** The leading run of stream separators a returned stream can carry. */
export const LEADING_SEPARATOR = /^(?::\s+)+/;

/** Split a combined stream into lines: `\r\n`, `\r` and `\n` are all breaks. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}
