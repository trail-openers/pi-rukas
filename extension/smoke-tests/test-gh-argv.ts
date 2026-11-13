#!/usr/bin/env bun
/**
 * #745 — argv-pinning gate for the `gh` / `glab` merge-evidence invocations.
 *
 * The bug this test pins: `gatherMergeEvidence` and `prChecksCmd` requested
 * `isRequired` from `gh pr checks --json` — a field the subcommand does not
 * support. `gh` rejected the command with "Unknown JSON field" on EVERY host,
 * the gate failed closed on every PR, and the handoff told the operator to
 * "check the incomplete required checks" — a CI verdict about a healthy,
 * green system.
 *
 * The supported field set is a property of the gh BINARY, not the repo, so
 * this test pins the field set as a hard-coded constant, verified against
 * gh 2.98.0 (2026-08-20) on this host:
 *
 *   gh pr checks --json: bucket, completedAt, description, event, link,
 *                        name, startedAt, state, workflow
 *   gh pr view  --json:  (mergeStateStatus, mergeable, state, headRefOid — a
 *                        subset of the supported pr view set, pinned for the
 *                        same reason the checks set is pinned). `headRefOid`
 *                        was added by #1533 so the merge pin and the CI verdict
 *                        come from ONE read; it is a supported `pr view` field
 *                        (verified against gh 2.102.0 on this host).
 *
 * The GitLab side of the fix (the MR API call and the open-pipeline jobs
 * call) is a bare `glab api` GET that takes no field list at all, which is
 * exactly why it cannot regress the same way; the assertion below pins the
 * exact command strings anyway, so a field list creeping in later is caught
 * here too.
 */

import {
  GL_JOB_PAGE_SIZE,
  mergeEvidenceGlJobsCmd,
  mergeEvidenceGlJobsPage2Cmd,
  mergeEvidenceGlMrCmd,
  mergeEvidenceGlPipelinesCmd,
} from "../src/forge-commands-gl-evidence.ts";
import {
  labelAddCmd,
  labelRemoveCmd,
  mergeEvidenceViewCmd,
  pipelineViewCmd,
  prChecksCmd,
} from "../src/forge-commands.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
	if (cond) console.log(`✓ ${msg}`);
	else {
		console.error(`✗ ${msg}`);
		exit = 1;
	}
}

/** Fields `gh pr checks --json` accepts, per gh 2.98.0 (2026-08-20). */
const GH_PR_CHECKS_FIELDS = new Set([
	"bucket",
	"completedAt",
	"description",
	"event",
	"link",
	"name",
	"startedAt",
	"state",
	"workflow",
]);

/**
 * The `pr view` fields the merge-evidence gate actually requests.
 *
 * `headRefOid` (#1533) is the commit OID the driver pins its merge to: the
 * evidence read is the single moment the forge is observed, so the CI verdict
 * and the pin cannot come from two reads that disagree.
 *
 * `author` (#2181) is the login the merge-author allowlist is checked against,
 * requested by the SAME read for the same reason: who opened the PR is judged at
 * the moment its CI verdict was read, and a second `gh pr view` would be a second
 * moment in which the PR could have been reassigned.
 */
const GH_PR_VIEW_EVIDENCE_FIELDS = new Set([
	"mergeStateStatus",
	"mergeable",
	"state",
	"headRefOid",
	"author",
]);

function requestedFields(cmd: string, flag: string): string[] {
	const match = cmd.match(new RegExp(`${flag}\\s+(\\S+)`));
	if (!match) return [];
	return match[1]!.split(",").filter(Boolean);
}

// ── gh pr checks — the field list gh 2.98.0 actually supports ─────────────

{
  const cmd = prChecksCmd("github", 17);
  const fields = requestedFields(cmd, "--json");
  assert(cmd === "gh pr checks 17 --json name,state,bucket", `exact argv: ${cmd}`);
  assert(
    fields.length > 0 && fields.every((f) => GH_PR_CHECKS_FIELDS.has(f)),
    `every requested field (${fields.join(",")}) is in the gh 2.98.0 supported set for \`gh pr checks --json\` — a field outside that set makes the whole invocation fail closed (the #745 bug)`,
  );
  assert(
    !fields.includes("isRequired"),
    "isRequired must not be requested — it is not a field this subcommand supports",
  );
}

// ── gh pr view — the merge-evidence gate's state read ──────────────────────

{
	const cmd = mergeEvidenceViewCmd(17);
	const fields = requestedFields(cmd, "--json");
	assert(
		cmd ===
			"gh pr view 17 --json mergeStateStatus,mergeable,state,headRefOid,author",
		`exact argv: ${cmd}`,
	);
	assert(
		fields.length > 0 && fields.every((f) => GH_PR_VIEW_EVIDENCE_FIELDS.has(f)),
		`every requested field (${fields.join(",")}) is one the gate knows how to read`,
	);
	assert(
		fields.includes("author"),
		"#2181: the author is requested by the evidence read itself — a gate that must ask gh a second time for the login can be handed a different PR state than the one it pinned",
	);
}

// ── GitLab — no --json field list can creep in on the glab side either ────

