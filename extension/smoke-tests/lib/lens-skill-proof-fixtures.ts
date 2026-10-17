/**
 * Shared fixtures for the `skillLoadProof` smoke tests (#995 / PR #1530).
 *
 * The proof suite is split across two `test-*.ts` files — the pure check and
 * the round-2 false-negative cases — both of which compare tool-call paths
 * against the SAME resolved skill path. AGENTS.md §12 keeps each file under
 * 500 lines, and duplicating the resolution across files would defeat the
 * point of having one canonical spelling.
 *
 * Intentionally NOT named `test-*.ts` — CI's smoke-tests glob must not
 * self-execute it (same shape as `lib/review-ledger-test-helpers.ts`).
 */

import { realpathSync } from "node:fs";

/** A skill path as a driver would build it (`path.join(skillsDir, lens.skill)`). */
const SKILL = "/tmp/skills/code-review-security";

/**
 * The same path in the spelling the check actually compares.
 *
 * The check compares EXACT whole paths, and macOS resolves `/tmp` to
 * `/private/tmp`, so a fixture written as a literal `/tmp/...` compares equal
 * to itself after normalisation whether or not the matching logic works — which
 * is how six of these cases were silently vacuous before this note. The
 * resolved form is what makes the negative cases real.
 *
 * The trailing-separator spelling (`${SKILL_RESOLVED}/`) and the file form
 * (`${SKILL_RESOLVED}/SKILL.md`) are deliberately NOT exported: every case that
 * pins a spelling variant builds it inline from this constant, so a second
 * exported spelling can go stale next to the one the assertion actually uses.
 */
export const SKILL_RESOLVED = realpathSync("/tmp") + SKILL.slice("/tmp".length);
