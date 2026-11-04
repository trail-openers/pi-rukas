/**
 * lean/verify-baseline — telling a tier the run broke from one that was already red.
 *
 * `verify` answers "does the frozen contract pass on THIS tree?" and the machine
 * routes every `red` into a build round. That answer is only about the change when
 * the tier was green before the change existed. A tier that is red at the run's
 * `baseSha` — a suite unrelated to the diff that fails on this host's mainline — is
 * red whatever the builder does next, and a run that bills a fix round for it sends a
 * developer to edit production code nobody asked them to touch. A tier that is red at
 * HEAD and green on a second run at HEAD is a flake, and costs the same round for
 * nothing.
 *
 * Two questions, both asked only AFTER a tier has gone red (a green tier pays
 * nothing, and a probe on the happy path would double every verify):
 *
 *   - **a re-run at HEAD** — {@link confirmTierRed}: the same command, once more, in
 *     the same worktree. Green on the second run means the first observed nothing
 *     stable, so the tier counts green and the flake rides in the reason the PR body
 *     prints. Red twice is a real failure and the caller goes on to the probe.
 *   - **a probe at the run's base commit** — {@link probeTierAtBase}: the run's
 *     frozen tests first, then the tier's command once, both in a throwaway detached
 *     worktree checked out at `baseSha`, provisioned like every other driver worktree
 *     and removed in a `finally`. A base that fails the run's own frozen contract AND
 *     the tier has a red gate the change did not author, so the caller hands the run
 *     back BEFORE any build round; a base that passes the contract has no red to
 *     blame and the tier stays the real failure it was.
 *
 * The probe runs at `baseSha` and never at HEAD: probing at HEAD would let the
 * builder's own commit decide what counts as pre-existing.
 *
 * Both questions are settled by ONE piece of evidence, and it is the child's exit
 * code — read through {@link tierExitCode}, not by comparing a result object against
 * `undefined`. `verify`'s executor resolves a successful command with a
 * `{stdout, stderr}` object and rejects a failed one with the child's code; an
 * injected executor is free to resolve with nothing at all, and a gate that inferred
 * "red" from an absent value read every green as a red (and vice versa) depending on
 * which stand-in a case happened to use. An exit code is a value, so it cannot be
 * confused with its own absence: `undefined` means the command succeeded, a number
 * means it did not, and a kill or an un-startable command is neither and gets no
 * colour at all.
 *
 * "Could not tell" is never a colour, and it never excuses a tier. A base run that
 * was killed, overflowed its buffer, never started, or printed nothing but the
 * executor's own error observed nothing, so it answers `unknown` and the tier stays
 * the ordinary red it was. The one exception is the probe tree itself: a base that
 * cannot be checked out leaves the run anchored to a commit nothing here has judged,
 * so no verdict about it — a green included — is worth recording, and that is
 * `unusable`, which the caller turns into a throw.
 *
 * Lean's own module on purpose. The /work develop gate has an older answer to the
 * same question (`work-driver-verify-baseline.ts`), but its verdict is a per-test
 * attribution keyed on a verify-loop report file lean's tiers do not produce, and it
 * can only ADD evidence to a run that parks anyway. Lean's tiers are opaque shell
 * strings, so what it can compare is a whole tier, and what it can decide is hand
 * back before a build round rather than after.
 *
 * The frozen tests inside the probe are the exemption's boundary. A run's contract is
 * frozen proved-red on purpose and must go green for the run to be worth anything, so
 * a base that still fails it is a gate the change did not author — while a base that
 * passes it has no pre-existing red anywhere, and excusing the tier over that would
 * delete the run's only contract check.
 */

import { trace } from "../trace.ts";
import { verifyChildEnv, verifyHostEnv } from "../work-driver-verify-cmd.ts";
import { looksLikeMissingDeps, provisionWorktree } from "../worktree-provision.ts";
import { neverStarted, sha256, wasKilled } from "./specify-proof.ts";
import { NO_HOOKS } from "./specify-reset.ts";
import { type VerifyExec, VerifyInfraError } from "./verify-types.ts";

/** The lead every baseline-red reason carries, so a reader can tell it from a red. */
export const BASELINE_RED_MARKER = "baseline red:";

