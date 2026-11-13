/**
 * work-driver-merge-evidence-gl-reads — the list reads behind the GitLab merge
 * evidence gate (#2226), split from `work-driver-merge-evidence-gl.ts` along the
 * seam the gate already has: the gatherer decides what a verdict IS, this module
 * decides WHICH ROWS a verdict may be drawn from.
 *
 * Everything here answers one question with a list of rows the forge returned:
 * is this the whole list, and does it contain the pipeline the MR designates as
 * its head's? Both questions are merge decisions, because a gate that graded a
 * subset or a foreign pipeline reported a verdict it never read.
 *
 * The two shapes of "not the whole truth" the gate has to tell apart:
 *
 *   - **Truncation.** `per_page=100` is the largest page the API serves, so a
 *     100-row answer is consistent with a 356-row collection and with one of
 *     exactly 100. The row count cannot separate them; a second-page probe can,
 *     and asking it is what keeps an MR of exactly that size mergeable instead of
 *     permanently refused. A probe that FAILS leaves the question open, which is
 *     tooling rather than a verdict.
 *   - **Mis-attribution.** A pipeline row can carry the right `id` and another
 *     commit's `sha`. The id is a foreign key, not an identity — GitLab keeps it
 *     stable across a re-run — so the row must agree with the head too, or the
 *     gate is grading CI that never ran on this head.
 *
 * Row-level grading is NOT here: that is the one table in `forge-gl-grade.ts`.
 *
 * Every read here is bounded. `maxBuffer` bounds the ANSWER, never the wait, so
 * a `glab` that hangs would hold the caller — the driver's merged step, the
 * stepback ci step, lean land — open indefinitely; only the `tool_call` merge
 * guard wrapped the whole gather in its own budget. Each read therefore carries
 * the shared forge-exec bound, and one that times out is a tooling refusal.
 */

import { FORGE_EXEC_TIMEOUT_MS } from "./forge-detect.ts";

/** Shell executor with the fields these reads actually pass. */
type GlListExec = (
  cmd: string,
  opts: { cwd: string; maxBuffer: number; timeout: number },
) => Promise<{ stdout: string }>;

/** Read one `glab api` list and classify its answer. */
export async function readGlList(
  execFn: GlListExec,
  repoRoot: string,
  cmd: string,
  maxBuffer: number,
): Promise<{ rows: unknown[] } | { malformed: string } | { failed: string }> {
  try {
    const { stdout } = await execFn(cmd, {
      cwd: repoRoot,
      maxBuffer,
      timeout: FORGE_EXEC_TIMEOUT_MS,
    });
    return parseGlArray(stdout);
  } catch (err) {
    return { failed: glExecDetail(err) };
  }
}

/** A non-zero exit and an exit-0-but-unparseable answer are different faults. */
function glExecDetail(err: unknown): string {
  const e = err as Error & { killed?: boolean };
  if (e?.killed) return `the glab invocation timed out (${FORGE_EXEC_TIMEOUT_MS}ms)`;
  return e?.message ?? "the glab invocation failed";
}

/** `stdout` → a JSON array, or the reason it is not one. */
export function parseGlArray(stdout: string): { rows: unknown[] } | { malformed: string } {
  if (!stdout.trim()) return { malformed: "(the glab invocation returned no output)" };
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed)) return { malformed: stdout };
    return { rows: parsed as unknown[] };
  } catch {
    return { malformed: "(output was not valid JSON)" };
  }
}

/**
 * Whether a list response that FILLED its page is the whole collection (#2226).
 *
 * The only question that separates "exactly a page" from "there is more" is
 * "does a second page exist?", and one more read answers it. Refusing on a full
 * page instead — the shape this gate shipped with — made every collection of
 * exactly that size permanently unmergeable: no re-run changes the answer, which
 * is the pilot-parking class this issue exists to remove. A probe that FAILS is
 * refused as tooling, because an unread follow-up leaves the possibility of more
 * rows open.
 *
 * Shared by both paginated reads: the jobs list (a truncated jobs list grades a
 * subset) and the pipelines list (a truncated one can omit the very row that
 * proves the head pipeline belongs to this MR).
 */
