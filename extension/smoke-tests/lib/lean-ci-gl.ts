/**
 * lib/lean-ci-gl — the GitLab half of the `ci` recorder's forge seam.
 *
 * `lean-ci-recorder.ts` answers the four things `ci` reaches outside itself; the
 * GitLab cases need three more, and they are the ones whose whole point is that
 * they are NOT stubbed: the adapter is the real `createForge`, its argv is the
 * adapter's pinned form, and a self-hosted case is a repo that really carries
 * `.pi/forge` and an SSH remote on that host, because a detection the fixture
 * hand-waves is a fixture and not a detection.
 *
 * So the GitLab fixture lives here and the recorder imports it, which keeps both
 * files under the size cap along a seam that already exists: everything in this
 * file answers a GitLab read, and nothing in it knows what a pull request is.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectForge } from "../../src/forge-detect.ts";
import type { Forge, ForgeExecFn } from "../../src/forge-types.ts";
import { createForge } from "../../src/forge.ts";
import { GL_MR, GL_MR_CHECKING, glDetection } from "../forge-fixtures.ts";
import { gitTestEnv } from "./git-test-env.ts";

/** What a GitLab case asks the forge to answer. */
export interface GlCase {
  /** The MR rows the readiness reads compose from, one per poll. */
  mr?: Record<string, unknown>;
  mrAtReads?: (head: string) => unknown[];
  /** The raw job rows, in GitLab's snake_case `status` shape. Read-only and
   *  serialized verbatim, never mutated — so a suite's `as const` job fixtures
   *  pass straight through from `CiCase` without a cast. */
  jobs?: readonly Record<string, unknown>[];
  /** The SECOND page of the same jobs read — what a `?page=2` probe answers.
   *  A case that never gets a jobs read at all (an MR with no pipeline, or one
   *  whose pipeline names no commit) sets this to `null` to say so: the
   *  read-for-rows counter then stays at zero, because a case that answered a
   *  page nobody asked for would be answering a read that never happened.
   *  Absent means the empty page — what a one-page pipeline really has beyond
   *  its first page. */
  jobsPage2?: readonly Record<string, unknown>[] | null;
  /** The MR's pipelines rows. An empty array is "no pipeline at all". */
  pipelines?: readonly { id: number; sha?: string; status?: string }[];
  /** An MR reply that names NO pipeline: the step must then make no jobs read at
   *  all. This is the MR with no pipeline, as distinct from `pipelines: []`, which
   *  is the pipelines LIST the step no longer reads. */
  noPipeline?: boolean;
  /** What the pipeline the step asks about reports as the commit it built. The
   *  default is the head of the case's own repo, which is what a real MR's pipeline
   *  is built at; `null` is the pipeline that names no commit, and any other string
   *  is a pipeline at another commit — the tag or schedule pipeline whose rows the
   *  step must refuse to grade. */
  pipelineSha?: string | null;
  /** The head the MR reply reports, when the case wants one other than the head
   *  this repo holds: an MR whose head moved off the certified commit. */
  mrHead?: string;
  /** A read that fails outright — the forge could not be reached. */
  unreadable?: boolean;
  /** The self-hosted host, for a case built on `.pi/forge` + an SSH remote. */
  glHost?: string;
}

/** The self-hosted host every self-hosted case of this recorder is told to use. */
export const SELF_HOST = "gitlab.example.com";

/**
 * The commit-bearing fields of the fixture's MR rows — the reply's
 * `diff_refs.head_sha` and its embedded `open_pipeline.id` — are read by the step
 * to decide WHICH pipeline's jobs to read and at which commit the readiness was
 * composed. Both follow the head of the case's own repo, because the step pins the
 * jobs read to that head (see `ci-forge-gl.ts`) and a constant would be a commit
 * this repo never held: every green would be a green about a head that cannot
 * exist. A case that names its own `mr` owns it COMPLETELY — rewriting its
 * `diff_refs` would turn "the forge named no head" into a well-formed answer and
 * the case would assert nothing.
 */
