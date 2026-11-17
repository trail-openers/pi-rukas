#!/usr/bin/env bun
/**
 * lean/submodule-entries — what `listSubmodules` refuses, and the git facts behind each refusal.
 *
 * Two defects, both invisible to every other suite because each fails by saying NOTHING:
 *
 *   (a) a submodule NAME that cannot survive a command-line config assignment. The seeding names
 *       its source as `-c submodule.<name>.url=<path>`, and git splits that assignment at its
 *       FIRST `=` — measured, git 2.53, case (d) — so a name carrying one sets a key git never
 *       consults and leaves the intended one UNSET. `submodule update` then falls back to the URL
 *       the base's `.gitmodules` records while the `protocol.file.allow=always` on the same call
 *       licenses the transport: the offline rule fails OPEN to a network fetch on base content,
 *       green everywhere. A quote or whitespace does the same by moving where git thinks the
 *       section ends. The refusal is the same one already made for a line this step cannot prove
 *       it read, and it names the name, which is the thing to fix in the base;
 *   (b) `submoduleState`'s line parser. git prints the sigil IMMEDIATELY followed by the sha
 *       (`U<sha> <path>` for a gitlink with no git dir); with the sha optional the parser matched
 *       every line and matched none of them the way it claimed, so `unpopulated` stayed empty and
 *       the `unproven` backstop in `specify-reset.ts` was dead code — Resolution 3's "silence is
 *       never a pass" half, inert while its own case passed by another route.
 *
 * Real git throughout: both claims are about what git PRINTS and how git PARSES, and a stub can
 * print or parse anything.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { execp } from "../src/exec.ts";
import { SpecifyInfraError } from "../src/lean/specify-reset.ts";
import { listSubmodules } from "../src/lean/submodule-entries.ts";
import { submoduleState } from "../src/lean/specify-submodules.ts";
import type { ExecFn } from "../src/worktree.ts";
import { trackedTempDir } from "./lib/git-test-env.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { gitEnv, gitIn, plainRepo } from "./lib/lean-submodule-local-fixture.ts";

const { assert, failures } = makeAssert();

/** The product's executor: these cases are about git's own answers, so git is not stubbed. */
const exec: ExecFn = async (cmd, o) =>
  execp(cmd, { ...o, env: { ...gitEnv(), ...(o?.env ?? {}) } });

/** The sha `git submodule status` prints for a fixture submodule, asked of git itself. */
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SUB = "vendor/lib";

/** A `submodule status` answer, for the half of (b) that needs git's OTHER glyph. */
const answers =
  (out: string): ExecFn =>
  async () =>
    ({ stdout: out, exitCode: 0 }) as never;

/** A base whose `.gitmodules` holds one entry with exactly this name and path. */
function baseWith(tag: string, name: string, sub = SUB): string {
  const { repoRoot } = plainRepo(tag);
  writeFileSync(
    path.join(repoRoot, ".gitmodules"),
    `[submodule "${name}"]\n\tpath = ${sub}\n\turl = https://example.invalid/x.git\n`,
  );
  return repoRoot;
}

// ── (a) an unusable name is a refusal that names the name
{
  // `=` and a space are the two shapes git itself will not round-trip through a command-line
  // assignment; both are printed UNQUOTED by `--get-regexp path`, so they reach this parser bare
  // (measured, git 2.53, case (d)). A quote cannot be forged here — git C-quotes a name
  // containing one on the way out, and a name holding a real `"` is a config file git itself
  // refuses to parse — so the `"` in the filter is the belt beside those braces, not a third
  // case. A tab is neither: git prints it raw and re-reads `-c submodule.a<TAB>b.url` as the
  // same key it stored, so filtering one would refuse a base whose submodule seeds correctly.
  for (const [label, name] of [
    ["an equals sign", "we=ird"],
    ["a space", "with space"],
  ] as const) {
    const repoRoot = baseWith(`name-${label.replace(/\W/g, "-")}`, name);
    let threw: Error | undefined;
    let listed: unknown;
    try {
      listed = await listSubmodules(exec, repoRoot);
    } catch (err) {
      threw = err as Error;
    }
    assert(
      threw instanceof SpecifyInfraError,
      `(a) a submodule name with ${label} is refused, not silently listed (got ${
        threw?.name ?? `listed ${JSON.stringify(listed)}`
      })`,
    );
    assert(
      threw?.message.includes(name) === true,
      `(a) and the refusal prints the name it could not use — the thing to fix in the base (got ${String(
        threw?.message?.slice(0, 180),
      )})`,
    );
    // The premise, asked of git rather than asserted: the name really does reach this parser
    // bare, so the refusal is the last place that can still see it.
    const printed = spawnSync(
      "git",
      ["config", "--file", ".gitmodules", "--get-regexp", "path"],
      { cwd: repoRoot, encoding: "utf8", env: gitEnv() },
    );
    assert(
      (printed.stdout ?? "").includes(`submodule.${name}.path`),
      `(a) and git printed that name unquoted on the key, so nothing upstream neutralised it (got ${JSON.stringify(
        (printed.stdout ?? "").trim(),
      )})`,
    );
  }
}

