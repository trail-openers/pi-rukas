#!/usr/bin/env bun
/**
 * public-hygiene-normalise (the #1788 follow-up) — the driver's own publishes
 * show `~` and `<repo>` instead of this host's absolute paths, and the bytes it
 * posts are the bytes the matcher judged.
 *
 * ## What each block proves
 *
 * 1. **The rewrite itself**: a handoff-shaped body carrying a transcript path
 *    under the home directory, a worktree path and a verify-log path under the
 *    repository is published with `~`/`<repo>` and passes the generic rule; the
 *    bytes handed to the forge are byte-identical to the judged text.
 * 2. **Fail-closed after the rewrite**: a path under ANOTHER user's home, and a
 *    denylist term beside a home path, are both still refused — the rewrite is
 *    not an escape.
 * 3. **Order**: a repository root whose last segment looks like a private
 *    address is rewritten to `<repo>` BEFORE the address rule can read it.
 * 4. **The bounds**: a `<!-- pi-rukas: … -->` marker is byte-identical; a
 *    private target gets no rewrite; the escape hatch off gets no rewrite; a
 *    root that merely PRECEDES other text is not a path under it.
 * 5. **The note**: appended only when a rewrite happened, and only once.
 *
 * Everything is built from this test's own temp home and repo directories — no
 * real user name, host or path appears in this file, and no test reads or
 * rewrites the host's home.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDenylistCacheForTests } from "../src/public-denylist.ts";
import { driverPublicTextCheck } from "../src/public-hygiene-driver.ts";
import {
  PATH_NORMALISATION_NOTE,
  normaliseDriverPublishPaths,
  withPathNormalisationNote,
} from "../src/public-hygiene-normalise.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = "example-private-host";
// The scratch root must NOT sit under the host's real home. The rewrite tries the
// repository spellings before the home spelling, and `home` here is a child of
// `root`; a transcript path built under `home` would otherwise also sit under the
// real `~`, and the shorter home spelling would collapse it before the repository
// spelling was reached. `TMPDIR` is the runner's own short scratch dir.
const root = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hygiene-normalise-"));

// The fixture world, all under this test's own scratch dir: a home directory
// with a "real" transcript path, a sibling directory that is ANOTHER user's
// home, and a repository with a worktree and a verify log under it.
const home = path.join(root, "home", "example-person");
const otherHome = path.join(root, "home", "someone-else");
const repo = path.join(root, "work", "example-project");
for (const dir of [
  home,
  otherHome,
  path.join(repo, ".worktrees", "issue-7-x"),
  path.join(repo, "tmp", "issue-7"),
]) {
  mkdirSync(dir, { recursive: true });
}

const denylist = path.join(root, "denylist");
writeFileSync(denylist, `# synthetic\n${TERM}\n`, "utf8");

/** The driver seam with every host fact pinned to this test's fixture world. */
const check = (text: string) =>
  driverPublicTextCheck("pull request body", text, "gh pr comment", repo, {
    exec: async () => ({ stdout: "false\n" }),
    homeDir: home,
    // Identity realpath: the offline fixture paths are already canonical, and a
    // test must never ask the filesystem about the HOST's roots.
    realpath: (dir) => dir,
  });

