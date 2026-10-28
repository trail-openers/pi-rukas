/**
 * work-driver-toolchain-canary — does the pinned type-checker actually judge
 * anything? (#1879)
 *
 * The bug this closes: a read-only reviewer child overwrote the shared
 * `extension/node_modules/typescript/bin/tsc` (and `lib/tsc.js`) with a
 * `sleep 9.5; exit 0` stub. Every local typecheck — the develop gate, the ci
 * tier, the cap checkpoint's `typecheckWorktree` and `.pi/verify-cmd*` — then
 * exited 0 on any tree for about eleven minutes. The gates did not fail; they
 * reported a verdict the compiler never formed, and the pipeline had no way to
 * tell a green from a stub.
 *
 * The rule the whole module rests on: **a check that cannot fail cannot
 * pass.** Before any tier is trusted as GREEN, the driver runs the same
 * compiler, from the same cwd, on a file containing one known type error
 * written OUTSIDE the repository. The compiler must exit non-zero AND print a
 * `TS2322` diagnostic. A compiler that accepts `const x: number = "no"` has
 * judged nothing, and its green means nothing.
 *
 * Three deliberate boundaries:
 *
 *   - **The pinned spelling only.** A verify command is canaried exactly when it
 *     contains {@link LOCAL_TSC_CMD} — the one spelling the driver prescribes for
 *     the compiler (`node node_modules/typescript/bin/tsc`, defined in
 *     work-driver-cap-checkpoint-typecheck.ts and read through the module, never
 *     copied into a literal here). A project whose typecheck is spelled otherwise
 *     is not canaried: this is a rule about the driver's own convention, not a
 *     general compiler auditor.
 *
 *     The import is TYPE-of-load-time, not module-scope: this module sits between
 *     work-driver-explain (which imports the park's advice constant) and the
 *     checkpoint's typecheck module, so every read of the spelling happens inside
 *     a function. A module-scope template over it is a real TDZ reference —
 *     `bun smoke-tests/test-toolchain-canary-1879.ts` is the detector.
 *
 *   - **Per-process cache keyed by the compiler's identity**, not its name:
 *     realpath of the entry file plus its mtime and size, and bounded by age.
 *     A stub swap changes at least one of the three, so a canary never goes
 *     stale across a reinstall or a re-clobber; two identical calls in one
 *     process pay once. The age bound exists because the identity alone does
 *     not: `bin/tsc` is a launcher that loads `lib/tsc.js`, and the #1879
 *     incident clobbered BOTH files — a swap that leaves the entry file itself
 *     untouched changes no mtime and no size, and an unbounded cache would
 *     carry the old verdict for the life of a long driver process. A cached
 *     verdict older than {@link CANARY_CACHE_MAX_AGE_MS} is re-probed.
 *
 *   - **Never writes inside the repo.** The canary file lives under
 *     `os.tmpdir()`, because a type error committed into the tree it is
 *     verifying would fail the very gate it exists to validate.
 *
 *   - **No compiler, no judgement.** When the pinned entry file does not exist
 *     under the cwd the canary answers {@link CANARY_NOT_JUDGED} and the tier
 *     runs unchanged: a missing `node_modules` is not a tampered compiler, and
 *     the typecheck itself fails on a missing binary anyway ("could not run").
 *     The canary blocks only what it actually observed — a compiler that was
 *     there and accepted the known error. The call sites that must not report a
 *     verdict at all (the cap checkpoint) still treat an unasked question as
 *     "could not run", never as a pass.
 *
 * Failure is not a verify failure: {@link TOOLCHAIN_UNSOUND_LABEL} marks the
 * park as `toolchain-unsound`, a cap of its own, so an operator is told to
 * reinstall dependencies rather than to look at a diff that may be fine. The
 * escape hatch `PI_ENSEMBLE_TOOLCHAIN_CANARY=0` skips the check — and says so
 * in the notes, rather than going silent.
 */

import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withVerifySlot } from "./host-resources.ts";
import { trace } from "./trace.ts";
import { LOCAL_TSC_CMD } from "./work-driver-cap-checkpoint-typecheck.ts";
import type { DriverExecFn } from "./work-driver-context.ts";
import { verifyChildEnv } from "./work-driver-verify-cmd.ts";

/**
 * Marker on the failure string the cap router keys on. A canary failure is
 * never routed to `verify-failed:<step>`: the code was not indicted, the
 * compiler was.
 */
