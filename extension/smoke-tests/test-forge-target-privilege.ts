#!/usr/bin/env bun
/**
 * #2257 round 2 — a `github.com` target is a privilege, not a string.
 *
 * The public-only gate skips a publish scan on ONE answer: `gh` said this
 * repository is private. Everything else — no remote, an unparseable URL, a
 * non-GitHub host, a lookup that failed — means CHECK. So whoever hands the gate
 * a `RepoTarget` decides whether the scan runs, and a target the host does not
 * actually serve is a licence to stop checking: `gh api repos/group/sub/project`
 * can answer `true` for a path github.com publishes no repository at, and every
 * post the cycle then makes goes out unread.
 *
 * Two surfaces could still mint that licence, and each was judged by a rule that
 * lived somewhere else:
 *
 *   1. `parseRemoteUrl`'s `forge` argument relaxed the `owner/repo` bound on a
 *      `github.com` URL. An exported `PI_ENSEMBLE_FORGE=gitlab` in a GitHub clone
 *      is the ordinary way to reach it, and it turned `git@github.com:g/s/p.git`
 *      into `["g","s","p"]` for every consumer;
 *   2. `createForge` reduced that path to a `RepoTarget` carrying the host the
 *      DETECTION reported rather than the host the REMOTE named, so a deep
 *      github.com path reached `isPrivateTarget` as a github.com slug.
 *
 * What the rules now are, and where they live:
 *
 *   - `parseRemoteUrl` accepts a `github.com` path of EXACTLY two segments,
 *     whatever forge the caller passes. A deeper path parses to nothing, so no
 *     consumer sees a slug at all (forge-detect.ts, `parseNamespace`);
 *   - the publish target is decided by `forgePublishTarget` alone, carries the
 *     remote's host, and refuses a github.com path that is not two segments;
 *   - every consumer of the shared parse that turns a path into a `RepoTarget`
 *     refuses the same shape, so a `target:` argument the driver built by hand —
 *     or a resolver that bypassed the adapter — cannot mint one either.
 *
 * Each case therefore asserts BOTH halves of the contract: no target, AND the
 * text still got checked. "No target" alone is satisfiable by a broken parser;
 * the scan running is what the missing target is FOR.
 *
 * Harness pattern: pinned literals, no framework (test-forge-parse-remote-url.ts
 * shape). Fully offline: a recording exec seam, an injected visibility resolver,
 * and a synthetic denylist — this repository is public.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ForgeExecFn, createForge } from "../src/forge.ts";
import { parseRemoteUrl } from "../src/forge-detect.ts";
import { forgePublishTarget } from "../src/forge-publish-target.ts";
import { parsePushUrlTarget } from "../src/public-hygiene-remote.ts";
import {
  type Target,
  isRepoTarget,
  resolveCommandTarget,
} from "../src/public-hygiene-target.ts";
import { resetDenylistCacheForTests } from "../src/public-denylist.ts";
import {
  type RepoTarget,
  isPrivateTarget,
  resetVisibilityCacheForTests,
} from "../src/public-hygiene-visibility.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = ["example", "private", "host"].join("-");
const DIRTY_BODY = `deployed on ${TERM} last night`;

/** The two URL forms every rule below has to survive, at both depths. */
const GH_DEEP_HTTPS = "https://github.com/acme/corp/widget.git";
const GH_DEEP_SCP = "git@github.com:acme/corp/widget.git";
const GH_FLAT_HTTPS = "https://github.com/acme/widget.git";
const GH_FLAT_SCP = "git@github.com:acme/widget.git";

