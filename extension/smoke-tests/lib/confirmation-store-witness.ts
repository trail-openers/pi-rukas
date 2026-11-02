#!/usr/bin/env bun
/**
 * #1934 — the two witnesses over `releaseFixture`'s teardown, split out of
 * `confirmation-store-fixture.ts` by the AGENTS.md §12 500-line gate.
 *
 * The seam is the DIRECTION of judgement. `confirmation-store-fixture.ts` owns
 * the fixture: the clone recipe, the two env pins, and the release that puts
 * them back. This module owns nothing and *audits* that release — it reads the
 * env and a record and reports what is wrong, creates no directory, writes no
 * file, and calls no git. That asymmetry is the reason for the split rather than
 * an arbitrary line: the two functions import the fixture module's types and
 * nothing else, so nothing here can change the isolation contract the fixture's
 * jsdoc calls load-bearing, and neither could be moved to a test file (a witness
 * that lives in a caller is exactly what let the Biome autofix invert both
 * `delete` branches with every fixture-family file green — see
 * `releaseUnpinProblems`).
 *
 * Both take a `label` and return `string[]` rather than calling `assert`: the
 * caller owns its own assertion channel (a test file imported by another test
 * file runs its top level, `process.exit` included, inside the importer), and a
 * helper that reported for itself could not be reused by the two files that
 * share these predicates.
 */

import type { ReleaseTarget } from "./confirmation-store-fixture.ts";

/** The two env vars the fixture pins, restated here because the witnesses name
 * them and the fixture module keeps their definitions private. They are `const`s
 * in `confirmation-store-fixture.ts`; if either spelling changes there, the
 * witnesses here must change with it — which the fixture's own
 * `releaseFixture`/`assertUnset` callers make loud the first time it runs. */
const LEDGER_ENV = "PI_ENSEMBLE_REVIEW_LEDGER_FILE";
const AGENT_DIR_ENV = "PI_AGENT_DIR";

/** The witness that `releaseFixture`'s two "was unset" branches really UNSET —
 * asserted BY `releaseFixture`, not merely reported by a caller.
 *
 * WHY IT IS A POST-CONDITION OF THE RELEASE AND NOT A PREDICATE A TEST CALLS.
 * The previous shape of this function returned `string[]` and every witness of
 * the two `delete` branches lived in a test file that called it afterwards. That
 * puts the checking OUTSIDE the thing under test, and the reviewer measured what
 * it costs: with `delete process.env[X]` replaced by the assignment Biome's
 * autofix produces, the release left the key present holding the 9-character
 * string `"undefined"` and BOTH fixture-family files stayed green — the caller's
 * `problems` array was computed from a `process.env` the mutant had already
 * poisoned, and `=== falsy` accepted it. So the absence check now runs INSIDE
 * `releaseFixture`, on the variable it just wrote, and returns a problem the
 * caller must assert. The predicate above still answers the caller's question
 * (`assertUnset` is what a case reads to audit a record); this is the release
 * answering for its own branch.
 *
 * `!(NAME in process.env)` and not the falsy read of the pin: on bun assigning
 * the `undefined` LITERAL to an env key does NOT remove it — it stores the
 * 9-character string `"undefined"`, which every consumer that reads the pin
 * through `?.trim()` treats as a truthy path. So the autofix does not unset, it
 * re-pins somewhere worse, and a test that only reads env strings accepts it.
 * (The contiguous dot-form of that assignment is described rather than written
 * out: this repo's own env-clear ratchet scans comments too and reddens on the
 * explanation of the very trap it forbids.)
 *
 * WHAT IT JUDGES: only a release whose recorded member was `undefined` — a pin
 * the fixture installed over nothing, so the fixture's own pin is what must be
 * gone. A member that recorded a string is a RESTORE, judged by `assertUnset`'s
 * set-arms, and asserting absence there would be wrong on its face.
 *
 * ARM BY ARM, measured (compiler-valid mutants on the shared function, whole
 * repo copy under /tmp, `bun run` of the two witness files, red line recorded):
 * - ledger / was-unset assign-instead-of-delete → RED
 *   (`release: … deletes it rather than storing the undefined literal`)
 * - agent  / was-unset assign-instead-of-delete → RED
 *   (`release: … AGENT_DIR pin …` — the arm the ledger-only probe left unjudged,
 *   which is why the two pins are checked SEPARATELY rather than in one
 *   condition: a single `problems.length === 1` reading let the ledger's problem
 *   cover for the agent's, measured `reds=0` on that arm.)
 * - the sentinel arm → NOT reachable here, and it must not be: a fixture that
 *   installed nothing has no pin of ours to remove, so this witness reports the
 *   release judged nothing rather than reporting `[]` for a branch it skipped.
 */
export function releaseUnpinProblems(f: ReleaseTarget, label: string): string[] {
  const problems: string[] = [];
  if (f.priorEnv.installed === false) {
    // The release did not run, so there is no branch to audit. `[]` here would be
    // the silent-green shape this file exists to remove: a witness that reports
    // "nothing wrong" for a case it never judged.
    return [
      `${label}: the release judged no pin (priorEnv=${JSON.stringify(f.priorEnv)} installed nothing), so its unpin is unwitnessed`,
    ];
  }
  if (f.priorEnv.ledgerFile === undefined && LEDGER_ENV in process.env) {
    problems.push(
      `${label}: an "unset" LEDGER pin is still in process.env after the release (${JSON.stringify(process.env[LEDGER_ENV])}) — only a delete expression unsets on bun`,
    );
  }
  if (f.priorEnv.agentDir === undefined && AGENT_DIR_ENV in process.env) {
    problems.push(
      `${label}: an "unset" AGENT_DIR pin is still in process.env after the release (${JSON.stringify(process.env[AGENT_DIR_ENV])}) — only a delete expression unsets on bun`,
    );
  }
  return problems;
}

