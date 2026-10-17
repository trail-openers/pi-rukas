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
export const SKILL = "/tmp/skills/code-review-security";

/**
 * The same path in the spelling the check actually compares.
 *
 * macOS resolves `/tmp` to `/private/tmp`, so a fixture written as a literal
 * `/tmp/...` compares equal to itself after normalisation whether or not the
 * matching logic works — which is how six of these cases were silently vacuous
 * before this note. The resolved form is what makes the negative cases real.
 */
export const SKILL_RESOLVED = realpathSync("/tmp") + SKILL.slice("/tmp".length);

/**
 * A trailing-separator spelling of the same directory.
 *
 * What varies in practice — and what the case using it pins — is the trailing
 * separator, i.e. how a child spells the path versus how the driver built it.
 * A `./` prefix would be resolved against the PROCESS CWD by the same
 * normalisation the product uses (deliberately: a child's relative path is not
 * the parent's relative path), so it only equals an absolute path when written
 * as one.
 */
export const SLOPPY_SKILL = `${SKILL_RESOLVED}/`;

/** The skill file inside `SKILL_RESOLVED`. */
export const SKILL_FILE = `${SKILL_RESOLVED}/SKILL.md`;
