#!/usr/bin/env bun
/**
 * #2160 — `forge_read` answers every required read on both forges, and refuses
 * anything that writes.
 *
 * The tool runs in the PARENT through `createForge(detectForge(…))` with the
 * parent's login, so an offline test injects the executor at the adapter's own
 * seam (`createForge`'s `execFn`) and asserts the whole path: verb → command
 * builder → exec → raw bytes back. `forge-fixtures.ts` supplies the payloads;
 * the missing rows (issue comments, PR comments, issue list/search, PR list,
 * PR reviews, the failed-job log) were added there for this file.
 *
 * Two arms this file exists for beyond coverage:
 *
 *   - the WRITE REFUSAL. `forge_read` has no write verb; a call naming a write
 *     is refused with a message that names the read verbs, and the refusal
 *     fires BEFORE any forge is contacted (a refusal that ran a command first
 *     would be a write with extra steps). The same boundary refuses a `state`
 *     or `sourceBranch` the command builders would not accept: both are
 *     child-supplied and ride into the parent's credentialed `gh`/`glab` string.
 *   - RAW BYTES. A structured read comes back as the forge's JSON and a diff or
 *     log read comes back verbatim — the public-hygiene rewrite is a write rule
 *     and must not touch fetched bytes. The GitLab trace arm asserts a marker
 *     that exists ONLY in the trace payload, so it judges the trace read rather
 *     than the job-list row text that would satisfy a looser assertion.
 */

import { mergeEvidenceViewCmd } from "../src/forge-commands.ts";
import { createForge } from "../src/forge.ts";
import { detectForge } from "../src/forge-detect.ts";
import { executeForgeRead } from "../src/forge-read-execute.ts";
import { FORGE_READ_VERBS, validateForgeRead } from "../src/forge-read-tool.ts";
import {
  GH_CHECKS,
  GH_ISSUE,
  GH_ISSUE_COMMENTS,
  GH_ISSUE_LIST,
  GH_PR,
  GH_PR_COMMENTS,
  GH_PR_LIST,
  GH_PR_REVIEWS,
  GH_REPO,
  GH_RUN_DONE,
  GH_RUN_FAILED_LOG,
  GH_RUN_JOBS,
  GL_ISSUE,
  GL_ISSUE_NOTES,
  GL_ISSUE_LIST,
  GL_JOB_TRACE,
  GL_MR,
  GL_MR_APPROVALS,
  GL_MR_LIST,
  GL_MR_NOTES,
  GL_PIPELINE_DONE,
  GL_PIPELINE_JOBS,
  GL_PROJECT,
  ghDetection,
  glDetection,
  mkExec,
} from "./forge-fixtures.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

const JSON_ = (v: unknown): string => JSON.stringify(v);
const OWNER = "acme";
const REPO = "widget";
const GH_DET = ghDetection(OWNER, REPO);
const GL_DET = glDetection(OWNER, REPO);

/** Run one verb against a fake exec and return the raw output plus the calls made. */
async function read(
  det: typeof GH_DET,
  exec: ReturnType<typeof mkExec>,
  req: Record<string, unknown>,
): Promise<string> {
  return executeForgeRead(det, "/repo", req as never, {
    buildForge: (d, o) => createForge(d, { execFn: exec.fn, cwd: o.cwd }),
  });
}

