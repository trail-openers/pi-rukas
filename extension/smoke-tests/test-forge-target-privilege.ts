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

    // The `isPrivateTarget` seam rows — the malformed / `opts.host` / blank-host
    // half of the contract — live in the sibling test-forge-target-privilege-seam.ts
    // (the 500-line gate: this file is the parse/target-minting half and the
    // end-to-end adapter cases; that one is the seam itself).

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
