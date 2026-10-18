#!/usr/bin/env bun
/**
 * `skillLoadProof` — the round-3 adversarial cases (PR #1530 review, round 3).
 * Companion to `test-lens-skill-load-verified.ts` (the shape matrix) and
 * `test-lens-skill-load-round2.ts`; one suite split under AGENTS.md §12.
 *
 * Two rules the first version of the check lacked, each found by the adversarial
 * review and each measured rather than inferred:
 *
 *   - CONTAINMENT. The basename rule had no containment check, so a
 *     `SKILL.md` in ANY directory — `/tmp/zzz/SKILL.md`, or the skill dir's own
 *     parent — proved a lens whose skill lives elsewhere, through both the
 *     `read` and the bash branch. The resolved candidate must equal the driver's
 *     `<dir>/SKILL.md` exactly.
 *   - WRITES CREDITED AS READS. `sed -i … <skill>/SKILL.md` rewrites the file
 *     and `cat x > <skill>/SKILL.md` truncates it; neither puts its content in
 *     the child's context, yet both came back `proven`. A segment carrying a
 *     redirect token, or `sed` with an in-place flag, is not a read.
 *
 * Every rule here is paired with the honest case that still proves, so each is a
 * narrowed match and not a matcher that rejects everything — and each redirect
 * arm (`>`, `>>`, `2>`, `&>`) has its own case, because a matcher missing one is
 * invisible to a test that only exercises another.
 */

import path from "node:path";
import { skillLoadProof } from "../src/lens-skill-load-proof.ts";
import { SKILL_RESOLVED } from "./lib/lens-skill-proof-fixtures.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

isolateLedger();

let exit = 0;
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

/* CONTAINMENT (round-3 adversarial finding). The old rule asked only that the
 * last path component be `SKILL.md`, so ANY directory's SKILL.md proved this
 * lens — `/tmp/zzz/SKILL.md` and a `cat` of it both came back `proven`. A
 * claim about one skill cannot be evidenced by a file that is not it. Each
 * case is paired with the honest read of the same shape that still proves. */
