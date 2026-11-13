#!/usr/bin/env bun
/**
 * The headless result's `prUrl` — built only when its web address is certain
 * (#1326, self-hosted ssh #2225).
 *
 *   - the ten rows of today's contract: GitHub and GitLab remotes, https ports
 *     kept, GitLab subgroups kept, alias hosts and traversal refused
 *   - an ssh remote whose host the operator declared in `.pi/forge` gets a URL
 *     built from that host, in the scp-like and ssh:// forms, nested groups kept
 *   - a host nobody declared still yields no URL — no guessing
 *   - the resolver leg the runner calls (`prUrlResolver(repoRoot)`), driven end
 *     to end through one remote plus the repo's own `.pi/forge`
 *
 * Offline: temp directories only, and no network — `detectForge` is reached with
 * its probe off, so the only host truth here is the one in `.pi/forge`.
 */
import {
  formatPrUrl,
  prUrlFromComment,
  prUrlResolver,
  webRepoUrl,
} from "../src/headless/pr-url.ts";
import { projectIssue } from "../src/headless/result.ts";
import type { WorkEvent } from "../src/workflow-state-events.ts";
import { type WorkState, appendEvent, initialState } from "../src/workflow-state.ts";
import { trackedTempDir } from "./lib/git-test-env.ts";
import { mkForgeRepo } from "./lib/headless-contract-git.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function build(events: WorkEvent[]): WorkState {
  let s = initialState(7);
  for (const e of events) s = appendEvent(s, e);
  return s;
}

/**
 * Unset `PI_ENSEMBLE_FORGE`. `Reflect.deleteProperty` is how this suite removes
 * the forge override (`merge-guard-helpers.ts`): on Bun 1.4 assigning `undefined`
 * stores the literal string "undefined" rather than unsetting, and the env-clear
 * ratchet polices that assignment (`test-env-clear-gate.ts`).
 */
function unsetForgeEnv(): void {
  Reflect.deleteProperty(process.env, "PI_ENSEMBLE_FORGE");
}

/**
 * Run `fn` with `PI_ENSEMBLE_FORGE` pinned to `value`, or withheld when it is
 * `undefined`, and the operator's own value restored after. A withheld override
 * is what the self-hosted cases below prove — the URL has to come from the repo's
 * own `.pi/forge`, not from an env var another test file left set.
 */
async function withForgeEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const saved = process.env.PI_ENSEMBLE_FORGE;
  if (value === undefined) unsetForgeEnv();
  else process.env.PI_ENSEMBLE_FORGE = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) unsetForgeEnv();
    else process.env.PI_ENSEMBLE_FORGE = saved;
  }
}

// ── prUrl: only when unambiguous.
{
  const cases: [string, string, string | undefined][] = [
    ["github", "git@github.com:o/r.git", "https://github.com/o/r/pull/5"],
    ["github", "ssh://git@github.com:22/o/r.git", "https://github.com/o/r/pull/5"],
    ["github", "https://ghe.example.com:8443/o/r", "https://ghe.example.com:8443/o/r/pull/5"],
    ["github", "https://github.com/o/r/extra", undefined],
    [
      "gitlab",
      "https://gitlab.example.com/g/sub/p.git",
      "https://gitlab.example.com/g/sub/p/-/merge_requests/5",
    ],
    ["gitlab", "git@gitlab.com:g/sub/p.git", "https://gitlab.com/g/sub/p/-/merge_requests/5"],
    // An ssh alias host (or a self-hosted ssh host) has no certain web address.
    ["github", "git@github-work:o/r.git", undefined],
    ["gitlab", "ssh://git@gitlab.example.com:2222/g/p.git", undefined],
    ["gitlab", "https://gitlab.example.com/g/../p", undefined],
    ["unknown", "https://x.example/o/r", undefined],
  ];
  for (const [forge, remote, want] of cases) {
    const got = formatPrUrl(forge, remote, 5);
    assert(got === want, `${forge} ${remote} → ${want ?? "no URL"} (${got ?? "none"})`);
  }
  assert(
    prUrlFromComment("https://github.com/o/r/pull/5#issuecomment-1", 5) ===
      "https://github.com/o/r/pull/5",
    "a recorded PR comment URL yields the PR URL",
  );
  assert(
    prUrlFromComment("https://github.com/o/r/pull/6#issuecomment-1", 5) === undefined,
    "a comment on another PR is not used",
  );
  const s = build([
    { kind: "merged", at: 1, prNumber: 5 },
    {
      kind: "handoff-emitted",
      at: 2,
      labelApplied: true,
      targetType: "pr",
      targetNumber: 5,
      commentUrl: "https://gitlab.example.com/a/b/c/-/merge_requests/5#note_9",
    } as WorkEvent,
  ]);
  assert(
    projectIssue(s, "f").prUrl === "https://gitlab.example.com/a/b/c/-/merge_requests/5",
    "the result prefers the PR URL the driver recorded",
  );
}

