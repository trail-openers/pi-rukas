#!/usr/bin/env bun
/**
 * #2257 round 2, SEAM half — `isPrivateTarget` decides who may skip a scan.
 *
 * Split out of `test-forge-target-privilege.ts` (500-line gate); that file keeps
 * the parse/target-minting halves and the end-to-end adapter cases. This half
 * pins the seam itself: the malformed / `opts.host` / blank-host rows.
 *
 * The public-only gate skips a publish scan on ONE answer: `gh` said this
 * repository is private. Whoever hands that seam a `RepoTarget` therefore
 * decides whether the scan runs, so the shape of a supplied slug is a privilege
 * and not a string. A `RepoTarget` whose owner or repo carries a separator is
 * not a repository github.com publishes — `gh api repos/acme/corp/widget`
 * answers about a path, not a slug — so a `true` there is an unverified claim
 * wearing a verified answer, and it is the one answer that stops a check.
 *
 * Why the seam and not just the adapter: `inspectCommand`'s `target:` argument
 * lets any caller hand `isPrivateTarget` its own slug, so the rule about the
 * ANSWER cannot live in `forge.ts` alone. The rows below reach the seam
 * directly, with the lookup injected, so no case depends on a real clone.
 *
 * The mirror-image spelling matters as much as the first one: `owner` and `repo`
 * feed ONE endpoint (`ghVisibility` builds `repos/OWNER/REPO` from the two
 * fields), so `"acme" + "corp/widget"` is the very same path github.com
 * publishes nothing at as `"acme/corp" + "widget"`. And because `opts.host`
 * picks the transport, it is also the host whose slug rule must apply — while a
 * BLANK host names no forge at all and so waives nothing.
 *
 * Harness pattern: pinned literals, no framework (test-forge-parse-remote-url.ts
 * shape). Fully offline: an injected visibility resolver and a cleared cache
 * before every row.
 */

import {
  type RepoTarget,
  isPrivateTarget,
  resetVisibilityCacheForTests,
} from "../src/public-hygiene-visibility.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

let exitCode = exit;
function eq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${msg} — got ${a}${a === e ? "" : `, expected ${e}`}`);
}

console.log("\n--- the visibility seam: a github.com slug must be a REAL one ---");

/** A deep github.com slug — the shape github.com publishes no repository at. */
const deepTarget: RepoTarget = { owner: "acme/corp", repo: "widget", host: "github.com" };

// The seam that decides the exemption is `isPrivateTarget`, and every caller
// that hands it a `target:` argument (the forge adapter's own slug, the
// driver's hand-built one) gets to decide whether the scan runs at all. A
// `RepoTarget` whose owner carries a slash is not a repository github.com
// publishes — `gh api repos/acme/corp/widget` answers about a path, not a
// slug — so a `true` there is an unverified claim wearing a verified answer,
// and it is the one answer that stops a check. Reaching it from the seam
// rather than only from the adapter is the point: the adapter's own guard is
// a rule about one caller, and this is the rule about the answer.
const askedDeep: RepoTarget[] = [];
const deepIsPrivate = await isPrivateTarget(deepTarget, {
  lookup: async (t) => {
    askedDeep.push(t);
    return true;
  },
});
assert(
  deepIsPrivate === false,
  `a deep github.com slug is not a private repository the scan may skip (isPrivateTarget said ${deepIsPrivate})`,
);
assert(
  askedDeep.length === 0,
  `…and no lookup was issued for it at all (asked: ${askedDeep
    .map((t) => `${t.host ?? "<no host>"}/${t.owner}/${t.repo}`)
    .join(", ") || "none"})`,
);

// The mirror-image spelling. `owner` and `repo` feed ONE endpoint
// (`ghVisibility` builds `repos/OWNER/REPO` from the two fields), so `"acme" +
// "corp/widget"` is the very same path github.com publishes nothing at as
// `"acme/corp" + "widget"`. A rule that policed `owner` alone called this
// second spelling a repository and let it buy the exemption.
for (const malformed of [
  { owner: "acme", repo: "corp/widget", host: "github.com" },
  { owner: "acme", repo: "corp/widget" },
  { owner: "acme/corp", repo: "widget/sub", host: "github.com" },
  { owner: "", repo: "widget", host: "github.com" },
  { owner: "acme", repo: "", host: "github.com" },
]) {
  resetVisibilityCacheForTests();
  const askedMalformed: RepoTarget[] = [];
  const malformedIsPrivate = await isPrivateTarget(malformed, {
    lookup: async (t) => {
      askedMalformed.push(t);
      return true;
    },
  });
  assert(
    malformedIsPrivate === false,
    `${JSON.stringify(malformed)}: the separator is refused wherever it sits (isPrivateTarget said ${malformedIsPrivate})`,
  );
  assert(
    askedMalformed.length === 0,
    `…with no lookup issued and nothing cached (asked: ${askedMalformed
      .map((t) => `${t.host ?? "<no host>"}/${t.owner}/${t.repo}`)
      .join(", ") || "none"})`,
  );
}

console.log("\n--- the shape rule is asked of the host the lookup is about ---");