export const TOOLCHAIN_UNSOUND_LABEL = "[toolchain-unsound]";

/** The one type error the canary file contains — an assignment the type system must refuse. */
const CANARY_SOURCE = 'const x: number = "no";\n';

/** The diagnostic that error's code. Printed by the real compiler as TS2322. */
const CANARY_DIAGNOSTIC = "TS2322";

/** The values that turn the escape hatch off, matching every other hatch. */
const DISABLED_VALUES = new Set(["0", "false", "off", "no"]);

/** The operator-facing reason a canary park carries (also the `explainCap` advice). */
export const TOOLCHAIN_UNSOUND_ADVICE =
  "The type-checker accepted a file with a known type error, so a green typecheck proves nothing. Reinstall dependencies (`bun install --frozen-lockfile --force` in the package directory) and restart the cycle.";

/**
 * The note the gate records when the canary could not be asked at all — the
 * operator turned it off, or there was no compiler under that cwd to ask.
 */
export const CANARY_SKIPPED_NOTE = "compiler integrity not checked";

/**
 * #1879 fix round (H3) — the answer a tier gets when there is no compiler to
 * ask: {@link CANARY_NOT_JUDGED}, not a failure. The develop and ci tiers let
 * the command run unchanged, because a missing compiler is an absent
 * dependency tree — not a stub substituted for one — and the tier's own
 * command fails on it anyway (node reports `Cannot find module`, which the
 * checkpoint's classifier already reads as "could not run").
 *
 * A tier must never turn this into a park: the operator's problem would be an
 * uninstalled `node_modules`, and the advice for that is a reinstall the tier
 * itself already says with its own ENOENT.
 */
export const CANARY_NOT_JUDGED = "not judged";

/** What the canary observed about the compiler it was pointed at. */
export type CanaryOutcome =
  /** The compiler rejected the known error with the expected diagnostic. */
  | { ok: true }
  /** The compiler accepted it, or rejected it for a reason that is not the diagnostic. */
  | { ok: false; why: string }
  /** The canary could not ask the question. Never reported as a pass or a failure. */
  | { ok: undefined; why: string };

/**
 * Is the canary enabled? `PI_ENSEMBLE_TOOLCHAIN_CANARY=0` turns it off.
 *
 * The vocabulary is the repo's shared one — `0`, `false`, `off`, `no`, trimmed
 * and lower-cased — the same set `consolidatedVerifySkipEnabled` and
 * `gateReuseEnabled` accept, so an operator who writes `off` on one hatch gets
 * it honoured on every hatch. A malformed value keeps the canary ON: the safe
 * side is the one that runs the check.
 *
 * Reads the parent env the way every other escape hatch in the driver does
 * (compare `transientRetryEnabled`) rather than taking the whole environment as
 * an optional parameter: this module's answer is consulted inside verify gates
 * whose child envs the driver scrubs, and the env-inheritance gate
 * (test-verify-child-env-paths.ts) refuses a whole-environment default outright
 * so it can never become one.
 */
export function toolchainCanaryEnabled(): boolean {
  const raw = process.env.PI_ENSEMBLE_TOOLCHAIN_CANARY;
  if (raw === undefined) return true;
  return !DISABLED_VALUES.has(raw.trim().toLowerCase());
}

/** Does this verify command invoke the pinned compiler spelling? */
export function usesPinnedCompiler(cmd: string): boolean {
  return cmd.includes(LOCAL_TSC_CMD);
}

/**
 * The compiler entry file the pinned spelling would load from `cwd`, lexically.
 * `LOCAL_TSC_CMD` is `node node_modules/typescript/bin/tsc`, so the last word
 * is the script — the one word that resolves against the cwd.
 */
function compilerEntryPath(cwd: string): string {
  const script = LOCAL_TSC_CMD.split(" ").pop() as string;
  return path.resolve(cwd, script);
}
/**
 * The cache key: realpath of the entry file, plus its mtime and size. The
 * realpath follows the provisioned `node_modules` links, so the key names the
 * MAIN checkout's file — the tree every worktree links to, and the one the
 * incident clobbered. A swap of the file changes mtime or size; a swap of the
 * tree changes the realpath. Any read failure yields no key, and a result with
 * no key is never cached (an unknown must not be remembered as a verdict).
 */
async function compilerIdentity(entry: string): Promise<string | undefined> {
  try {
    const real = await fs.realpath(entry);
    const st = await fs.stat(real);
    if (!st.isFile()) return undefined;
    return `${real}\u0000${st.mtimeMs}\u0000${st.size}`;
  } catch {
    return undefined;
  }
}

