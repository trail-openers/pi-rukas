#!/usr/bin/env bun
/**
 * #1392 D4 — the commit-pr twin of the develop gate runs the baseline probe
 * and says what it found.
 *
 * Cycle 54 parked on `integration-verify-failed` after a developer had already
 * greened the same gate in its own worktree. The park text had a hole where the
 * assertion should be — `(no specific assertion could be extracted)` — and the
 * driver had run the baseline probe #1253 added and reported NOTHING about its
 * answer. An operator reading that park cannot tell a defect the change added
 * from a gate that was already red at the base commit, which is precisely the
 * distinction #1253 exists to make.
 *
 * The develop seam already states both facts (#1349). The commit-pr seam ran
 * no probe at all and wrote no `verifyEvidence` on the cap.
 *
 * Asserted here, in order:
 *  1. `commitPrVerifyBaselineNote` is total over (assertion extracted?, probe
 *     outcome?) — every shape either says something true or abstains; nothing
 *     ever claims a baseline the probe did not establish.
 *  2. A failing commit-pr consolidated run probes the base ONCE and only after
 *     the real run failed — a green run pays nothing.
 *  3. The note reaches the cap: `runCommitPrConsolidatedVerify` carries it, and
 *     the cap's evidence + `verifyEvidence.failures` state the honest absence
 *     AND the baseline verdict (which is why the note is built here rather than
 *     rendered from prose).
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { commitPrVerifyBaselineNote } from "../src/work-driver-integrate-verify.ts";
import type { BaselineProbeOutcome } from "../src/work-driver-integrate-verify.ts";
import { runCommitPrConsolidatedVerify } from "../src/work-driver-integrate-verify.ts";
import { BASELINE_RED_MARKER } from "../src/work-driver-verify-baseline.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);

let exit = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
};

const CMD = "bash scripts/verify.sh";
const BASE = "0".repeat(40);

const green = (): BaselineProbeOutcome => ({ verdict: { status: "green" } });
const redNoAssertion = (): BaselineProbeOutcome => ({
  verdict: { status: "red", assertion: null, timedOut: false },
});
const redWithAssertion = (): BaselineProbeOutcome => ({
  // No `✗`/`FAILED:` glyph in the assertion text or any assert() message: the
  // smoke loop's capture parser reads those glyphs in a row's own text as the
  // child's failure marker.
  verdict: {
    status: "red",
    assertion: "keeps the ledger balanced: exit 0 (got 1)",
    timedOut: false,
  },
});
const redTimedOut = (): BaselineProbeOutcome => ({
  verdict: { status: "red", assertion: null, timedOut: true },
});
const unknownBase = (): BaselineProbeOutcome => ({
  verdict: { status: "unknown", reason: "could not check out the base commit" },
});
const noProbe = (): BaselineProbeOutcome => ({
  reason: "the cycle did not record a base commit to probe",
});

const note = (
  assertionExtracted: boolean,
  baseline: BaselineProbeOutcome,
  timedOut = false,
): string | undefined =>
  commitPrVerifyBaselineNote({ assertionExtracted, baseline, timedOut, cmd: CMD });

/** The note rendered, or "" when it abstains — so assertions stay booleans. */
const text = (n: string | undefined): string => n ?? "";

/** A note that states a red base rather than (or before) the honest absence. */
const statesRedBase = (n: string | undefined): boolean => text(n).includes(BASELINE_RED_MARKER);

/** A note carrying the probe's own assertion, which the change's tail never shows. */
const namesBaseAssertion = (n: string | undefined): boolean =>
  text(n).includes("assertion at base");

/** A note that states the honest absence of a readable assertion. */
const statesAbsence = (n: string | undefined): boolean =>
  text(n).includes("exited non-zero") && text(n).includes("no assertion could be read");

// ── 1. The sentence is total and never invents a baseline ────────────────────

