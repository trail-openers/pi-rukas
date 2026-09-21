// test-forge-comments.ts — #775 forge comment seams (offline smoke test).
//
// Covers the comment-list + PR-comment seams added to the forge adapter:
//   - issueComments (the idempotency check before re-posting a handoff)
//   - prComments (the PR-targeted handoff fallback's read seam)
//   - prComment (the PR-targeted handoff fallback's post seam)
//
// Command-string invariants: single unchained commands only (the #408
// recovery-command rule — the in-process handoff fallback runs these in-process
// in the driver, not through the permission layer, but the unchained shape
// is pinned here so a regression that routes the fallback through a chained
// command shape fails the gate).
//
// Runtime: mocked exec (no network).

import { createForge, forgeCommands } from "../src/forge.ts";
import { ghDetection, glDetection, mkExec } from "./forge-fixtures.ts";

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
  const ghDet = ghDetection(owner, repo);
  const glDet = glDetection(owner, repo);

  // ── Command-string invariants (the test seam) ──────────────────────────
  console.log("command strings:");
  await check("issueCommentsCmd is a single unchained gh issue view --json comments read", () => {
    const cmd = forgeCommands.issueCommentsCmd("github", 42);
    assert(cmd === "gh issue view 42 --json comments", `got ${cmd}`);
    assert(!/[&&;|]/.test(cmd), `unchained invariant: ${cmd}`);
  });
  await check("prCommentsCmd is a single unchained gh pr view --json comments read", () => {
    const cmd = forgeCommands.prCommentsCmd("github", 17);
    assert(cmd === "gh pr view 17 --json comments", `got ${cmd}`);
    assert(!/[&&;|]/.test(cmd), `unchained invariant: ${cmd}`);
  });
  await check("prCommentCmd uses gh pr comment --body-file (unchained)", () => {
    const cmd = forgeCommands.prCommentCmd("github", 17, "/tmp/b");
    assert(cmd === "gh pr comment 17 --body-file /tmp/b", `got ${cmd}`);
    assert(!/[&&;|]/.test(cmd), `unchained invariant: ${cmd}`);
  });
  await check("issueCommentsCmd (gitlab) is a single unchained glab api notes read", () => {
    const cmd = forgeCommands.issueCommentsCmd("gitlab", 42);
    assert(cmd.includes("/projects/:id/issues/42/notes"), `got ${cmd}`);
    assert(!/[&&;|]/.test(cmd), `unchained invariant: ${cmd}`);
  });
  await check("prCommentsCmd (gitlab) is a single unchained glab api notes read", () => {
    const cmd = forgeCommands.prCommentsCmd("gitlab", 17);
    assert(cmd.includes("/projects/:id/merge_requests/17/notes"), `got ${cmd}`);
    assert(!/[&&;|]/.test(cmd), `unchained invariant: ${cmd}`);
  });
  await check("prCommentCmd (gitlab) uses glab api POST to the MR notes endpoint", () => {
    const cmd = forgeCommands.prCommentCmd("gitlab", 17, "/tmp/b");
    assert(cmd.includes("--method POST"), `got ${cmd}`);
    assert(cmd.includes("/projects/:id/merge_requests/17/notes"), `got ${cmd}`);
    assert(!/[&&;|]/.test(cmd), `unchained invariant: ${cmd}`);
  });

  // ── GitHub runtime ──────────────────────────────────────────────────────
  console.log("github runtime:");
  const rows = [
    {
      id: 1001,
      body: "the handoff body",
      html_url: "https://github.com/acme/widget/issues/42#issuecomment-1001",
      created_at: "2026-09-21T00:00:00Z",
    },
  ];
  {
    const { fn } = mkExec({
      "gh issue view 42 --json comments": { stdout: JSON.stringify({ comments: rows }) },
      "gh pr view 17 --json comments": { stdout: JSON.stringify({ comments: rows }) },
      "gh pr comment 17": { stdout: "https://github.com/acme/widget/pull/17#issuecomment-2002" },
    });
    const forge = createForge(ghDet, { execFn: fn });
    await check(
      "issueComments maps html_url into url + preserves body (idempotency seam)",
      async () => {
        const comments = await forge.issueComments(42);
        assert(comments.length === 1, `len ${comments.length}`);
        const first = comments[0];
        assert(first !== undefined, "at least one comment");
        assert(first.body === "the handoff body", `body ${first.body}`);
        assert(
          first.url === "https://github.com/acme/widget/issues/42#issuecomment-1001",
          `url ${first.url}`,
        );
      },
    );
    await check(
      "prComments lists the PR's review comments (the PR handoff fallback's read seam)",
      async () => {
        const comments = await forge.prComments(17);
        assert(comments.length === 1, `len ${comments.length}`);
        assert(comments[0]?.id === 1001, `id ${comments[0]?.id}`);
      },
    );
    await check("prComment posts via gh pr comment and returns the canonical URL", async () => {
      const url = await forge.prComment(17, "the handoff body");
      assert(url === "https://github.com/acme/widget/pull/17#issuecomment-2002", `got ${url}`);
    });
  }
  // Empty comment list (no existing handoff comment → the fallback posts).
  {
    const { fn } = mkExec({
      "gh issue view 42 --json comments": { stdout: JSON.stringify({ comments: [] }) },
    });
    const forge = createForge(ghDet, { execFn: fn });
    await check("issueComments returns an empty array when the issue has no comments", async () => {
      const comments = await forge.issueComments(42);
      assert(comments.length === 0, `len ${comments.length}`);
    });
  }

  // ── GitLab runtime ──────────────────────────────────────────────────────
  console.log("gitlab runtime:");
  {
    const notes = [
      {
        id: 2001,
        body: "the handoff body",
        web_url: "https://gitlab.com/acme/widget/-/issues/42#note_2001",
        created_at: "2026-09-21T00:00:00Z",
      },
    ];
    const { fn } = mkExec({
      'glab api "/projects/:id/issues/42/notes"': { stdout: JSON.stringify(notes) },
      'glab api "/projects/:id/merge_requests/17/notes"': { stdout: JSON.stringify(notes) },
      "glab api --method POST": {
        stdout: JSON.stringify({
          id: 2002,
          body: "the handoff body",
          web_url: "https://gitlab.com/acme/widget/-/merge_requests/17#note_2002",
        }),
      },
    });
    const forge = createForge(glDet, { execFn: fn });
    await check("gitlab issueComments maps web_url into url", async () => {
      const comments = await forge.issueComments(42);
      const first = comments[0];
      assert(comments.length === 1 && first !== undefined, `len ${comments.length}`);
      assert(first.body === "the handoff body", `body ${first.body}`);
      assert(
        first.url === "https://gitlab.com/acme/widget/-/issues/42#note_2001",
        `url ${first.url}`,
      );
    });
    await check("gitlab prComments lists the MR's notes", async () => {
      const comments = await forge.prComments(17);
      assert(comments.length === 1, `len ${comments.length}`);
      assert(comments[0]?.id === 2001, `id ${comments[0]?.id}`);
    });
    await check(
      "gitlab prComment posts via the MR notes endpoint and returns web_url",
      async () => {
        const url = await forge.prComment(17, "the handoff body");
        assert(
          url === "https://gitlab.com/acme/widget/-/merge_requests/17#note_2002",
          `got ${url}`,
        );
      },
    );
  }

  console.log("");
  if (exitCode !== 0) {
    console.error("FAILURES — see above");
    process.exit(1);
  }
  console.log("All forge-comments tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