/**
 * The private directory the canary files live in: one per process, mode 0700,
 * under the OS temp dir. A predictable name in the shared temp dir is a
 * symlink target for any other uid on the host — `writeFile` follows it and the
 * canary becomes a write primitive outside the tree. `mkdtemp` makes the name
 * unguessable and refuses to reuse one that exists; the mode is the one `mkdir`
 * would have given anyway (the process umask widens it, hence the explicit
 * `chmod`), so nobody else can read or replace what is compiled.
 */
/**
 * The prefix of the private per-process canary directory. Exported so the test
 * can name the directory it expects without copying the literal and drifting.
 */
export const CANARY_DIR_PREFIX = "pi-rukas-canary-";

let canaryDir: Promise<string> | undefined;
/** One removal handler for the whole process, however many probes asked. */
let canaryDirCleanupArmed = false;
function canaryDirOnce(): Promise<string> {
  if (canaryDir === undefined) {
    canaryDir = fs
      .mkdtemp(path.join(os.tmpdir(), CANARY_DIR_PREFIX))
      .then(async (dir) => {
        await fs.chmod(dir, 0o700).catch(() => undefined);
        // The probe deletes each file it writes, but a process killed mid-probe
        // would leave the directory (and the file in it) in the shared temp dir
        // for the life of the host. One `exit` handler, armed once, sweeps it.
        if (!canaryDirCleanupArmed) {
          canaryDirCleanupArmed = true;
          process.once("exit", () => {
            try {
              fsSync.rmSync(dir, { recursive: true, force: true });
            } catch {
              // A temp dir that will not go away is not a reason to fail a run.
            }
          });
        }
        return dir;
      })
      .catch((err) => {
        // A failed creation is not a verdict about the compiler — but it must
        // not be retried forever on a temp dir that will not be made either.
        canaryDir = undefined;
        throw err;
      });
  }
  return canaryDir;
}

/** The canary file, in that private dir: outside every repository it might verify. */
async function canaryPath(runId: string): Promise<string> {
  // The basename leads with `canary`: the sound verdict requires a diagnostic
  // line that NAMES this file, and a fixed prefix lets a test's control stub
  // print the file it was asked about without knowing the unguessable per-probe
  // suffix. The random part stays, so the name is still not a symlink target.
  return path.join(await canaryDirOnce(), `canary-${runId}.ts`);
}

/** Escape a literal for embedding in a RegExp (the canary's file name is generated, not user input). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The compiler's own account of a non-zero run, gathered from every field it reports. */
function rejectionText(err: unknown): string {
  const e = (err ?? {}) as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [e.stdout, e.stderr, e.message].map((x) => (typeof x === "string" ? x : "")).join("\n");
}

/**
 * Run the compiler on the canary file and classify what came back.
 *
 * Exactly three answers, and the rule for telling them apart is that **only an
 * exit-0 run is proof of an unsound compiler**:
 *
 *   - exit 0 on the known error → `ok: false`. The compiler was there, it read
 *     the file, and it refused to judge it. That is the stub.
 *   - non-zero WITH the `TS2322` diagnostic → `ok: true`. It refused THIS
 *     error, which is the only question the canary asks.
 *   - non-zero WITHOUT it → `ok: undefined`, **never** `false`. A compiler that
 *     crashes, cannot parse its own invocation, is killed at its bound or finds
 *     no lib directory exits non-zero having said nothing about the assignment.
 *     That is an environment fault, and an environment fault is not a finding
 *     about the compiler — `guardCompilerIntegrity` reads `undefined` as "could
 *     not look", records the note and lets the tier run, where the tier's own
 *     command reports the real problem. Calling it `false` would park a cycle
 *     accusing a compiler of unsoundness on the strength of a crash it never
 *     completed.
 */