{
  const n = note(false, unknownBase());
  assert(
    statesAbsence(n),
    "honest absence: the park says the gate exited non-zero and nothing was readable",
  );
  assert(
    text(n).includes("baseline verify not established"),
    "honest absence: the unestablished probe is named as unestablished",
  );
}

{
  const n = note(false, green());
  assert(
    text(n).includes("baseline verify passed") && text(n).includes("was green before"),
    "green base is STATED, not left as the silence the operator has to guess at",
  );
}

{
  const n = note(true, green());
  assert(
    n === undefined,
    "an extracted assertion + a green base adds nothing — no filler sentence",
  );
}

{
  const n = note(false, redNoAssertion());
  assert(
    statesRedBase(n) &&
      statesAbsence(n) &&
      text(n).includes("ALSO FAILS") &&
      text(n).includes("cannot be attributed to this diff"),
    "red base with no assertion is stated as red at base, alongside the honest absence",
  );
}

{
  const n = note(false, redTimedOut());
  assert(
    text(n).includes("exceeded its bound") && text(n).includes(BASELINE_RED_MARKER),
    "a base run killed at its bound is reported as the host's bound, not as a code verdict",
  );
}

{
  const n = note(false, noProbe());
  assert(
    text(n).includes("did not record a base commit") && !text(n).includes("was green"),
    "no probe never reads as green — the absence is named and attribution is withheld",
  );
}

{
  // The shape that made cycle 54 unreadable: no assertion, no probe, killed run.
  const n = note(false, unknownBase(), true);
  assert(n === undefined, "a killed run reports the bound, not a baseline verdict about the code");
}

{
  const n = note(false, { verdict: { status: "unknown", reason: "" } });
  assert(
    text(n).includes("baseline verify not established"),
    "an empty probe reason still renders as an absence",
  );
  const m = note(true, { reason: "" });
  assert(
    text(m).includes("not established"),
    "a probe that never ran is an absence even when the assertion parsed",
  );
}

{
  // The base is red and the gate emitted nothing assertion-shaped at all: BOTH
  // facts go in one sentence (the cycle-54 shape — the operator needs the
  // honest absence AND the attribution).
  const n = note(false, redNoAssertion());
  assert(
    statesRedBase(n) && namesBaseAssertion(n) === false && statesAbsence(n),
    "a red base with no readable assertion is stated alongside the honest absence",
  );
}

{
  // The shape that abstains: a red base on an assertion the change's own
  // message already names is `baselineRedMessage`'s sentence to state, so a
  // second rendering of it in the cap evidence would only invite disagreement.
  const n = note(true, redWithAssertion());
  assert(n === undefined, "a red base on the parsed assertion abstains for baselineRedMessage");
}

// ── 2. The probe runs only after a failure, and only once ───────────────────

const root = mkdtempSync(path.join(tmpdir(), "pi-1392-d4-"));

function makeExec(runs: { cmd: string; fail: boolean; kill?: boolean }[]) {
  const calls: string[] = [];
  const fn: ExecFn = async (cmd) => {
    calls.push(cmd);
    // The probe's own plumbing answers with real git: `probeBaselineVerify`
    // must reach the command it runs inside its temporary tree, and the
    // `finally` that removes that tree must not throw for want of a mock.
    if (/^git worktree (add|remove)/.test(cmd)) {
      return { stdout: "" };
    }
    const match = runs.find((r) => cmd.includes(r.cmd));
    if (!match) return { stdout: "", stderr: "" };
    if (match.kill) {
      const err = new Error("killed") as Error & { killed?: boolean };
      err.killed = true;
      throw err;
    }
    if (match.fail) {
      // The cycle-54 shape: the gate's own summary markers, nothing assertion-shaped.
      const err = new Error("Command failed: exit 1") as Error & {
        stdout?: string;
        stderr?: string;
      };
      err.stdout = "FAILED: scripts/verify.sh\n";
      err.stderr = "";
      throw err;
    }
    return { stdout: "ok\n", stderr: "" };
  };
  return { fn, calls };
}

