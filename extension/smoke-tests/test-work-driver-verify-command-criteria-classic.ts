#!/usr/bin/env bun
/**
 * #2283 — the classic `/work` command-criteria tier.
 *
 * The lean engine has run `verify: "command"` criteria since the tier was written. Classic
 * `/work` never had a call site, so a cycle filed against a spec carrying them ran none and
 * reported the develop step green — and a project whose verify command `verifyCmdFor` cannot
 * discover (the normal shape for a language the chain does not know) ran no command at all in
 * that step.
 *
 * The wiring MIRRORS lean by calling the same two functions (`specCriteriaFor`,
 * `commandCriteriaOutcome`); it does not re-implement them and it does not change lean's
 * behaviour. These cases drive the real `verifyDevelopOutcome` over real git, and pin four
 * things the issue makes load-bearing:
 *
 *   - **independent of `plan.cmd`** — the arms differ by the DISCOVERED verify command being
 *     absent, and the criteria still run (the control proves the chain really was skipped);
 *   - **a red criterion fails verify** — with `ok:false`, the criterion's own id in the
 *     failure, and no cap-routing marker anywhere in it;
 *   - **a not-runnable criterion is disclosed, never red** — a note naming the criterion, and
 *     the step still passing;
 *   - **a missing `verify.test` template is a named blocking failure** whose string is not
 *     the `[toolchain-unsound]` label and carries none of the `verifyCapFor` markers.
 *
 * Also pinned: the issue body comes from the cached artifact only (a missing or out-of-state
 * artifact is a named note, never a network read), and the two gates report independently —
 * a run with a red criterion AND an absent provenance path reports both.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_RESIDUE_LABEL } from "../src/work-driver-dirty-root-classify.ts";
import { HOST_EXHAUSTION_LABEL } from "../src/work-driver-exec-error.ts";
import { TOOLCHAIN_UNSOUND_LABEL } from "../src/work-driver-toolchain-canary.ts";
import { BASELINE_RED_MARKER } from "../src/work-driver-verify-baseline.ts";
import {
  COMMAND_CRITERIA_CHECKED_NOTE_PREFIX,
  COMMAND_CRITERIA_PREFIX,
  MISSING_VERIFY_TEST_TEMPLATE_FAILURE,
} from "../src/work-driver-verify-develop-command-criteria.ts";
import { verifyCapFor } from "../src/work-driver-verify-develop-helpers.ts";
import { VERIFY_TIMEOUT_LABEL } from "../src/work-driver-verify-develop-helpers.ts";
import { PROVENANCE_FAILURE_PREFIX } from "../src/work-driver-verify-develop-provenance.ts";
import { verifyDevelopOutcome } from "../src/work-driver-verify-develop.ts";
import {
  type ProvenanceFixture,
  makeProvenanceFixture,
} from "./lib/verify-develop-provenance-fixture.ts";
import {
  GREEN_CRITERION,
  RUNNER_SCRIPT,
  RUNNER_TEMPLATE,
  specBody,
  workJsonWithRunnerTemplate,
} from "./lib/verify-develop-criteria-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The chain's own "nothing to run" note, read rather than restated as a literal a drift in
`work-driver-verify-develop-cmd.ts` would silently retire. */
// The chain's own "nothing to run" note. The fixture passes an empty `verifyCmd` to make the
// chain skip: `cmd: ""` is falsy, so the gate records its skipped arm and says so, where an
// absent key would take the default-`npm test` arm and report a real (red) run instead.
const CHAIN_SKIPPED_NOTE = "no verify command discoverable";

/** The tier's executed-pass note, asserted with its counts so "ran nothing" can never print
 * the same sentence as "ran everything". */
const CRITERIA_RAN_NOTE = "command criteria: 1 of 1 command criteria run, none failed";

/** One workstream's no-effective-base row, asserted verbatim where it is produced — at the
 * gate, not in the per-worktree pass — so a note that stopped saying which worktree it
 * declined would be caught. The primary workstream's id is `a`. */
const NO_BASE_NOTE = 'command criteria: NOT CHECKED (no effective base for workstream "a")';

/** The same row for the second workstream, which is what the no-base arm has to name when
 * a cycle's base is unreadable and there is more than one worktree to decline. */
const NO_BASE_NOTE_FOR_B = 'command criteria: NOT CHECKED (no effective base for workstream "b")';

