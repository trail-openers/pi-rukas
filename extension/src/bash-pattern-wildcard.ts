/**
 * Bash permission helper primitives: mid-`*` wildcard matching for
 * matchBashSubcommand (#891).
 *
 * A standalone `*` token in the middle of a bash allowlist pattern
 * (surrounded by spaces, not trailing) matches exactly one whitespace-free
 * argument via a `\S+` regex. Trailing `*` and `pattern *` keep their
 * existing semantics. These helpers are imported by bash-command-parser.ts
 * so that module stays under the 500-line file-size limit (AGENTS.md §12).
 * The vipune update refusal is bash-destructive-write.ts's isDestructiveWrite: one rule.
 */

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

// Build a RegExp for a pattern containing `*` tokens. Like hasMidWildcard,
// standalone mid `*` tokens mean exactly one whitespace-free argument.
// Standalone mid `*` tokens become `\S+` (one whitespace-free arg); a
// trailing `*` on the last token becomes `.*` (loose prefix). Returns null if
// no `*` tokens at all.
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