async function probe(cwd: string, run: DriverExecFn): Promise<CanaryOutcome> {
  const script = LOCAL_TSC_CMD.split(" ").pop() as string;
  const runId = `${process.pid}-${Date.now().toString(36)}`;
  let file: string;
  try {
    file = await canaryPath(runId);
    await fs.writeFile(file, CANARY_SOURCE, { mode: 0o600 });
  } catch (err) {
    return {
      ok: undefined,
      why: `the canary file could not be written: ${(err as Error).message}`,
    };
  }
  try {
    // argv form: no shell re-parse, and the temp path stays one argument
    // however the tree's path is spelled. A verify run, so it takes a slot:
    // it compiles a real tree's worth of library code, not a no-op.
    // `killGroup` matches the checkpoint's typecheck exec options: the compiler
    // grandchild inherits the pipes, so a plain timeout would leave it holding
    // the promise after its own bound fired.
    await withVerifySlot(() =>
      run("node", {
        argv: [script, "--noEmit", file],
        cwd,
        timeout: CANARY_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        killGroup: true,
        env: verifyChildEnv(),
      }),
    );
    // Exit 0 on a file with a known type error: the compiler judged nothing.
    return {
      ok: false,
      why: `it exited 0 on a file containing \`${CANARY_SOURCE.trim()}\`, which ${CANARY_DIAGNOSTIC} must reject`,
    };
  } catch (err) {
    const output = rejectionText(err);
    if (rejectsTheCanary(output, file)) {
      return { ok: true };
    }
    // A non-zero run that never printed the diagnostic judged nothing about
    // this assignment: not judged, not a verdict. See the docblock.
    const first = output.split("\n").find((l) => l.trim().length > 0) ?? "no output";
    return {
      ok: undefined,
      why: `it exited non-zero without the expected ${CANARY_DIAGNOSTIC} diagnostic, which is a crash or an environment fault rather than a judgement (${first.slice(0, 160)})`,
    };
  } finally {
    await fs.rm(file, { force: true }).catch(() => undefined);
  }
}

/**
 * Did the compiler refuse THE canary file? A bare `error TS2322` anywhere in
 * the output is not enough: a compiler that rejects some unrelated file for an
 * assignment error while accepting `const x: number = "no"` has still judged
 * nothing. The diagnostic must name the canary file, so the pass is anchored to
 * the one question the probe actually asked.
 */
function rejectsTheCanary(output: string, file: string): boolean {
  const diagnostic = new RegExp(`\\berror ${CANARY_DIAGNOSTIC}\\b`, "i");
  // A compiler prints `path/to/file.ts(1,7):`, so the name is followed by `(`;
  // `\b` alone would end at the `.` and match `other.ts` as well as the canary.
  const namesTheCanary = new RegExp(
    `(^|[\\/:])${escapeRegExp(path.basename(file))}(?![A-Za-z0-9_])`,
    "i",
  );
  return output.split("\n").some((line) => diagnostic.test(line) && namesTheCanary.test(line));
}

/** The canary's own bound: a real tsc answers a one-file check in seconds. */
const CANARY_TIMEOUT_MS = 60_000;

/**
 * How long a cached verdict stays trusted. Long enough that a tier which asks
 * many times in one minute pays once; short enough that a compiler clobbered
 * while the driver sat in a long dispatch is asked again before the next tier
 * trusts it. The identity key alone cannot catch that swap — see the module
 * header — so the age bound is the freshness guarantee.
 */
const CANARY_CACHE_MAX_AGE_MS = 10 * 60_000;

/** Process-lifetime cache: compiler identity → what the canary observed, and when. */
const cache = new Map<string, { at: number; outcome: CanaryOutcome }>();

/** Drops every cached verdict. Test seam for the cache, not a production hook. */
export function resetToolchainCanaryCache(): void {
  cache.clear();
}

/**
 * Ask the compiler, once per identity per {@link CANARY_CACHE_MAX_AGE_MS},
 * whether it still compiles. `now` is injectable so the age bound is testable
 * without waiting out ten minutes; production callers never pass it.
 */
async function ask(
  entry: string,
  cwd: string,
  run: DriverExecFn,
  now: () => number = Date.now,
): Promise<CanaryOutcome> {
  const key = await compilerIdentity(entry);
  if (key !== undefined) {
    const hit = cache.get(key);
    if (hit !== undefined && now() - hit.at < CANARY_CACHE_MAX_AGE_MS) return hit.outcome;
  }
  const outcome = await probe(cwd, run);
  if (key !== undefined) cache.set(key, { at: now(), outcome });
  return outcome;
}

/**
 * The compiler-integrity check every guarded tier runs before trusting a GREEN
 * result. `cwd` is the directory the tier runs its verify command in (the
 * package directory for the pinned relative spelling).
 *
 * Never throws. A canary that cannot be asked reports `ok: undefined` with a
 * reason — the caller decides what an unasked question costs (the develop gate
 * fails the tier; the cap checkpoint reports "could not run", never "passed").
 */
