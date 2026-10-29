#!/usr/bin/env bun
/**
 * A seed that FAULTED hands the run back; a seed that found nothing refuses.
 *
 * `leanSeed` runs before the run exists, so it must never take the command down
 * (case (b) of `test-lean-seed-base.ts` pins that). But "never throws" and "the
 * reason belongs on the issue" are two different questions, and the seed is the
 * only place that can tell them apart: `proveBaseSha` THROWS for a git that
 * could not be asked and returns a rule for a commit that is genuinely absent,
 * so the catch in `leanSeed` is the one site that sees a fault and nothing else.
 *
 * What it marks, and what the mark costs, is the pair this file owns:
 *
 *   (n) a seed whose proof THROWS is marked `infra`, and the mark survives the
 *       thread from `leanSeed` through `handlersFor` into the `ready` handler;
 *   (o) with the mark set and an empty base, `ready` THROWS
 *       `could not seed the run's base: <why>` — the engine's handler-error path
 *       ends the run `handed-back` at exit 10 and `decline` never runs, so no
 *       not-ready comment is posted for a git the harness could not ask;
 *   (p) without the mark, the same empty base still goes the refusal route:
 *       `ready` answers `fail`, `decline` runs, the rules are recorded. The
 *       handback is for a fault, not for a repository with no mainline.
 *
 * The forge is absent (`PI_ENSEMBLE_FORGE=none`, which `originRepo` sets and
 * restores) and `decline` is a spy rather than the real poster: the case is
 * about WHICH terminal state the run reaches, and a case that posted a real
 * comment to judge it would fail for the wrong reason when the forge is down.
 */

