import { spawnSync } from "node:child_process";
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
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectForge } from "../../src/forge-detect.ts";
import { mapGlPipelineJobs } from "../../src/forge-mapping.ts";
import type { ForgeExecFn } from "../../src/forge-types.ts";
import { createForge } from "../../src/forge.ts";
import type { GlForge } from "../../src/lean/ci-forge-gl.ts";
import { GL_JOBS, GL_MR, GL_MR_CHECKING, glDetection } from "../forge-fixtures.ts";
import { gitTestEnv } from "./git-test-env.ts";

/** What a GitLab case asks the forge to answer. */
export interface GlCase {
  /** The MR rows the readiness reads compose from, one per poll. */
  mr?: Record<string, unknown>;
  mrAtReads?: (head: string) => unknown[];
  /** The raw job rows, in GitLab's snake_case `status` shape. */
  jobs?: Record<string, unknown>[];
  /** The MR's pipelines rows. An empty array is "no pipeline at all". */
  pipelines?: unknown[];
  /** A read that fails outright — the forge could not be reached. */
  unreadable?: boolean;
  /** The self-hosted host, for a case built on `.pi/forge` + an SSH remote. */
  glHost?: string;
}

/** The self-hosted host every self-hosted case of this recorder is told to use. */
export const SELF_HOST = "gitlab.example.com";

/** The MR's pipelines row the fixture answers with: one finished pipeline. */
const PIPELINE = [{ id: 5001, status: "success" }];

/** The two-job green pipeline the fixture answers with, in GitLab's own shape. */
const GL_TWO_GREEN = [
  { name: "build", status: "success" },
  { name: "test", status: "success" },
];

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

/** The job rows the pipeline read answers, in the adapter's normalized shape. */
function glJobs(c: GlCase) {
  return mapGlPipelineJobs(c.jobs ?? GL_TWO_GREEN);
}

/**
 * The MR row the Nth readiness read composes from.
 *
 * A case that names its own row owns it COMPLETELY, `diff_refs` included:
 * rewriting it would turn "the forge named no head" into a valid head and the
 * case would assert nothing. Without an explicit row the fixture's is used with
 * its head set to THIS repo's commit — the fixture's is a constant, and a
 * constant is a commit this repo never held, which would make every green here a
 * green about a head that cannot exist.
 */
function glMrRow(c: GlCase, head: string, n: number): Record<string, unknown> {
  if (c.mrAtReads !== undefined) {
    const seq = c.mrAtReads(head);
    const picked = seq[Math.min(n, seq.length - 1)];
    if (picked !== undefined) return picked as Record<string, unknown>;
  }
  if (c.mr !== undefined) return c.mr;
  return { ...GL_MR, diff_refs: { head_sha: head } };
}

/** The MR row of a `checking` poll: the retryable status, everything else clean. */
export function glMrChecking(head: string): Record<string, unknown> {
  return { ...GL_MR_CHECKING, diff_refs: { head_sha: head } };
}

/** The MR row with no `diff_refs` at all — the head the forge never named. */
export function glMrHeadless(): Record<string, unknown> {
  const { diff_refs: _dropped, ...rest } = GL_MR;
  return rest;
}

/**
 * The MR row whose `diff_refs.head_sha` is not a full commit sha — the malformed
 * head, which is a different fault from an absent one and must say so.
 */
export function glMrShortHead(): Record<string, unknown> {
  return { ...GL_MR, diff_refs: { head_sha: "abc123" } };
}

/**
 * The adapter a GitLab case reads through: the REAL `createForge`, over the
 * recorder's exec fake.
 *
 * `execFn` is the recorder's own command-recording exec, so the argv that lands
 * in `Ran.cmds` is what the adapter built — the pinned `glab api …` forms — and
 * not something this suite shaped to match its own expectations. A self-hosted
 * case gets the detection the REAL `detectForge` returns for the `.pi/forge` +
 * SSH remote this file wrote into the fixture repo.
 */
export async function glForge(
  c: GlCase,
  repoRoot: string,
  head: string,
  selfHosted: boolean,
  record: (cmd: string) => void,
): Promise<GlForge> {
  let mrReads = 0;
  const fixtureExec: ForgeExecFn = async (cmd) => {
    record(cmd);
    if (c.unreadable === true) throw new Error("glab: could not reach the API");
    if (cmd.includes("/jobs")) return { stdout: JSON.stringify(c.jobs ?? GL_TWO_GREEN) };
    if (cmd.includes("/pipelines")) return { stdout: JSON.stringify(c.pipelines ?? PIPELINE) };
    return { stdout: JSON.stringify(glMrRow(c, head, mrReads++)) };
  };
  const detection = selfHosted ? await detectForge(repoRoot, {}) : glDetection("group", "sub");
  return createForge(detection, {
    execFn: fixtureExec,
    cwd: repoRoot,
  }) as unknown as GlForge;
}
