#!/usr/bin/env bun
/**
 * handoff-body-routes-through-the-seam (#1820 lens round 1, M2) — the handoff
 * comment's public/private decision has ONE owner: the driver publish seam.
 *
 * ## The defect this file pins
 *
 * `work-driver-handoff-body.ts` re-implemented the public-only rule: it called
 * `isPrivateTarget` directly, with whatever resolver the caller happened to pass
 * and no visibility resolver of its own. The consequence is the one the seam
 * exists to prevent — a driver handoff on a POSITIVELY PRIVATE repository got
 * folded like a public one, because with no resolver the question could not be
 * answered and the code fell through to the rewrite. Every other driver publish
 * asks the seam, which resolves the target, asks `gh` when the caller supplied no
 * resolver, and skips the fold on a positive private answer.
 *
 * ## What each block proves
 *
 * 1. **Private keeps exact paths**: a `visibility` that answers "private" leaves
 *    the host's transcript path byte-for-byte in the body and adds no note.
 * 2. **Public folds**: the same state, an executor that answers "not private",
 *    yields `~/…` and no host home, and the fold is the seam's own output.
 * 3. **The marker survives the fold**: the `<!-- pi-rukas: … -->` span is
 *    byte-identical, because a host parses it to find and extend the comment.
 * 4. **A refusal posts nothing**: text the matcher refuses returns a refusal, the
 *    reason carries the matcher's category and never the term, and the delivery
 *    leg posts no comment and claims no URL.
 * 5. **No resolver is no excuse**: with an executor whose `gh` call blows up, the
 *    body is still folded — a lookup that failed means "check", never "publish
 *    the host path".
 *
 * Offline: recording executors only; no real home path is published anywhere.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Forge } from "../src/forge.ts";
import { resetDenylistCacheForTests } from "../src/public-denylist.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import { handoffCommentBody } from "../src/work-driver-handoff-body.ts";
import { deliverHandoff } from "../src/work-driver-handoff-deliver.ts";
import { withEnv } from "./lib/env-scope.ts";
import { makeFixture, mkForge, stateWith } from "./lib/handoff-publish-fixture.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const root = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "handoff-seam-"));
const fx = makeFixture(root);
writeFileSync(fx.denylist, `# synthetic\n${fx.term}\n`, "utf8");

const FORGE = {
  forge: "github",
  host: "github.com",
  owner: "example-owner",
  repo: "example-repo",
} as unknown as Forge;

/** An executor answering the seam's `gh api` visibility read and its git reads. */
function seamExec(privateAnswer: boolean | "throws") {
  const calls: string[] = [];
  const fn = async (cmd: string, opts?: { argv?: string[] }) => {
    const argv = opts?.argv ?? [];
    calls.push([cmd, ...argv].join(" "));
    if (argv[0] === "api") {
      if (privateAnswer === "throws") throw new Error("gh unreachable");
      return { stdout: `${privateAnswer}\n` };
    }
    if (argv[0] === "remote" && argv[1] === "get-url") {
      return { stdout: "https://github.com/example-owner/example-repo.git\n" };
    }
    return { stdout: "" };
  };
  return { fn: fn as never, calls };
}

await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: fx.denylist }, async () => {
  resetDenylistCacheForTests();
  resetVisibilityCacheForTests();

  const ctx = { repoRoot: fx.repo };
  const state = stateWith(fx);

  // ── 1. a positively PRIVATE repository keeps its exact paths ──────────────
  const priv = seamExec(true);
  const privateCheck = await handoffCommentBody(state, ctx, FORGE, async () => true, priv.fn);
  assert(privateCheck.refusal === undefined, "a private handoff is not refused");
  const privateBody = privateCheck.body ?? "";
  assert(
    privateBody.includes(fx.transcript),
    "a private repository's handoff keeps the real transcript path — the fold was the bug",
  );
  assert(
    !privateBody.includes("relative to `~`"),
    "…and carries no note about placeholders it never used",
  );
  assert(
    privateBody.includes("<!-- pi-rukas:handoff"),
    "…and the marker is present for the private case too",
  );

  // ── 2 + 3. a PUBLIC target folds, and the marker is untouched ─────────────
  resetVisibilityCacheForTests();
  const pub = seamExec(false);
  const publicCheck = await handoffCommentBody(state, ctx, FORGE, undefined, pub.fn);
  assert(
    publicCheck.refusal === undefined,
    `a clean public body is not refused (${publicCheck.refusal})`,
  );
  const publicBody = publicCheck.body ?? "";
  assert(publicBody.includes("~/"), "a public handoff folds the host home to `~`");
  assert(!publicBody.includes(fx.transcript), "…and the host transcript path is gone");
  assert(
    publicBody.includes("<repo>/"),
    "…and a worktree path under the repository folds to `<repo>`",
  );
  const markerLine = publicBody.split("\n").find((l) => l.startsWith("<!-- pi-rukas:"));
  const markerLineFromPrivate = privateBody.split("\n").find((l) => l.startsWith("<!-- pi-rukas:"));
  assert(
    markerLine !== undefined && markerLine === markerLineFromPrivate,
    `the pi-rukas marker is byte-identical folded or not (folded: ${JSON.stringify(markerLine)})`,
  );
  assert(
    pub.calls.some((c) => c.startsWith("gh ") || c.includes("api")),
    "the seam asked the visibility question itself — the caller passed no resolver",
  );

  // ── 4. a REFUSED body posts nothing and names no term ────────────────────
  resetVisibilityCacheForTests();
  const dirty = stateWith(fx);
  dirty.eventLog = [
    ...(dirty.eventLog ?? []),
    {
      kind: "dispatch-completed",
      at: 3,
      step: "develop",
      role: "developer",
      jobId: "j2",
      label: `the build failed on ${fx.term}`,
      ms: 1_000,
      transcriptPath: fx.transcript,
    },
  ];
  const refused = await handoffCommentBody(dirty, ctx, FORGE, undefined, seamExec(false).fn);
  assert(refused.refusal !== undefined, "a body carrying a denylist term is refused");
  assert(
    refused.refusal !== undefined && !refused.refusal.includes(fx.term),
    `the refusal names the matcher's category, never the term (got ${JSON.stringify(refused.refusal?.slice(0, 160))})`,
  );

  // The delivery leg honours the refusal: an empty body posts nothing, claims no
  // URL, and the body file on disk is never used as a source.
  const forge = mkForge([]);
  const delivered = await deliverHandoff({
    issue: 9,
    prNumber: undefined,
    forge: forge.forge,
    body: "",
    commentUrl: undefined,
    labelApplied: false,
    dispatchFailed: false,
  });
  assert(
    forge.posted.length === 0 && delivered.commentUrl === undefined,
    "a refused handoff posts no comment and claims no comment URL",
  );

  // ── 5. a visibility lookup that FAILS still folds (fail-closed) ───────────
  resetVisibilityCacheForTests();
  const broken = await handoffCommentBody(state, ctx, FORGE, undefined, seamExec("throws").fn);
  assert(
    broken.body !== undefined && !broken.body.includes(fx.transcript),
    "an unreadable visibility answer folds the paths — never publishes the host path",
  );
});

rmSync(root, { recursive: true, force: true });
process.exit(exit);
