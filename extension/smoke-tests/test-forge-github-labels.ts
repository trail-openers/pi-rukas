/**
 * test-forge-github-labels.ts — the label half of the GitHub forge adapter.
 *
 * Split out of `test-forge-github.ts` (§12 file-size cap), which keeps every
 * other operation. The seam is real and not a line count: labels are the only
 * forge surface whose three operations mean something only in a particular
 * ORDER — create-if-missing with the error swallowed, add to the target, read
 * back through the view — and the attention-gate lifecycle below is what the
 * handoff path actually relies on. Kept verbatim from the original file:
 * swapping the order, or letting `labelCreate` throw on `already exists`, is a
 * real defect and this file is the only place it is pinned.
 *
 * Run: cd extension && bun run smoke-tests/test-forge-github-labels.ts
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
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

async function main() {
  const owner = "acme";
  const repo = "widget";
  const det = ghDetection(owner, repo);

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
      assert(
        calls.some((c) => c.includes("--add-label")),
        "no add-label cmd",
      );
    });
    await check("labelRemove uses --remove-label", async () => {
      await forge.labelRemove("issue", 42, "bug");
      assert(
        calls.some((c) => c.includes("--remove-label")),
        "no remove-label cmd",
      );
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
      "gh pr edit 17 --add-label": { stdout: "" },
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
      assert(
        calls.some((c) => c.includes("gh label create") && c.includes("--force")),
        `create: ${calls}`,
      );
      assert(
        calls.some((c) => c.includes("gh issue edit 42 --add-label")),
        `issue add: ${calls}`,
      );
      // #775 — GitHub has no `mr` subcommand; an mr target maps to `pr`.
      assert(
        calls.some((c) => c.includes("gh pr edit 17 --add-label")),
        `mr add maps to gh pr edit: ${calls}`,
      );
      // 3. Read back — the attention gate (work-driver-attention.ts) reads
      //    the issue's labels to decide refuse/proceed.
      const names = (await forge.issueView(42)).labels.map((l) => l.name);
      assert(names.includes("needs-human-attention"), `labels: ${names}`);
    });
  }

  forgeExitCode("All forge-github label tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
