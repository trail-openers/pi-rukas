// test-forge-gitlab-ci.ts — the GitLab (glab) CI-watch, label and repo-settings
// paths, offline smoke test. Split from test-forge-gitlab.ts at the 500-line
// seam (AGENTS.md §12); the command-shape and MR/issue reads stay there.

import { createForge } from "../src/forge.ts";
import { GL_ISSUE, GL_PIPELINE_DONE, GL_PIPELINE_RUNNING, GL_PROJECT, glDetection, mkExec } from "./forge-fixtures.ts";

let exitCode = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok: ${name}`))
    .catch((e) => {
      console.error(`  FAIL: ${name} — ${e?.message ?? e}`);
      exitCode = 1;
    });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const det = glDetection("acme", "widget");

  // ── CI watch (GitLab polling loop) ──────────────────────────────────────
  // Terminal statuses are success/failed/canceled/skipped/manual — verify a
  // non-`success` terminal is also recognized (the loop must not treat
  // `failed` as still-running).
  console.log("ci watch (GitLab):");
  {
    const { fn } = mkExec({
      "glab api /projects/:id/pipelines/901": { stdout: JSON.stringify(GL_PIPELINE_DONE) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("ciWatch returns terminal on first poll (status=success)", async () => {
      const result = await forge.ciWatch(901, { pollMs: 1, timeoutMs: 1000 });
      assert(result.ok && result.terminal && !result.timedOut, "terminal on first poll");
      assert(result.run?.status === "SUCCESS", `status ${result.run?.status}`);
      assert(result.run?.headBranch === "feature/issue-17-x", `ref ${result.run?.headBranch}`);
    });
  }
  {
    const failed = { ...GL_PIPELINE_DONE, status: "failed" };
    const { fn } = mkExec({
      "glab api /projects/:id/pipelines/901": { stdout: JSON.stringify(failed) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("ciWatch treats status=failed as terminal", async () => {
      const result = await forge.ciWatch(901, { pollMs: 1, timeoutMs: 1000 });
      assert(result.ok && result.terminal, "terminal");
      assert(result.run?.status === "FAILED", `status ${result.run?.status}`);
    });
  }
  {
    const { fn } = mkExec({
      "glab api /projects/:id/pipelines/901": { stdout: JSON.stringify(GL_PIPELINE_RUNNING) },
    });
    const forge = createForge(det, { execFn: fn });
    let nowMs = 0;
    await check("ciWatch polls with injected clock and times out", async () => {
      const result = await forge.ciWatch(901, {
        pollMs: 1000,
        timeoutMs: 2500,
        now: () => nowMs,
        sleep: async (ms: number) => {
          nowMs += ms;
        },
      });
      assert(result.ok && !result.terminal && result.timedOut, "timed out");
      assert(result.run?.status === "RUNNING", `status ${result.run?.status}`);
      assert(nowMs >= 2000, `clock advanced (got ${nowMs})`);
    });
  }

  // ── Labels ──────────────────────────────────────────────────────────────
  console.log("labels:");
  {
    const { fn, calls } = mkExec({
      "glab api -X POST": { stdout: JSON.stringify({ name: "new-label", color: "00ff00" }) },
      "glab api -X PUT": { stdout: "" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("labelCreate POSTs to /projects/:id/labels", async () => {
      const label = await forge.labelCreate("new-label", "00ff00");
      assert(label?.name === "new-label", `name ${label?.name}`);
      assert(calls.some((c) => c.includes("/projects/:id/labels")), `no POST labels: ${calls}`);
    });
    await check("labelAdd uses add_labels (auto-creates missing)", async () => {
      await forge.labelAdd("issue", 42, "new-label");
      assert(calls.some((c) => c.includes("add_labels=new-label")), `no add_labels: ${calls}`);
    });
    await check("labelRemove uses remove_labels", async () => {
      await forge.labelRemove("issue", 42, "old-label");
      assert(calls.some((c) => c.includes("remove_labels=old-label")), `no remove_labels: ${calls}`);
    });
  }

  // ── Attention-gate label lifecycle (needs-human-attention) ──────────────
  // Same lifecycle as the GitHub test: create (POST /labels) → add via
  // add_labels PUT → read back via issueView.
  console.log("attention-gate label lifecycle:");
  {
    const { fn, calls } = mkExec({
      "glab api -X POST": { stdout: "{}" },
      "glab api -X PUT": { stdout: "" },
      "glab issue view 42": {
        stdout: JSON.stringify({ ...GL_ISSUE, labels: [{ name: "needs-human-attention" }] }),
      },
    });
    const forge = createForge(det, { execFn: fn });
    // 1. Create via POST /projects/:id/labels.
    await forge.labelCreate("needs-human-attention", "FFAA00");
    // 2. Add to both the issue (attention-gate target) and the MR via PUT.
    await forge.labelAdd("issue", 42, "needs-human-attention");
    await forge.labelAdd("mr", 17, "needs-human-attention");
    await check("create, add to issue AND mr, read back on issue", async () => {
      assert(calls.some((c) => c.includes("-X POST") && c.includes("/projects/:id/labels")), `create: ${calls}`);
      assert(
        calls.some((c) => c.includes("add_labels=needs-human-attention") && c.includes("/issues/42")),
        `issue add: ${calls}`,
      );
      assert(
        calls.some(
          (c) => c.includes("add_labels=needs-human-attention") && c.includes("/merge_requests/17"),
        ),
        `mr add: ${calls}`,
      );
      // 3. Read back — the attention gate reads the issue's labels.
      const names = (await forge.issueView(42)).labels.map((l) => l.name);
      assert(names.includes("needs-human-attention"), `labels: ${names}`);
    });
  }

  // ── Repo settings ───────────────────────────────────────────────────────
  console.log("repo settings:");
  {
    const { fn } = mkExec({
      "glab api /projects/:id": { stdout: JSON.stringify(GL_PROJECT) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("repoSettings derives booleans from merge_method + squash_option", async () => {
      const repo = await forge.repoSettings();
      assert(repo.name === "acme/widget", `name ${repo.name}`);
      assert(repo.squashMergeAllowed === true, "squash");
      assert(repo.mergeCommitAllowed === false, "merge (method=squash)");
      assert(repo.rebaseMergeAllowed === false, "rebase (not on GL)");
      assert(repo.mergeMethod === "squash", `method ${repo.mergeMethod}`);
      assert(repo.squashOption === "squash_and_commit", `option ${repo.squashOption}`);
    });
  }

  // (direct mapper tests + parsePrNumberFromResponse shape/anchor cases
  //  live in test-forge-mapping-shapes.ts — split at the 500-line seam)

  console.log("");
  if (exitCode !== 0) {
    console.error("FAILURES — see above");
    process.exit(1);
  }
  console.log("All forge-gitlab-ci tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
