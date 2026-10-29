#!/usr/bin/env bun
/**
 * The base sha is a RUN-START fact, and a fresh `work-lean` used to have none.
 *
 * Field evidence: headless work-lean 1908 on main exited 10 after two steps.
 * `runWorkLean` seeded the engine with `{ version }` alone and `ready`'s handler
 * deliberately returns only its verdict, so nothing ever wrote `baseSha` — and
 * `specify` (like `build`, `challenge` and `verify`) refuses a run whose record
 * carries no base: "the run carries no base sha", thrown as infrastructure,
 * which is the wrong ending for a run whose issue was perfectly ready.
 *
 * `leanSeed` is the fix, and these cases pin what it guarantees:
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
 *       the field run could not reach.
 *
 * Everything here is offline: real git in a temp repo (a stubbed probe would
 * test the stub), and `gh` pointed at a script printing the issue body so the
 * forge read succeeds without a network or a token.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { handlersFor, leanSeed, phase1Handlers, readyOutcome } from "../src/lean/command.ts";
import { runLean } from "../src/lean/engine.ts";
import { HAPPY, scripted, tempDir } from "./lib/lean-engine-fixtures.ts";
import { gitTestEnv } from "./lib/git-test-env.ts";

const { assert, failures } = makeAssert();

function makeAssert(): { assert: (cond: boolean, msg: string) => void; failures: () => number } {
  let failed = 0;
  return {
    assert: (cond, msg) => {
      if (cond) console.log(`\u2713 ${msg}`);
      else {
        console.error(`\u2717 ${msg}`);
        failed = 1;
      }
    },
    failures: () => failed,
  };
}

/** git in `dir` with the host's config isolated and a fixture-local identity. */
function git(dir: string, ...args: string[]): string {
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

const SPEC = {
  problem: "The retry helper gives up on the first transient failure.",
  size: "S",
  criteria: [{ id: "AC1", text: "retries a transient failure twice", verify: "test" }],
};

const BODY = `\`\`\`pi-spec v1\n${JSON.stringify(SPEC, null, 2)}\n\`\`\``;

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
function fakeGhDir(body: string): string {
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
async function withGh<T>(binDir: string, fn: () => Promise<T>): Promise<T> {
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
function originRepo(
  opts: { withOrigin?: boolean; withLocalMain?: boolean; workJson?: boolean } = {},
): { repoRoot: string; originHead: string; dispose: () => void } {
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
  const forgeBefore = process.env.PI_ENSEMBLE_FORGE;
  process.env.PI_ENSEMBLE_FORGE = "none";
  return {
    repoRoot,
    originHead,
    dispose: () => {
      if (forgeBefore === undefined) delete process.env.PI_ENSEMBLE_FORGE;
      else process.env.PI_ENSEMBLE_FORGE = forgeBefore;
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

// ── (a) the seed resolves origin/HEAD, the ref every later base read goes through.
{
  const repo = originRepo();
  try {
    const seed = await leanSeed(repo.repoRoot);
    assert(
      seed.baseSha === repo.originHead && /^[0-9a-f]{40}$/.test(seed.baseSha),
      `leanSeed returns the origin/HEAD sha (got ${JSON.stringify(seed.baseSha)})`,
    );
    assert(
      typeof seed.version === "string" && seed.version.length > 0,
      `leanSeed stamps the version (got ${JSON.stringify(seed.version)})`,
    );
    assert(seed.why === undefined, "a resolved base carries no failure cause");
  } finally {
    repo.dispose();
  }
}

// ── (b) no mainline at all: empty, and it must NOT throw.
{
  const repo = originRepo({ withOrigin: false, withLocalMain: false });
  try {
    let threw: unknown;
    let seed: Awaited<ReturnType<typeof leanSeed>> = { version: "", baseSha: "untouched" };
    try {
      seed = await leanSeed(repo.repoRoot);
    } catch (err) {
      threw = err;
    }
    assert(
      threw === undefined,
      `leanSeed never throws on an unresolvable mainline (${String(threw)})`,
    );
    assert(
      seed.baseSha === "",
      `no mainline seeds an empty base (got ${JSON.stringify(seed.baseSha)})`,
    );
    assert(
      typeof seed.why === "string" && seed.why.length > 0,
      `the failure carries why the probe failed (got ${JSON.stringify(seed.why)})`,
    );
  } finally {
    repo.dispose();
  }
}

// ── (c) the seed lands on the record, and specify's own read sees it.
{
  const dir = tempDir();
  const BASE = "0123456789abcdef0123456789abcdef01234567";
  try {
    const seen: string[] = [];
    const handlers = {
      ...scripted(HAPPY).handlers,
      specify: async (ctx: { run: { baseSha: string } }) => {
        seen.push(ctx.run.baseSha);
        return { kind: "ok" };
      },
    };
    const result = await runLean({
      repoRoot: dir.dir,
      issue: 4201,
      handlers,
      seed: { version: "test", baseSha: BASE },
      now: () => 1,
    });
    assert(seen.length === 1, "the specify handler ran once");
    assert(
      seen[0] === BASE,
      `specify saw ctx.run.baseSha = the seed (got ${JSON.stringify(seen[0])})`,
    );
    assert(
      result.run.baseSha === BASE,
      `the run record carries the seeded base (got ${JSON.stringify(result.run.baseSha)})`,
    );
    const onDisk = JSON.parse(
      readFileSync(path.join(dir.dir, ".pi", "lean-state", "4201.json"), "utf8"),
    ) as { baseSha?: string };
    assert(
      onDisk.baseSha === BASE,
      `the persisted record carries it too (got ${JSON.stringify(onDisk.baseSha)})`,
    );

    // (d) A resume keeps the recorded base: the seed is for a NEW run only, so
    // a mainline that moved cannot become this run's base mid-flight.
    const moved = "ffffffffffffffffffffffffffffffffffffffff";
    const resumed = await runLean({
      repoRoot: dir.dir,
      issue: 4201,
      // The finished record short-circuits before any handler runs, so the
      // assertion is about the base on the record it returns.
      handlers: {},
      seed: { version: "test", baseSha: moved },
      now: () => 2,
    });
    assert(
      resumed.run.baseSha === BASE,
      `a resumed run keeps its recorded base, not the seed (got ${JSON.stringify(resumed.run.baseSha)})`,
    );
  } finally {
    dir.cleanup();
  }
}

// ── (e) an empty base is a `ready` refusal naming the mainline rule, not a throw.
{
  const repo = originRepo();
  try {
    const gh = fakeGhDir(BODY);
    const ready = await withGh(gh, () => readyOutcome(repo.repoRoot, 4202, ""));
    assert(
      ready.kind === "fail" &&
        ready.facts.failedRules.some((r) => r.includes("could not resolve the mainline sha")),
      `an empty base fails ready with the mainline rule (got ${ready.kind} ${JSON.stringify(ready.facts.failedRules)})`,
    );
    // The seed's own cause reaches the comment, which is what separates "this
    // clone has no origin/HEAD" from "git broke" for the operator reading it.
    const withWhy = await withGh(gh, () =>
      readyOutcome(repo.repoRoot, 4202, "", "origin/HEAD: no such ref"),
    );
    assert(
      withWhy.facts.failedRules.some((r) => r.includes("origin/HEAD: no such ref")),
      `the seed's cause is quoted in the rule (got ${JSON.stringify(withWhy.facts.failedRules)})`,
    );
    // A run seeded with the real base gets a green ready: the refusal above is
    // about the missing base, not about this repo.
    const seeded = await withGh(gh, () => readyOutcome(repo.repoRoot, 4202, repo.originHead));
    assert(
      seeded.kind === "ok" && seeded.facts.baseSha === repo.originHead,
      `a seeded base makes ready ok at that sha (got ${seeded.kind} ${JSON.stringify(seeded.facts.failedRules)})`,
    );
  } finally {
    repo.dispose();
  }
}

// ── (f) the wiring the field run could not get through: command handlers, real
// engine, real repo — a green `ready` and a record that carries the base.
{
  const repo = originRepo();
  try {
    const seed = await leanSeed(repo.repoRoot);
    const dir = tempDir();
    try {
      // The handlers are built against the REAL repo — `readyOutcome` reads
      // git and the forge there — while the run's state file lives in the
      // scratch dir, which is what `repoRoot: dir.dir` below is for.
      const handlers = phase1Handlers(repo.repoRoot, 4203);
      const result = await withGh(fakeGhDir(BODY), () =>
        runLean({
          repoRoot: dir.dir,
          issue: 4203,
          // `specify` is stubbed: the real step dispatches a model. What this
          // case owns is that the seed reaches the record `ready` and `specify`
          // read, not what the step does with it (test-lean-specify.ts owns that).
          handlers: { ...handlers, specify: () => Promise.resolve({ kind: "ok" }) },
          seed: { version: seed.version, baseSha: seed.baseSha },
          now: () => 3,
        }),
      );
      const readyStep = result.run.steps.find((s) => s.state === "ready");
      assert(
        readyStep?.outcome?.kind === "ok",
        `ready is green once the run has a base (got ${JSON.stringify(readyStep?.outcome)})`,
      );
      assert(
        result.run.baseSha === repo.originHead,
        `the driven run's record carries the base (got ${JSON.stringify(result.run.baseSha)})`,
      );
    } finally {
      dir.cleanup();
    }
  } finally {
    repo.dispose();
  }
}

// ── (g) a non-empty base that names no object is a refusal, not a default config.
//
// `loadWorkConfig` reads through `gitType`/`gitShow`, which catch EVERY git
// failure and answer "absent" — right for a missing file, wrong for a missing
// COMMIT: a base that resolves to nothing used to look exactly like a repo with
// no `.pi/work.json` and `ready` returned `ok` with the defaults. The two cases
// below are the same mistake in both directions — a word that is not a ref, and
// forty hex characters that are not an object — because a stale or hand-edited
// resumed record can arrive as either.
{
  const repo = originRepo();
  try {
    const gh = fakeGhDir(BODY);
    const bogus = await withGh(gh, () => readyOutcome(repo.repoRoot, 4204, "not-a-ref!!"));
    assert(
      bogus.kind === "fail" &&
        bogus.facts.failedRules.some((r) => r.includes("is not a commit in this clone")),
      `a base that is not a ref fails ready (got ${bogus.kind} ${JSON.stringify(bogus.facts.failedRules)})`,
    );
    const hex = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const fake = await withGh(gh, () => readyOutcome(repo.repoRoot, 4204, hex));
    assert(
      fake.kind === "fail" &&
        fake.facts.failedRules.some(
          (r) => r.includes("is not a commit in this clone") && r.includes(hex),
        ),
      `forty hex characters that name no object fail ready (got ${fake.kind} ${JSON.stringify(fake.facts.failedRules)})`,
    );
    // A real base still passes the new gate, so the refusal above is about the
    // base and not about this repo.
    const real = await withGh(gh, () => readyOutcome(repo.repoRoot, 4204, repo.originHead));
    assert(
      real.kind === "ok" && real.facts.baseSha === repo.originHead,
      `a real base sha still gives ok (got ${real.kind} ${JSON.stringify(real.facts.failedRules)})`,
    );
    // A base the caller invented entirely is reported CLIPPED in the part the
    // harness composes: the sha is untrusted text going into an issue comment.
    // (git's own stderr echoes the ref back verbatim and is clipped separately,
    // which is why the assertion reads the `base sha …` prefix rather than the
    // whole rule. The base is `x` + 200 `a`, so its 80-char clip is `x` + 79 `a`.)
    const long = `x${"a".repeat(200)}`;
    const clipped = await withGh(gh, () => readyOutcome(repo.repoRoot, 4204, long));
    const clipRule = clipped.facts.failedRules.find((r) => r.startsWith("base sha ")) ?? "";
    assert(
      clipped.kind === "fail" &&
        clipRule.includes(`${"a".repeat(79)} is not a commit`) &&
        !clipRule.startsWith(`base sha ${long}`),
      `a long bogus base is clipped to 80 chars in the rule (got ${JSON.stringify(clipped.facts.failedRules)})`,
    );
  } finally {
    repo.dispose();
  }
}

// ── (h) a repo whose base commits NO .pi/work.json: the other half of the
// `workJson` knob, and the shape that made the bug above invisible. Absent
// config is legitimate, so this must stay `ok` — it is the *absent commit* that
// is refused, never the absent file.
{
  const repo = originRepo({ workJson: false });
  try {
    const seeded = await withGh(fakeGhDir(BODY), () =>
      readyOutcome(repo.repoRoot, 4205, repo.originHead),
    );
    assert(
      seeded.kind === "ok" && seeded.facts.config?.version === 1,
      `a base with no .pi/work.json still gives ok on defaults (got ${seeded.kind} ${JSON.stringify(seeded.facts.failedRules)})`,
    );
  } finally {
    repo.dispose();
  }
}

// ── (i) the seed's cause reaches the rule: `runWorkLean` always re-seeds
// through `leanSeed`, so the one line that threads a seed into the handlers is
// what `handlersFor` owns, and this drives it directly with a seed whose probe
// failed. A resumed run has no seed of this process's making; the run whose
// seed DID fail must still tell the operator what git said.
{
  const repo = originRepo();
  try {
    const dir = tempDir();
    try {
      const handlers = handlersFor(
        repo.repoRoot,
        4206,
        {},
        {
          version: "test",
          baseSha: "",
          why: "origin/HEAD: no such ref",
        },
      );
      const result = await withGh(fakeGhDir(BODY), () =>
        runLean({
          repoRoot: dir.dir,
          issue: 4206,
          // `decline` posts to the forge; this case owns the RULE the handler
          // recorded, and the comment that carries it is (f)'s shape.
          handlers: { ...handlers, decline: () => Promise.resolve({ kind: "done" }) },
          seed: { version: "test", baseSha: "" },
          now: () => 4,
        }),
      );
      const rules = result.run.steps.find((s) => s.state === "ready")?.outcome?.failedRules ?? [];
      assert(
        rules.some(
          (r) =>
            r.includes("could not resolve the mainline sha") &&
            r.includes("origin/HEAD: no such ref"),
        ),
        `a seed whose probe failed threads its cause into ready's rule (got ${JSON.stringify(rules)})`,
      );
    } finally {
      dir.cleanup();
    }
  } finally {
    repo.dispose();
  }
}

process.exit(failures());
