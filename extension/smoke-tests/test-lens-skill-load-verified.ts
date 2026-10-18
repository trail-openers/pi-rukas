#!/usr/bin/env bun
/**
 * `skillLoadProof` (lens-skill-load-proof.ts) — the pure check that a lens
 * child's `Skill Load Status: SUCCESS` is backed by an actual read of its
 * skill file (PR #1530 lens finding, SECURITY/MEDIUM).
 *
 * This file pins the shape decisions: which tools count, what "the same path"
 * means, and what an empty `toolUses` means. The consumer (`runLensChild`) and
 * the prompt-path refusal live in `test-lens-skill-load-consumer.ts`, and the
 * round-2 false-negative cases in `test-lens-skill-load-round2.ts` — the three
 * are one suite split under AGENTS.md §12, not three suites.
 *
 * Since round 3 of the #1530 review the consumer treats `unproven` as a shadow
 * WARN, not a block, so the outcomes asserted here are the pure predicate's —
 * still the right thing to pin: the warn and any future block both key off
 * exactly this three-way value.
 */

import path from "node:path";
import { __tests__, skillLoadProof } from "../src/lens-skill-load-proof.ts";
import { SKILL_RESOLVED } from "./lib/lens-skill-proof-fixtures.ts";
import { isolateLedger } from "./lib/review-ledger-test-helpers.ts";

// #1069 — isolate before any src import: the real runLensReview write must
// land in a temp file, not the main clone's .git (worktree common dir).
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

// A trailing-separator spelling of the same directory. What varies in practice
// — and what case 1f pins — is that separator: how a child spells the path
// versus how the driver built it. A `./` prefix would resolve against the
// PROCESS CWD under the same normalisation the product uses (deliberately: a
// child's relative path is not the parent's relative path), so it only equals
// an absolute path when written as one.
const SLOPPY_SKILL = `${SKILL_RESOLVED}/`;

