#!/usr/bin/env bun
/**
 * Shared helpers for the merge-guard decision-matrix tests (test-merge-guard.ts
 * and test-merge-guard-round-cap.ts). Both files drive the REAL registerMergeGuard
 * hook through `opts.execFn`; this module holds the common ledger setup,
 * the fake-pi hook factory, and the `hookDecision` runner so the two files
 * share one implementation (the 500-line gate: the round-cap matrix is a
 * sibling file, and the shared harness lives here rather than being
 * duplicated).
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { registerMergeGuard } from "../src/merge-guard.ts";
import type { MergeTarget } from "../src/merge-target.ts";
import { type LedgerEntry, latestEntry, ledgerPathFor } from "../src/review-ledger.ts";
import { adversarialPassed, lensPassed } from "../src/review-ledger.ts";
import type { MergeGateEnv } from "./merge-guard-forge-fixture.ts";
import { evidenceHeadFor, isFullCommitSha } from "./merge-guard-forge-fixture.ts";
import { commandOf } from "./lib/argv-shell.ts";

// The hook reads the forge from PI_ENSEMBLE_FORGE (the detectForge hard
// override) so the decision matrix runs offline, without a real remote.
process.env.PI_ENSEMBLE_FORGE = "github";

let LEDGER_FILE: string | undefined;
let LEDGER_TMP_DIR: string | undefined;

export async function setupLedgerPath() {
  LEDGER_TMP_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-ledger-"));
  process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(LEDGER_TMP_DIR, "review-ledger.json");
  const realExec = async (cmd: string) => ({
    stdout: execSync(cmd, { cwd: import.meta.dirname, encoding: "utf8" }),
  });
  const p = await ledgerPathFor(realExec, import.meta.dirname);
  if (!p) throw new Error("cannot resolve the ledger path for the decision matrix");
  // Canary: the ledger must NOT live inside any .git directory — that would
  // clobber the real per-clone review ledger shared by every worktree.
  assert(
    !/([/\\])\.git([/\\]|$)/.test(p),
    "canary: the test ledger is not inside a .git directory",
  );
  LEDGER_FILE = p;
}

export function teardownLedger() {
  if (LEDGER_TMP_DIR) {
    try {
      rmSync(LEDGER_TMP_DIR, { recursive: true, force: true });
    } catch (err) {
      console.error(`⚠ could not remove the ledger temp dir: ${(err as Error).message}`);
    }
  }
}

export let exit = 0;
export function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

export { ledgerPathFor, latestEntry, adversarialPassed, lensPassed };
export type { LedgerEntry, MergeTarget };

export const TARGET: MergeTarget = {
  forge: "github",
  prNumber: 12,
  headBranch: "feature/x",
  headOid: "abc123",
  baseBranch: "main",
  author: "dev",
  labels: [],
};

export const GOOD_ENTRIES: LedgerEntry[] = [
  { branch: "feature/x", kind: "adversarial", patchId: "p1", passed: true, at: 1 },
  { branch: "feature/x", kind: "lens", patchId: "p1", passed: true, at: 2 },
];

/** Save/restore the shared ledger around a row so the matrix is side-effect-free. */
export async function withLedger(entries: LedgerEntry[], fn: () => Promise<unknown>) {
  const file = LEDGER_FILE;
  if (!file) throw new Error("ledger path not resolved — call setupLedgerPath() first");
  const saved = (() => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  })();
  try {
    writeFileSync(file, JSON.stringify({ entries }, null, 2), "utf8");
  } catch (err) {
    throw new Error(`cannot write test ledger at ${file}: ${(err as Error).message}`);
  }
  const done = () => {
    try {
      if (saved === null) {
        if (existsSync(file)) unlinkSync(file);
      } else {
        writeFileSync(file, saved, "utf8");
      }
    } catch (err) {
      console.error(`⚠ could not restore the ledger at ${file}: ${(err as Error).message}`);
    }
  };
  try {
    return await fn();
  } finally {
    done();
  }
}

