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
 *    root that merely PRECEDES other text is not a path under it; a mask that
 *    cannot be found returns the ORIGINAL bytes and claims no rewrite.
 * 5. **The note**: appended only when a rewrite happened, and only once.
 *
 * Everything is built from this test's own temp home and repo directories — no
 * real user name, host or path appears in this file, and no test reads or
 * rewrites the host's home.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PUBLIC_DENYLIST_PATH_ENV, resetDenylistCacheForTests } from "../src/public-denylist.ts";
import { driverPublicTextCheck } from "../src/public-hygiene-driver.ts";
import {
  PATH_NORMALISATION_NOTE,
  normaliseDriverPublishPaths,
  withPathNormalisationNote,
} from "../src/public-hygiene-normalise.ts";
import { publicTextRefusal } from "../src/public-hygiene-text.ts";
import { resetVisibilityCacheForTests } from "../src/public-hygiene-visibility.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = "example-private-host";
// A second term for the fold case, so the two blocks never disagree about which
// entry a refusal is blaming. The fold case needs a term that lives INSIDE the
// repository root it removes: `example-private-host` is used by the block above
// as a term that sits OUTSIDE any root, and reusing it here would make one block's
// expectation depend on the other's fixture.
// Two terms for the two things the fold block judges: the fold removes a ROOT it
// recognises, so a body whose only private content is the root publishes clean,
// while a term that appears as its own path segment survives the rewrite and is
// still refused. Declared next to the scratch list they are written to, so a
// refusal's line number is checkable against a file this test owns — never against
// a host's real denylist, which would make the outcome a fact about the machine.
const FOLD_TERM = "pi-rukas-host-mark";
// The scratch root must NOT sit under the host's real home. The rewrite tries the
// repository spellings before the home spelling, and `home` here is a child of
// `root`; a transcript path built under `home` would otherwise also sit under the
// real `~`, and the shorter home spelling would collapse it before the repository
// spelling was reached. `TMPDIR` is the runner's own short scratch dir.
const root = mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "hygiene-normalise-"));

// The fixture world, all under this test's own scratch dir: a home directory
// with a "real" transcript path and a repository with a worktree and a verify
// log under it.
const home = path.join(root, "home", "example-person");
const repo = path.join(root, "work", "example-project");
for (const dir of [
  home,
  path.join(repo, ".worktrees", "issue-7-x"),
  path.join(repo, "tmp", "issue-7"),
]) {
  mkdirSync(dir, { recursive: true });
}

// ANOTHER user's home is a LITERAL absolute path, not a directory under the
// scratch root. A nested `…/home/someone-else` is preceded by a path character,
// and the generic home rule matches `/home/<name>/` only at the START of a path
// (or after a non-path character), so the nested spelling is invisible to it:
// whether that text got refused depended on the HOST — refused when the scratch
// root itself sat under a personal `/home/<name>/`, silently clean on a runner
// whose scratch root sits under the exempt `/home/runner/`. A judgement this test
// makes must not be a fact about the machine that runs it. The file need not
// exist; nothing here opens it.
const otherHome = "/home/someone-else";

