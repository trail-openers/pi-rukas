/**
 * merge-guard-stub-gl — the GitLab half of the merge-guard exec stub
 * (#2226), split out of `merge-guard-stub.ts` for the §12 cap.
 *
 * `mergeGuardExec` owns the command ORDER for both forges; this module owns only
 * what the gatherer's GitLab reads are ANSWERED with, and is called from that one
 * place with the command already joined. The arm belongs here rather than beside
 * the gh arms because it is the reads of a different forge: `glab api` argv built
 * by `forge-commands-gl-evidence.ts`, not gh's, and the two page-2 probes below
 * share an ordering constraint no gh read has.
 *
 * Order inside this module is part of the contract, same as in the parent: both
 * page-2 probes are matched BEFORE their page-1 arm, because the page-1 argv is a
 * PREFIX of the probe's, so an `includes` on the shorter form would answer a
 * probe with page 1's rows and report a short list as truncated.
 *
 * `glEvidenceAnswer` returns `undefined` when no arm matched, which sends the
 * command back to the parent's matcher chain — the catch-all there then throws
 * `unexpected exec` on anything genuinely unrecognised, so an un-stubbed GitLab
 * read is a fixture gap that fails loudly rather than an empty answer a matrix
 * passes on.
 */

import type { MergeGuardEnv } from "./merge-guard-stub.ts";

/**
 * The one pipeline id the GitLab arms name. The gatherer follows the MR row's
 * `head_pipeline.id` rather than the newest row of the pipelines list, so the MR
 * answer, the pipelines answer and the jobs answer must all name the SAME
 * pipeline, and the two jobs matchers below key on it. An arm that wants a
 * different one replaces the MR row and the pipelines row together.
 */
const GL_PIPELINE_ID = 5001;

/**
 * The MR row the gatherer's GitLab arm reads (#2226): the fields
 * `composeGlReadiness` needs, plus the head — from the SAME read, which is the
 * point of the single-API-call shape (E2). Derived from the one widened head
 * every other reader answers with, so a matrix about the CHECK verdicts cannot
 * fail the head pin by accident.
 */
function glMrRow(prNumber: number, oid: string, status: string | undefined) {
	return {
		iid: prNumber,
		state: "opened",
		detailed_merge_status: status ?? "can_be_merged",
		has_conflicts: false,
		blocking_discussions_resolved: true,
		approvals_left: 0,
		sha: oid,
		diff_refs: { head_sha: oid },
		head_pipeline: { id: GL_PIPELINE_ID, sha: oid, status: "success" },
	};
}

/**
 * Answer one GitLab evidence read, or `undefined` when the command is not one.
 *
 * The guard's identity read is deliberately NOT re-stubbed in glab form: it
 * stays the parent's answer, widened to the same head, because that is the read
 * the guard issues whichever forge the merge is on.
 */
export async function glEvidenceAnswer(
	env: MergeGuardEnv,
	cmd: string,
	headOid: string,
): Promise<{ stdout: string } | undefined> {
	const mr = t_prNumber(env);
	if (cmd.includes(`glab api /projects/:id/merge_requests/${mr}`)) {
		if (env.failEvidence) throw new Error("glab: could not read the MR");
		return {
			stdout:
				env.glMr ?? JSON.stringify(glMrRow(mr, headOid, env.glMrStatus)),
		};
	}
	const pipelines = `glab api "/projects/:id/merge_requests/${mr}/pipelines`;
	if (cmd.includes(pipelines) && cmd.includes("&page=2")) {
		if (env.failChecks) throw new Error("glab: could not read the pipelines page");
		return { stdout: env.glPipelinesPage2 ?? "[]" };
	}
	if (cmd.includes(pipelines)) {
		if (env.failChecks) throw new Error("glab: could not read the pipelines");
		return {
			stdout:
				env.glPipelines ??
				JSON.stringify([{ id: GL_PIPELINE_ID, sha: headOid, status: "success" }]),
		};
	}
	const jobs = `glab api "/projects/:id/pipelines/${GL_PIPELINE_ID}/jobs`;
	if (cmd.includes(`${jobs}?per_page=`) && cmd.includes("&page=2")) {
		if (env.failChecks) throw new Error("glab: could not read the jobs page");
		return { stdout: env.glJobsPage2 ?? "[]" };
	}
	if (cmd.includes(jobs)) {
		if (env.failChecks) throw new Error("glab: could not read the jobs");
		if (env.hangChecks) {
			// The #2107 hang arm, on the read that is last: the guard's bound is
			// what answers it, and the assertion that every read was bounded wants
			// the earlier reads to have answered rather than timed out.
			await new Promise((res) => setTimeout(res, 60_000));
		}
		return {
			stdout:
				env.glJobs ?? JSON.stringify([{ name: "quality-gate", status: "success" }]),
		};
	}
	return undefined;
}

/** The MR number the argv matchers are built with, from the matrix's own target. */
function t_prNumber(env: MergeGuardEnv): number {
	return env.target.prNumber;
}
