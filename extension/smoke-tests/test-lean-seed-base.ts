#!/usr/bin/env bun
/**
 * The `work-lean` base sha: seeded from the mainline, pinned to an immutable
 * oid, and refused by `ready` when it is neither.
 *
 * The cases and what each pins are enumerated in the header of
 * `lib/lean-seed-fixtures.ts` — the fixtures file is the one place that list is
 * written, because the two files are one suite split at the fixtures/cases seam
 * (this one crossed AGENTS.md §12's line cap when the immutable-oid refusals
 * landed) and a reader of either should see the whole shape.
 *
 * Read `lib/lean-seed-fixtures.ts` for why the forge is a `cat` script and not a
 * `printf`, and why `git remote set-head` is what makes the whole bug class
 * reachable in a temp repo at all.
 */

// ── (a)–(k): the whole inventory these cases and `lib/lean-seed-fixtures.ts`
// share, kept at the TOP of the file because a reader deciding what is covered
// should not have to reach the bottom of either file for it. The fixtures file
// repeats the same list from the other side of the seam; the words live there.
//
//   (a) the seed resolves origin/HEAD, the ref every later base read goes through
//   (b) no mainline at all: seeds "" and does NOT throw
//   (c) the seed lands on the record, and specify's own read sees it
//   (d) a resume keeps the base its first round recorded — a NON-terminal record
//       driven with a differing seed, so the assertion is about the base and not
//       about a short-circuit
//   (e) an empty base is a `ready` refusal naming the mainline rule, not a throw
//   (f) the wiring: command handlers, real engine, real repo — green `ready`,
//       record carrying the base
//   (g) a non-empty base that names no object is a refusal, not a default config,
//       and the refused value is clipped in the rule
//   (h) a base whose commit carries no `.pi/work.json` is still `ok`
//   (i) the seed's cause reaches the rule through `handlersFor`
//   (j) the base is pinned to an IMMUTABLE oid, not merely to something git will
//       resolve (`main`, `HEAD`, a suffix chain, an 8-hex prefix, an uppercase
//       full sha all refused; a real full sha still `ok`)
//   (k) a git INFRASTRUCTURE fault is not a refusal: the second probe's answer
//       decides, and a fault THROWS so the run hands back rather than posting
//       "not a commit" on an issue whose clone merely could not be asked
//   (l) the seeder PEELS too: an oid-shaped mainline that is not a commit seeds
//       "" with a reason naming the value, never a base the clone cannot show
//   (m) a base that resolves to a DIFFERENT oid is refused and the rule says what
//       it resolved to; a refused base is never echoed in the facts
//
// (k)–(m) are the git-behaviour half of the suite and live in
// `test-lean-base-infra.ts`; they drive the git seam through `originRepo`'s
// `fakeGit` and assert on the argv the code asked for, so a skipped peel or a
// skipped equality check fails a case instead of passing one.

import { readFileSync } from "node:fs";
import { handlersFor, leanSeed, phase1Handlers, readyOutcome } from "../src/lean/command.ts";
import { type LeanHandler, runLean } from "../src/lean/engine.ts";
import { leanStateFile } from "../src/lean/state.ts";
import { HAPPY, makeAssert, scripted, seedUpTo, tempDir } from "./lib/lean-engine-fixtures.ts";
import { BODY, fakeGhDir, originRepo, withGh, withGitBin } from "./lib/lean-seed-fixtures.ts";