/* 1 — the pure proof. Each case names the shape it pins, because the
 * `unproven` / `unverifiable` split is the whole safety property: `unproven`
 * is what a future block keys on, and an absence of evidence must never be it. */
{
  eq(
    skillLoadProof([{ name: "read", arguments: { path: SKILL_RESOLVED } }], SKILL_RESOLVED),
    "unproven",
    "1a a `read` of the bare skill DIRECTORY is not a read of SKILL.md (the prompt hands out a dir; crediting it accepted a read that opened nothing)",
  );
  eq(
    skillLoadProof([], SKILL_RESOLVED),
    "unverifiable",
    "1b no recorded tool calls is UNVERIFIABLE, not a refutation (a killed child's replay carries none)",
  );
  eq(
    skillLoadProof([{ name: "report_finding", arguments: { path: "src/a.ts" } }], SKILL_RESOLVED),
    "unproven",
    "1c a SUCCESS whose only tool call is report_finding is refuted",
  );
  eq(
    skillLoadProof(
      [
        {
          name: "read",
          arguments: { path: `${SKILL_RESOLVED.replace(/security$/, "architecture")}` },
        },
      ],
      SKILL_RESOLVED,
    ),
    "unproven",
    "1d a read of a DIFFERENT skill does not prove this lens's claim",
  );
  eq(
    skillLoadProof(
      [{ name: "read", arguments: { path: `${SKILL_RESOLVED}-extra` } }],
      SKILL_RESOLVED,
    ),
    "unproven",
    "1e a prefix-sharing path is not the skill path (substring matching would pass this)",
  );
  eq(
    skillLoadProof([{ name: "read", arguments: { path: SLOPPY_SKILL } }], SKILL_RESOLVED),
    "unproven",
    "1f a trailing slash on the DIRECTORY normalises away — and is still the directory, so still not a read of the file",
  );
  eq(
    skillLoadProof(
      [{ name: "read", arguments: { path: `${SKILL_RESOLVED}/SKILL.md` } }],
      SKILL_RESOLVED,
    ),
    "proven",
    "1f2 canary for 1a/1f: the SKILL.md itself IS proven (the two above are the directory rule, not a broken match)",
  );
  eq(
    skillLoadProof(
      [{ name: "bash", arguments: { command: `cat ${SKILL_RESOLVED}/SKILL.md` } }],
      SKILL_RESOLVED,
    ),
    "proven",
    "1g a bash `cat` of the skill's SKILL.md counts as loading it",
  );
  eq(
    skillLoadProof(
      [
        {
          name: "bash",
          arguments: { command: `sed -n '1,80p' "${SKILL_RESOLVED}/SKILL.md"` },
        },
      ],
      SKILL_RESOLVED,
    ),
    "proven",
    "1h a quoted `sed` range of the skill file counts",
  );
  eq(
    skillLoadProof(
      [{ name: "bash", arguments: { command: `grep -r precedence ${SKILL_RESOLVED}` } }],
      SKILL_RESOLVED,
    ),
    "unproven",
    "1i a `grep` of the skill dir is not a read — it proves a line was seen, not the file loaded",
  );
  eq(
    skillLoadProof(
      [{ name: "bash", arguments: { command: `ls ${SKILL_RESOLVED}` } }],
      SKILL_RESOLVED,
    ),
    "unproven",
    "1o a `ls` of the skill dir names the path but reads nothing",
  );
  eq(
    skillLoadProof(
      [{ name: "bash", arguments: { command: `echo ${SKILL_RESOLVED}/SKILL.md` } }],
      SKILL_RESOLVED,
    ),
    "unproven",
    "1p echoing the path is not reading the file",
  );
  eq(
    skillLoadProof(
      [{ name: "bash", arguments: { command: `grep x cat ${SKILL_RESOLVED}` } }],
      SKILL_RESOLVED,
    ),
    "unproven",
    "1q `cat` as an argument of another verb does not make it a read (the verb is anchored)",
  );
  eq(
    skillLoadProof(
      [{ name: "bash", arguments: { command: `ls -la; cat ${SKILL_RESOLVED}/SKILL.md` } }],
      SKILL_RESOLVED,
    ),
    "proven",
    "1r a reader verb after a shell separator still counts",
  );
  eq(
    skillLoadProof(
      [{ name: "read", arguments: { command: `cat ${SKILL_RESOLVED}` } }],
      SKILL_RESOLVED,
    ),
    "unproven",
    "1j a `read` whose args carry no path field is not proof (the path must be in a path-shaped arg)",
  );
  eq(
    skillLoadProof([null, "nonsense", { name: 42 }], SKILL_RESOLVED),
    "unproven",
    "1k malformed toolUse entries are skipped, never trusted (toolUses is unknown[] by contract)",
  );
  eq(
    skillLoadProof([{ name: "read", arguments: { path: SKILL_RESOLVED } }], ""),
    "unverifiable",
    "1l an empty skillPath is UNVERIFIABLE, not a refutation — a check that could not run must never block the lens it failed to inspect",
  );
  eq(
    skillLoadProof(
      [{ name: "read", arguments: { path: `/opt${SKILL_RESOLVED}` } }],
      SKILL_RESOLVED,
    ),
    "unproven",
    "1s a longer path whose TAIL is the skill path is not a read of it (basename-matching would pass this)",
  );
  eq(
    skillLoadProof(
      [{ name: "read", arguments: { file_path: SKILL_RESOLVED } }],
      SKILL_RESOLVED,
      // The live count is passed so this is a decision about the KEY, not an
      // abstention about the array.
      1,
    ),
    "unproven",
    "1m `file_path` is NOT accepted — Pi's read schema declares `path`, so a `file_path` call never opened the file",
  );
  // The constant pinned by name. Without it the case above is vacuous against
  // the obvious refactor: PATH_KEY as a list `["path", "file_path"]` — the
  // pre-round-2 shape — keeps every behavioural assertion green while
  // crediting a call the tool itself rejects.
  eq(
    __tests__.PATH_KEY,
    "path",
    "1mb PATH_KEY is exactly `path`, the key Pi's read schema declares",
  );
  // The delimiter cases below are all shaped as `cat …` deliberately. A
  // negative case built on a `read` of a near-miss path never reaches the
  // delimiter comparison at all — the read branch compares whole normalised
  // paths — so a substring-matching implementation passes them vacuously and
  // the gate looks green while the parser is gone. `cat` puts the path inside
  // a command string, which is where `mentionsPath` decides.
  eq(
    skillLoadProof(
      [{ name: "bash", arguments: { command: `cat ${SKILL_RESOLVED}-extra/SKILL.md` } }],
      SKILL_RESOLVED,
    ),
    "unproven",
    "1t `cat` of a prefix-sharing skill dir is not a read of this one (substring matching would pass this)",
  );
  eq(
    skillLoadProof(
      [{ name: "bash", arguments: { command: `cat /opt${SKILL_RESOLVED}/SKILL.md` } }],
      SKILL_RESOLVED,
    ),
    "unproven",
    "1u `cat` of a different dir whose name ENDS with this skill's is not a read of it (tail matching would pass this)",
  );
  eq(
    skillLoadProof(
      [{ name: "bash", arguments: { command: `FOO=/opt${SKILL_RESOLVED}-x cat noop` } }],
      SKILL_RESOLVED,
    ),
    "unproven",
    "1v a path embedded mid-token is not a read of this skill (the path must start a token)",
  );
  eq(
    skillLoadProof([{ name: "write", arguments: { path: SKILL_RESOLVED } }], SKILL_RESOLVED),
    "unproven",
    "1n a non-reader tool naming the path is not a read",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
