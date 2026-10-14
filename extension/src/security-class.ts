/**
 * security-class — the security class of CRITICAL open points (#1151).
 *
 * An unresolved CRITICAL open point whose text matches one of these terms parks
 * the cycle as `security-open-point`: the driver will not choose that policy for
 * the resolver. open-points-contract.ts holds the heading and severity constants;
 * this module holds the class itself, so the term list is read in one place.
 * A stem matches only as a whole identifier segment: letters and digits bound it,
 * while `_`, `-`, `.` and spaces do not, so `db_password` and `client_secret` match.
 *
 * The rule: a bare security stem parks. An ambiguous stem (one that is also ordinary
 * engineering vocabulary, e.g. "injection" in "dependency injection") carries an
 * `excludes` list of phrases that contain the stem; the stem parks on its own UNLESS
 * it survives removal of those phrases. A few non-security stems (hash, nonce) carry
 * a `requires` list instead: they park only alongside a security word. Excludes are
 * deliberately short and named, so a new ordinary phrase is an explicit edit here,
 * not a silent widening of the class. A security point missed is worse than an
 * ordinary one that parks, and a park clears with [RESOLVED] and --restart.
 */

/**
 * One family of the security class. `stem` is a regex body matched as a whole
 * segment, case-insensitively.
 * - `requires`: the term matches only if one of these co-words also appears in the
 *   bullet (whole-word, case-insensitive). For non-security stems that need a
 *   security word (hash, nonce).
 * - `excludes`: each phrase is a regex body that contains the stem and names an
 *   ordinary use of it. Every occurrence is removed from the bullet before the stem
 *   is tested, so a security word elsewhere in the bullet still parks. `[ _-]` stands
 *   for a space, underscore or hyphen between words.
 */
export interface SecurityTerm {
  readonly label: string;
  readonly stem: string;
  readonly requires?: readonly string[];
  readonly excludes?: readonly string[];
}

