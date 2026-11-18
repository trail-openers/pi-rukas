/**
 * work-driver-verify-baseline-stale — #2341: is a red base simply BEHIND the
 * default branch?
 *
 * Split out of `work-driver-verify-baseline.ts` along the natural seam
 * (AGENTS.md §12: that module is the develop gate's baseline COMPARISON — the
 * probe that runs the command at base and the verdict it returns; this one is
 * the single git fact the handoff renders alongside it, plus the renderer of
 * that fact's public sentence — {@link staleBaseClosing}). The direction is
 * one-way: baseline → stale, nothing here calls back.
 *
 * The defect this closes. A base that trails the default branch can be red
 * only because it predates commits mainline already carries, and the handoff
 * told the operator to "fix the gate at the base commit" — advice no change
 * authored on that base can act on (one production cycle spent 58 minutes on
 * it while the fix already sat on the default branch). So the handoff asks
 * this question after a genuine red and, when the base is a strict ancestor of
 * the default-branch tip, states the divergence and drops that instruction.
 *
 * THE RULE THIS MODULE OWNS: the answer is TRI-STATE. An unreadable git call is
 * `unknown`, never a silent "no" — the same convention
 * `work-driver-adversarial-fix-git.ts`'s `isAncestor` follows, where
 * `merge-base --is-ancestor` exit 1 is git's definitive NO and every other
 * failure is an unreadable probe. Silence is never a pass in either direction:
 * `unknown` renders as "could not be established", never as "mainline does not
 * explain the red".
 *
 * Local reads only — no `gh`, no network — because this runs on the red path
 * INSIDE the develop gate, where a network probe is a hang the gate did not
 * budget for. The reasons are a FIXED VOCABULARY, never git's own error text:
 * they reach the operator-visible handoff, which is published to a public
 * forge, and `execFile`'s message is `Command failed: git\n<stderr>` — a
 * redirect of the repository's own paths into that surface. The raw text goes
 * to `trace` instead, which the operator's transcript carries and the handoff
 * does not.
 */
import { redactSecrets } from "./secret-patterns.ts";
import { trace } from "./trace.ts";
import { CAP_EVIDENCE_PER_FAILURE_MAX } from "./work-develop-cap-evidence.ts";
import { TIER_KNOB, TIER_TIMEOUT_FILE, VERIFY_TIMEOUT_ENV } from "./work-driver-verify-budget.ts";
import { detailLooksCredential } from "./work-driver-verify-credential-screen.ts";
import { VERIFY_TIMEOUT_LABEL, boundText } from "./work-driver-verify-develop-helpers.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * #2341 — rides mid-string on a `baselineRedMessage` whose red is plausibly
 * explained by commits the base predates on the default branch. The two
 * explainers (`explainNoVerdictCap`, `explainVerifyFailed`) key on it to drop
 * the "Fix the gate at the base commit" instruction, which is unactionable
 * advice when the base can never go green because mainline already moved on.
 * It rides INSIDE the `[baseline-red]` entry, so an explain site must never
 * ask it of a different entry than the one it asked the red marker of.
 */
export const BASELINE_STALE_BASE_MARKER = "[baseline-behind-default-branch]";

/**
 * #2341 — the tri-state answer of the stale-base probe, asked only after a
 * base run came back red. `behind` is the git fact the handoff may state
 * (base is a strict ancestor of the default-branch tip, N commits back);
 * `not-behind` is the answer that keeps the fix-the-base advice; `unknown` is
 * an unreadable probe — it never reads as "the red is not explained by
 * mainline commits" with confidence, so the handoff says it could not
 * establish the fact. Silence is never a pass in either direction.
 */
export type BaseBehindDefaultBranch =
  | {
      status: "behind";
      /** The default branch name ("main"), without the remote prefix. */
      branch: string;
      commitsBehind: number;
      /** `git log --oneline` subjects of the missing commits, newest first. */
      commits: readonly string[];
    }
  | { status: "not-behind" }
  /** A fixed-vocabulary reason (see the module header), never git's own text. */
  | { status: "unknown"; reason: string };

