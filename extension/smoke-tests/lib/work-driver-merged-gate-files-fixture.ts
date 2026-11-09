#!/usr/bin/env bun
/**
 * The fixture behind `test-work-driver-merged-gate-files.ts` (#1529): one
 * parked-at-`merged` cycle, driven through the real `runWorkDriver`, whose
 * doctrine, judge answers and PR change set are all chosen by the case.
 *
 * The base-commit `AGENTS.md` is supplied the way the doctrine fixtures do: the
 * text lives in a real throwaway clone, committed at the SHA the state file
 * records as `baseSha`, and then deleted from the working tree. A gate that read
 * doctrine off disk would see nothing and every case here would park for a
 * reason unrelated to what it asserts.
 *
 * The judge arrives through the policy seam (`policyJudgeFn`) under
 * `PI_ENSEMBLE_FORBID_LIVE_SPAWN=1`, which is what `mergeAuthorityJudge`
 * requires before it honours an injected judge — so the gate-file question is
 * answered by the case's own function, never by a spawned child.
 *
 * Merge commands are never spelled as literals here or in the test: the
 * mode-independent merge guard reads the bash command text of every tool call
 * (#1390 / #1417).
 *
 * `PI_ENSEMBLE_MERGE_AUTHORITY` is set per case, never inherited: the merged step
 * reads it at call time, so a case asking for the authority switch off gets it and
 * every other case gets the gate on, whatever the ambient process carried.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DispatchResult } from "../../src/types.ts";
import type { PolicyJudgeFn } from "../../src/work-driver-policy.ts";
import type { DriverContext } from "../../src/work-driver-context.ts";
import type { VerifyExecFn } from "../../src/work-driver-git.ts";
import { runWorkDriver } from "../../src/work-driver.ts";
import {
  type WorkState,
  initialState,
  readState,
  writeState,
} from "../../src/workflow-state.ts";
import { commandOf } from "./argv-shell.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { isNulDiffRead, nulNameStatus } from "./nul-porcelain.ts";

/** The head the forge reports and the lens row reviewed — nothing moved since the review. */
export const HEAD_OID = "1".repeat(39) + "a";
/** The patch identity the head check reads for that head. */
export const PATCH_ID = "2".repeat(39) + "b";
/** The merge base the identity and the protected diff read resolve to. */
export const MERGE_BASE = "3".repeat(39) + "c";

/**
 * The doctrine that grants the merge. The authority gate needs it in every case
 * that reaches the declared gate-file gate, which sits after authority, evidence
 * and the head check.
 */
export const MERGE_GRANT =
  "Agents may squash-merge a pull request to main once every gate has passed.";

/**
 * The merge grant plus the repository's own declaration of a gate file.
 *
 * The doctrine spells the phrase "gate files" (that mention is what asks the
 * declared-list question) but declares only paths OUTSIDE the built-in protected
 * set: a document that named `.github/` would be caught by the protected gate
 * before the declared gate-file gate ran, and the case would assert that gate.
 */
export function declaredDoc(declaration: string): string {
  return `${MERGE_GRANT}\n\n${declaration}`;
}

/** Doctrine that mentions the mechanism without declaring a single path. */
export const MENTION_WITHOUT_DECLARATION =
  "Some paths are gate files and the maintainer decides them per pull request.";

/** A judge's `report_policy` call carrying a declared path and its quote. */
export function gateFileEntry(pathValue: string, quote: string): { path: string; quote: string } {
  return { path: pathValue, quote };
}

/**
 * A judge that records every prompt it was handed and answers the ONE question it
 * was asked. It answers by the question's own words rather than by call order,
 * because the two questions a merging cycle asks do not arrive in a fixed order:
 * `--merge` short-circuits the authority question, so a gate-file case may see
 * one call or two.
 *
 * `entries` is what the declared-list question reports; omitting it answers
 * `unstated`, which is how a case says "the judge had nothing to declare" without
 * silencing the merge grant it gives to the other question.
 */
