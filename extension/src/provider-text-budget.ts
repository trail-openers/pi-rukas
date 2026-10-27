/**
 * provider-text-budget — the ONE budget a provider's own error body is stored
 * at (#1798 round 5).
 *
 * A leaf with no imports, deliberately: the value is needed both at the WRITE
 * site (`work-driver-completion-event.ts::boundedProviderText`, which puts the
 * provider's words into the durable state file) and at the RENDER site
 * (`headless/failure.ts`, which prints them to a host). Before it was shared,
 * the writer clipped at `FAILURE_REASON_CHARS` (240) while the renderer clipped
 * at 1000, and the store was the tighter of the two — which is the wrong way
 * round (see `test-commit-pr-verify-evidence-1064.ts`: a store bound below a
 * render bound silently truncates what the operator is owed).
 *
 * Why the store needs the LOOSER number, concretely: classification does not
 * happen at write time. It happens later, when the step router runs
 * `classifyFailureCause` over the STORED `providerMessage`, matching the spend
 * cap / quota window regexes anywhere in it. At 240 characters a real 429 —
 * gateway prefix, request id, then the terminal phrase — lost the phrase and
 * flipped from `rate-limited:quota-terminal` to `rate-limited:429`, so
 * `isSystemicFailure` let the remaining queue groups start into the same cap.
 *
 * The composite `errorTail` keeps its own bound (`clip`, i.e.
 * `FAILURE_REASON_CHARS`), because that field is a one-line scrollback
 * sentence, not the evidence the classifier reads.
 */
export const PROVIDER_MAX = 1000;
