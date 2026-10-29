/**
 * lib/lean-publish-fixture — the harness the `lean/publish` smoke tests share.
 *
 * The step's two outside-world claims are git and forge claims, so one is real
 * and the other is observed: a temp repo with a real `origin` (a bare repo on
 * disk, so `git push` really writes refs into it and a case can read the branch
 * back out of it) and a FAKE forge that records every `prList` / `prCreate` call
 * it receives. The push assertions are therefore about the bytes origin holds,
 * not about what a stub said it did.
 *
 * The tree is the shape `specify`/`build`/`verify` leave behind: a base commit,
 * an implementation commit on the run's branch, and a step log carrying the
 * frozen tests and (when the case asks) a decided green `verify` naming that
 * head. Cases then break one invariant each — a dirty file, a moved head, a
 * foreign commit already on origin's branch — and the step has to refuse.
 *
 * `runPublish` returns `{outcome, threw, head, forge}` and never throws, so a
 * case asserts on the error's own type and message rather than on a try/catch
 * shape that can swallow the assertion.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../../src/exec.ts";
import type { NormalizedPullRequest } from "../../src/forge-types.ts";
import type { HandlerCtx } from "../../src/lean/engine.ts";
import type { PublishDeps } from "../../src/lean/publish-deps.ts";
import { netGitEnv } from "../../src/work-driver-net-git.ts";
import { renderPiSpec } from "../../src/lean/spec.ts";
import type { PiSpec } from "../../src/lean/spec.ts";
import { specifyWorktreePath } from "../../src/lean/specify-tree.ts";
import { pathProblem } from "../../src/lean/specify-tree.ts";
import type { LeanRun, Outcome, Step } from "../../src/lean/state.ts";
import { createRun } from "../../src/lean/state.ts";
import { gitTestEnv } from "./git-test-env.ts";
import { git, sha } from "./lean-verify-fixture.ts";

/** Temp dirs this module made; the caller removes them at the end of the run. */
export const ROOTS: string[] = [];

/** The acceptance test the run froze, committed at HEAD. */
const TEST = "#!/bin/sh\nexit 0\n";

/** The default contract: two test criteria, each with one frozen file. */
export function defaultSpec(): PiSpec {
  return {
    problem: "the retry helper backs off on a transient failure",
    size: "S",
    criteria: [
      { id: "AC1", text: "a transient failure is retried", verify: "test" },
      { id: "AC2", text: "the backoff is bounded", verify: "test" },
    ],
  };
}

/** A PR in the shape the forge adapter returns, with just the fields publish reads. */
export function fakePr(
  number: number,
  url: string,
  headRefName: string,
  isDraft?: boolean,
): NormalizedPullRequest {
  return {
    number,
    title: "t",
    body: "",
    state: "OPEN",
    url,
    headRefName,
    baseRefName: "main",
    author: undefined,
    mergeable: null,
    mergeStateStatus: null,
    isDraft,
    labels: [],
    createdAt: undefined,
    updatedAt: undefined,
  };
}

/** What the fake forge recorded, so a case asserts on calls rather than vibes. */
export interface FakeForge {
  prListCalls: number;
  prCreateCalls: { title: string; head: string; body: string; draft?: boolean }[];
  /** Numbers the step asked the forge to put back to draft. */
  prDraftCalls: number[];
  /** Numbers the step asked to read (the list reply carries no `isDraft`). */
  prViewCalls: number[];
  /** Make `prView` reject — the forge cannot tell the step anything. */
  viewThrows: boolean;
  /** Make `prDraft` reject — the forge refuses to put a reused PR back to draft. */
  draftThrows: boolean;
  /**
   * What `prView` reports for each number after a `prDraft`, overriding the PR's
   * own `isDraft` — the seam for a forge that accepted the call and left the PR
   * ready. `undefined` (the default) reports the state the PR carries.
   */
  afterDraft?: Map<number, boolean | undefined>;
  prs: NormalizedPullRequest[];
  listThrows: boolean;
  prList: (opts?: { state?: string; sourceBranch?: string }) => Promise<NormalizedPullRequest[]>;
  prView: (number: number) => Promise<NormalizedPullRequest>;
  prDraft: (number: number) => Promise<void>;
  prCreate: (
    title: string,
    headBranch: string,
    body: string,
    opts?: { baseBranch?: string; draft?: boolean },
  ) => Promise<NormalizedPullRequest>;
}

