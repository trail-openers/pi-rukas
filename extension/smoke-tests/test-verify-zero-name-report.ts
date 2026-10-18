#!/usr/bin/env bun
/**
 * #1404 fix round 3 — THE zero-name change report, and the arithmetic the
 * caller's continue gate runs on.
 *
 * Split out of `test-integration-verify-baseline.ts` for the 500-line cap
 * (AGENTS.md §12). It is the case set that decides whether a red consolidated
 * gate can be talked into a push, so it runs beside the others in the offline
 * loop rather than being folded into the parser file.
 *
 * The shape under test: the change run FAILED (that is the only reason the
 * probe runs at all), yet its own report carries the loop's positive-zero
 * trailer `FAILED-TESTS: 0`. That report does not describe the failure in front
 * of us, so the probe is UNATTRIBUTABLE — it is not "the change broke nothing".
 * Paired with a base that IS red and DOES name the change's test, this is the
 * fixture that used to fall through every guard: zero change names, zero base
 * names matching, `caused.length === 0`, and the caller read that as "all
 * pre-existing" and PUSHED.
 *
 * (g) and (h) are one test, not two: (h) is the mirror control that makes (g)
 * mean what it says. If both ever return `undefined`, (g) is vacuous; if both
 * ever return an outcome, the guard is gone.
 */
import { createVerifyReportFile } from "../src/work-driver-verify-report-path.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

{
  const { attributeAgainstBase } = await import("../src/work-driver-verify-attribution.ts");
  const fs = await import("node:fs");
  const { createVerifyReportDir } = await import("../src/work-driver-verify-report-path.ts");
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const REPO = "/repo";
  const PROBE = `${REPO}/.worktrees/baseline-verify-commit-pr`;

  /**
   * Scripted exec: git/worktree plumbing succeeds, the gate run fails the way
   * `execFile` fails a non-zero child (a thrown error carrying `stdout`). The
   * stream is the loop's normal summary shape — what `probed` and the tally
   * cross-check read. NAMES never come from it.
   */
  const scripted =
    (gate: { stdout: string; code: number }) =>
    async (cmd: string): Promise<{ stdout: string; stderr?: string }> => {
      if (cmd.startsWith("git ") || cmd.startsWith("mkdir") || cmd.includes("worktree")) {
        return { stdout: "" };
      }
      const err = new Error(`Command failed with exit code ${gate.code}`) as Error & {
        stdout: string;
        stderr: string;
        code: number;
      };
      err.stdout = gate.stdout;
      err.stderr = "";
      err.code = gate.code;
      throw err;
    };
  const baseStream = (names: string[], count: number): string =>
    [
      ...names.map((n) => `FAILED: ${n}`),
      `FAILED: ${count} test(s) — ${names.join(", ")}`,
      `P: 3  F: ${count}`,
    ].join("\n");

  const reportDir = createVerifyReportDir("pi-1404-zeroname-");
  const writeReport = (p: string, names: string[]): void => {
    fs.writeFileSync(
      p,
      names.length === 0
        ? "FAILED-TESTS: 0\n"
        : `${names.join("\n")}\nFAILED-TESTS: ${names.length}\n`,
    );
  };
  const newReport = (label: string): string => createVerifyReportFile(reportDir, label);

  // The control change report: it names its own failure, in the change tree's
  // spelling. Everything below varies the BASE or this file, never both.
  const changeReport = newReport("change");
  writeReport(changeReport, [`${REPO}/tests/test-red.ts`]);
  const opts = (verifyCmd: string, probeReport: string, changeFile = changeReport) => ({
    repoRoot: REPO,
    baseSha: SHA,
    verifyCmd,
    changeRoots: ["/wt-a"],
    timeoutMs: 5000,
    reportDir,
    changeReportFile: changeFile,
    probeReportFile: probeReport,
    probeEnv: { VERIFY_REPORT_FILE: probeReport },
  });

  const RED_BASE = baseStream([`${PROBE}/tests/test-red.ts`], 1);

  // (g) A FAILED change run whose report names zero tests, against a base that
  // is red and names that test: unattributable. The guard is the only thing
  // between this fixture and a push.
  const changeZero = newReport("change-zero");
  fs.writeFileSync(changeZero, "FAILED-TESTS: 0\n");
  const probeG = newReport("base-g");
  writeReport(probeG, [`${PROBE}/tests/test-red.ts`]);
  const zeroName = await attributeAgainstBase(scripted({ stdout: RED_BASE, code: 1 }), {
    ...opts("sh gate.sh", probeG),
    changeReportFile: changeZero,
  });
  assert(
    zeroName === undefined,
    `#1404: a FAILED change run whose report names zero tests is unattributable, never "nothing to excuse" — a red base must not launder it into a push (got ${JSON.stringify(zeroName)})`,
  );

  // The same refusal must not depend on the base's exit code: a zero-name
  // change report parks whatever the base says, so no second shape can lean on
  // the guard (g) asserts.
  const zeroNameGreenExit = await attributeAgainstBase(scripted({ stdout: RED_BASE, code: 0 }), {
    ...opts("sh gate.sh", probeG),
    changeReportFile: changeZero,
  });
  assert(
    zeroNameGreenExit === undefined,
    `#1404: a zero-name change report parks whatever the base's exit code says — the absence of the guard is what (h) proves removable, so no second shape may rely on it (got ${JSON.stringify(zeroNameGreenExit)})`,
  );

  // (h) The mirror control: the SAME base, with a change report that DOES name
  // the test, excuses it. So (g) parks on the empty change report and on
  // nothing else about this fixture.
  const agreedAgain = await attributeAgainstBase(
    scripted({ stdout: RED_BASE, code: 1 }),
    opts("sh gate.sh", probeG),
  );
  assert(
    agreedAgain !== undefined &&
      agreedAgain.changeCausedFailures.length === 0 &&
      agreedAgain.changeRunNames.length === 1,
    `#1404 (control for (g)): the same base excuses a change report that names its own failure, so (g) fails closed on the empty report alone (got ${JSON.stringify(agreedAgain)})`,
  );

  // (i) The continue gate's own arithmetic: the change run names TWO tests and
  // the base is red on only ONE. `changeCausedFailures` is non-empty so the
  // caller parks, and `changeRunNames` carries the denominator (2) the caller
  // compares against `preExistingFailures.length` — without it a caller could
  // only ask "is caused empty?", which a duplicate spelling can satisfy.
  const changePair = newReport("change-pair");
  writeReport(changePair, [`${REPO}/tests/test-red.ts`, `${REPO}/tests/test-other.ts`]);
  const partial = await attributeAgainstBase(scripted({ stdout: RED_BASE, code: 1 }), {
    ...opts("sh gate.sh", probeG),
    changeReportFile: changePair,
  });
  assert(
    partial !== undefined &&
      partial.changeRunNames.length === 2 &&
      partial.preExistingFailures.length === 1 &&
      partial.changeCausedFailures.length === 1,
    `#1404: the outcome reports the change run's own name count, so the caller's pre.length === changeNames.length test is checkable rather than inferable (got ${JSON.stringify(partial)})`,
  );

  fs.rmSync(reportDir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
