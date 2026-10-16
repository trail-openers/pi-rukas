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
 * argv call cannot fall through to a silent `{stdout:""}` — and the matchers
 * below are DERIVED from the same argv constants the production readers send,
 * via `commandOf`. A hand-written regex here would restate the command line a
 * second time: change the argv in src and every fake silently stops matching,
 * the read falls through to `{stdout:""}`, and the assertions pass against an
 * EMPTY change set. That is the vacuous-fake class this lib exists to catch, so
 * it does not get to live in the harness. `test-work-driver-protected-paths-read.ts`
 * asserts a real argv call routed through `commandOf` satisfies both matchers.
 */

import {
  PROTECTED_DIFF_ARGV,
  PROTECTED_STATUS_ARGV,
} from "../../src/work-driver-protected-paths-read.ts";
import { commandOf } from "./argv-shell.ts";

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

/**
 * A name-status record as a test writes it.
 *
 * - `"src/a.ts"` — a modification (git's `M`).
 * - `"A\tsrc/a.ts"` / `"D\t.pi/verify-cmd"` — an added or deleted path. The kind
 *   is emitted, not inferred: collapsing every non-rename to `M` made a deletion
 *   test indistinguishable from a modification test, so a reader that ignored the
 *   status field could still pass "a deleted protected file halts".
 * - `"R\tfrom\tto"` — a rename (git's `R100`, three tokens).
 */
export function nulNameStatus(...records: string[]): string {
  const out: string[] = [];
  for (const line of records) {
    if (line.trim().length === 0) continue;
    const fields = line.split("\t");
    if (fields.length >= 3 && /^R/.test(fields[0] ?? "")) {
      out.push("R100", fields[1] ?? "", fields[2] ?? "");
      continue;
    }
    const first = (fields[0] ?? "").trim();
    const kind = /^[MAD]$/.test(first) ? first : "M";
    const path = fields.length > 1 ? (fields[fields.length - 1] ?? "") : first;
    out.push(kind, path);
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

/**
 * The shell-form command line the gate sends for the uncommitted read — built by
 * `commandOf`, the very function the fakes match against, so the two cannot drift.
 */
const NUL_STATUS_CMD = commandOf("git", { argv: [...PROTECTED_STATUS_ARGV] });

/**
 * The shell-form prefix of the committed read. The `<base>..HEAD` range is
 * deliberately NOT part of it: it is the one element a caller appends at the call
 * site (and the one whose text a test controls), so the matcher takes it as a
 * suffix rather than pretending to know it.
 */
const NUL_DIFF_PREFIX = `${commandOf("git", { argv: [...PROTECTED_DIFF_ARGV] })} `;

/** Does this command line name the gate's NUL-separated uncommitted read? */
export function isNulStatusRead(line: string): boolean {
  return line === NUL_STATUS_CMD;
}

/** Does this command line name the gate's NUL-separated committed read? */
export function isNulDiffRead(line: string): boolean {
  return line.startsWith(NUL_DIFF_PREFIX) && line.slice(NUL_DIFF_PREFIX.length).length > 0;
}
