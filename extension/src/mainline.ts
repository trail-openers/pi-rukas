/**
 * mainline — which branch the mainline is, resolved from the clone.
 *
 * #1387: this pair used to live in `work-driver-git.ts`, so the review ledger
 * path (`review-ledger-path.ts` → `identityBase`) imported a driver module for
 * one git read. The ledger writer and the merge guard both compute a patch
 * identity against `<remote>/<mainline>`; making them reach the driver layer
 * to do it tied the review layer to the driver for something that is a plain
 * git lookup.
 *
 * Neutral leaf, the shape `exec.ts` and `git-range.ts` already follow: its
 * only import is `./exec.ts` for its option/result types, so any module —
 * driver or review — may depend on it without pulling the other side in. The
 * driver callers keep their imports unchanged via the re-exports in
 * `work-driver-git.ts`.
 *
 * The executor type is declared structurally here rather than imported from
 * `work-driver-git.ts`: a type-only import of `VerifyExecFn` would satisfy the
 * grep gate in `test-review-ledger-path-imports.ts` only because TypeScript
 * erases it, which is exactly the false pass that gate exists to refuse. Its
 * result is `{ stdout, stderr? }` — the weakest contract that satisfies every
 * existing executor in the repo (`VerifyExecFn`, the driver `ExecFn` and
 * `execp` are all assignable to it; `execp`'s required `stderr` is a subtype
 * of the optional one).
 *
 * Every probe is bounded by `MAINLINE_PROBE_TIMEOUT_MS` and every failure
 * names its cause, because this leaf sits on the fail-closed paths: the review
 * ledger (`identityBase`) and the merge guard compute a patch identity against
 * `<remote>/<mainline>` through here. An unbounded `gh repo view` on a stalled
 * connection settled never, and "never" is the one outcome a fail-closed gate
 * cannot report — no reason, no verdict, no merge.
 */

import type { ExecOpts } from "./exec.ts";

/** The executor shape both `detectMainline` and `resolveMainline` accept. */
export type MainlineExecFn = (
  cmd: string,
  opts?: ExecOpts,
) => Promise<{ stdout: string; stderr?: string }>;

/**
 * Bound on each mainline probe.
 *
 * Both calls are read-only and finish in well under a second when the host is
 * healthy — `git symbolic-ref` reads a local ref, `gh repo view` is one API
 * round-trip. Thirty seconds is the point at which "slow" is plainly a stalled
 * connection or a hung credential prompt, and the caller wants its verdict
 * rather than a promise that never settles. Deliberately a constant rather
 * than an input: `test-headless-inputs.ts` refuses an env read the
 * `--capabilities` inventory does not list, and a knob for a timeout nobody
 * tunes is an input with no operator.
 */
export const MAINLINE_PROBE_TIMEOUT_MS = 30_000;

/**
 * A mainline resolution. `ok` is the discriminator: `resolveMainline` reads
 * the verdict off it alone, never off the presence of a `branch` key (#1153).
 */
export type MainlineResult = { ok: true; branch: string } | { ok: false; reason: string };

/**
 * Resolve the mainline branch name for the current repo (e.g. "main",
 * "master").
 *
 * Two-step resolution:
 *   1. `git symbolic-ref --short refs/remotes/origin/HEAD` — fast, no
 *      network, returns "origin/main" → stripped to "main" in JS.
 *   2. Fallback: the forge adapter's `repoSettings()` (the network call
 *      behind the old `gh repo view --json defaultBranchRef`), used when
 *      origin/HEAD is absent (some fetch configurations don't set it).
 *
 * Returns `{ ok: true, branch }` on success, `{ ok: false, reason }` on
 * failure. The caller (detectMainline) is designed for use both from
 * verifyStepOutcome (via injected ctx.verifyExecFn) and from
 * restoreCheckout (injected at call site).
 *
 * Each probe carries `MAINLINE_PROBE_TIMEOUT_MS`. Both failures are recorded
 * (the executor is a free variable, so a hang, a missing `gh` and a non-zero
 * exit are three different faults) and the failure reason names them, so a
 * timeout reads differently from "gh is not installed".
 *
 * NOTE on shell safety: `git symbolic-ref` takes a fixed ref with no
 * dynamic arguments. The executor takes a shell string; any future
 * caller that wants to pass dynamic branch/repo names must not interpolate
 * them raw — JSON.stringify for quoting or prefer execFile-style arrays.
 */