const GL_MR_PIPELINE = { id: 5001, status: "running" };

/** Give an MR row the pipeline whose jobs the step reads, identified by id only.
 *  GitLab's MR reply names the pipeline; the commit it built comes from the
 *  `/pipelines/:id` read, which is where the step's head pin gets its evidence. */
function withRowHead(row: Record<string, unknown>): Record<string, unknown> {
  if (row.open_pipeline !== undefined || row.head_pipeline !== undefined) return row;
  return { ...row, open_pipeline: GL_MR_PIPELINE };
}

/** Strip the embedded pipeline rows: an MR that names no pipeline at all. */
function withNoPipeline(row: Record<string, unknown>): Record<string, unknown> {
  const { open_pipeline: _o, head_pipeline: _h, ...rest } = row;
  return rest;
}

/** The MR address the publish step records for a self-hosted GitLab run. */
export const glPrUrl = (): string => `https://${SELF_HOST}/group/sub/-/merge_requests/77`;

/**
 * Put the run's publish step on a merge request instead of a pull request.
 *
 * The step derives the number from this URL alone, so a GitLab case that left
 * the GitHub URL on the log would be a GitHub case with a GitLab fixture bolted
 * on — and would have gone green without ever parsing a `/-/merge_requests/N`.
 */
export function rewritePrUrl(
  f: { ctx: { steps: unknown[]; run: { steps: unknown[] } } },
  url: string,
): void {
  const rewritten = f.ctx.steps.map((entry) => {
    const s = entry as { state: string; outcome?: { prUrl?: string } };
    if (s.state !== "publish" || s.outcome?.prUrl === undefined) return entry;
    return { ...s, outcome: { ...s.outcome, prUrl: url } };
  });
  f.ctx.steps = rewritten;
  f.ctx.run = { ...f.ctx.run, steps: rewritten };
}

/**
 * Make this repo a self-hosted GitLab clone, the way the operator's is.
 *
 * `detectForge` resolves a self-hosted project from `.pi/forge` (`type=`,
 * `host=`) agreeing with the remote's host, so both are written here and the
 * remote is the scp-form SSH one that a self-hosted clone really carries. The
 * recorder then asks `detectForge` itself rather than being told the answer, so
 * the case fails if that leg stops resolving.
 */
export function writeSelfHosted(repoRoot: string, host: string): void {
  mkdirSync(join(repoRoot, ".pi"), { recursive: true });
  writeFileSync(join(repoRoot, ".pi", "forge"), `type=gitlab\nhost=${host}\n`);
  spawnSync("git", ["remote", "add", "origin", `git@${host}:group/sub/project.git`], {
    cwd: repoRoot,
    encoding: "utf8",
    env: gitTestEnv(),
  });
}

/** The MR row the Nth readiness read composes from. */
function glMrRow(c: GlCase, head: string, n: number): Record<string, unknown> {
  if (c.mrAtReads !== undefined) {
    const seq = c.mrAtReads(head);
    const picked = seq[Math.min(n, seq.length - 1)];
    if (picked !== undefined) return withRowHead(picked as Record<string, unknown>);
  }
  if (c.mr !== undefined) return withRowHead(c.mr);
  // A case that says its MR names no pipeline gets one: the step must then read
  // neither the pipelines list nor any jobs page, and a default row that named a
  // pipeline would make that claim untestable.
  if (c.noPipeline === true)
    return withNoPipeline(
      c.mrHead === undefined
        ? { ...GL_MR, diff_refs: { head_sha: head } }
        : { ...GL_MR, diff_refs: { head_sha: c.mrHead } },
    );
  // The default row tracks the head this repo really holds — the one the verify
  // gate certified: the raw fixture's `head_sha` is a constant. `mrHead` is how a
  // case says the MR has moved off it, and the pipeline follows the reply's own
  // head, because GitLab's MR reply reports its pipeline's commit to match.
  return withRowHead({ ...GL_MR, diff_refs: { head_sha: c.mrHead ?? head } });
}

