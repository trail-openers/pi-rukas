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
import { hasOpaqueRun, nameLooksSecret } from "./work-driver-verify-tally.ts";

/**
 * The shortest separator-free run of base64 alphabet that reads as a KEY BODY
 * rather than prose. 20 is below every base64 PEM/chunked body chunk and above
 * the longest run a real sentence carries (`check-lines`, `24639`, `24576`), so
 * the arm fires on a credential and not on the #1841 fixture's own numbers.
 */
export const OPAQUE_RUN_MIN = 20;

/** Padding carries no alphabetic character: a run of it is a redaction fill, not a key. */
const PADDING_ONLY_RE = /^=+$/;

/**
 * How a line is split into candidate runs. `=` is a SEPARATOR here: the redactor's
 * own fill is a run of `=`, and no key body needs a `=` to be recognised — every
 * other base64 character is still inside the run it belongs to.
 */
const RUN_SPLIT_RE = /[^A-Za-z0-9+/]+/;

/**
 * True when `line` carries a separator-free run of {@link OPAQUE_RUN_MIN}+ base64
 * characters that reads as key material.
 *
 * The run rule is ONE rule, asked per separator-free RUN — `hasOpaqueRun` from
 * `work-driver-verify-tally.ts`, its own conjunction, its own minimum. A second copy
 * of "a long run is opaque" is a second rule that drifts, and #1841 round 4 is
 * precisely what drift looks like: this module used to test ONE WHOLE LINE against a
 * single `{20,}` regex, so a gate line that merely cited a path
 * (`see /home/dev/work/src/some/really/long/path/name/index.tsx`) came back refused —
 * punctuation the sentence joined is one long span to a whole-line test, and every
 * run inside it is prose. An arm that fires on prose is an arm that gets switched
 * off, which is how a credential screen dies. The tally's rule was already run-wise
 * for exactly that reason; the two now cannot disagree.
 *
 * The two differences that remain are deliberate and both make THIS arm narrower,
 * because a verify-evidence line is prose while a tally name is a path:
 *   - a run of pure `=` padding is never opaque — the redactor's own fill is a run
 *     of `=` and must not be a refusal;
 *   - `OPAQUE_RUN_MIN` is this module's own bound, sized to evidence prose.
 *
 * Asked on the redacted text, so a masked span (`[REDACTED]`, a run of `*`) is not
 * itself a refusal: the line is refused only when something the redactor did not
 * recognise still looks like key material.
 */
export function carriesOpaqueRun(line: string): boolean {
  return redactSecrets(line)
    .text.split(RUN_SPLIT_RE)
    .some((run) => !PADDING_ONLY_RE.test(run) && hasOpaqueRun(run, OPAQUE_RUN_MIN));
}

/**
 * The credential screen every verify-evidence line passes before it is stored.
 *
 * Two arms, each covering a shape the other cannot:
 *   - `nameLooksSecret` — the tally's three-arm veto, whose first arm IS
 *     `looksLikeCredential` (the keyword shape, `password=…`, `token: …`), plus a
 *     digest or key-body run, or anything `redactSecrets` would rewrite. The
 *     keyword arm is not asked again here: a third call to a predicate one of the
 *     others already calls is a third place its shape can change;
 *   - {@link carriesOpaqueRun} — the post-redaction opaque run, which is what
 *     catches an unprefixed base64 blob no keyword anchors on.
 *
 * BOTH channels of the record ask this one (#1841 round 4): the `FAIL`-header DETAIL
 * channel through {@link harvestHeaderDetails}, the ASSERTION channel through
 * `guardedPush`'s veto in `work-driver-verify-record.ts`. "Could this line still be
 * credential material" is ONE question, and a veto the indented route asks while the
 * unindented one does not is the module's own defect mirrored.
 */
export function detailLooksCredential(line: string): boolean {
  return nameLooksSecret(line) || carriesOpaqueRun(line);
}
