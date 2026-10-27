/**
 * Shared fixtures for the #1114 adversarial fix-pass tests (real git repos,
 * a developer stub, and git-error injection). Not a test itself (no `test-`
 * prefix, so the gate glob does not run it).
 */

import { exec, execFile, execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../../src/types.ts";
import type { CycleContext, DriverContext } from "../../src/work-driver-context.ts";
import type { EmitSink } from "../../src/work-state-emit.ts";
import { defaultExec } from "../../src/work-driver-adversarial-fix-git.ts";
import type { GitRead } from "../../src/work-driver-adversarial-fix-git.ts";
import type { PassPlan } from "../../src/work-driver-adversarial-fix-scope.ts";
import { planFixPass } from "../../src/work-driver-adversarial-fix-scope.ts";
import type { WorkEvent, WorkState } from "../../src/workflow-state.ts";
import { initialState } from "../../src/workflow-state.ts";
import { gitTestEnv } from "./git-test-env.ts";

const realExec = promisify(exec);
const realExecFile = promisify(execFile);

export function tmpDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `adv-fix-${label}-`));
  mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
  return dir;
}

/** Run one real git command in `cwd` and return its stdout.
 *
 * #1145 — `env: gitTestEnv()`. `execSync` is the synchronous spawn form, which
 * bun 1.3 does not fix with an ambient `process.env` write, and the repos built
 * through here are the ones the develop/consolidate gates read their dirty
 * state from: a host `~/.config/git/ignore` makes a fixture file vanish from
 * `git status`, which decides the verdict without touching the code. */
export function git(cwd: string, cmd: string): string {
  return execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, {
    cwd,
    stdio: "pipe",
    env: gitTestEnv(),
  }).toString();
}

export function singleState(dir: string, eventLog: WorkState["eventLog"] = []): WorkState {
  const s = initialState(1114, 1_000_000);
  return {
    ...s,
    eventLog,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees: { default: dir },
      branchName: "feature/issue-1114",
    },
  };
}

/** A real repo: `a.txt` and `b.txt` committed on main, develop gates on `true`. */
export function repoWithFile(label: string): string {
  const dir = tmpDir(label);
  mkdirSync(path.join(dir, ".pi"), { recursive: true });
  writeFileSync(path.join(dir, ".pi", "verify-cmd"), "true\n");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  writeFileSync(path.join(dir, "b.txt"), "one\n");
  git(dir, "init -q -b main");
  // The driver's own state file lives under .pi/work-state; real cycles exclude it.
  writeFileSync(path.join(dir, ".git", "info", "exclude"), ".pi/work-state/\ntmp/\n");
  git(dir, "add -A");
  git(dir, 'commit -q -m "base"');
  return dir;
}

/** The developer's edit, committed in its worktree as a real developer does. */
export function devCommit(dir: string, file: string, body: string): void {
  writeFileSync(path.join(dir, file), body);
  git(dir, "add -A");
  git(dir, 'commit -q -m "fix"');
}

/** The developer's edit left uncommitted in its worktree. */
export function devWrite(dir: string, file: string, body: string): void {
  writeFileSync(path.join(dir, file), body);
}

/**
 * A single-workstream state routed back to develop: one parsed ISSUES_FOUND
 * round and a fix request naming `findings`. `paths` is the declared fence
 * (empty = N=1 unfenced).
 */
export function fixState(
  dir: string,
  paths: string[],
  findings = "a.txt: change one to two; b.txt: also fix",
): WorkState {
  const base = git(dir, "rev-parse HEAD").trim();
  const s = singleState(dir, [
    { kind: "adversarial-round", at: 1, round: 1, status: "ISSUES_FOUND", verdictParsed: true },
    { kind: "adversarial-fix-requested", at: 2, workstreamId: "default", round: 1, findings },
  ]);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      baseSha: base,
      workstreams: { default: { id: "default", scope: "fix", paths, outOfScope: [] } },
    },
  };
}

/** A successful developer dispatch result. */
export function devOk(role: string): DispatchResult {
  return { role, ok: true, exitCode: 0, text: "done", toolUses: [], ms: 1 } as DispatchResult;
}

/** A driver context whose developer stub is `onDev` and whose git runs for real unless overridden. */
export function fixCtx(
  dir: string,
  onDev: (dir: string) => void,
  verifyExecFn?: DriverContext["verifyExecFn"],
): DriverContext {
  return {
    // A DriverHost is structural (sendUserMessage + emit); a test host records
    // nothing on either, so it satisfies the type as written — no cast needed,
    // and a cast here would hide a real shape change on the host seam.
    host: { sendUserMessage: () => {}, emit: () => {} },
    repoRoot: dir,
    issue: 1114,
    issueBodyFetcherFn: async () => ({ stdout: "mock" }),
    verifyExecFn,
    dispatchFn: async (_pi, spec) => {
      if (spec.role === "developer") onDev(dir);
      return devOk(spec.role);
    },
  };
}

