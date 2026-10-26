/**
 * work-driver-verify-credential-screen — #1841 round 2: the credential veto a
 * verify-evidence line passes BEFORE it is stored, and the one shared tail both
 * channels of the record run through.
 *
 * The defect. `work-driver-verify-record.ts` has two channels: the ASSERTION
 * channel, whose `push` vetoes a line through `extractSpecificAssertion` (which
 * carries `isNonAssertionLine`, the marker/echo/credential veto) and then
 * `redactThenBound`; and the `FAIL`-header DETAIL channel, which historically ran
 * only `isNonAssertionLine` + `redactThenBound` — no credential screen of its own
 * beyond the keyword-anchored `LOOKS_LIKE_SECRET`. So an unprefixed base64 PEM
 * body, a bare `Authorization: Basic <b64>`, or an `ssh-rsa AAAA…` blob printed
 * INDENTED under a `FAIL` header reached the corrective developer's prompt, the
 * `corrective-round` event's `evidenceLines` and the write-fence admission
 * evidence verbatim, while the very same line unindented is refused today —
 * because the unindented form is judged by the classifier, which the indented one
 * never was.
 *
 * Why one module for the arms. The tally harvest (`work-driver-verify-tally.ts`)
 * already owned a three-arm name veto (`nameLooksSecret`), and the base-run prose
 * (`work-driver-verify-base-confirm-prose.ts`) had to import it because a veto
 * that is one arm at one sink and three at another is the bug, not the arms. This
 * adds the arm neither carries — the post-redaction opaque-run test — and holds it
 * beside the two it reuses, so there is ONE answer to "could this line still be
 * credential material after the redactor had its turn". The fourth arm is the
 * classifier's own (`classifyFailureLine` → `isNonAssertionLine`), asked by the
 * harvest where it already runs.
 *
 * Why the opaque-run arm exists at all: `redactSecrets` is keyed on SHAPE WITH
 * CONTEXT (a prefix or a keyword to anchor on — see `secret-patterns.ts`), so a
 * bare base64 body with no `key=`/`token:`/`sk-` in front of it survives redaction
 * whole. Asking the question AFTER `redactThenBound` rather than before is
 * deliberate: a line the redactor already masked is a line whose credential the
 * patterns DID see, and it should not be dropped for having been masked.
 */

import { redactSecrets } from "./secret-patterns.ts";
import { looksLikeCredential } from "./work-driver-verify-assertion.ts";
import { nameLooksSecret } from "./work-driver-verify-tally.ts";

/**
 * The shortest separator-free run of base64 alphabet that reads as a KEY BODY
 * rather than prose. 20 is below every base64 PEM/chunked body chunk and above
 * the longest run a real sentence carries (`check-lines`, `24639`, `24576`), so
 * the arm fires on a credential and not on the #1841 fixture's own numbers.
 */
export const OPAQUE_RUN_MIN = 20;

/** base64 alphabet, plus `=` which only ever pads — so a run of it is a redaction fill. */
const OPAQUE_RUN_RE = /[A-Za-z0-9+/=]{20,}/;

/**
 * True when `line`, as it would be STORED, still carries a run of 20+ base64
 * characters. Asked on the redacted text, so a masked span (`[REDACTED]`, a run of
 * `*`) is not itself a refusal: the line is refused only when something the
 * redactor did not recognise still looks like key material.
 */
export function carriesOpaqueRun(line: string): boolean {
  return OPAQUE_RUN_RE.test(redactSecrets(line).text);
}

/**
 * The credential screen every verify-evidence line passes before it is stored.
 *
 * Three arms, each covering a shape the others cannot:
 *   - `looksLikeCredential` — the keyword-anchored shape (`password=…`, `token: …`);
 *   - `nameLooksSecret` — the tally's three-arm veto (the keyword shape, a digest
 *     or key-body run, or anything `redactSecrets` would rewrite);
 *   - {@link carriesOpaqueRun} — the post-redaction opaque run, which is what
 *     catches an unprefixed base64 blob no keyword anchors on.
 */
export function detailLooksCredential(line: string): boolean {
  return looksLikeCredential(line) || nameLooksSecret(line) || carriesOpaqueRun(line);
}