eq(
  skillLoadProof([{ name: "read", arguments: { path: "/tmp/zzz/SKILL.md" } }], SKILL_RESOLVED, 1),
  "unproven",
  "1ac a read of some OTHER directory's SKILL.md is not this lens's skill (basename-only matching would pass this)",
);
// The same containment rule seen from the side that must keep PASSING: a
// `SKILL.md` that happens to live in a directory sharing a component name with
// this one, one level up. A basename matcher accepts it; a whole-path match
// does not. This is the canary that makes 1ac/1ad a containment test rather
// than a "nothing matches" test.
eq(
  skillLoadProof(
    [{ name: "read", arguments: { path: `${path.posix.dirname(SKILL_RESOLVED)}/SKILL.md` } }],
    SKILL_RESOLVED,
    1,
  ),
  "unproven",
  "1an a SKILL.md sitting directly in the PARENT of the skill dir is not this lens's file",
);
eq(
  skillLoadProof(
    [{ name: "bash", arguments: { command: "cat /tmp/zzz/SKILL.md" } }],
    SKILL_RESOLVED,
    1,
  ),
  "unproven",
  "1ad `cat` of some OTHER directory's SKILL.md is not this lens's skill (the bash branch had the same basename gap)",
);
// Containment seen from the directory side, through the BRANCH the pre-filter
// cannot shortcut: a `cat` whose operand list contains the skill DIRECTORY
// next to a real `SKILL.md` mention. A bare `cat <dir>` never reaches here (the
// file-name pre-filter drops it first), so this is the only shape in which the
// `dirs` rejection in `tokenMatches` is the thing doing the work.
eq(
  skillLoadProof(
    [
      {
        name: "bash",
        arguments: { command: `cat ${SKILL_RESOLVED} ${SKILL_RESOLVED}/SKILL.md` },
      },
    ],
    SKILL_RESOLVED,
    1,
  ),
  "proven",
  "1ah4 a real SKILL.md operand proves even when the directory is also named — the dir token is skipped, not fatal",
);
eq(
  skillLoadProof(
    [
      {
        name: "bash",
        arguments: { command: `cat ${SKILL_RESOLVED} notes ${SKILL_RESOLVED}/SKILL.md` },
      },
    ],
    SKILL_RESOLVED,
    1,
  ),
  "proven",
  "1ah4b canary: same shape with an extra operand — still the file operand that decides",
);
// …and the arm where the directory rejection IS load-bearing: the directory is
// the ONLY operand, reached past the pre-filter by mentioning the file name in
// a non-path position. Nothing here names the file, so nothing may prove.
eq(
  skillLoadProof(
    [{ name: "bash", arguments: { command: `cat ${SKILL_RESOLVED} --label=SKILL.md` } }],
    SKILL_RESOLVED,
    1,
  ),
  "unproven",
  "1ah4c the skill DIRECTORY as the only operand is never credited, even when the file name appears as a flag value (the pre-filter admits it; `dirs` must reject it)",
);
// Canary for 1ah4c: the same command with the directory replaced by the FILE
// proves — so 1ah4c is the directory rule, not a matcher that rejects all of
// these shapes.
eq(
  skillLoadProof(
    [
      {
        name: "bash",
        arguments: { command: `cat ${SKILL_RESOLVED}/SKILL.md --label=SKILL.md` },
      },
    ],
    SKILL_RESOLVED,
    1,
  ),
  "proven",
  "1ah4d canary for 1ah4c: same command, directory swapped for the file — proven",
);
eq(
  skillLoadProof(
    [{ name: "bash", arguments: { command: `cat ${SKILL_RESOLVED}/notes.txt` } }],
    SKILL_RESOLVED,
    1,
  ),
  "unproven",
  "1ao `cat` of a sibling that is not named SKILL.md is unproven on the file-name rule alone",
);
// Containment seen from the directory side: a SKILL.md one level UP shares the
// file name the pre-filter admits, so this is the arm only the whole-path
// comparison can settle — the case that makes 1ao/1ad real.
eq(
  skillLoadProof(
    [
      {
        name: "bash",
        arguments: { command: `cat ${path.posix.dirname(SKILL_RESOLVED)}/SKILL.md` },
      },
    ],
    SKILL_RESOLVED,
    1,
  ),
  "unproven",
  "1an-b `cat` of a SKILL.md in the PARENT of the skill dir is not this lens's file (the pre-filter admits the name; only containment rejects it)",
);
// Canary for 1ah4: the same `cat` shape pointed at the FILE still proves, so
// the directory rejection above is the rule and not a broken matcher.
eq(
  skillLoadProof(
    [{ name: "bash", arguments: { command: `cat ${SKILL_RESOLVED}/SKILL.md` } }],
    SKILL_RESOLVED,
    1,
  ),
  "proven",
  "1ah5 canary for 1ah4: `cat <skill>/SKILL.md` still proves (the dir rule is specific to the directory)",
);
// Canary for 1ag: `>>` appearing as part of a token is not a redirect, so the
// append form cannot be credited by accident in either direction.
eq(
  skillLoadProof(
    [{ name: "bash", arguments: { command: `cat ${SKILL_RESOLVED}/SKILL.md` } }],
    SKILL_RESOLVED,
    1,
  ),
  "proven",
  "1ag-canary canary: a `cat` with no redirect token at all still proves",
);

eq(
  skillLoadProof(
    [{ name: "read", arguments: { path: `${SKILL_RESOLVED}/SKILL.md` } }],
    SKILL_RESOLVED,
    1,
  ),
  "proven",
  "1ae canary for 1ac/1ad: the real SKILL.md still proves, so containment is a narrowed match, not a broken one",
);

/* WRITES ARE NOT READS (round-3 adversarial finding). A reader verb is not
 * enough: a segment that redirects into the file truncates it and `sed -i`
 * rewrites it, and neither put the skill's content in the child's context.
 * Crediting them meant a child that DESTROYED its skill file reported SUCCESS
 * and was corroborated. */