// ── (b) the tree read: git's own `submodule status` output, parsed for what it says
{
  // A base that registers a gitlink nothing on this host holds — no module store, no checkout.
  // Built by hand rather than stubbed because the claim is the SHAPE of git's line.
  const repo = trackedTempDir("submodule-state-");
  gitIn(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, ".gitmodules"), `[submodule "${SUB}"]\n\tpath = ${SUB}\n`);
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  // `update-index --cacheinfo` is git's own way to record a gitlink, and `git add -A` afterwards
  // reads that path back as an ordinary deletion and drops it — so the entry is re-written after
  // the last `add` and the commit is checked to actually carry it, or every assertion below would
  // be about a base with no submodule in it at all.
  gitIn(repo, "update-index", "--add", "--cacheinfo", `160000,${SHA},${SUB}`);
  writeFileSync(path.join(repo, "tracked"), "x\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "update-index", "--add", "--cacheinfo", `160000,${SHA},${SUB}`);
  gitIn(repo, "commit", "-q", "-m", "carry a gitlink nothing holds");
  assert(
    gitIn(repo, "ls-tree", "HEAD", "--", SUB).startsWith("160000 commit "),
    `(b) the base really registers ${SUB} as a gitlink (got ${JSON.stringify(
      gitIn(repo, "ls-tree", "HEAD", "--", SUB),
    )})`,
  );
  const status = gitIn(repo, "submodule", "status", "--", SUB);
  // The premise the whole case rests on, asked of git. Two things are pinned here and both were
  // wrong before: the sha is printed (the old parser's optional sha matched lines git does not
  // produce) and the sigil is IMMEDIATELY followed by it — no space, which the old `\s+` demanded
  // and which is why the branch below never fired on real output.
  //
  // The glyph git prints for "registered and nothing checked out" on git 2.53 is `-`, not the `U`
  // the comment here claimed: `U` is an UNMERGED path (three index stages), a state no submodule
  // pass of this step can produce, so a parser that recognised only `U` reported every genuinely
  // unpopulated submodule as fine. Both are read; the canary below fails the moment git's answer
  // stops being one of them, which is the only way a future git that changes the spelling is caught
  // rather than silently disabling the backstop.
  assert(
    /^[-U][0-9a-f]{40} vendor\/lib$/u.test(status),
    `(b) git's own line for that state is the sigil then the sha then the path, no space (got ${JSON.stringify(
      status,
    )})`,
  );
  const state = await submoduleState(exec, repo);
  assert(
    state?.unpopulated.includes(SUB) === true,
    `(b) so the read of the tree reports the PATH unpopulated — the backstop fires rather than staying silent (got ${JSON.stringify(
      state,
    )})`,
  );
  assert(
    state?.registered.includes(SUB) === true,
    `(b) and still lists the path as registered, which is the pair the clause is built from (got ${JSON.stringify(
      state?.registered,
    )})`,
  );
  // The other glyph, same parser: a populated submodule is listed and never disclosed, so the
  // backstop is a filter and not a catch-all that names every submodule in the tree.
  const populated = await submoduleState(
    answers(` ${SHA} ${SUB} (heads/main)\n`),
    repo,
  );
  assert(
    populated?.unpopulated.length === 0 && populated?.registered.includes(SUB) === true,
    `(b) and a populated submodule is registered but never disclosed (got ${JSON.stringify(
      populated,
    )})`,
  );
}

// ── (c) the ordinary name still lists, so (a) is a filter and not a broken parser
{
  const repoRoot = baseWith("name-ok", SUB);
  const listed = await listSubmodules(exec, repoRoot);
  assert(
    listed?.length === 1 && listed[0]?.name === SUB && listed[0]?.path === SUB,
    `(c) an ordinary name still lists, name and path intact (got ${JSON.stringify(listed)})`,
  );
}

// ── (d) the git behaviour (a) exists for, measured rather than assumed
{
  const { repoRoot } = plainRepo("name-git");
  const shown = spawnSync(
    "git",
    ["-c", "submodule.a=b.url=SRC", "config", "--get-regexp", "submodule"],
    { cwd: repoRoot, encoding: "utf8", env: gitEnv() },
  );
  const out = (shown.stdout ?? "").trim();
  assert(
    shown.status === 0 && out === "submodule.a b.url=SRC",
    `(d) git's cmdline parser splits the assignment at the first = and sets a different key (rc ${String(
      shown.status,
    )}, got ${JSON.stringify(out)})`,
  );
  const intended = spawnSync(
    "git",
    ["-c", "submodule.a=b.url=SRC", "config", "--get", "submodule.a=b.url"],
    { cwd: repoRoot, encoding: "utf8", env: gitEnv() },
  );
  assert(
    intended.status !== 0,
    `(d) and the key the seeding meant to set is genuinely unset, which is what lets git fall back to the recorded URL (rc ${String(
      intended.status,
    )}, stdout ${JSON.stringify((intended.stdout ?? "").trim())})`,
  );
}

process.exit(failures() === 0 ? 0 : 1);