/** Register the real guard on a fake pi and drive it through `opts.execFn`. */
export async function makeHook(env: {
  target: MergeTarget;
  currentPatchId: string;
  fetchedHead: string;
  calls: string[];
  failFetch?: boolean;
  failGh?: boolean;
  /** #2107 — the `timeout` each exec was given, so a test can assert the bound. */
  timeouts?: number[];
  ledgerCommonDir?: string;
  remote?: string;
  ghComments?: string;
  /** The mainline `git symbolic-ref` reports (default: the PR's base). */
  mainline?: string;
  /** What `git merge-base` prints (default `mb0000`; "" = no merge-base). */
  mergeBase?: string;
  /**
   * What `gh pr view --json number` (the CURRENT-BRANCH resolution) does.
   * `"throws"` (default) is the stub's error; `"empty"` makes it return no
   * `number` field, which is the shape that leaves `resolvePrNumber` with
   * `undefined` — the case the early-refusal seam reports.
   */
  branchNumber?: "throws" | "empty";
} & MergeGateEnv): Promise<(event: unknown, ctx: unknown) => Promise<unknown>> {
  let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
  const fakePi = {
    on: (name: string, fn: (event: unknown, ctx: unknown) => Promise<unknown>) => {
      if (name === "tool_call") handler = fn;
    },
  } as never;
  const t = env.target;
  const ghView = {
    stdout: JSON.stringify({
      headRefName: t.headBranch,
      headRefOid: t.headOid,
      baseRefName: t.baseBranch,
      author: { login: t.author },
      labels: t.labels.map((n) => ({ name: n })),
    }),
  };
  // #2107 — the repo scoping: the value every `gh` read must end with. A forge
  // read that dropped it answers about a different PR than the one the merge
  // acts on, so `execFn` refuses it (see below).
  const wantRepoFlag = env.targetRepo !== undefined ? ` -R ${env.targetRepo}` : "";
  /** The identity read's field list — what keeps it apart from the evidence read. */
  const IDENTITY_FIELDS = "headRefName,headRefOid,baseRefName,author,labels";
  /** The #2106 evidence read's field list, answered from the env knobs below. */
  const EVIDENCE_FIELDS = "mergeStateStatus,mergeable,state,headRefOid";
  // The argv form (#1095) records as `cmd argv…` so the matchers below read the
  // same command text whichever form the guard used.
  const execFn = async (
    cmd0: string,
    opts?: {
      argv?: string[];
      cwd?: string;
      timeout?: number;
      maxBuffer?: number;
      shell?: string;
      killGroup?: boolean;
      env?: Record<string, string>;
      stdoutEncoding?: string;
    },
  ): Promise<{ stdout: string }> => {
    const cmd = commandOf(cmd0, opts);
    env.calls.push(cmd);
    if (opts?.timeout !== undefined) (env.timeouts ??= []).push(opts.timeout);
    // #2107 — the repo scoping, checked AFTER the record so an unscoped read
    // still shows up in `calls` as the command the guard actually issued: an
    // arm then fails on its own `-R <repo>` assertion (or on this refusal)
    // rather than on an empty call list that hides what was asked. The matcher
    // is the whole `gh` command, not `gh pr …` — the guard appends the flag, so
    // a scoped read always ENDS with it — and it has to cover the argv form
    // (#1095) that `gh pr checks` is issued in, whose joined text a `gh pr `
    // prefix test never saw.
    if (wantRepoFlag && cmd.startsWith("gh ") && !cmd.endsWith(wantRepoFlag)) {
      throw new Error(`forge read not scoped to the command's repo: ${cmd}`);
    }
    if (cmd.includes("gh pr view")) {
      if (cmd.includes("--json number")) {
        if (env.branchNumber === "empty") return { stdout: "{}" };
        return { stdout: JSON.stringify({ number: t.prNumber }) };
      }
      // #2106 — the CI evidence read is a `gh pr view` too, told apart ONLY by
      // its field list. A matcher that keyed on `gh pr view` alone would hand
      // the guard its identity answer and the gate would pass on nothing.
      if (cmd.includes(`--json ${EVIDENCE_FIELDS}`)) {
        if (env.failEvidence) throw new Error("gh: could not read the PR state");
        // #2107 — the PR's own head, as the forge reports it: the fixture's
        // `target.headOid`, which is also what the guard verifies against
        // `fetchedHead`. An arm testing the verdict pin overrides it with
        // `evidenceHeadOid`.
        const prHeadOid =
          env.evidenceHeadOid === undefined
            ? evidenceHeadFor(env.fetchedHead)
            : isFullCommitSha(env.evidenceHeadOid)
              ? env.evidenceHeadOid
              : env.evidenceHeadOid.padEnd(40, "0");
        if (env.hangChecks) {
          // The #2107 hang arm: the guard's bound is what answers this, so the
          // stub itself outlives every timeout an unbounded caller would have.
          await new Promise((res) => setTimeout(res, 60_000));
        }
        return {
          stdout: JSON.stringify({
            mergeStateStatus: env.mergeStateStatus ?? "CLEAN",
            mergeable: "TRUE",
            state: "OPEN",
            // #2107 — the head this verdict was read at. The guard compares it
            // to the OID it fetched and checked against the PR's `headOid`, so
            // the default is a 40-hex rendering of THAT head (the fixture's
            // `fetchedHead`, which the guard has just verified): every matrix
            // that is not testing the pin agrees by construction, because the
            // value below is derived from the same field the guard compares.
            // An arm testing the pin names `evidenceHeadOid` — a different
            // full OID, or "" for a read that reported no head at all.
            headRefOid: prHeadOid,
          }),
        };
      }
      if (env.failGh) throw new Error("gh: not found");
      if (cmd.includes("--json comments")) {
        if (env.ghComments === undefined) {
          throw new Error("gh: comments not stubbed");
        }
        return { stdout: env.ghComments };
      }
      if (!cmd.includes(`--json ${IDENTITY_FIELDS}`)) {
        throw new Error(`unexpected gh pr view field list: ${cmd}`);
      }
      return ghView;
    }
    // #2106 — the check rows behind the CI evidence gate.
    if (cmd.includes("gh pr checks")) {
      if (env.hangChecks) {
        await new Promise((res) => setTimeout(res, 60_000));
      }
      if (env.failChecks) throw new Error("gh: could not read the checks");
      return {
        stdout:
          env.prChecks ??
          JSON.stringify([{ name: "quality-gate", state: "SUCCESS", bucket: "pass" }]),
      };
    }
    if (cmd.includes("git fetch")) {
      if (env.failFetch) throw new Error("unable to connect");
      return { stdout: "" };
    }
    // Remote resolution: origin → upstream → first remote.
    if (cmd.includes("git config --get remote.origin.url")) {
      if (env.remote === "origin") return { stdout: "git@github.com:o/r.git\n" };
      return { stdout: "" };
    }
    if (cmd.includes("git config --get remote.upstream.url")) {
      if (env.remote === "upstream") return { stdout: "git@github.com:o/r.git\n" };
      return { stdout: "" };
    }
    if (cmd.includes("git config --get remote.")) {
      return { stdout: "" };
    }
    if (cmd.includes("git remote")) {
      return { stdout: `${env.remote}\n` };
    }
    if (cmd.includes(`rev-parse ${env.remote}/`)) return { stdout: env.fetchedHead };
    if (cmd.includes("symbolic-ref")) {
      return { stdout: `origin/${env.mainline ?? env.target.baseBranch}\n` };
    }
    if (cmd.includes("git merge-base")) return { stdout: `${env.mergeBase ?? "mb0000"}\n` };
    if (cmd.includes("patch-id")) return { stdout: `${env.currentPatchId} 0000` };
    if (cmd.includes("git-common-dir")) {
      return { stdout: env.ledgerCommonDir ?? "" };
    }
    throw new Error(`unexpected exec: ${cmd}`);
  };
  registerMergeGuard(fakePi, { execFn });
  if (!handler) throw new Error("the merge guard did not register a tool_call handler");
  return handler;
}

