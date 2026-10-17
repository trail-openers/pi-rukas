#!/usr/bin/env bun
/**
 * `skillLoadProof` — the round-2 false-negative cases (PR #1530 lens review,
 * round 2). Companion to `test-lens-skill-load-verified.ts`; same suite, split
 * under AGENTS.md §12 so neither file carries the whole matrix.
 *
 * Every case here is a shape where the FIRST version of the check refuted a
 * child that had honestly loaded its skill — and a refutation BLOCKS a lens,
 * so these are the cases that would have blocked every review:
 *
 *   - a SYMLINKED skills dir (install.sh symlinks `skill/*` into the skills
 *     dir) where the child opens the canonical target instead of the link;
 *   - an UNDER-RECOVERED replay, where `observedToolCalls` says the child made
 *     more calls than `toolUses` carries, so absence proves nothing;
 *   - the BASENAME rule — any file under the skill dir used to count, so a
 *     sibling file stood in for the skill itself;
 *   - the bash TOKENISER — reader verb and path must live in the same command
 *     segment, and each token is compared whole, never as a substring.
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { skillLoadProof } from "../src/lens-skill-load-proof.ts";
import { SKILL_FILE, SKILL_RESOLVED } from "./lib/lens-skill-proof-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`✓ ${msg}`);
    return true;
  }
  console.error(`✗ ${msg}\n    actual:   ${a}\n    expected: ${e}`);
  exit = 1;
  return false;
}

/* 1b — round 2 of the #1530 review: the false-negative cases. Each one is a
 * shape where the FIRST version refuted a child that had honestly loaded its
 * skill — and a refutation blocks a lens, so these are the cases that would
 * have blocked every review. */
{
  // The symlinked skills dir — what install.sh actually leaves behind (it
  // `ln -sfn`s `skill/*` into the skills dir, so the entry IS a symlink). The
  // driver builds the symlinked path; a child that opens the canonical target
  // has the same file open. The proof resolves the DRIVER's path once and keeps
  // BOTH spellings as candidates, then compares the child's path lexically.
  const linkRoot = mkdtempSync(path.join(os.tmpdir(), "lens1530-symlink-"));
  const realDir = path.join(linkRoot, "real", "code-review-security");
  mkdirSync(realDir, { recursive: true });
  writeFileSync(path.join(realDir, "SKILL.md"), "---\nname: code-review-security\n---\n");
  const linkedDir = path.join(linkRoot, "skills", "code-review-security");
  mkdirSync(path.dirname(linkedDir), { recursive: true });
  symlinkSync(realDir, linkedDir, "dir");

  eq(
    skillLoadProof(
      [{ name: "read", arguments: { path: path.join(realDir, "SKILL.md") } }],
      // What the driver passes is the symlinked path it built with path.join.
      linkedDir,
      1,
    ),
    "proven",
    "1w a symlinked skills dir does not refute a child that read the canonical target (the driver's own path resolves to it)",
  );
  eq(
    skillLoadProof(
      [{ name: "read", arguments: { path: path.join(linkedDir, "SKILL.md") } }],
      linkedDir,
      1,
    ),
    "proven",
    "1x canary for 1w: the symlinked spelling of the same file is also proven (so 1w's pass is not a substring accident)",
  );
  eq(
    skillLoadProof(
      [
        {
          name: "read",
          arguments: { path: path.join(linkRoot, "real", "other-skill", "SKILL.md") },
        },
      ],
      linkedDir,
      1,
    ),
    "unproven",
    "1aw canary for 1w: through the same symlink, a DIFFERENT skill's file is still refuted (realpath did not just widen the match)",
  );

  // Under-recovery: the live event stream saw 3 calls, the replay carried 1.
  // The missing two may hold the read, so nothing here can refute the claim.
  eq(
    skillLoadProof(
      [{ name: "report_finding", arguments: { severity: "LOW", path: "src/a.ts" } }],
      SKILL_RESOLVED,
      3,
    ),
    "unverifiable",
    "1y an under-recovered replay (observedToolCalls 3 > toolUses 1) is UNVERIFIABLE, not a refutation",
  );
  eq(
    skillLoadProof(
      [{ name: "read", arguments: { path: `${SKILL_RESOLVED}-other`, offset: 1 } }],
      SKILL_RESOLVED,
      3,
    ),
    "unverifiable",
    "1z under-recovery abstains even when the recovered calls name a WRONG path — the missing calls decide",
  );
  eq(
    skillLoadProof(
      [
        { name: "read", arguments: { path: `${SKILL_RESOLVED}/SKILL.md` } },
        { name: "report_finding", arguments: { severity: "LOW", path: "src/a.ts" } },
      ],
      SKILL_RESOLVED,
      3,
    ),
    "proven",
    "1aa canary: the same under-recovered shape DOES prove once the read is among what was recovered (the abstain is not unconditional)",
  );
  eq(
    skillLoadProof(
      [{ name: "report_finding", arguments: { severity: "LOW", path: "src/a.ts" } }],
      SKILL_RESOLVED,
      1,
    ),
    "unproven",
    "1ab canary: with the counts AGREED (observed 1, recovered 1) the same reply is refuted — 1y's abstain comes from the gap, not the fixture",
  );

  // A sibling file inside the skill dir is not the skill.
  eq(
    skillLoadProof(
      [{ name: "read", arguments: { path: `${SKILL_RESOLVED}/cheatsheet.md` } }],
      SKILL_RESOLVED,
      1,
    ),
    "unproven",
    "1ac a read of a SIBLING file inside the skill dir does not prove the skill was loaded",
  );
  eq(
    skillLoadProof(
      [{ name: "read", arguments: { path: `${SKILL_RESOLVED}/references/notes.md` } }],
      SKILL_RESOLVED,
      1,
    ),
    "unproven",
    "1ad a nested file under the skill dir is not the skill file either",
  );
  eq(
    skillLoadProof(
      [{ name: "read", arguments: { path: `${SKILL_RESOLVED}/SKILL.md.bak` } }],
      SKILL_RESOLVED,
      1,
    ),
    "unproven",
    "1ae a SKILL.md-prefixed name is not SKILL.md (a basename-prefix match would pass this)",
  );
  eq(
    skillLoadProof(
      [{ name: "read", arguments: { path: `${SKILL_RESOLVED}/SKILL.md` } }],
      SKILL_RESOLVED,
      1,
    ),
    "proven",
    "1af canary: the SKILL.md itself in that same dir IS proven (1ac/1ad are the basename rule, not a broken directory match)",
  );
  eq(
    skillLoadProof(
      [
        {
          name: "bash",
          arguments: { command: `cat ${SKILL_RESOLVED}/../code-review-security/SKILL.md` },
        },
      ],
      SKILL_RESOLVED,
      1,
    ),
    "proven",
    "1ag a `..` detour that lands on the skill file is the same file (lexical normalisation)",
  );
  // Canary for 1ag: normalisation is what makes it prove, so the same detour
  // landing OUTSIDE the skill dir must be refuted — a matcher that ignored `..`
  // would pass 1ag by accident via the un-normalised string.
  eq(
    skillLoadProof(
      [
        {
          name: "bash",
          arguments: { command: `cat ${SKILL_RESOLVED}/../other-skill/SKILL.md` },
        },
      ],
      SKILL_RESOLVED,
      1,
    ),
    "unproven",
    "1ah3 canary for 1ag: the same `..` shape landing on ANOTHER skill's file is refuted (normalisation is real, not decorative)",
  );

  // The prompt hands the child the DIRECTORY, but the read that loads the skill
  // is `<dir>/SKILL.md`. Naming the bare directory is NOT a read — the pre-round
  // -3 rule credited it, which accepted a child that named the directory and
  // opened nothing. Its canary is 1af (the real file, proven) above.
  eq(
    skillLoadProof([{ name: "read", arguments: { path: SKILL_RESOLVED } }], SKILL_RESOLVED, 1),
    "unproven",
    "1ah naming the skill DIRECTORY the prompt gave is NOT a read of SKILL.md (it is a directory — reading it opens nothing)",
  );
  eq(
    skillLoadProof(
      [{ name: "read", arguments: { path: `${SKILL_RESOLVED}/` } }],
      SKILL_RESOLVED,
      1,
    ),
    "unproven",
    "1ah2 a trailing slash on the directory is still the directory, so still not a read",
  );
  eq(
    skillLoadProof(
      [{ name: "bash", arguments: { command: `cat ${SKILL_RESOLVED}` } }],
      SKILL_RESOLVED,
      1,
    ),
    "unproven",
    "1ah4 `cat <dir>` on a directory is an error, not a load — the directory is never credited in the bash branch either",
  );

  // Verb and path must live in the SAME segment.
  eq(
    skillLoadProof(
      [
        {
          name: "bash",
          arguments: { command: `cd x && cat ${SKILL_RESOLVED}/SKILL.md` },
        },
      ],
      SKILL_RESOLVED,
      1,
    ),
    "proven",
    "1ai `cd x && cat <skill>/SKILL.md` is proven — verb and path in one segment after &&",
  );
  eq(
    skillLoadProof(
      [
        {
          name: "bash",
          arguments: { command: `cat /etc/hostname; echo ${SKILL_RESOLVED}/SKILL.md` },
        },
      ],
      SKILL_RESOLVED,
      1,
    ),
    "unproven",
    "1aj a reader verb in a DIFFERENT segment does not vouch for the path",
  );
  eq(
    skillLoadProof(
      [{ name: "bash", arguments: { command: `echo ${SKILL_RESOLVED}/SKILL.md` } }],
      SKILL_RESOLVED,
      1,
    ),
    "unproven",
    "1ak `echo <skill>/SKILL.md` is unproven — the segment's first word is not a reader verb",
  );
  eq(
    skillLoadProof(
      [{ name: "bash", arguments: { command: `cat "${SKILL_RESOLVED}/SKILL.md"` } }],
      SKILL_RESOLVED,
      1,
    ),
    "proven",
    "1al quotes around the path are stripped before comparing",
  );
  eq(
    skillLoadProof(
      [{ name: "bash", arguments: { command: `cat ${SKILL_RESOLVED}/SKILL.md | wc -l` } }],
      SKILL_RESOLVED,
      1,
    ),
    "proven",
    "1am `cat <skill>/SKILL.md | wc -l` counts — the verb is first and the path is in that segment",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