/** The multi-issue refusal, asserted verbatim for the same reason. */
const MULTI_ISSUE_NOTE =
  "command criteria: NOT CHECKED (a multi-issue cycle has no single spec to judge)";

interface Run {
  failures: string[];
  notes: string[];
  ok: boolean;
  f: ProvenanceFixture;
  mine: string[];
}

/**
 * Drive the develop gate once.
 *
 * `verifyCmd` deliberately controls ONLY the discovered verify command: when absent, the
 * chain prints "no verify command discoverable" and runs nothing, which is the state the
 * criteria must survive. The runner script and the criterion's test file are committed at
 * the base either way, because the tier's own rule is that a command criterion's file must
 * be byte-identical to base.
 */
async function run(opts: {
  criteria?: Record<string, unknown>[];
  /** Contents for the criterion's test file; a file containing FAIL makes the runner exit 1. */
  testFileContent?: string;
  workJson?: Record<string, unknown> | null;
  /** `""` makes the chain skip entirely; undefined lets the fixture default it to "". */
  verifyCmd?: string;
  body?: string | null;
  extraDevelopFiles?: Record<string, string>;
  /** Moves HEAD immediately before the project's verify command runs, so the tier reads one
   * OID before the runs and a different one after them. The drift the ordering check exists
   * for — and the arm that decides whether a red survives. */
  moveHeadDuringRun?: boolean;
  /** More than one entry marks the cycle grouped, which the tier refuses to judge: the
   * cached artifact holds the PRIMARY issue's body, so a sibling's criteria are not in the
   * text it reads. */
  issues?: number[];
  /** The workstream's effective base for EVERY workstream. An invalid sha is how the
   * no-base note arm is reached — `effectiveBaseFor` answers undefined and the tier
   * declines the worktree rather than guessing a ref to judge it against. */
  baseSha?: string;
  /** An invalid sha for ONE workstream: `workstreamBaseShas` is read per id and falls back
   * to the cycle base unless the entry is a valid sha, so this is the driver's own shape
   * for a workstream whose base could not be resolved. */
  baseShaFor?: Record<string, string>;
  /** Drive more than one workstream, one per id. Each worktree is the develop child's own
   * (the fixture creates one), so a two-workstream arm sees the criteria run twice — which
   * is what makes the note's counts a statement about one workstream and not the cycle. */
  workstreams?: string[];
}): Promise<Run> {
  const f = await makeProvenanceFixture({
    issue: 2283,
    baseFiles: {
      ...(opts.workJson === null
        ? {}
        : {
            ".pi/work.json": JSON.stringify(
              opts.workJson ?? workJsonWithRunnerTemplate(),
              null,
              2,
            ),
          }),
      "tests/run.sh": RUNNER_SCRIPT,
      "tests/quota.test.ts": opts.testFileContent ?? "ok\n",
      ...(opts.verifyCmd === undefined ? {} : { ".pi/verify-cmd": `${opts.verifyCmd}\n` }),
    },
    // One committed file always: the develop gate's own hollow-diff rule refuses a run whose
    // every worktree is empty, and that failure is not what these cases are about.
    developFiles: {
      "src/quota.ts": "export const quota = 1;\n",
      ...(opts.extraDevelopFiles ?? {}),
    },
    // "" is the caller's own command string, forwarded verbatim so the harness's argv-prefix
    // match never fires and the chain sees exactly what the fixture's .pi/verify-cmd holds.
    verifyCommand: opts.verifyCmd ?? "",
    // Lets the executor recognise the tier's argv-form runner call and fire the drift hook.
    runnerTemplate: opts.workJson === null ? undefined : RUNNER_TEMPLATE,
    ...(opts.workstreams === undefined ? {} : { extraWorkstreams: opts.workstreams }),
    ...(opts.moveHeadDuringRun === undefined
      ? {}
      : {
          beforeVerify: async () => {
            await f.commit("drift/late-commit.ts", "export const late = 1;\n");
          },
        }),
  });
  const artifact = writeBodyArtifact(f, opts.criteria, opts.body);
  const failures: string[] = [];
  const notes: string[] = [];
  await verifyDevelopOutcome(
    f.ctxFor(),
    f.stateFor(
      {
        ...(artifact === undefined ? {} : { issueBodyArtifact: artifact }),
        ...(opts.workstreams === undefined
          ? {}
          : {
              workstreams: Object.fromEntries(
                opts.workstreams.map((id) => [
                  id,
                  { id, scope: `workstream ${id}`, paths: [], outOfScope: [] },
                ]),
              ),
            }),
        ...(opts.baseShaFor === undefined
          ? {}
          : { workstreamBaseShas: opts.baseShaFor }),
      },
      {
        ...(opts.issues === undefined ? {} : { issues: opts.issues }),
        ...(opts.baseSha === undefined ? {} : { baseSha: opts.baseSha }),
      },
    ),
    f.execFn,
    failures,
    notes,
    {},
  );
  return {
    failures,
    notes,
    ok: failures.length === 0,
    f,
    mine: failures.filter((x) => x.includes(COMMAND_CRITERIA_PREFIX)),
  };
}