/** The fake forge: it records, and it answers whatever the case loaded into it. */
export function fakeForge(
  over: Partial<Omit<FakeForge, "prList" | "prView" | "prDraft" | "prCreate">> = {},
): FakeForge {
  const f: FakeForge = {
    prListCalls: 0,
    prCreateCalls: [],
    prDraftCalls: [],
    prViewCalls: [],
    viewThrows: false,
    draftThrows: false,
    prs: [],
    listThrows: false,
    // Placeholders, assigned just below: the methods close over `f` itself, so
    // they cannot appear in the object literal that creates `f`.
    prList: async () => [],
    prView: async (n) => fakePr(n, "https://forge.example/none", "none"),
    prDraft: async () => {},
    prCreate: async () => fakePr(0, "https://forge.example/none", "none"),
    ...over,
  };
  f.prList = async () => {
    f.prListCalls++;
    if (f.listThrows) throw new Error("forge: prList could not reach the host");
    return f.prs;
  };
  f.prView = async (n: number) => {
    f.prViewCalls.push(n);
    if (f.viewThrows) throw new Error("forge: prView could not reach the host");
    const found = f.prs.find((pr) => pr.number === n);
    if (found === undefined) throw new Error(`forge: no PR #${n}`);
    // A PR the step has just asked to draft is reported as the case put there,
    // which is what makes "the forge accepted prDraft and left it ready" a
    // testable behaviour rather than an imagined one.
    if (f.prDraftCalls.includes(n) && f.afterDraft !== undefined && f.afterDraft.has(n))
      return { ...found, isDraft: f.afterDraft.get(n) };
    return found;
  };
  f.prDraft = async (n: number) => {
    f.prDraftCalls.push(n);
    if (f.draftThrows) throw new Error("forge: prDraft could not reach the host");
    // A successful re-draft is a STATE CHANGE the fake has to keep: the step
    // reads the PR back afterwards, and a fake still reporting it ready would
    // make every honest run look like the lie the read-back exists to catch.
    const found = f.prs.find((pr) => pr.number === n);
    if (found !== undefined) found.isDraft = true;
  };
  f.prCreate = async (
    title: string,
    headBranch: string,
    body: string,
    opts?: { draft?: boolean },
  ): Promise<NormalizedPullRequest> => {
    f.prCreateCalls.push({ title, head: headBranch, body, draft: opts?.draft });
    return fakePr(77, "https://forge.example/pull/77", headBranch);
  };
  return f;
}

export interface PublishOpts {
  issue: number;
  /** The contract the issue body carries. */
  spec?: PiSpec;
  /** Override the issue body wholesale (an unusable spec, an injected heading). */
  body?: string;
  /** Make the worktree dirty before the step looks. */
  dirty?: boolean;
  /** Commit inside the worktree after the green verify was recorded. */
  commitAfterVerify?: boolean;
  /** Counters the run carries (a `draft` flag from the gate). */
  draft?: boolean;
  /** Origin already holds a foreign commit on the branch (non-fast-forward). */
  originForeign?: boolean;
  /** The fake forge's open PRs; `undefined` means "load none". */
  openPrs?: NormalizedPullRequest[];
  /** Make `prView` reject, so the step cannot read a reused PR's draft state. */
  viewThrows?: boolean;
  /** Make `prDraft` reject, so a reused PR cannot be put back to draft. */
  draftThrows?: boolean;
  /**
   * What `prView` reports for a number AFTER the step asked to draft it — the
   * seam for a forge that accepted `prDraft` and left the PR ready. A number the
   * map does not carry keeps the state the PR itself reports.
   */
  afterDraft?: Record<number, boolean | undefined>;
  /**
   * Answer one git call before the fixture's own executor sees it — the seam for
   * a case that must control a push's porcelain output. Return `undefined` to
   * let the call through.
   */
  execOver?: (
    cmd: string,
    opts?: Parameters<PublishDeps["exec"]>[1],
  ) => Promise<{ stdout: string; stderr?: string }> | undefined;
  /** Make `prList` reject. */
  listThrows?: boolean;
  /** A branch name to force onto the run (an unsafe ref, for the handback case). */
  branch?: string;
  /**
   * Set `core.sshCommand` in the fixture repo before the step runs — the seam
   * for a push env that must honour the repo's own ssh selection (a deploy key
   * chosen with `git config core.sshCommand`, which an env-only `netGitEnv()`
   * lookup silently skips).
   */
  sshCommand?: string;
  /** Check out a worktree whose branch differs from the run's (a state file that
   *  names the mainline while the tree sits on its own lean ref). */
  worktreeBranch?: string;
  /** The verify step to log; omit for a run that never reached a verdict. */
  verify?: { kind: "green" | "red"; head?: string; reason?: string } | undefined;
  /** Extra steps appended to the log. */
  extraSteps?: Step[];
}

