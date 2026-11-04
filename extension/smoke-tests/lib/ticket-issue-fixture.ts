/**
 * lib/ticket-issue-fixture — the one issue text both ticket-aware-review files
 * assert against.
 *
 * Split from the two test files (AGENTS.md §12). The body STATES a constraint on
 * purpose: a body that says nothing cannot show that a body was read, and every
 * assertion in those files is "the child's brief contains this sentence".
 * `CONSTRAINT` is the sentence a reviewer could plausibly object to — rewording
 * a fixed exception message — which is the exact finding that drove the original
 * fixer to contradict the ticket.
 */

/** The requirement a reviewer would plausibly try to "improve". */
export const CONSTRAINT = 'The exception message must remain exactly "quota exceeded".';

export const ISSUE_BODY = `Add a quota check to the meter.

## Acceptance criteria
- ${CONSTRAINT}
- The check runs before the draw.

## Test surface
- extension/smoke-tests/test-meter-quota.ts (new)`;

/** Past `MAX_ISSUE_CHARS`: a long filler run, then the constraint at the tail,
 * so an assertion on the constraint also proves the bound kept the part that
 * matters. */
export const OVER_BODY = `${"filler word ".repeat(700)}\n${CONSTRAINT}`;