/**
 * Why `verify` hands a run back when its tier is red at the run's base commit.
 *
 * A durable record that reaches the handback comment and the PR body's Verification
 * section, so it names the tier, the base sha, and the one fact the operator needs:
 * this run's builder did not author the failure, and no build round can fix it.
 */
export function baselineRedReason(name: string, cmd: string, baseSha: string): string {
  return `${BASELINE_RED_MARKER} tier ${name} is red at the base commit ${baseSha} — \`${cmd}\` fails at the base without this run's changes, so no build round can fix it`;
}

/**
 * The tail on a green whose tier passed only on its second run at HEAD.
 *
 * Carried in the outcome's `reason`, which is the channel `publish` already prints in
 * the PR body's Verification section — so a tier that was excused says so rather than
 * reporting a clean gate it did not see.
 */
export function flakeReason(name: string, cmd: string, headRuns: number): string {
  return `verify.${name} was red on its first run and green on the re-run (${headRuns} run(s) at HEAD in all) — recorded as a flake of \`${cmd}\`, not as a pass this build earned`;
}

/** A base probe's answer: a colour, or the reason it has none. */
export type BaseProbe =
  | { status: "green" }
  | { status: "red" }
  | { status: "unknown"; reason: string }
  /** The probe could not run at all: the base is not checkoutable in this clone. */
  | { status: "unusable"; reason: string };

/**
 * The exit code a tier run ended with, or `undefined` when it exited 0.
 *
 * The one place this step decides pass-from-fail, and it decides on the child's
 * status rather than on which side of a promise a value landed: the production
 * executor rejects a non-zero exit with `code` set, and a stand-in executor is free to
 * resolve with no result object at all. Reading absence as the verdict made the gate
 * agree with whatever its injected executor happened to return.
 *
 * A run that was killed, timed out, overflowed its buffer or never started has no
 * exit code and no verdict either — the caller asks {@link tierObserved} first, and
 * nothing may be concluded from a run that judged nothing.
 */
export function tierExitCode(ran: unknown): number | undefined {
  const code = (ran as { code?: unknown } | undefined)?.code;
  return typeof code === "number" ? code : undefined;
}

/**
 * Did a tier run observe the work at all?
 *
 * `false` for the shapes where nobody ran anything: a kill (which is also a timeout —
 * the executor stamps `timedOutKill` when the wall clock signalled), an output
 * overflow that truncated the evidence, or a command the shell could not start. Those
 * are neither green nor red anywhere in this step, at HEAD or at the base.
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
 * `false` — the re-run exited 0 — is the flake: the caller counts the tier green and
 * records it. `true` is a second red, and also a re-run that observed nothing (a kill,
 * an overflow, a command that never started): an excuse needs two runs that saw the
 * work, so those leave the first red standing exactly as if there had been no re-run.
 *
 * So "exited 0" is the ONLY answer that excuses, and it is asked for positively, in two
 * parts: the re-run must have OBSERVED the work, and it must have ended with exit code 0.
 * Inferring the excuse from the ABSENCE of a numeric exit code is the opposite bug — the
 * executor's kill, timeout, overflow and `ENOENT` shapes all reject with a non-numeric
 * `code` (`null`, or a string), and so does a rejection that stamped nothing at all, so
 * an absence test would read every one of them as the clean exit and report a green on a
 * tier nobody saw pass. The base probe's sibling {@link classifyBaseRun} asks the same
 * question through {@link tierObserved} first; a re-run is held to the same standard.
 *
 * The return is the fact, not a colour — the tier's own `Executed` from the first run
 * stays the evidence, and only this tells the caller whether to believe it.
 */
