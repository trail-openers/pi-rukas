#!/usr/bin/env bun
/**
 * #2125 Rescope 2 — the merge guard's pre-check for a child that cannot land.
 *
 * A day of field logs after 0.14.70 recorded ~730 holds, none of them a real
 * landing: reviewers reading test filenames that carry the landing verb,
 * `grep`s and `vipune` notes quoting it, heredocs, `bun -e` probes. The
 * classifier scans RAW text — quoted arguments and heredoc bodies included —
 * so it cannot tell prose about a landing from a landing, and every earlier
 * classifier built for this issue freed between 1.4% and 13.5% of those rows.
 *
 * So the rule is scoped by who is asking (S1): a non-ops child gets the raw
 * landing-form scan and nothing else, because (S3) these roles never land a
 * PR and the guard catches mistakes for them, not adversaries. `ops` and the
 * parent keep the classifier untouched. What is pinned here:
 *   A. a non-ops role is RELEASED for reads, prose and heredocs naming the
 *      verb, and HELD for every real landing form;
 *   B. `ops` and an unset role are never released — behaviour is unchanged;
 *   C. the pre-check is direction-safe: it only ever turns a hold into a run,
 *      so no command is stopped for a child that ops would have been allowed;
 *   D. the scan is linear in its input (the regex form of it backtracked
 *      catastrophically and hung a child for eighteen minutes).
 */

import { roleScopedMergeVerdict } from "../src/merge-landing-form.ts";
import {
  assert,
  TARGET,
  exit,
  setupLedgerPath,
  teardownLedger,
  withLedger,
} from "./merge-guard-helpers.ts";

const KW = "me" + "rge"; // assembled so this file's own text stays scannable
const NON_OPS = ["code-review-specialist", "adversarial-developer", "explore", "developer", "plan"];

/** A test filename carrying the verb — the single most-held shape in the field. */
const PROBE_FILE = `extension/smoke-tests/test-guard-role-scoped-${KW}-2125.ts`;

/**
 * Rows the CLASSIFIER holds for `ops` today and the pre-check releases for a
 * reviewer: the bare filename as a command, and a probe whose quoted body
 * names the verb. Verified against the hook, not asserted from the prose — a
 * `grep` of the same word and a heredoc writer are already read as no-merge
 * by the classifier (its own inert-write rule), so they are not the delta.
 */
/** Rows the pre-check must hold: the forms S2 names, plus the indirect shapes
 *  Rescope 2's R2 keeps held (a substitution, a runner, quoted prose).
 *
 *  `vipune add '…'` is held although it cannot merge: the scan cannot tell a
 *  landing inside an argument from one a runner will execute, so it holds
 *  both. Releasing a real landing is the failure this guard exists to prevent;
 *  holding a note that quotes the form costs one turn. */
const HELD_FORMS = [
  `gh pr ${KW} 12`,
  `gh -R o/r pr ${KW} 12 --squash`,
  `glab mr ${KW} 3`,
  `glab mr accept 3`,
  `gh api repos/o/r/pulls/5/${KW} -X PUT`,
  `git ${KW} main`,
];
/**
 * Prose that quotes the form but cannot run it: `vipune` is neither a tool
 * word nor a runner, so the scan releases it. This is the field shape the
 * issue was filed for, and the reason matching requires the tool word — a
 * plain token scan would hold `grep -rn "gh pr <kw>" .` and every note.
 */
const HELD_PROSE = [`vipune add 'gh pr ${KW} 12 is the accepted form'`];
/** R2's indirect shapes: text this scan cannot read but the shell can run. */
const HELD_INDIRECT = [
  `echo "$(gh pr ${KW} 1)" > f`,
  "echo `gh pr " + KW + " 1` > f",
  `$GH pr ${KW} 12`,
  `sh -c 'gh pr ${KW} 12'`,
  `xargs -I{} gh pr ${KW} {}`,
  // A runner whose INLINE script the scan cannot read: `-e`/`-c` text is
  // executed, so a landing can hide in it.
  `bun -e 'console.log("${KW}")'`,
];
/**
 * Rows the CLASSIFIER holds for `ops` today and the pre-check releases for a
 * reviewer — the measured delta, all verified against the real hook rather
 * than asserted from the prose: a bare verb-named path, a grep of the verb,
 * and a heredoc writer.
 */