async function main() {
  const repo = path.join(root, "repo");
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  const git = (args: string[]) => execFileP("git", args, { cwd: repo });
  await git(["config", "user.email", "t@example.com"]);
  await git(["config", "user.name", "T"]);
  await execFileP("sh", ["-c", "echo base > tracked.txt"], { cwd: repo });
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "base"]);

  const baseOpts = {
    repoRoot: repo,
    workstreamCount: 1,
    workstreamIds: ["default"],
    perWorktreeFailuresByWs: {},
    timeoutMs: 5_000,
    baseSha: BASE,
    issue: 1392,
  };

  // A green consolidated run never pays for a probe.
  {
    const { fn, calls } = makeExec([{ cmd: CMD, fail: false }]);
    const res = await runCommitPrConsolidatedVerify(fn, { ...baseOpts, verifyCmd: CMD });
    assert(res.ok === true, "green consolidated run passes");
    assert(
      calls.filter((c) => c.includes("worktree add")).length === 0,
      "the happy path pays nothing: no probe worktree on a green run",
    );
  }

  // A red consolidated run probes the base exactly once.
  {
    const { fn, calls } = makeExec([
      { cmd: CMD, fail: true },
      { cmd: "git worktree add", fail: false },
      { cmd: "git worktree remove", fail: false },
    ]);
    const res = await runCommitPrConsolidatedVerify(fn, { ...baseOpts, verifyCmd: CMD });
    assert(res.ok === false, "red consolidated run fails");
    if (res.ok === false) {
      assert(
        calls.filter((c) => c.includes("worktree add --detach")).length === 1,
        "the failing run probes the base exactly once",
      );
      assert(
        res.failureTail.length <= 900,
        `the failure tail stays bounded (${res.failureTail.length} chars)`,
      );
      assert(
        res.verdict.assertion === "(no specific assertion could be extracted)",
        "the classifier still reports its honest-absence sentinel in the message",
      );
      assert(
        statesAbsence(res.evidenceNote),
        "the cap evidence carries the honest-absence sentence",
      );
      const ev = text(res.evidenceNote);
      assert(
        ev.includes("baseline verify passed") ||
          ev.includes("baseline verify not established") ||
          ev.includes(BASELINE_RED_MARKER),
        "the cap evidence states the baseline result — green, red, or unestablished",
      );
      assert(
        res.classifiedMessage !== res.evidenceNote,
        "the note is additive to the classified message, not a replacement",
      );
      assert(
        res.baseline !== undefined,
        "the probe outcome is carried structurally for the caller",
      );
    }
  }

  // No base recorded → no probe, and the note says so rather than implying green.
  {
    const { fn, calls } = makeExec([{ cmd: CMD, fail: true }]);
    const res = await runCommitPrConsolidatedVerify(fn, {
      ...baseOpts,
      verifyCmd: CMD,
      baseSha: undefined,
    });
    assert(res.ok === false, "no base still fails the verify");
    assert(
      calls.filter((c) => c.includes("worktree add --detach")).length === 0,
      "with no base recorded the probe is not attempted",
    );
    if (res.ok === false) {
      const ev = text(res.evidenceNote);
      assert(
        ev.includes("not established") && !ev.includes("was green"),
        "an unprobed base is an absence in the evidence, never a green claim",
      );
    }
  }

  // A run killed at its bound keeps its own cap wording: no baseline sentence.
  {
    const { fn } = makeExec([{ cmd: CMD, fail: true, kill: true }]);
    const res = await runCommitPrConsolidatedVerify(fn, { ...baseOpts, verifyCmd: CMD });
    if (res.ok === false) {
      assert(res.timedOut === true, "the killed run is reported as a timeout");
      assert(
        res.evidenceNote === undefined,
        "a killed run gets no baseline sentence — it reached no verdict to qualify",
      );
    } else {
      assert(false, "the killed run reached the failure path");
    }
  }
}

await main();
rmSync(root, { recursive: true, force: true });
process.exit(exit);
