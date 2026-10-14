#!/usr/bin/env bun
/**
 * The security class of CRITICAL open points, term by term.
 *
 * Every term in SECURITY_CLASS_TERMS (security-class.ts) has a parking canary.
 * A term with co-words also has a benign canary that matches its stem without
 * any co-word and must proceed; that is checked mechanically below. Identifiers
 * such as `db_password` park because `_` is not a letter or digit, and the
 * ordinary engineering phrases the class once over-matched must proceed too.
 */

import { SECURITY_CLASS_TERMS, matchSecurityTerm } from "../src/security-class.ts";
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import type { NormalisedSpec } from "../src/work-driver-intent.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const spec = (over: Partial<NormalisedSpec> = {}): NormalisedSpec => ({
  intent: "Preserve the requested intent while applying the change.",
  deliverables: [{ id: "d1", description: "apply the requested change", paths: [] }],
  acceptanceCriteria: ["the requested behavior is preserved"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "proceed",
  rationale: "the requested change is actionable",
  ...over,
});

/** The filed issue whose Open points section holds the single CRITICAL line `point`. */
const issueWith = (point: string) =>
  `## Open points (unresolved at the gap-gate cap)\n\n- [CRITICAL] ${point}\n`;

const parks = (point: string) =>
  finaliseSpecVerdict(spec(), issueWith(point)).parkReason === "security-open-point";

