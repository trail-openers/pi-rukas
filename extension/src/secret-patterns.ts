/**
 * secret-patterns — the one secret-shape pattern set, shared by vipune.ts
 * (`looksLikeSecret`) and decision-log.ts (`redactSecrets`).
 */

/**
 * Secrets, by shape. vipune refuses to store a matching text (it persists
 * plaintext SQLite) and the decision log redacts matching spans (#1308) —
 * one pattern set, so the two cannot drift.
 *
 * Deliberately keyed on *shape with context*, never on raw entropy. An
 * earlier draft used `[A-Fa-f0-9]{40,}`, which matches every git SHA — so a
 * correction citing a commit, or a CI error line containing a hash, would
 * have been silently refused on the highest-value write path.
 */
export const SECRET_PATTERNS: readonly RegExp[] = [
  // OpenAI and Anthropic both use `sk-` with an infix segment (`sk-proj-`,
  // `sk-ant-api03-`), so the token body is NOT alphanumeric-only. Measured: the
  // previous `sk-[A-Za-z0-9]{16,}` refused a legacy key and passed both current
  // formats — including this project's own provider.
  /\bsk-[A-Za-z0-9](?:[A-Za-z0-9-]{15,})\b/,
  /\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bglpat-[A-Za-z0-9_-]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bnpm_[A-Za-z0-9]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*["']?[A-Za-z0-9._\-/+]{12,}/i,
  // A password embedded in a URL: scheme://user:pass@host
  /:\/\/[^\s/:@]+:[^\s/@]+@/,
];
