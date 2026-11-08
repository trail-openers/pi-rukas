/**
 * lean/freeze-check — a candidate acceptance test run against the project's own
 * cheap content checks, BEFORE it becomes frozen.
 *
 * The freeze pipeline proves one thing about a candidate: it is RED against the
 * base, executed by `verify.test`. That is the whole admission test — and it is
 * not the only check a repository has. A project also runs commands that read
 * test-file CONTENT (`verify.fast` here carries a scanner that refuses
 * `process.env.X = undefined` in any `.ts`). Nothing in specify or challenge ran
 * those, and `build` may not edit a frozen file. So a candidate that trips a
 * content gate freezes, and the run cannot win: no build round can edit the
 * file, and the gate stays red however the code changes. In the field that cost
 * all three build rounds.
 *
 * `verify.freezeCheck` is the key that closes it: one shell command the project
 * sets, run over the whole tree at the two moments a frozen file is either
 * admitted or trusted.
 *
 *   - **before the freeze** (specify / challenge, in `runTestPipeline`): red at
 *     base and green with the candidates means the candidates broke the gate, so
 *     the ones the gate NAMED never join the contract — dropped through the same
 *     channel as every other boundary refusal. A gate red at base is the
 *     mainline's problem and never blocks or attributes anything here (`verify`'s
 *     baseline probe owns that). An unrunnable gate blocks nothing either, but
 *     says so in the step reason: a check that could not run is not evidence.
 *   - **at verify** (§D3): a project tier red at HEAD plus a freeze check that
 *     fails ON A FROZEN FILE means the contract itself is defective. No build
 *     round can fix it — the file is untouchable by contract — so the step hands
 *     the run back instead of billing one.
 *
 * Attribution runs the same command at the base with no candidates in place, in
 * the same worktree, before the candidates were ever written. That is the only
 * "the gate was fine and your files were not" the step will assert, and it is
 * the same shape `verify-baseline.ts`'s probe takes.
 */

import { verifyChildEnv } from "../work-driver-verify-cmd.ts";
import { neverStarted, wasKilled } from "./specify-proof.ts";
import type { DropLabel } from "./specify-run.ts";
import type { VerifyExec } from "./verify-types.ts";

/** What a freeze check said. `unknown` is not a colour: it never blocks. */
export type FreezeCheck =
  | { kind: "green" }
  | { kind: "red"; output: string }
  | { kind: "unknown"; detail: string };

/** The default ceiling, shared with a project tier rather than a per-file one. */
const FREEZE_CHECK_TIMEOUT_MS = 30 * 60_000;
/** A gate that prints more than this is not naming files, it is dumping a log. */
const FREEZE_CHECK_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Was this rejection a command the shell could not start at all?
 *
 * Asked of BOTH halves of the rejection, because the shape depends on the form:
 * an argv-form call rejects with the spawn error itself (`code: "ENOENT"`), while
 * a shell-string call rejects with `Command failed: …` carrying the shell's
 * NUMERIC status — 127 on sh, 126 for a non-executable file — and the `not
 * found` / `not executable` line only in `stderr`. A `sh -c 'exit 1'` that
 * printed its own failure answers false on both counts and is a red, which is the
 * reading `verify-steps.ts` insists on for the project tiers: an exit status
 * alone says nothing about whether the work was ever judged.
 */
function couldNotBeStarted(err: unknown): boolean {
  if (neverStarted(err)) return true;
  const e = err as { code?: unknown; stderr?: unknown; message?: unknown };
  if (e?.code !== 126 && e?.code !== 127) return false;
  const text = `${typeof e.stderr === "string" ? e.stderr : ""}${typeof e.message === "string" ? e.message : ""}`;
  return /not found|not executable|No such file or directory|cannot execute/i.test(text);
}

/**
 * Run the project's freeze check once in `wt`.
 *
 * Same discipline as `verify`'s `runTier`: the driver's knobs scrubbed out of the
 * child env, its own process group so a timeout reaches a grandchild holding
 * stdout, and a bound. A kill, an output flood or a command the shell could not
 * start is `unknown` rather than a throw — a gate that could not answer must not
 * block a freeze, and must not be reported as a red either.
 */