const denylist = path.join(root, "denylist");
writeFileSync(denylist, `# synthetic\n${TERM}\n${FOLD_TERM}\n`, "utf8");

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
  //
  // `otherHome` is a LITERAL absolute path, never a directory under the scratch
  // root: the generic home rule matches `/home/<name>/` only at the START of a
  // path, so a nested spelling was judged by the host rather than by the rule
  // (refused under a personal `/home/<name>/` scratch root, clean under the
  // exempt `/home/runner/` one — the CI failure this fixture fixes).
  const otherUsersHome = `See ${path.join(otherHome, ".ssh", "id_ed25519")} for the key.`;
  const refusedOther = await check(otherUsersHome);
  assert(
    refusedOther.refusal?.includes("home directory") === true,
    `a path under ANOTHER user's home is still refused after the rewrite (${refusedOther.refusal?.slice(0, 60) ?? "PASSED — the rewrite made it look like ~"})`,
  );
  assert(
    refusedOther.text.includes(otherHome) && !refusedOther.text.includes("~/"),
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

  // A marker span whose mask has gone is the one case the rewrite must not guess
  // at: the masked buffer has a hole where the marker's bytes were, and posting
  // it would publish a marker the driver's own reader cannot parse. The original
  // bytes come back with `rewritten: false`, so the generic rules judge what the
  // caller actually has. Reachable through the exported seam by a body that
  // carries the mask character alongside a marker — the mask is a control byte no
  // publish body carries, so this is a fault-injection case, not a shape the
  // driver composes.
  const strayed = normaliseDriverPublishPaths(
    `log at ${path.join(repo, "a.ts")} \u0001 <!-- pi-rukas:x -->`,
    { repoRoot: repo, homeDir: "" },
  );
  assert(
    strayed.text === `log at ${path.join(repo, "a.ts")} \u0001 <!-- pi-rukas:x -->` &&
      strayed.rewritten === false &&
      strayed.kinds.length === 0,
    "a mask that cannot be found returns the original bytes and claims no rewrite",
  );

  // ── 4b. BOTH flanks are judged, by one class (#1820 round 3).
  //
  // The two flanks used to be judged by two different rules, so a path whose
  // before-character satisfied rule A and whose after-character satisfied rule B
  // could still go unfolded — and an unfolded repository root inside the operator's
  // home keeps the host home in the text the denylist check then refuses. Each case
  // below has ONE boundary character that git would not accept in a pathname, on
  // the side named, and must fold.
  const HOME_REPO = `${home}/repo`;
  const flank = (text: string) =>
    normaliseDriverPublishPaths(text, { repoRoot: HOME_REPO, homeDir: home });
  const FOLD_BOUNDARIES: Array<[string, string, string]> = [
    ["backslash before", `git -C \\${HOME_REPO} status`, "backslash"],
    ["comma before", `logs, ${HOME_REPO}: ok`, "comma"],
    ["open paren before", `(${HOME_REPO}/src)`, "open paren"],
    ["close paren after", `see (${HOME_REPO})`, "close paren"],
    ["comma after", `${HOME_REPO}, and the build`, "comma"],
    ["quote after", `\`'${HOME_REPO}'\``, "quote"],
    ["colon after", `git status in ${HOME_REPO}: fatal to run`, "colon"],
    ["whitespace after", `path was ${HOME_REPO} today`, "whitespace"],
  ];
  for (const [label, probe, name] of FOLD_BOUNDARIES) {
    const got = flank(probe);
    assert(
      !got.text.includes(HOME_REPO) && got.rewritten === true,
      `a ${name} ${label} of the root ENDS the path and folds it (${label}: ${JSON.stringify(got.text)})`,
    );
  }
  // The two rules the class replaces, kept exactly: a sibling that continues the
  // root's NAME is a different directory, and a separator means a path under it.
  const kept = flank("backup at ~/repo-old/ and ~/repo.bak/ and ~/other");
  assert(
    kept.text === "backup at ~/repo-old/ and ~/repo.bak/ and ~/other",
    `…and a sibling that continues the name is never folded (${JSON.stringify(kept.text)})`,
  );
  assert(
    !flank(`see ${HOME_REPO}/src/index.ts`).text.includes(HOME_REPO),
    "a separator after the root is a path under it, which folds",
  );

  // The handoff case that started this: a host path that would not fold became text
  // the denylist refused, so the driver had a rendered handoff it could not publish
  // and — before round 2 — an operator who could not tell why. The fold is the fix;
  // the refusal reason below is what makes the residual case diagnosable.
  //
  // Judged through the seam that ACTUALLY runs the denylist: `driverPublicTextCheck`
  // folds and then judges with exactly `publicTextRefusal(label, normalised.text)`
  // (its only caller), which reads the list itself off `PUBLIC_DENYLIST_PATH_ENV`
  // — the scratch list this `withEnv` block already set. `normaliseDriverPublishPaths`
  // neither takes a denylist nor returns a refusal, so asking IT both asserted
  // nothing about the denylist and read a field the function never produces.
  //
  // The fixture is a LITERAL `/home/dev/…` tree for the same reason `otherHome`
  // above is one: only the FOLD is under test, and a root under this test's own
  // scratch dir made the outcome a fact about the host. Unfolded, a
  // `${root}/…/tmp-host-mark/x` sits under a personal `/home/<name>/` when the
  // runner's `TMPDIR` does (so the generic set refused it and the control passed
  // for a reason the fold has nothing to do with) and under the exempt
  // `/home/runner/` when it does not (so the control went clean). `dev` is on the
  // generic rule's placeholder list precisely so documentation and fixtures can
  // carry a home path, so the judgement below is the same on every host. The
  // directories need not exist — nothing here opens them.
  const fakeHome = "/home/dev";
  const FAKE_REPO = `${fakeHome}/repo`;
  // Two terms, because this block needs two DIFFERENT outcomes from the same list:
  // a term that sits OUTSIDE the folded root (the fold removes it, so the body
  // publishes) and a term that sits INSIDE it (the fold rewrites the path around
  // it but cannot remove the word, so the check still refuses). One term would
  // make the two assertions contradict each other.
  const INSIDE_TERM = FOLD_TERM;

  // (a) A host path whose only private content IS the repository root: the fold
  // removes the root and the body publishes clean. The RAW text goes in and the
  // seam does the folding — a caller that pre-folded would hand the check bytes
  // nobody judged. `homeDir` is the fake home and the cwd is the scratch repo,
  // exactly as a driver post supplies them.
  const published = await driverPublicTextCheck(
    "pull request body",
    `trace at ${FAKE_REPO}/logs/x and the log`,
    "gh pr comment 7 --body-file body.md",
    repo,
    { exec: async () => ({ stdout: "false\n" }), homeDir: fakeHome, realpath: (dir) => dir },
  );
  assert(
    published.refusal === undefined &&
      published.rewritten === true &&
      !published.text.includes(FAKE_REPO) &&
      !published.text.includes(fakeHome) &&
      published.text === "trace at ~/repo/logs/x and the log",
    `the fold removes the host root before the denylist sees it (text ${JSON.stringify(published.text)}, refusal ${published.refusal?.split("\n")[1]?.slice(0, 60) ?? "clean"})`,
  );

  // (b) The same seam with a term the fold CANNOT remove. A fold replaces a ROOT it
  // recognises; a term that appears as its own path segment is not the root, so it
  // survives the rewrite and the check still refuses — on the DENYLIST entry, not
  // the generic set, which is what makes (a) a judgement about the fold rather than
  // about a list that never fires. Same label, same command, same home, identity
  // `realpath`: (a) and (b) differ only in whether the text carries the term.
  // `line 3` is this test's own scratch list's line for `INSIDE_TERM`, named so a
  // generic-set refusal cannot masquerade as the pass.
  const residual = await driverPublicTextCheck(
    "pull request body",
    `trace at ${FAKE_REPO}/${INSIDE_TERM}/x and the log`,
    "gh pr comment 7 --body-file body.md",
    repo,
    { exec: async () => ({ stdout: "false\n" }), homeDir: fakeHome, realpath: (dir) => dir },
  );
  assert(
    residual.refusal !== undefined &&
      residual.refusal.includes("A private-denylist entry matched") &&
      residual.refusal.includes("line 3") &&
      !residual.refusal.includes(INSIDE_TERM),
    `a term the fold cannot remove is still refused, by the list and naming no term (${residual.refusal?.split("\n")[1]?.slice(0, 70) ?? "clean"})`,
  );
  assert(
    residual.rewritten === true && residual.text === `trace at ~/repo/${INSIDE_TERM}/x and the log`,
    `…on the FOLDED bytes, i.e. the fold ran first and did not save it (${JSON.stringify(residual.text)})`,
  );
  assert(
    residual.refusal !== undefined &&
      residual.refusal.includes("A private-denylist entry matched") &&
      residual.refusal.includes("line 3") &&
      !residual.refusal.includes(INSIDE_TERM),
    `a term the fold cannot remove is still refused, by the list and naming no term (${residual.refusal?.split("\n")[1]?.slice(0, 70) ?? "clean"})`,
  );
  assert(
    residual.rewritten === true && residual.text === `trace at ~/repo/${INSIDE_TERM}/x and the log`,
    `…on the FOLDED bytes, i.e. the fold ran first and did not save it (${JSON.stringify(residual.text)})`,
  );

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
