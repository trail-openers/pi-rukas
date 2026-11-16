/**
 * lean/verify-baseline — telling a tier the run broke from one that was already red.
 *
 * `verify` routes every tier `red` into a build round, which is only right when the tier was green before the
 * change existed. Two questions, both asked only AFTER a tier has gone red (a green tier pays nothing):
 *
 *   - **a re-run at HEAD** — {@link confirmTierRed}: green on the second run means the first observed nothing
 *     stable, so the tier counts green and the flake rides in the PR body's reason;
 *   - **a probe at the run's base commit** — {@link probeTierAtBase}: the run's frozen tests' BYTES compared
 *     against what the run froze, then the tier's command once, both in a throwaway detached worktree at
 *     `baseSha`. A base that holds other bytes at the frozen paths AND fails the tier has a red gate the change
 *     did not author, so the caller hands the run back BEFORE any build round.
 *
 * The probe runs at `baseSha` and never at HEAD: probing at HEAD would let the builder's own commit decide what
 * counts as pre-existing.
 *
 * Both are settled by the child's exit code, read through {@link tierExitCode} — the verdict must be a value,
 * never an absence. A kill, an overflow or an un-startable command observed nothing: that is `unknown`, never a
 * colour. Only a base that cannot be checked out at all is `unusable`, which the caller turns into a throw.
 *
 * The frozen tests inside the probe are the exemption's boundary: a base that passes them has no pre-existing
 * red anywhere, and excusing the tier over that would delete the run's only contract check.
 */

import { trace, traceWarn } from "../trace.ts";
import { verifyChildEnv, verifyHostEnv } from "../work-driver-verify-cmd.ts";
import { linkShareableDeps, looksLikeMissingDeps } from "../worktree-provision.ts";
import { neverStarted, sha256, wasKilled } from "./specify-proof.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { type VerifyExec, VerifyInfraError } from "./verify-types.ts";

/** The lead every baseline-red reason carries, so a reader can tell it from a red. */
export const BASELINE_RED_MARKER = "baseline red:";

/**
 * Why `verify` hands a run back when its tier is red at the run's base commit. Reaches the handback
 * comment and the PR body, so it names the tier, the base sha, and that no build round can fix it.
 */
export function baselineRedReason(name: string, cmd: string, baseSha: string): string {
  return `${BASELINE_RED_MARKER} tier ${name} is red at the base commit ${baseSha} — \`${cmd}\` fails at the base without this run's changes, so no build round can fix it`;
}

/**
 * The tail on a green whose tier passed only on its second run at HEAD, carried in the outcome's
 * `reason` — the channel `publish` prints in the PR body.
 */
export function flakeReason(name: string, cmd: string): string {
  return `verify.${name} was red on its first run and green on the re-run — recorded as a flake of \`${cmd}\`, not as a pass this build earned`;
}

/** A base probe's answer: a colour, or the reason it has none. */
export type BaseProbe =
  | { status: "green" }
  | { status: "red" }
  | { status: "unknown"; reason: string }
  /** The probe could not run at all: the base is not checkoutable in this clone. */
  | { status: "unusable"; reason: string };

/**
 * The exit code a tier run ended with, or `undefined` when it exited 0 — the one place this step decides
 * pass-from-fail, on the child's status rather than on which side of a promise a value landed.
 */
export function tierExitCode(ran: unknown): number | undefined {
  const code = (ran as { code?: unknown } | undefined)?.code;
  return typeof code === "number" ? code : undefined;
}

/**
 * Did a tier run observe the work at all? `false` for the shapes where nobody ran anything: a kill, an
 * output overflow, or a command the shell could not start. Neither green nor red, at HEAD or base.
 */
export function tierObserved(ran: unknown): boolean {
  return (
    !wasKilled(ran) && !neverStarted(ran) && (ran as { overflow?: unknown })?.overflow === undefined
  );
}

/** Run one tier's command and return its exit code, `undefined` for a clean exit. */
async function tierCode(
  exec: VerifyExec,
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<unknown> {
  return await exec(cmd, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    killGroup: true,
    env: verifyChildEnv(),
  }).catch((err: unknown) => err);
}

