/**
 * lib/verify-develop-provenance-fixture — drives the develop gate's #2283 gates against a
 * REAL repository.
 *
 * The provenance gate's whole claim is that it judges the committed tree, so a fake that
 * answered `git ls-tree` from a table could not distinguish "the file is not in the commit"
 * from "the executor did not implement that argv" — the vacuous-fake class. Every git read
 * here goes to real git in a real worktree; only the project's own verify command is
 * intercepted, and it is intercepted by name, never by a git argv.
 *
 * The two gates this lib serves share one rig because they are wired at the same seam and
 * must be observed to be independent: a case that needs a red command criterion and an
 * absent provenance token sets both on the same tree and asserts each gate reports its own.
 *
 * Lives in lib/ so the smoke glob never self-executes it.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HEADLESS_INPUTS } from "../../src/headless/inputs.ts";
import { buildDriverKnobNames } from "../../src/work-driver-verify-cmd.ts";
import { createEmitSink, type EmitSink } from "../../src/work-state-emit.ts";
import type { CycleContext, DriverContext } from "../../src/work-driver-context.ts";
import type { WorkEvent } from "../../src/workflow-state-events.ts";
import { initialState } from "../../src/workflow-state.ts";
import { gitTestEnv } from "./git-test-env.ts";

const execFileP = promisify(execFile);

/**
 * The fixture's git-isolation env, with the driver's own knobs removed.
 *
 * `gitTestEnv()` is built from `process.env`, so it carries whatever `PI_ENSEMBLE_*` the
 * driving process holds. That is right for the fixture's OWN git calls (they are the driver's
 * calls, and lean's fixtures rely on it) and wrong as the base under a scrubbed env a
 * production seam handed down: the spread would then put a knob back that the code under test
 * had just removed, and a test of the scrub could only ever see the leak. Dropping the names
 * `verifyChildEnv` owns makes the child's environment answer the question the case is asking.
 */
function isolatedBaseWithoutKnobs(): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...gitTestEnv() };
  const knobs = buildDriverKnobNames(HEADLESS_INPUTS);
  for (const name of knobs) delete base[name];
  return base;
}

/** The executor the gate under test uses: real git, and a scripted outcome for the
 * project's verify command so a case never pays for a suite it is not about. */
export function makeProvenanceExec(
  verifyCommand: string,
  onVerify?: () => Promise<void> | void,
  /** The project's `verify.test` template, so the tier's argv-form runner call is
   * recognisable. Without it an argv arm cannot tell the criteria runner from a git call. */
  runnerTemplate?: string,
  /** What the runner printed. The project's runner reports the environment it was spawned
   * with, and the only place those bytes exist is the executor's result — `runTestFile`
   * discards them on a green and the develop gate never sees them. Without this the child's
   * environment would be unobservable, which is how an env-scrub assertion could print a
   * `MISSING` for a knob it never actually looked at. */
  onRunnerOutput?: (out: { stdout: string; stderr: string }) => void,
): NonNullable<DriverContext["verifyExecFn"]> {
  return async (cmd, o) => {
    // Two arms, because the project's runner reaches this executor in two shapes and the
    // original matcher read only one of them.
    //
    //  - **shell form** — the discoverable verify chain runs `sh -c "<cmd>"`, and is answered
    //    with the canned result so a case never pays for a real suite it is not about. Only
    //    an explicitly configured command matches: `startsWith("")` is true for every command,
    //    which would answer `git` calls too and break the gate outright.
    //  - **argv form** — `runTestFile` renders the `verify.test` template as argv and calls
    //    `exec(bin, { argv: rest })`, so the template arrives SPLIT: `cmd` is the bin and
    //    `o.argv` is only the remaining args (`"sh"` + `["tests/run.sh", file]`). The full
    //    rendering is `cmd` followed by `argv`; comparing `argv` alone drops the bin and never
    //    matches, which is how the drift hook silently never fired. This arm is independent of
    //    `verifyCommand`, because the criteria tier runs its runner on the very arms where no
    //    verify command is discoverable at all. It also RUNS the command rather than answering
    //    it: a red arm is decided by the runner script's own exit, so a canned result here
    //    would make every red assertion vacuous.
    const argv = o?.argv;
    const isCriteriaRunner =
      argv !== undefined &&
      argv.length > 0 &&
      runnerTemplate !== undefined &&
      `${cmd} ${argv.join(" ")}` === runnerTemplate.replace("{file}", argv.at(-1) ?? "");
    if (isCriteriaRunner) await onVerify?.();
    // The criteria runner is recognised FIRST and never answered from a can. The project's
    // discovered verify command is often a prefix of the rendered `verify.test` template
    // (`sh` matches `sh tests/run.sh <file>`), so testing the canned arm first swallowed the
    // criteria run, returned an empty result, and the tier reported a pass for a runner that
    // never ran — which is how every env-observation of this tier was vacuously green.
    if (!isCriteriaRunner && verifyCommand !== "" && cmd.startsWith(verifyCommand)) {
      await onVerify?.();
      return { stdout: "" };
    }
    const { shell, ...rest } = o ?? {};
    const opts = {
      cwd: rest.cwd,
      maxBuffer: rest.maxBuffer ?? 8 * 1024 * 1024,
      timeout: rest.timeout,
      // The isolation levers go UNDER the caller's env, never over it. `gitTestEnv()` starts
      // from `process.env`, so merging it ON TOP of a scrubbed env handed down by the tier
      // re-admits every driver knob the scrub removed: the child would then show a knob the
      // production code scrubbed correctly, and an env-scrub assertion could never go green.
      // Isolation comes from the base, and every name the scrub owns is dropped from that base
      // so an absent key is genuinely absent in the child.
      env: o?.env ? { ...isolatedBaseWithoutKnobs(), ...o.env } : gitTestEnv(),
    };
    const ran = o?.argv
      ? await execFileP(cmd, o.argv, opts)
      : await execFileP(shell ?? "/bin/sh", ["-c", cmd], opts);
    if (isCriteriaRunner) onRunnerOutput?.({ stdout: ran.stdout, stderr: ran.stderr });
    const { stdout } = ran;
    return { stdout };
  };
}

