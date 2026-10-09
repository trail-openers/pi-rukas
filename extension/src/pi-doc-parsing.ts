/**
 * Doc parsing for the pi compatibility claim — issue #1038 (split from
 * pi-binary-resolve.ts so the drift gate can import the parser directly).
 *
 * Single source of the "## Last verified against pi X.Y.Z (YYYY-MM-DD)" regex.
 * Consumed by pi-version-probe.ts (version warning) and
 * smoke-tests/test-pi-version-drift.ts (drift gate). Pure; no I/O.
 */

/**
 * Parse the maintained "## Last verified against pi X.Y.Z (YYYY-MM-DD)" line
 * from docs/pi-compatibility.md content. Returns null when absent.
 */
export function parseVerifiedLine(doc: string): { version: string; date: string } | null {
  const m = doc.match(
    /## Last verified against pi\s+([0-9][0-9a-z.+-]*)\s+\((\d{4}-\d{2}-\d{2})\)/,
  );
  if (!m) return null;
  return { version: m[1] as string, date: m[2] as string };
}
