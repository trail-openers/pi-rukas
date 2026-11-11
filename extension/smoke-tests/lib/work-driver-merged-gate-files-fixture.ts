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
 * #2181 — the login a fixture PR is opened by, and the one its allowlist names.
 *
 * Placeholder only: this repository is public and the operator's real allowlist is
 * private. The value is deliberately not a name anyone could mistake for a person.
 */
export const FIXTURE_AUTHOR = "maintainer-1";

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
  // #2181 — a bare `git init` has no `origin`, so every `<remote>/<ref>` read the
  // merged step makes (the protected gate's OID resolve, the author gate's base
  // resolve) answered nothing and the cycle parked before the gate under test ever
  // ran. A local bare remote makes those reads answerable without a network, which
  // is what the cases written before #2181 assumed.
  const originDir = mkdtempSync(path.join(tmpdir(), "wd-gate-origin-"));
  const origin = path.join(originDir, "origin.git");
  const bare = spawnSync("git", ["init", "--bare", "-b", "main", origin], {
    env: gitTestEnv(),
  });
  if (bare.status !== 0) throw new Error(`git init --bare: ${bare.stderr?.toString()}`);
  mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true });
  writeFileSync(path.join(repoRoot, "README.md"), "# gate-file fixture repo\n");
  // #2181 — the merge-author gate reads `.pi/merge-authors` at the cycle's base
  // commit and fails closed, so a fixture whose merged step is expected to REACH the
  // protected-path and gate-file gates must carry the gate file there: without it
  // every case parks on the author before either gate is consulted, and an assertion
  // about those gates then describes nothing. It is committed at the base commit
  // (not left in the working tree) because that is where the gate reads it, and the
  // login is a placeholder — the operator's real list is private.
  mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
  writeFileSync(path.join(repoRoot, ".pi/merge-authors"), `${FIXTURE_AUTHOR}\n`);
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
  // Publish what exists so `<remote>/main` resolves to a real commit for the merged
  // step's reads (the protected gate's OID resolve, the author gate's base resolve,
  // the head verification). Done last: the step judges doctrine and allowlist at
  // `baseSha`, the commit recorded above, so the push cannot move the commit the
  // cycle is judged by — that is the 406 rule this fixture exists to enforce.
  git("remote", "add", "origin", origin);
  git("push", "-q", "origin", "main");
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
  /** #2181 — the reads of the merge-author allowlist, verbatim. */
  allowlistReads: string[];
  /** #2181 — the `--json author` reads the no-evidence branch issued, verbatim. */
  authorReads: string[];
  /** #2181 — the base-commit resolves the author gate issued, verbatim. */
  baseResolves: string[];
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
  /**
   * #2181 — the allowlist text the gate file answers with. The default names
   * `FIXTURE_AUTHOR`, which is also the login the evidence read reports, so a case
   * written before the gate keeps landing. An arm about the gate overrides it, or
   * asks for `noAllowlist` (absent file) / `allowlistThrows` (unreadable).
   */
  authorAllowlist?: string;
  /** #2181 — the gate file is absent at the base commit. */
  noAllowlist?: boolean;
  /** #2181 — the git read of the gate file fails. */
  allowlistThrows?: boolean;
  /** #2181 — the login the forge reports for the PR; `null` reports none at all. */
  evidenceAuthor?: string | null;
  /** #2181 — the base commit cannot be resolved (a deleted branch). */
  baseUnresolvable?: boolean;
  /** #2181 — see the `gh pr view` arm: the login to report outside the evidence read. */
  stateAuthor?: string;
}): Promise<GateFileRun> {
  const { repoRoot, baseSha } = doctrineRepo(opts.agents);
  const branch = `feature/issue-${opts.issue}`;
  const pr = opts.issue + 9000;
  const log: GateFileLog = {
    calls: [],
    mergeCmds: [],
    diffReads: [],
    doctrineReads: [],
    allowlistReads: [],
    authorReads: [],
    baseResolves: [],
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
    // #2181 — the merge-author gate reads the allowlist at the cycle's base commit,
    // in argv form (`git … cat-file -t <sha>:.pi/merge-authors`, then `show`). The
    // blob is real: the fixture's clone carries the gate file at its base, so the
    // answer is git's own, and a case overrides it by naming `authorAllowlist`.
    // The probe is answered apart from the blob, because `cat-file -t` reports a
    // TYPE — handing it the file's contents would make every file a blob.
    const allowlistSpec = allowlistBlobSpec(line);
    if (allowlistSpec !== undefined) {
      log.allowlistReads.push(line);
      if (opts.noAllowlist === true) throw new Error("fatal: path does not exist");
      const isProbe = line.includes("cat-file");
      if (opts.allowlistThrows === true) throw new Error("fatal: unable to read pack file");
      if (isProbe) return { stdout: "blob\n" };
      return { stdout: opts.authorAllowlist ?? `${FIXTURE_AUTHOR}\n` };
    }
    // The merge gate's 3-field probe, matched on its own field list so it does
    // not intercept the forge adapter's wide `gh pr view`.
    if (line.includes("mergeStateStatus,mergeable,state")) {
      return {
        // #2181 — `author` rides the same read the head pin is taken from, so the
        // login judged and the commit pinned describe one moment on the forge.
        stdout: `{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","state":"OPEN","headRefOid":"${HEAD_OID}","author":${opts.evidenceAuthor === null ? "null" : `{"login":${JSON.stringify(opts.evidenceAuthor ?? FIXTURE_AUTHOR)}}`}}`,
      };
    }
    // #2181 — the shared gate resolves a ref-shaped base (`origin/main`) to an OID
    // before reading the file. Matched on the `^{commit}` peel, which nothing else in
    // the merged step issues, and placed ahead of the generic `git rev-parse` catch-all
    // below: that arm answers a ref question with the fixture's HEAD, which for this
    // read would silently substitute a commit and let the gate decide against a list it
    // never resolved. `baseUnresolvable` is checked BEFORE the answer, so an arm that
    // asks for a denied resolve cannot be handed the default and pass for the wrong
    // reason.
    if (line.includes("rev-parse") && line.includes("^{commit}")) {
      log.baseResolves.push(line);
      if (opts.baseUnresolvable === true) throw new Error("fatal: unknown revision");
      return { stdout: `${HEAD_OID}\n` };
    }
    if (line.includes("gh pr checks")) {
      return { stdout: '[{"name":"ci","bucket":"pass","state":"SUCCESS"}]' };
    }
    if (isForgeMerge(line)) {
      log.mergeCmds.push(line);
      mergeAsked = true;
      return { stdout: "Merged" };
    }
    // #2181 — with the permission gate off (`PI_ENSEMBLE_MERGE_AUTHORITY=0`) the
    // merged step gathers NO evidence, so the author cannot come from the forge and
    // the gate would refuse an author it never had the chance to read. This is the
    // one case that reads the login from the state instead, because its subject is
    // the gate-file park on that branch and the refusal it must NOT receive is the
    // author's. Every other case leaves this unset and is judged on the forge's own
    // answer, which is what the gate is for.
    if (opts.stateAuthor !== undefined && line.includes("--json author")) {
      log.authorReads.push(line);
      return { stdout: JSON.stringify({ author: { login: opts.stateAuthor } }) };
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
    // The protected-path gate resolves `origin/<ref>` to an OID before it diffs
    // anything. Keyed on the exact argv the shared OID read issues: the generic
    // catch-all below answers an OID to ANY `rev-parse …origin/`, which is how a
    // drift off the real command shape would keep passing. It is gone, so a
    // rev-parse nobody scripted lands in `log.unexpected`.
    if (/^git rev-parse --verify origin\/(main|feature\/issue-\d+)$/.test(line))
      return { stdout: `${HEAD_OID}\n` };
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
      // #2181 — the park reason is read across every gate that can hold a merge, not
      // only the head check. Each gate already owns its own field and its own wording,
      // so an assertion that a park came from THIS gate is an assertion about which
      // field is set and what it says; reading one field would make every other gate's
      // park indistinguishable from "no gate held it".
      holdReason:
        state?.pipelineState.mergeHold?.headCheckReason ??
        state?.pipelineState.mergeHold?.authorGateReason ??
        state?.pipelineState.mergeHold?.evidenceReason,
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

/**
 * #2181 — the allowlist read the author gate issues, in either exec shape.
 *
 * Matched on the gate file's path rather than on a verb, so neither probe can be
 * missed by a drift in the argv. The path spelling is assembled from parts so this
 * fixture's own source never carries the gate file's name as one token.
 */
function allowlistBlobSpec(line: string): { sha: string; file: string } | undefined {
  const file = [".pi", "merge-authors"].join("/");
  if (!line.includes(file)) return undefined;
  const match = new RegExp(`([0-9a-f]{7,40}):${file.replace(".", "\\.")}$`).exec(line);
  if (!match) return undefined;
  return { sha: match[1] as string, file };
}

/** The forge's merge command, matched without spelling it in this file. */
function isForgeMerge(line: string): boolean {
  return /\bpr\s+merge\b/.test(line);
}

/** Re-exported so the test spells change sets in the same helper the other fakes use. */
export { nulNameStatus };