/** The fixed vocabulary the `unknown` arm renders. No git text reaches here. */
const UNRESOLVED_REF = "the default branch could not be resolved locally";
const ANCESTRY_UNREADABLE = "the ancestry read did not answer";
const DIVERGENCE_UNREADABLE = "the divergence read did not answer";

/**
 * #2341 — is the red base simply BEHIND the default branch? Three local git
 * reads against the cycle's own checkout (the probe's throwaway tree is
 * detached and carries no remote refs), and every one is TRI-STATE: a git call
 * that could not answer is `unknown`, never a silent "no".
 *
 * `origin/HEAD` is the primary resolution with `main` and `master` as the two
 * names every clone answers to; a clone whose default branch is neither gets
 * `unknown`, not a guess.
 *
 * `behind` requires BOTH halves of the git fact: the base is a strict ancestor
 * of the default-branch tip AND commits sit between them. A diverged base (not
 * an ancestor) is `not-behind`: the probe cannot claim mainline moves the red
 * for a base that carries its own commits.
 */
export async function probeBaseBehindDefault(
  execFn: ExecFn,
  opts: { repoRoot: string; baseSha: string; env?: NodeJS.ProcessEnv },
): Promise<BaseBehindDefaultBranch> {
  const git = async (
    argv: string[],
  ): Promise<{ ok: true; stdout: string } | { ok: false; code?: number }> => {
    try {
      const { stdout } = await execFn("git", {
        argv,
        cwd: opts.repoRoot,
        maxBuffer: 256 * 1024,
        timeout: 30_000,
        ...(opts.env === undefined ? {} : { env: opts.env }),
      });
      return { ok: true, stdout };
    } catch (err) {
      const e = err as Error & { code?: number | string };
      const code = typeof e.code === "number" ? e.code : undefined;
      // git's own words, which may name local paths, go to the transcript only.
      trace(
        `work-driver: baseline stale-base probe \`git ${argv.join(" ")}\` failed: ${e.message ?? ""}`,
      );
      return code === undefined ? { ok: false } : { ok: false, code };
    }
  };
  let ref = "";
  const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head.ok && head.stdout.trim() !== "") ref = head.stdout.trim();
  else {
    for (const candidate of ["origin/main", "origin/master"]) {
      const r = await git(["rev-parse", "--verify", "--quiet", candidate]);
      if (r.ok && r.stdout.trim() !== "") {
        ref = candidate;
        break;
      }
    }
  }
  if (ref === "") return { status: "unknown", reason: UNRESOLVED_REF };
  const ancestor = await git(["merge-base", "--is-ancestor", opts.baseSha, ref]);
  if (!ancestor.ok) {
    // Exit 1 is git's definitive NO; anything else never read as either answer.
    return ancestor.code === 1
      ? { status: "not-behind" }
      : { status: "unknown", reason: ANCESTRY_UNREADABLE };
  }
  const log = await git(["log", "--oneline", "--no-decorate", `${opts.baseSha}..${ref}`]);
  if (!log.ok) return { status: "unknown", reason: DIVERGENCE_UNREADABLE };
  const commits = log.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (commits.length === 0) return { status: "not-behind" };
  return {
    status: "behind",
    branch: ref.replace(/^origin\//, ""),
    commitsBehind: commits.length,
    commits,
  };
}

/**
 * #2341 / fix wave 4 — the `behind` arm's closing sentence for the
 * `[baseline-red]` handoff, rendered where the fact and its vocabulary live.
 * `branch` is `git symbolic-ref` output and the subjects are
 * `git log --oneline` output from the OPERATOR's repository, and the sentence
 * rides into a PUBLIC handoff (cap evidence, issue body), so every piece of
 * it goes through the verify-evidence credential screen
 * (`detailLooksCredential`, the one the verify record's channels and the
 * header-detail harvest ask) and `redactSecrets`: a credential-shaped
 * subject is dropped whole (the keyword-shaped `looksLikeCredential` alone
 * has no arm for the unprefixed base64 blob an author who pasted a key
 * actually prints), and a credential-shaped branch name is demoted to the
 * fixed `the default branch` — the arm keeps its value, the divergence
 * count being the actionable half. The ` (+N more)` disclosure counts
 * against what was SHOWN, not the two slots, and a screen-dropped subject is
 * disclosed as withheld.
 */
