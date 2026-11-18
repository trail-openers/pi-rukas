#!/usr/bin/env bun
/**
 * The adversarial verdict re-ask's production spawn, on the arms where it CANNOT
 * be assembled or CANNOT be started.
 *
 * `test-adversarial-verdict-reask-spawn.ts` pins the child that comes UP — its
 * argv, its env, its cwd, and what a killed child may answer. This file pins the
 * other direction, which is the whole contract of `spawnVerdictReaskChild` and
 * its one caller: **every way a re-ask can fail is a `ReaskOutcome`, never an
 * exception.** An fs fault sits inside `withOperatorConfigGuard`'s own window and
 * a rejecting seam sits on the injected function; either one escaping propagates
 * through `reaskRoundOnce` into the round body and ENDS THE LOOP, where the round
 * was supposed to fall back to the infrastructure failure it already had.
 *
 * The three ways the prompt file is prepared (`readFile` of the role prompt,
 * `mkdtemp`, `writeFile`) and the way the child is started are each forced to
 * fail by making their target unreachable — no `node:fs` mock, because the ESM
 * namespace is read-only under bun and a mock that could not be installed would
 * report a pass for the wrong reason. Driving the real syscalls keeps each arm
 * honest about which call actually failed.
 *
 * The arms also pin the OPPOSITE direction — that the catch is not a blanket one:
 * a child that runs and prints nothing must still answer `no-answer`, and a
 * failure the round is meant to see must reach the trace with the error that
 * caused it.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ReaskOutcome } from "../src/adversarial-verdict-reask-child.ts";
import { spawnVerdictReaskChild } from "../src/adversarial-verdict-reask-child.ts";
import { VERDICT_REASK_SOURCE_TAG } from "../src/adversarial-verdict-reask-constants.ts";
import {
  adversarialVerdictReaskEnabled,
  reaskRoundVerdict,
} from "../src/adversarial-verdict-reask.ts";
import { _resetPiBinaryCache } from "../src/pi-binary-resolve.ts";
import { isReviewerRole } from "../src/review-bounds.ts";
import { ROLES } from "../src/roles.ts";
import { NOOP_TALLY, createReaskSpawnStage } from "./lib/adversarial-reask-spawn-fixtures.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const { SESSION, REVIEW_TREE, dir, reviewerRound, dispose } =
  createReaskSpawnStage("reask-spawn-fail");
const tally = NOOP_TALLY;

/** One ask driven with a forced fs fault, and everything the harness saw. */
type Arm = {
  name: string;
  role: string;
  tmpdir: string;
  /** The substring the trace line must carry to name the failing call. `""` for an
   * arm that never reached an fs call and so has no error to name. */
  want: string;
  /** A `PI_ENSEMBLE_PI_BIN` to name for this arm (the "will not start" case). */
  piBin?: string;
  /** A `PI_ENSEMBLE_PROMPTS_DIR` to name for this arm. */
  promptsDir?: string;
};

const realWrite = process.stderr.write.bind(process.stderr);

/** What one forced-failure arm produced: the exception it must not have thrown,
 * the outcome it must have returned, and the trace line that names the cause. */
type ArmResult = { threw?: string; outcome?: ReaskOutcome; trace: string };