await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: denylist }, async () => {
  resetDenylistCacheForTests();

  // ── 1. a handoff-shaped body: transcript under home, worktree and verify log
  // under the repo; published normalised and clean, and POSTED AS JUDGED.
  const handoff = [
    "<!-- pi-rukas:handoff issue=7 cap=round-cap -->",
    "# Handoff",
    "",
    `- transcript: ${path.join(home, ".pi", "agent", "ensemble-runs", "run-1-developer.json")}`,
    `- worktree: ${path.join(repo, ".worktrees", "issue-7-x")}`,
    `- verify log: ${path.join(repo, "tmp", "issue-7", "verify.log")}`,
  ].join("\n");
  const ok = await check(handoff);
  assert(
    ok.refusal === undefined,
    `a handoff body with host paths is clean once normalised (${ok.refusal?.slice(0, 60) ?? "clean"})`,
  );
  assert(ok.rewritten === true, "and the seam reports it rewrote something");
  assert(!ok.text.includes(home), "the home directory no longer appears in the published bytes");
  assert(!ok.text.includes(repo), "nor does the repository root");
  assert(ok.text.includes("~/"), "the transcript path is relative to ~");
  assert(
    ok.text.includes("<repo>/.worktrees/issue-7-x"),
    "the worktree path is relative to <repo>",
  );
  assert(ok.text.includes("cap=round-cap"), "…and the pi-rukas marker is untouched");

  // ── 2. fail-closed after the rewrite.
  const otherUsersHome = `See ${path.join(otherHome, ".ssh", "id_ed25519")} for the key.`;
  const refusedOther = await check(otherUsersHome);
  assert(
    refusedOther.refusal?.includes("home directory") === true,
    `a path under ANOTHER user's home is still refused after the rewrite (${refusedOther.refusal?.slice(0, 60) ?? "PASSED — the rewrite made it look like ~"})`,
  );
  assert(
    refusedOther.text.includes(otherHome),
    "and it is NOT rewritten to ~, which would attribute it to this operator",
  );

  const both = `See ${TERM} at ${path.join(home, "notes", "plan.md")}.`;
  const refusedBoth = await check(both);
  assert(refusedBoth.refusal !== undefined, "a denylist term beside a home path is still refused");
  assert(!(refusedBoth.refusal ?? "").includes(TERM), "and the refusal carries no term");

  // ── 3. order: a repo root whose final segment looks like a private address.
  const dotted = path.join(root, "srv", "10.1.2.0");
  mkdirSync(dotted, { recursive: true });
  const dottedBody = `The gate ran in ${path.join(dotted, "extension")}.`;
  const checkedDotted = await driverPublicTextCheck("body", dottedBody, "gh pr comment", dotted, {
    exec: async () => ({ stdout: "false\n" }),
    homeDir: home,
    realpath: (dir) => dir,
  });
  assert(
    checkedDotted.refusal === undefined,
    `a repository root ending in a dotted quad is rewritten to <repo> BEFORE the address rule reads it (${checkedDotted.refusal ?? "clean"})`,
  );
  assert(
    checkedDotted.text === "The gate ran in <repo>/extension.",
    "…and the result is the placeholder",
  );

  // ── 4. the bounds.
  const marker = `<!-- pi-rukas:lens-residuals branch=main patch=${"a".repeat(12)} -->`;
  const withMarker = `Findings below.\n${marker}\nPath: ${path.join(repo, "src", "a.ts")}`;
  const checkedMarker = normaliseDriverPublishPaths(withMarker, { repoRoot: repo, homeDir: home });
  assert(
    checkedMarker.text.includes(marker),
    "a pi-rukas marker survives the rewrite byte-identical, even beside a rewritten path",
  );
  assert(
    normaliseDriverPublishPaths(marker, { repoRoot: repo, homeDir: home }).text === marker,
    "…and a body that is only the marker is returned unchanged",
  );

  const noRoot = normaliseDriverPublishPaths(`log at ${path.join(root, "x.log")}`, {
    repoRoot: undefined,
    homeDir: "",
  });
  assert(noRoot.rewritten === false, "with no roots supplied, nothing is rewritten");

  const nearMiss = normaliseDriverPublishPaths(`backup at ${repo}-old/ and ${repo}.bak/`, {
    repoRoot: repo,
    homeDir: "",
  });
  assert(
    nearMiss.text === `backup at ${repo}-old/ and ${repo}.bak/`,
    "a root followed by anything but a separator or the end of the text is not a path under it",
  );

  const bareRoot = normaliseDriverPublishPaths(`the root is ${repo}`, {
    repoRoot: repo,
    homeDir: "",
  });
  assert(bareRoot.text === "the root is <repo>", "…while a root at the end of the text is");

  // ── 5. the note.
  const noted = withPathNormalisationNote("body text", true);
  assert(
    noted.includes(PATH_NORMALISATION_NOTE),
    "a rewritten handoff says what ~ and <repo> mean",
  );
  assert(
    withPathNormalisationNote(noted, true) === noted,
    "…and saying it twice is not a thing a re-post does",
  );
  assert(withPathNormalisationNote("body text", false) === "body text", "no rewrite, no note");

  // ── 6. the round-cap residual post: checked, and refused when dirty.
  const { residualDisclosureBody } = await import("../src/work-driver-lens-cap-hygiene.ts");
  const ctx = { repoRoot: repo };
  const exec = (async (cmd: string, o?: { argv?: string[] }) => {
    if (o?.argv?.[0] === "config")
      return { stdout: "https://github.com/example-owner/example-repo.git\n" };
    if (o?.argv?.[0] === "remote")
      return { stdout: "https://github.com/example-owner/example-repo.git\n" };
    if (o?.argv?.[0] === "api") return { stdout: "false\n" };
    return { stdout: "" };
  }) as never;
  const clean = await residualDisclosureBody(
    ctx,
    `Findings:\n- src/a.ts:1 in ${path.join(repo, "src", "a.ts")}\n<!-- pi-rukas:lens-residuals branch=main patch=abc -->`,
    exec,
  );
  assert(
    "text" in clean,
    `a clean residual body is posted, normalised (${clean.text?.slice(0, 40)})`,
  );
  assert("text" in clean && !clean.text.includes(repo), "…with the repository root rewritten out");
  const dirty = await residualDisclosureBody(ctx, `A finding names ${TERM}.`, exec);
  assert(
    "refusal" in dirty && !dirty.refusal.includes(TERM),
    "a dirty residual body is refused, and the refusal names no term",
  );
});

// ── the escape hatch turns the rewrite off along with the check.
await withEnv(
  { PI_ENSEMBLE_PUBLIC_DENYLIST: denylist, PI_ENSEMBLE_PUBLIC_HYGIENE: "0" },
  async () => {
    resetDenylistCacheForTests();
    const off = await check(`log at ${path.join(home, "x.log")}`);
    assert(off.refusal === undefined, "the hatch off publishes without a check");
    assert(
      off.rewritten === false,
      "…and without a rewrite: a disabled guard changes nobody's text",
    );
    assert(off.text.includes(home), "…so the original bytes are what the caller publishes");
  },
);

// ── a positively private target keeps its exact paths.
await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: denylist }, async () => {
  resetDenylistCacheForTests();
  // The visibility answer is cached per slug, and block 1 asked about this very
  // slug on the public branch. Without a reset this block would read block 1's
  // answer and assert against a lookup that never happened.
  resetVisibilityCacheForTests();
  const priv = await driverPublicTextCheck(
    "pull request body",
    `log at ${path.join(home, "x.log")}`,
    "gh pr comment",
    repo,
    {
      exec: async () => ({ stdout: "false\n" }),
      visibility: async () => true,
      target: { owner: "example-owner", repo: "example-repo", host: "github.com" },
      homeDir: home,
      realpath: (dir) => dir,
    },
  );
  assert(priv.refusal === undefined, "a private repository is not checked");
  assert(priv.rewritten === false, "…and its paths stay exact");
  assert(priv.text.includes(home), "the operator of a private repo reads the real path");
});

rmSync(root, { recursive: true, force: true });
process.exit(exit);