export async function confirmTierRed(opts: {
  name: string;
  cmd: string;
  wt: string;
  exec: VerifyExec;
  timeoutMs: number;
}): Promise<boolean> {
  const ran = await tierCode(opts.exec, opts.cmd, opts.wt, opts.timeoutMs);
  // An excuse needs a re-run that SAW the work and came back clean: two positive facts,
  // not the absence of an exit code. The executor's kill, timeout, overflow and `ENOENT`
  // shapes reject with a non-numeric `code` (`null`, or a string) and so does a rejection
  // that stamped nothing at all, so reading "no numeric code" as "exited 0" would report
  // a green on a tier nobody saw pass. The base probe's sibling `classifyBaseRun` asks
  // the same question through `tierObserved` first; a re-run is held to the same standard.
  if (!tierObserved(ran)) return true;
  // A run that observed the work still has to have ANSWERED. `tierCode` folds a
  // rejection into the value it returns, so a rejection that stamped no `code`, no kill
  // and no `ENOENT` would otherwise be read as a clean exit by `tierExitCode` alone — a
  // green handed out for a re-run that reported nothing. An executor that resolves with
  // no result object at all is the fixture's "exited 0 with no output", and stays green.
  if (ran !== undefined && typeof ran === "object" && !("stdout" in (ran as object))) return true;
  return tierExitCode(ran) !== undefined;
}

/**
 * What one tier's command does at the run's base commit, in a throwaway checkout.
 *
 * The tree is a SIBLING of the repo, never under it: `verify` scans the whole repo —
 * `.worktrees/` included — with `git status --porcelain --untracked-files=all` before
 * and after every run, so a throwaway checked out inside `repoRoot` is itself
 * untracked dirt and the probe would hand the run back for its own tree. Provisioning
 * still works there, because `worktree-provision` scans the repo's parent for a
 * sibling checkout.
 *
 * It is removed in a `finally` — including when the base run threw — and removed
 * before the add as well, because the only thing a killed process can leave behind is
 * a tree this function is about to overwrite.
 */
export async function probeTierAtBase(opts: {
  repoRoot: string;
  baseSha: string;
  issue: number;
  cmd: string;
  timeoutMs: number;
  exec: VerifyExec;
  /** The run's frozen contract, re-run at the base as the price of an excuse. */
  frozen: Record<string, string>;
  /** The project's per-file runner template; `undefined` means none is configured. */
  testRunner?: string;
}): Promise<BaseProbe> {
  const { repoRoot, baseSha, cmd, timeoutMs, exec } = opts;
  const abs = baselineProbeWorktreePath(repoRoot, opts.issue);
  // The probe's OWN git calls are the driver's, so they keep the one knob that
  // decides where a host-channel cycle reports (see `verifyHostEnv`); the project
  // command below runs scrubbed, like every other project tier.
  const hostEnv = verifyHostEnv();
  const remove = () =>
    exec("git", {
      argv: [...NO_HOOKS, "worktree", "remove", "--force", abs],
      cwd: repoRoot,
      timeout: 60_000,
      maxBuffer: 256 * 1024,
      env: hostEnv,
    }).catch(() => undefined);
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
    // A bare worktree holds tracked files only; a tier that needs a dependency tree
    // would fail every command in it, which says nothing about the base commit.
    await provisionWorktree(exec, repoRoot, abs).catch(() => undefined);
    // The contract first: a tier is only excused over a run whose frozen tests the base
    // ALSO fails. Their verdicts are READ, never re-decided or re-run here, and the three
    // answers say different things to whoever reads the handback.
    //
    // They cannot be RUN at the base. A run's acceptance tests are written during the run
    // by the step that froze them, so `baseSha` predates them: in this file's own cases
    // the base holds none of the frozen paths. Executing them there would either report
    // the runner's "no such file" as the frozen test still failing — `frozenTestFailure`
    // reads ANY non-zero exit that way — and excuse the tier over a contract the base
    // never carried, or find nothing to run and call the base green. So the probe asks
    // the base the only question it can answer: did the mainline already carry these very
    // bytes, and did it leave them failing?
    if (Object.keys(opts.frozen).length > 0) {
      const contract = await baseCarriedFrozen(exec, repoRoot, baseSha, opts.frozen, hostEnv);
      if (contract.kind === "carries-nothing")
        return {
          status: "unknown",
          reason: `the base commit ${baseSha.slice(0, 12)} carries none of this run's frozen acceptance tests (${contract.paths.join(", ")}), so the base cannot be judged against this run's contract`,
        };
      if (contract.kind === "unreadable") return { status: "unknown", reason: contract.reason };
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
    return await classifyBaseRun(await tierCode(exec, cmd, abs, timeoutMs));
  } finally {
    await remove();
  }
}

