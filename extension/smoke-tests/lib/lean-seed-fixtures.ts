/**
 * The forge stub and the temp-repo builder every `work-lean` base case shares.
 *
 * Split out of `test-lean-seed-base.ts` when that file gained the immutable-oid
 * refusals and crossed AGENTS.md §12's line cap: the two files are one suite
 * split along the seam between its FIXTURES and its CASES, not a second suite.
 * Both read the same source (`src/lean/command.ts`), so both stay under the
 * same cap rather than one of them being squeezed.
 *
 * ## Every case in the two files these fixtures serve
 *
 * The base sha is a RUN-START fact, and a fresh `work-lean` used to have none.
 *
 * Field evidence: headless work-lean 1908 on main exited 10 after two steps.
 * `runWorkLean` seeded the engine with `{ version }` alone and `ready`'s handler
 * deliberately returns only its verdict, so nothing ever wrote `baseSha` — and
 * `specify` (like `build`, `challenge` and `verify`) refuses a run whose record
 * carries no base: "the run carries no base sha", thrown as infrastructure,
 * which is the wrong ending for a run whose issue was perfectly ready.
 *
 * `leanSeed` is the fix, and the cases these fixtures serve pin what it and
 * `readyOutcome` guarantee:
 *
 *   (a) the seed resolves the mainline tip the clone last saw (`origin/HEAD`),
 *       so the base is a real commit rather than a guess;
 *   (b) a repo with no mainline seeds `""` and does NOT throw — the seed runs
 *       before the run does, and a seed that threw would take the command down
 *       instead of letting `ready` refuse the issue with a reason;
 *   (c) the seed reaches the record: `runLean` puts it on the new run, and the
 *       `specify` handler sees the same value on `ctx.run.baseSha` — exactly the
 *       read that refused the field run;
 *   (d) the seed is a run-START fact: a resumed run keeps the sha its first
 *       round recorded, so a mainline that moved cannot silently become this
 *       run's base;
 *   (e) `ready` refuses an empty base with the mainline rule (quoting the
 *       seed's cause when it has one) rather than probing for a base of its own;
 *   (f) the wiring end to end: the handler set the command builds, driven by the
 *       engine, gets a green `ready` and a record carrying the base — the shape
 *       the field run could not reach;
 *   (g) a non-empty base that names no object is a `ready` refusal, not a
 *       default config, and the refused value is clipped in the rule;
 *   (h) a base whose commit carries no `.pi/work.json` is still `ok` — the
 *       refusal is about the absent commit, never the absent file;
 *   (i) the seed's cause reaches the rule through `handlersFor`;
 *   (j) the base is pinned to an IMMUTABLE oid, not merely to something git
 *       will resolve: `main`, `HEAD`, a ``main^{commit}`touch x`@{0}`` suffix
 *       chain, an 8-hex prefix and an uppercase full sha are all refused, and a
 *       real full sha still gives `ok`.
 *
 * Everything is offline: real git in a temp repo (a stubbed probe would test the
 * stub), and `gh` pointed at a script printing the issue body so the forge read
 * succeeds without a network or a token.
 *
 * Nothing here asserts — a fixture that reported a verdict would be judging
 * someone else's run (the same reason `lib/lean-engine-fixtures.ts` makes its
 * assert a function).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitTestEnv } from "./git-test-env.ts";

/** The pi-spec every base case feeds the forge, so the spec parse goes green. */
export const SPEC = {
  problem: "The retry helper gives up on the first transient failure.",
  size: "S",
  criteria: [{ id: "AC1", text: "retries a transient failure twice", verify: "test" }],
};

export const BODY = `\`\`\`pi-spec v1\n${JSON.stringify(SPEC, null, 2)}\n\`\`\``;

/** git in `dir` with the host's config isolated and a fixture-local identity. */
export function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...gitTestEnv(),
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/**
 * A dir whose `gh` answers every call with `{ body }` — the shape both the
 * forge adapter's `gh issue view … --json …` and the raw fallback parse.
 *
 * `command.ts` wires `readyOutcome` to the real forge, so the seam a case has
 * for the issue body is the `gh` those paths shell out to. A PATH entry pointing
 * at a script is the narrowest fake that keeps the production read in place: the
 * JSON parse, the spec parser and the readiness judgement all run on real bytes,
 * and no token or network is needed.
 *
 * The script writes a JSON file and `cat`s it. It must NOT print the body
 * through `printf`: `%s` swallows the backquotes of a pi-spec fence and `%b`
 * eats the escapes that JSON used to spell the body's own newlines (both
 * measured — each produced `{"body":""}` from a well-formed spec), and a fake
 * that quietly deletes the fence tests a run that was refused for a reason the
 * case never intended. `cat` passes the bytes through unchanged.
 */