export async function probeSecondPage(
  execFn: GlListExec,
  repoRoot: string,
  cmd: string,
): Promise<{ more: true } | { none: true } | { failed: string }> {
  const second = await readGlList(execFn, repoRoot, cmd, 512 * 1024);
  if ("failed" in second) return { failed: second.failed };
  if ("malformed" in second) return { failed: second.malformed };
  return second.rows.length === 0 ? { none: true } : { more: true };
}

/**
 * The pipeline whose jobs the gate is allowed to grade, from the MR's pipelines
 * list (#2226).
 *
 * The MR row carries `head_pipeline.id` — the pipeline GitLab itself designates
 * as the one running on the MR head — so the gate asks for that row's jobs
 * rather than for "the newest thing in a list whose ordering is server-side and
 * documented as nothing more than 'all pipelines for this MR'". A train
 * pipeline, an auto-deploy pipeline, or a superseded branch pipeline can sit at
 * the front of that list, and a jobs list read for one of them is not a verdict
 * about this head: either it refuses a green MR (an unrelated pipeline is red)
 * or, worse, it passes a red one.
 *
 * Fallback when the MR row names no head pipeline (the field is hidden when the
 * caller may not view the project's pipelines): the list is filtered to rows
 * whose `sha` is the MR head, and only a single such row is accepted — several
 * agree on nothing. When the MR row names one, the list is used to prove that
 * row belongs to this MR AND to this commit: the id is a foreign key, not an
 * identity, and a row that carries the right id and a different `sha` is CI that
 * never ran on this head (a re-run, a restored pipeline, a cached list).
 */
export function pickPipelineForHead(
  mrRaw: Record<string, unknown>,
  rows: unknown[],
  headOid: string | undefined,
): { pipelineId: number } | { refusal: string } | { noPipeline: true } {
  const head = headPipelineId(mrRaw);
  const list = rows.filter(
    (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
  );
  // Read it this way FIRST: the pipelines read answering an empty list is the
  // one absence that means "this MR has no CI", and that reading must not
  // depend on any field of the MR row. Checked after the head pipeline only for
  // the empty list — an MR row that names a pipeline its own list omits is the
  // disagreement below, not a pipeline-less MR.
  if (list.length === 0) return { noPipeline: true };
  if (head !== undefined) {
    const row = list.find((r) => r.id === head);
    if (row === undefined) {
      // The MR names a head pipeline the MR's own pipelines list does not
      // contain: the two reads disagree, and neither can be trusted to name the
      // CI verdict for this merge.
      return {
        refusal: `the MR names head pipeline ${head}, which its pipelines list does not contain`,
      };
    }
    // The id matched, which is not yet the same as the row being about this
    // head: pipeline ids are stable, so the row with the right id can carry
    // another commit's `sha`. Grading its jobs would call CI that never ran on
    // this head a verdict about it. When the MR row gave the gate no head to
    // compare against there is no disagreement to name, and the id is all the
    // forge answered — which is what the fallback branch below also accepts.
    if (headOid !== undefined && row.sha !== headOid) {
      return {
        refusal: `its sha ${String(row.sha ?? "(absent)").slice(0, 40)} is not the MR head ${headOid.slice(0, 12)}`,
      };
    }
    return { pipelineId: head };
  }
  if (headOid === undefined) {
    return {
      refusal:
        "the MR row carries no head pipeline and no head OID, so no pipeline can be attributed to this head",
    };
  }
  const matching = list.filter((r) => typeof r.sha === "string" && r.sha === headOid);
  const shortHead = headOid.slice(0, 12);
  if (matching.length === 0) {
    return {
      refusal: `none of the ${list.length} pipeline(s) listed for this MR ran on the head ${shortHead}`,
    };
  }
  if (matching.length > 1) {
    return {
      refusal: `${matching.length} pipelines for this MR claim the head ${shortHead}; the MR row names no head pipeline to choose between them`,
    };
  }
  const id = typeof matching[0]?.id === "number" ? matching[0].id : undefined;
  if (id === undefined) return { refusal: "the matching pipeline row carries no numeric id" };
  return { pipelineId: id };
}

/** The MR row's `head_pipeline.id`, or `undefined` when the row does not name one. */
function headPipelineId(raw: Record<string, unknown>): number | undefined {
  const head = raw.head_pipeline as Record<string, unknown> | null | undefined;
  return head !== null && typeof head?.id === "number" ? head.id : undefined;
}