/**
 * What the base commit holds at the run's frozen paths — the base's own recorded state.
 *
 * Read as the base's BYTES (`git show <base>:<path>`) and compared against what the run
 * froze. Three answers, because they mean three different things:
 *
 *   - `carries-nothing` — the base has none of these files. This is the ordinary answer:
 *     a run's contract is authored during the run, so the base predates it. It is
 *     deliberately NOT a colour; a mainline that never carried the test did not author a
 *     red gate and cannot excuse a tier over it.
 *   - `red` — the base holds a path the run froze and its bytes are NOT the frozen ones.
 *     The frozen file is the run's contract in its passing shape, so a base holding other
 *     bytes at that path is a mainline whose own copy of this test does not satisfy what
 *     the run is held to: a gate the change did not author.
 *   - `green` — the base already holds the frozen bytes, so the mainline passed them and
 *     this run's red is its own.
 *
 * A read that fails outright is `unreadable`, never `carries-nothing`: "I could not
 * look" and "it was not there" are different facts and the operator fixes different
 * things.
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
  | { kind: "unreadable"; reason: string }
> {
  const paths = Object.keys(frozen);
  const differed: string[] = [];
  const absent: string[] = [];
  for (const rel of paths) {
    const ran = await exec("git", {
      argv: [...NO_HOOKS, "show", `${baseSha}:${rel}`],
      cwd: repoRoot,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: hostEnv,
    }).catch((err: unknown): Record<string, unknown> => {
      // A rejection is the executor speaking, not git's "no such path": keep the object
      // so the absent-path test below can read its `code` and `stderr`, and never a null
      // that would look like a result with no bytes.
      return typeof err === "object" && err !== null
        ? (err as Record<string, unknown>)
        : { message: String(err) };
    });
    if (ran === undefined)
      return { kind: "unreadable", reason: `the base's ${rel} could not be read` };
    if (gitPathAbsent(ran)) {
      absent.push(rel);
      continue;
    }
    if (!Object.hasOwn(ran, "stdout"))
      return { kind: "unreadable", reason: `the base's ${rel} could not be read` };
    const bytes = typeof ran.stdout === "string" ? ran.stdout : "";
    if (bytes.length === 0 || sha256(bytes) !== frozen[rel]) differed.push(rel);
  }
  if (differed.length > 0) return { kind: "red", paths: differed };
  if (absent.length === paths.length) return { kind: "carries-nothing", paths: absent };
  return { kind: "green" };
}

/**
 * Is a failed `git show <ref>:<path>` git's own "this commit holds no such path"?
 *
 * The same two wordings `verify-reads.ts` recognises for `.pi/verify-cmd`; re-derived
 * here rather than imported because that module's reader also decides a config default,
 * and a baseline probe must not inherit "treat it as absent" from a config question.
 */
function gitPathAbsent(err: unknown): boolean {
  const e = err as { code?: unknown; stderr?: string; message?: string };
  const text = `${e?.stderr ?? ""}\n${e?.message ?? ""}`;
  return e?.code === 128 && /does not exist|exists on disk, but not in/i.test(text);
}

/**
 * A base tier run's colour, from the same exit code the HEAD runs are judged by.
 *
 * A red base needs the child's OWN output: a run that exited non-zero having printed
 * nothing but the executor's message is a harness speaking instead of a gate, and no
 * commit's colour is knowable from that. The two no-colour families — a run that
 * judged nothing, and a bare checkout with no dependencies — say which, because the
 * operator who reads them fixes different things.
 */
function classifyBaseRun(ran: unknown): BaseProbe {
  if (ran === undefined || tierExitCode(ran) === undefined) return { status: "green" };
  const e = ran as {
    stdout?: string;
    stderr?: string;
    message?: string;
    overflow?: string;
  };
  if (!tierObserved(ran))
    return {
      status: "unknown",
      reason:
        e.overflow !== undefined
          ? `the base run exceeded its output bound on ${e.overflow}`
          : "the base run was killed, timed out, or could not be started",
    };
  const out = [e.stdout, e.stderr].filter((s) => typeof s === "string").join("\n");
  // A bare worktree whose dependencies were never linked fails every command.
  if (looksLikeMissingDeps(out))
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