/**
 * The tree a fix-pass stray revert test needs: a real repo, a real detached
 * worktree, the pass's own in-scope commit, and the strays covering each case
 * the revert handles differently (created / edited / untracked).
 *
 * `label` names the temp dir so several cases can tell their repos apart in a
 * failure message. Shared by the three stray tests — each varies a different
 * rule of the same shape, so the layout lives here rather than being copied.
 */
export function passTreeAt(label: string): {
  repoRoot: string;
  worktree: string;
  /** What `planFixPass` records positively before dispatching the pass. */
  headBefore: string;
  /** The HEAD after the pass's own in-scope commit — what a corrective round
   *  dispatched inside the pass would have recorded as its baseline. */
  headAtRound: string;
} {
  const repoRoot = repoWithFile(label);
  const worktree = `${repoRoot}/.worktrees/issue-1846`;
  git(repoRoot, "worktree add -q --detach .worktrees/issue-1846 HEAD");
  const headBefore = git(worktree, "rev-parse HEAD").trim();
  // The pass's own legitimate work, committed as a real fix pass commits. This is
  // the commit the revert MUST survive — it is the whole reason the revert is
  // path-scoped rather than a whole-tree reset.
  devCommit(worktree, "a.txt", "two\n");
  const headAtRound = git(worktree, "rev-parse HEAD").trim();
  // Stray 1 — a tracked file the pass created after its fix commit.
  devCommit(worktree, "helper.ts", "export const helper = () => 1;\n");
  // Stray 2 — a tracked file that existed before the pass and was edited.
  writeFileSync(`${worktree}/b.txt`, "hijacked\n");
  // Stray 3 — an untracked file, in no commit, so no ref can ever hold it.
  devWrite(worktree, "scratch-notes.md", "notes the pass should not have added\n");
  return { repoRoot, worktree, headBefore, headAtRound };
}

/** The tree `passTreeAt` builds, in a dir named for the issue under test. */
export function strayPassTree(): ReturnType<typeof passTreeAt> {
  return passTreeAt("1846-revert");
}

/**
 * A state whose `pipelineState.worktrees` names `dir` for the `default`
 * workstream. `singleState` hard-codes that id, and the revert's target gate
 * (#1849 item 7) reads the recorded tree by it, so a test whose plan carries a
 * different id must record the tree under THAT id — otherwise the gate refuses
 * for the right reason and the rule under test never runs.
 */
export function stateWithWorktree(
  st: WorkState,
  workstreamId: string,
  dir: string,
): WorkState {
  return {
    ...st,
    pipelineState: {
      ...st.pipelineState,
      worktrees: { ...st.pipelineState.worktrees, [workstreamId]: dir },
    },
  };
}

/** A sink that records nothing. A step under test persists through the sink; a
 *  test that asserts on the returned state needs the events, not the emission. */
export const silentSink: EmitSink = { emit: () => undefined, fingerprints: [] };

/**
 * The `CycleContext` a step seam needs: `fixCtx`'s driver context plus the emit
 * sink `CycleContext` requires. The typed alternative to hand-rolling a context
 * object and casting it — a cast there hides a real change to the context seam,
 * which is exactly what the fix-pass steps read.
 */
export function typedCycleCtx(
  repoRoot: string,
  issue: number,
  opts: { onDev?: (dir: string) => void; verifyExecFn?: DriverContext["verifyExecFn"] } = {},
): CycleContext {
  return {
    ...fixCtx(repoRoot, opts.onDev ?? (() => undefined), opts.verifyExecFn),
    issue,
    emitSink: silentSink,
  };
}

/**
 * A driver event log, checked against the closed `WorkEvent` union at the point
 * it is built. The bare `x as WorkEvent[]` escape hatch hides a renamed field or
 * a stale event kind until runtime; this signature makes the compiler read each
 * element, which is the whole reason the fixture builds logs at all.
 */
export function events(...list: readonly WorkEvent[]): WorkEvent[] {
  return [...list];
}

/** An early assert for a fence read that must succeed: a failed pre-pass read means the FIXTURE is broken, not the rule under test. */
export function mustRead<T>(read: GitRead<T>, label: string): T {
  if (!read.ok) {
    throw new Error(`${label}: ${read.reason}`);
  }
  return read.value;
}