/** Write the composite body the explore step would have written, under the state dir. */
function writeBodyArtifact(
  f: ProvenanceFixture,
  criteria: Record<string, unknown>[] | undefined,
  body: string | null | undefined,
): string | undefined {
  if (body === null) return undefined;
  const text = body ?? specBody(criteria ?? [GREEN_CRITERION]);
  const rel = `.pi/work-state/2283/issue-body.txt`;
  mkdirSync(path.join(f.repo, ".pi", "work-state", "2283"), { recursive: true });
  writeFileSync(path.join(f.repo, rel), text);
  return rel;
}

const cleanup = async (r: Run): Promise<void> => {
  const { rmSync } = await import("node:fs");
  rmSync(r.f.root, { recursive: true, force: true });
};

// ── 1. the green arm: a runnable command criterion runs, and the step passes ───────────────
{
  const r = await run({ criteria: [GREEN_CRITERION] });
  assert(
    r.mine.length === 0,
    `green: a runnable command criterion does not fail the step (got: ${r.mine.join(" | ")})`,
  );
  assert(
    r.notes.some((n) => n.includes(CRITERIA_RAN_NOTE)) === true,
    `green: the tier SAYS it ran — an executed pass is distinguishable from a pass that ran nothing (got: ${r.notes.join(" | ")})`,
  );
  await cleanup(r);
}

// ── 2. independent of plan.cmd: no discoverable verify command, criteria still run ─────────
{
  // The control first: with NO criteria at all and no discoverable command, the chain is
  // skipped and nothing runs. Without this arm, "the criteria ran" below could be the verify
  // command's own doing rather than this tier's.
  // `verifyCmd: undefined` puts no `.pi/verify-cmd`, no package.json and no Cargo.toml in the
  // fixture, so `verifyCmdFor` discovers nothing and the whole per-worktree chain is skipped.
  // The control asserts that skip from the SAME arm's notes, so "the criteria ran" below is a
  // statement about this tier and not about a verify command nobody disabled.
  const control = await run({ criteria: [], verifyCmd: undefined });
  assert(
    control.notes.some((n) => n.includes(CHAIN_SKIPPED_NOTE)) === true &&
      control.notes.some((n) => n.includes(CRITERIA_RAN_NOTE)) === false,
    `control: with no criteria and no discoverable command, the chain is skipped AND no criterion claims to have run (got: ${control.notes.filter((n) => n.includes("verify command")).join(" | ")})`,
  );
  await cleanup(control);

  const r = await run({ criteria: [GREEN_CRITERION], verifyCmd: undefined });
  assert(
    r.notes.some((n) => n.includes(CHAIN_SKIPPED_NOTE)) === true,
    `the verify-command chain really was skipped — no discoverable command in this arm (got: ${r.notes.filter((n) => n.includes("verify command")).join(" | ")})`,
  );
  // The note is matched as a WHOLE row, counts and all. A substring match on "command
  // criteria" is satisfied by a NOT CHECKED row or a not-runnable row, and a `0 of 1` row
  // reads the same to a substring test as `1 of 1`.
  assert(
    r.notes.some((n) => n === CRITERIA_RAN_NOTE) === true,
    `and the criteria ran ANYWAY, which is the whole point of wiring them beside the ratchet gates rather than inside the chain (got: ${r.notes.join(" | ")})`,
  );
  await cleanup(r);
}