export function gateFileJudge(opts: {
  /** The path the judge declares, or `[]` to declare nothing. */
  declares?: string;
  /** Throw instead of answering — an unavailable judge, not a refusing one. */
  throws?: boolean;
  calls: string[];
}) {
  return async (prompt: string) => {
    opts.calls.push(prompt);
    if (opts.throws) throw new Error("the judge child could not be spawned");
    // Routed by the QUESTION, not by the documents: the two questions a merging
    // cycle asks carry their own wording, and with `--merge` the authority
    // question is never asked at all, so the documents alone cannot say which
    // question this is.
    const asked = /^## The question\n\n([\s\S]*?)\n\n## /m.exec(prompt)?.[1] ?? "";
    if (!/declare as gate files/i.test(asked)) {
      return {
        toolUses: [
          { name: "report_policy", arguments: { verdict: "permitted", quote: MERGE_GRANT } },
        ],
      };
    }
    const declared = opts.declares;
    if (declared === undefined) {
      return { toolUses: [{ name: "report_policy", arguments: { verdict: "unstated" } }] };
    }
    // The judge quotes the document's own declaration sentence — the one line that
    // names the path it reports. Anything else the seam's citation check refuses.
    const doc = /<<<DOCUMENT [^\n]+\n([\s\S]*?)\nDOCUMENT>>>/.exec(prompt)?.[1] ?? "";
    const cited = /<<<DOCUMENT ([^\n]+)\n/.exec(prompt)?.[1];
    const sentence = doc
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.includes(declared));
    if (sentence === undefined) {
      return { toolUses: [{ name: "report_policy", arguments: { verdict: "unstated" } }] };
    }
    return {
      toolUses: [
        {
          name: "report_policy",
          arguments: {
            verdict: "permitted",
            quote: sentence,
            ...(cited ? { sourceFile: cited } : {}),
            entries: [gateFileEntry(declared, sentence)],
          },
        },
      ],
    };
  };
}

/**
 * A throwaway clone whose AGENTS.md exists ONLY at the SHA it returns as
 * `baseSha`, and not in the working tree.
 *
 * The shape matters: `readDoctrineAtBase` asks `git show <sha>:AGENTS.md`, and
 * when that sha's tree has no such file git answers the spec as a REVISION and
 * prints the deletion's commit metadata — a judge would then be handed a diff and
 * quote from it, and a gate that verifies quotes against "the doctrine" would be
 * verifying a diff. So the doctrine gets its own commit (the base), and a later
 * commit removes it from the tree.
 */
function doctrineRepo(agents: string | undefined): { repoRoot: string; baseSha: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), "wd-gate-files-"));
  const git = (...args: string[]) => {
    const child = spawnSync("git", args, { cwd: repoRoot, env: gitTestEnv() });
    if (child.status !== 0) {
      throw new Error(`git ${args.join(" ")}: ${child.stderr?.toString().slice(0, 200)}`);
    }
    return child.stdout.toString().trim();
  };
  git("init", "-b", "main");
  git("config", "user.email", "gate-files@test.invalid");
  git("config", "user.name", "Gate files test");
  git("config", "commit.gpgsign", "false");
  mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true });
  writeFileSync(path.join(repoRoot, "README.md"), "# gate-file fixture repo\n");
  git("add", "-A");
  git("commit", "-m", "chore: base");
  let baseSha = git("rev-parse", "HEAD");
  if (agents !== undefined) {
    writeFileSync(path.join(repoRoot, "AGENTS.md"), agents);
    git("add", "-A");
    git("commit", "-m", "docs: the doctrine, present only at the cycle's base commit");
    baseSha = git("rev-parse", "HEAD");
    rmSync(path.join(repoRoot, "AGENTS.md"));
    git("add", "-A");
    git("commit", "-m", "chore: the doctrine is gone from the working tree");
  }
  return { repoRoot, baseSha };
}

/** The lens row the merged step's head check requires for this branch. */
function seedReviewLedger(dir: string, branch: string): void {
  writeFileSync(
    path.join(dir, ".git", "review-ledger.json"),
    JSON.stringify({
      entries: [
        {
          branch,
          kind: "lens",
          patchId: PATCH_ID,
          headSha: HEAD_OID,
          passed: true,
          at: 1,
          round: 1,
          hasCritical: false,
        },
      ],
    }),
  );
}

function mkState(issue: number, pr: number, branch: string, baseSha: string): WorkState {
  const s = initialState(issue, 1_000_000);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "merged",
      lastCompletedStep: "ci",
      status: "running",
      baseSha,
      branchName: branch,
      prNumber: pr,
      prDraft: { status: "ready" },
    },
  } as WorkState;
}

