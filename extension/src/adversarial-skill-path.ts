/**
 * adversarial-skill-path — where the adversarial reviewer's own skill lives
 * (#1827).
 *
 * The reviewer skill re-read cap (`review-bounds.ts`) counts only reads that
 * resolve to the DRIVER-supplied skill path's `SKILL.md`, so the adversarial
 * reviewer's spawn needs that path the way a lens child's does
 * (`path.join(skillsDir, lens.skill)` in `lens-review-child.ts`). This is its
 * half of that pairing, split out so `adversarial.ts` — already at the
 * file-size gate (AGENTS.md §12) — can pass the value without growing.
 */

import path from "node:path";
import { piSkillsDir } from "./lens-review-format.ts";
import { SKILL_FILE_NAME } from "./lens-skill-path.ts";

/** The adversarial reviewer's skill directory name, matching its role name. */
export const ADVERSARIAL_SKILL_NAME = "adversarial-developer";

/**
 * The adversarial reviewer's skill DIRECTORY, spelled the way the lens review
 * spells a lens skill path. The file inside it — `SKILL.md` — is the only read
 * the re-read cap counts; a read of any other skill file never counts.
 */
export function adversarialSkillPath(): string {
  return path.join(piSkillsDir(), ADVERSARIAL_SKILL_NAME);
}

/** The skill FILE inside a driver-supplied skill directory. */
export function skillFileOf(skillDir: string): string {
  return path.join(skillDir, SKILL_FILE_NAME);
}
