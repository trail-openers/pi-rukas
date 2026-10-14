#!/usr/bin/env bun
/**
 * The security class of CRITICAL open points, term by term.
 *
 * Every term in SECURITY_CLASS_TERMS (security-class.ts) has a parking
 * canary. A term with co-words also has a benign canary: the same stem without
 * its co-word, which must proceed. The ordinary engineering phrases the class
 * once over-matched must proceed too.
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

/** The verdict the gate gives a filed issue whose one CRITICAL point is `point`. */
function gateOf(point: string): NormalisedSpec {
  return finaliseSpecVerdict(
    spec(),
    `## Open points (unresolved at the gap-gate cap)\n\n- [CRITICAL] ${point}\n`,
  );
}

const parks = (point: string) => gateOf(point).parkReason === "security-open-point";

// Parking canaries: one per term, phrased with a co-word where the term needs one.
const parkingCanaries: Array<[string, string]> = [
  ["authentication", "Who may call the endpoint \u2014 authentication is undecided"],
  ["authorization", "Which role may export data \u2014 authorization is undecided"],
  ["auth", "Whether auth is required on the retry endpoint \u2014 proposal: yes"],
  ["OAuth", "OAuth2 scopes for the webhook \u2014 proposal: read-only"],
  ["JWT", "JWT expiry for the worker \u2014 proposal: 15 minutes"],
  ["ACL", "ACL for the bucket \u2014 proposal: private"],
  ["RBAC", "RBAC mapping for reviewers \u2014 proposal: maintainer"],
  ["role (admin)", "Which admin role may rotate keys \u2014 proposal: owners"],
  ["role (role-based)", "Whether role-based access applies \u2014 proposal: yes"],
  ["session", "How long a session stays valid \u2014 proposal: 1 hour"],
  ["login", "Whether login is rate limited \u2014 proposal: yes"],
  ["signing key", "Where the signing key is stored \u2014 proposal: KMS"],
  ["private key", "Whether the private key is rotated \u2014 proposal: yearly"],
  ["secret", "Where the secrets live \u2014 proposal: env var"],
  ["permission", "What permissions the worker needs on the bucket"],
  ["credential", "Where the credential is read from \u2014 proposal: env"],
  ["token (api)", "Which api token lifetime applies \u2014 proposal: one hour"],
  ["token (bearer)", "Which bearer token format is accepted \u2014 proposal: opaque"],
  ["API key", "Whether the api key rotates \u2014 proposal: monthly"],
  ["password", "Whether the password is hashed \u2014 proposal: bcrypt"],
  ["passwd", "Whether reads of /etc/passwd are blocked \u2014 proposal: yes"],
  ["encryption", "Whether the payload is encrypted at rest \u2014 proposal: yes"],
  ["TLS", "Whether the TLS config is pinned \u2014 proposal: yes"],
  ["certificate", "Which certificate chain is trusted \u2014 proposal: system store"],
  ["cert", "Which certs the worker presents \u2014 proposal: client cert"],
  ["crypto", "Which crypto library to use \u2014 proposal: node:crypto"],
  ["input validation (input)", "Whether input validation is strict \u2014 proposal: strict"],
  ["input validation (request)", "Whether request validation runs first \u2014 proposal: yes"],
  ["input validation (payload)", "Whether payload sanitization is applied \u2014 proposal: yes"],
  ["injection (SQL)", "Whether SQL injection is guarded \u2014 proposal: parameterize"],
  ["injection (command)", "Whether command injection is possible \u2014 proposal: no"],
  ["injection (prompt)", "Whether prompt injection is guarded \u2014 proposal: yes"],
  ["injection (script)", "Whether script injection is blocked \u2014 proposal: yes"],
  ["injection (header)", "Whether header injection is blocked \u2014 proposal: yes"],
  ["sandbox", "Whether the sandbox is enabled for the child \u2014 proposal: yes"],
  ["privilege", "Which privilege level the worker runs at \u2014 proposal: least"],
  ["access control", "Who is covered by the access control list \u2014 proposal: admins"],
  ["deletion (data)", "Whether data deletion is soft \u2014 proposal: soft"],
  ["deletion (user)", "Whether a user deletion removes sessions \u2014 proposal: yes"],
  ["deletion (hard)", "Whether a hard delete of the record is allowed \u2014 proposal: no"],
  ["data loss", "Whether this risks data loss on rollback \u2014 proposal: none"],
  ["CSRF", "Whether the CSRF check guards the form \u2014 proposal: yes"],
  ["CORS", "Which CORS origins are allowed \u2014 proposal: the console only"],
  ["SSRF", "Whether the webhook fetcher blocks SSRF \u2014 proposal: yes"],
  ["XSS", "Whether the comment renderer escapes XSS \u2014 proposal: yes"],
  ["cookie", "Which session cookie flags apply \u2014 proposal: HttpOnly"],
  ["cookie (secure)", "Whether the cookie is marked secure \u2014 proposal: yes"],
  ["allowlist", "Which origins go on the allowlist \u2014 proposal: the console"],
  ["allowlist (host)", "Which host allow list the proxy uses \u2014 proposal: one host"],
  // Original #1151 canaries, restored (#1171): their co-words were widened, not dropped.
  ["token (lifetime)", "Which token lifetime applies \u2014 proposal: one hour"],
  ["session (validity)", "How long a session stays valid \u2014 proposal: 1 hour"],
  ["role (rotate)", "which role may rotate keys \u2014 proposal: admins"],
  ["deletion (records)", "Whether records are deleted or soft-deleted \u2014 proposal: soft"],
  ["validation (schema)", "Whether schema validation is strict \u2014 proposal: strict"],
  ["sandbox (enabled)", "Whether the sandbox is enabled for the child \u2014 proposal: yes"],
  ["sanitize", "Whether input is sanitized before logging \u2014 proposal: yes"],
  ["injection (nosql)", "Whether nosql injection is guarded \u2014 proposal: yes"],
];