export async function toolchainCanary(
  cwd: string,
  run: DriverExecFn,
  now: () => number = Date.now,
): Promise<CanaryOutcome> {
  const entry = compilerEntryPath(cwd);
  try {
    fsSync.accessSync(entry);
  } catch {
    // No compiler to ask — the canary judges NOTHING. It is not evidence of a
    // stub (a stub is a file that exists and answers wrongly), and the tier's
    // own command fails on a missing binary by itself. `guardCompilerIntegrity`
    // therefore lets the tier run; a caller that must not record a verdict at
    // all (the cap checkpoint) reads `ok !== true` and says "could not run".
    return { ok: undefined, why: CANARY_NOT_JUDGED };
  }
  try {
    return await ask(entry, cwd, run, now);
  } catch (err) {
    // The canary is a guard, not a dependency: an unexpected fault is an
    // unasked question, and each caller already handles one.
    trace(`work-driver: toolchain canary faulted: ${(err as Error).message}`);
    return { ok: undefined, why: `the canary could not run (${(err as Error).message})` };
  }
}

/** The failure string a guarded tier appends for an unsound compiler. */
export function toolchainUnsoundFailure(where: string, why: string): string {
  return `${TOOLCHAIN_UNSOUND_LABEL} the pinned type-checker (${LOCAL_TSC_CMD}) in ${where} is not sound: ${why}. ${TOOLCHAIN_UNSOUND_ADVICE}`;
}
/** True for a failure string this module produced. */
export function isToolchainUnsoundFailure(failure: string): boolean {
  return failure.includes(TOOLCHAIN_UNSOUND_LABEL);
}

/**
 * #1879 — the directory the pinned compiler spelling resolves against for
 * `cmd`. The spelling is relative (`node_modules/typescript/bin/tsc`) and every
 * tier that uses it gets there with `cd <pkg> && …` — `.pi/verify-cmd*` all open
 * with `cd extension` — so the directory the canary must run the compiler in is
 * that package directory. Asking at repoRoot would look for a compiler the tier
 * never runs. With no `cd` prefix, or one whose target does not hold the pinned
 * file, the answer is the tier's own cwd: that is where the command ran, so that
 * is where the compiler lives.
 */
export function packageDirFor(cmd: string, cwd: string): string {
  const target = LOCAL_TSC_CMD.split(" ").pop();
  if (target === undefined) return cwd;
  for (const m of cmd.matchAll(/(?:^|[;&|\s(])cd\s+("[^"\n]*"|'[^'\n]*'|[^\s;&|)]+)/g)) {
    const raw = (m[1] ?? "").replace(/^["']|["']$/g, "");
    if (raw === "") continue;
    const dir = path.resolve(cwd, raw);
    // Only a directory that actually holds the pinned compiler counts; an
    // unrelated `cd` (`cd ..`, a scratch dir) must not move the probe.
    try {
      if (fsSync.existsSync(path.join(dir, target))) return dir;
    } catch {
      return cwd;
    }
  }
  return cwd;
}

/**
 * The gate-side helper: run the canary for `cmd` in `cwd` when `cmd` invokes
 * the pinned compiler, and report what the caller must record.
 *
 * Returns `undefined` when there is nothing to record — the command does not
 * use the pinned spelling, the hatch is set, or the compiler passed. Otherwise
 * `{ failure, note }`: `failure` is set only when the compiler was PROVEN
 * unsound (the park's reason); an unaskable canary sets only `note`, because
 * "could not look" must not park a cycle whose code is fine.
 */
export async function guardCompilerIntegrity(opts: {
  cmd: string;
  cwd: string;
  where: string;
  run: DriverExecFn;
}): Promise<{ failure?: string; note?: string } | undefined> {
  if (!usesPinnedCompiler(opts.cmd)) return undefined;
  if (!toolchainCanaryEnabled()) return { note: CANARY_SKIPPED_NOTE };
  const outcome = await toolchainCanary(opts.cwd, opts.run);
  if (outcome.ok === true) return undefined;
  if (outcome.ok === undefined) {
    // "Could not look" is never a park — for a missing compiler or an
    // unaskable one alike. The tier runs, and its own command is the thing
    // that reports a dependency tree that is not installed.
    return { note: CANARY_SKIPPED_NOTE };
  }
  return {
    failure: toolchainUnsoundFailure(opts.where, outcome.why),
    note: `compiler integrity check failed — ${outcome.why}`,
  };
}
