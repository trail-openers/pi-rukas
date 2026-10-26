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
import { gitTestEnv } from "./git-test-env.ts";
import { isKnownGitSubcommand, runFixtureGit } from "./headless-s5-git.ts";
import {
  EVIDENCE_HEAD,
  FIXTURE_PATCH_ID,
  FIXTURE_PR,
  type MergeVerdict,
  doctrineSpec,
  issueView,
  isForgeMerge,
  isVisibilityLookup,
  mergeView,
} from "./headless-s5-forge.ts";

// Re-exported so the harness and every case keep importing the forge rows from
// the fixture they already know; the declarations live in `headless-s5-forge.ts`
// only so each file stays under the §12 cap.
export {
  EVIDENCE_HEAD,
  FIXTURE_PATCH_ID,
  FIXTURE_PR,
  type MergeVerdict,
  isForgeMerge,
} from "./headless-s5-forge.ts";

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
 * Write the per-clone review ledger the merged step's identity check reads
 * (#1533): one adversarial row for `branch`, whose patchId is the id the exec
 * seam's `git patch-id` answers.
 *
 * The row's shape is the whole point. A cycle that reaches the merge with NO
 * row is a cycle nobody reviewed, and the head check parks it — so the positive
 * control needs this file, and a case that wants the mismatch park asks for a
 * row that did not pass. `passed` is a parameter rather than a constant so the
 * negative case is one call, not a fixture edit. The ledger lives where the
 * clone keeps it: under the git dir.
 */
export function seedReviewLedger(repoRoot: string, branch: string, passed = true): void {
  writeFileSync(
    path.join(repoRoot, ".git", "review-ledger.json"),
    JSON.stringify({
      entries: [
        {
          branch,
          kind: "adversarial",
          patchId: FIXTURE_PATCH_ID,
          passed,
          at: 1,
          round: 1,
          hasCritical: false,
        },
      ],
    }),
  );
}

/**
 * A throwaway git repo whose AGENTS.md carries `grant` at the base commit and
 * nothing in the working tree. No remotes, no hooks, fixture-local git identity.
 */
export function headlessRepo(
  grant: string | undefined,
  dirName = "headless-s5-",
  branch = `feature/issue-${FIXTURE_PR}`,
  reviewRow = true,
): HeadlessRepo {
  const repoRoot = mkdtempSync(path.join(tmpdir(), dirName));
  const git = (...args: string[]) => {
    // #1145 — `env: gitTestEnv()`: `spawnSync` with no `env` inherits the REAL
    // `environ` on bun 1.3, and the base SHA this repo records is where the
    // doctrine read (#406) resolves, so a host ignore file or
    // `init.defaultBranch` would move the composition's verdict off the code.
    const child = spawnSync("git", args, { cwd: repoRoot, env: gitTestEnv() });
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
  // #1533 — the merged step's identity comparison reads the per-clone review
  // ledger, and a cycle that reaches the merge with NO adversarial row is a
  // cycle nobody reviewed: the check parks it. Seed one passing row for the
  // cycle's branch, carrying the patch id the exec seam's `git patch-id`
  // answers, so the identity the merged step computes is the identity on file.
  // A case that wants the mismatch park passes `reviewRow: false`.
  if (reviewRow) seedReviewLedger(repoRoot, branch);
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

/** Everything the seam was asked, and the merges it was asked to perform. */
export interface MergeExecLog {
  /** Every command line the seam received, joined for argv-form calls. */
  calls: string[];
  /** The forge merge invocations it was asked to run, verbatim. */
  mergeCmds: string[];
  /**
   * Every wide `gh pr view` ANSWER the seam handed back, in the order asked.
   *
   * `calls` records the commands; this records the replies. The positive
   * control needs both to make its ordering claim: "the forge said MERGED"
   * is content, and "only after the merge was asked for" is order.
   */
  prViewAnswers: string[];
  /** #1533 — the head verification's fetch, and the rev-parse that records the
   * fetched head. Both are answered by the fixture rather than run against a
   * remote these throwaway repos do not have. */
  headFetches: string[];
  headReads: string[];
  /** #1472 — every `gh issue view` the seam answered, verbatim. */
  issueViewCmds: string[];
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
 *
 * The `"merged"` control is stateful: the wide `gh pr view` answers OPEN until
 * the forge merge has been asked for, and MERGED after it. That ordering is what
 * makes the post-merge verification real — an adapter that never issued the
 * merge would still see MERGED from a fixture that hardcoded it, and the
 * positive control would prove nothing.
 */
export function mergeExec(
  opts: {
    merge: MergeVerdict;
    repoRoot: string;
    prNumber?: number;
    refuseDoctrine?: boolean;
    /** #1472 — answer the issue-view with CLOSED so a case can exercise the gate. */
    issueState?: "OPEN" | "CLOSED";
  },
  log: MergeExecLog,
): VerifyExecFn {
  const pr = opts.prNumber ?? FIXTURE_PR;
  let mergeAsked = false;
  const runGit = (args: string[]) => runFixtureGit(args, opts.repoRoot);
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
      // #1533 — `git symbolic-ref` answers the mainline probe, and these
      // throwaway repos have no `refs/remotes/origin/HEAD` at all: without this
      // the fixture's own answer was shadowed by the real git failing on a ref
      // that does not exist, and every merging case parked on an unreadable
      // mainline. The fixture's `main` is the same answer its `gh repo view`
      // fallback already gives.
      if (sub === "symbolic-ref") return { stdout: "origin/main\n" };
      if (sub === "merge-base") {
        // #1533 — the identity's merge base, over refs this remote-less clone
        // cannot resolve. Answered with a fixed OID so the patch identity is
        // computed (and compared) rather than the check refusing an unreadable
        // base; the comparison itself is what the case under test asserts on.
        log.headReads.push(line);
        return { stdout: `${EVIDENCE_HEAD}\n` };
      }
      if (sub === "check-ref-format") {
        // #1533 — the branch-name guard for the head read. These fixture repos do
        // not have the cycle's branch at all, so the real git refused it and the
        // merged step parked. Answered as valid; the identity comparison is what
        // the cases assert on, not whether the local branch exists.
        log.headReads.push(line);
        return { stdout: "" };
      }
      if (sub === "diff") {
        log.headReads.push(line);
        return { stdout: "" };
      }
      // #1533 — the merged step fetches the head and the mainline before it
      // trusts any identity, and these throwaway fixture repos have no remote
      // at all. The head verification's OWN reads (fetch, the rev-parse that
      // records the fetched head) are answered here rather than against the
      // origin that does not exist; everything else the whitelist serves still
      // runs against the real fixture repo, so an unexpected read is still
      // unexpected. A cycle that reached this fetch with a real remote would
      // have had one in `git remote`, and the check refuses that case instead.
      if (sub === "fetch") {
        log.headFetches.push(line);
        return { stdout: "" };
      }
      if (sub === "rev-parse" && o.argv.some((w) => w.startsWith("origin/"))) {
        // #1533 — the head verification's read of the fetched head, and the
        // merge-base computation behind it. Both name `origin/<branch>` refs that
        // these remote-less fixture repos cannot resolve, so the seam answers
        // them directly; every other rev-parse still runs against the fixture's
        // real repo, so an unexpected read stays unexpected.
        log.headReads.push(line);
        return { stdout: `${EVIDENCE_HEAD}\n` };
      }
      // #1533 — `readyPatchId` resolves the branch tip through `resolveHeadSha`,
      // which prefixes `-C <cwd>` and therefore is not the `rev-parse` subcommand
      // at argv[0]. Same reasoning: an `origin/<branch>` ref this fixture cannot
      // resolve, answered with the OID the evidence probe reported.
      if (
        sub === "-C" &&
        o.argv[2] === "rev-parse" &&
        o.argv.some((w) => w.startsWith("origin/"))
      ) {
        log.headReads.push(line);
        return { stdout: `${EVIDENCE_HEAD}\n` };
      }
      if (!isKnownGitSubcommand(o.argv)) {
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

    // #1533 — the ledger path helper resolves the clone's git dir with a STRING
    // form call (`git rev-parse --git-common-dir`, no argv), so the argv branch
    // above never sees it and it landed in `unexpected`. It reads the fixture's
    // own repo, so run it there and record it as an anticipated read.
    if (line === "git rev-parse --git-common-dir") {
      log.headReads.push(line);
      return runGit(["rev-parse", "--git-common-dir"]);
    }

    // The evidence gate's 3-field probe — distinct from the forge adapter's wide
    // prView field list, which also mentions `mergeStateStatus`.
    if (line.includes("--json mergeStateStatus,mergeable,state")) {
      return { stdout: mergeView(opts.merge, pr, mergeAsked).evidence };
    }
    // #1472 — the closed-issue gate and the attention check both read the
    // issue state through the forge. Unanswered, they land in `unexpected` and
    // every case reaching a step boundary fails the clean-log assertion. OPEN
    // unless a case asks otherwise: a fixture answering CLOSED would park
    // every cycle.
    if (line.includes("gh issue view")) {
      log.issueViewCmds.push(line);
      return { stdout: issueView(opts.issueState) };
    }
    if (line.includes("gh pr checks")) return { stdout: mergeView(opts.merge, pr, mergeAsked).checks };
    if (line.includes("gh pr view")) {
      const answer = mergeView(opts.merge, pr, mergeAsked).prView;
      log.prViewAnswers.push(answer);
      return { stdout: answer };
    }
    if (isForgeMerge(line)) {
      log.mergeCmds.push(line);
      // The stateful control: recording the request is what turns the forge's
      // answer to `gh pr view` into MERGED, so the post-merge verification in
      // `executeAndVerifyMerge` confirms a merge that was actually issued.
      mergeAsked = true;
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
    // The driver publish seam's ONE visibility question (#1820 widened which
    // publishes ask it). `false` = public, the shape every case here assumes:
    // a public repository is the only one the hygiene checks apply to at all.
    if (isVisibilityLookup(cmd, o?.argv)) {
      return { stdout: "false\n" };
    }
    if (line.includes("git config --get remote")) {
      return { stdout: "https://github.com/s5/s5.git\n" };
    }
    if (line.includes("git remote")) return { stdout: "origin\n" };
    if (line.includes("git symbolic-ref")) return { stdout: "origin/main\n" };
    // #1533 — the merged step's identity reads that name `origin/<ref>`s these
    // remote-less fixture repos cannot resolve: the merge base and the patch
    // identity over it. Both are STRING-form calls, so the argv branch above
    // never sees them and they landed in `unexpected`. The OID and the patch
    // id are fixed, so the identity comparison the cases assert on runs.
    if (line.startsWith("git merge-base ") && line.includes("origin/")) {
      log.headReads.push(line);
      return { stdout: `${EVIDENCE_HEAD}\n` };
    }
    if (line.includes("git patch-id")) {
      log.headReads.push(line);
      return { stdout: `${FIXTURE_PATCH_ID} commit\n` };
    }
    // #1533 — the merged step's identity check resolves the mainline through the
    // STRING form of this probe (the argv branch above cannot see it), and this
    // clone has no `refs/remotes/origin/HEAD`: the real git always failed here,
    // so every merging case parked on an unreadable mainline. `origin/main` is
    // what the fixture's `gh repo view` fallback answers anyway.

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