for (const [label, point] of parkingCanaries) {
  assert(parks(point), `parks: ${label}`);
}

// Benign canaries: the ambiguous stem without its co-word proceeds.
const benignCanaries: Array<[string, string]> = [
  ["token (tokenizer)", "tokenizer output format \u2014 proposal: JSON"],
  ["role (review)", "which role reviews the PR \u2014 proposal: maintainer"],
  [
    "injection (dependency)",
    "constructor/dependency injection \u2014 proposal: pass the client in",
  ],
  ["validation (config)", "config validate step \u2014 proposal: run it before the build"],
  ["deletion (cache)", "stale cache entries are deleted \u2014 proposal: keep them"],
  ["cookie (banner)", "cookie banner copy \u2014 proposal: keep the current wording"],
  [
    "allowlist (formatter)",
    "allowlist of file extensions for the formatter \u2014 proposal: .ts only",
  ],
  ["sandbox (feature flag)", "sandbox feature flag \u2014 proposal: keep it off by default"],
  ["session (store)", "the session store is per-cycle \u2014 proposal: keep it"],
];

for (const [label, point] of benignCanaries) {
  assert(!parks(point), `benign (no park): ${label}`);
}

// The term list is the whole class: every term has a parking canary above.
for (const term of SECURITY_CLASS_TERMS) {
  const covered = parkingCanaries.some(([, point]) => matchSecurityTerm(point)?.stem === term.stem);
  assert(covered, `every term has a parking canary: ${term.label} (${term.stem})`);
}

// A term with co-words does not match on the stem alone.
assert(
  matchSecurityTerm("tokenizer output") === undefined,
  "a co-word term does not match its bare stem",
);

// ----------------------------------- authorization class canaries (#1151 widened)
// (#1171: each canary below parks; the full label list is checked in test-intent-open-point-edges.ts.)

{
  // One canary per widened class: each CRITICAL point touching it parks.
  const classes: Array<[string, string]> = [
    ["credential", "Where the credential is read from \u2014 proposal: env"],
    ["token", "Which token lifetime applies \u2014 proposal: one hour"],
    ["token (api)", "Which api token lifetime applies \u2014 proposal: one hour"],
    ["api key", "Whether the api key rotates \u2014 proposal: monthly"],
    ["password", "Whether the password is hashed \u2014 proposal: bcrypt"],
    ["encrypt", "Whether the payload is encrypted at rest \u2014 proposal: yes"],
    ["decrypt", "Who may decrypt the export \u2014 proposal: the owner"],
    ["tls", "Whether the TLS config is pinned \u2014 proposal: yes"],
    ["certificate", "Which certificate chain is trusted \u2014 proposal: system store"],
    ["crypto", "Which crypto library to use \u2014 proposal: node:crypto"],
    ["sanitize", "Whether input is sanitized before logging \u2014 proposal: yes"],
    ["validate", "Whether schema validation is strict \u2014 proposal: strict"],
    ["validate (request)", "Whether request validation is strict \u2014 proposal: strict"],
    ["inject", "Whether prompt injection is guarded \u2014 proposal: yes"],
    ["sandbox", "Whether the sandbox is enabled for the child \u2014 proposal: yes"],
    ["privilege", "Which privilege level the worker runs at \u2014 proposal: least"],
    ["access control", "Who is covered by the access control list \u2014 proposal: admins"],
    ["delete", "Whether records are deleted or soft-deleted \u2014 proposal: soft"],
    ["delete (user)", "Whether user records are deleted or soft-deleted \u2014 proposal: soft"],
    ["data loss", "Whether this risks data loss on rollback \u2014 proposal: none"],
    ["secret", "Where the secrets live \u2014 proposal: env var"],
    ["auth", "Whether auth is required on the retry endpoint \u2014 proposal: yes"],
    ["oauth", "OAuth scopes for the webhook \u2014 proposal: read-only"],
    ["jwt", "JWT expiry for the worker \u2014 proposal: 15 minutes"],
    ["acl", "ACL for the bucket \u2014 proposal: private"],
    ["rbac", "RBAC mapping for reviewers \u2014 proposal: maintainer"],
    ["role", "which role may rotate keys \u2014 proposal: admins"],
    ["role (admin)", "which admin role may rotate keys \u2014 proposal: admins"],
    ["session", "How long a session stays valid \u2014 proposal: 1 hour"],
    ["login", "Whether login is rate limited \u2014 proposal: yes"],
    ["signing key", "Where the signing key is stored \u2014 proposal: KMS"],
    ["private key", "Whether the private key is rotated \u2014 proposal: yearly"],
  ];
  for (const [cls, point] of classes) {
    const resolved = gateOf(point);
    assert(
      resolved.verdict === "park" && resolved.parkReason === "security-open-point",
      `canary: a ${cls} open point parks as security-open-point`,
    );
  }
  // Non-security CRITICAL points are still carried as assumptions, not parked.
  const perProvider = gateOf("Whether the retry ceiling is per-provider \u2014 proposal: global");
  assert(
    perProvider.verdict === "proceed-with-assumptions",
    "canary: a non-security CRITICAL point caps proceed to proceed-with-assumptions",
  );
}

process.exit(exit);