/**
 * Did the tier's second run at HEAD agree with its first?
 *
 * `false` — the re-run exited 0 — is the flake: the caller counts the tier green and records it. `true` is a
 * second red, and also a re-run that observed nothing. "Exited 0" is the ONLY answer that excuses, and it is
 * asked for positively — the executor's kill, timeout, overflow and `ENOENT` rejections all carry a non-numeric
 * `code`. {@link classifyBaseRun} asks the same question the same way.
 */
export async function confirmTierRed(opts: {
  name: string;
  cmd: string;
  wt: string;
  exec: VerifyExec;
  timeoutMs: number;
}): Promise<boolean> {
  return confirmTierRedFrom(await tierCode(opts.exec, opts.cmd, opts.wt, opts.timeoutMs));
}

/** What the base tier run printed alongside its colour — see `probeTierAtBase`. */
export type BaseProbeOutcome = BaseProbe & { stream?: string };

/**
 * What one tier's command does at the run's base commit, in a throwaway checkout.
 *
 * The tree is a SIBLING of the repo, never under it: `verify` scans the whole repo with `git status --porcelain
 * --untracked-files=all` before and after every run, so a throwaway inside `repoRoot` is itself untracked dirt.
 * It is removed in a `finally` and before the add.
 *
 * The answer carries the base run's COMBINED stream (`stream`) beside its colour: the caller decides from those
 * bytes whether the base NAMED the head run's failures, and the tree is gone by the time it reads them.
 */
export async function probeTierAtBase(opts: {
  repoRoot: string;
  baseSha: string;
  issue: number;
  cmd: string;
  timeoutMs: number;
  exec: VerifyExec;
  /** The run's frozen contract, whose BYTES the base is compared against. */
  frozen: Record<string, string>;
}): Promise<BaseProbeOutcome> {
  const { repoRoot, baseSha, cmd, timeoutMs, exec } = opts;
  const abs = baselineProbeWorktreePath(repoRoot, opts.issue);
  // The probe's OWN git calls are the driver's, so they keep `verifyHostEnv`'s knob; the
  // project command below runs scrubbed.
  const hostEnv = verifyHostEnv();
  const remove = () =>
    exec("git", {
      argv: [...NO_HOOKS, "worktree", "remove", "--force", abs],
      cwd: repoRoot,
      timeout: 60_000,
      maxBuffer: 256 * 1024,
      env: hostEnv,
    }).catch(() => undefined);
  // A registration a killed run left behind makes the next `worktree add` at this path refuse.
  await remove();
  try {
    await exec("git", {
      argv: [...NO_HOOKS, "worktree", "add", "--detach", abs, baseSha],
      cwd: repoRoot,
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: hostEnv,
    });
  } catch (err) {
    return {
      status: "unusable",
      reason: `the base commit ${baseSha} could not be checked out for the baseline probe: ${(err as Error)?.message ?? String(err)}`,
    };
  }
  try {
    // A bare worktree holds tracked files only, so a tier needing a dependency tree would fail every command
    // in it — which says nothing about the base. Symlinks only (`linkShareableDeps`, never
    // `provisionWorktree`): the project's `.pi/worktree-setup` is arbitrary code.
    await linkShareableDeps(exec, repoRoot, abs).catch(() => undefined);
    // The contract first: a tier is only excused over a run whose frozen tests the base ALSO fails. Their
    // verdicts are READ here, never re-run: `baseSha` predates the run's acceptance tests.
    let contractEstablished = false;
    if (Object.keys(opts.frozen).length > 0) {
      const contract = await baseCarriedFrozen(exec, repoRoot, baseSha, opts.frozen, hostEnv);
      // Whether the probe could READ the run's frozen bytes: it decides nothing about the contract's colour,
      // but it decides what the tier's own output may be read as below.
      contractEstablished = contract.kind !== "carries-nothing";
      if (contract.kind === "carries-nothing")
        return {
          status: "unknown",
          reason: `the base commit ${baseSha.slice(0, 12)} does not establish this run's frozen contract (${contract.paths.join(", ")}), so the base cannot be judged against it`,
        };
      if (contract.kind !== "red")
        return {
          status: "unknown",
          reason:
            contract.kind === "green"
              ? "the run's frozen tests pass at the base commit, so this red is not pre-existing"
              : `the run's frozen tests are not the run's own at the base commit, so the base cannot be judged against this run's contract`,
        };
    }
    trace(`lean/verify: baseline probe — running \`${cmd}\` at base ${baseSha.slice(0, 12)}`);
    const ran = await tierCode(exec, cmd, abs, timeoutMs);
    const verdict = classifyBaseRun(ran, contractEstablished);
    const e = ran as { stdout?: string; stderr?: string } | undefined;
    const stream = [e?.stdout, e?.stderr].filter((s) => typeof s === "string").join("\n");
    return stream === "" ? verdict : { ...verdict, stream };
  } finally {
    // Not swallowed: a tree git still holds makes the NEXT probe at this path refuse its add.
    await remove().catch((err: unknown) =>      traceWarn(
        `verify-baseline: probe tree cleanup failed — ${(err as Error)?.message ?? String(err)}`,
      ),
    );
  }
}