// ── 3. a red criterion fails verify, and the cap it routes to is verify-failed:develop ─────
{
  const r = await run({ criteria: [GREEN_CRITERION], testFileContent: "FAIL\n" });
  assert(
    r.ok === false,
    `red: a criterion whose file exits non-zero fails the develop step (failures: ${r.failures.join(" | ")})`,
  );
  assert(
    r.mine.length === 1 && r.mine[0]?.includes("AC1") === true,
    `red: the failure names the criterion id (got: ${r.mine.join(" | ")})`,
  );
  assert(
    verifyCapFor("develop", r.failures) === "verify-failed:develop",
    `red: the cap is the ordinary verify-failure cap (got ${verifyCapFor("develop", r.failures)})`,
  );
  await cleanup(r);
}

// ── 3b. a red survives a head that moved under the runs; only a green loses its licence ────
{
  // The drift the ordering check exists for, injected by the harness rather than faked: the
  // fixture commits while the project's own runner is mid-call, so the tier reads one OID
  // before the runs and a different one after them. That is exactly the realistic shape — a
  // develop child, a lens-fix child, or a criterion's own script committing inside the
  // command tier's window.
  //
  // The rule under test is the asymmetry, and both directions are pinned here. A GREEN loses
  // its licence: it is a claim about a tree that is gone, so the executed-pass note must not
  // print. A RED keeps it: `outcome.failed` is a non-zero exit the project's runner observed,
  // evidence AGAINST the work, and a moved head does not make a measured failure untrue.
  // Collapsing the two — the shape this tier shipped with — turned a verdict it had paid for
  // into a step that passed over a note.
  const driftRed = await run({
    criteria: [GREEN_CRITERION],
    testFileContent: "FAIL\n",
    moveHeadDuringRun: true,
  });
  assert(
    driftRed.mine.length === 1 && driftRed.mine[0]?.includes("AC1") === true,
    `drift + red: the criterion's failure is CARRIED across the head move, naming its id (got: ${driftRed.mine.join(" | ")})`,
  );
  assert(
    verifyCapFor("develop", driftRed.failures) === "verify-failed:develop",
    `drift + red: and it routes to the ordinary verify-failure cap, not a pass over notes (got ${verifyCapFor("develop", driftRed.failures)})`,
  );
  assert(
    driftRed.notes.some(
      (n) => n.includes("head moved while the criteria ran") && n.includes("NOT CHECKED"),
    ) === true,
    `drift + red: the move is still disclosed as a could-not-tell row, so the reader knows the green verdicts were discarded (got: ${driftRed.notes.filter((n) => n.includes("head moved")).join(" | ")})`,
  );
  await cleanup(driftRed);

  // The other direction of the same asymmetry. Without this arm, a wiring that carried every
  // verdict across drift would satisfy the red assertions above while re-licensing exactly the
  // green the check exists to refuse.
  const driftGreen = await run({
    criteria: [GREEN_CRITERION],
    moveHeadDuringRun: true,
  });
  assert(
    driftGreen.notes.some((n) => n.includes(CRITERIA_RAN_NOTE)) === false,
    `drift + green: the executed-pass note never prints for criteria judged against a tree that is gone (got: ${driftGreen.notes.join(" | ")})`,
  );
  assert(
    driftGreen.notes.some(
      (n) => n.includes("head moved while the criteria ran") && n.includes("NOT CHECKED"),
    ) === true,
    `drift + green: and the run says what it discarded rather than going silent (got: ${driftGreen.notes.filter((n) => n.includes("head moved")).join(" | ")})`,
  );
  await cleanup(driftGreen);
}

// ── 4. a missing verify.test template is a named blocking failure ──────────────────────────
{
  const r = await run({ criteria: [GREEN_CRITERION], workJson: null });
  assert(
    r.ok === false,
    `no template: the step FAILS rather than passing over criteria nobody ran (failures: ${r.failures.join(" | ")})`,
  );
  assert(
    r.mine[0] === MISSING_VERIFY_TEST_TEMPLATE_FAILURE,
    `no template: the failure is the named constant, byte-for-byte (got: ${r.mine[0]})`,
  );
  assert(
    r.mine[0]?.includes(TOOLCHAIN_UNSOUND_LABEL) === false &&
      r.mine[0]?.includes(VERIFY_TIMEOUT_LABEL) === false &&
      r.mine[0]?.includes(BASELINE_RED_MARKER) === false &&
      r.mine[0]?.includes(HOST_EXHAUSTION_LABEL) === false &&
      r.mine[0]?.includes(BUILD_RESIDUE_LABEL) === false,
    "no template: the string carries neither the toolchain-unsound label nor any no-verdict marker, so it cannot be routed to another cap",
  );
  assert(
    verifyCapFor("develop", r.failures) === "verify-failed:develop",
    `no template: and the cap router sends it to verify-failed:develop (got ${verifyCapFor("develop", r.failures)})`,
  );
  await cleanup(r);
}