const HELD_BY_CLASSIFIER = [
  PROBE_FILE,
  `grep -rn '${KW}' extension/smoke-tests/`,
  `cat > notes.md <<'EOF'\nthe PR was ${KW}d after the review loop\nEOF`,
];
const RELEASED = [
  ...HELD_BY_CLASSIFIER,
  ...HELD_PROSE,
  // `bun <file>` runs the file's CONTENTS, so a verb in its NAME is not an
  // executed landing — the field's most-held shape, now free.
  `bun ${PROBE_FILE}`,
];
/**
 * The subset run through the real hook as `ops`: rows the classifier reads as
 * no-merge, so a hold there can only come from the pre-check — that is what
 * makes the direction-safety assertion mean something.
 */
const CLASSIFIER_RELEASES = HELD_BY_CLASSIFIER;

/** The role is a parameter — the guard's call site reads it from the environment. */
function verdict(role: string | undefined, cmd: string): "release" | "hold" {
  return roleScopedMergeVerdict(role, cmd);
}

// ---------------------------------------------------------------- A. non-ops
for (const role of NON_OPS) {
  for (const cmd of RELEASED)
    assert(
      verdict(role, cmd) === "release",
      `${role}: released, no landing form: ${JSON.stringify(cmd.slice(0, 58))}`,
    );
  for (const cmd of [...HELD_FORMS, ...HELD_INDIRECT])
    assert(
      verdict(role, cmd) === "hold",
      `${role}: held, landing form: ${JSON.stringify(cmd.slice(0, 58))}`,
    );
}

for (const role of ["explore", "code-review-specialist", "adversarial-developer"])
  assert(
    verdict(role, PROBE_FILE) === "release",
    `${role}: the bare verb-named filename is not a landing form`,
  );

// ------------------------------------------------------------ B. ops / parent
for (const role of ["ops", "", undefined, " OPS "])
  assert(
    verdict(role, PROBE_FILE) === "hold",
    `${JSON.stringify(role)}: never released, the classifier still runs`,
  );

// ---------------------------------------------------------------- D. linearity
const HUGE = `${"x".repeat(2_000_000)} ${KW}`;
const t0 = performance.now();
const slow = verdict("explore", HUGE);
const ms = performance.now() - t0;
assert(slow === "release" && ms < 1000, `a 2 MB single line classifies in ${ms.toFixed(0)}ms`);

// ------------------------------------------- the real hook, under each role
await setupLedgerPath();

/** A review that passed for the branch under review, so a merge is permitted. */
const PASSED = [
  { branch: TARGET.headBranch, kind: "adversarial", patchId: "p1", passed: true, at: 1 },
  { branch: TARGET.headBranch, kind: "lens", patchId: "p1", passed: true, at: 2 },
] as typeof PASSED;

/**
 * Drive the real hook.
 *
 * `blocked` is the HOLD — the refusal of a command the guard could not read as
 * a merge, which is what costs a child a turn and what this issue is about.
 * `stopped` also counts a command the guard let reach the forge (a real merge,
 * reviewed or not): a permitted merge is neither blocked nor held, so an
 * assertion that conflated the two would fail on correct behaviour.
 */
async function hookAs(command: string, role: string | undefined) {
  const prev = process.env.PI_ENSEMBLE_ROLE;
  if (role === undefined) delete process.env.PI_ENSEMBLE_ROLE;
  else process.env.PI_ENSEMBLE_ROLE = role;
  let handler: ((e: unknown, c: unknown) => Promise<unknown>) | undefined;
  const calls: string[] = [];
  const fakePi = {
    on: (name: string, fn: (e: unknown, c: unknown) => Promise<unknown>) => {
      if (name === "tool_call") handler = fn;
    },
  } as never;
  const { registerMergeGuard } = await import("../src/merge-guard.ts");
  registerMergeGuard(fakePi, {
    execFn: async (cmd: string) => {
      calls.push(cmd);
      return { stdout: "{}" };
    },
  } as never);
  try {
    const r = (await withLedger(PASSED, () =>
      handler?.({ toolName: "bash", input: { command } }, undefined as never),
    )) as { block?: boolean; reason?: string } | undefined;
    return {
      blocked: r?.block === true,
      stopped: r?.block === true || calls.length > 0,
      calls: calls.length,
      reason: r?.reason ?? "",
    };
  } finally {
    if (prev === undefined) delete process.env.PI_ENSEMBLE_ROLE;
    else process.env.PI_ENSEMBLE_ROLE = prev;
  }
}

