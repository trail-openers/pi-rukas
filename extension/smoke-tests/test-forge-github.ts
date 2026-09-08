/**
 * test-forge-github.ts — offline smoke test for the GitHub (gh) path of
 * the forge adapter (S2 of epic #608).
 *
 * Covers every operation for the GitHub forge with mocked `gh` CLI output:
 *   - field mapping (number, body, OPEN, headRefName, url — camelCase)
 *   - issue view/create/edit/comment/search
 *   - PR view/list/create/merge/diff/checks
 *   - CI watch + run
 *   - merge readiness (CLEAN/DIRTY/BLOCKED/UNKNOWN)
 *   - label ops
 *   - repo settings
 *   - command-string invariants (the test seam)
 *
 * Run: cd extension && bun run smoke-tests/test-forge-github.ts
 */

import { mapGhIssue, mapGhPr, mapGhRepo, mapGhRun } from "../src/forge-mapping.ts";
import { createForge, forgeCommands } from "../src/forge.ts";
import {
  GH_CHECKS,
  GH_ISSUE,
  GH_PR,
  GH_REPO,
  GH_RUN_DONE,
  ghDetection,
  mkExec,
} from "./forge-fixtures.ts";

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
  const owner = "acme";
  const repo = "widget";
  const det = ghDetection(owner, repo);

  // ── Command-string invariants (the test seam) ──────────────────────────
  console.log("command strings:");
  await check("issueViewCmd is gh issue view with --json", () => {
    const cmd = forgeCommands.issueViewCmd("github", 42);
    assert(cmd.startsWith("gh issue view 42"), `got ${cmd}`);
    assert(cmd.includes("--json number,title,body,state,url"), "missing --json fields");
  });
  await check("issueEditCmd uses --body-file", () => {
    const cmd = forgeCommands.issueEditCmd("github", 42, "/tmp/x/body.md");
    assert(cmd.includes("--body-file /tmp/x/body.md"), `got ${cmd}`);
  });
  await check("prMergeCmd uses --squash --delete-branch", () => {
    const cmd = forgeCommands.prMergeCmd("github", 17, "squash");
    assert(cmd === "gh pr merge 17 --squash --delete-branch", `got ${cmd}`);
  });
  await check("prCreateCmd uses --head", () => {
    const cmd = forgeCommands.prCreateCmd("github", "T", "branch", "/tmp/b", "main");
    assert(cmd.includes("--head main...branch"), `got ${cmd}`);
  });
  await check("labelCreateCmd uses gh label create --force", () => {
    const cmd = forgeCommands.labelCreateCmd("github", "needs-human-attention", "FFAA00");
    assert(cmd === "gh label create needs-human-attention --color FFAA00 --force", `got ${cmd}`);
  });
  await check("labelAddCmd/labelRemoveCmd use --add-label/--remove-label on edit", () => {
    const add = forgeCommands.labelAddCmd("github", "issue", 42, "needs-human-attention");
    assert(add === "gh issue edit 42 --add-label needs-human-attention", `got ${add}`);
    const rm = forgeCommands.labelRemoveCmd("github", "issue", 42, "needs-human-attention");
    assert(rm === "gh issue edit 42 --remove-label needs-human-attention", `got ${rm}`);
  });

  // ── Create commands must NOT carry --json (gh create has no --json flag) ─
  // gh issue create and gh pr create print the created object's URL as plain
  // text. Appending --json makes gh exit non-zero — the dual-forge S4
  // migration pattern-matched the create commands against the read commands
  // and broke every issue filing on GitHub since that merge.
  console.log("create commands (no --json) and canaries (with --json):");
  await check("issueCreateCmd('github', …) does NOT contain --json", () => {
    const cmd = forgeCommands.issueCreateCmd("github", "T", "/tmp/b");
    assert(cmd.startsWith("gh issue create"), `got ${cmd}`);
    assert(!cmd.includes("--json"), `must not carry --json: ${cmd}`);
  });
  await check("prCreateCmd('github', …) does NOT contain --json", () => {
    const cmd = forgeCommands.prCreateCmd("github", "T", "branch", "/tmp/b", "main");
    assert(cmd.startsWith("gh pr create"), `got ${cmd}`);
    assert(!cmd.includes("--json"), `must not carry --json: ${cmd}`);
  });
  // Canary — these READ commands DO carry --json (proves the fix is not
  // over-applied to the whole forge-commands module). A regression in any of
  // them means the create-command fix accidentally stripped --json from a read.
  for (const [label, cmd] of [
    ["issueViewCmd", forgeCommands.issueViewCmd("github", 42)],
    ["issueSearchCmd", forgeCommands.issueSearchCmd("github", "bug")],
    ["prViewCmd", forgeCommands.prViewCmd("github", 17)],
    ["prListCmd", forgeCommands.prListCmd("github")],
    ["prChecksCmd", forgeCommands.prChecksCmd("github", 17)],
    ["repoSettingsCmd", forgeCommands.repoSettingsCmd("github")],
  ] as const) {
    await check(`canary: ${label}('github', …) STILL contains --json`, () => {
      assert(cmd.includes("--json"), `regressed: ${cmd}`);
    });
  }

  // gh issue create prints the created URL as a plain line on stdout; the
  // adapter must map that line into a NormalizedIssue, deriving `number` from
  // the trailing path segment. A mapper that expects JSON here is a bug.
  console.log("create plain-text URL mapping:");
  {
    const { fn } = mkExec({
      "gh issue create": { stdout: "https://github.com/acme/widget/issues/42\n" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueCreate maps a plain-text URL stdout (number 42, full url)", async () => {
      const issue = await forge.issueCreate("A new issue", "the body");
      assert(issue.number === 42, `expected 42, got ${issue.number}`);
      assert(issue.url === "https://github.com/acme/widget/issues/42", `url: ${issue.url}`);
    });
  }
  {
    const { fn } = mkExec({
      "gh issue create": { stdout: "\n  https://github.com/acme/widget/issues/99\n  \n" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueCreate tolerates surrounding whitespace/blank lines", async () => {
      const issue = await forge.issueCreate("A new issue", "the body");
      assert(issue.number === 99, `expected 99, got ${issue.number}`);
      assert(issue.url === "https://github.com/acme/widget/issues/99", `url: ${issue.url}`);
    });
  }
  {
    const { fn } = mkExec({
      "gh pr create": { stdout: "https://github.com/acme/widget/pull/17\n" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prCreate maps a plain-text URL stdout (number 17, full url)", async () => {
      const pr = await forge.prCreate("A PR", "feature/issue-17-x", "the PR body", "main");
      assert(pr.number === 17, `expected 17, got ${pr.number}`);
      assert(pr.url === "https://github.com/acme/widget/pull/17", `url: ${pr.url}`);
    });
  }
  {
    const { fn } = mkExec({
      "gh pr create": { stdout: "\n\nhttps://github.com/acme/widget/pull/77\t\n" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prCreate tolerates surrounding whitespace and trailing tab", async () => {
      const pr = await forge.prCreate("A PR", "feature/issue-17-x", "the PR body", "main");
      assert(pr.number === 77, `expected 77, got ${pr.number}`);
      assert(pr.url === "https://github.com/acme/widget/pull/77", `url: ${pr.url}`);
    });
  }
  // Non-URL, non-JSON stdout (an error string that somehow reached the
  // mapper) must reject — NOT silently map to number 0.
  async function rejectsOnNonUrl(forge: ReturnType<typeof createForge>, label: string) {
    let threw = false;
    let got: unknown = undefined;
    try {
      await (label === "issue"
        ? forge.issueCreate("A new issue", "the body")
        : forge.prCreate("A PR", "feature/issue-17-x", "the PR body", "main"));
    } catch {
      threw = true;
    }
    assert(threw, `expected rejection, got: ${JSON.stringify(got)}`);
    if (!threw && got && typeof got === "object" && "number" in got) {
      assert((got as { number: number }).number !== 0, "must not map to number 0");
    }
  }
  {
    const { fn } = mkExec({
      "gh issue create": { stdout: "HTTP Error 401: bad credentials\n" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueCreate rejects (no silent number=0) when stdout is not a URL", async () =>
      rejectsOnNonUrl(forge, "issue"),
    );
  }
  {
    const { fn } = mkExec({
      "gh pr create": { stdout: "HTTP Error 403: permission denied\n" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prCreate rejects (no silent number=0) when stdout is not a URL", async () =>
      rejectsOnNonUrl(forge, "pr"),
    );
  }

  // ── Issue operations ────────────────────────────────────────────────────
  console.log("issues:");
  {
    const { fn, calls } = mkExec({
      "gh issue view 42": { stdout: JSON.stringify(GH_ISSUE) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueView normalizes camelCase fields", async () => {
      const issue = await forge.issueView(42);
      assert(issue.number === 42, `number ${issue.number}`);
      assert(issue.body === "the issue body", `body ${issue.body}`);
      assert(issue.state === "OPEN", `state ${issue.state}`);
      assert(issue.url === "https://github.com/acme/widget/issues/42", `url ${issue.url}`);
      assert(issue.labels.length === 1 && issue.labels[0].name === "bug", "labels");
      assert(issue.author === "janni", `author ${issue.author}`);
      assert(calls.length === 1 && calls[0]!.includes("--json"), "cmd shape");
    });
  }

  // ── Issue create (temp file body) ──────────────────────────────────────
  {
    const { fn, calls } = mkExec({
      "gh issue create": { stdout: JSON.stringify(GH_ISSUE) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueCreate passes --title and --body-file (temp path)", async () => {
      const issue = await forge.issueCreate("A new issue", "the body");
      assert(issue.number === 42, "round-tripped");
      const cmd = calls.find((c) => c.includes("gh issue create"));
      assert(cmd !== undefined, `no create cmd: ${calls}`);
      assert(cmd!.includes("--title "), `--title: ${cmd}`);
      assert(cmd!.includes("A new issue"), `--title value: ${cmd}`);
      const file = cmd!.replace(/.*--body-file\s+/, "");
      assert(file.startsWith("/"), `not a temp path: ${file}`);
      assert(!file.includes("the body"), "body must not be inlined in the command");
    });
  }

  // ── Issue edit (temp file body) ─────────────────────────────────────────
  {
    const { fn, calls } = mkExec({
      "gh issue edit 42": { stdout: JSON.stringify(GH_ISSUE) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueEdit writes body to a temp file", async () => {
      const issue = await forge.issueEdit(42, "edited body");
      assert(issue.number === 42, "round-tripped");
      const cmd = calls.find((c) => c.includes("gh issue edit"));
      assert(cmd !== undefined, "no edit command");
      assert(cmd!.includes("--body-file "), `missing --body-file: ${cmd}`);
      const file = cmd!.replace(/.*--body-file\s+/, "");
      assert(file.startsWith("/"), `not a path: ${file}`);
    });
  }

  // ── Issue comment ───────────────────────────────────────────────────────
  {
    const { fn } = mkExec({
      "gh issue comment 42": { stdout: "https://github.com/acme/widget/issues/42#issuecomment-1" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueComment returns the URL", async () => {
      const url = await forge.issueComment(42, "a comment");
      assert(url.includes("issuecomment-1"), `got ${url}`);
    });
  }

  // ── Issue search ────────────────────────────────────────────────────────
  {
    const { fn } = mkExec({
      "gh issue list --search": { stdout: JSON.stringify([GH_ISSUE, { ...GH_ISSUE, number: 43 }]) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("issueSearch returns an array", async () => {
      const issues = await forge.issueSearch("bug");
      assert(issues.length === 2, `len ${issues.length}`);
      assert(issues[0]!.number === 42, "first");
      assert(issues[1]!.number === 43, "second");
    });
  }

  // ── PR operations ───────────────────────────────────────────────────────
  console.log("pull requests:");
  {
    const { fn } = mkExec({
      "gh pr view 17": { stdout: JSON.stringify(GH_PR) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prView normalizes headRefName", async () => {
      const pr = await forge.prView(17);
      assert(pr.number === 17, "number");
      assert(pr.headRefName === "feature/issue-17-x", `head ${pr.headRefName}`);
      assert(pr.baseRefName === "main", `base ${pr.baseRefName}`);
      assert(pr.mergeable === "TRUE", `mergeable ${pr.mergeable}`);
      assert(pr.mergeStateStatus === "CLEAN", `status ${pr.mergeStateStatus}`);
    });
  }

  {
    const { fn } = mkExec({
      "gh pr list": { stdout: JSON.stringify([GH_PR]) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prList with sourceBranch uses --head", async () => {
      const prs = await forge.prList({ sourceBranch: "feature/issue-17-x" });
      assert(prs.length === 1, "len");
    });
  }

  {
    const { fn } = mkExec({
      "gh pr diff 17": { stdout: "diff --git a/foo b/foo" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prDiff returns the diff text", async () => {
      const diff = await forge.prDiff(17);
      assert(diff.includes("diff --git"), `got ${diff}`);
    });
  }

  {
    const { fn, calls } = mkExec({
      "gh pr merge 17": { stdout: "Merged #17" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prMerge uses --squash --delete-branch", async () => {
      const out = await forge.prMerge(17);
      assert(out.includes("Merged"), `got ${out}`);
      const cmd = calls.find((c) => c.includes("gh pr merge"));
      assert(cmd !== undefined, "no merge cmd");
      assert(cmd!.includes("--squash"), `no --squash: ${cmd}`);
      assert(cmd!.includes("--delete-branch"), `no --delete-branch: ${cmd}`);
    });
  }

  // ── PR create (temp file body) ──────────────────────────────────────────
  {
    const { fn, calls } = mkExec({
      "gh pr create": { stdout: JSON.stringify(GH_PR) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prCreate passes --head base...branch and --body-file", async () => {
      const pr = await forge.prCreate("A PR", "feature/issue-17-x", "the PR body", "main");
      assert(pr.number === 17, "round-tripped");
      const cmd = calls.find((c) => c.includes("gh pr create"));
      assert(cmd !== undefined, `no create cmd: ${calls}`);
      assert(cmd!.includes("--head main...feature/issue-17-x"), `--head: ${cmd}`);
      const file = cmd!.replace(/.*--body-file\s+/, "");
      assert(file.startsWith("/"), `not a temp path: ${file}`);
    });
  }

  // ── PR checks ───────────────────────────────────────────────────────────
  {
    const { fn } = mkExec({
      "gh pr checks 17": { stdout: JSON.stringify(GH_CHECKS) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("prChecks normalizes rows", async () => {
      const checks = await forge.prChecks(17);
      assert(checks.length === 2, `len ${checks.length}`);
      assert(checks[0]!.name === "ci", "first name");
      assert(checks[0]!.state === "PASS", `state ${checks[0]!.state}`);
      assert(checks[0]!.isRequired === true, "required");
    });
  }

  // CI watch + CI run are covered by smoke-tests/test-forge-ci-watch.ts

  // Merge readiness (GitHub) is covered by test-forge-merge-readiness.ts

  // ── Labels ──────────────────────────────────────────────────────────────
  console.log("labels:");
  {
    const { fn, calls } = mkExec({
      "gh label create": { stdout: JSON.stringify({ name: "new-label", id: 5, color: "00ff00" }) },
      "gh issue edit 42 --add-label": { stdout: "" },
      "gh issue edit 42 --remove-label": { stdout: "" },
    });
    const forge = createForge(det, { execFn: fn });
    await check("labelCreate returns the label and uses --force (idempotent)", async () => {
      const label = await forge.labelCreate("new-label", "00ff00");
      assert(label!.name === "new-label", `name ${label!.name}`);
      assert(label!.id === 5, `id ${label!.id}`);
      const cmd = calls.find((c) => c.includes("gh label create"));
      assert(cmd?.includes("--force"), `idempotency: ${cmd}`);
    });
    await check("labelAdd uses --add-label", async () => {
      await forge.labelAdd("issue", 42, "bug");
      assert(calls.some((c) => c.includes("--add-label")), "no add-label cmd");
    });
    await check("labelRemove uses --remove-label", async () => {
      await forge.labelRemove("issue", 42, "bug");
      assert(calls.some((c) => c.includes("--remove-label")), "no remove-label cmd");
    });
  }

  // ── Attention-gate label lifecycle (needs-human-attention) ──────────────
  // Mirrors work-driver-handoff.ts: create-if-missing (error swallowed) →
  // add to the target → read back via issueView. Same lifecycle for PRs.
  console.log("attention-gate label lifecycle:");
  {
    const { fn, calls } = mkExec({
      "gh label create": { stdout: "{}" },
      "gh issue edit 42 --add-label": { stdout: "" },
      "gh mr edit 17 --add-label": { stdout: "" },
      "gh issue view 42": {
        stdout: JSON.stringify({ ...GH_ISSUE, labels: [{ name: "needs-human-attention" }] }),
      },
    });
    const forge = createForge(det, { execFn: fn });
    // 1. Create-if-missing (the handoff swallows "already exists").
    await forge.labelCreate("needs-human-attention", "FFAA00");
    // 2. Add to both the issue (attention-gate target) and the PR.
    await forge.labelAdd("issue", 42, "needs-human-attention");
    await forge.labelAdd("mr", 17, "needs-human-attention");
    await check("create-if-missing, add to issue AND mr, read back on issue", async () => {
      assert(calls.some((c) => c.includes("gh label create") && c.includes("--force")), `create: ${calls}`);
      assert(calls.some((c) => c.includes("gh issue edit 42 --add-label")), `issue add: ${calls}`);
      assert(calls.some((c) => c.includes("gh mr edit 17 --add-label")), `mr add: ${calls}`);
      // 3. Read back — the attention gate (work-driver-attention.ts) reads
      //    the issue's labels to decide refuse/proceed.
      const names = (await forge.issueView(42)).labels.map((l) => l.name);
      assert(names.includes("needs-human-attention"), `labels: ${names}`);
    });
  }

  // ── Repo settings ───────────────────────────────────────────────────────
  console.log("repo settings:");
  {
    const { fn } = mkExec({
      "gh repo view": { stdout: JSON.stringify(GH_REPO) },
    });
    const forge = createForge(det, { execFn: fn });
    await check("repoSettings normalizes the three booleans", async () => {
      const repo = await forge.repoSettings();
      assert(repo.name === "acme/widget", `name ${repo.name}`);
      assert(repo.squashMergeAllowed === true, "squash");
      assert(repo.mergeCommitAllowed === true, "merge");
      assert(repo.rebaseMergeAllowed === false, "rebase");
      assert(repo.defaultBranch === "main", `default ${repo.defaultBranch}`);
    });
  }

  // ── Mappers (direct) ────────────────────────────────────────────────────
  console.log("mappers:");
  await check("mapGhIssue throws on missing number", () => {
    try {
      mapGhIssue({ title: "x", body: "y", state: "OPEN", url: "u" } as Record<string, unknown>);
      throw new Error("should have thrown");
    } catch (e) {
      assert((e as Error).message.includes("number"), `wrong error: ${(e as Error).message}`);
    }
  });
  await check("mapGhPr throws on missing state", () => {
    try {
      mapGhPr({ number: 1, title: "t", body: "b", url: "u" } as Record<string, unknown>);
      throw new Error("should have thrown");
    } catch (e) {
      assert((e as Error).message.includes("state"), `wrong error: ${(e as Error).message}`);
    }
  });
  await check("mapGhRun normalizes snake_case", () => {
    const run = mapGhRun(GH_RUN_DONE as Record<string, unknown>);
    assert(run.id === 901, "id");
    assert(run.status === "COMPLETED", "status");
    assert(run.conclusion === "SUCCESS", "conclusion");
  });
  await check("mapGhRepo normalizes", () => {
    const r = mapGhRepo(GH_REPO as Record<string, unknown>);
    assert(r.name === "acme/widget", "name");
    assert(r.owner === "acme", "owner");
  });

  console.log("");
  if (exitCode !== 0) {
    console.error("FAILURES — see above");
    process.exit(1);
  }
  console.log("All forge-github tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