// Parking canaries: one per term, phrased with a co-word where the term needs one.
const parkingCanaries: Array<[string, string]> = [
  ["authentication", "Who may call the endpoint \u2014 authentication is undecided"],
  ["authentication (retry)", "Who may call the retry endpoint \u2014 authentication is undecided"],
  ["authorization", "Which role may export data \u2014 authorization is undecided"],
  ["authorization (retry)", "Who may change the retry timeout \u2014 authorization is undecided"],
  ["authorization (rotate)", "Which role has authorization to rotate keys"],
  ["auth", "Whether auth is required on the retry endpoint \u2014 proposal: yes"],
  ["OAuth", "OAuth2 scopes for the webhook \u2014 proposal: read-only"],
  ["OAuth (scopes)", "OAuth scopes for the webhook \u2014 proposal: read-only"],
  ["JWT", "JWT expiry for the worker \u2014 proposal: 15 minutes"],
  ["ACL", "ACL for the bucket \u2014 proposal: private"],
  ["RBAC", "RBAC mapping for reviewers \u2014 proposal: maintainer"],
  ["role (admin)", "Which admin role may rotate keys \u2014 proposal: owners"],
  ["role (role-based)", "Whether role-based access applies \u2014 proposal: yes"],
  ["role (rotate)", "which role may rotate keys \u2014 proposal: admins"],
  ["session", "How long a session stays valid \u2014 proposal: 1 hour"],
  ["session (validity)", "How long a session stays valid \u2014 proposal: 1 hour"],
  ["login", "Whether login is rate limited \u2014 proposal: yes"],
  ["signing key", "Where the signing key is stored \u2014 proposal: KMS"],
  ["private key", "Whether the private key is rotated \u2014 proposal: yearly"],
  ["secret", "Where the secrets live \u2014 proposal: env var"],
  ["permission", "What permissions the worker needs on the bucket"],
  ["credential", "Where the credential is read from \u2014 proposal: env"],
  ["token (api)", "Which api token lifetime applies \u2014 proposal: one hour"],
  ["token (bearer)", "Which bearer token format is accepted \u2014 proposal: opaque"],
  ["token (lifetime)", "Which token lifetime applies \u2014 proposal: one hour"],
  ["API key", "Whether the api key rotates \u2014 proposal: monthly"],
  ["password", "Whether the password is hashed \u2014 proposal: bcrypt"],
  ["passwd", "Whether reads of /etc/passwd are blocked \u2014 proposal: yes"],
  ["password hashing (bcrypt)", "Which bcrypt cost factor is used \u2014 proposal: 12"],
  ["password hashing (argon2)", "Whether argon2 or scrypt is the KDF \u2014 proposal: argon2id"],
  ["password hashing (co-word)", "How the hashed password is stored \u2014 proposal: salted"],
  ["encryption", "Whether the payload is encrypted at rest \u2014 proposal: yes"],
  ["decrypt", "Who may decrypt the export \u2014 proposal: the owner"],
  ["TLS", "Whether the TLS config is pinned \u2014 proposal: yes"],
  ["TLS (ssl)", "Whether SSL is enforced on the proxy \u2014 proposal: yes"],
  ["HMAC", "Which HMAC key signs the webhook \u2014 proposal: per-tenant"],
  ["nonce (replay)", "Whether the replay nonce is single-use \u2014 proposal: yes"],
  ["firewall", "Which firewall rules open the port \u2014 proposal: none"],
  ["certificate", "Which certificate chain is trusted \u2014 proposal: system store"],
  ["cert", "Which certs the worker presents \u2014 proposal: client cert"],
  ["crypto", "Which crypto library to use \u2014 proposal: node:crypto"],
  ["input validation (input)", "Whether input validation is strict \u2014 proposal: strict"],
  ["input validation (request)", "Whether request validation runs first \u2014 proposal: yes"],
  ["input validation (payload)", "Whether payload sanitization is applied \u2014 proposal: yes"],
  ["validation (schema)", "Whether schema validation is strict \u2014 proposal: strict"],
  [
    "validation (request, reviewed)",
    "Whether request validation is strict \u2014 proposal: strict",
  ],
  ["sanitize", "Whether input is sanitized before logging \u2014 proposal: yes"],
  ["injection (SQL)", "Whether SQL injection is guarded \u2014 proposal: parameterize"],
  ["injection (command)", "Whether command injection is possible \u2014 proposal: no"],
  ["injection (prompt)", "Whether prompt injection is guarded \u2014 proposal: yes"],
  ["injection (script)", "Whether script injection is blocked \u2014 proposal: yes"],
  ["injection (header)", "Whether header injection is blocked \u2014 proposal: yes"],
  ["injection (nosql)", "Whether nosql injection is guarded \u2014 proposal: yes"],
  ["sandbox", "Whether the sandbox is enabled for the child \u2014 proposal: yes"],
  ["privilege", "Which privilege level the worker runs at \u2014 proposal: least"],
  ["access control", "Who is covered by the access control list \u2014 proposal: admins"],
  ["deletion (data)", "Whether data deletion is soft \u2014 proposal: soft"],
  ["deletion (user)", "Whether a user deletion removes sessions \u2014 proposal: yes"],
  ["deletion (hard)", "Whether a hard delete of the record is allowed \u2014 proposal: no"],
  ["deletion (records)", "Whether records are deleted or soft-deleted \u2014 proposal: soft"],
  ["data loss", "Whether this risks data loss on rollback \u2014 proposal: none"],
  ["CSRF", "Whether the CSRF check guards the form \u2014 proposal: yes"],
  ["CORS", "Which CORS origins are allowed \u2014 proposal: the console only"],
  ["SSRF", "Whether the webhook fetcher blocks SSRF \u2014 proposal: yes"],
  ["XSS", "Whether the comment renderer escapes XSS \u2014 proposal: yes"],
  ["cookie", "Which session cookie flags apply \u2014 proposal: HttpOnly"],
  ["cookie (secure)", "Whether the cookie is marked secure \u2014 proposal: yes"],
  ["allowlist", "Which origins go on the allowlist \u2014 proposal: the console"],
  ["allowlist (host)", "Which host allow list the proxy uses \u2014 proposal: one host"],
  // Identifiers: `_` bounds a stem, so these park (#1171 boundary).
  ["identifier db_password", "Where db_password is read from \u2014 proposal: env"],
  ["identifier client_secret", "Whether client_secret rotates \u2014 proposal: monthly"],
  ["identifier aws_credentials", "Which aws_credentials profile is used \u2014 proposal: CI role"],
  ["identifier enable_tls", "Whether enable_tls is forced \u2014 proposal: yes"],
  ["identifier use_jwt", "Whether use_jwt is required \u2014 proposal: yes"],
  ["identifier csrf_token", "Whether csrf_token is checked \u2014 proposal: yes"],
  ["identifier my_private_key", "Where my_private_key is stored \u2014 proposal: KMS"],
  // Origin canary phrasings, kept verbatim (#1151 authorization class).
  [
    "origin: endpoint authentication",
    "Who may call the endpoint \u2014 authentication is undecided",
  ],
  ["origin: API secrets", "Where the API secrets live \u2014 proposal: env var"],
  ["origin: validate (request)", "Whether request validation is strict \u2014 proposal: strict"],
  ["origin: inject", "Whether prompt injection is guarded \u2014 proposal: yes"],
  ["origin: delete", "Whether records are deleted or soft-deleted \u2014 proposal: soft"],
  ["origin: decrypt", "Who may decrypt the export \u2014 proposal: the owner"],
  ["origin: sanitize", "Whether input is sanitized before logging \u2014 proposal: yes"],
  ["origin: role", "which role may rotate keys \u2014 proposal: admins"],
];