for (const role of ["explore", "code-review-specialist", "adversarial-developer"]) {
  const r = await hookAs(PROBE_FILE, role);
  assert(!r.blocked, `${role}: the hook does not hold the verb-named filename`);
}
// The shapes this issue exists for, expressed honestly. Every row of the
// replay corpus is a command the guard HELD in production, and a non-`ops`
// child now runs these. Whether the classifier would still hold one TODAY is a
// separate matter — #1559's inert-write rule has since freed some — so the
// assertion is on the child, plus the invariant that the child is never held
// where `ops` runs free.
for (const cmd of HELD_BY_CLASSIFIER) {
  const keeper = await hookAs(cmd, "ops");
  const child = await hookAs(cmd, "code-review-specialist");
  assert(!child.blocked, `a reviewer runs the field-held row: ${JSON.stringify(cmd.slice(0, 44))}`);
  assert(
    !child.blocked || keeper.blocked,
    `the child is never held where ops runs free: ${JSON.stringify(cmd.slice(0, 44))}`,
  );
}
const asParent = await hookAs(HELD_BY_CLASSIFIER[0]!, undefined);
const asParentPeer = await hookAs(HELD_BY_CLASSIFIER[0]!, "ops");
assert(
  asParent.blocked === asParentPeer.blocked,
  "the parent (role unset) gets the classifier's verdict, never the release",
);

// C. direction safety, asserted on the hook: the pre-check can only ever
// widen a release, so a child is never HELD where ops would have been allowed
// to run. The rows that make this mean something are the ones the classifier
// itself reads as no-merge — for those, ops runs free, so any hold on the
// child would be a hold this change invented.
for (const cmd of CLASSIFIER_RELEASES) {
  const child = await hookAs(cmd, "explore");
  const keeper = await hookAs(cmd, "ops");
  assert(!keeper.blocked, `the classifier itself releases ${JSON.stringify(cmd.slice(0, 40))}`);
  assert(!child.blocked, `no hold is invented for the child: ${JSON.stringify(cmd.slice(0, 40))}`);
}
// And no row the pre-check holds can be one the classifier would have let
// through untouched: for every HELD_FORMS row, ops is stopped too.
for (const cmd of [...HELD_FORMS, ...HELD_INDIRECT]) {
  const keeper = await hookAs(cmd, "ops");
  assert(
    keeper.stopped || cmd === `git ${KW} main`,
    `ops is stopped on every held form too (a reviewed git merge is permitted): ${JSON.stringify(cmd.slice(0, 40))}`,
  );
}
// No landing form is EVER released: `release` is the one verdict that returns
// from the hook before any gate runs, so holding these rows is what keeps a
// reviewer's `git merge main` inside the review gate instead of outside it.
for (const cmd of [...HELD_FORMS, ...HELD_INDIRECT])
  for (const role of NON_OPS)
    assert(
      verdict(role, cmd) === "hold",
      `${role}: a landing form is never released: ${JSON.stringify(cmd.slice(0, 40))}`,
    );
// And through the hook, a landing form reaches a gate: it refuses, consults
// the forge, or (a reviewed `git merge main`) is permitted by the guard, which
// is the guard SEEING it. What it must never do is release silently.
for (const cmd of HELD_FORMS) {
  const r = await hookAs(cmd, "developer");
  assert(
    r.stopped || cmd === `git ${KW} main`,
    `a landing form is seen by a gate: ${JSON.stringify(cmd.slice(0, 40))}`,
  );
}

teardownLedger();
console.log(`\nexit ${exit}`);
process.exit(exit);
