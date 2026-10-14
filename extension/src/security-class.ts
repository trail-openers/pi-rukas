/**
 * security-class — the security class of CRITICAL open points (#1151, #1171).
 *
 * An unresolved CRITICAL open point whose text matches one of these terms parks
 * the cycle as `security-open-point`: the driver will not choose that policy for
 * the resolver. open-points-contract.ts holds the heading and severity constants;
 * this module holds the class itself, so the term list is read in one place.
 *
 * Ambiguous stems carry co-words so ordinary engineering wording ("dependency
 * injection", "config validate step", "which role reviews the PR", "tokenizer
 * output", "stale cache entries are deleted") does not park. Co-words are widened
 * on purpose: a security point missed is worse than an ordinary one that parks,
 * and a park clears with [RESOLVED] and --restart.
 */

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
 * Words that name a decision the driver must not make on the resolver's behalf.
 * An unresolved CRITICAL point touching one of these parks rather than proceeds.
 * (#1171: the list lives in this module; the first matching term names the point.)
 */
export const SECURITY_CLASS_TERMS: readonly SecurityTerm[] = [
  {
    label: "authentication",
    stem: String.raw`(?:un|pre|re|non)?auth(?:n|z|s)?(?:_\w*)?|(?:un|pre|re|non)?authenticat\w*`,
  },
  {
    label: "authorization",
    stem: String.raw`(?:un|pre|re|non)?authori[sz](?:e|ed|es|ing|ation|ations)?(?:_\w*)?`,
  },
  { label: "OAuth", stem: String.raw`oauth2?` },
  { label: "JWT", stem: String.raw`jwt` },
  { label: "ACL", stem: String.raw`acl` },
  { label: "RBAC", stem: String.raw`rbac` },
  {
    label: "role",
    stem: String.raw`roles?`,
    requires: [
      "role-based",
      "rbac",
      "admin",
      "rotate",
      "grant",
      "assign",
      "access",
      "permission",
      "privilege",
    ],
  },
  {
    label: "session",
    stem: String.raw`sessions?`,
    requires: [
      "auth",
      "login",
      "cookie",
      "token",
      "hijack",
      "fixation",
      "expiry",
      "timeout",
      "valid",
      "validity",
      "lifetime",
      "expire",
      "expires",
      "expired",
      "expiration",
      "revoke",
      "revoked",
      "idle",
    ],
  },
  { label: "login", stem: String.raw`login` },
  { label: "signing key", stem: String.raw`signing[ _-]?keys?` },
  { label: "private key", stem: String.raw`private[ _-]?keys?` },
  { label: "secret", stem: String.raw`secret\w*` },
  { label: "permission", stem: String.raw`permissions?` },
  { label: "credential", stem: String.raw`credential\w*` },
  {
    label: "token",
    stem: String.raw`token\w*`,
    requires: [
      "api",
      "access",
      "auth",
      "bearer",
      "refresh",
      "jwt",
      "session",
      "csrf",
      "secret",
      "oauth",
      "lifetime",
      "expiry",
      "expiration",
      "expire",
      "expires",
      "expired",
      "ttl",
      "revoke",
      "revoked",
      "rotate",
      "issued",
    ],
  },
  { label: "API key", stem: String.raw`api[ _-]?keys?\w*` },
  { label: "password", stem: String.raw`password\w*` },
  { label: "passwd", stem: String.raw`passwd` },
  {
    label: "encryption",
    stem: String.raw`(?:un|pre|re|non)?(?:en|de)crypt\w*`,
  },
  { label: "TLS", stem: String.raw`tls` },
  { label: "certificate", stem: String.raw`certificates?` },
  { label: "cert", stem: String.raw`certs?` },
  { label: "crypto", stem: String.raw`crypto\w*` },
  { label: "input validation", stem: String.raw`(?:un|pre|re|non)?sanitiz\w*` },
  {
    label: "input validation",
    stem: String.raw`(?:un|pre|re|non)?validat\w*`,
    requires: ["input", "request", "payload", "schema", "untrusted", "user", "external"],
  },
  {
    label: "injection",
    stem: String.raw`inject\w*`,
    requires: [
      "sql",
      "nosql",
      "command",
      "ldap",
      "xpath",
      "os",
      "shell",
      "template",
      "code",
      "prompt",
      "script",
      "header",
    ],
  },
  {
    label: "sandbox",
    stem: String.raw`sandbox\w*`,
    requires: [
      "escape",
      "isolation",
      "untrusted",
      "container",
      "jail",
      "breakout",
      "enabled",
      "enable",
      "disabled",
      "disable",
      "child",
    ],
  },
  { label: "privilege", stem: String.raw`privilege\w*` },
  { label: "access control", stem: String.raw`access[ _-]control` },
  {
    label: "deletion",
    stem: String.raw`delet\w*`,
    requires: [
      "data",
      "user",
      "account",
      "hard",
      "records",
      "rows",
      "production",
      "prod",
      "soft",
      "permanent",
      "purge",
    ],
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

/** Distinct security-class labels in declaration order: the list explainPark names (#1171). */
export const SECURITY_CLASS_LABELS: readonly string[] = [
  ...new Set(SECURITY_CLASS_TERMS.map((term) => term.label)),
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
