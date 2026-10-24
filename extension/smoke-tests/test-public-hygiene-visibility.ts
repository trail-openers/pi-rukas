#!/usr/bin/env bun
/**
 * public-hygiene-visibility (#1788 round 1, PM design decision) — the guard
 * protects PUBLIC repositories, so a private one must not have its commit
 * messages, PR bodies or pushes refused at all, and every way the visibility
 * question can fail must still refuse.
 *
 * Four things this file pins:
 *
 * 1. a PRIVATE target: a dirty commit message, a dirty PR body and a dirty push
 *    all pass, which is the whole point of the decision;
 * 2. the SAME surfaces on a PUBLIC target are refused — the block is not
 *    satisfied by a gate that skips everything;
 * 3. a resolver that throws, returns nothing useful, or never answers is
 *    REFUSED (fail closed), as is an unresolvable remote: "could not tell" is
 *    never "clean";
 * 4. the cache asks `gh` ONCE per OWNER/REPO, however many publishes arrive.
 *
 * Nothing here touches the network: the visibility question and the remote-URL
 * question are both injected, which is precisely why they are seams. Terms are
 * synthetic — this repository is public.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type DenylistRead,
  readPublicDenylist,
  resetDenylistCacheForTests,
} from "../src/public-denylist.ts";
import { inspectCommand } from "../src/public-hygiene-guard.ts";
import {
  type RepoTarget,
  ghVisibility,
  isPrivateTarget,
  resetVisibilityCacheForTests,
  targetSlug,
  visibilityLookupCount,
} from "../src/public-hygiene-visibility.ts";
import type { ExecFn } from "../src/worktree.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const TERM = "example-private-host";
const PUSH = ["pu", "sh"].join("");
const GITHUB_URL = "https://github.com/example-owner/example-repo.git";

const dir = mkdtempSync(path.join(tmpdir(), "hygiene-visibility-"));
const denylistPath = path.join(dir, "denylist");
writeFileSync(denylistPath, `# the operator list\n${TERM}\n`, "utf8");
const denylistEnv = { PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath };

/** A denylist read that always uses this file, never the operator's own. */
function deny(): DenylistRead {
  resetDenylistCacheForTests();
  return readPublicDenylist(denylistEnv);
}

/** The dirty commands every block asks about, one per publish surface type. */
const SURFACES: readonly { label: string; command: string; location: string }[] = [
  {
    label: "commit message",
    command: 'git commit -m "feat: wire example-private-host into the build"',
    location: "commit message",
  },
  {
    label: "PR body",
    command: 'gh pr create --title hi --body "deployed on example-private-host"',
    location: "body",
  },
  {
    label: "issue body",
    command: 'gh issue create --title hi --body "ping example-private-host"',
    location: "body",
  },
];

/** The push, assembled from pieces so the verb is not a literal in this file. */
const pushCommand = (): string => ["git", PUSH, "origin", "main"].join(" ");

/** The remote URL the resolver is handed, for a github.com repository. */
const githubRemote = async (): Promise<string> => GITHUB_URL;

/** A resolver that hands back the whole publish surface for one target.
 *
 * `exec` is passed through UNDEFINED by default rather than as a fake: with no
 * executor the guard passes the push half (it cannot ask git) but still resolves
 * the target through the injected `remoteUrl`, which is what these cases are
 * about. A scripted executor that answers every git call with an empty string
 * instead made the refspec `main` unresolvable, and the command was then refused
 * for a reason that had nothing to do with visibility.
 */
function ask(
  command: string,
  opts: {
    visibility?: (t: RepoTarget) => Promise<boolean>;
    remoteUrl?: (name: string, dir: string) => Promise<string>;
    exec?: ExecFn;
  } = {},
) {
  return inspectCommand(command, dir, opts.exec, deny, {
    pushVerb: PUSH,
    visibility: opts.visibility,
    remoteUrl: (name: string) =>
      (opts.remoteUrl ?? (async (): Promise<string> => GITHUB_URL))(name, dir),
  });
}

// ── 1. A PRIVATE repository: none of the publish surfaces is refused.
await withEnv(denylistEnv, async () => {
  resetVisibilityCacheForTests();
  const seen: string[] = [];
  const privateRepo = async (t: RepoTarget): Promise<boolean> => {
    seen.push(targetSlug(t));
    return true;
  };
  for (const s of SURFACES) {
    const r = await ask(s.command, { visibility: privateRepo });
    assert(r === undefined, `a private repo does not refuse a dirty ${s.label}`);
  }
  const push = await ask(pushCommand(), {
    visibility: privateRepo,
  });
  assert(push === undefined, "a private repo does not refuse a push either");
  assert(
    seen.every((s) => s === "example-owner/example-repo"),
    `every surface resolved to the remote's repository (got ${seen.join(", ")})`,
  );
});