// ── 5. not-runnable is disclosed, never red ────────────────────────────────────────────────
{
  // A `command` that is not a plain repo-relative file is the spec's own defect: the tier
  // declines it, the step stays green, and the reason reaches the notes.
  const r = await run({
    criteria: [
      { id: "AC9", text: "Not a file at all.", verify: "command", command: "sh -c 'exit 1'" },
      GREEN_CRITERION,
    ],
  });
  assert(
    r.ok === true,
    `not-runnable: a refused criterion never fails the step (failures: ${r.failures.join(" | ")})`,
  );
  assert(
    r.notes.some((n) => n.includes("criterion AC9 not run")) === true &&
      // The whole row, and only the one row: these two are the tier's only channel for a
      // criterion it declined, so a wiring that pushed them into `failures` (making a spec
      // defect red) or dropped them (hiding it) has to be visible from here.
      r.notes.filter((n) => n.includes("criterion AC9 not run")).length === 1 &&
      r.failures.some((f) => f.includes("AC9")) === false,
    `not-runnable: the refusal is DISCLOSED as exactly one note per criterion, with its reason and never as a failure (notes: ${r.notes.filter((n) => n.includes("AC9")).join(" | ")}; failures: ${r.failures.join(" | ")})`,
  );
  assert(
    r.notes.some((n) => n === "command criteria: 1 of 2 command criteria run, none failed"),
    "and the runnable criterion beside it still ran, so a refusal cannot hide a pass or a red (the note counts 1 of 2, matched as a whole row)",
  );
  await cleanup(r);
}