{
  const checks = prChecksCmd("gitlab", 17);
  assert(
    checks === 'glab api "/projects/:id/merge_requests/17/pipelines" --output json',
    `glab prChecksCmd exact argv: ${checks}`,
  );
  assert(
    !checks.includes("--json"),
    "glab prChecksCmd must not grow a field list — a field set is exactly how #745 happened",
  );
  const jobs = pipelineViewCmd(5001);
  assert(
    jobs === "glab api /projects/:id/pipelines/5001 --output json",
    `glab pipelineViewCmd exact argv: ${jobs}`,
  );
  assert(!jobs.includes("--json"), "glab pipelineViewCmd must not grow a field list either");
}

// ── #2226 — the GitLab merge-evidence reads, pinned like every other argv ──

{
  // The three reads the gatherer's GitLab arm is allowed to issue, and nothing
  // else. They are pinned HERE (rather than only in the evidence tests) because
  // they gate the one irreversible act: a builder that quietly changed endpoint
  // would send the gate to the wrong MR or the wrong pipeline, and the verdict
  // it reports would still look well-formed.
  const mr = mergeEvidenceGlMrCmd(17);
  assert(mr === "glab api /projects/:id/merge_requests/17", `glab MR-state argv: ${mr}`);
  assert(!mr.includes("--json"), "glab MR-state argv must not grow a field list (#745)");
  const pipes = mergeEvidenceGlPipelinesCmd(17);
  assert(
    pipes === 'glab api "/projects/:id/merge_requests/17/pipelines?per_page=100" --output json',
    `glab pipelines argv: ${pipes}`,
  );
  assert(!pipes.includes("--json"), "glab pipelines argv must not grow a field list either");
  // #2226 — the pipelines list is read to PROVE the MR's head pipeline belongs
  // to this MR, so it is pinned to the same page size as the jobs read: with
  // the API's 20-row default, an MR whose 21st-oldest pipeline is the head's
  // would look like the forge contradicting itself.
  assert(
    pipes.includes(`per_page=${GL_JOB_PAGE_SIZE}`),
    `glab pipelines argv must pin the page size (the API default is 20): ${pipes}`,
  );
  const glJobs = mergeEvidenceGlJobsCmd(5001);
  assert(
    glJobs === 'glab api "/projects/:id/pipelines/5001/jobs?per_page=100" --output json',
    `glab jobs argv: ${glJobs}`,
  );
  assert(!glJobs.includes("--json"), "glab jobs argv must not grow a field list either");
  // #2226 — the page size is load-bearing: the endpoint's own default is 20, so
  // an argv that lost `per_page` would quietly grade the first 20 jobs of a
  // 356-job pipeline and report it as the whole verdict. Pinned here, at the
  // same seam that pins the endpoint itself, rather than only in the gatherer.
  assert(
    glJobs.includes(`per_page=${GL_JOB_PAGE_SIZE}`),
    `glab jobs argv must pin the page size (the API default is 20): ${glJobs}`,
  );
  // #2226 — the second-page probe. It is a fourth read, so it is pinned here
  // like the three that decide the verdict: a builder that dropped `&page=2`
  // would re-read page 1, always answer "there are more rows", and turn every
  // pipeline of exactly a page back into a permanent refusal.
  const glJobs2 = mergeEvidenceGlJobsPage2Cmd(5001);
  assert(
    glJobs2 === 'glab api "/projects/:id/pipelines/5001/jobs?per_page=100&page=2" --output json',
    `glab jobs page-2 argv: ${glJobs2}`,
  );
}

// ── #775 — the label edit commands must name a real gh subcommand ────────

{
	// GitHub has no `gh mr edit` — an `mr` target must map to `pr`, or the
	// in-process handoff label fallback silently fails for every PR target
	// (the corpus shows 13/117 label failures were exactly this shape).
	const addPr = labelAddCmd("github", "mr", 17, "needs-human-attention");
	assert(
		addPr === "gh pr edit 17 --add-label needs-human-attention",
		`labelAddCmd mr→pr (gh has no mr subcommand): ${addPr}`,
	);
	const addIssue = labelAddCmd("github", "issue", 42, "bug");
	assert(
		addIssue === "gh issue edit 42 --add-label bug",
		`labelAddCmd issue unchanged: ${addIssue}`,
	);
	const rmPr = labelRemoveCmd("github", "mr", 17, "needs-human-attention");
	assert(
		rmPr === "gh pr edit 17 --remove-label needs-human-attention",
		`labelRemoveCmd mr→pr (gh has no mr subcommand): ${rmPr}`,
	);
	const rmIssue = labelRemoveCmd("github", "issue", 42, "bug");
	assert(
		rmIssue === "gh issue edit 42 --remove-label bug",
		`labelRemoveCmd issue unchanged: ${rmIssue}`,
	);
	// GitLab: the glab api paths already use issues/ vs merge_requests/ —
	// the mapping must not leak onto the gitlab branch.
	const glabAdd = labelAddCmd("gitlab", "mr", 17, "needs-human-attention");
	assert(
		glabAdd ===
			'glab api -X PUT -f "add_labels=needs-human-attention" /projects/:id/merge_requests/17',
		`gitlab mr target still uses the merge_requests path: ${glabAdd}`,
	);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
