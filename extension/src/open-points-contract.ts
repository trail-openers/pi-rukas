/**
 * open-points-contract — the contract for the "Open points" section of a filed issue (#1151).
 *
 * The /plan gap gate writes this section (plan-gap-disclosure.ts) when a CRITICAL
 * gap is still unresolved at its iteration cap. The /work intent gate reads it
 * back (work-driver-intent-criticality.ts) and decides whether the issue is
 * buildable. Both sides take the heading and severity from here, so a rename on
 * one side cannot silently stop the other from reading what it wrote.
 *
 * Reading rules the intent gate applies:
 *   - only bullets under the heading, and only those tagged `[CRITICAL]` (uppercase),
 *     gate;
 *   - a security-class point parks the cycle with reason `security-open-point`; any
 *     other point caps a proceed at `proceed-with-assumptions`. The security class is
 *     SECURITY_CLASS_TERMS below and nothing else: it is the only home of that list;
 *   - a point the author has answered no longer gates. A bullet is resolved only
 *     when `[RESOLVED]` immediately follows the severity tag (e.g.
 *     `- [CRITICAL][RESOLVED] …` or `- [CRITICAL] [RESOLVED] …`). Answer the point
 *     in the issue body, mark it resolved, and re-run with `/work N --restart`;
 *   - a line in the section that mentions CRITICAL but does not parse as a point
 *     or a resolved bullet caps a proceed rather than being ignored.
 */

/** Heading of the open-points section the gap gate renders. */
export const OPEN_POINTS_HEADING = "Open points (unresolved at the gap-gate cap)";

/** The severity tag of a bullet that gates the intent resolver. */
export const CRITICAL_SEVERITY = "CRITICAL";

/**
 * One family of the security class. `stem` is a regex body matched as a whole
 * word, case-insensitively. When `requires` is set, the term matches only if one
 * of the co-words also appears in the same open-point bullet (the whole bullet
 * text, case-insensitive, whole-word).
 */
export interface SecurityTerm {
  readonly label: string;
  readonly stem: string;
  readonly requires?: readonly string[];
}

/**
 * The security class: decisions the driver must not make on the resolver's behalf.
 * An unresolved CRITICAL point matching any term parks rather than proceeds.
 *
 * Ambiguous stems carry co-words so ordinary engineering wording ("dependency
 * injection", "config validate step", "which role reviews the PR", "tokenizer
 * output", "stale cache entries are deleted") does not park.
 */
export const SECURITY_CLASS_TERMS: readonly SecurityTerm[] = [
  { label: "authentication", stem: String.raw`(?:un|pre|re|non)?auth(?:n|z|s)?(?:_\w*)?` },
  { label: "authentication", stem: String.raw`(?:un|pre|re|non)?authenticat\w*` },
  {
    label: "authorization",
    stem: String.raw`(?:un|pre|re|non)?authori[sz](?:e|ed|es|ing|ation|ations)?(?:_\w*)?`,
  },
  { label: "OAuth", stem: String.raw`oauth2?` },
  { label: "JWT", stem: String.raw`jwt` },
  { label: "ACL", stem: String.raw`acl` },
  { label: "RBAC", stem: String.raw`rbac` },
  { label: "role", stem: String.raw`roles?`, requires: ["role-based", "rbac", "admin"] },
  { label: "session", stem: String.raw`sessions?` },
  { label: "login", stem: String.raw`login` },
  { label: "signing key", stem: String.raw`signing[ _-]?keys?` },
  { label: "private key", stem: String.raw`private[ _-]?keys?` },
  { label: "secret", stem: String.raw`secret\w*` },
  { label: "permission", stem: String.raw`permissions?` },
  { label: "credential", stem: String.raw`credential\w*` },
  {
    label: "token",
    stem: String.raw`token\w*`,
    requires: ["api", "access", "auth", "bearer", "refresh"],
  },
  { label: "API key", stem: String.raw`api[ _-]?keys?\w*` },
  { label: "password", stem: String.raw`password\w*` },
  { label: "passwd", stem: String.raw`passwd` },
  { label: "encryption", stem: String.raw`(?:un|pre|re|non)?(?:en|de)crypt\w*` },
  { label: "TLS", stem: String.raw`tls` },
  { label: "certificate", stem: String.raw`certificates?` },
  { label: "cert", stem: String.raw`certs?` },
  { label: "crypto", stem: String.raw`crypto\w*` },
  {
    label: "input validation",
    stem: String.raw`(?:un|pre|re|non)?(?:sanitiz\w*|validat\w*)`,
    requires: ["input", "request", "payload"],
  },
  {
    label: "injection",
    stem: String.raw`inject\w*`,
    requires: ["sql", "command", "prompt", "script", "header"],
  },
  { label: "sandbox", stem: String.raw`sandbox\w*` },
  { label: "privilege", stem: String.raw`privilege\w*` },
  { label: "access control", stem: String.raw`access[ _-]control` },
  {
    label: "deletion",
    stem: String.raw`delet\w*`,
    requires: ["data", "user", "account", "hard"],
  },
  { label: "data loss", stem: String.raw`data[ _-]loss` },
  { label: "CSRF", stem: String.raw`csrf` },
  { label: "CORS", stem: String.raw`cors` },
  { label: "SSRF", stem: String.raw`ssrf` },
  { label: "XSS", stem: String.raw`xss` },
  {
    label: "cookie",
    stem: String.raw`cookies?`,
    requires: ["session", "secure", "httponly", "samesite", "auth", "signed"],
  },
  {
    label: "allowlist",
    stem: String.raw`allow[ _-]?list`,
    requires: ["ip", "origin", "origins", "host", "domain", "redirect", "url", "egress"],
  },
];

interface CompiledTerm {
  readonly term: SecurityTerm;
  readonly stem: RegExp;
  readonly coWords: RegExp | undefined;
}

const COMPILED_TERMS: readonly CompiledTerm[] = SECURITY_CLASS_TERMS.map((term) => ({
  term,
  stem: new RegExp(`\\b(?:${term.stem})\\b`, "i"),
  coWords: term.requires
    ? new RegExp(`(?<![a-z0-9])(?:${term.requires.join("|")})(?![a-z0-9])`, "i")
    : undefined,
}));

/** The first security term the text matches, or undefined when the text is outside the class. */
export function matchSecurityTerm(text: string): SecurityTerm | undefined {
  return COMPILED_TERMS.find(
    (c) => c.stem.test(text) && (c.coWords === undefined || c.coWords.test(text)),
  )?.term;
}