export async function runFreezeCheck(
  cmd: string,
  wt: string,
  exec: VerifyExec,
  timeoutMs: number = FREEZE_CHECK_TIMEOUT_MS,
): Promise<FreezeCheck> {
  const ran = await exec(cmd, {
    cwd: wt,
    timeout: timeoutMs,
    maxBuffer: FREEZE_CHECK_MAX_BUFFER,
    killGroup: true,
    env: verifyChildEnv(),
  }).catch((err: unknown) => ({ __err: err }) as never);
  const err = (ran as { __err?: unknown })?.__err;
  if (err === undefined) return { kind: "green" };
  const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown; overflow?: unknown };
  const out = [e.stdout, e.stderr, e.message]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .join("\n");
  if (wasKilled(err) || e.overflow !== undefined || couldNotBeStarted(err))
    return {
      kind: "unknown",
      detail: out.replace(/\s+/g, " ").trim().slice(0, 200),
    };
  return { kind: "red", output: out };
}

/** A path in a check's output must look like a path, not a word in a sentence. */
function looksLikePath(token: string): boolean {
  return (
    token.includes("/") &&
    !token.startsWith("/") &&
    !token.startsWith("-") &&
    !token.includes("://")
  );
}

/** Strip the quotes, brackets and punctuation a runner wraps a path in. */
function bareToken(token: string): string {
  return token.replace(/^[[({"']+/, "").replace(/[\])}"'.,:;]+$/, "");
}

/**
 * Which candidate paths this check's output names.
 *
 * Substring first: the named file is the file a content gate prints, and a
 * substring hit is the answer no formatting can hide. The word scan is the
 * backstop for an output that wraps the path in `"` or `(`, which `includes`
 * still matches — it exists for the tokens a path split leaves. A path match is
 * per candidate, so a check that named one file cannot drop the others.
 */
export function namedCandidates(output: string, candidates: string[]): string[] {
  const named: string[] = [];
  for (const rel of candidates) {
    const hit =
      output.includes(rel) ||
      output.split(/\s+/).some((token) => {
        const bare = bareToken(token);
        return looksLikePath(bare) && (rel === bare || bare.endsWith(`/${rel}`));
      });
    if (hit) named.push(rel);
  }
  return named;
}

/** Why the drop happened, in the words a child's retry prompt and an operator read. */
export function freezeCheckDropReason(cmd: string, confirmedAtBase: boolean): string {
  return `fails verify.freezeCheck ${cmd}${confirmedAtBase ? " (a base run of the same command with no candidate files was green)" : ""}`;
}

/**
 * Every candidate dropped for one check that was green at base and red here.
 *
 * Nothing is attributed when the base run never happened or did not go red:
 * without the comparison the check says only "the tree is red", which is not
 * evidence about which file broke it, and a freeze must not be lost on that.
 */
export function freezeCheckDrops(
  base: FreezeCheck,
  withCandidates: FreezeCheck,
  cmd: string,
  candidates: string[],
): DropLabel[] | undefined {
  if (base.kind !== "green" || withCandidates.kind !== "red") return undefined;
  const named = namedCandidates(withCandidates.output, candidates);
  const paths = named.length === 0 ? candidates : named;
  const reason = freezeCheckDropReason(cmd, true);
  return paths.map((path) => ({ criterionId: "verify.freezeCheck", path, reason }));
}

/**
 * The clause naming a freeze check this step could not run, or "" when nothing
 * to say. Carried in the step reason: a check that blocked nothing still has to
 * be disclosed, or its silence reads as a pass.
 */
export function freezeCheckNote(cmd: string, ran: boolean, check: FreezeCheck | undefined): string {
  if (check === undefined || check.kind !== "unknown") return "";
  return `verify.freezeCheck ${cmd} could not be judged${ran ? " (its base run too)" : ""}: ${check.detail}`;
}