/**
 * What the base commit holds at the run's frozen paths — the base's own recorded state. Read as the base's
 * BYTES (`git show <base>:<path>`) and compared against what the run froze. Three answers:
 *
 *   - `carries-nothing` — the base has none of these files (the ordinary answer). NOT a colour: a mainline that
 *     never carried the test did not author a red gate;
 *   - `red` — the base holds a path the run froze with bytes that are NOT the frozen ones;
 *   - `green` — the base already holds the frozen bytes, so this run's red is its own.
 *
 * A read that fails outright is `carries-nothing` too. Only git's own exit-128 "does not exist" wording reads
 * as absent, so an executor timeout or overflow never becomes git's answer.
 */
async function baseCarriedFrozen(
  exec: VerifyExec,
  repoRoot: string,
  baseSha: string,
  frozen: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv,
): Promise<
  | { kind: "red"; paths: string[] }
  | { kind: "green" }
  | { kind: "carries-nothing"; paths: string[] }
> {
  const paths = Object.keys(frozen);
  const differed: string[] = [];
  const absent: string[] = [];
  // A path whose bytes could not be read establishes no red, so it lands in the same no-excuse answer as an
  // absent path.
  const unread: string[] = [];
  for (const rel of paths) {
    const ran = await exec("git", {
      argv: [...NO_HOOKS, "show", `${baseSha}:${rel}`],
      cwd: repoRoot,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: hostEnv,
    }).catch((err: unknown): Record<string, unknown> => {
      // A rejection is the executor speaking, not git's "no such path": keep the object so
      // the absent-path test below can read its `code` and `stderr`.
      return typeof err === "object" && err !== null
        ? (err as Record<string, unknown>)
        : { message: String(err) };
    });
    if (ran === undefined) {
      unread.push(rel);
      continue;
    }
    if (gitPathAbsent(ran)) {
      absent.push(rel);
      continue;
    }
    // No `stdout` own-property, or one that is not a string: the executor spoke and the base
    // did not. A rejection's `code` is `null` for a kill and a string for `ENOENT`, so neither
    // may be read as bytes.
    if (!Object.hasOwn(ran, "stdout") || typeof ran.stdout !== "string") {
      unread.push(rel);
      continue;
    }
    const bytes = ran.stdout;
    if (bytes.length === 0 || sha256(bytes) !== frozen[rel]) differed.push(rel);
  }
  if (differed.length > 0) return { kind: "red", paths: differed };
  if (absent.length + unread.length === paths.length) return { kind: "carries-nothing", paths };
  // Some paths matched and others could not be read: the base cannot be judged against this
  // run's contract at all. Same answer as an absent path — no established red.
  if (unread.length > 0) return { kind: "carries-nothing", paths: unread };
  return { kind: "green" };
}

