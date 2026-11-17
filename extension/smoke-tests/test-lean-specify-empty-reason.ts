#!/usr/bin/env bun
/**
 * lean/specify-run — the submodule disclosure reaches the reason of EVERY outcome kind.
 *
 * #2319 Resolution 4: the disclosure is folded into each caller's outcome reason, never only a
 * trace line. `committed` already carried it; `empty` did not — and `empty` is the kind whose
 * record the operator reads to learn why nothing was frozen. A submodule this step seeded nothing
 * into is the best available explanation for a submitted test that died on a missing vendored
 * import, and a bare `empty` reason leaves the reader to conclude the adversary simply wrote
 * nothing red.
 *
 * Driven through `runTestPipeline` directly rather than through `specify`: at the step's top
 * level `specify.ts` folds `provisioning.problem` into whatever reason it is handed, so a case
 * there cannot tell `empty`'s own composition from a fold made after it. Here the reason is the
 * pipeline's, byte for byte.
 *
 *   (a) `empty` over a tree whose submodule pass supplied nothing: the reason names the path;
 *   (b) the seeded control: same round, nothing unpopulated, and the reason says nothing about
 *       submodules — so (a) cannot pass by appending the clause unconditionally.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { SpecifyInfraError, runTestPipeline } from "../src/lean/specify-run.ts";
import type { ExecFn } from "../src/worktree.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const SUB = "vendor/lib";

/**
 * One pipeline round over a real git tree whose reset left a submodule unpopulated.
 *
 * `unpopulated` decides which half of the pair is exercised: when something could not be
 * supplied, the step hands the pipeline the clause it built from its own notes; when the pass
 * seeded everything it hands `undefined`, which is the control that keeps (a) from passing on an
 * unconditional append. The submitted test exits green at the base, which is what makes the round
 * `empty` at all.
 */
async function drive(
  issue: number,
  unpopulated: string | undefined,
): Promise<{ threw?: unknown; kind?: string; reason?: string }> {
  const wt = mkdtempSync(`${process.env.TMPDIR ?? "/tmp"}/pi-lean-empty-`);
  const rel = "tests/AC1-green.test.sh";
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    HOME: wt,
    XDG_CONFIG_HOME: wt,
  };
  const git = (...argv: string[]): string => {
    const r = spawnSync("git", ["-C", wt, ...argv], { encoding: "utf8", env });
    if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${r.stderr}`);
    return (r.stdout ?? "").trim();
  };
  // A runner that PASSES: green at the base is what drops the file and empties the round.
  const exec: ExecFn = async (cmd, opts) => {
    if (cmd === "sh") return { stdout: "ok\n", stderr: "" };
    const argv = (opts?.argv ?? []) as string[];
    const r = spawnSync("git", ["-C", (opts?.cwd as string) ?? wt, ...argv], {
      encoding: "utf8",
      env,
      input: "",
    });
    if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${(r.stderr ?? "").trim()}`);
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const out: { threw?: unknown; kind?: string; reason?: string } = {};
  try {
    git("init", "-q", "-b", "main");
    writeFileSync(`${wt}/a.ts`, "1\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    const headBefore = git("rev-parse", "HEAD");
    writeFileSync(`${wt}/tests`, "", { flag: "a" });
    rmSync(`${wt}/tests`, { force: true });
    // The child's test, which the proof will run and find green.
    const dir = `${wt}/tests`;
    spawnSync("mkdir", ["-p", dir]);
    writeFileSync(`${wt}/${rel}`, "#!/bin/sh\necho ok\nexit 0\n", { mode: 0o755 });
    const verdict = await runTestPipeline(
      {
        exec,
        wt,
        repoRoot: wt,
        issue,
        branch: "main",
        headBefore,
        runnerTemplate: "sh {file}",
        wanted: ["AC1"],
        coverage: "any-red",
        extract: () => ({ rows: [{ criterionId: "AC1", testFiles: [rel] }], skipped: 0 }),
        validate: async (rows) => ({ kept: rows, dropped: [] }),
        // The seam the reset's owner uses: `problem` is what the tree-preparation step reports
        // about ITS pass, and `prepare` re-runs after the pipeline's own reset — so this is the
        // same channel production fills, not a value this case invents.
        prepare: async () =>
          unpopulated === undefined
            ? { wt, linked: [] }
            : {
                wt,
                linked: [],
                problem: `submodules are not populated: "${unpopulated}" — the superproject holds neither a module store nor a populated checkout for these paths, so this step seeded nothing there`,
              },
        commitMessage: "test: empty round",
      },
      { toolUses: [] },
    );
    out.kind = verdict.kind;
    out.reason = (verdict as { reason?: string }).reason;
  } catch (err) {
    out.threw = err;
  } finally {
    rmSync(wt, { recursive: true, force: true });
  }
  return out;
}

// ── (a) the `empty` kind carries the disclosure
{
  const empty = await drive(931, SUB);
  assert(
    empty.threw === undefined && empty.kind === "empty",
    `(a) the round came back empty (${empty.threw instanceof SpecifyInfraError ? `infra: ${String((empty.threw as Error).message)}` : `kind ${String(empty.kind)}`})`,
  );
  assert(
    (empty.reason ?? "").includes(SUB) && /seeded nothing there/.test(empty.reason ?? ""),
    `(a) and the empty reason carries the submodule disclosure rather than leaving the reader to guess why nothing was red (reason ${JSON.stringify(empty.reason)})`,
  );
}

// ── (b) the control: with nothing unpopulated, the reason says nothing about submodules
{
  const seeded = await drive(932, undefined);
  assert(
    seeded.threw === undefined && seeded.kind === "empty",
    `(b) the control round also came back empty (${seeded.threw instanceof SpecifyInfraError ? `infra: ${String((seeded.threw as Error).message)}` : `kind ${String(seeded.kind)}`})`,
  );
  assert(
    (seeded.reason ?? "").includes("seeded nothing there") === false,
    `(b) and its reason says nothing about submodules — the step working is not a caveat, so (a) cannot pass by always saying it (reason ${JSON.stringify(seeded.reason)})`,
  );
}

process.exit(failures());