export async function detectMainline(
  repoRoot: string,
  execFn: MainlineExecFn,
): Promise<MainlineResult> {
  // Each probe's failure cause, in probe order. The failure reason names both
  // — an unreadable mainline is fail-closed downstream, so "it failed" is not
  // an answer an operator can act on.
  const causes: string[] = [];

  // 1. git symbolic-ref — no network, instant.
  try {
    const { stdout } = await execFn("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
      timeout: MAINLINE_PROBE_TIMEOUT_MS,
    });
    const ref = stdout.trim();
    if (ref) {
      // Returns "origin/main" — strip the leading origin/.
      const branch = ref.startsWith("origin/") ? ref.slice(7) : ref;
      if (branch) return { ok: true, branch };
    }
    causes.push("git symbolic-ref: empty origin/HEAD");
  } catch (err) {
    // refs/remotes/origin/HEAD may be absent; fall through.
    causes.push(`git symbolic-ref: ${causeOf(err)}`);
  }

  // 2. Fallback: `gh repo view` — the raw-JSON call is kept rather than
  //    routed through the forge adapter on purpose: the tests inject a
  //    `git symbolic-ref`-answering fake that answers nothing else, and
  //    the forge's `repoSettings()` command shape is not what those fakes
  //    expect. The adapter is the S4 seam for PR operations; this
  //    mainline probe is a git-side call with a `gh` fallback.
  try {
    const { stdout } = await execFn(
      "gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'",
      { cwd: repoRoot, maxBuffer: 64 * 1024, timeout: MAINLINE_PROBE_TIMEOUT_MS },
    );
    const branch = stdout.trim();
    if (branch) return { ok: true, branch };
    causes.push("gh repo view: empty defaultBranchRef");
  } catch (err) {
    // Both methods failed.
    causes.push(`gh repo view: ${causeOf(err)}`);
  }

  return {
    ok: false,
    reason: `could not resolve mainline branch: both git symbolic-ref and gh repo view failed (${causes.join("; ")})`,
  };
}

/**
 * The cause of a failed probe, in the words of whatever failed.
 *
 * `promisify(exec)` puts the shell's own complaint on the error — a timeout
 * carries `command timed out after 30000ms`, a missing `gh` carries
 * `command not found`, a non-zero exit carries the captured stderr. Sliced to
 * 200 chars: this text is embedded in the failure `reason`, which travels into
 * handoff comments and PR bodies, and a chatty `gh` backtrace is not what an
 * operator needs to read there.
 */
function causeOf(err: unknown): string {
  const msg = err instanceof Error && err.message ? err.message : String(err);
  return msg.trim().slice(0, 200);
}

/**
 * #1134 follow-up — detectMainline as a total function for its callers.
 *
 * A caller that reads `.branch` off a value that is undefined, or off an
 * unexpected shape, gets a TypeError rather than a verdict, and a throw from
 * the detector escapes the gate that asked. Both become the same unresolved
 * result a failed detection produces, carrying the reason.
 */
export async function resolveMainline(
  repoRoot: string,
  execFn: MainlineExecFn,
  detect: typeof detectMainline = detectMainline,
): Promise<MainlineResult> {
  let m: unknown;
  try {
    m = await detect(repoRoot, execFn);
  } catch (err) {
    const msg = ((err as Error)?.message ?? String(err)).slice(0, 200);
    return { ok: false, reason: `mainline detection threw: ${msg}` };
  }
  // #1153 — read the discriminated result by its DISCRIMINANT. A `"branch" in m`
  // test passes for any object carrying a `branch` key, including a failure
  // record that happens to have one; `ok` is the only field whose presence is
  // load-bearing for the verdict.
  if (m && typeof m === "object") {
    const mo = m as { ok?: unknown; branch?: unknown; reason?: unknown };
    if (mo.ok === true && typeof mo.branch === "string" && mo.branch.length > 0) {
      return { ok: true, branch: mo.branch };
    }
    if (mo.ok === false && typeof mo.reason === "string" && mo.reason.length > 0) {
      return { ok: false, reason: mo.reason };
    }
  }
  return {
    ok: false,
    reason: "mainline detection returned an unexpected result",
  };
}