/**
 * Words that name a decision the driver must not make on the resolver's behalf.
 * An unresolved CRITICAL point touching one of these parks rather than proceeds.
 * The first matching term names the point.
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
    excludes: [
      "role[ _-]in[ _-]the[ _-]pipeline",
      "reviewer[ _-]role",
      "role[ _-]of[ _-]the",
      "plays[ _-]a[ _-]role",
    ],
  },
  {
    label: "session",
    stem: String.raw`sessions?`,
    excludes: ["session[ _-]store", "test[ _-]session", "session[ _-]state", "repl[ _-]session"],
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
    excludes: [
      String.raw`tokeni[sz]\w*`,
      String.raw`tokens?[ _-](?:count|budget|limit|usage)`,
      String.raw`tokens?[ _-](?:in|of)[ _-](?:the[ _-])?context[ _-]window`,
    ],
  },
  { label: "API key", stem: String.raw`api[ _-]?keys?\w*` },
  {
    label: "password hashing",
    stem: String.raw`bcrypt|scrypt|argon2`,
  },
  {
    label: "password hashing",
    stem: String.raw`hash(?:es|ed|ing)?`,
    requires: ["passwords?", "passwd", "credentials?"],
  },
  { label: "password", stem: String.raw`password\w*` },
  { label: "passwd", stem: String.raw`passwd` },
  {
    label: "encryption",
    stem: String.raw`(?:un|pre|re|non)?(?:en|de)crypt\w*`,
  },
  { label: "TLS", stem: String.raw`tls` },
  { label: "TLS", stem: String.raw`ssl` },
  { label: "HMAC", stem: String.raw`hmac\w*` },
  {
    label: "nonce",
    stem: String.raw`nonces?`,
    requires: ["replay", "csrf", "auth", "token", "crypto"],
  },
  { label: "firewall", stem: String.raw`firewalls?` },
  { label: "certificate", stem: String.raw`certificates?` },
  { label: "cert", stem: String.raw`certs?` },
  { label: "crypto", stem: String.raw`crypto\w*` },
  { label: "input validation", stem: String.raw`(?:un|pre|re|non)?sanitiz\w*` },
  {
    label: "input validation",
    stem: String.raw`(?:un|pre|re|non)?validat\w*`,
    excludes: [
      String.raw`config[ _-]validat\w*`,
      String.raw`validate[ _-]step`,
      String.raw`schema[ _-]version[ _-]validat\w*`,
    ],
  },
  {
    label: "injection",
    stem: String.raw`inject\w*`,
    excludes: [String.raw`(?:dependency|constructor|property|setter|DI)[ _-]injection`],
  },
  {
    label: "sandbox",
    stem: String.raw`sandbox\w*`,
    excludes: [
      String.raw`sandbox[ _-]feature[ _-]flags?`,
      String.raw`test[ _-]sandbox`,
      String.raw`sandbox[ _-]environment[ _-]for[ _-]tests`,
    ],
  },
  { label: "privilege", stem: String.raw`privilege\w*` },
  { label: "access control", stem: String.raw`access[ _-]control` },
  {
    label: "deletion",
    stem: String.raw`delet\w*`,
    excludes: [
      // A cache/temp modifier, one or two cache/temp nouns, then the verb:
      // `stale cache entries are deleted`. A customer or user noun is not listed, so
      // `temporary customer records are deleted` parks.
      String.raw`(?:stale|cached?|temp(?:orary)?|scratch)[ _-](?:(?:cache|cached|entries|entry|files?|dirs?|directories|directory|artifacts?|copies|outputs?|worktrees?|branch(?:es)?)[ _-]){1,2}(?:(?:is|are|be)[ _-])?delet\w*`,
      String.raw`(?:worktrees?|branch(?:es)?)[ _-](?:(?:is|are|be)[ _-])?delet\w*`,
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
  { label: "MFA", stem: String.raw`mfa` },
  { label: "2FA", stem: String.raw`2fa` },
  { label: "OTP", stem: String.raw`otp` },
  { label: "passcode", stem: String.raw`passcodes?` },
  { label: "SSO", stem: String.raw`sso` },
  { label: "SAML", stem: String.raw`saml` },
  { label: "OIDC", stem: String.raw`oidc` },
  { label: "path traversal", stem: String.raw`(?:path[ _-]?)?traversal\w*` },
  { label: "deserialization", stem: String.raw`deserializ\w*` },
  {
    label: "eval",
    stem: String.raw`eval`,
    requires: ["untrusted", "user", "input", "code", "string"],
  },
  { label: "sudo", stem: String.raw`sudo` },
  { label: "setuid", stem: String.raw`setuid` },
  { label: "PII", stem: String.raw`pii` },
  { label: "privacy", stem: String.raw`privacy` },
];

/** Distinct security-class labels in declaration order: the list explainPark names. */
export const SECURITY_CLASS_LABELS: readonly string[] = [
  ...new Set(SECURITY_CLASS_TERMS.map((term) => term.label)),
];

interface CompiledTerm {
  readonly term: SecurityTerm;
  readonly stem: RegExp;
  readonly coWords: RegExp | undefined;
  readonly excludeRe: RegExp | undefined;
}

/** A whole-word alternation over `words`, as regex bodies. */
function wordsRe(words: readonly string[]): RegExp {
  return new RegExp(`(?<![a-z0-9])(?:${words.join("|")})(?![a-z0-9])`, "i");
}

/** Every exclude phrase as one global whole-segment alternation: each occurrence is removed. */
function phraseRe(phrases: readonly string[]): RegExp {
  return new RegExp(`(?<![a-z0-9])(?:${phrases.join("|")})(?![a-z0-9])`, "gi");
}

const COMPILED_TERMS: readonly CompiledTerm[] = SECURITY_CLASS_TERMS.map((term) => ({
  term,
  stem: new RegExp(`(?<![a-z0-9])(?:${term.stem})(?![a-z0-9])`, "i"),
  coWords: term.requires ? wordsRe(term.requires) : undefined,
  excludeRe: term.excludes ? phraseRe(term.excludes) : undefined,
}));

/** The first security term the text matches, or undefined when the text is outside the class. */
export function matchSecurityTerm(text: string): SecurityTerm | undefined {
  return COMPILED_TERMS.find((c) => {
    // Each exclude phrase is removed where it occurs; the stem must survive the removal.
    const remainder = c.excludeRe ? text.replace(c.excludeRe, " ") : text;
    return c.stem.test(remainder) && (c.coWords === undefined || c.coWords.test(text));
  })?.term;
}