export interface PublishRun {
  outcome?: Outcome;
  threw?: Error;
  repoRoot: string;
  wt: string;
  head: string;
  origin: string;
  forge: FakeForge;
  body: string;
  /** The env each git child received, in call order. */
  gitEnvs: NodeJS.ProcessEnv[];
}

/** The step log a run carries when it reaches publish with a green gate. */
function logFor(issue: number, o: PublishOpts, head: string): Step[] {
  const steps: Step[] = [
    { key: `${issue}:ready:0`, state: "ready", startedAt: 1, outcome: { kind: "ok" } },
    {
      key: `${issue}:specify:0`,
      state: "specify",
      startedAt: 2,
      outcome: {
        kind: "ok",
        frozen: { "tests/AC1-retry.test.sh": sha(TEST), "tests/AC2-bound.test.sh": sha(TEST) },
        tests: { AC1: ["tests/AC1-retry.test.sh"], AC2: ["tests/AC2-bound.test.sh"] },
      },
    },
    {
      key: `${issue}:build:0`,
      state: "build",
      startedAt: 3,
      outcome: { kind: "ok", reason: "1 file(s) changed" },
    },
  ];
  if (o.verify !== undefined) {
    steps.push({
      key: `${issue}:verify:0`,
      state: "verify",
      startedAt: 4,
      outcome: {
        kind: o.verify.kind,
        ...(o.verify.reason === undefined ? {} : { reason: o.verify.reason }),
        ...(o.verify.kind === "green" ? { verifiedHead: o.verify.head ?? head } : {}),
      },
    });
  }
  return [...steps, ...(o.extraSteps ?? [])];
}