export function staleBaseClosing(
  behind: Extract<BaseBehindDefaultBranch, { status: "behind" }>,
  opts: { subjects?: boolean } = {},
): string {
  const candidates = opts.subjects === false ? [] : behind.commits.slice(0, 2);
  const shown: string[] = [];
  for (const c of candidates) {
    if (detailLooksCredential(c)) continue;
    shown.push(redactSecrets(c).text.slice(0, 60));
  }
  const withheld = candidates.length - shown.length;
  const branchLabel = detailLooksCredential(behind.branch)
    ? "the default branch"
    : redactSecrets(behind.branch).text;
  // The compact arm (#2341 fix wave 5, H3) shows no subjects at all, so the
  // "+N more" disclosure would only restate the count the sentence already
  // carries — it is dropped with the subjects, not left to double the width.
  const more = opts.subjects === false ? 0 : behind.commits.length - shown.length;
  // The branch is NAMED ONCE (#2341 fix wave 5, H3). It used to be printed
  // three times in one sentence — the divergence, the attribution and the
  // re-run instruction — which cost three times the branch name's width in the
  // 800-char cap-evidence entry (and three copies of the redaction on a
  // credential-shaped name, which is a disclosure the sentence never needed).
  // The two later mentions carry no fact the first does not: the operator
  // re-runs on the branch the sentence just named.
  return `${BASELINE_STALE_BASE_MARKER} the base trails ${branchLabel} by ${behind.commitsBehind} commit${
    behind.commitsBehind === 1 ? "" : "s"
  }${shown.length > 0 ? ` — ${shown.join("; ")}` : ""}${more > 0 ? ` (+${more} more)` : ""}${
    withheld > 0 ? ` (${withheld} subject${withheld > 1 ? "s" : ""} withheld)` : ""
  }: the red may be that branch's, not the base's (divergence, not cause); re-run on a base that includes it`;
}

/**
 * The recognition floor the cmd is clipped down to when the frame alone has
 * eaten the window (#2341 fix wave 4, H3) — long enough for the operator to
 * name the command back, short enough to buy the assertion its room. Lives
 * here with its other renderer (#2341 fix wave 6, ISSUES 1: moving the
 * `red-timed-out` arm here brought the floor's home too); `baselineRedMessage`
 * imports it for the red arm's own cmd clip.
 */
export const CMD_FLOOR = 12;

/**
 * The `red-timed-out` entry of `baselineRedMessage` (#1509), rendered by the
 * handoff-renderer half of this split (#2341 fix wave 6, ISSUES 1) under the
 * SAME budget discipline as the red arm: the unbounded operator-authored cmd
 * used to be the one variable part nobody budgeted — a 400-char command
 * published an entry past the cap-evidence bound, and the cap's own tail
 * amputation then ate the LEADING `[baseline-red]` marker the entry exists to
 * carry. The cmd is the only variable part of this entry, so the cmd pays:
 * quoted whole whenever it fits, clipped with the renderer's own `\u2026`
 * (the span `baselineRedForCommand` licenses) below that, floored at
 * recognition — and the marker leads whatever survives. The knob named is the
 * one that governs the tier the probe ran (the suite tier), and the bound is
 * the caller's `timeoutMs` threaded in rather than re-read, so the text can
 * only ever describe the run that actually happened.
 */
export function timedOutRedEntry(
  marker: string,
  cmd: string,
  timeoutMs: number,
  where: string,
  suffix: string,
): string {
  const lead = `${marker} ${VERIFY_TIMEOUT_LABEL} verify command \``;
  const rest = `\` exceeded its ${boundText(timeoutMs)} timeout ${where} — the gate cannot finish inside its bound on this host whatever the diff contains. Raise ${TIER_KNOB.suite} (or .pi/${TIER_TIMEOUT_FILE.suite}, or ${VERIFY_TIMEOUT_ENV} in the environment) or make the gate faster; the failures below do not implicate this change${suffix}`;
  const over = lead.length + cmd.length + rest.length - CAP_EVIDENCE_PER_FAILURE_MAX;
  const cmdText =
    over > 0 ? `${cmd.slice(0, Math.max(CMD_FLOOR, cmd.length - over - 1))}\u2026` : cmd;
  return `${lead}${cmdText}${rest}`;
}
