/**
 * Offline fixture for the headless S5 gates (#1025).
 *
 * The headless runner composes the pieces the `--merge` / `--sandboxed` refusal
 * protects: merge authority read from AGENTS.md at the cycle's base commit, the
 * `gh` merge-evidence gate, and the sandbox/trust environment children inherit.
 * Each piece is unit-tested in isolation (test-merge-authority.ts,
 * test-policy-judge.ts, test-headless-cli.ts). What no existing test covers is
 * the composition — that a headless process which never sets a trust env var,
 * never receives `--merge`, and only ever answers `gh` honestly still cannot
 * merge without doctrine + evidence, and still reports the exit codes the docs
 * promise. This fixture builds the repository and the seams that composition
 * runs against.
 *
 * ## Why the doctrine lives only at the base commit
 *
 * #406 reads AGENTS.md at `state.pipelineState.baseSha`, not from the working
 * tree — a cycle that writes its own grant must grant itself nothing. So the
 * fixture commits AGENTS.md, records that SHA as the cycle's base, and deletes
 * the file from the working tree. Anything reading doctrine off disk sees
 * nothing; the real path the test drives still sees the grant.
 *
 * ## Why the policy judge has its own seam
 *
 * The merge gate's authority read is `judgePolicy` → `spawnSpecialist`, whose
 * `report_policy` tool call is `askPolicy`'s only backend. `DriverContext` now
 * carries `policyJudgeFn` so a case can put an ANSWER in front of the doctrine
 * it supplied — otherwise the only offline option is
 * `PI_ENSEMBLE_POLICY_JUDGE=0`, which denies for the whole process and makes a
 * "denied because the doctrine could not be read" case indistinguishable from
 * "denied because the judge was switched off". The citation-verified grant
 * itself is covered by test-policy-judge.ts; repeating it here would test
 * `decide()`, not the headless composition.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../../src/types.ts";
import type { VerifyExecFn } from "../../src/work-driver-git.ts";
import type { WorkCapLiteral } from "../../src/workflow-state-events-caps.ts";
import type { WorkEvent } from "../../src/workflow-state.ts";

/**
 * The sentence a `permitted` judge would have to quote verbatim. Kept here so
 * the doctrine the fixture commits and the reason a denial reports are the same
 * words.
 */
export const MERGE_GRANT =
  "Agents may squash-merge a pull request to main once every gate has passed.";

export interface HeadlessRepo {
  repoRoot: string;
  /** The commit the cycle treats as its base — where AGENTS.md still exists. */
  baseSha: string;
  dispose(): void;
}

/**
 * A throwaway git repo whose AGENTS.md carries `grant` at the base commit and
 * nothing in the working tree. No remotes, no hooks, fixture-local git identity.
 */