// ── prUrl for an ssh remote whose host the operator declared in .pi/forge.
// An ssh host outside github.com / gitlab.com is a web address only when the
// project itself names it: the remote's host may be an ssh alias and its port
// is not the web port, so a host nobody declared still yields no URL.
{
  const GITLAB_FORGE = "type=gitlab\nhost=gitlab.example.com\n";
  const GHE_FORGE = "type=github\nhost=ghe.example.com\n";
  const declared: [string, string, string, string | undefined][] = [
    // scp-style, GitLab nested groups: the path is kept whole.
    [
      "gitlab",
      "git@gitlab.example.com:group/sub/project.git",
      GITLAB_FORGE,
      "https://gitlab.example.com/group/sub/project/-/merge_requests/7",
    ],
    // The two-segment form of the same remote.
    [
      "gitlab",
      "git@gitlab.example.com:group/project.git",
      GITLAB_FORGE,
      "https://gitlab.example.com/group/project/-/merge_requests/7",
    ],
    // ssh:// with an ssh port — the port is never the web port, so https:443.
    [
      "gitlab",
      "ssh://git@gitlab.example.com:2222/group/sub/project.git",
      GITLAB_FORGE,
      "https://gitlab.example.com/group/sub/project/-/merge_requests/7",
    ],
    // GitHub Enterprise names the /pull form instead.
    [
      "github",
      "git@ghe.example.com:org/repo.git",
      GHE_FORGE,
      "https://ghe.example.com/org/repo/pull/7",
    ],
    // The remote's host is an ssh alias the config does not name: no URL.
    ["github", "git@github-work:o/r.git", GHE_FORGE, undefined],
    // A known public host whose declared host disagrees: no URL. The declared
    // host is a constraint, never a licence to invent an address.
    ["gitlab", "git@gitlab.com:g/sub/p.git", "type=gitlab\nhost=gitlab.example.com\n", undefined],
    // A declared host that is not a bare host names a path, not a host: no URL.
    [
      "gitlab",
      "git@gitlab.example.com:group/project.git",
      "type=gitlab\nhost=gitlab.example.com/self\n",
      undefined,
    ],
  ];
  for (const [forge, remote, forgeConfig, want] of declared) {
    const host = forgeConfig.match(/^host=(\S+)$/m)?.[1];
    const got = formatPrUrl(forge, remote, 7, host);
    assert(
      got === want,
      `declared host: ${forge} ${remote} → ${want ?? "no URL"} (${got ?? "none"})`,
    );
  }

  // The resolver leg: what the headless runner actually calls. `withForgeEnv`
  // with no value withholds PI_ENSEMBLE_FORGE — the URL has to come from the
  // repo's own .pi/forge — and `mkForgeRepo` gives each case exactly one remote,
  // which the resolver requires before it builds anything.
  await withForgeEnv(undefined, async () => {
    const resolve = async (remote: string, forgeConfig: string) =>
      (await prUrlResolver(mkForgeRepo(trackedTempDir("prurl-"), remote, forgeConfig)))(7);
    assert(
      (await resolve("git@gitlab.example.com:group/sub/project.git", GITLAB_FORGE)) ===
        "https://gitlab.example.com/group/sub/project/-/merge_requests/7",
      "the resolver builds a nested-group ssh GitLab URL from the declared host",
    );
    assert(
      (await resolve("ssh://git@gitlab.example.com:2222/group/project.git", GITLAB_FORGE)) ===
        "https://gitlab.example.com/group/project/-/merge_requests/7",
      "the resolver keeps the ssh:// form and drops its ssh port",
    );
    assert(
      (await resolve("git@ghe.example.com:org/repo.git", GHE_FORGE)) ===
        "https://ghe.example.com/org/repo/pull/7",
      "the resolver builds the GitHub Enterprise /pull form from the declared host",
    );
    assert(
      (await resolve("git@github-work:o/r.git", GHE_FORGE)) === undefined,
      "an ssh alias the operator never declared still yields no URL",
    );
    assert(
      (await resolve("git@other.example.com:g/p.git", GITLAB_FORGE)) === undefined,
      "a .pi/forge host the remote does not carry yields no URL",
    );
    assert(
      webRepoUrl("gitlab", "git@gitlab.example.com:group/sub/project.git", "gitlab.example.com") ===
        "https://gitlab.example.com/group/sub/project",
      "webRepoUrl takes the declared host over the remote's own",
    );
  });
}

process.exit(exit);