export async function correctiveScaffold(
  label: string,
  atBase: Record<string, string> = {},
): Promise<{ dir: string; st: WorkState; planned: PassPlan[] }> {
  const dir = repoWithFile(label);
  trackAtBase(dir, { "lib/main.ts": "export const m = 1;\n", ...atBase });
  const st = fixState(dir, ["a.txt", "lib/main.ts"], "a.txt: change one to two");
  const planned = mustRead(
    await planFixPass(defaultExec, dir, st.pipelineState, [
      { workstreamId: "default", findings: "a.txt: change one to two" },
    ]),
    label,
  );
  return { dir, st, planned };
}

/** The pass's own declared edit, committed before the round is recorded. */
export const passEdit = (dir: string): void => devCommit(dir, "a.txt", "two\n");

export function trackAtBase(dir: string, files: Record<string, string>): void {
  for (const [file, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), body);
  }
  git(dir, "add -A");
  git(dir, 'commit -q -m "tracked at base"');
}

/**
 * #1849 C — the fan-out ceiling's coupled-test exclusion drives the pass through
 * the real `postPassFault`, so it needs a planned pass, not a hand-built one:
 * `planFixPass` computes the fence the ceiling reads, and a fence the test
 * invented would test the test.
 */
export async function plannedPassesFor(
  dir: string,
  st: WorkState,
  findings: string,
): Promise<PassPlan[]> {
  const read = await planFixPass(defaultExec, dir, st.pipelineState, [
    { workstreamId: "default", findings },
  ]);
  if (!read.ok) throw new Error(`planFixPass failed: ${read.reason}`);
  return read.value;
}

/**
 * The `PassPlan`s one fix pass would carry, built by the REAL `planFixPass`
 * against a real repo — the typed alternative to a test hand-rolling a plan
 * object (which silently rots whenever the plan gains a required field, and
 * hides nothing as well as a `cast` does).
 *
 * `worktree` is overridden because the plan reads it from
 * `pipelineState.worktrees`, which `singleState` points at the repo root: a
 * revert test needs the plan to name its `.worktrees/…` tree instead. That
 * override is exactly the seam #1849 item 7 guards, so the matching
 * `singleState` call takes the SAME tree — a state whose recorded worktree
 * disagrees with the plan is the refusal case, and it is built on purpose in
 * `test-fix-pass-strays-worktree.ts`, not by accident here.
 */
export async function typedPassPlans(
  repoRoot: string,
  worktree: string,
  declared: readonly string[],
  findings: string,
): Promise<PassPlan[]> {
  const st = fixState(repoRoot, [...declared], findings);
  const planned = await planFixPass(defaultExec, repoRoot, st.pipelineState, [
    { workstreamId: "default", findings },
  ]);
  if (!planned.ok) throw new Error(`planFixPass failed: ${planned.reason}`);
  return planned.value.map((p) => ({ ...p, worktree }));
}

/**
 * A git executor that fails any command containing `match` (a simulated
 * unreadable tree, base or HEAD) and runs every other command for real. Argv-form
 * calls (`opts.argv`, the develop step's git reads) are matched on the full
 * command line and run without a shell, as the production executor does.
 */
export function execFailing(match: string): NonNullable<DriverContext["verifyExecFn"]> {
  return (cmd, opts) => {
    const full = [cmd, ...(opts?.argv ?? [])].join(" ");
    if (full.includes(match)) return Promise.reject(new Error(`simulated git failure: ${match}`));
    if (opts?.argv) {
      return realExecFile(cmd, opts.argv, { cwd: opts.cwd, maxBuffer: opts.maxBuffer });
    }
    return realExec(cmd, { cwd: opts?.cwd, maxBuffer: opts?.maxBuffer });
  };
}

/**
 * #1137 — a two-workstream (docs + code) state with a pending fix for the
 * DOCS workstream. The docs workstream is declared on `b.txt` (a non-source,
 * docs-style path) and the code sibling on `a.txt`; the issue body carries a
 * criterion owned only by the code sibling. Used to assert the per-workstream
 * adversarial prompt scopes the docs review and lists the sibling's criteria
 * as out of scope.
 */
export function twoWorkstreamState(
  dir: string,
  findings = "b.txt: document the change",
): WorkState {
  const base = git(dir, "rev-parse HEAD").trim();
  const s = singleState(dir, [
    { kind: "adversarial-round", at: 1, round: 1, status: "ISSUES_FOUND", verdictParsed: true },
    { kind: "adversarial-fix-requested", at: 2, workstreamId: "docs", round: 1, findings },
  ]);
  return {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      baseSha: base,
      worktrees: { docs: dir, code: dir },
      workstreams: {
        docs: {
          id: "docs",
          scope: "document the change in b.txt",
          paths: ["b.txt"],
          outOfScope: ["a.txt"],
        },
        code: {
          id: "code",
          scope: "implement the feature in a.txt",
          paths: ["a.txt"],
          outOfScope: ["b.txt"],
        },
      },
      plumbReports: [],
    },
  };
}