let exitCode = exit;
function eq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${msg} — got ${a}${a === e ? "" : `, expected ${e}`}`);
}

// ======================================================================
// 1. parseRemoteUrl: a github.com path is two segments whatever the caller says
// ======================================================================

console.log("\n--- parseRemoteUrl: the forge argument cannot relax the github.com bound ---");

for (const url of [GH_DEEP_HTTPS, GH_DEEP_SCP]) {
  eq(
    parseRemoteUrl(url, "gitlab"),
    undefined,
    `a deep github.com URL passed as ${JSON.stringify(url)} yields no parse for any caller (HIGH 1): the rule is a fact about the host, not a choice the caller makes`,
  );
  eq(
    parseRemoteUrl(url, "github"),
    undefined,
    `…asked as GitHub it parses to nothing either: ${JSON.stringify(url)}`,
  );
  eq(parseRemoteUrl(url), undefined, `…and unqualified: ${JSON.stringify(url)}`);
}

for (const url of [GH_FLAT_HTTPS, GH_FLAT_SCP]) {
  eq(
    parseRemoteUrl(url, "gitlab"),
    { host: "github.com", path: ["acme", "widget"] },
    `a two-segment github.com URL still parses however the caller labels the forge: ${JSON.stringify(url)}`,
  );
}

// A GitHub mislabelling must not become a way to make a GitLab remote parse
// deeper either, so the relaxed rule stays reachable on its own host.
eq(
  parseRemoteUrl("git@gitlab.example.com:group/sub/project.git", "github"),
  undefined,
  "the argument can never RELAX a non-github host into GitHub's rule nor deepen a github one",
);

// ======================================================================
// 2. forgePublishTarget: the host travels with the target, and a deep
//    github.com path mints no licence
// ======================================================================

console.log("\n--- forgePublishTarget: host always carried, deep github.com refused ---");

for (const url of [GH_DEEP_HTTPS, GH_DEEP_SCP]) {
  eq(
    forgePublishTarget(url, "gitlab"),
    undefined,
    `a deep github.com remote mints no publish target even labelled GitLab: ${JSON.stringify(url)} (HIGH 2)`,
  );
  eq(
    forgePublishTarget(url, "github"),
    undefined,
    `…nor when labelled GitHub: ${JSON.stringify(url)}`,
  );
}

eq(
  forgePublishTarget("git@github.com:acme/widget.git", "gitlab"),
  { owner: "acme", repo: "widget", host: "github.com" },
  "a two-segment github.com target carries the host explicitly — an absent host would fall through to whatever the caller assumed",
);
eq(
  forgePublishTarget("git@forge.internal.example:group/project.git", "github"),
  { owner: "group", repo: "project", host: "forge.internal.example" },
  "and the host is the REMOTE's, never the detection result's — the config leg's host= is not a host the remote named",
);

// ======================================================================
// 3. parsePushUrlTarget: the push-side mint of the same shape
// ======================================================================

console.log("\n--- parsePushUrlTarget: the same refusal on the push surface ---");

for (const url of [GH_DEEP_HTTPS, GH_DEEP_SCP]) {
  eq(
    parsePushUrlTarget(url),
    undefined,
    `a deep github.com push URL yields no RepoTarget: ${JSON.stringify(url)}`,
  );
}
eq(
  parsePushUrlTarget(GH_FLAT_SCP),
  { host: "github.com", owner: "acme", repo: "widget" },
  "…while a real github.com slug keeps its host",
);

// ======================================================================
// 4. End to end through the adapter: no target AND the text is still checked
// ======================================================================

const dir = mkdtempSync(path.join(tmpdir(), "forge-target-privilege-"));
const list = path.join(dir, "public-denylist");
writeFileSync(list, `# synthetic terms\n${TERM}\n`, "utf8");

function recorder(): { fn: ForgeExecFn; calls: string[] } {
  const calls: string[] = [];
  const fn: ForgeExecFn = async (cmd, opts) => {
    calls.push(opts?.argv ? [cmd, ...opts.argv].join(" ") : cmd);
    return { stdout: '{"number":17,"title":"t"}', stderr: "" };
  };
  return { fn, calls };
}

/** An adapter over `url`, with every visibility answer pinned to `true`. */
function adapter(url: string | undefined, forge: "github" | "gitlab") {
  const rec = recorder();
  const asked: RepoTarget[] = [];
  const built = createForge(
    { forge, host: "github.com", remote: "origin", url, source: "env" },
    {
      execFn: rec.fn,
      cwd: dir,
      visibility: async (t) => {
        asked.push(t);
        return true;
      },
    },
  );
  return { built, calls: rec.calls, asked };
}