/**
 * Is a failed `git show <ref>:<path>` git's own "this commit holds no such path"?
 *
 * Re-derived rather than imported from `verify-reads.ts`, whose reader also decides a config
 * default: a baseline probe must not inherit "treat it as absent" from that.
 */
function gitPathAbsent(err: unknown): boolean {
  const e = err as { code?: unknown; stderr?: string; message?: string };
  const text = `${e?.stderr ?? ""}\n${e?.message ?? ""}`;
  return e?.code === 128 && /does not exist|exists on disk, but not in/i.test(text);
}

/**
 * A base tier run's colour, from the same exit code the HEAD runs are judged by.
 *
 * The optional `stream` carries the base run's combined output so the caller can ask WHICH tests
 * the base failed; the classification below never reads it. Exported for the smoke test that
 * judges this function's ORDER directly: `verify` reads `unknown` and `green` identically.
 *
 * Observation is asked FIRST: a killed, timed-out, un-startable or overflowed run has no exit
 * code, and an exit-code test ahead of it handed `{status: "green"}` to every one of those shapes.
 * `confirmTierRed` asks in the same order.
 *
 * A red base needs the child's OWN output: a run that exited non-zero having printed nothing but
 * the executor's message is a harness speaking, not a gate. The three no-colour families name
 * which, because the operator fixes different things. With no frozen bytes readable at the base
 * there is no comparison to make, so the tier's own output cannot be read as the mainline's red
 * gate either.
 */
export function classifyBaseRun(ran: unknown, contractEstablished: boolean): BaseProbe {
  if (!tierObserved(ran)) {
    const e = ran as { overflow?: string };
    return {
      status: "unknown",
      reason:
        e?.overflow !== undefined
          ? `the base run exceeded its output bound on ${e.overflow}`
          : "the base run was killed, timed out, or could not be started",
    };
  }
  // Observed and exited 0: the base passes this tier.
  if (tierExitCode(ran) === undefined) return { status: "green" };
  const e = ran as {
    stdout?: string;
    stderr?: string;
    message?: string;
    overflow?: string;
  };
  const out = [e.stdout, e.stderr].filter((s) => typeof s === "string").join("\n");
  // A bare worktree whose dependencies were never linked fails every command.
  if (contractEstablished && looksLikeMissingDeps(out))
    return { status: "unknown", reason: "the base checkout failed for want of dependencies" };
  if (out.trim() === "")
    return { status: "unknown", reason: "the base run returned no output from the tier itself" };
  return { status: "red" };
}

/** The probe tree for one issue's baseline comparison. */
export function baselineProbeWorktreePath(repoRoot: string, issue: number): string {
  // SIBLING to the repo, not under it — see `probeTierAtBase`.
  const trimmed = repoRoot.replace(/[/]+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return `${trimmed.slice(0, cut)}/${trimmed.slice(cut + 1)}.baseline-lean-verify-${issue}`;
}

/** A base the probe could not check out: the machine, so the engine hands back. */
export function baselineUnusableError(reason: string): VerifyInfraError {
  return new VerifyInfraError(reason);
}
/**
 * The judgement {@link confirmTierRed} makes about a re-run it did not itself spawn.
 *
 * `verify` needs the re-run's OUTPUT as well as its colour, so it spawns the child once
 * through `tierRunStream` and asks this. One predicate for both callers keeps "a kill is not
 * a pass" from meaning two things.
 */
export function confirmTierRedFrom(ran: unknown): boolean {
  // An excuse needs a re-run that SAW the work and came back clean: two positive facts, not
  // the absence of an exit code.
  if (!tierObserved(ran)) return true;
  // A run that observed the work still has to have ANSWERED: `tierCode` folds a rejection
  // into the value it returns, so a rejection that stamped nothing would read as a clean exit
  // by `tierExitCode` alone.
  if (ran !== undefined && typeof ran === "object" && !("stdout" in (ran as object))) return true;
  return tierExitCode(ran) !== undefined;
}