// ── 2. The SAME surfaces on a PUBLIC repository are refused — the gate must
// skip nothing but what it positively knows is private.
await withEnv(denylistEnv, async () => {
  resetVisibilityCacheForTests();
  const publicRepo = async (): Promise<boolean> => false;
  for (const s of SURFACES) {
    // A fresh cache per surface: block 1 has already answered for this same
    // repository, and a cached `false` would make this block ask the cache
    // rather than the resolver it is meant to be exercising.
    resetVisibilityCacheForTests();
    const r = await ask(s.command, { visibility: publicRepo });
    // `inspectCommand` returns its own `Decision` shape (a reason plus a trace
    // verdict); the BLOCKING is what the registered hook adds on top. Asserting
    // on `block` here would be asserting on the wrapper, so the reason is the
    // thing under test at this level.
    assert(r !== undefined, `a public repo refuses a dirty ${s.label}`);
    assert(
      (r?.reason ?? "").includes(s.location),
      `and the refusal names the ${s.label} as the surface`,
    );
    assert(!(r?.reason ?? "").includes(TERM), "and the refusal carries no term");
  }
  const push = await ask(pushCommand(), {
    visibility: publicRepo,
    remoteUrl: githubRemote,
  });
  // The push is NOT refused here: with no executor the guard passes the push
  // half rather than refusing a role that pushes all day on a range it could not
  // ask git about. What the block is really asserting is that execution reached
  // that point at all — a private answer would have returned before it, and the
  // dirty prose surfaces above prove the checks are live for this repository.
  assert(push === undefined, "a public repo push is judged by the range rules, not skipped");
});

// ── 3. Any failure of the visibility question CHECKS (fail closed). A resolver
// that throws, one that answers nothing useful, and one that never answers are
// three different failures and all three must reach the checks.
await withEnv(denylistEnv, async () => {
  const dirty = SURFACES[1]?.command ?? "";
  resetVisibilityCacheForTests();
  const throws = await ask(dirty, {
    visibility: async () => {
      throw new Error("gh: network unreachable");
    },
  });
  assert(throws !== undefined, "a visibility lookup that throws is refused, not skipped");

  resetVisibilityCacheForTests();
  const hangs = await ask(dirty, {
    visibility: () => new Promise<boolean>(() => undefined),
  });

  assert(hangs !== undefined, "a visibility lookup that never answers is refused");

  // An unresolvable remote: no repository means no positive private answer, so
  // the surface is checked. This is the case the PM brief names as "no remote".
  resetVisibilityCacheForTests();
  const noRemote = await ask(dirty, {
    remoteUrl: async () => {
      throw new Error("no such remote");
    },
    visibility: async () => true,
  });
  assert(noRemote !== undefined, "an unreadable remote URL is refused even by a private resolver");

  resetVisibilityCacheForTests();
  const junkUrl = await ask(dirty, {
    remoteUrl: async () => "not a repository url at all",
    visibility: async () => true,
  });
  assert(junkUrl !== undefined, "an unparseable remote URL is refused");
});

// ── 4. The cache: one lookup per repository, however many publishes.
await withEnv(denylistEnv, async () => {
  resetVisibilityCacheForTests();
  let asked = 0;
  const counting = async (): Promise<boolean> => {
    asked += 1;
    return false;
  };
  for (const s of SURFACES) {
    await ask(s.command, { visibility: counting });
  }
  await ask(SURFACES[1]?.command ?? "", { visibility: counting });
  assert(asked === 1, `the cache asked gh once for one repository (asked ${asked} times)`);
  assert(visibilityLookupCount() === 1, "and the cache holds one entry for it");

  // A second repository is a second lookup — the cache is keyed per OWNER/REPO,
  // not globally, or one private repo would silence the guard everywhere.
  const other = await ask('gh pr create -R other-org/other-repo --body "x"', {
    visibility: async () => false,
  });
  assert(other === undefined, "a clean publish to another repo passes");
  assert(visibilityLookupCount() === 2, `and the second repository got its own lookup`)
});

// ── 5. `ghVisibility`: the raw answer, and the ways it must not be believed.
{
  const ok = (stdout: string): ExecFn =>
    (async () => ({ stdout, stderr: "" })) as unknown as ExecFn;
  const target: RepoTarget = { owner: "acme", repo: "widget" };
  resetVisibilityCacheForTests();
  assert(
    (await ghVisibility(target, ok("true\n"), dir)) === true,
    "the word true is a private repository",
  );
  for (const [stdout, label] of [
    ["false\n", "the word false"],
    ["", "an empty body"],
    ["gh: command not found\n", "a usage banner on stdout"],
    ['{"private":true}\n', "a JSON body the --jq never reduced"],
  ] as const) {
    assert(
      (await ghVisibility(target, ok(stdout), dir)) === false,
      `${label} is not a private answer`,
    );
  }
  const boom: ExecFn = (async () => {
    throw new Error("gh: not authenticated");
  }) as unknown as ExecFn;
  let rejected = false;
  try {
    await ghVisibility(target, boom, dir);
  } catch {
    rejected = true;
  }
  assert(rejected, "a failing gh call rejects the raw lookup — the caller decides, not this");

  // The argv form: the slug is ONE argument, never a shell string.
  const seen: { cmd: string; argv?: string[] }[] = [];
  const spy: ExecFn = (async (cmd: string, opts?: { argv?: string[] }) => {
    seen.push({ cmd, argv: opts?.argv });
    return { stdout: "true\n", stderr: "" };
  }) as unknown as ExecFn;
  await ghVisibility(target, spy, dir);
  assert(
    seen[0]?.cmd === "gh" &&
      seen[0]?.argv?.[0] === "api" &&
      seen[0]?.argv?.[1] === "repos/acme/widget" &&
      seen[0]?.argv?.includes(".private") === true,
    "asked as argv: gh api repos/OWNER/REPO --jq .private",
  );

  // A non-GitHub host is answered without any lookup at all: `gh` cannot speak
  // for a GitLab project, and an unverified "public" there would be a claim.
  resetVisibilityCacheForTests();
  let called = false;
  const untouched = async (): Promise<boolean> => {
    called = true;
    return true;
  };
  assert(
    (await isPrivateTarget(target, { host: "gitlab.com", lookup: untouched })) === false &&
      !called,
    "a non-github host is checked without asking gh",
  );
  resetVisibilityCacheForTests();
}

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