// The same malformed slugs, the same refusal, but with the host supplied
// through `opts.host` rather than on the target. `opts.host` is what picks the
// transport, so it is also the host whose slug rule must apply: a caller that
// says `github.com` over a target whose own host is a GitLab box must not get
// a malformed slug past the shape rule and into the `gh` lookup.
for (const malformed of [
  { owner: "acme/corp", repo: "widget", host: "gitlab.example.com" },
  { owner: "acme", repo: "corp/widget", host: "gitlab.example.com" },
]) {
  resetVisibilityCacheForTests();
  const askedViaOptsHost: RepoTarget[] = [];
  const viaOptsHost = await isPrivateTarget(malformed, {
    host: "github.com",
    lookup: async (t) => {
      askedViaOptsHost.push(t);
      return true;
    },
  });
  assert(
    viaOptsHost === false,
    `${JSON.stringify(malformed)} with opts.host github.com: the separator is refused on the host the lookup asks (isPrivateTarget said ${viaOptsHost})`,
  );
  assert(
    askedViaOptsHost.length === 0,
    `…with no lookup issued and nothing cached (asked: ${askedViaOptsHost
      .map((t) => `${t.host ?? "<no host>"}/${t.owner}/${t.repo}`)
      .join(", ") || "none"})`,
  );
}

// A BLANK host is not a host. `""` is what a config `host=` or a URL parse
// yields when nobody named one, and on the strength of not being exactly
// `github.com` it waived the shape rule AND still read as "unknown, so ask
// gh" in the transport branch — so `{owner:"acme/corp",repo:"widget",host:""}`
// reached the resolver with the very separator the rule above refuses. A host
// that names no forge cannot be the host whose rules are waived, so `""` reads
// as absent everywhere `host` is read: github.com for the shape rule, the
// transport and the cache key alike.
for (const blankHost of [
  { owner: "acme/corp", repo: "widget", host: "" },
  { owner: "acme", repo: "corp/widget", host: "" },
  { owner: "acme/corp", repo: "widget" },
  { owner: "acme", repo: "corp/widget" },
]) {
  resetVisibilityCacheForTests();
  const askedBlankHost: RepoTarget[] = [];
  const blankHostIsPrivate = await isPrivateTarget(blankHost, {
    host: "",
    lookup: async (t) => {
      askedBlankHost.push(t);
      return true;
    },
  });
  assert(
    blankHostIsPrivate === false,
    `${JSON.stringify(blankHost)} with opts.host "": a blank host waives nothing (isPrivateTarget said ${blankHostIsPrivate})`,
  );
  assert(
    askedBlankHost.length === 0,
    `…with no lookup issued and nothing cached (asked: ${askedBlankHost
      .map((t) => `${t.host ?? "<no host>"}/${t.owner}/${t.repo}`)
      .join(", ") || "none"})`,
  );
}

// …and the blank stays read as absent when the TARGET carries one but
// `opts.host` names github.com: the effective host is still github.com, so
// the shape rule still applies.
for (const blankOnTarget of [
  { owner: "acme/corp", repo: "widget", host: "" },
  { owner: "acme", repo: "corp/widget", host: "" },
]) {
  resetVisibilityCacheForTests();
  const askedBlankTargetHost: RepoTarget[] = [];
  const blankTargetHostIsPrivate = await isPrivateTarget(blankOnTarget, {
    host: "github.com",
    lookup: async (t) => {
      askedBlankTargetHost.push(t);
      return true;
    },
  });
  assert(
    blankTargetHostIsPrivate === false,
    `${JSON.stringify(blankOnTarget)} with opts.host github.com: the effective host is github.com and the separator is refused (isPrivateTarget said ${blankTargetHostIsPrivate})`,
  );
  assert(
    askedBlankTargetHost.length === 0,
    `…with no lookup issued and nothing cached (asked: ${askedBlankTargetHost
      .map((t) => `${t.host ?? "<no host>"}/${t.owner}/${t.repo}`)
      .join(", ") || "none"})`,
  );
}

// The row the brief names: no host on the target at all, github.com supplied
// through `opts.host` — the effective host is github.com, so the shape rule
// applies even though `target.host` is absent.
resetVisibilityCacheForTests();
const askedNoTargetHost: RepoTarget[] = [];
const noTargetHostIsPrivate = await isPrivateTarget(
  { owner: "acme/corp", repo: "widget" },
  {
    host: "github.com",
    lookup: async (t) => {
      askedNoTargetHost.push(t);
      return true;
    },
  },
);
assert(
  noTargetHostIsPrivate === false,
  `{"acme/corp","widget"} with no target host and opts.host github.com is refused on shape (isPrivateTarget said ${noTargetHostIsPrivate})`,
);
assert(
  askedNoTargetHost.length === 0,
  `…with no lookup issued and nothing cached (asked: ${askedNoTargetHost
    .map((t) => `${t.host ?? "<no host>"}/${t.owner}/${t.repo}`)
    .join(", ") || "none"})`,
);

// A GitLab namespace is NOT malformed — nesting is what GitLab serves, so a
// deep slug on another host stays checkable (answered `false`, as any
// non-GitHub host is) rather than refused on shape by this rule.
resetVisibilityCacheForTests();
const namespaceIsPrivate = await isPrivateTarget(
  { owner: "group/sub", repo: "project", host: "gitlab.example.com" },
  { lookup: async () => false },
);
assert(
  namespaceIsPrivate === false,
  "a deep GitLab namespace stays checkable rather than being refused on shape",
);

// The control: an owner that IS one slug keeps its private answer, so the
// refusal above is about the shape and not a seam that exempts nothing.
resetVisibilityCacheForTests();
const askedFlat: RepoTarget[] = [];
const flatIsPrivate = await isPrivateTarget(
  { owner: "acme", repo: "widget", host: "github.com" },
  {
    lookup: async (t) => {
      askedFlat.push(t);
      return true;
    },
  },
);
assert(flatIsPrivate === true, "a real github.com slug still gets its private answer");
eq(
  askedFlat.map((t) => `${t.host}/${t.owner}/${t.repo}`),
  ["github.com/acme/widget"],
  "…on one lookup of that slug, host included",
);

exitCode = exit;
console.log(`\nexit ${exitCode}`);
process.exit(exitCode);