/** Every git call a fixture makes, with the host's config and identity held constant. */
async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd: dir,
    env: gitTestEnv(),
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
}

/** A file written relative to a repo, creating parent directories as needed. */
function put(repo: string, rel: string, content: string): void {
  const abs = path.join(repo, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

export interface ProvenanceFixture {
  /** The scratch root; everything below it lives and dies together. */
  root: string;
  /** The clone the cycle runs in — `ctx.repoRoot`. */
  repo: string;
  /** The develop child's worktree, for the primary workstream `a`. */
  worktree: string;
  /** Every worktree path by workstream id, for `stateFor`'s workstreams map. A case that
   * drives more than one workstream asks for the extra ids up front; each is a second
   * detached worktree at the base with the develop files committed, so a multi-workstream
   * arm judges the same shape twice rather than one real and one empty. */
  worktrees: Record<string, string>;
  baseSha: string;
  headSha: string;
  /** Write a file in the worktree and commit it. Returns nothing; the gate re-reads HEAD. */
  commit(rel: string, content: string): Promise<void>;
  /** Commit a pre-staged change (write + `git add` + commit in one step). */
  commitAll(message: string): Promise<void>;
  execFn: NonNullable<DriverContext["verifyExecFn"]>;
  /** The context and state the gate is driven with. `issue` is the case's own number.
   * Always returns a `CycleContext`: `verifyDevelopOutcome` takes one, so a fixture that
   * handed back a bare `DriverContext` could only be passed to the gate by defeating the
   * compiler. The emit sink is real (built by `createEmitSink`) and its event log is kept on
   * `emitted`, so a case can read what a drive emitted instead of trusting it to stay empty. */
  ctxFor(opts?: { withEmitSink?: boolean }): CycleContext;
  /** Every event the drives of this fixture emitted, in call order. */
  emitted: WorkEvent[];
  stateFor(
    extra?: {
      issueBodyArtifact?: string;
      /** A per-workstream base that is not a full sha is how the driver itself produces a
       * workstream with no effective base — `effectiveBaseFor` falls back to the cycle base
       * only when the entry IS a valid sha. */
      workstreamBaseShas?: Record<string, string>;
      workstreams?: Record<
        string,
        { id: string; scope: string; paths: string[]; outOfScope: string[] }
      >;
    },
    opts?: { issues?: number[]; baseSha?: string },
  ): ReturnType<typeof initialState>;
}

/**
 * Build a repo whose base holds `baseFiles`, plus one detached worktree at the base.
 *
 * The caller then commits the develop child's own work through `commit`, and the gate
 * judges exactly that range. The worktree is detached, as the driver's are: a branch name
 * in the worktree would let a case pass by naming a ref the gate never reads.
 */
export async function makeProvenanceFixture(opts: {
  issue: number;
  baseFiles?: Record<string, string>;
  /** Contents committed on the worktree before the gate runs, in order. */
  developFiles?: Record<string, string>;
  verifyCommand?: string;
  onVerify?: () => void;
  /** The project's `verify.test` template, passed to the executor so it can recognise the
   * criteria tier's argv-form runner call. Omit it on a case with no command criteria. */
  runnerTemplate?: string;
  /** Runs immediately before the project's verify command, so a case can move HEAD between
   * the two head reads of the criteria tier — the drift the green verdicts must not survive
   * and a red verdict must. A throw is not swallowed: a case that cannot move the head has
   * to fail, not quietly run the static-head arm. */
  beforeVerify?: () => Promise<void> | void;
  /** Extra workstream ids besides `a`, each with its own worktree at the base. */
  extraWorkstreams?: string[];
  /** Receives everything the project's `verify.test` runner printed, per run. See
   * {@link makeProvenanceExec}'s `onRunnerOutput`. */
  onRunnerOutput?: (out: { stdout: string; stderr: string }) => void;
}): Promise<ProvenanceFixture> {
  const root = mkdtempSync(path.join(tmpdir(), `pi-prov-${String(opts.issue)}-`));
  // The scratch root is itself inside a git-tracked tree on some hosts (/tmp under a repo,
  // a worktree-relative tmpdir), and `git init` then refuses — "already a repository".
  // `--separate-git-dir` writes the metadata where nothing can already hold it.
  const gitDir = path.join(root, "git");
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(path.join(repo, ".pi"), { recursive: true });
  // A base is never empty: an empty tree has no OID for a gate to pin, and `git commit`
  // refuses it outright ("nothing to commit"), so a case with no baseFiles would die in the
  // fixture rather than in the gate under test.
  put(repo, "README.md", "# provenance fixture\n");
  for (const [rel, content] of Object.entries(opts.baseFiles ?? {})) put(repo, rel, content);
  const verifyCommand = opts.verifyCommand ?? "true";
  if (opts.verifyCommand !== undefined && opts.verifyCommand !== "") {
    writeFileSync(path.join(repo, ".pi", "verify-cmd"), `${opts.verifyCommand}\n`);
  }
  await git(repo, ["init", "-q", `--separate-git-dir=${gitDir}`, "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).trim();
  const worktree = path.join(root, ".worktrees", `issue-${String(opts.issue)}-a`);
  await git(repo, ["worktree", "add", "-q", "--detach", worktree, baseSha]);
  for (const [rel, content] of Object.entries(opts.developFiles ?? {})) put(worktree, rel, content);
  await git(worktree, ["add", "-A"]);
  // A fixture that stages nothing has nothing to commit, and git exits 1 saying so. The
  // worktree still sits at the base, which is the shape that case wants — so an empty
  // commit is a no-op here, not a fixture failure.
  await git(worktree, ["commit", "-q", "-m", "develop"]).catch(() => undefined);
  const headSha = (await git(worktree, ["rev-parse", "HEAD"])).trim();
  const worktrees: Record<string, string> = { a: worktree };
  for (const id of opts.extraWorkstreams ?? []) {
    // `id` is data, not a path: a workstream called `../x` would escape the scratch root
    // and the `rm` cleanup would follow it. The driver's ids are `a`, `b`, … today; this
    // is the same `normaliseRelPath` refusal the develop gate applies to every path it reads.
    // `id` is data, not a path: a workstream called `../x` would escape the scratch root
    // and the `rm` cleanup would follow it. The driver's ids are `a`, `b`, … today; this
    // keeps a caller-supplied id from naming a directory outside the scratch root.
    const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
    // The primary's `a` already has its worktree (created above, and the one `commit`
    // writes to), so it is skipped here rather than duplicated under a second path.
    if (id === "a") continue;
    const wt = path.join(root, ".worktrees", `issue-${String(opts.issue)}-ws-${safe}`);
    await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
    for (const [rel, content] of Object.entries(opts.developFiles ?? {})) put(wt, rel, content);
    await git(wt, ["add", "-A"]);
    await git(wt, ["commit", "-q", "-m", `develop ${safe}`]).catch(() => undefined);
    worktrees[id] = wt;
  }
  const execFn = makeProvenanceExec(
    verifyCommand,
    async () => {
      await opts.beforeVerify?.();
      opts.onVerify?.();
    },
    opts.runnerTemplate,
    opts.onRunnerOutput,
  );
  const emitted: WorkEvent[] = [];
  const emitSink: EmitSink = createEmitSink((event) => {
    emitted.push(event);
  });
  return {
    root,
    repo,
    worktree,
    worktrees,
    baseSha,
    headSha,
    emitted,
    execFn,
    async commit(rel: string, content: string) {
      put(worktree, rel, content);
      await git(worktree, ["add", "-A"]);
      await git(worktree, ["commit", "-q", "-m", `add ${rel}`]);
    },
    async commitAll(message: string) {
      await git(worktree, ["add", "-A"]);
      await git(worktree, ["commit", "-q", "-m", message]);
    },
    ctxFor() {
      // The sink is not optional and never was: `CycleContext` requires it, and building it
      // behind a flag no caller set meant every gate-level drive either failed to type-check
      // or was handed a context the gate's own signature refuses. One sink per fixture, with
      // the events accumulated in `emitted` where a case can see them.
      return {
        host: { sendUserMessage: () => {} } as never,
        repoRoot: repo,
        issue: opts.issue,
        verifyExecFn: execFn,
        // The shape `persistCycle` reads — a real sink built by `createEmitSink`, so a
        // whole-step drive does not stub a field the code under test walks.
        emitSink,
      } as unknown as CycleContext;
    },
    stateFor(extra, callOpts) {
      let s = initialState(opts.issue, 1_000_000);
      // The worktree map is keyed on the ids the case declared, each resolved to its own
      // detached worktree — with `a` as the one exception: the primary's tree is created
      // before this map exists and is always present, so a case that declares `a` (every
      // multi-workstream one does) must not silently re-point it at a second tree.
      const ids = extra?.workstreams
        ? Object.keys(extra.workstreams)
        : Object.keys(worktrees).length > 0
          ? Object.keys(worktrees)
          : ["a"];
      const treeFor = (id: string): string => worktrees[id] ?? worktree;
      s = {
        ...s,
        ...(callOpts?.issues === undefined || callOpts.issues.length < 2
          ? {}
          : { issues: callOpts.issues }),
        pipelineState: {
          ...s.pipelineState,
          branchName: `feature/issue-${String(opts.issue)}`,
          baseSha: callOpts?.baseSha ?? baseSha,
          worktrees: Object.fromEntries(ids.map((id) => [id, treeFor(id)])),
          workstreams: extra?.workstreams ?? {
            a: { id: "a", scope: "the work", paths: [], outOfScope: [] },
          },
          ...(extra?.workstreamBaseShas === undefined
            ? {}
            : { workstreamBaseShas: extra.workstreamBaseShas }),
          ...(extra?.issueBodyArtifact === undefined
            ? {}
            : { issueBodyArtifact: extra.issueBodyArtifact }),
        },
      };
      return s;
    },
  };
}

/** The record at the heart of the field case: a results table whose `source` names a file
 * the same change also synthesises. */
export const FIELD_RECORD_ROWS = [
  { task: "t1", seconds: 12 },
  { task: "t2", seconds: 641 },
  { task: "t3", seconds: 5 },
];

/** Render the record the way the field case's generator did — JSON.stringify of a built
 * object, so the committed bytes and the generator's output are the same bytes by
 * construction, which is the whole point of the fixture. */
export function renderRecord(rows: readonly unknown[], source: string): string {
  return `${JSON.stringify({ source, pass: rows.length, rows }, null, 2)}\n`;
}

/** The generator that round-trips the record byte-identically from its own rows. */
export function renderGenerator(source: string, rows: readonly unknown[]): string {
  return [
    "// Renders the committed record from the rows below. A pure function of its own input:",
    "// byte-identity here says nothing about whether `source` ever existed.",
    "const rows = " + JSON.stringify(rows, null, 2) + ";",
    `const source = ${JSON.stringify(source)};`,
    'process.stdout.write(JSON.stringify({ source, pass: rows.length, rows }, null, 2) + "\\n");',
    "",
  ].join("\n");
}
