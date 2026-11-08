#!/usr/bin/env bun
/**
 * lean/freeze-check, `challenge` side — an adversary's new file is admitted on
 * the same terms as `specify`'s.
 *
 * The rule is not the step's, it is the CONTRACT's: a file `build` may not edit
 * is unwinnable whoever wrote it, so `challenge` runs the project's freeze check
 * over its candidates too. It shares the pipeline, so the interesting question
 * is whether the drop is per-file and per-cause: the round's whole claim is that
 * SOME edge case was found, so a gate that names one bad file must not take the
 * good one with it — and the reason the child gets back must name the CHECK, not
 * some other rule that happened to fire first.
 *
 *   (g1) a marked new file in its own right → `new-tests`, the clean file frozen
 *        alone, the commit holding the clean file alone, and the drop attributed
 *        to the freeze check by name;
 *   (g2) a check the round's own head already fails → the adversary's clean file
 *        still freezes. A gate the mainline fails has no standing to condemn a
 *        candidate, and "could not tell" is never a colour.
 *
 * Same fixture as `test-lean-challenge.ts`: real repo at base + frozen commit +
 * build commit, real git, only the adversary stubbed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { WorkConfig } from "../src/lean/config.ts";
import { defaultConfig } from "../src/lean/config.ts";
import {
  RUNNER,
  TWO_AC_BODY,
  blobSha,
  commitPaths,
  redEdge,
  runChallenge,
  sha,
  submit,
} from "./lib/lean-challenge-fixture.ts";
import { assert, testLocationExit } from "./lib/lean-test-location-fixture.ts";

const MARKER = "FORBIDDEN_MARKER";
/** The offending spelling, assembled so this repo's own env-clear ratchet stays quiet. */
const OFFENDING = `process.env.${["X", "_OFFENDER"].join("")} = undefined`;
/**
 * The marker is SPLIT rather than written out: the grep below receives it as
 * shell words, so a single contiguous token would satisfy its own search. Each
 * half is quoted separately and joined by an empty `-e` alternative-free pattern,
 * which is what makes the gate read a file's bytes rather than its own text.
 */
const MARKER_GREP = `${MARKER.slice(0, 8)}''${MARKER.slice(8)}`;
const EDGE = "tests/AC1-adversary-edge.test.sh";
const MARKED = "tests/AC2-adversary-marked.test.sh";

function markedEdge(): string {
  // The marker reaches the file through a CONCATENATION, so nothing in this
  // source text contains the contiguous token the gate searches for — the same
  // discipline the gate's own pattern uses (see `MARKER_GREP`).
  const token = `${MARKER.slice(0, 8)}${MARKER.slice(8)}`;
  // The path it prints is passed in, so the red proof calls it a red and the
  // freeze check is the rule that refuses it — not the runner, which would
  // report the same file as `unclear` and hide the attribution this case pins.
  return `${redEdge(MARKED)}# offending form: ${OFFENDING} ${token}\n`;
}

/** The adversary's ordinary new test, for the arm where the gate must not bite. */
function cleanEdge(): string {
  return redEdge(EDGE);
}

/**
 * The project's content gate: green unless a test file carries the marker.
 *
 * It searches for the SPLIT form (see `MARKER_GREP`) and the candidate carries
 * the contiguous one, so a gate that passes has genuinely read the tree rather
 * than its own command line.
 */
function gate(): string {
  return `sh -c 'if grep -rl "${MARKER_GREP}" tests >/dev/null 2>&1; then grep -rn "${MARKER_GREP}" tests; exit 1; fi'`;
}

function config(): WorkConfig {
  return { ...defaultConfig(), verify: { fast: "true", test: RUNNER, freezeCheck: gate() } };
}

// ── (g1) the marked candidate is dropped, and a clean one survives it ───────
{
  // The marked candidate is submitted for AC2 and the clean one for AC1 — the
  // round's own `any-red` rule keeps a red for any criterion, so a drop that
  // swallowed the good file as well would read as `none` here.
  const r = await runChallenge({
    issue: 2411,
    specBody: TWO_AC_BODY,
    config: config(),
    child: (wt) => {
      writeEdge(wt, EDGE, redEdge(EDGE));
      writeEdge(wt, MARKED, markedEdge());
    },
    toolUses: [submit("AC1", [EDGE]), submit("AC2", [MARKED])],
  });
  assert(r.threw === undefined, `(g1) no throw (${r.threw?.message})`);
  assert(
    r.outcome?.kind === "new-tests",
    `(g1) the round still freezes the edge it found (got ${r.outcome?.kind})`,
  );
  assert(
    Object.keys(r.outcome?.frozen ?? {}).join() === EDGE,
    `(g1) ONLY the clean file joins the contract (got ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes("verify.freezeCheck") &&
      (r.outcome?.reason ?? "").includes(gate()),
    `(g1) the drop is attributed to the freeze check and its command, not to another rule (got ${r.outcome?.reason})`,
  );
  assert(
    (r.outcome?.reason ?? "").includes(MARKED),
    `(g1) the reason names the file the check condemned (got ${r.outcome?.reason})`,
  );
  assert(
    commitPaths(r.worktree).join() === EDGE,
    `(g1) the commit holds the clean file alone (got ${commitPaths(r.worktree).join(", ")})`,
  );
  assert(
    blobSha(r.worktree, "HEAD", EDGE) === sha(redEdge(EDGE)),
    "(g1) the frozen file is the bytes the adversary wrote",
  );
}

// ── (g2) a check the round's own head already fails: no attribution, no drop ─
{
  const r = await runChallenge({
    issue: 2412,
    // The base commit — the tree the round's head descends from and the tree the
    // attribution run reads — carries a marked file of its own.
    baseMainlineMarker: true,
    baseMainlineText: `${redEdge("tests/mainline-marked.test.sh")}# ${OFFENDING} ${MARKER.slice(0, 8)}${MARKER.slice(8)}\n`,
    config: config(),
    child: (wt) => writeEdge(wt, EDGE, cleanEdge()),
    toolUses: [submit("AC1", [EDGE])],
  });
  assert(r.threw === undefined, `(g2) no throw (${r.threw?.message})`);
  assert(
    r.outcome?.kind === "new-tests" && Object.keys(r.outcome?.frozen ?? {}).join() === EDGE,
    `(g2) a gate already red at head never blocks the adversary's freeze (got ${r.outcome?.kind} / ${JSON.stringify(r.outcome?.frozen)})`,
  );
  assert(
    blobSha(r.worktree, "HEAD", EDGE) === sha(cleanEdge()),
    "(g2) the frozen file is the bytes the adversary wrote",
  );
}

/** One file the adversary wrote, executable, with its parents. */
function writeEdge(wt: string, rel: string, body: string): void {
  const target = path.join(wt, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, { mode: 0o755 });
}

process.exit(testLocationExit());