/**
 * The MR row of a `checking` poll: the retryable status, everything else clean,
 * at the head the case's repo holds.
 */
export function glMrChecking(head: string): Record<string, unknown> {
  return withRowHead({ ...GL_MR_CHECKING, diff_refs: { head_sha: head } });
}

/**
 * The MR row with no `diff_refs` at all — the head the forge never named. Its
 * pipeline goes with it: a reply that still named a pipeline would be read for
 * jobs the step then grades on a head the read never gave.
 */
export function glMrHeadless(): Record<string, unknown> {
  const { diff_refs: _dropped, open_pipeline: _pipeline, ...rest } = GL_MR;
  return rest;
}

/**
 * The MR row whose `diff_refs.head_sha` is not a full commit sha — the malformed
 * head, which is a different fault from an absent one and must say so.
 */
export function glMrShortHead(): Record<string, unknown> {
  return withRowHead({ ...GL_MR, diff_refs: { head_sha: "abc123" } });
}

/** The two-job green pipeline the fixture answers with, in GitLab's own shape. */
const GL_TWO_GREEN = [
  { name: "build", status: "success" },
  { name: "test", status: "success" },
];

/** The MR's pipelines reply — the list `prChecks` reads. */
const pipelineRow = (head: string) => [{ id: GL_MR_PIPELINE.id, sha: head, status: "success" }];

/**
 * The adapter a GitLab case reads through: the REAL `createForge`, over the
 * recorder's exec fake.
 *
 * `execFn` is the recorder's own command-recording exec, so the argv that lands
 * in `Ran.cmds` is what the adapter built — the pinned `glab api …` forms — and
 * not something this suite shaped to match its own expectations. The single
 * `/pipelines/:id` read is answered with the commit the case says it built, since
 * that is the evidence the step's head pin judges. A self-hosted case gets the
 * detection the REAL `detectForge` returns for the `.pi/forge` + SSH remote this
 * file wrote into the fixture repo.
 *
 * Returned as `Forge` (the adapter's own type) because that is what `CiDeps.forge`
 * declares: this is the real adapter, not a seam shaped to the step's subset, and
 * the step narrows it to `GlForge` itself when it branches onto the GitLab arm.
 */
export async function glForge(
  c: GlCase,
  repoRoot: string,
  head: string,
  selfHosted: boolean,
  record: (cmd: string) => void,
): Promise<Forge> {
  let mrReads = 0;
  const fixtureExec: ForgeExecFn = async (cmd) => {
    record(cmd);
    if (c.unreadable === true) throw new Error("glab: could not reach the API");
    if (cmd.includes("/jobs")) {
      if (c.noPipeline === true || c.jobsPage2 === null)
        throw new Error(`fixture: a jobs read nobody should have made — ${cmd}`);
      return {
        stdout: JSON.stringify(/page=2/.test(cmd) ? (c.jobsPage2 ?? []) : (c.jobs ?? GL_TWO_GREEN)),
      };
    }
    if (c.noPipeline === true && cmd.includes("/pipelines"))
      throw new Error(`fixture: a pipelines read nobody should have made — ${cmd}`);
    const one = /^glab api \/projects\/:id\/pipelines\/(\d+) --output json$/.exec(cmd);
    if (one !== null) {
      const sha =
        c.pipelineSha === null
          ? undefined
          : (c.pipelineSha ?? c.mrHead ?? c.pipelines?.[0]?.sha ?? head);
      return { stdout: JSON.stringify({ id: Number(one[1]), sha, status: "success" }) };
    }
    if (cmd.includes("/pipelines"))
      return { stdout: JSON.stringify(c.pipelines ?? pipelineRow(c.mrHead ?? head)) };
    return { stdout: JSON.stringify(glMrRow(c, head, mrReads++)) };
  };
  const detection = selfHosted ? await detectForge(repoRoot, {}) : glDetection("group", "sub");
  return createForge(detection, {
    execFn: fixtureExec,
    cwd: repoRoot,
  });
}