try {
  // ── (16) an fs failure in the prompt-file write is an OUTCOME, not a throw ─
  // A role `spawnSpecialist` could never dispatch: no `ROLES` entry and no reviewer
  // standing, so both of `writeReviewerPromptFile`'s pre-fs refusals are exercised
  // by one arm — and, because the prompt directory is fixed at module load, it is
  // the only way to reach them without editing a role's prompt out from under the
  // rest of the suite.
  const unknownRole = "not-a-role-at-all";
  const denyMkdtemp = path.join(dir, "ro-tmp");
  mkdirSync(denyMkdtemp, { recursive: true });
  chmodSync(denyMkdtemp, 0o500);

  const arms: Arm[] = [
    {
      // Both pre-fs refusals return `undefined` — "this role has no business being
      // re-asked" — and the caller maps that to the same `spawn-failed` outcome with
      // NO trace line, because there was no error to name.
      name: "a role with no prompt to read",
      role: unknownRole,
      tmpdir: dir,
      want: "",
    },
    {
      name: "a refused mkdtemp",
      role: "adversarial-developer",
      tmpdir: denyMkdtemp,
      want: "mkdtemp",
    },
    {
      // A child that cannot be started at all: `getPiInvocation` is pointed at a
      // binary that does not exist, so the settle reports the `error` event that no
      // `exit` ever follows. Distinguishes a real catch from a blanket one — an
      // over-broad `try` that swallowed the settle too would report this child as
      // `spawn-failed` and pass.
      name: "a pi binary that will not start",
      role: "adversarial-developer",
      tmpdir: dir,
      want: "PI_ENSEMBLE_PI_BIN",
      piBin: path.join(dir, "no-such-pi"),
    },
  ];

  const results: Array<{ arm: Arm } & ArmResult> = [];
  for (const arm of arms) {
    const captured: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured.push(chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    let threw: string | undefined;
    let outcome: ReaskOutcome | undefined;
    try {
      await withEnv(
        {
          TMPDIR: arm.tmpdir,
          PI_ENSEMBLE_DEBUG: "1",
          // No stub `pi` unless the arm names one: with none set, a prompt write
          // that SUCCEEDED would resolve a real binary and spawn it, so a pass here
          // cannot come from a stubbed child that never reached the fs calls.
          PI_ENSEMBLE_PI_BIN: arm.piBin ?? undefined,
          ...(arm.promptsDir === undefined ? {} : { PI_ENSEMBLE_PROMPTS_DIR: arm.promptsDir }),
        },
        async () => {
          // The binary is cached at first resolve, so an arm naming a different one
          // has to drop the cache or it silently re-runs the previous arm's stub —
          // the shape of pass that means nothing.
          _resetPiBinaryCache();
          try {
            outcome = await spawnVerdictReaskChild({
              transcriptPath: SESSION,
              role: arm.role,
              model: "reviewer-model-1",
              cwd: REVIEW_TREE,
              boundMs: 5_000,
              prompt: "reply with the verdict line",
            });
          } catch (err) {
            threw = err instanceof Error ? err.message : String(err);
          } finally {
            // Restore the root and any re-ask dir left in it: a 0500 entry under the
            // suite's own temp tree makes this file's final cleanup fail with EACCES
            // and takes the whole run down as an unhandled error.
            try {
              chmodSync(arm.tmpdir, 0o700);
              for (const name of readdirSync(arm.tmpdir)) {
                if (name.startsWith("pi-rukas-reask-")) {
                  chmodSync(path.join(arm.tmpdir, name), 0o700);
                }
              }
            } catch {
              /* the arm's own failure may have left no root to restore */
            }
          }
        },
      );
    } finally {
      process.stderr.write = realWrite;
    }
    results.push({
      arm,
      ...(threw === undefined ? {} : { threw }),
      ...(outcome === undefined ? {} : { outcome }),
      trace: captured.find((c) => c.includes(VERDICT_REASK_SOURCE_TAG)) ?? "",
    });
  }

  for (const r of results) {
    assert(
      r.threw === undefined,
      `(16) ${r.arm.name} THROWS nothing out of the child (${JSON.stringify(r.threw)})`,
    );
    assert(
      r.outcome !== undefined && r.outcome.ok === false && r.outcome.reason === "spawn-failed",
      `(16) ${r.arm.name} lands on the spawn-failed outcome the round already falls back from (${JSON.stringify(r.outcome)})`,
    );
    // An arm with no `want` never reached an fs call and so has no error to name.
    assert(
      r.arm.want === "" ||
        (r.trace.includes(VERDICT_REASK_SOURCE_TAG) && r.trace.includes(r.arm.want)),
      `(16) ${r.arm.name} is traced with the error that caused it (${JSON.stringify(r.trace.slice(0, 180))})`,
    );
  }
  assert(
    results.every((r) => r.outcome !== undefined || r.threw !== undefined),
    `(16) canary: every arm reached the child and got an answer back (${String(
      results.filter((r) => r.outcome === undefined && r.threw === undefined).length,
    )} arm(s) settled on nothing at all)`,
  );
  assert(
    !isReviewerRole(unknownRole) && (ROLES as Record<string, unknown>)[unknownRole] === undefined,
    `(16) canary: the un-dispatchable role really has no prompt entry and no reviewer standing (${unknownRole})`,
  );

  // The arm no in-process env can reach: a REVIEWER role whose prompt file cannot
  // be read. `roles.ts` resolves `PI_ENSEMBLE_PROMPTS_DIR` at IMPORT time, so
  // pointing it at an empty directory means loading the child module in a process
  // that had the variable before its first import — the same shape
  // `test-AC1-reviewer-probe-hygiene-prompt.ts` uses for a build. The child prints
  // one JSON line, so a throw there reads as a crash rather than a pass.
  const promptsOff = path.join(dir, "prompts-off");
  mkdirSync(promptsOff, { recursive: true });
  const childScript = path.join(dir, "prompt-read-arm.ts");
  const childModule = path.join(
    path.resolve(import.meta.dirname, ".."),
    "src",
    "adversarial-verdict-reask-child.ts",
  );
  writeFileSync(
    childScript,
    [
      // Absolute: the specifier resolves against the CHILD script's own path, which
      // sits under a temp root, so a relative one would resolve inside that tree and
      // fail to load — a pass-shaped crash.
      `import { spawnVerdictReaskChild } from ${JSON.stringify(childModule)};`,
      "const [sess, cwd, tmp] = process.argv.slice(2);",
      "const out = await spawnVerdictReaskChild({",
      "  transcriptPath: sess,",
      '  role: "adversarial-developer",',
      '  model: "reviewer-model-1",',
      "  cwd,",
      "  boundMs: 5_000,",
      '  prompt: "reply with the verdict line",',
      "});",
      "process.stdout.write(JSON.stringify({ ok: out.ok, reason: out.ok ? null : out.reason }));",
    ].join("\n"),
  );
  let readArm: { ok?: boolean; reason?: string | null; crashed?: string } = {};
  let readArmStderr = "";
  try {
    const child = spawnSync(process.execPath, [childScript, SESSION, REVIEW_TREE, dir], {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        TMPDIR: dir,
        PI_ENSEMBLE_DEBUG: "1",
        PI_ENSEMBLE_PI_BIN: "",
        PI_ENSEMBLE_PROMPTS_DIR: promptsOff,
      },
    });
    readArmStderr = child.stderr ?? "";
    try {
      readArm = JSON.parse(child.stdout) as { ok?: boolean; reason?: string | null };
    } catch {
      readArm = { crashed: `${child.status ?? child.signal}: ${child.stderr.slice(0, 200)}` };
    }
  } catch (err) {
    readArm = { crashed: err instanceof Error ? err.message : String(err) };
  }
  assert(
    readArm.crashed === undefined,
    `(16) an unreadable role prompt THROWS nothing out of the child (${JSON.stringify(readArm.crashed)})`,
  );
  assert(
    readArm.ok === false && readArm.reason === "spawn-failed",
    `(16) an unreadable role prompt lands on the spawn-failed outcome the round already falls back from (${JSON.stringify(readArm)})`,
  );
  assert(
    readArmStderr.includes(VERDICT_REASK_SOURCE_TAG) && readArmStderr.includes("ENOENT"),
    `(16) an unreadable role prompt is traced with the error that caused it (${JSON.stringify(readArmStderr.slice(0, 180))})`,
  );
  assert(
    readdirSync(promptsOff).length === 0 &&
      !readdirSync(promptsOff).includes("adversarial-developer.md"),
    `(16) canary: the redirected prompt directory really is empty, so the reviewer's prompt file really could not be read (${String(readdirSync(promptsOff).length)} entries)`,
  );

  // ── (17) the re-ask's temp dir is removed on every arm ────────────────────
  // `mkdtemp` made a `pi-rukas-reask-*` dir per ask and nothing removed it: a /tmp
  // of role prompts left behind by every round whose verdict was unreadable.
  // Success, the bound and the pre-child refusal must each clean up.
  const sweepRoot = path.join(dir, "sweep-root");
  mkdirSync(sweepRoot, { recursive: true });
  const sweepTmp = path.join(sweepRoot, "tmp");
  mkdirSync(sweepTmp, { recursive: true });
  const countPromptDirs = (): number =>
    readdirSync(sweepTmp).filter((n) => n.startsWith("pi-rukas-reask-")).length;
  const sweepPi = path.join(dir, "pi-sweep.sh");
  const answerLine = JSON.stringify({
    type: "agent_end",
    messages: [{ role: "assistant", content: [{ type: "text", text: "VERDICT: APPROVED" }] }],
  });
  writeFileSync(sweepPi, `#!/bin/sh\ncat "$1" >/dev/null 2>&1 || true\ncat\n`, { mode: 0o755 });
  chmodSync(sweepPi, 0o755);
  const driveAsk = async (opts: { hang: boolean; boundMs: number }): Promise<void> => {
    // The hang arm prints nothing and lingers: the ONLY way it ends is the bound.
    writeFileSync(
      sweepPi,
      [
        "#!/bin/sh",
        'cat "$1" >/dev/null 2>&1 || true',
        "cat",
        `printf '%s\\n' ${JSON.stringify(answerLine)}`,
        ...(opts.hang ? ["sleep 2"] : []),
      ].join("\n"),
      { mode: 0o755 },
    );
    chmodSync(sweepPi, 0o755);
    await withEnv({ TMPDIR: sweepTmp, PI_ENSEMBLE_PI_BIN: sweepPi }, async () => {
      _resetPiBinaryCache();
      await spawnVerdictReaskChild({
        transcriptPath: SESSION,
        role: "adversarial-developer",
        model: "reviewer-model-1",
        cwd: REVIEW_TREE,
        boundMs: opts.boundMs,
        prompt: "reply with the verdict line",
      });
    });
  };
  // The bound arm first: a child that never exits is the arm a `finally` is easiest
  // to lose, and it runs while a working temp root still exists to fail loudly on.
  await driveAsk({ hang: true, boundMs: 300 });
  const leakedAfterKill = countPromptDirs();
  await driveAsk({ hang: false, boundMs: 5_000 });
  const leakedAfterAnswer = countPromptDirs();
  const missingSession = await spawnVerdictReaskChild({
    transcriptPath: path.join(sweepRoot, "never-written.json"),
    role: "adversarial-developer",
    cwd: REVIEW_TREE,
    boundMs: 5_000,
    prompt: "reply with the verdict line",
  });
  const leakedAfterRefusal = countPromptDirs();
  assert(
    leakedAfterKill === 0 && leakedAfterAnswer === 0 && leakedAfterRefusal === 0,
    `(17) no pi-rukas-reask-* dir survives the child: ${String(leakedAfterKill)} after a bound kill, ${String(leakedAfterAnswer)} after an answer, ${String(leakedAfterRefusal)} after a refusal`,
  );
  assert(
    missingSession.ok === false && missingSession.reason === "no-session",
    `(17) and the refusal that never wrote a dir is still an outcome (${JSON.stringify(missingSession)})`,
  );

  // ── (18) a re-ask that THROWS is contained, not thrown at the caller ──────
  // `reaskRoundVerdict` is the loop's one call into the re-ask; an exception past it
  // takes the round down rather than falling back. The seam is an injected function,
  // so neither its rejection nor its fulfilment value is the child's to validate.
  const rejecting = await reaskRoundVerdict(
    reviewerRound(),
    3,
    tally,
    () => Promise.reject(new Error("seam exploded")),
    "job-reask-rejects",
    REVIEW_TREE,
  );
  assert(
    rejecting === undefined,
    `(18) a rejecting re-ask seam returns undefined, the same as an absent answer (${JSON.stringify(rejecting)})`,
  );
  assert(
    adversarialVerdictReaskEnabled() === true,
    "(18) canary: the switch was on, so this really drove the re-ask path",
  );
  const malformed: Array<[string, () => Promise<unknown>]> = [
    ["undefined", async () => undefined],
    ["null", async () => null],
    ["a bare string", async () => "VERDICT: APPROVED"],
    ["an answer with no text", async () => ({ ok: true })],
    ["a reasonless failure", async () => ({ ok: false })],
  ];
  for (const [name, seam] of malformed) {
    let threw: string | undefined;
    let recovered: Awaited<ReturnType<typeof reaskRoundVerdict>>;
    try {
      recovered = await reaskRoundVerdict(
        reviewerRound(),
        1,
        tally,
        seam as never,
        "job-reask-malformed",
        REVIEW_TREE,
      );
    } catch (err) {
      threw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    assert(
      threw === undefined && recovered === undefined,
      `(18) a seam that fulfils with ${name} is contained as no-answer, not thrown at the round (${JSON.stringify(threw)} / ${JSON.stringify(recovered)})`,
    );
  }
  // And the direction that must NOT be swallowed: a child that really runs over a
  // transcript whose bytes are not an RPC stream answers `no-answer`, because a
  // catch broad enough to make that `spawn-failed` is a catch that hides a real
  // stream fault.
  const garbage = path.join(dir, "garbage-session.json");
  writeFileSync(garbage, "\u0000\u0000 not json \u0000\n");
  const garbagePi = path.join(dir, "pi-garbage.sh");
  writeFileSync(garbagePi, '#!/bin/sh\ncat "$1" >/dev/null 2>&1 || true\ncat\n', { mode: 0o755 });
  chmodSync(garbagePi, 0o755);
  let childThrew: string | undefined;
  let childOutcome: ReaskOutcome | undefined;
  await withEnv({ PI_ENSEMBLE_PI_BIN: garbagePi }, async () => {
    _resetPiBinaryCache();
    try {
      childOutcome = await spawnVerdictReaskChild({
        transcriptPath: garbage,
        role: "adversarial-developer",
        model: "reviewer-model-1",
        cwd: REVIEW_TREE,
        boundMs: 5_000,
        prompt: "reply with the verdict line",
      });
    } catch (err) {
      childThrew = err instanceof Error ? err.message : String(err);
    }
  });
  assert(
    childThrew === undefined &&
      childOutcome !== undefined &&
      childOutcome.ok === false &&
      childOutcome.reason === "no-answer",
    `(18) the production child over a transcript of garbage settles to an outcome instead of throwing (${JSON.stringify(childThrew)} / ${JSON.stringify(childOutcome)})`,
  );
} finally {
  for (const leftover of [path.join(dir, "ro-tmp"), path.join(dir, "sweep-root")]) {
    try {
      chmodSync(leftover, 0o700);
    } catch {
      /* already gone */
    }
  }
  dispose();
}

console.log(
  `\nre-ask spawn failure ${failures() === 0 ? "green" : "RED"} (${String(failures())} failing)`,
);
process.exit(failures());