try {
  await withEnv(
    {
      PI_ENSEMBLE_PUBLIC_DENYLIST: path.join(dir, "public-denylist"),
    },
    async () => {
    console.log("\n--- createForge: a deep github.com remote cannot excuse its own posts ---");

    // The HIGH-2 shape: the detection says github.com, the remote runs deep.
    // A `true` visibility answer must NOT be reachable for a slug the host does
    // not serve, or every post of the cycle goes out unread.
    for (const url of [GH_DEEP_HTTPS, GH_DEEP_SCP]) {
      resetVisibilityCacheForTests();
      resetDenylistCacheForTests();
      const a = adapter(url, "github");
      let thrown: unknown;
      try {
        await a.built.prCreate("ship it", "feature/x", DIRTY_BODY, {});
      } catch (err) {
        thrown = err;
      }
      assert(
        (thrown as { publicHygiene?: boolean })?.publicHygiene === true,
        `${url}: the dirty body is refused, not excused by the resolver's private answer`,
      );
      assert(
        a.asked.length === 0,
        `${url}: no visibility answer was ever sought for a slug github.com does not serve (asked: ${a.asked
          .map((t) => `${t.host ?? "<no host>"}/${t.owner}/${t.repo}`)
          .join(", ") || "none"})`,
      );
      assert(
        a.calls.every((c) => !c.includes("pr create")),
        `${url}: and nothing was posted`,
      );
    }

    // The inverse: a real github.com slug still gets its private answer, so the
    // refusals above are the missing target and not a broken gate.
    resetVisibilityCacheForTests();
    resetDenylistCacheForTests();
    const flat = adapter(GH_FLAT_HTTPS, "github");
    const posted = await flat.built.prCreate("ship it", "feature/x", DIRTY_BODY, {});
    assert(posted.number === 17, "a real github.com slug keeps its private exemption");
    eq(
      flat.asked.map((t) => `${t.host}/${t.owner}/${t.repo}`),
      ["github.com/acme/widget"],
      "…asked about exactly one target, the remote's, with its host",
    );

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


    console.log("\n--- the tool_call guard's resolver: a deep remote names no target ---");

    // `inspectCommand`'s `target:` argument is the caller's own assertion about
    // where a publish goes, and a `true` visibility answer on it is the ONLY
    // thing that skips a scan. That makes the shape of a supplied slug a
    // privilege, so the rule cannot live in `forge.ts` alone. This drives the
    // guard's own target resolver — the path every caller that supplies no target
    // takes — with git replaced by the `remoteUrl` seam, so no case depends on a
    // real clone. A github.com remote deeper than `owner/repo` must name no
    // repository, which routes the caller to a check rather than to a lookup that
    // could answer `true` about a path the host does not serve.
    const ghCreate = ["gh", "pr", "create", "--title", "t"].join(" ");
    const resolveRemote = (url: string) =>
      resolveCommandTarget(ghCreate, dir, undefined, { remoteUrl: async () => url });

    for (const url of [GH_DEEP_HTTPS, GH_DEEP_SCP]) {
      const resolved: Target | undefined = await resolveRemote(url);
      assert(
        !isRepoTarget(resolved as Target),
        `${url}: a deep github.com remote resolves to no repository target (got ${JSON.stringify(resolved)})`,
      );
    }
    const flatResolved: Target | undefined = await resolveRemote(GH_FLAT_HTTPS);
    assert(
      isRepoTarget(flatResolved as Target),
      `a real github.com remote still resolves to its slug (got ${JSON.stringify(flatResolved)})`,
    );
    eq(
      isRepoTarget(flatResolved as Target)
        ? `${(flatResolved as RepoTarget).owner}/${(flatResolved as RepoTarget).repo}@${(flatResolved as RepoTarget).host}`
        : undefined,
      "acme/widget@github.com",
      "…and the target carries the host the remote named",
    );
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

exitCode = exit;
console.log(`\nexit ${exitCode}`);
process.exit(exitCode);