export async function hookDecision(
  command: string,
  entries: LedgerEntry[],
  opts: {
    target?: MergeTarget;
    patchId?: string;
    fetchedHead?: string;
    failGh?: boolean;
    failFetch?: boolean;
    ledgerCommonDir?: string;
    remote?: string;
    ghComments?: string;
    mainline?: string;
    mergeBase?: string;
    branchNumber?: "throws" | "empty";
  } & MergeGateEnv = {},
) {
  const env: Parameters<typeof makeHook>[0] = {
    target: opts.target ?? TARGET,
    currentPatchId: opts.patchId ?? "p1",
    fetchedHead: opts.fetchedHead ?? "abc123",
    failGh: opts.failGh,
    failFetch: opts.failFetch,
    ledgerCommonDir: opts.ledgerCommonDir ?? (LEDGER_FILE ? path.dirname(LEDGER_FILE) : ""),
    calls: [] as string[],
    /** #2107 — the `timeout` each exec was given, so a test can assert the bound. */
    timeouts: [] as number[],
    remote: opts.remote ?? "origin",
    ghComments: opts.ghComments,
    mainline: opts.mainline,
    mergeBase: opts.mergeBase,
    branchNumber: opts.branchNumber,
    prChecks: opts.prChecks,
    mergeStateStatus: opts.mergeStateStatus,
    failEvidence: opts.failEvidence,
    failChecks: opts.failChecks,
    evidenceHeadOid: opts.evidenceHeadOid,
    hangChecks: opts.hangChecks,
    repoFlag: opts.repoFlag,
    targetRepo: opts.targetRepo,
  };
  const handler = await makeHook(env);
  // #1417 round 2 — capture the HELD trace lines alongside the verdict. The
  // line is the only place a hold's CODE is recorded (the rendered refusal
  // deliberately carries no command text, and the trace carries the code and
  // the length only), so a matrix that asserted only the block/reason could
  // not tell a correct hold from one logged under someone else's cause.
  const traces: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    traces.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let r: unknown;
  try {
    r = await withLedger(entries, () =>
      handler(
        { toolName: "bash", input: { command: command + (env.repoFlag ?? "") } },
        undefined as never,
      ),
    );
  } finally {
    process.stderr.write = realWrite;
  }
  return {
    block: (r as { block?: boolean } | undefined)?.block === true,
    reason: (r as { reason?: string } | undefined)?.reason,
    calls: env.calls,
    /** #2107 — every `timeout` the hook passed to an exec, in call order. */
    timeouts: env.timeouts,
    /**
     * Every `merge-guard: HELD …` OR `merge-guard: BLOCKED …` trace line the
     * hook emitted for this command. #1479 — the filter used to match `HELD`
     * only, so a blocked merge (kind `merge`, unresolvable number) logged its
     * `merge-guard: BLOCKED` trace line and no test could ever see it. The
     * line is stored WITHOUT the `[pi-rukas] WARN ` prefix `traceWarn` adds,
     * so an assertion can anchor on `^merge-guard:` without depending on the
     * console prefix — which is harness plumbing, not the trace contract.
     * (Renamed from `holds` in #1479: it now carries BLOCKED lines too, and
     * `traces` matches the doc — these are the guard's trace lines.)
     */
    traces: traces
      .filter((l) => l.includes("merge-guard: HELD") || l.includes("merge-guard: BLOCKED"))
      .map(
        (l) =>
          // #1479 lens fix — strip ANY trace level word, not just `WARN`: the
          // prefix is harness plumbing (`[pi-rukas] LEVEL msg`), and a future
          // level must not silently change which lines the filter sees.
          l.trim().replace(/^\[pi-rukas\] [A-Z]+ /, ""),
      ),
  };
}