const { assert, failures } = makeAssert();

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
    // …and it is NOT marked as infrastructure. A clone with no mainline is a
    // fact about the repository the issue lives in, and `ready` has to be able
    // to post it; only a git that could not be asked at all marks its seed
    // `infra` (the handback half is `test-lean-seed-infra.ts`, where a seed
    // whose proof throws ends the run handed-back rather than not-ready).
    assert(
      seed.infra !== true,
      `an absent mainline is a refusal the issue is told about, not an infra fault (got ${JSON.stringify(seed.infra)})`,
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
      specify: async (ctx: Parameters<LeanHandler>[0]) => {
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
    const onDisk = JSON.parse(readFileSync(leanStateFile(dir.dir, 4201), "utf8")) as {
      baseSha?: string;
    };
    assert(
      onDisk.baseSha === BASE,
      `the persisted record carries it too (got ${JSON.stringify(onDisk.baseSha)})`,
    );

    // (d) A resume keeps the recorded base: the seed is for a NEW run only, so
    // a mainline that moved cannot become this run's base mid-flight. The
    // record is NON-terminal (mid-walk at `review`) and is built by the same
    // fixture a real drive goes through, so this asserts the resume path rather
    // than the short-circuit a finished record takes — and the base it must
    // keep is a real oid that DIFFERS from the seed below, which is the only
    // shape that distinguishes "kept the record" from "took whatever came in".
    const moved = "ffffffffffffffffffffffffffffffffffffffff";
    seedUpTo(dir.dir, 4201, "review", { baseSha: BASE });
    const resumed = await runLean({
      repoRoot: dir.dir,
      issue: 4201,
      // The states before `review` are already in the log, so only `review`
      // onward runs; the seed is what must NOT be adopted.
      handlers: scripted(HAPPY).handlers,
      seed: { version: "test", baseSha: moved },
      now: () => 2,
    });
    assert(
      resumed.run.baseSha === BASE,
      `a resumed run keeps its recorded base, not the seed (got ${JSON.stringify(resumed.run.baseSha)})`,
    );
    assert(
      resumed.run.baseSha !== moved,
      "the differing seed is not what the record ended up carrying",
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
    const ready = await withGh(gh, () => readyOutcome(repo.repoRoot, 4202, { baseSha: "" }));
    assert(
      ready.kind === "fail" &&
        ready.facts.failedRules.some((r) => r.includes("could not resolve the mainline sha")),
      `an empty base fails ready with the mainline rule (got ${ready.kind} ${JSON.stringify(ready.facts.failedRules)})`,
    );
    // The seed's own cause reaches the comment, which is what separates "this
    // clone has no origin/HEAD" from "git broke" for the operator reading it.
    const withWhy = await withGh(gh, () =>
      readyOutcome(repo.repoRoot, 4202, { baseSha: "", why: "origin/HEAD: no such ref" }),
    );
    assert(
      withWhy.facts.failedRules.some((r) => r.includes("origin/HEAD: no such ref")),
      `the seed's cause is quoted in the rule (got ${JSON.stringify(withWhy.facts.failedRules)})`,
    );
    // A run seeded with the real base gets a green ready: the refusal above is
    // about the missing base, not about this repo.
    const seeded = await withGh(gh, () =>
      readyOutcome(repo.repoRoot, 4202, { baseSha: repo.originHead }),
    );
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
    const bogus = await withGh(gh, () =>
      readyOutcome(repo.repoRoot, 4204, { baseSha: "not-a-ref!!" }),
    );
    assert(
      bogus.kind === "fail" &&
        bogus.facts.failedRules.some((r) => r.includes("is not a full commit sha")),
      `a base that is not an oid fails ready with the SHAPE rule (got ${bogus.kind} ${JSON.stringify(bogus.facts.failedRules)})`,
    );
    const hex = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const fake = await withGh(gh, () => readyOutcome(repo.repoRoot, 4204, { baseSha: hex }));
    assert(
      fake.kind === "fail" &&
        fake.facts.failedRules.some(
          (r) => r.includes("is not a commit in this clone") && r.includes(hex),
        ),
      `forty hex characters that name no object fail ready (got ${fake.kind} ${JSON.stringify(fake.facts.failedRules)})`,
    );
    // A base the caller invented entirely is reported CLIPPED in the part the
    // harness composes: the sha is untrusted text going into an issue comment.
    // (git no longer echoes the ref back at all — the resolution moved into
    // `resolveHeadSha`, which traces rather than returns a message — so the rule
    // is exactly `base sha <clip> is not a full commit sha` (this value is not
    // even oid-shaped, so it is the shape rule that refuses it), and the
    // assertion below pins the whole string. The base is `x` + 200 `a`, so its
    // 80-char clip is `x` + 79 `a`, plus the ellipsis `oneLine` appends.)
    const long = `x${"a".repeat(200)}`;
    const clipped = await withGh(gh, () => readyOutcome(repo.repoRoot, 4204, { baseSha: long }));
    const clipRule = clipped.facts.failedRules.find((r) => r.startsWith("base sha ")) ?? "";
    assert(
      clipped.kind === "fail" &&
        clipRule === `base sha x${"a".repeat(79)}… is not a full commit sha` &&
        !clipRule.startsWith(`base sha ${long}`),
      `a long bogus base is clipped to 80 chars in the rule (got ${JSON.stringify(clipped.facts.failedRules)})`,
    );
    // Neither refusal echoes the value in the FACTS: the rule carries it once,
    // clipped, and a second unclipped copy in the facts is a second renderer a
    // later reader has to remember.
    assert(
      (clipped.facts as { baseSha?: string }).baseSha === undefined,
      `a refused base is not echoed in the facts (got ${JSON.stringify((clipped.facts as { baseSha?: string }).baseSha)})`,
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
      readyOutcome(repo.repoRoot, 4205, { baseSha: repo.originHead }),
    );
    assert(
      seeded.kind === "ok" && seeded.facts.config?.version === 1,
      `a base with no .pi/work.json still gives ok on defaults (got ${seeded.kind} ${JSON.stringify(seeded.facts.failedRules)})`,
    );
  } finally {
    repo.dispose();
  }
}

// ── (j) the base must be an IMMUTABLE oid, not merely a string git resolves.
//
// The first version of this gate ran the caller's string through
// `rev-parse --verify <base>^{commit}` and accepted ANY 40-hex answer. That
// proves a resolution happened, not that the base named the object: `main`,
// `HEAD` and `@{0}` all resolve, a suffix chain such as
// ``main^{commit}`touch x`@{0}`` resolves to main's tip through the
// backtick-quoting git's own rev syntax allows, and an 8-hex prefix or a
// mixed-case full sha resolve to a DIFFERENT spelling than the one the record
// carries — so every later equality check against the base silently misses.
// All five are refused by requiring a full lowercase oid that resolves back to
// itself. The real sha still answers `ok`, which is what makes the refusals
// about the base and not about this repo.
{
  const repo = originRepo();
  try {
    const gh = fakeGhDir(BODY);
    const refusals: Array<[string, string, string]> = [
      ["a branch name", "main", "is not a full commit sha"],
      ["HEAD", "HEAD", "is not a full commit sha"],
      [
        "a suffix chain through backtick quoting",
        "main^{commit}`touch x`@{0}",
        "is not a full commit sha",
      ],
      ["an 8-hex prefix of the real tip", repo.tip.slice(0, 8), "is not a full commit sha"],
    ];
    for (const [label, value, rule] of refusals) {
      const out = await withGh(gh, () => readyOutcome(repo.repoRoot, 4207, { baseSha: value }));
      assert(
        out.kind === "fail" &&
          out.facts.failedRules.some((r) => r.startsWith(`base sha ${value} ${rule}`)),
        `${label} (${JSON.stringify(value)}) is refused by ready (got ${out.kind} ${JSON.stringify(out.facts.failedRules)})`,
      );
    }
    // An uppercase full sha names a real commit and is still refused: it is not
    // the canonical spelling, so a later string equality against it cannot
    // settle. Probed against a repo with no remote at all, so the value cannot
    // accidentally be a ref that resolves.
    const upper = repo.tip.toUpperCase();
    const noOrigin = originRepo({ withOrigin: false });
    try {
      const out = await withGh(fakeGhDir(BODY), () =>
        readyOutcome(noOrigin.repoRoot, 4208, { baseSha: upper }),
      );
      assert(
        out.kind === "fail" &&
          out.facts.failedRules.some(
            (r) =>
              r.startsWith("base sha ") &&
              r.includes(upper) &&
              r.includes("is not a full commit sha"),
          ),
        `an uppercase full sha is refused by ready (got ${out.kind} ${JSON.stringify(out.facts.failedRules)})`,
      );
      const good = await withGh(fakeGhDir(BODY), () =>
        readyOutcome(noOrigin.repoRoot, 4208, { baseSha: noOrigin.tip }),
      );
      assert(
        good.kind === "ok" && good.facts.baseSha === noOrigin.tip,
        `the same commit as a full lowercase sha still gives ok (got ${good.kind} ${JSON.stringify(good.facts.failedRules)})`,
      );
    } finally {
      noOrigin.dispose();
    }
    // And in the repo WITH a remote, where `main` is a real resolvable ref: the
    // refusal above must be about the shape, not about git failing.
    const real = await withGh(gh, () =>
      readyOutcome(repo.repoRoot, 4207, { baseSha: repo.originHead }),
    );
    assert(
      real.kind === "ok" && real.facts.baseSha === repo.originHead,
      `a real full sha still gives ok (got ${real.kind} ${JSON.stringify(real.facts.failedRules)})`,
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