import { handlersFor, leanSeed, readyOutcome } from "../src/lean/command.ts";
import { runLean } from "../src/lean/engine.ts";
import { makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";
import { BODY, fakeGhDir, originRepo, realGitFaultRepo, withGh, withStubForge } from "./lib/lean-seed-fixtures.ts";

const { assert, failures } = makeAssert();

// ── (o) `ready` refuses to speak for a fault. Direct call, so the throw is the
// assertion and no engine is involved: a fault-shaped base with the mark set
// throws, and the same base without it answers `fail`.
{
  const repo = originRepo();
  try {
    const gh = fakeGhDir(BODY);
    let thrown: unknown;
    let out: Awaited<ReturnType<typeof readyOutcome>> | undefined;
    try {
      out = await withGh(gh, () =>
        readyOutcome(repo.repoRoot, 4211, {
          baseSha: "",
          why: "git was killed (signal SIGKILL)",
          infra: true,
        }),
      );
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error,
      `an infra seed with an empty base throws rather than refusing (got ${JSON.stringify(out)})`,
    );
    assert(
      (thrown as Error)?.message ===
        "could not seed the run's base: git was killed (signal SIGKILL)",
      `the throw names the seed's own cause (got ${JSON.stringify((thrown as Error)?.message)})`,
    );
    assert(
      (thrown as Error)?.name === "Error",
      `the handback is a plain Error, not a typed state error (got ${JSON.stringify((thrown as Error)?.name)})`,
    );
    // The cause is CLIPPED, not interpolated raw: `why` is git's text (a first
    // stderr line, an exec message) reaching a thrown message an operator and a
    // log renderer see verbatim, so it gets the same 160-char clip
    // `unresolvedMainlineRule` applies to the same string on the refusal path.
    const longWhy = "x".repeat(400);
    let longThrown: unknown;
    try {
      await withGh(gh, () =>
        readyOutcome(repo.repoRoot, 4211, { baseSha: "", why: longWhy, infra: true }),
      );
    } catch (err) {
      longThrown = err;
    }
    assert(
      longThrown instanceof Error &&
        longThrown.message ===
          `could not seed the run's base: ${"x".repeat(160)}…`,
      `the infra handback clips the seed's cause to 160 chars (got ${JSON.stringify((longThrown as Error)?.message)})`,
    );
    // The same empty base with no mark is still a refusal the issue is told
    // about: the handback is for a fault, never for a repository that simply
    // has no mainline.
    const refusal = await withGh(gh, () =>
      readyOutcome(repo.repoRoot, 4211, {
        baseSha: "",
        why: "origin/HEAD: no such ref",
      }),
    );
    assert(
      refusal.kind === "fail" &&
        refusal.facts.failedRules.some((r) => r.includes("origin/HEAD: no such ref")),
      `an unmarked empty base still refuses with the mainline rule (got ${refusal.kind} ${JSON.stringify(refusal.facts.failedRules)})`,
    );
  } finally {
    repo.dispose();
  }
}

// ── (n)+(o) end to end: a seed whose proof throws is marked, and the run that
// is driven by it ends `handed-back` at exit 10 with no not-ready comment.
//
// The fault is produced by the object store, not by a staged `git` on PATH: a
// loose object's fanout directory at mode `000` makes BOTH of the proof's reads
// fail the way a broken store does, and `realGitFaultRepo` is the same fixture
// the `chmod 000` case in `test-lean-base-proof.ts` drives. A staged git would
// be the wrong seam here — `mainlineSha` catches every read it makes, so a
// `git` that answers nothing never reaches the proof, and the case would be
// asserting the refusal path while calling itself a fault.
{
  const skipped = process.getuid !== undefined && process.getuid() === 0;
  if (skipped) {
    console.log("- skipped (n)/(o): running as root, chmod 000 does not deny reads");
  } else {
    const faulted = realGitFaultRepo();
    if (faulted === undefined) {
      console.log("- skipped (n)/(o): no readable commit could be built in a temp repo");
    } else {
      try {
        // The repo is seeded from its OWN tip (a real commit) and then the fanout
        // is closed, so `mainlineSha` resolves and the PROOF is what fails — the
        // only route into the seed's catch. The fixture chmods during its own
        // setup, so by the time `leanSeed` runs the store is unreadable.
        const seed = await leanSeed(faulted.repoRoot);
        assert(
          seed.baseSha === "" && seed.infra === true,
          `a seed whose proof could not be answered by git is marked infra (got ${JSON.stringify(seed)})`,
        );
        assert(
          (seed.why ?? "").includes("could not verify base sha"),
          `the fault quotes the proof's own classified cause (got ${JSON.stringify(seed.why)})`,
        );
        const dir = tempDir();
        try {
          let declineRan = 0;
          const handlers = handlersFor(faulted.repoRoot, 4212, {}, seed);
          const result = await withStubForge(fakeGhDir(BODY), () =>
            runLean({
              repoRoot: dir.dir,
              issue: 4212,
              handlers: {
                ...handlers,
                decline: async () => {
                  declineRan++;
                  return { kind: "done" };
                },
              },
              seed: { version: seed.version, baseSha: seed.baseSha },
              now: () => 5,
            }),
          );
          assert(
            result.state === "handed-back" && result.code === 10,
            `a faulted seed hands the run back at exit 10 (got ${result.state} exit ${result.code})`,
          );
          assert(
            declineRan === 0,
            `the not-ready comment is never posted for a git fault (decline ran ${declineRan}×)`,
          );
          assert(
            (result.run.result?.reason ?? "").includes("could not seed the run's base"),
            `the handback reason names the seed fault (got ${JSON.stringify(result.run.result?.reason)})`,
          );
          const readyStep = result.run.steps.find((s) => s.state === "ready");
          assert(
            readyStep?.outcome?.kind === "error",
            `the ready step records the handler error rather than a refusal (got ${JSON.stringify(readyStep?.outcome)})`,
          );
        } finally {
          dir.cleanup();
        }
      } finally {
        faulted.dispose();
      }
    }
  }
}

// ── (p) the ordinary no-mainline run still ends not-ready at exit 11, with
// `decline` running: the handback must not have swallowed the refusal route.
{
  const repo = originRepo({ withOrigin: false, withLocalMain: false });
  try {
    const seed = await leanSeed(repo.repoRoot);
    assert(
      seed.baseSha === "" && seed.infra !== true,
      `a clone with no mainline seeds unmarked (got ${JSON.stringify(seed)})`,
    );
    const dir = tempDir();
    try {
      let declineRan = 0;
      const handlers = handlersFor(repo.repoRoot, 4213, {}, seed);
      const result = await withStubForge(fakeGhDir(BODY), () =>
        runLean({
          repoRoot: dir.dir,
          issue: 4213,
          handlers: {
            ...handlers,
            decline: async () => {
              declineRan++;
              return { kind: "done" };
            },
          },
          seed: { version: seed.version, baseSha: seed.baseSha },
          now: () => 6,
        }),
      );
      assert(
        result.state === "not-ready" && result.code === 11,
        `an absent mainline still ends not-ready at exit 11 (got ${result.state} exit ${result.code})`,
      );
      assert(
        declineRan === 1,
        `the refusal is still reported on the issue (decline ran ${declineRan}×)`,
      );
      const rules = result.run.steps.find((s) => s.state === "ready")?.outcome?.failedRules ?? [];
      assert(
        rules.some((r) => r.includes("could not resolve the mainline sha")),
        `the recorded rules still name the mainline (got ${JSON.stringify(rules)})`,
      );
    } finally {
      dir.cleanup();
    }
  } finally {
    repo.dispose();
  }
}

process.exit(failures());
