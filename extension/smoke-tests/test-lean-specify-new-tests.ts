#!/usr/bin/env bun
/**
 * lean/specify — a frozen acceptance test must be a NEW file (`specify` side).
 *
 * The `submit_tests` boundary checks a path exists in the worktree, but the
 * child works in a checkout of the run's base, so `exists` on its own cannot
 * tell "the child wrote this" from "git put it there". That gap is how the
 * adversary can (and did) freeze a test it never wrote, twice over: name a
 * tracked project test, or overwrite one. Both are refused against the base
 * commit — the one commit the child cannot move — and the git read behind that
 * rule is `existsInCommit`, pinned unit-wise by `test-lean-exists-in-commit.ts`
 * and judged here on the real step, in a real repo, where "refused" means the
 * file was never frozen and never committed.
 *
 * Four arms, and the fourth is the one that makes the other three mean
 * something: a run that refuses everything would pass the first three.
 *
 *   (n1) the child submits a tracked test it never opened → `no-red-test`, the
 *        newness reason, nothing committed, the project's own bytes intact;
 *   (n2) the child OVERWRITES a tracked test and submits it → same refusal, and
 *        the base's bytes still stand in the commit (the boundary never needs to
 *        see the child's bytes to know the path is not its to freeze);
 *   (n3) a genuinely new file in the same folder and config → freezes, as before;
 *   (n4) both in ONE call → the new file freezes, the tracked one is refused,
 *        and the criterion is covered by the survivor. The rule is per path.
 *
 * The `challenge` half of the same rule — where the ref that gets read is the
 * subtler one, because the round proves red against the HEAD — is in
 * `test-lean-challenge-new-tests.ts`. Shared fixture: lib/lean-specify-fixture.ts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  ROOTS,
  configWithLocation,
  git,
  makeRepo,
  redScript,
  runSpecify,
  submit,
} from "./lib/lean-specify-fixture.ts";
import { assert, testLocationExit } from "./lib/lean-test-location-fixture.ts";

// ─────── (n) a submitted test must be NEW: an existing tracked test is refused
//
// `exists` asks about the working tree, and the child works in a checkout of the
// base — so on its own it accepts the two reproductions the adversary can (and
// did) produce: name an existing green project test nobody wrote, or overwrite
// one. Both are refused here against the run's base commit, which the child
// cannot move, and in both arms the run freezes NOTHING: a test the child did not
// write is not a falsification of the spec, and a test of the project's own that
// happens to exit non-zero is worse, because it becomes the contract the builder
// is measured against for the rest of the run.
{
  // The project's own green test, tracked at the base, matching the configured
  // folder and name pattern — the shape with every incentive to be submitted.
  const TRACED = "extension/smoke-tests/test-project-existing.ts";
  const repo = makeRepo({
    "src/retry.ts": "export const retry = () => {};\n",
    [TRACED]: "// the project's own test, already green, already tracked\n",
  });
  // (n1) the child never opened it: it just found it in the tree and declared it.
  const untouched = await runSpecify({
    repoRoot: repo.repoRoot,
    baseSha: repo.baseSha,
    issue: 1891,
    config: configWithLocation("extension/smoke-tests", "test-*.ts"),
    writes: () => {},
    toolUses: [submit("AC1", [TRACED])],
  });
  assert(
    untouched.threw === undefined,
    `(specify) submitting an existing tracked test is a VERDICT, not infra (${untouched.threw?.message})`,
  );
  assert(
    untouched.outcome?.kind === "no-red-test",
    `(specify) an existing tracked test freezes nothing → no-red-test (got ${untouched.outcome?.kind})`,
  );
  assert(
    (untouched.outcome?.reason ?? "").includes(
      `${TRACED} already exists at the base commit; a new acceptance test must be a new file`,
    ),
    `(specify) the reason is the newness sentence, naming the file (got ${untouched.outcome?.reason})`,
  );
  assert(
    git(untouched.worktree, "rev-list", "--count", "HEAD").trim() === "1",
    `(specify) nothing was committed — the tree holds only its base (got ${git(untouched.worktree, "rev-list", "--count", "HEAD")})`,
  );
  assert(
    git(untouched.worktree, "show", `HEAD:${TRACED}`).includes("already green") === true,
    "(specify) the project's own test is untouched in the commit, byte for byte",
  );

  // (n2) the child OVERWROTE the tracked test with a red script and declared it.
  // Same refusal: the boundary never sees the bytes and does not need to.
  const overwritten = await runSpecify({
    repoRoot: repo.repoRoot,
    baseSha: repo.baseSha,
    issue: 1892,
    config: configWithLocation("extension/smoke-tests", "test-*.ts"),
    writes: (wt) => {
      mkdirSync(path.join(wt, "extension/smoke-tests"), { recursive: true });
      writeFileSync(path.join(wt, TRACED), redScript(), { mode: 0o755 });
    },
    toolUses: [submit("AC1", [TRACED])],
  });
  assert(
    overwritten.outcome?.kind === "no-red-test" &&
      (overwritten.outcome.reason ?? "").includes("already exists at the base commit") === true,
    `(specify) an OVERWRITTEN tracked test gets the same refusal as an untouched one (got ${overwritten.outcome?.kind} / ${overwritten.outcome?.reason})`,
  );
  assert(
    git(overwritten.worktree, "show", `HEAD:${TRACED}`).includes("already green") === true,
    "(specify) the child's rewrite did not reach the commit — the base's bytes still stand",
  );

  // (n3) the control: a genuinely new file in the same folder, same config, and
  // the run freezes it. Without this arm the two above could be "refuse all".
  const fresh = await runSpecify({
    repoRoot: repo.repoRoot,
    baseSha: repo.baseSha,
    issue: 1893,
    config: configWithLocation("extension/smoke-tests", "test-*.ts"),
    writes: (wt) => {
      mkdirSync(path.join(wt, "extension/smoke-tests"), { recursive: true });
      writeFileSync(path.join(wt, "extension/smoke-tests/test-ac1-new.ts"), redScript(), {
        mode: 0o755,
      });
    },
    toolUses: [submit("AC1", ["extension/smoke-tests/test-ac1-new.ts"])],
  });
  assert(
    fresh.outcome?.kind === "ok" &&
      Object.keys(fresh.outcome.frozen ?? {}).join() === "extension/smoke-tests/test-ac1-new.ts",
    `(specify) a file the child actually created still freezes (got ${JSON.stringify(fresh.outcome)})`,
  );
  // (n4) both in ONE call: the new file survives, the tracked one is refused, and
  // the criterion is covered by the survivor — the rule is per path, not per row.
  const mixed = await runSpecify({
    repoRoot: repo.repoRoot,
    baseSha: repo.baseSha,
    issue: 1894,
    config: configWithLocation("extension/smoke-tests", "test-*.ts"),
    writes: (wt) => {
      mkdirSync(path.join(wt, "extension/smoke-tests"), { recursive: true });
      writeFileSync(path.join(wt, "extension/smoke-tests/test-ac1-mixed.ts"), redScript(), {
        mode: 0o755,
      });
    },
    toolUses: [submit("AC1", [TRACED, "extension/smoke-tests/test-ac1-mixed.ts"])],
  });
  assert(
    mixed.outcome?.kind === "ok" &&
      Object.keys(mixed.outcome.frozen ?? {}).join() ===
        "extension/smoke-tests/test-ac1-mixed.ts" &&
      (mixed.outcome.reason ?? "").includes("already exists at the base commit") === true,
    `(specify) one call keeps the new file and refuses the tracked one, with the reason carried (got ${JSON.stringify(mixed.outcome)})`,
  );
}
for (const dir of ROOTS) {
  try {
    (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

console.log(
  testLocationExit() === 0 ? "\nA specify round's acceptance tests must be new." : "\nFAILED",
);
process.exit(testLocationExit());
