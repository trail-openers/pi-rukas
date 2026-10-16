/**
 * secret-patterns — the one secret-shape pattern set, shared by vipune.ts
 * (`looksLikeSecret`) and the redactor below.
 *
 * Dependency-free by design: vipune.ts, decision-log.ts (`redactSecrets`, re-exported
 * from here for its existing callers) and the open-point reader all import from this file,
 * and the reader must not pull `node:fs` / `node:child_process` into its closure just to
 * redact a bullet (#1187 fix round 2).
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

/** The fixed marker every redacted span becomes. */
export const REDACTED = "[REDACTED]";

/** `SECRET_PATTERNS` with the global flag added, so `replace` hits every span. */
const GLOBAL_PATTERNS: readonly RegExp[] = SECRET_PATTERNS.map(
  (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`),
);

/**
 * Replace every span matching a {@link SECRET_PATTERNS} rule with {@link REDACTED}
 * and report how many spans were replaced.
 */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const re of GLOBAL_PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return REDACTED;
    });
  }
  return { text: out, count };
}