// ── 5b. the gate's own refusals: a multi-issue cycle, and a workstream with no base ───────
{
  // Both rows are emitted by `runCommandCriteriaGate`, below the per-worktree pass, and
  // both are the difference between "the tier judged and was unclear" and "the tier
  // declined to judge at all". The first is the arm that can produce a false verdict — a
  // grouped cycle judged against the PRIMARY issue's cached artifact would report a verdict
  // on a contract no sibling agreed to — so its absence is asserted as well as its presence.
  const grouped = await run({ criteria: [GREEN_CRITERION], issues: [2283, 2284] });
  assert(
    grouped.notes.some((n) => n === MULTI_ISSUE_NOTE) === true,
    `multi-issue: the tier refuses rather than judging every workstream against the primary's spec (got: ${grouped.notes.filter((n) => n.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  assert(
    grouped.notes.some((n) => n === CRITERIA_RAN_NOTE) === false &&
      grouped.mine.length === 0,
    `multi-issue: and it runs nothing — no executed-pass note, no criteria failure (notes: ${grouped.notes.filter((n) => n.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")}; failures: ${grouped.mine.join(" | ")})`,
  );
  await cleanup(grouped);

  // The reverse, so the arm cannot be inverted into a refusal that swallows every cycle.
  const single = await run({ criteria: [GREEN_CRITERION], issues: [2283] });
  assert(
    single.notes.some((n) => n === MULTI_ISSUE_NOTE) === false &&
      single.notes.some((n) => n === CRITERIA_RAN_NOTE) === true,
    `single-issue (an explicit \`issues: [n]\`): the tier still judges — the guard keys on the count, not on the field being set (got: ${single.notes.filter((n) => n.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  await cleanup(single);

  // The no-base arm: `effectiveBaseFor` answers undefined for an unreadable base, and the
  // tier names the workstream it declined rather than guessing a ref to judge it against.
  const noBase = await run({ criteria: [GREEN_CRITERION], baseSha: "not-a-sha", workstreams: ["a", "b"] });
  assert(
    noBase.notes.some((n) => n === NO_BASE_NOTE) === true &&
      // Both worktrees are declined, each by name: the row is a per-worktree answer, so a
      // cycle-wide refusal that named only one workstream would hide the other from the
      // reader (and from the operator deciding whether to re-run).
      noBase.notes.some((n) => n === NO_BASE_NOTE_FOR_B) === true &&
      noBase.notes.some((n) => n === CRITERIA_RAN_NOTE) === false,
    `no base: every workstream is named in its own could-not-tell row, and no criterion claims to have run against a base nobody resolved (got: ${noBase.notes.filter((n) => n.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  assert(
    noBase.mine.length === 0,
    `no base: a missing base is never a criteria failure (got: ${noBase.mine.join(" | ")})`,
  );
  await cleanup(noBase);

  // And the per-worktree loop keeps judging past a refusal: `a` has a base and runs, `b`
  // has none and is declined. A gate that returned on the first missing base (or let one
  // workstream's note swallow the cycle) prints no executed row at all, and a reader could
  // not tell "the tier declined here and judged there" from "nothing ran this round".
  const mixed = await run({ criteria: [GREEN_CRITERION], workstreams: ["a", "b"] });
  assert(
    mixed.notes.filter((n) => n === CRITERIA_RAN_NOTE).length === 2 && mixed.mine.length === 0,
    `two workstreams: each is judged on its own, so the executed-pass row appears once per worktree (got ${String(mixed.notes.filter((n) => n === CRITERIA_RAN_NOTE).length)}: ${mixed.notes.filter((n) => n.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  await cleanup(mixed);

  // The sibling arm of the no-base row, and the one that keeps the guard honest: a
  // workstream whose per-workstream base entry is not a valid sha is NOT the missing-base
  // case — `effectiveBaseFor` falls back to the cycle base whenever that entry is invalid,
  // so `b` keeps being judged and gets no refusal row. A wiring that read an invalid entry
  // as "no base" would decline every workstream a dependent cycle has (`workstreamBaseShas`
  // is written for dependents at #679), which is a false green across the board.
  const oneBadBase = await run({
    criteria: [GREEN_CRITERION],
    workstreams: ["a", "b"],
    baseShaFor: { b: "not-a-sha" },
  });
  assert(
    oneBadBase.notes.filter((n) => n.includes("no effective base")).length === 0 &&
      oneBadBase.notes.filter((n) => n === CRITERIA_RAN_NOTE).length === 2 &&
      oneBadBase.mine.length === 0,
    `an unresolvable per-workstream base falls back to the cycle base and is still judged — no refusal row, and each worktree gets its own executed row (got: ${oneBadBase.notes.filter((n) => n.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  await cleanup(oneBadBase);
}

// ── 6. a criterion whose file changed since base is not-runnable, not red ──────────────────
{
  const r = await run({
    criteria: [GREEN_CRITERION],
    extraDevelopFiles: { "tests/quota.test.ts": "rewritten by the develop child\n" },
  });
  assert(
    r.ok === true &&
      r.notes.some(
        (n) => n.includes("criterion AC1 not run") && n.includes("changed since base"),
      ) === true,
    `a preservation criterion whose file the change rewrote is declined, not judged red (ok ${String(r.ok)}; got: ${r.notes.filter((n) => n.includes("AC1")).join(" | ")})`,
  );
  await cleanup(r);
}

// ── 7. the issue body comes from the cached artifact, never the network ────────────────────
{
  const missing = await run({ criteria: [GREEN_CRITERION], body: null });
  assert(
    missing.ok === true &&
      missing.notes.some((n) => n.includes("NOT CHECKED") && n.includes("no cached issue body")) ===
        true,
    `no artifact: a named note, not a pass-by-silence and not a failure (ok ${String(missing.ok)}; got: ${missing.notes.filter((n) => n.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  await cleanup(missing);

  // An artifact outside the cycle's state dir is refused by `readCachedBody`; the tier then
  // says it could not read the block rather than fetching the issue over the network.
  const outside = await run({ criteria: [GREEN_CRITERION] });
  const rel = ".pi/outside-body.txt";
  writeFileSync(path.join(outside.f.repo, rel), specBody([GREEN_CRITERION]));
  const failures: string[] = [];
  const notes: string[] = [];
  await verifyDevelopOutcome(
    outside.f.ctxFor(),
    outside.f.stateFor({ issueBodyArtifact: rel }),
    outside.f.execFn,
    failures,
    notes,
    {},
  );
  assert(
    failures.length === 0 &&
      notes.some((n) => n.includes("NOT CHECKED") && n.includes("artifact")) === true,
    `an artifact outside .pi/work-state/ is a named note — the block is never read from a path the driver did not write (got: ${notes.filter((n) => n.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  await cleanup(outside);
}

// ── 8. an unparsable spec block is a note, not a failure and not a pass-by-silence ─────────
{
  const r = await run({ criteria: undefined, body: "prose only, no block at all\n" });
  assert(
    r.ok === true && !r.notes.some((n) => n.includes(COMMAND_CRITERIA_CHECKED_NOTE_PREFIX)),
    "a body with no pi-spec block is an ordinary run that asked for nothing: no criteria, no note claiming any ran",
  );
  await cleanup(r);
  const broken = await run({ criteria: undefined, body: "```pi-spec v1\n{not json\n```\n" });
  assert(
    broken.ok === true &&
      broken.notes.some((n) => n.includes("NOT CHECKED") && n.includes("spec")) === true,
    `an unparsable block is a named note, never a verdict (ok ${String(broken.ok)}; got: ${broken.notes.filter((n) => n.includes(COMMAND_CRITERIA_PREFIX)).join(" | ")})`,
  );
  await cleanup(broken);
}

// ── 9. independence: a red criterion and an absent provenance path report BOTH ─────────────
{
  const both = await run({
    criteria: [GREEN_CRITERION],
    testFileContent: "FAIL\n",
    extraDevelopFiles: {
      "tasks/record.json": '{"source":"results/never-measured.ndjson","rows":[]}\n',
    },
  });
  const prov = both.failures.filter((x) => x.includes(PROVENANCE_FAILURE_PREFIX));
  const crit = both.failures.filter((x) => x.includes(COMMAND_CRITERIA_PREFIX));
  assert(
    prov.length === 1 && crit.length === 1,
    `both gates report on the same run — neither suppresses the other (provenance ${String(prov.length)}, criteria ${String(crit.length)})`,
  );
  await cleanup(both);

  const onlyProv = await run({
    criteria: [GREEN_CRITERION],
    extraDevelopFiles: { "tasks/record.json": '{"source":"results/never-measured.ndjson"}\n' },
  });
  assert(
    onlyProv.failures.filter((x) => x.includes(PROVENANCE_FAILURE_PREFIX)).length === 1 &&
      onlyProv.failures.filter((x) => x.includes(COMMAND_CRITERIA_PREFIX)).length === 0,
    "with only the provenance defect, only that gate reports",
  );
  await cleanup(onlyProv);

  const onlyCrit = await run({ criteria: [GREEN_CRITERION], testFileContent: "FAIL\n" });
  assert(
    onlyCrit.failures.filter((x) => x.includes(PROVENANCE_FAILURE_PREFIX)).length === 0 &&
      onlyCrit.failures.filter((x) => x.includes(COMMAND_CRITERIA_PREFIX)).length === 1,
    "with only the criterion defect, only that gate reports",
  );
  await cleanup(onlyCrit);
}

// ── 10. the tier's own wording survives drift against the lean module it mirrors ───────────
{
  const { readFileSync } = await import("node:fs");
  const lean = readFileSync(
    path.join(import.meta.dir, "..", "src", "lean", "verify-commands.ts"),
    "utf8",
  );
  assert(
    lean.includes("no verify.test runner template is configured"),
    "the missing-template signature this tier matches on is still the string lean/verify-commands.ts throws — the two cannot drift in silence",
  );
  assert(
    MISSING_VERIFY_TEST_TEMPLATE_FAILURE.includes("verify.test"),
    "and the blocking failure names the config key the operator has to set",
  );
}

// ── 11. the doctrine both gates rest on is actually shipped to the reviewers ───────────────
{
  // These two modules exist because "a record that round-trips through its own generator"
  // was being accepted as evidence. That judgement lives in the prompt layer, so a reviewer
  // is only told to make it if the sentence is still in the assembled modules — a reworded
  // or deleted module would leave both gates enforcing a rule nobody states.
  const { readFileSync } = await import("node:fs");
  const doctrine = ["../modules/domains/adversarial-criteria.md", "../modules/workflows/quality-gates.md"];
  for (const rel of doctrine) {
    const text = readFileSync(path.join(import.meta.dir, "..", rel), "utf8");
    assert(
      text.includes("round-trips through its own generator") &&
        text.includes("met only by evidence that it executed"),
      `${rel} still carries the evidence-not-claims rule these two gates enforce`,
    );
  }
}

console.log(`\nexit ${String(exit)}`);
process.exit(exit);