export function fakeGhDir(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "lean-seed-gh-"));
  const json = JSON.stringify({
    body,
    number: 1,
    title: "t",
    state: "OPEN",
    url: "https://forge.invalid/o/r/issues/1",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    labels: [],
    author: { login: "t" },
  });
  writeFileSync(path.join(dir, "answer.json"), json, "utf8");
  writeFileSync(path.join(dir, "gh"), '#!/bin/sh\ncat "$(dirname "$0")/answer.json"\n', {
    mode: 0o755,
  });
  return dir;
}

/** Run `fn` with `binDir` searched before the host's PATH; restores after. */
export async function withGh<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${before ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = before;
  }
}

/**
 * A temp repo whose mainline refs exist or do not, as the case asks.
 *
 * `git remote set-head` is what makes `origin/HEAD` exist at all — a repo
 * `git init`-ed in a temp dir has no such ref, and the whole bug class here is a
 * probe that reads refs. `workJson` commits the config at the base because
 * `ready` loads `.pi/work.json` AT that sha: absent it, `ready` would fall back
 * to defaults, which is a different situation from the one under test.
 *
 * `withLocalMain: false` is the second shape the seed must answer for. `origin`
 * is the last ref `mainlineSha` probes, so with no remote AND no `main` there is
 * nothing left to resolve — and a commit still has to exist for the case to have
 * a repo, so it goes on a throwaway branch and `main` is deleted.
 */
export function originRepo(
  opts: { withOrigin?: boolean; withLocalMain?: boolean; workJson?: boolean } = {},
): { repoRoot: string; originHead: string; tip: string; dispose: () => void } {
  const withOrigin = opts.withOrigin !== false;
  const withLocalMain = opts.withLocalMain !== false;
  const repoRoot = mkdtempSync(path.join(tmpdir(), "lean-seed-"));
  const originDir = path.join(repoRoot, ".origin.git");
  git(repoRoot, "init", "-q", "-b", "main");
  mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
  writeFileSync(path.join(repoRoot, "README.md"), "# seed fixture\n", "utf8");
  // `workJson: false` is a real shape, not an unused knob: `ready` loads the
  // config AT the base and a repo without one is the common case, so a case
  // has to drive it and see the run go green on the defaults anyway.
  if (opts.workJson !== false) {
    writeFileSync(path.join(repoRoot, ".pi", "work.json"), JSON.stringify({ version: 1 }), "utf8");
  } else {
    // Keep `.pi/` in the commit so the directory exists and a later case can
    // tell "no config file" from "no config directory".
    writeFileSync(path.join(repoRoot, ".pi", "README"), "no config\n", "utf8");
  }
  git(repoRoot, "add", "-A");
  if (withLocalMain) {
    git(repoRoot, "commit", "-q", "-m", "base");
  } else {
    git(repoRoot, "commit", "-q", "-m", "base", "--allow-empty");
    git(repoRoot, "checkout", "-q", "-b", "side");
    git(repoRoot, "branch", "-D", "main");
  }
  if (withOrigin) {
    git(repoRoot, "init", "-q", "--bare", originDir);
    git(repoRoot, "remote", "add", "origin", originDir);
    git(repoRoot, "push", "-q", "origin", "main");
    git(repoRoot, "remote", "set-head", "origin", "main");
  }
  const originHead = withOrigin && withLocalMain ? git(repoRoot, "rev-parse", "origin/HEAD") : "";
  // The local tip, which exists even in a repo with no remote: a case that
  // needs a REAL full sha in a repo with no `origin/HEAD` (the uppercase-sha
  // refusal) cannot use `originHead`, which is "" there.
  const tip = withLocalMain ? git(repoRoot, "rev-parse", "HEAD") : "";
  const forgeBefore = process.env.PI_ENSEMBLE_FORGE;
  // Set BEFORE the caller's first case reads it, and restored to the exact prior
  // bytes rather than `delete`d: every reader in the tree (`fetchIssueBody`,
  // `postNotReady`, …) compares against `"none"`, so a stale value a sibling
  // test file left on the process would be as good as a forge to the fixture
  // that is supposed to keep the network out. Absent is restored as absent.
  process.env.PI_ENSEMBLE_FORGE = "none";
  const forgeWasAbsent = forgeBefore === undefined;
  return {
    repoRoot,
    originHead,
    tip,
    dispose: () => {
      if (forgeWasAbsent) process.env.PI_ENSEMBLE_FORGE = undefined;
      else process.env.PI_ENSEMBLE_FORGE = forgeBefore;
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}
