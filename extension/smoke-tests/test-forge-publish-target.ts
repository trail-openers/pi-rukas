#!/usr/bin/env bun
/**
 * #2257 — `forgePublishTarget`: the one place the adapter's publish target is
 * decided.
 *
 * The public-only gate skips a surface only on a POSITIVE private answer, so a
 * target this function hands out is a licence to stop checking. Two shapes made
 * that licence reachable on a public host, and both are pinned here as refusals:
 *
 *   - a `github.com` path deeper than `owner/repo` (a GitHub clone labelled GitLab
 *     by `PI_ENSEMBLE_FORGE` or `.pi/forge`): github.com serves one repository per
 *     owner, so the slug is one `gh` cannot resolve, and a lookup that still
 *     answered `true` excused every post the cycle made;
 *   - a host taken from the detection result rather than the remote — the config
 *     leg's `host=` is not a host the remote named, and asking `gh` about a
 *     project on another instance under github.com's name is an unverified claim.
 *
 * Harness pattern: pinned literals, no framework (test-forge-parse-remote-url.ts
 * shape). Offline: a pure function over a string.
 */

import { forgePublishTarget } from "../src/forge-publish-target.ts";

let exit = 0;
function eq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg} — got ${a}, expected ${e}`);
    exit = 1;
  }
}

// A GitLab subgroup keeps its whole namespace as the owner — the slug `glab`
// needs it, and so does the hygiene target.
eq(
  forgePublishTarget("git@gitlab.example.com:group/sub/project.git", "gitlab"),
  { owner: "group/sub", repo: "project", host: "gitlab.example.com" },
  "a subgroup remote yields the namespace as owner and the project as repo",
);
eq(
  forgePublishTarget("https://github.com/acme/widget.git", "github"),
  { owner: "acme", repo: "widget", host: "github.com" },
  "a two-segment GitHub remote yields its slug and the remote's host",
);
eq(
  forgePublishTarget("git@github.com:acme/widget.git/", "github"),
  { owner: "acme", repo: "widget", host: "github.com" },
  "…with the `.git/` trailing-separator shape normalised away",
);

// The two fail-closed shapes.
eq(
  forgePublishTarget("git@github.com:acme/corp/widget.git", "gitlab"),
  undefined,
  "a deep github.com path names no target, even labelled GitLab — no slug for the visibility lookup to call private",
);
eq(
  forgePublishTarget("https://github.com/acme/corp/widget", "github"),
  undefined,
  "…and the same shape asked as GitHub",
);
eq(
  forgePublishTarget("git@forge.internal.example:group/project.git", "gitlab"),
  { owner: "group", repo: "project", host: "forge.internal.example" },
  "the host is the remote's, not the detection result's — a config leg naming github.com cannot relabel it",
);
eq(
  forgePublishTarget("git@forge.internal.example:group/a/b/c/d/e.git", "gitlab"),
  undefined,
  "a path past the depth bound names no target either",
);
eq(forgePublishTarget(undefined, "github"), undefined, "no remote URL at all yields no target");
eq(forgePublishTarget("", "github"), undefined, "…nor does an empty one");
eq(forgePublishTarget("not a url", "github"), undefined, "…nor an unparseable one");

console.log(`\nexit ${exit}`);
process.exit(exit);
