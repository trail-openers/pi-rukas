/**
 * Mid-pattern `*` wildcard helpers for matchBashSubcommand (#891).
 *
 * A standalone `*` token in the middle of a bash allowlist pattern
 * (surrounded by spaces, not trailing) matches exactly one whitespace-free
 * argument via a `\S+` regex. Trailing `*` and `pattern *` keep their
 * existing semantics. These helpers are imported by bash-command-parser.ts
 * so that module stays under the 500-line file-size limit (AGENTS.md §12).
 */

// Moved verbatim from bash-command-parser.ts to stay under the 500-line limit.

/**
 * `vipune update` carrying new content — refused for every role, unconditionally.
 *
 * Measured: `vipune update <id> -t "…"` REPLACES the row's content in place. One
 * row before, one row after; no new row, no `superseded_by` lineage, no undo. The
 * id survives, so anything that cited that memory now cites different text —
 * which makes it quieter than `delete`, and worse.
 *
 * The allowlist alone cannot express this. `matchBashSubcommand` is
 * prefix-based, so `"vipune update *"` grants every flag or none; there is no way
 * to permit `--status` (harmless promotion) while refusing `--text`. So the
 * refusal lives here, ahead of the allowlist, and holds even if a future edit
 * re-admits the verb. The harness repairs memory with `add --supersedes`, which
 * preserves the original row — an agent must not silently rewrite the record it
 * is judged against.
 */
export function isDestructiveMemoryWrite(command: string): boolean {
  const c = command.trim();
  if (!/^vipune\s+update\b/.test(c)) return false;
  return /(^|\s)(-t|--text)(\s|=|$)/.test(c);
}

// Escape a single pattern token for use inside a RegExp literal.
function escapeRegexToken(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns true if the pattern has at least one standalone `*` token in a
// non-trailing position. Patterns with a mid `*` are routed through the
// regex branch; trailing `*`/` *` branches only apply to patterns without a mid `*`.
export function hasMidWildcard(pattern: string): boolean {
  const tokens = pattern.split(" ");
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === "*") return true;
  }
  return false;
}

// Build a RegExp for a pattern containing `*` tokens. Standalone mid `*`
// tokens become `\S+` (one whitespace-free arg); a trailing `*` on the last
// token becomes `.*` (loose prefix). Returns null if no `*` tokens at all.
export function midWildcardPattern(pattern: string): RegExp | null {
  const tokens = pattern.split(" ");
  let hasAny = false;
  for (const t of tokens) {
    if (t === "*" || t.endsWith("*")) {
      hasAny = true;
      break;
    }
  }
  if (!hasAny) return null;
  const last = tokens.length - 1;
  const parts = tokens.map((t, i) => {
    if (t === "*") return "\\S+";
    if (i === last && t.endsWith("*")) {
      const stem = t.slice(0, -1);
      return stem ? `${escapeRegexToken(stem)}.*` : ".*";
    }
    return escapeRegexToken(t);
  });
  return new RegExp(`^${parts.join("\\s+")}$`);
}
