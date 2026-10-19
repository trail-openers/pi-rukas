#!/usr/bin/env bun
/**
 * The invisible-character gate of the single-workstream plan repair
 * (`INVISIBLE_PATH` in work-driver-plan-repair.ts), split out of
 * `test-plan-spec-mismatch-repair.ts` for the file-size cap.
 *
 * Every other path check in the repair compares VISIBLE text: `isPlainRepoRelativePath`
 * refuses shell metacharacters and ASCII whitespace, `plannedPathProblem` names
 * `\t\r\n\v\f\0` and the shell set, `isProtectedPath` matches a literal directory
 * name. None of them speaks for a Unicode `Cf` format character, so
 * `.\u200Bgithub/workflows/ci.yml` passes all three while being the protected
 * directory, and a RLO reorders what a reviewer of the PR body reads. The repair is
 * the component that WRITES the path into the plan, so it is where the character is
 * refused.
 *
 * The probes are built with `String.fromCharCode` throughout: a source file carrying
 * a real bidi control is a review hazard of its own, and `\p{Cc}`/`\p{Cf}` in the
 * implementation name them without one.
 */

import type { NormalisedSpec } from "../src/work-driver-intent.ts";
import { repairOmittedDeliverablePaths } from "../src/work-driver-plan-repair.ts";
import { SPEC, WS } from "./lib/plan-repair-fixtures.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ZWJ = String.fromCharCode(0x200d);
const ZWSP = String.fromCharCode(0x200b);
const RLO = String.fromCharCode(0x202e);
const NUL = String.fromCharCode(0);

/** The only refusal a case may produce: this gate's, naming the character. */
function refuseReasons(slot: string, grant: string[] = [], declared = ["src/a.ts"]): string[] {
  const seen: string[] = [];
  const spec: NormalisedSpec = {
    ...SPEC,
    deliverables: [{ id: "d5", description: "invisible", paths: ["src/a.ts", slot] }],
  };
  const pure = repairOmittedDeliverablePaths(
    { "task-1": WS("task-1", declared) },
    spec,
    grant,
    (r) => seen.push(r),
  );
  return pure === undefined ? seen : ["<REPAIRED>"];
}

// --------------------------- 1. a slot whose only defect is the character: refused
//
// Each visible half is a path the planner's own grammar accepts, so the refusal can
// only come from this gate. `\s` matches the ASCII control range, so a lone `\n` is
// trimmed by the splitter and never reaches here — those are judged on the disclosure
// instead (`test-plan-repair-assumption.ts`). The untrimmable forms are the
// zero-widths, the bidi controls and NUL, which no `\s` reaches.

{
  const INVISIBLE_SLOTS: string[] = [
    `src/..${ZWJ}/${ZWSP}.github/workflows/ci.yml`,
    `agents${ZWSP}.json`,
    `.${ZWSP}github/workflows/ci.yml`,
    `src/evil${RLO}.ts`,
    `src/zw${ZWJ}n.ts`,
    `src/marks${NUL}${ZWSP}.ts`,
    `src/marks${ZWSP}${NUL}.ts`,
    `src/${RLO}${ZWJ}nested.ts`,
  ];
  for (const slot of INVISIBLE_SLOTS) {
    const seen = refuseReasons(slot);
    assert(
      seen.length === 1 && seen[0]?.includes("invisible"),
      `invisible character in slot ${JSON.stringify(slot)}: refused, nothing appended`,
    );
  }
}

// ------------------ 2. a zero-width inside a protected directory: refused for its character
//
// Granted, so the protected-path rule is the one that would have fired. The
// zero-width before the dot is precisely what makes `isProtectedPath` miss it, so a
// pass here would be the whole point of the attack.

{
  const ZW_DOT_GITHUB = `.${ZWSP}github/workflows/ci.yml`;
  const seen = refuseReasons(ZW_DOT_GITHUB, [ZW_DOT_GITHUB]);
  assert(
    seen.length === 1 && seen[0]?.includes("invisible") && !seen[0]?.includes("protected path"),
    "zero-width before the dot of a protected directory: refused for its character, not passed as ordinary",
  );
}

// ------------------------------- 3. a poisoned declared path cannot witness a repair
//
// The witness test compares a declared path against the SPEC's own copy of the same
// string, so a poisoned witness MATCHES (case A) and is trusted by everything except
// this gate; and where nothing matches, the witness refusal still fires before the
// 'wrong plan' decline, which would otherwise read as an ordinary miss (case B).

{
  const specW: NormalisedSpec = {
    ...SPEC,
    deliverables: [
      { id: "w", description: "witness", paths: [`src/a${ZWSP}.ts`] },
      { id: "d5", description: "more", paths: [`src/a${ZWSP}.ts`, "src/b.ts"] },
    ],
  };
  const seenW: string[] = [];
  const witness = repairOmittedDeliverablePaths(
    { "task-1": WS("task-1", [`src/a${ZWSP}.ts`]) },
    specW,
    [],
    (r) => seenW.push(r),
  );
  assert(
    witness === undefined &&
      seenW.length === 1 &&
      seenW[0]?.includes("witness") &&
      !seenW[0]?.includes("wrong plan"),
    "zero-width inside a witness path that MATCHES the spec: refused for its character, not trusted",
  );
  const seenW2: string[] = [];
  assert(
    repairOmittedDeliverablePaths(
      { "task-1": WS("task-1", [`src/unrelated${ZWSP}.ts`]) },
      SPEC,
      [],
      (r) => seenW2.push(r),
    ) === undefined &&
      seenW2.length === 1 &&
      seenW2[0]?.includes("witness"),
    "zero-width inside an unrelated declared path: the witness check runs before the plan-quality decline",
  );
}

process.exit(exit);
