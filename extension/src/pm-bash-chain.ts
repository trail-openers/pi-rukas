/**
 * pm-bash-chain — lets the PM bash guard accept a chain of allowlisted reads
 * (`git status && git diff --stat`, `git log --oneline -12 | head -5`,
 * `jq . .pi/work-state/5.json 2>/dev/null`) instead of refusing every
 * operator outright (#1352).
 *
 * The PM spent turns inventing workarounds for refused reads of its own
 * cycle: every command in the report was a read, refused only because it
 * carried `&&`, `;` or `|`. `matchBashSubcommand` keeps its contract — it
 * still returns null for any operator, because it also serves strict/headless
 * resolution for every role — and this module is consulted by the PM guard
 * alone, after that null.
 *
 * The rule: split at `&&`, `||`, `;` and `|` outside quotes, drop the
 * harmless redirects `2>/dev/null`, `>/dev/null`, `&>/dev/null` and `2>&1`,
 * and allow only when EVERY segment is itself an `allow` under the same
 * allowlist. Each segment goes back through `matchBashSubcommand`, so `$(…)`,
 * backticks, `$VAR`, any other redirect and an escaped operator still refuse.
 * Refused outright: a background `&`, a newline, an unterminated quote, and
 * `xargs` / `tee` anywhere in a chain — they turn the upstream output into a
 * command line or a file write, which no single allowlisted read can do.
 *
 * Every part's first word must also BE an allowlisted command word, not just
 * start with one: loose rows like `echo*` / `cat*` prefix-match
 * `echo() ( touch x )` (a function definition that a later part would call),
 * `cat=1 touch x` (an env assignment before another command) and
 * `catchsegv <prog>`. `firstWordAllowed` refuses all three; the PM guard
 * applies it to a single command too.
 */

import { matchBashSubcommand } from "./bash-command-parser.ts";

export type ChainSplit =
  | { ok: true; segments: string[] }
  | { ok: false; reason: "unterminated-quote" | "operator" };

const NULL_REDIRECT = /^(?:[12&]?>\/dev\/null|2>&1)(?=$|[\s;&|])/;

/** Split a command at top-level `&&`, `||`, `;`, `|`, dropping null redirects. */
export function splitReadOnlyChain(command: string): ChainSplit {
  const segments: string[] = [];
  let cur = "";
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i] ?? "";
    if (ch === "'" || ch === '"') {
      // Copy the quoted run verbatim; the segment check re-parses it.
      let j = i + 1;
      while (j < n && command[j] !== ch) j += ch === '"' && command[j] === "\\" ? 2 : 1;
      if (j >= n) return { ok: false, reason: "unterminated-quote" };
      cur += command.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "\\") {
      cur += command.slice(i, i + 2); // escaped char stays; the segment check sees it
      i += 2;
    } else if (command.startsWith("&&", i) || command.startsWith("||", i)) {
      segments.push(cur);
      cur = "";
      i += 2;
    } else if (ch === ";" || (ch === "|" && command[i + 1] !== "&")) {
      segments.push(cur);
      cur = "";
      i++;
    } else {
      const redirect = NULL_REDIRECT.exec(command.slice(i));
      if (redirect && /^$|\s$/.test(cur)) {
        i += redirect[0].length;
      } else if (ch === "&" || ch === "\n") {
        return { ok: false, reason: "operator" };
      } else {
        cur += ch;
        i++;
      }
    }
  }
  segments.push(cur);
  const trimmed = segments.map((s) => s.trim());
  // A trailing `;` is harmless; an empty segment anywhere else is malformed.
  if (trimmed.length > 1 && trimmed[trimmed.length - 1] === "") trimmed.pop();
  if (trimmed.some((s) => s === "")) return { ok: false, reason: "operator" };
  return { ok: true, segments: trimmed };
}

const CHAIN_FORBIDDEN = /^(?:xargs|tee)(?:\s|$)/;

/** True when every part of the chain is an allowlisted read on its own. */
export function allowsReadOnlyChain(command: string, allowlist: Record<string, string>): boolean {
  const split = splitReadOnlyChain(command);
  if (!split.ok) return false;
  return split.segments.every(
    (s) =>
      !CHAIN_FORBIDDEN.test(s) &&
      matchBashSubcommand(s, allowlist) === "allow" &&
      firstWordAllowed(s, allowlist),
  );
}

/**
 * True when the command's first word equals the first word of an `allow`
 * row (`cat*` → `cat`, `git -C * log*` → `git`), so a loose prefix row never
 * admits a longer word, a function definition or an env assignment.
 */
export function firstWordAllowed(command: string, allowlist: Record<string, string>): boolean {
  const first = command.trimStart().split(/\s/, 1)[0] ?? "";
  if (first === "") return false;
  return Object.entries(allowlist).some(
    ([pattern, verdict]) =>
      verdict === "allow" && pattern.split(/\s/, 1)[0]?.replace(/\*$/, "") === first,
  );
}