for (const [label, point] of parkingCanaries) {
  assert(parks(point), `parks: ${label}`);
}

// Benign canaries: a stem without its co-word proceeds. `author` and `_`-joined
// words are checked here too: `auth` is a whole identifier segment, not a prefix.
const benignCanaries: Array<[string, string]> = [
  ["token (tokenizer)", "tokenizer output format \u2014 proposal: JSON"],
  ["role (review)", "which role reviews the PR \u2014 proposal: maintainer"],
  [
    "injection (dependency)",
    "constructor/dependency injection \u2014 proposal: pass the client in",
  ],
  ["validation (config)", "config validate step \u2014 proposal: run it before the build"],
  ["deletion (cache)", "stale cache entries are deleted \u2014 proposal: keep them"],
  ["deletion (temp file)", "the temp file is deleted after each run \u2014 proposal: keep it"],
  ["cookie (banner)", "cookie banner copy \u2014 proposal: keep the current wording"],
  [
    "allowlist (formatter)",
    "allowlist of file extensions for the formatter \u2014 proposal: .ts only",
  ],
  ["sandbox (feature flag)", "sandbox feature flag \u2014 proposal: keep it off by default"],
  ["session (store)", "the session store is per-cycle \u2014 proposal: keep it"],
  ["session (underscore store)", "session_store is per-cycle \u2014 proposal: keep it"],
  ["nonce (fixture name)", "nonce in the test fixture name \u2014 proposal: keep it"],
  ["hash (map lookup)", "hash map lookup \u2014 proposal: keep the current map"],
  ["auth (author)", "the issue author is listed in the body \u2014 proposal: keep it"],
  ["auth (author_name)", "author_name column is unused \u2014 proposal: keep it"],
];

for (const [label, point] of benignCanaries) {
  assert(!parks(point), `benign (no park): ${label}`);
}

// A non-security CRITICAL point is carried as an assumption, not parked.
assert(
  finaliseSpecVerdict(
    spec(),
    issueWith("Whether the retry ceiling is per-provider \u2014 proposal: global"),
  ).verdict === "proceed-with-assumptions",
  "canary: a non-security CRITICAL point caps proceed to proceed-with-assumptions",
);

// The term list is the whole class: every term has a parking canary above.
for (const term of SECURITY_CLASS_TERMS) {
  const covered = parkingCanaries.some(([, point]) => matchSecurityTerm(point)?.stem === term.stem);
  assert(covered, `every term has a parking canary: ${term.label} (${term.stem})`);
}

// Every term with co-words has a benign canary: its stem appears without any
// co-word, in a phrase that names no security term.
const stemRe = (stem: string) => new RegExp(`(?<![a-z0-9])(?:${stem})(?![a-z0-9])`, "i");
for (const term of SECURITY_CLASS_TERMS.filter((t) => t.requires)) {
  const covered = benignCanaries.some(
    ([, point]) => stemRe(term.stem).test(point) && matchSecurityTerm(point) === undefined,
  );
  assert(covered, `every co-word term has a benign canary: ${term.label} (${term.stem})`);
}

// A term with co-words does not match on the stem alone.
assert(
  matchSecurityTerm("tokenizer output") === undefined,
  "a co-word term does not match its bare stem",
);

process.exit(exit);