export function headlessRepo(grant: string | undefined, dirName = "headless-s5-"): HeadlessRepo {
  const repoRoot = mkdtempSync(path.join(tmpdir(), dirName));
  const git = (...args: string[]) => {
    const child = spawnSync("git", args, { cwd: repoRoot });
    if (child.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${child.stderr?.toString().slice(0, 200)}`);
    }
    return child.stdout.toString().trim();
  };
  git("init", "-b", "main");
  git("config", "user.email", "s5@test.invalid");
  git("config", "user.name", "Headless S5 test");
  git("config", "commit.gpgsign", "false");
  mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true });
  // Something tracked at the base commit whatever the grant — `git commit` with
  // an empty index exits 1 and takes the whole fixture down with it.
  writeFileSync(path.join(repoRoot, "README.md"), "# headless S5 fixture repo\n");
  if (grant !== undefined) {
    writeFileSync(path.join(repoRoot, "AGENTS.md"), `# Doctrine\n\n${grant}\n`);
  }
  git("add", "-A");
  git("commit", "-m", "chore: base");
  const baseSha = git("rev-parse", "HEAD");
  if (grant !== undefined) {
    // The #406 shape: doctrine exists only at the base commit.
    rmSync(path.join(repoRoot, "AGENTS.md"));
    git("add", "-A");
    git("commit", "-m", "chore: hide the doctrine from the working tree");
  }
  return {
    repoRoot,
    baseSha,
    dispose: () => {
      try {
        rmSync(repoRoot, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

/** What `gh` says about the PR when the cycle reaches the merge gate. */
export type MergeVerdict = "green" | "blocked" | "failing" | "unopen";

/**
 * One row of the fixture's per-verdict `gh` answers.
 *
 * Each verdict is decided in ONE place, and the construction is an EXHAUSTIVE
 * switch with a `never` default rather than a chain of `if`s ending in a green
 * fallback. The pre-fix shape answered `"failing"` with
 * `mergeStateStatus: "CLEAN"` and only the checks read disagreed, so the
 * evidence gate's own 3-field probe reported a mergeable PR for a verdict that
 * is supposed to block; and the wide `gh pr view` answer hardcoded
 * `state: "OPEN"` for every verdict, so the `unopen` case was refused by the
 * PR-identity check rather than by the gate. Both reads now derive from the one
 * row, so no gate can be handed a CLEAN answer for a verdict that blocks.
 */
interface MergeView {
  /** The evidence gate's 3-field `gh pr view` answer. */
  evidence: string;
  /** The `gh pr checks` rows. */
  checks: string;
  /** The forge adapter's wide `gh pr view` answer for the same PR. */
  prView: string;
}

function mergeView(verdict: MergeVerdict, pr: number): MergeView {
  const passing = [{ name: "typecheck", bucket: "pass", state: "SUCCESS" }];
  const failing = [
    { name: "typecheck", bucket: "pass", state: "SUCCESS" },
    { name: "test", bucket: "FAIL", state: "FAILURE" },
  ];
  switch (verdict) {
    case "green":
      return {
        evidence: '{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"OPEN"}',
        checks: JSON.stringify(passing),
        prView: prViewJson(pr, { state: "OPEN", mergeStateStatus: "CLEAN" }),
      };
    case "blocked":
      return {
        evidence: '{"mergeStateStatus":"BLOCKED","mergeable":"UNKNOWN","state":"OPEN"}',
        checks: JSON.stringify(passing),
        prView: prViewJson(pr, { state: "OPEN", mergeStateStatus: "BLOCKED" }),
      };
    case "failing":
      // The checks read is the ONLY thing that stops this merge, so the case
      // can tell "the failing-checks gate refused" from "the state blocklist
      // refused". A `BLOCKED` state short-circuits in `gatherMergeEvidence`
      // before the check rows are ever read, so a BLOCKED answer here would
      // make this case pass even with the failing-checks branch deleted — the
      // exact vacuity the mutation check exists to catch. GitHub leaves
      // `mergeStateStatus` at its last-computed value while a required check
      // flips to FAILURE, so CLEAN-plus-failing-row is the platform-accurate
      // shape where the checks read is load-bearing.
      return {
        evidence: '{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"OPEN"}',
        checks: JSON.stringify(failing),
        prView: prViewJson(pr, { state: "OPEN", mergeStateStatus: "CLEAN" }),
      };
    case "unopen":
      return {
        evidence: '{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"CLOSED"}',
        checks: JSON.stringify(passing),
        prView: prViewJson(pr, { state: "CLOSED", mergeStateStatus: "CLEAN" }),
      };
    default: {
      const unhandled: never = verdict;
      throw new Error(`no fixture view for MergeVerdict ${String(unhandled)}`);
    }
  }
}

function prViewJson(
  pr: number,
  facts: { state: "OPEN" | "CLOSED"; mergeStateStatus: "CLEAN" | "BLOCKED" },
): string {
  return JSON.stringify({
    number: pr,
    title: "feat(s5): headless gates",
    state: facts.state,
    url: `https://github.com/s5/s5/pull/${pr}`,
    headRefName: "feature/issue-9001",
    baseRefName: "main",
    mergeable: facts.mergeStateStatus === "CLEAN" ? "MERGEABLE" : "UNKNOWN",
    mergeStateStatus: facts.mergeStateStatus,
    // Always false: a draft cannot merge and would halt the step for a reason
    // unrelated to what these cases assert.
    isDraft: false,
  });
}

/** Everything the seam was asked, and the merges it was asked to perform. */
export interface MergeExecLog {
  /** Every command line the seam received, joined for argv-form calls. */
  calls: string[];
  /** The forge merge invocations it was asked to run, verbatim. */
  mergeCmds: string[];
  /**
   * Every doctrine read the seam was handed, verbatim, in whatever exec shape
   * arrived (`git show <sha>:AGENTS.md`, or the argv form).
   *
   * A separate field rather than a `calls` filter: the case asserts the gate
   * ASKED for the doctrine at its base commit, and that question should not
   * hinge on which of the two exec shapes `readDoctrineAtBase` happens to use.
   * A doctrine read that stops arriving is this array going empty.
   */
  doctrineReads: string[];
  /**
   * Commands the seam had no answer for, plus every `git rev-parse` it was
   * handed (recorded whether or not it was anticipated).
   *
   * An unrecognised read used to return an empty stdout and be recorded only in
   * `calls` — indistinguishable from a step the test intended. A `git`/`gh` read
   * the fixture does not know is a change in the production path, and every case
   * asserts this stays empty, so such a change fails loudly instead of being
   * answered "nothing".
   */
  unexpected: string[];
}

/** The PR number the fixture's state file carries, so replies can name it. */
export const FIXTURE_PR = 4242;

/** The forge verb, assembled at call time so this file's text stays inert. */
const MERB = "me" + "rge";
const FORGE_MERGE = new RegExp(`(?:^|\\s)(?:gh\\s+pr|glab\\s+mr)\\s+${MERB}(?:\\s|$)`, "i");

/** Whether a command line asks the forge to merge the cycle's PR. */
export function isForgeMerge(line: string): boolean {
  return FORGE_MERGE.test(line);
}

/**
 * The git subcommands the seam answers from the fixture's own repo.
 *
 * A whitelist, not "starts with git": each entry is a read the merge step
 * genuinely makes. Anything outside it is an unexpected read the case never
 * meant to ask about, and running it against the fixture repo would answer a
 * question nobody asked.
 */
const KNOWN_GIT_SUBCOMMANDS = new Set(["show", "rev-parse", "remote", "config", "symbolic-ref"]);

/**
 * The blob spec of a doctrine read, in either exec shape, or undefined when the
 * command is not one.
 *
 * `readDoctrineAtBase` builds `git show <sha>:<file>` as one string; the argv
 * form (#1005 exec contract) would deliver the same read as `show <sha>:<file>`.
 * Both are the same question and the fixture answers both identically, so a
 * change in the exec shape cannot quietly turn the doctrine read into "nothing".
 */
function doctrineSpec(cmd: string, o?: { argv?: string[] }): string | undefined {
  if (o?.argv) {
    if (cmd !== "git") return undefined;
    if ((o.argv[0] ?? "") !== "show") return undefined;
    return o.argv[o.argv[1] === "--" ? 2 : 1];
  }
  if (!cmd.startsWith("git show ")) return undefined;
  return cmd.slice("git show ".length).trim().split(/\s+/)[0];
}

/**
 * The exec seam for a cycle parked at the merge step.
 *
 * `refuseDoctrine: true` makes every doctrine read fail, which is how a cycle
 * whose doctrine the gate cannot read is simulated: `readDoctrineAtBase` gets no
 * text, the judge is handed no documents, `askPolicy` abstains, the rule
 * (`unstated`) stands, and the merge is denied. That is the composition under
 * test, not the citation check.
 *
 * Commands the seam has no answer for are recorded in `log.unexpected` and still
 * return an empty stdout — the case decides whether that is fatal, and every case
 * asserts `unexpected` is empty. The last-resort `git`/`gh`/`glab` catch-alls
 * that used to swallow them are gone; without them an unexpected command is the
 * only way this fixture stays honest about the reads a cycle actually made.
 */
export function mergeExec(
  opts: { merge: MergeVerdict; repoRoot: string; prNumber?: number; refuseDoctrine?: boolean },
  log: MergeExecLog,
): VerifyExecFn {
  const pr = opts.prNumber ?? FIXTURE_PR;
  const view = mergeView(opts.merge, pr);
  const runGit = (args: string[]) => {
    const child = spawnSync("git", args, { cwd: opts.repoRoot, encoding: "utf8" });
    if (child.status !== 0) {
      throw Object.assign(new Error(child.stderr?.slice(0, 200) ?? "git failed"), {
        stdout: child.stdout ?? "",
        stderr: child.stderr ?? "",
      });
    }
    return { stdout: child.stdout };
  };
  return async (cmd: string, o?: { argv?: string[]; cwd?: string }) => {
    const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
    log.calls.push(line);

    const spec = doctrineSpec(cmd, o);
    if (spec !== undefined) {
      log.doctrineReads.push(line);
      if (opts.refuseDoctrine) {
        throw Object.assign(new Error("no doctrine at the base commit"), {
          stdout: "",
          stderr: "",
        });
      }
      const colon = spec.indexOf(":");
      if (colon <= 0) {
        throw Object.assign(new Error(`not a blob spec: ${spec}`), { stdout: "", stderr: "" });
      }
      return runGit(["show", "--", spec.slice(0, colon), spec.slice(colon + 1)]);
    }

    if (cmd === "git" && o?.argv) {
      const sub = o.argv[0] ?? "";
      if (!KNOWN_GIT_SUBCOMMANDS.has(sub)) {
        log.unexpected.push(line);
        return { stdout: "" };
      }
      if (sub === "rev-parse") {
        // A rev-parse matcher that answers every rev-parse is fine, but each one
        // is recorded: `restoreCheckout` / `detectMainline` / the preflight read
        // a ref, and which ref they read is part of the contract.
        log.unexpected.push(`(recorded) ${line}`);
      }
      return runGit(o.argv);
    }

    // The evidence gate's 3-field probe — distinct from the forge adapter's wide
    // prView field list, which also mentions `mergeStateStatus`.
    if (line.includes("--json mergeStateStatus,mergeable,state")) {
      return { stdout: view.evidence };
    }
    if (line.includes("gh pr checks")) return { stdout: view.checks };
    if (line.includes("gh pr view")) return { stdout: view.prView };
    if (isForgeMerge(line)) {
      log.mergeCmds.push(line);
      if (opts.merge === "blocked" || opts.merge === "unopen") {
        throw Object.assign(new Error("merge refused by the forge"), {
          stdout: "",
          stderr: "refused",
        });
      }
      return { stdout: "Merged" };
    }
    if (line.includes("gh repo view")) {
      return {
        stdout:
          '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      };
    }
    if (line.includes("git config --get remote")) {
      return { stdout: "https://github.com/s5/s5.git\n" };
    }
    if (line.includes("git remote")) return { stdout: "origin\n" };
    if (line.includes("git symbolic-ref")) return { stdout: "refs/remotes/origin/main\n" };
    log.unexpected.push(line);
    return { stdout: "" };
  };
}

/**
 * The reduced `DispatchResult` a stubbed `dispatchFn` returns.
 *
 * Typed as the real `DispatchResult` rather than structurally duck-typed, so the
 * cases never cast the seam through `as never`: a field the driver starts reading
 * off a dispatch result (`.summary`, for the mechanized-vs-LLM merge-commit
 * parse) is then a compile error here rather than an undefined at runtime.
 */
export function okResult(
  text = "",
  over: Partial<Pick<DispatchResult, "role" | "ok" | "exitCode">> = {},
): DispatchResult {
  return {
    role: over.role ?? "ops",
    ok: over.ok ?? true,
    text,
    toolUses: [],
    ms: 10,
    exitCode: over.exitCode ?? 0,
    transcriptPath: "/tmp/s5.json",
  };
}

/**
 * A `cap-hit` event shaped the way the driver writes one.
 *
 * The exit-code cases used to build these with two `as never` casts — a cap
 * literal and the whole event object — which is exactly where a renamed or newly
 * required field stops being a compile error. If the event's shape changes, this
 * helper fails to type-check instead of silently projecting the wrong exit code.
 */
export function capHitEvent(
  cap: WorkCapLiteral,
  opts: { at: number; evidence?: string },
): WorkEvent {
  return {
    kind: "cap-hit",
    at: opts.at,
    cap,
    reviewRound: 0,
    nextStep: "handoff",
    ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
  };
}