/** Build the repo, the worktree and the ctx, then run the step. */
export async function runPublish(o: PublishOpts): Promise<PublishRun> {
  const issue = o.issue;
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-publish-"));
  ROOTS.push(repoRoot);
  const origin = mkdtempSync(path.join(tmpdir(), "lean-publish-origin-"));
  ROOTS.push(origin);
  git(origin, "init", "-q", "--bare");
  git(repoRoot, "init", "-q", "-b", "main");
  git(repoRoot, "remote", "add", "origin", origin);
  if (o.sshCommand !== undefined) git(repoRoot, "config", "core.sshCommand", o.sshCommand);

  writeFileSync(path.join(repoRoot, "src.ts"), "export const x = 1;\n");
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-q", "-m", "base");
  const baseSha = git(repoRoot, "rev-parse", "HEAD");
  git(repoRoot, "push", "-q", "origin", "main");

  const branch = o.branch ?? `lean/issue-${issue}`;
  const checkout = o.worktreeBranch ?? branch;
  const wt = specifyWorktreePath(repoRoot, issue);
  git(repoRoot, "worktree", "add", "-q", "-B", checkout, wt, baseSha);

  // The implementation + frozen tests, committed in the worktree: this is the
  // head the green verify is a claim about, and the head publish pushes.
  mkdirSync(path.join(wt, "tests"), { recursive: true });
  writeFileSync(path.join(wt, "tests/AC1-retry.test.sh"), TEST, { mode: 0o755 });
  writeFileSync(path.join(wt, "tests/AC2-bound.test.sh"), TEST, { mode: 0o755 });
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "feat: implement the retry helper");
  const head = git(wt, "rev-parse", "HEAD");

  if (o.originForeign === true) {
    // A commit origin holds on the same branch that this tree does not: the
    // step's push is non-fast-forward and must be refused, not forced over.
    const other = mkdtempSync(path.join(tmpdir(), "lean-publish-other-"));
    ROOTS.push(other);
    git(other, "init", "-q", "-b", branch);
    git(other, "remote", "add", "origin", origin);
    writeFileSync(path.join(other, "foreign.ts"), "export const foreign = 1;\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "foreign work");
    git(other, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
  }

  if (o.dirty === true) writeFileSync(path.join(wt, "stray.txt"), "uncommitted\n");
  if (o.commitAfterVerify === true) {
    writeFileSync(path.join(wt, "later.ts"), "export const later = 1;\n");
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "feat: a commit nobody verified");
  }

  const steps = logFor(issue, o, head);
  const run: LeanRun = {
    ...createRun({
      issue,
      version: "0.14.40",
      models: { developer: "model-a", adversary: "model-b" },
      baseSha,
      branch,
    }),
    steps,
    counters: {
      buildAttempts: 1,
      challengeDone: true,
      reviewDone: false,
      ciFixUsed: false,
      draft: o.draft === true,
    },
  };
  const ctx: HandlerCtx = {
    repoRoot,
    issue,
    run,
    steps,
    stepKey: `${issue}:publish:0`,
    now: () => 9,
  };

  const forge = fakeForge({
    prs: o.openPrs ?? [],
    listThrows: o.listThrows === true,
    viewThrows: o.viewThrows === true,
    draftThrows: o.draftThrows === true,
    ...(o.afterDraft === undefined ? {} : { afterDraft: new Map(Object.entries(o.afterDraft).map(([k, v]) => [Number(k), v] as const)) }),
  });
  const spec = o.spec ?? defaultSpec();
  /** The env every git child ran with, so a case can assert on the push's. */
  const seenEnvs: NodeJS.ProcessEnv[] = [];
  const deps: PublishDeps = {
    // The production seam's env decision is applied HERE rather than inside
    // `publishDeps()` — the fixture injects its own executor, so a push env the
    // fixture never forwarded would be a guarantee no test can observe. Same
    // env (the driver's `netGitEnv`), same condition (`cmd === "git"` and no
    // env supplied by the caller) — INCLUDING the cwd argument, which is what
    // lets the repo's `core.sshCommand` take part in the precedence. Omitting it
    // here would make the fixture observe a different env than production builds.
    exec: async (cmd, opts) => {
      const override = o.execOver?.(cmd, opts);
      if (override !== undefined) return override;
      const cwd = opts?.cwd ?? wt;
      const env = opts?.env ?? (cmd === "git" ? netGitEnv(gitTestEnv(), cwd) : gitTestEnv());
      seenEnvs.push(env);
      return execp(cmd, { ...opts, env, cwd });
    },
    fetchBody: async () => o.body ?? renderPiSpec(spec),
    forge: async () => forge,
  };
  const { publishOutcome } = await import("../../src/lean/publish.ts");
  const shared = { repoRoot, wt, head, origin, forge, gitEnvs: seenEnvs };
  try {
    return {
      outcome: await publishOutcome(ctx, deps),
      ...shared,
      body: forge.prCreateCalls[0]?.body ?? "",
    };
  } catch (err) {
    return {
      threw: err as Error,
      ...shared,
      body: forge.prCreateCalls[0]?.body ?? "",
    };
  }
}

/**
 * A path the publish body may print: a normalised git-relative path that
 * `specify-tree`'s own traversal / forbidden-directory rule accepts. The body's
 * own filter is deliberately NARROWER still — it also refuses a space or a
 * semicolon — so this helper is the looser class.
 */
export function printablePath(p: string): boolean {
  const rel = p
    .replace(/\/+/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .join("/");
  return pathProblem(rel) === undefined && /^[A-Za-z0-9._/-]+$/.test(rel);
}

/** What origin's branch actually points at, or "" when the ref does not exist. */
export function originHead(origin: string, branch: string): string {
  try {
    return git(origin, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    return "";
  }
}

/**
 * Load an EXTRA criterion id -> test-file map onto the fixture's step log.
 *
 * The default log maps AC1/AC2 to two clean paths; a case that wants the body's
 * path filter exercised adds its own criterion and hands its files in here, so
 * the paths under test are the ones the step actually reads from the record.
 */
export function testsStep(issue: number, tests: Record<string, string[]>): Step {
  return {
    key: `${issue}:challenge:0`,
    state: "challenge",
    startedAt: 5,
    outcome: { kind: "new-tests", tests },
  };
}