eq(
  skillLoadProof(
    [
      {
        name: "bash",
        arguments: { command: `cat /etc/hostname > ${SKILL_RESOLVED}/SKILL.md` },
      },
    ],
    SKILL_RESOLVED,
    1,
  ),
  "unproven",
  "1af `cat x > <skill>/SKILL.md` truncates the skill — a redirect target is not a read",
);
eq(
  skillLoadProof(
    [
      {
        name: "bash",
        arguments: { command: `cat /etc/hostname >> ${SKILL_RESOLVED}/SKILL.md` },
      },
    ],
    SKILL_RESOLVED,
    1,
  ),
  "unproven",
  "1ag the append form `>>` is a write too (a rule that only caught `>` would pass this)",
);
// The fd form is the case that separates a redirect matcher from a bare `>`
// matcher. The VERB must be a reader verb: a segment whose first word is `grep`
// or `ls` is rejected by the verb rule before the write rule is ever consulted,
// so a `2>` case built on a non-reader verb is vacuously green. With `cat` as
// the verb, the write rule is the only thing standing between this and a
// `proven`, and a matcher anchored on a bare `>` (no leading digits) misses it.
eq(
  skillLoadProof(
    [
      {
        name: "bash",
        arguments: { command: `cat /etc/hostname 2> ${SKILL_RESOLVED}/SKILL.md` },
      },
    ],
    SKILL_RESOLVED,
    1,
  ),
  "unproven",
  "1am `cat … 2> <skill>/SKILL.md` truncates the skill via the fd form (a matcher anchored on a bare `>` misses the digits and credits a write as a read)",
);
// And the `&>` spelling (stdout+stderr together) — the `&` in the matcher. A
// rule without it sees `&>` as an ordinary token and credits the write.
eq(
  skillLoadProof(
    [
      {
        name: "bash",
        arguments: { command: `cat /etc/hostname &> ${SKILL_RESOLVED}/SKILL.md` },
      },
    ],
    SKILL_RESOLVED,
    1,
  ),
  "unproven",
  "1ap `cat … &> <skill>/SKILL.md` is a write in its combined form (a matcher without `&` would miss it)",
);
eq(
  skillLoadProof(
    [
      {
        name: "bash",
        arguments: { command: `sed -i s/precedence/ignored/ ${SKILL_RESOLVED}/SKILL.md` },
      },
    ],
    SKILL_RESOLVED,
    1,
  ),
  "unproven",
  "1ah `sed -i` rewrites the skill in place — it never loaded it",
);
eq(
  skillLoadProof(
    [
      {
        name: "bash",
        arguments: {
          command: `sed --in-place s/precedence/ignored/ ${SKILL_RESOLVED}/SKILL.md`,
        },
      },
    ],
    SKILL_RESOLVED,
    1,
  ),
  "unproven",
  "1ai the long form `--in-place` is caught too (matching only `-i` would pass this)",
);
eq(
  skillLoadProof(
    [{ name: "bash", arguments: { command: `sed -n 1,40p ${SKILL_RESOLVED}/SKILL.md` } }],
    SKILL_RESOLVED,
    1,
  ),
  "proven",
  "1aj canary for 1ah/1ai: plain `sed -n` PRINTS the file and still proves — the -i rule is specific to in-place",
);
eq(
  skillLoadProof(
    [{ name: "bash", arguments: { command: `cat ${SKILL_RESOLVED}/SKILL.md` } }],
    SKILL_RESOLVED,
    1,
  ),
  "proven",
  "1ak canary for 1af/1ag: a bare `cat` with no redirect still proves",
);
eq(
  skillLoadProof(
    [
      {
        name: "bash",
        arguments: { command: `ls -la; cat ${SKILL_RESOLVED}/SKILL.md` },
      },
    ],
    SKILL_RESOLVED,
    1,
  ),
  "proven",
  "1al canary: a redirect in ANOTHER segment does not disqualify the reading segment (the write rule is per-segment, like the verb rule)",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
