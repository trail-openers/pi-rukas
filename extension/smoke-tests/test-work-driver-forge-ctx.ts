#!/usr/bin/env bun
/**
 * The cycle's Forge is DETECTED, never asserted.
 *
 * `forgeForCycle` is the one constructor of a cycle's Forge, so whatever it
 * hands back decides which forge CLI every pre-merge step of the cycle talks
 * to. It used to pass `PI_ENSEMBLE_FORGE=github` into detection, which is
 * detection's hard override: the answer was always GitHub, `.pi/forge` and the
 * remote were never consulted, and a GitLab cycle issued `gh`.
 *
 * These cases drive the real `detectForge` through a real repo on disk (a
 * `.pi/forge` plus an SSH remote on that host — the operator's own shape), so
 * the leg under test is the config-and-remote leg and not a fixture's say-so.
 *
 * Offline: an injected exec seam answers every command; no network, no CLI.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openPrBodyListCmd, prListCmd } from "../src/forge-commands.ts";
import { forgeForCycle } from "../src/work-driver-forge-ctx.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import { rawGhLookupRefusal } from "../src/work-driver-pr-preflight.ts";
import { gitTestEnv, trackedTempDir } from "./lib/git-test-env.ts";

gitTestEnv();

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The self-hosted host every case here is built on — never a live host. */
const SELF_HOST = "gitlab.example.com";

/**
 * A repo whose only forge evidence is the operator's own: `.pi/forge` naming
 * `type=gitlab`/`host=` and an scp-form SSH remote on that host.
 *
 * `.pi/` is created because `detectForge` reads `.pi/forge` from DISK — there
 * is no content seam on `forgeForCycle`, and widening its contract to add one
 * would let a test assert a config the repo never carried.
 */
