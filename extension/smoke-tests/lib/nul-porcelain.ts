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
 * - `"C\tfrom\tto"` / `"C75\tfrom\tto"` — a COPY (git's `C100`). A copy is what a
 *   developer produces when they duplicate a workflow instead of moving it, and the
 *   protected gate must see the *source* the same way it sees a rename's; a fake
 *   that could not spell one left that half of the parser unexercised.
 */
export function nulNameStatus(...records: string[]): string {
  const out: string[] = [];
  for (const line of records) {
    if (line.trim().length === 0) continue;
    const fields = line.split("\t");
    const first = (fields[0] ?? "").trim();
    if (fields.length >= 3 && /^[RC]\d*$/.test(first)) {
      // git prints the similarity score attached to the letter (`R100`, `C75`); an
      // omitted score is git's 100. The letter must be the WHOLE first field apart
      // from digits — a path spelled `"M\t…"` is a modification with a tab in its
      // name, and re-kinding a mistyped record would hide the typo.
      const score = /^[RC]\d+$/.test(first) ? first.slice(1) : "100";
      out.push(`${first[0]}${score}`, fields[1] ?? "", fields[2] ?? "");
      continue;
    }
    const kind = /^[MAD]$/.test(first) ? first : "M";
    const path = fields.length > 1 ? (fields[fields.length - 1] ?? "") : first;
    out.push(kind, path);
  }
  return out.length === 0 ? "" : `${out.join("\0")}\0`;
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