async function main(): Promise<void> {
  // ── 1. The read table is the whole documented surface ───────────────────
  console.log("verb table:");
  await check("every required read has a verb", () => {
    const required = [
      "issue_view",
      "issue_comments",
      "issue_list",
      "issue_search",
      "pr_view",
      "pr_list",
      "pr_reviews",
      "pr_checks",
      "pr_diff",
      "ci_run",
      "ci_run_log",
      "label_list",
      "repo_settings",
    ];
    assert(
      JSON.stringify([...FORGE_READ_VERBS].sort()) === JSON.stringify([...required].sort()),
      `verbs are exactly the required set (got ${FORGE_READ_VERBS.join(",")})`,
    );
  });
  await check("no write verb is exposed", () => {
    for (const w of ["merge", "create", "comment", "edit", "close", "label_add"]) {
      assert(
        !FORGE_READ_VERBS.includes(w as never),
        `the verb list carries no "${w}"`,
      );
    }
  });

  // ── 2. GitHub: every required read against fixtures ─────────────────────
  console.log("github reads:");
  await check("issue_view returns the body and lists the comments separately", async () => {
    const exec = mkExec({
      "gh issue view 42 --json number": { stdout: JSON_(GH_ISSUE) },
      "gh issue view 42 --json comments": { stdout: JSON_(GH_ISSUE_COMMENTS) },
    });
    const body = await read(GH_DET, exec, { verb: "issue_view", number: 42 });
    assert(body.includes("the issue body"), `issue body returned (${body.slice(0, 40)})`);
    const comments = await read(GH_DET, exec, { verb: "issue_comments", number: 42 });
    assert(comments.includes("first note"), "issue comments returned");
    assert(
      exec.calls.some((c) => c === "gh issue view 42 --json comments"),
      "the comment read uses the dedicated comments command",
    );
  });
  await check("issue_list carries state and issue_search carries the query", async () => {
    const exec = mkExec({
      // `--limit 100` is part of the key: the bare `gh issue list` key below
      // would also match the SEARCH command (whose own key is more specific),
      // and an order-dependent fake that answered a search with the wrong rows
      // would quietly satisfy the list assertion.
      "gh issue list --state closed --limit 100": { stdout: JSON_(GH_ISSUE_LIST) },
      "gh issue list --search": { stdout: JSON_(GH_ISSUE_LIST) },
    });
    const listed = await read(GH_DET, exec, { verb: "issue_list", state: "closed" });
    // The raw form the parent returns, not an indented re-render: `"state": "OPEN"`
    // is what a pretty-printed row looks like and `"state":"OPEN"` is what the
    // CLI actually sent, so an assertion written for one fails on the other. What
    // this arm judges is that the read came back as the bytes `gh` wrote.
    assert(listed === JSON_(GH_ISSUE_LIST), `issue list rows returned verbatim (${listed})`);
    assert(
      exec.calls.some((c) => c.includes("--state closed")),
      `state filter reaches the command (${exec.calls.join(" | ")})`,
    );
    const searched = await read(GH_DET, exec, { verb: "issue_search", query: "widget", allStates: true });
    assert(searched.includes("A GitHub issue"), "issue search rows returned");
    assert(
      exec.calls.some((c) => c.includes("--search widget") && c.includes("--state all")),
      "search query and allStates reach the command",
    );
  });
  await check("pr_view returns reviews, checks and the head SHA", async () => {
    // `headRefOid` reaches the caller through the merge-evidence read, which is
    // the read that pins a merge to a commit — `mergeEvidenceViewCmd`. The
    // adapter's normalized `prView` does not carry it, so this arm asserts the
    // command that must, not the view mapper.
    assert(
      mergeEvidenceViewCmd(17).includes("headRefOid"),
      "the merge-evidence view read requests the head SHA the merge is pinned to",
    );
    const exec = mkExec({
      "gh pr view 17 --json reviews": { stdout: JSON_(GH_PR_REVIEWS) },
      "--json comments": { stdout: JSON_(GH_PR_COMMENTS) },
      "gh pr view": { stdout: JSON_(GH_PR) },
      "gh pr checks 17": { stdout: JSON_(GH_CHECKS) },
    });
    const view = await read(GH_DET, exec, { verb: "pr_view", number: 17 });
    assert(view.includes("CLEAN"), "the PR view carries mergeStateStatus");
    assert(view.includes("feature/issue-17-x"), "the PR view carries the head branch");
    const reviews = await read(GH_DET, exec, { verb: "pr_reviews", number: 17 });
    assert(reviews.includes("APPROVED") && reviews.includes("reviewer"), "reviews returned");
    const checks = await read(GH_DET, exec, { verb: "pr_checks", number: 17 });
    assert(checks.includes('"name": "ci"'), "status checks returned");
    let refused = "";
    try {
      await read(GH_DET, exec, { verb: "pr_comments", number: 17 });
    } catch (err) {
      refused = (err as Error).message;
    }
    assert(/is a write/.test(refused), `a comment verb is refused as a write (${refused})`);
  });
  await check("pr_list, pr_diff, label_list, repo_settings", async () => {
    const exec = mkExec({
      "gh pr list": { stdout: JSON_(GH_PR_LIST) },
      "gh pr diff 17": { stdout: "+added line\n" },
      "gh label list": { stdout: JSON_([{ name: "bug" }]) },
      "gh repo view": { stdout: JSON_(GH_REPO) },
    });
    assert(
      (await read(GH_DET, exec, { verb: "pr_list", state: "open" })).includes("A GitHub PR"),
      "pr list returned",
    );
    assert(
      (await read(GH_DET, exec, { verb: "pr_diff", number: 17 })) === "+added line\n",
      "pr_diff returns the RAW diff, not JSON",
    );
    assert(
      (await read(GH_DET, exec, { verb: "label_list" })).includes("bug"),
      "label list returned",
    );
    assert(
      (await read(GH_DET, exec, { verb: "repo_settings" })).includes("main"),
      "repo settings returned",
    );
  });
  await check("ci_run and ci_run_log (gh run view --log-failed)", async () => {
    const exec = mkExec({
      "/jobs": { stdout: JSON_(GH_RUN_JOBS) },
      "--log-failed": { stdout: GH_RUN_FAILED_LOG },
      "actions/runs/901": { stdout: JSON_(GH_RUN_DONE) },
    });
    const run = await read(GH_DET, exec, { verb: "ci_run", id: 901 });
    assert(run.includes("SUCCESS"), "ci run status returned");
    const log = await read(GH_DET, exec, { verb: "ci_run_log", id: 901 });
    assert(log === GH_RUN_FAILED_LOG, `failed-job log returned verbatim (${JSON_(log)})`);
    assert(
      exec.calls.some((c) => c === "gh run view 901 --log-failed"),
      `the GitHub failed-log read runs --log-failed (${exec.calls.join(" | ")})`,
    );
  });
  await check("a GitHub run with no failed job answers empty, not an error", async () => {
    const exec = mkExec({
      "/jobs": {
        stdout: JSON_([{ id: 1, name: "build", status: "completed", conclusion: "success" }]),
      },
      "--log-failed": { stdout: "should not be called" },
    });
    const log = await read(GH_DET, exec, { verb: "ci_run_log", id: 901 });
    assert(log === "", "no failed job means an empty log");
    assert(
      !exec.calls.some((c) => c.includes("--log-failed")),
      "the log command is not run when no job failed",
    );
  });

  // ── 3. GitLab: every required read ──────────────────────────────────────
  console.log("gitlab reads:");
  await check("issue body with comments; list and search", async () => {
    const exec = mkExec({
      "glab issue view 42 --output json": { stdout: JSON_(GL_ISSUE) },
      "/issues/42/notes": { stdout: JSON_(GL_ISSUE_NOTES) },
      "glab issue list --search": { stdout: JSON_(GL_ISSUE_LIST) },
      "glab issue list --all": { stdout: JSON_(GL_ISSUE_LIST) },
      "glab issue list --per-page": { stdout: JSON_(GL_ISSUE_LIST) },
    });
    assert(
      (await read(GL_DET, exec, { verb: "issue_view", number: 42 })).includes("the issue body"),
      "issue body returned",
    );
    assert(
      (await read(GL_DET, exec, { verb: "issue_comments", number: 42 })).includes("first note"),
      "issue notes returned",
    );
    assert(
      // Raw bytes, as the CLI sent them — see the GitHub list arm for why the
      // assertion is on the whole reply rather than a pretty-printed fragment.
      (await read(GL_DET, exec, { verb: "issue_list" })) === JSON_(GL_ISSUE_LIST),
      "issue list returned verbatim",
    );
    assert(
      (await read(GL_DET, exec, { verb: "issue_search", query: "widget" })).includes("GitLab issue"),
      "issue search returned",
    );
  });
  await check("MR view with approvals, checks, diff", async () => {
    const exec = mkExec({
      "glab mr view 17 --output json": { stdout: JSON_(GL_MR) },
      "/merge_requests/17/approvals": { stdout: JSON_(GL_MR_APPROVALS) },
      "/merge_requests/17/pipelines": { stdout: JSON_([{ id: 5001 }]) },
      "/pipelines/5001/jobs": { stdout: JSON_(GL_PIPELINE_JOBS) },
      "glab mr diff 17": { stdout: "+gl added\n" },
      "glab mr list": { stdout: JSON_(GL_MR_LIST) },
    });
    assert(
      (await read(GL_DET, exec, { verb: "pr_view", number: 17 })).includes("the MR body"),
      "MR body returned",
    );
    const reviews = await read(GL_DET, exec, { verb: "pr_reviews", number: 17 });
    assert(reviews.includes("reviewer"), `MR approvals returned (${reviews.slice(0, 60)})`);
    const checks = await read(GL_DET, exec, { verb: "pr_checks", number: 17 });
    assert(checks.includes("build"), "MR pipeline jobs returned");
    assert(
      (await read(GL_DET, exec, { verb: "pr_list" })).includes("GitLab MR"),
      "MR list returned",
    );
    assert(
      (await read(GL_DET, exec, { verb: "pr_diff", number: 17 })) === "+gl added\n",
      "MR diff returned raw",
    );
  });
  await check("pipeline status and per-job failed traces", async () => {
    const exec = mkExec({
      "/pipelines/5001 ": { stdout: JSON_(GL_PIPELINE_DONE) },
      "/pipelines/5001/jobs": { stdout: JSON_(GL_PIPELINE_JOBS) },
      "/jobs/8001/trace": { stdout: JSON_(GL_JOB_TRACE) },
    });
    assert(
      (await read(GL_DET, exec, { verb: "ci_run", id: 5001 })).includes("SUCCESS"),
      "pipeline status returned",
    );
    const log = await read(GL_DET, exec, { verb: "ci_run_log", id: 5001 });
    // The marker lives ONLY in the trace payload, never in a job row, so this
    // asserts the trace bytes came back rather than the job list's text.
    assert(log.includes("TRACE-MARKER-8001"), `failed-job trace returned (${JSON_(log)})`);
    assert(
      exec.calls.some((c) => c.includes("/jobs/8001/trace")),
      `only the FAILED job's trace is read (${exec.calls.join(" | ")})`,
    );
    assert(
      !exec.calls.some((c) => c.includes("/jobs/8002/trace")),
      "the successful job's trace is not read",
    );
  });
  await check("labels and repo settings on GitLab", async () => {
    const exec = mkExec({
      "glab label list": { stdout: JSON_([{ name: "bug" }]) },
      "/projects/:id --output json": { stdout: JSON_(GL_PROJECT) },
    });
    assert((await read(GL_DET, exec, { verb: "label_list" })).includes("bug"), "labels returned");
    assert(
      (await read(GL_DET, exec, { verb: "repo_settings" })).includes("main"),
      "project settings returned",
    );
  });

  // ── 4. Refusals: no write verb, and nothing runs when refused ───────────
  console.log("refusals:");
  await check("a call naming a write operation is refused and runs no command", async () => {
    for (const verb of ["pr_merge", "issue_create", "pr_comment", "issue_close", "label_add"]) {
      const exec = mkExec({ "": { stdout: "SHOULD NOT RUN" } });
      let reason = "";
      try {
        await read(GH_DET, exec, { verb, number: 17 });
      } catch (err) {
        reason = (err as Error).message;
      }
      assert(/is a write/.test(reason), `"${verb}" refused as a write (${reason})`);
      assert(
        /reads: issue_view, issue_comments/.test(reason),
        `"${verb}" refusal names the read verbs`,
      );
      assert(exec.calls.length === 0, `"${verb}" ran no forge command`);
    }
  });
  await check("an unknown verb is refused with the read list", () => {
    const reason = validateForgeRead({ verb: "frobnicate" });
    assert(/unknown verb/.test(reason ?? "") && /repo_settings/.test(reason ?? ""), `got ${reason}`);
  });
  await check("a read verb missing its target is refused", () => {
    assert(/positive integer/.test(validateForgeRead({ verb: "pr_view" }) ?? ""), "pr_view needs a number");
    assert(/positive integer/.test(validateForgeRead({ verb: "ci_run_log" }) ?? ""), "ci_run_log needs an id");
    assert(/non-empty/.test(validateForgeRead({ verb: "issue_search" }) ?? ""), "issue_search needs a query");
    assert(validateForgeRead({ verb: "repo_settings" }) === undefined, "repo_settings needs no target");
  });
  await check("a verb name that is a READ is never refused as a write", () => {
    for (const verb of FORGE_READ_VERBS) {
      const r = validateForgeRead({ verb, number: 1, id: 1, query: "q" });
      assert(r === undefined, `${verb} validates (${r})`);
    }
  });
  // The child-supplied `state`/`sourceBranch` ride straight into the parent's
  // credentialed `gh`/`glab` command string; only `shq` quoting sits between
  // them and the shell. They are validated at the parse boundary, the way the
  // numeric targets are, so nothing but a known state or a plain branch name
  // is ever forwarded.
  await check("a state outside the accepted set is refused and runs no command", async () => {
    for (const state of ["x'$(touch /tmp/pwned)", "open; id", "OPEN", "OPEN ", "--state"] as const) {
      const reason = validateForgeRead({ verb: "pr_list", state });
      assert(
        /state/.test(reason ?? ""),
        `state ${JSON.stringify(state)} refused by name (${reason})`,
      );
    }
    for (const state of ["open", "closed", "merged", "all"]) {
      assert(
        validateForgeRead({ verb: "pr_list", state }) === undefined,
        `state "${state}" is accepted`,
      );
    }
    const exec = mkExec({ "": { stdout: "SHOULD NOT RUN" } });
    let reason = "";
    try {
      await read(GH_DET, exec, { verb: "issue_list", state: "x'$(touch /tmp/pwned)" });
    } catch (err) {
      reason = (err as Error).message;
    }
    assert(/state/.test(reason), `the bad state is refused by name (${reason})`);
    assert(exec.calls.length === 0, `a bad state ran no forge command (${exec.calls.join(" | ")})`);
  });
  await check("a sourceBranch that is not a plain branch name is refused", async () => {
    for (const sourceBranch of ["--upload-pack=x", "-x", "feat; rm -rf /", "a b", "feat'$(id)"]) {
      const reason = validateForgeRead({ verb: "pr_list", number: 1, sourceBranch });
      assert(
        /sourceBranch|branch/.test(reason ?? ""),
        `sourceBranch ${JSON.stringify(sourceBranch)} refused by name (${reason})`,
      );
    }
    for (const sourceBranch of ["feature/issue-2160-finish", "v1.2.3-rc_1", "a.b_c/d-e"]) {
      assert(
        validateForgeRead({ verb: "pr_list", sourceBranch }) === undefined,
        `sourceBranch "${sourceBranch}" is accepted`,
      );
    }
    const exec = mkExec({ "": { stdout: "SHOULD NOT RUN" } });
    let reason = "";
    try {
      await read(GH_DET, exec, { verb: "pr_list", number: 1, sourceBranch: "--upload-pack=x" });
    } catch (err) {
      reason = (err as Error).message;
    }
    assert(
      /sourceBranch|branch/.test(reason),
      `the bad sourceBranch is refused by name (${reason})`,
    );
    assert(exec.calls.length === 0, `a bad sourceBranch ran no forge command (${exec.calls.join(" | ")})`);
  });

  // The search string is the one child-supplied field with no grammar at all:
  // every other filter is a number, a state or a branch name. It rides into the
  // parent's credentialed `gh`/`glab` string like the rest, so it is bounded
  // here — a bounded search is still a search, and an unbounded one is a child
  // choosing how much work the parent's credential does on its behalf.
  await check("a query is bounded to a search, not a slurp", async () => {
    const short = validateForgeRead({ verb: "issue_search", query: "widget" });
    assert(short === undefined, `a plain query validates (${short})`);
    const atCap = validateForgeRead({ verb: "issue_search", query: "x".repeat(512) });
    assert(atCap === undefined, `the cap itself is accepted (${atCap})`);
    for (const query of ["", " ".repeat(3), "x".repeat(513), "x".repeat(9000)]) {
      const reason = validateForgeRead({ verb: "issue_search", query });
      assert(
        /query/.test(reason ?? ""),
        `query of ${query.length} chars refused by name (${reason})`,
      );
    }
    const exec = mkExec({ "": { stdout: "SHOULD NOT RUN" } });
    let reason = "";
    try {
      await read(GH_DET, exec, { verb: "issue_search", query: "x".repeat(9000) });
    } catch (err) {
      reason = (err as Error).message;
    }
    assert(/query/.test(reason), `the oversized query is refused by name (${reason.slice(0, 60)})`);
    assert(exec.calls.length === 0, `an oversized query ran no forge command (${exec.calls.join(" | ")})`);
  });

  // ── 5. The parent serves it; the child holds no credential ──────────────
  console.log("shape:");
  await check("detectForge resolves the forge the parent reads", async () => {
    const exec = mkExec({
      "git config --get remote.origin.url": {
        stdout: "https://github.com/acme/widget.git\n",
      },
    });
    const det = await detectForge("/repo", {
      execFn: async (cmd, o) =>
        exec.fn(cmd, o as Parameters<typeof exec.fn>[1]) as never,
      env: {},
      probeEnv: { PI_ENSEMBLE_FORGE_PROBE: "0" },
    });
    assert(det.forge === "github", `detected ${det.forge} (${exec.calls.join(" | ")})`);
  });

  await forgeExitCode("all forge_read reads answered, writes refused");
}

await main();