function selfHostedRepo(forgeFile: string | null): { repoRoot: string; dispose: () => void } {
  const repoRoot = trackedTempDir("forge-ctx-");
  mkdirSync(join(repoRoot, ".pi"), { recursive: true });
  if (forgeFile !== null) writeFileSync(join(repoRoot, ".pi", "forge"), forgeFile, "utf8");
  return {
    repoRoot,
    dispose: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

/** An exec seam answering the two git reads detection makes, plus anything else. */
function seam(remoteUrl: string | null, extra: VerifyExecFn = async () => ({ stdout: "" })) {
  const calls: string[] = [];
  const fn: VerifyExecFn = async (cmd, opts) => {
    calls.push(cmd);
    // Only `origin` carries a URL; `upstream` and the bare `git remote` list
    // must answer EMPTY, or detection never reaches the config leg at all.
    if (cmd.includes("remote.origin.url")) {
      if (remoteUrl === null) throw new Error("no remote");
      return { stdout: `${remoteUrl}\n` };
    }
    if (cmd.includes("remote.upstream.url")) return { stdout: "" };
    if (cmd === "git remote") return { stdout: remoteUrl === null ? "" : "origin\n" };
    return extra(cmd, opts);
  };
  return { fn, calls };
}

/** The env with `PI_ENSEMBLE_FORGE` ABSENT — never `delete`d (Bun stores "undefined"). */
const NO_FORGE_ENV: Record<string, string | undefined> = {};

// ── 1. a self-hosted GitLab repo resolves to the GitLab adapter ───────────

{
  const { repoRoot, dispose } = selfHostedRepo(`type=gitlab\nhost=${SELF_HOST}\n`);
  const cmds: string[] = [];
  const answer: VerifyExecFn = async (cmd, opts) => {
    cmds.push(cmd);
    return { stdout: "[]" };
  };
  const { fn, calls } = seam(`git@${SELF_HOST}:group/sub/project.git`, answer);
  const forge = await forgeForCycle({ repoRoot }, fn, new Map(), { env: NO_FORGE_ENV });
  assert(forge !== undefined, "a .pi/forge + SSH remote on the same host resolves a Forge");
  assert(forge?.forge === "gitlab", `…and it is the GitLab adapter (${forge?.forge})`);
  assert(
    calls.some((c) => c.includes("remote.origin.url")),
    "…the remote was really read (detection was not short-circuited by an env override)",
  );
  await forge?.prList({ state: "open" });
  assert(
    cmds.length === 1 && cmds[0] === prListCmd("gitlab", { state: "open" }),
    `…and the first pre-merge forge call IS the adapter's glab command (${cmds[0]})`,
  );
  assert(
    cmds.length === 1 && !cmds[0].startsWith("gh "),
    "…and no gh command was issued by a GitLab cycle",
  );
  // The raw-`gh` pre-merge lookups name their refusal instead of running gh.
  assert(
    rawGhLookupRefusal("gitlab") !== undefined &&
      rawGhLookupRefusal("github") === undefined &&
      rawGhLookupRefusal(undefined) !== undefined,
    "the raw-gh preflight lookups refuse every forge but github, by name",
  );
  assert(
    openPrBodyListCmd("open") ===
      "gh pr list --state open --limit 100 --json number,headRefName,body",
    "the GitHub lookup still issues the pinned gh command string",
  );
  dispose();
}

// ── 2. the config's host has to agree with the host the remote parses ───

{
  // A subgroup remote on a host the config does NOT name (#2257). Before the
  // parser accepted a namespace path deeper than two segments, this URL
  // parsed to no host at all, so `detectForge`'s config leg had nothing to
  // compare `host=` against and applied a `.pi/forge` pointing at another
  // instance — the cycle got an adapter for a host its remote never named.
  // With the path parsed, the mismatch is detected and the config refused.
  const { repoRoot, dispose } = selfHostedRepo(`type=gitlab\nhost=${SELF_HOST}\n`);
  const { fn, calls } = seam("git@other.example.net:group/sub/project.git");
  const forge = await forgeForCycle({ repoRoot }, fn, new Map(), { env: NO_FORGE_ENV });
  assert(
    forge === undefined,
    `a .pi/forge whose host disagrees with a subgroup remote is refused, not applied (${forge?.forge})`,
  );
  assert(
    calls.some((c) => c.includes("remote.origin.url")),
    "…with the remote read, so the refusal is the config leg's, not a missing remote",
  );
  dispose();
}

{
  // …and when the remote DOES parse a host, the config cannot redirect it:
  // the mismatch is detected and the answer is no forge, not a wrong one.
  const { repoRoot, dispose } = selfHostedRepo(`type=gitlab\nhost=${SELF_HOST}\n`);
  const { fn, calls } = seam("git@other.example.net:group/project.git");
  const forge = await forgeForCycle({ repoRoot }, fn, new Map(), { env: NO_FORGE_ENV });
  assert(
    forge === undefined,
    "a .pi/forge whose host disagrees with a PARSED remote host is rejected, not applied",
  );
  assert(
    calls.some((c) => c.includes("remote.origin.url")),
    "…with the remote read, so the rejection is the config leg's, not a missing remote",
  );
  dispose();
}

// ── 3. the probe never runs ────────────────────────────────────────────────

{
  const { repoRoot, dispose } = selfHostedRepo(null);
  let probed = false;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    probed = true;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const { fn } = seam(`git@${SELF_HOST}:group/sub/project.git`);
  const forge = await forgeForCycle({ repoRoot }, fn, new Map(), { env: NO_FORGE_ENV });
  globalThis.fetch = original;
  assert(
    forge === undefined && probed === false,
    "an unknown host with no config gives no Forge and no network probe (the seam has no side effects)",
  );
  dispose();
}

// ── 4. PI_ENSEMBLE_FORGE=none short-circuits before detection ─────────────

{
  const { repoRoot, dispose } = selfHostedRepo(`type=gitlab\nhost=${SELF_HOST}\n`);
  const { fn, calls } = seam(`git@${SELF_HOST}:group/sub/project.git`);
  const forge = await forgeForCycle({ repoRoot }, fn, new Map(), {
    env: { PI_ENSEMBLE_FORGE: "none" },
  });
  assert(
    forge === undefined,
    "PI_ENSEMBLE_FORGE=none gives no Forge even with a .pi/forge on disk",
  );
  assert(calls.length === 0, "…and detection never ran (no remote read, no config read)");
  dispose();
}

// ── 5. the env override still wins over the repo, as detectForge documents ─

{
  const { repoRoot, dispose } = selfHostedRepo(`type=gitlab\nhost=${SELF_HOST}\n`);
  const { fn } = seam(`git@${SELF_HOST}:group/sub/project.git`);
  const forge = await forgeForCycle({ repoRoot }, fn, new Map(), {
    env: { PI_ENSEMBLE_FORGE: "github" },
  });
  assert(forge?.forge === "github", "an explicit PI_ENSEMBLE_FORGE=github still wins");
  dispose();
}

// ── 6. a GitHub remote resolves the GitHub adapter (byte-identity of the CLI) ─

{
  const { repoRoot, dispose } = selfHostedRepo(null);
  const { fn } = seam("https://github.com/acme/widget.git");
  const forge = await forgeForCycle({ repoRoot }, fn, new Map(), { env: NO_FORGE_ENV });
  assert(forge?.forge === "github", "a github.com remote resolves the GitHub adapter");
  dispose();
}

// ── 7. opts.execOpts is the caller's deadline, on every adapter command ────

{
  // The explore issue-body fetch carries its per-attempt bound this way. An
  // adapter that ignored it would run `gh`/`glab` with no timeout at all, so the
  // bound is asserted here rather than trusted: an adapter with no deadline is
  // an unbounded forge call, which is the #1261 failure this seam exists to stop.
  const { repoRoot, dispose } = selfHostedRepo(`type=gitlab\nhost=${SELF_HOST}\n`);
  const optsSeen: Array<{ timeout?: number; maxBuffer?: number } | undefined> = [];
  const { fn } = seam(`git@${SELF_HOST}:group/sub/project.git`, async (cmd, opts) => {
    optsSeen.push(opts);
    return { stdout: "[]" };
  });
  const forge = await forgeForCycle({ repoRoot }, fn, new Map(), {
    env: NO_FORGE_ENV,
    execOpts: { timeout: 45_000, maxBuffer: 256 * 1024 },
  });
  await forge?.prList({ state: "open" });
  const adapterCall = optsSeen.at(-1);
  assert(
    adapterCall?.timeout === 45_000 && adapterCall.maxBuffer === 256 * 1024,
    `opts.execOpts travels on the adapter's command (${JSON.stringify(adapterCall)})`,
  );
  dispose();
}

process.exit(exit);
