/**
 * #1378 — the develop gate's change-set reads are NUL-separated
 * (`work-driver-protected-paths-read.ts`). Dozens of develop-gate fakes script
 * those two reads as the plain text git used to print; handing that text back for
 * a `-z` call parses as an EMPTY change set, so the assertions pass while
 * inspecting nothing — the vacuous-fake class #1283 exists to catch.
 *
 * These helpers translate the ergonomic test spelling (one path per line, renames
 * as `R  from -> to`) into the exact byte stream git emits, including the two
 * quirks that the original bug hid behind — both verified against a real
 * repository, not assumed from the man page:
 *
 *   - under `-z` a rename's field order REVERSES: `XY new\0orig\0`, destination first;
 *   - `-z` does not C-quote a name (no surrounding quotes, no octal escapes).
 *
 * Fakes reach these through `commandOf(cmd, opts)` from lib/argv-shell.ts so an
 * argv call cannot fall through to a silent `{stdout:""}`.
 */

/** A status record as a test writes it: `" M src/a.ts"`, `"?? .pi/x"`, `"R  old -> new"`. */
export function nulStatus(...records: string[]): string {
  const out: string[] = [];
  for (const line of records) {
    if (line.trim().length === 0) continue;
    const code = line.slice(0, 3); // the two status columns plus their separator
    const entry = line.slice(3);
    const arrow = entry.indexOf(" -> ");
    if (arrow >= 0 && /[RC]/.test(code)) {
      out.push(`${code}${unquote(entry.slice(arrow + 4))}`, unquote(entry.slice(0, arrow)));
    } else {
      out.push(`${code}${unquote(entry)}`);
    }
  }
  return out.length === 0 ? "" : `${out.join("\0")}\0`;
}

/** A name-status record as a test writes it: `"src/a.ts"` or `"R\tfrom\tto"`. */
export function nulNameStatus(...records: string[]): string {
  const out: string[] = [];
  for (const line of records) {
    if (line.trim().length === 0) continue;
    const fields = line.split("\t");
    if (fields.length >= 3 && /^R/.test(fields[0] ?? "")) {
      out.push("R100", fields[1] ?? "", fields[2] ?? "");
    } else {
      // A bare path is a change of indeterminate kind; `M` parses identically to
      // the `D`/`A` git would emit for a deleted or added file.
      out.push("M", fields[fields.length - 1] ?? "");
    }
  }
  return out.length === 0 ? "" : `${out.join("\0")}\0`;
}

/** A `\n`-joined list of changed paths → the committed read's NUL stream. */
export function nulLines(text: string): string {
  return nulNameStatus(...text.split("\n"));
}

/** `-z` names are raw bytes — the non-`-z` form's C-quoting is not in them. */
function unquote(p: string): string {
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p;
}

/** Does this command line name the gate's NUL-separated uncommitted read? */
export function isNulStatusRead(line: string): boolean {
  return /\bstatus --porcelain -z --untracked-files=all$/.test(line);
}

/** Does this command line name the gate's NUL-separated committed read? */
export function isNulDiffRead(line: string): boolean {
  return /\bdiff -z --name-status -M\b/.test(line);
}