/** Everything the case asked the seam, and what it told the case afterwards. */
export interface GateFileLog {
  /** Every command line the seam received, argv calls joined. */
  calls: string[];
  /** The forge merge invocations it was asked to run, verbatim. */
  mergeCmds: string[];
  /** The committed name-status reads it answered. */
  diffReads: string[];
  /** The `git show <base>:<file>` reads it answered, verbatim. */
  doctrineReads: string[];
  /** Commands it had no answer for. */
  unexpected: string[];
}

export interface GateFileRun {
  state: WorkState | undefined;
  log: GateFileLog;
  baseSha: string;
  repoRoot: string;
  /** Every prompt the injected judge was handed, in order. */
  judgePrompts: string[];
  /** The cycle's terminal status, as the driver left it on disk. */
  status: string | undefined;
  /** The last `cap-hit` event the cycle recorded. */
  cap: string | undefined;
  /** The park reason the merged step wrote on `pipelineState.mergeHold`. */
  holdReason: string | undefined;
}

/**
 * Drive one cycle to the `merged` step with the given doctrine, judge and PR
 * change set. `diff` is the committed name-status answer for the PR's own
 * commits (`nulNameStatus` spelling); absent means a clean PR.
 */
export async function gateFileRun(opts: {
  issue: number;
  agents: string | undefined;
  judge?: PolicyJudgeFn;
  /** `false` runs the cycle WITHOUT the operator's `--merge` grant. */
  mergeGrant?: boolean;
  /** `true` asks the authority judge too (no `--merge`), so a case can count both questions. */
  authorityJudge?: boolean;
  /** `false` runs with `PI_ENSEMBLE_MERGE_AUTHORITY=0` — the permission gate off. */
  authorityGate?: boolean;
  diff?: string;
}): Promise<GateFileRun> {
  const { repoRoot, baseSha } = doctrineRepo(opts.agents);
  const branch = `feature/issue-${opts.issue}`;
  const pr = opts.issue + 9000;
  const log: GateFileLog = {
    calls: [],
    mergeCmds: [],
    diffReads: [],
    doctrineReads: [],
    unexpected: [],
  };
  let mergeAsked = false;
  const judgePrompts: string[] = [];
  const judge: PolicyJudgeFn | undefined = opts.judge
    ? (prompt, signal) => {
        judgePrompts.push(prompt);
        return opts.judge!(prompt, signal);
      }
    : undefined;
  seedReviewLedger(repoRoot, branch);
  await writeState(repoRoot, mkState(opts.issue, pr, branch, baseSha));

  const prevAuthority = process.env.PI_ENSEMBLE_MERGE_AUTHORITY;
  if (opts.authorityGate === false) process.env.PI_ENSEMBLE_MERGE_AUTHORITY = "0";
  else delete process.env.PI_ENSEMBLE_MERGE_AUTHORITY;

  const exec: VerifyExecFn = async (cmd, o) => {
    const line = o?.argv ? [cmd, ...o.argv].join(" ") : cmd;
    log.calls.push(line);
    // The doctrine read, in either exec shape: answer from the clone's base commit.
    const blob = doctrineBlob(line);
    if (blob !== undefined) {
      log.doctrineReads.push(line);
      // No `--`: with it, git reads `<sha>` and `<file>` as two revs and prints
      // the commit that removed the file instead of the blob the gate is judging.
      const child = spawnSync("git", ["show", `${blob.sha}:${blob.file}`], {
        cwd: repoRoot,
        env: gitTestEnv(),
      });
      if (child.status !== 0) throw new Error("no doctrine at the base commit");
      return { stdout: child.stdout.toString() };
    }
    // The merge gate's 3-field probe, matched on its own field list so it does
    // not intercept the forge adapter's wide `gh pr view`.
    if (line.includes("mergeStateStatus,mergeable,state")) {
      return {
        stdout: `{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"OPEN","headRefOid":"${HEAD_OID}"}`,
      };
    }
    if (line.includes("gh pr checks")) {
      return { stdout: '[{"name":"ci","bucket":"pass","state":"SUCCESS"}]' };
    }
    if (isForgeMerge(line)) {
      log.mergeCmds.push(line);
      mergeAsked = true;
      return { stdout: "Merged" };
    }
    if (line.includes("gh pr view")) {
      return {
        stdout: JSON.stringify({
          number: pr,
          title: "feat(fixture): declared gate files",
          state: mergeAsked ? "MERGED" : "OPEN",
          url: `https://github.com/f/f/pull/${pr}`,
          headRefName: branch,
          baseRefName: "main",
          mergeable: "TRUE",
          mergeStateStatus: "CLEAN",
          isDraft: false,
        }),
      };
    }
    if (line.includes("gh repo view")) {
      return {
        stdout:
          '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      };
    }
    // The publish seam's one visibility question: `false` = public.
    if (cmd === "gh" && o?.argv?.[0] === "api") return { stdout: "false\n" };
    if (line.includes("git config --get remote."))
      return { stdout: "https://github.com/f/f.git\n" };
    if (line.includes("git remote")) return { stdout: "origin\n" };
    if (line.includes("git symbolic-ref")) return { stdout: "origin/main\n" };
    if (line.includes("git rev-parse --git-common-dir"))
      return { stdout: `${repoRoot}/.git\n` };
    if (line.includes("git merge-base")) return { stdout: `${MERGE_BASE}\n` };
    if (line.includes("git patch-id")) return { stdout: `${PATCH_ID} x\n` };
    if (line.includes("git rev-parse --end-of-options origin/"))
      return { stdout: `${HEAD_OID}\n` };
    if (/git rev-parse .*origin\//.test(line)) return { stdout: `${HEAD_OID}\n` };
    if (isNulDiffRead(commandOf(cmd, o))) {
      log.diffReads.push(line);
      return { stdout: opts.diff ?? "" };
    }
    if (line.startsWith("git fetch")) return { stdout: "" };
    if (line.includes("git rev-parse")) {
      return { stdout: /refs?\/|remotes\//.test(line) ? `${HEAD_OID}\n` : `${branch}\n` };
    }
    log.unexpected.push(line);
    return { stdout: "" };
  };

  const ctx = {
    repoRoot,
    issue: opts.issue,
    host: { sendUserMessage: () => {} } as unknown as ExtensionAPI,
    verifyExecFn: exec,
    mergeGrant: opts.authorityJudge === true ? false : (opts.mergeGrant ?? true),
    issueBodyFetcherFn: async () => ({
      stdout: `title:\ttest #${opts.issue}\nstate:\tOPEN\n\nbody`,
    }),
    dispatchFn: async () =>
      ({
        role: "ops",
        ok: true,
        text: "Mechanized merge succeeded.",
        toolUses: [],
        ms: 1,
        exitCode: 0,
        transcriptPath: "/tmp/gate-files.json",
      }) as unknown as DispatchResult,
    ...(judge ? { policyJudgeFn: judge } : {}),
  } as unknown as DriverContext;

  try {
    await runWorkDriver(ctx);
    const state = await readState(repoRoot, opts.issue);
    const cap = [...(state?.eventLog ?? [])].reverse().find((e) => e.kind === "cap-hit") as
      | { cap?: string }
      | undefined;
    return {
      state,
      log,
      baseSha,
      repoRoot,
      judgePrompts,
      status: state?.pipelineState.status,
      cap: cap?.cap,
      holdReason: state?.pipelineState.mergeHold?.headCheckReason,
    };
  } finally {
    if (prevAuthority === undefined) delete process.env.PI_ENSEMBLE_MERGE_AUTHORITY;
    else process.env.PI_ENSEMBLE_MERGE_AUTHORITY = prevAuthority;
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

/** The `<sha>:<file>` blob spec of a doctrine read, in either exec shape. */
function doctrineBlob(line: string): { sha: string; file: string } | undefined {
  const match = /(?:^|\s)([0-9a-f]{40}):([A-Za-z0-9._-]+)$/.exec(line);
  if (!match) return undefined;
  return { sha: match[1] as string, file: match[2] as string };
}

/** The forge's merge command, matched without spelling it in this file. */
function isForgeMerge(line: string): boolean {
  return /\bpr\s+merge\b/.test(line);
}

/** Re-exported so the test spells change sets in the same helper the other fakes use. */
export { nulNameStatus };