/** The witness that `releaseFixture`'s two "was unset" branches really UNSET, and
 * that its two "was set" branches really compare.
 *
 * WHY IT LIVES HERE AND NOT ONLY IN A TEST. Biome's autofix for `delete x`
 * rewrites it to `x = undefined`, and on **bun** that assignment does not
 * remove the variable — it stores the 9-character string `"undefined"`. Every
 * consumer that reads the pin through `?.trim()` then sees a truthy path and
 * resolves state to a file literally named `undefined`, so the guard INVERTS
 * rather than defuses: the fixture looks unpinned and is in fact pinned
 * somewhere worse. Measured: applying that autofix to `releaseFixture` itself
 * left all four confirmation tests green, because the only witnesses of these
 * two branches lived in a test file's private copy of the same shape. This
 * function is the counter-witness on the SHARED original — a test asserts
 * absence through it, so the autofix reddens here and not only there.
 *
 * WHAT IS JUDGED, ARM BY ARM — measured, not asserted. There are four arms and
 * each was tested by deleting its BODY in a compiler-valid mutant (whole copy
 * of the repo under /tmp, `bun run` of the witness file). Each arm now produces
 * its OWN red line, and no single mutant kills two of them:
 *
 * - ledger / was-set   → RED: `restore: a corrupted LEDGER restore is exactly
 *   one problem naming that pin (problems=[])` — the `restore_case`'s corruption
 *   of the ledger pin.
 * - ledger / was-unset → RED: `release: an "unset" pin re-pinned to the literal
 *   string is exactly one problem naming that pin AND its value, and not the
 *   was-set arm's comparison` — the `unset_case`'s inverted probe.
 * - agent  / was-set   → RED: `restore: a corrupted AGENT_DIR restore is exactly
 *   one problem naming that pin (problems=[])` — the `restore_case`'s agent-side
 *   corruption, which the split left in place.
 * - agent  / was-unset → RED: `release: an "unset" AGENT_DIR pin re-pinned to
 *   the literal string …` — the mirror probe for `PI_AGENT_DIR`.
 *
 * THE TRAP TWO OF THESE WITNESSES HAD, and why their predicates are wordier
 * than they look. Both was-unset probes originally read `length === 1` plus a
 * pin-name substring. That is NOT a witness of the arm: deleting the arm's body
 * makes the pin fall through to the `else if` of the was-SET arm, which compares
 * a recorded `undefined` against the pin and pushes `<PIN> != undefined` — a
 * message that mentions the pin, mentions the value, and is the array's only
 * element. Every clause passed and the mutant went green, measured `reds=0`
 * across all five files of the fixture family for each of the two arms. The
 * probes now require the was-unset arms' own spelling (`still present`, with the
 * value quoted) AND the absence of the was-set arm's spelling (`!=`), which is
 * the only pair of facts that separates the two arms' outputs. A witness that
 * accepts either arm's answer is a witness of neither.
 *
 * A future split that drops one of these cases reddens nothing but this
 * paragraph, which is the only place the arm-by-arm contract is stated. A
 * branch that cannot go red is not coverage, whatever this comment says.
 *
 * WHAT THE TWO PREDICATES DO NOT COVER: neither judges the sentinel arm (see
 * `releaseUnpinProblems`, which refuses to certify a release that installed
 * nothing), and `releaseFixture`'s own `delete` branches are witnessed by
 * `releaseUnpinProblems` rather than here — this function reads the env a caller
 * hands it, so it can only ever report what it sees, not what the release did.
 */
export function assertUnset(f: ReleaseTarget, label: string): string[] {
  const problems: string[] = [];
  if (f.priorEnv.installed === false) {
    // A fixture that never installed the pins has no release to audit. Without
    // this arm the sentinel would fall into the `=== undefined` branch below and
    // report the host's own pin as a leak — `null` means "nothing to judge",
    // which is a different answer from "nothing wrong", and a witness that
    // returns `[]` for a case it never ran is the silent-green shape this file
    // exists to remove.
    return [
      `${label}: the fixture never installed the pins (priorEnv=${JSON.stringify(f.priorEnv)}), so its release judges nothing`,
    ];
  }
  if (f.priorEnv.ledgerFile === undefined) {
    if (LEDGER_ENV in process.env) {
      problems.push(
        `${label}: ${LEDGER_ENV} still present (${JSON.stringify(process.env[LEDGER_ENV])})`,
      );
    }
  } else if (process.env[LEDGER_ENV] !== f.priorEnv.ledgerFile) {
    problems.push(`${label}: ${LEDGER_ENV} != ${f.priorEnv.ledgerFile}`);
  }
  if (f.priorEnv.agentDir === undefined) {
    if (AGENT_DIR_ENV in process.env) {
      problems.push(
        `${label}: ${AGENT_DIR_ENV} still present (${JSON.stringify(process.env[AGENT_DIR_ENV])})`,
      );
    }
  } else if (process.env[AGENT_DIR_ENV] !== f.priorEnv.agentDir) {
    problems.push(`${label}: ${AGENT_DIR_ENV} != ${f.priorEnv.agentDir}`);
  }
  return problems;
}

