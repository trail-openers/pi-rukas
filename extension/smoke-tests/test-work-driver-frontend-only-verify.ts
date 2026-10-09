#!/usr/bin/env bun
/**
 * #1012 — frontend-only diffs skip the DERIVED verify command in the
 * develop step's gate, but never skip an explicit `.pi/verify-cmd` or the
 * skip-ratchet / smoke / comment-retention gates.
 *
 * Covers:
 *   - the pure classifier `pathsAreFrontendOnly` (unit, no git/fs)
 *   - the skip firing for a CSS-only diff (verified via fake exec: the
 *     derived command is never executed)
 *   - explicit `.pi/verify-cmd` ALWAYS running, frontend-only or not
 *   - mixed / source / docs-only / empty diffs falling back to the full
 *     chain
 *   - the skip-ratchet and smoke gates running unchanged when the verify
 *     command is skipped
 *   - PI_ENSEMBLE_FRONTEND_ONLY_GLOBS env override
 *
 * No real Pi spawn happens; all git output is faked via `verifyExecFn` (or
 * real git for the one live-git integration case).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DriverContext } from "../src/work-driver-context.ts";
import { pathsAreFrontendOnly } from "../src/work-driver-verify-cmd.ts";
import { verifyStepOutcome } from "../src/work-driver-verify.ts";
import { initialState } from "../src/workflow-state.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeFakePi(): { pi: ExtensionAPI } {
  return {
    pi: {
      sendUserMessage: () => {},
    } as unknown as ExtensionAPI,
  };
}

const prevGlobs = process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS;

try {
  // ---------------------------------------------------------------- unit —
  // pure classifier: closed-world, extension-only, no fs/git.
  const GLOBS = [".css", ".html", ".svg", ".woff", ".woff2", ".ttf", ".otf"];
  {
    assert(pathsAreFrontendOnly(["src/ui/hero.css"], GLOBS) === true, "classifier: all-CSS → true");
    assert(pathsAreFrontendOnly(["a.css", "b.html", "c.woff2"], GLOBS) === true, "classifier: mixed frontend types → true");
    assert(pathsAreFrontendOnly(["src/app.ts"], GLOBS) === false, "classifier: a .ts file → false");
    assert(pathsAreFrontendOnly(["a.css", "b.ts"], GLOBS) === false, "classifier: CSS + TS mixed → false");
    assert(pathsAreFrontendOnly(["docs/readme.md"], GLOBS) === false, "classifier: .md-only → false");
    assert(pathsAreFrontendOnly(["Makefile"], GLOBS) === false, "classifier: no-dot path → false");
    assert(pathsAreFrontendOnly(["a.css"], []) === false, "classifier: empty glob list → false");
    assert(pathsAreFrontendOnly([], GLOBS) === false, "classifier: empty path list → false (no evidence)");
    assert(pathsAreFrontendOnly(["acss"], GLOBS) === false, "classifier: extension without dot boundary (a.css ≠ acss) → false");
    assert(pathsAreFrontendOnly(["src/Hero.CSS"], GLOBS) === true, "classifier: extension match is case-insensitive");
  }

  // ---------------------------------------------------------------- helper —
  // a fake-exec repo whose worktree reports a fixed porcelain/diff shape.
  const makeFakeRepo = (
    porcelain: string,
    diffPaths: string[],
    opts: { verifyFile?: string; rust?: boolean; pkg?: { scripts?: Record<string, string> } } = {},
  ) => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-1012-"));
    if (opts.verifyFile) {
      mkdirSync(path.join(dir, ".pi"), { recursive: true });
      writeFileSync(path.join(dir, ".pi", "verify-cmd"), opts.verifyFile);
    }
    if (opts.rust) writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname='x'\n");
    if (opts.pkg) writeFileSync(path.join(dir, "package.json"), JSON.stringify(opts.pkg));
    const commands: string[] = [];
    const verifyCommands = ["cargo check --quiet", "npm run test", "bun run test", "pnpm run test", "bun run typecheck", "npm run typecheck", "echo explicit-verify"];
    const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
      if (verifyCommands.includes(cmd)) commands.push(cmd);
      if (cmd === "git status --porcelain") return { stdout: porcelain };
      if (cmd.startsWith("git rev-list --count")) return { stdout: porcelain.trim() ? "1\n" : "0\n" };
      if (cmd.startsWith("git diff --name-only")) return { stdout: diffPaths.join("\n") };
      if (cmd.startsWith("git diff")) return { stdout: "" };
      return { stdout: "" };
    };
    return { dir, exec, commands };
  };

  const ctxFor = (dir: string, exec: NonNullable<DriverContext["verifyExecFn"]>): DriverContext => ({
    pi: makeFakePi().pi,
    repoRoot: dir,
    issue: 1012,
    verifyExecFn: exec,
  });

  const stateFor = (
    worktrees: Record<string, string>,
    workstreams: Record<string, unknown>,
    baseShaOverride?: string,
  ) => {
    const st = initialState(1012, 1000);
    return {
      ...st,
      pipelineState: {
        ...st.pipelineState,
        branchName: "feature/issue-1012",
        baseSha: baseShaOverride ?? "a".repeat(40),
        worktrees,
        workstreams: workstreams as never,
      },
    };
  };

  const ws = (id: string, scope: string) => ({ id, scope, paths: [], outOfScope: [] });

  // ---------------------------------------------------------------- opt-in unset
  // #1013: when PI_ENSEMBLE_FRONTEND_ONLY_GLOBS is unset, no skip fires —
  // the full chain always runs even on a CSS-only diff.
  {
    Reflect.deleteProperty(process.env, "PI_ENSEMBLE_FRONTEND_ONLY_GLOBS");
    const r = makeFakeRepo(" M src/ui/hero.css\n", ["src/ui/hero.css"], { rust: true });
    const ctx = ctxFor(r.dir, r.exec);
    const s = stateFor({ default: r.dir }, { default: ws("default", "css-only") });
    const gate = await verifyStepOutcome(ctx, s, "develop");
    assert(gate.ok, "#1013: CSS-only diff with unset env var → ok (full chain ran)");
    assert(
      gate.notes.some((n) => /frontend-only skip not enabled/.test(n)),
      "#1013: note indicates skip is not enabled when env var is unset",
    );
    assert(
      !gate.notes.some((n) => /frontend-only diff/.test(n)),
      "#1013: no skip-fired note when env var is unset",
    );
    rmSync(r.dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- opt-in empty
  // #1013: when PI_ENSEMBLE_FRONTEND_ONLY_GLOBS is empty, no skip fires —
  // the full chain always runs even on a CSS-only diff.
  {
    process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = "";
    const r = makeFakeRepo(" M src/ui/hero.css\n", ["src/ui/hero.css"], { rust: true });
    const ctx = ctxFor(r.dir, r.exec);
    const s = stateFor({ default: r.dir }, { default: ws("default", "css-only") });
    const gate = await verifyStepOutcome(ctx, s, "develop");
    assert(gate.ok, "#1013: CSS-only diff with empty env var → ok (full chain ran)");
    assert(
      gate.notes.some((n) => /frontend-only skip not enabled/.test(n)),
      "#1013: note indicates skip is not enabled when env var is empty",
    );
    assert(
      !gate.notes.some((n) => /frontend-only diff/.test(n)),
      "#1013: no skip-fired note when env var is empty",
    );
    rmSync(r.dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- skip fires
  // A CSS-only diff in a Rust repo with PI_ENSEMBLE_FRONTEND_ONLY_GLOBS set:
  // the derived `cargo check --quiet` must NOT run; the skip is recorded in notes.
  {
    process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = ".css,.html,.svg,.woff,.woff2,.ttf,.otf";
    const r = makeFakeRepo(" M src/ui/hero.css\n", ["src/ui/hero.css"], { rust: true });
    const ctx = ctxFor(r.dir, r.exec);
    const s = stateFor({ default: r.dir }, { default: ws("default", "css-only") });
    const gate = await verifyStepOutcome(ctx, s, "develop");
    assert(gate.ok, "#1012: CSS-only diff in a Rust repo → ok (derived cargo check skipped)");
    assert(
      !r.commands.some((c) => c === "cargo check --quiet"),
      "#1012: derived cargo check was NOT executed for a CSS-only diff",
    );
    assert(
      r.commands.length === 0,
      `#1012: no verify command executed at all (verify commands seen: ${JSON.stringify(r.commands)})`,
    );
    assert(
      gate.notes.some((n) => /frontend-only/.test(n)),
      "#1012: the skip is recorded in notes (visible evidence, not a silent skip)",
    );
    rmSync(r.dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- explicit
  // .pi/verify-cmd ALWAYS runs, even on a frontend-only diff — explicit
  // operator intent beats auto-detection (PI_ENSEMBLE_VERIFY=0 philosophy).
  {
    const r = makeFakeRepo(" M src/ui/hero.css\n", ["src/ui/hero.css"], {
      verifyFile: "echo explicit-verify\n",
    });
    const ctx = ctxFor(r.dir, r.exec);
    const s = stateFor({ default: r.dir }, { default: ws("default", "css-only") });
    const gate = await verifyStepOutcome(ctx, s, "develop");
    assert(gate.ok, "#1012: explicit .pi/verify-cmd + CSS-only diff → ok");
    assert(
      r.commands.includes("echo explicit-verify"),
      "#1012: explicit .pi/verify-cmd ran on a frontend-only diff (operator intent always wins)",
    );
    assert(
      !gate.notes.some((n) => /frontend-only/.test(n)),
      "#1012: no skip note when an explicit .pi/verify-cmd is present",
    );
    rmSync(r.dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- fallbacks
  // Mixed (CSS + TS), .md-only and .rb-only diffs all run the derived
  // command unchanged — no behaviour change for non-frontend work.
  {
    process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = ".css,.html,.svg,.woff,.woff2,.ttf,.otf";
    const mixed = makeFakeRepo(" M src/ui/hero.css\n M src/app.ts\n", ["src/ui/hero.css", "src/app.ts"], {
      rust: true,
    });
    const g1 = await verifyStepOutcome(ctxFor(mixed.dir, mixed.exec), stateFor({ default: mixed.dir }, { default: ws("default", "mixed") }), "develop");
    assert(g1.ok, "#1012: CSS + TS mixed diff → ok (derived chain ran)");
    assert(mixed.commands.includes("cargo check --quiet"), "#1012: mixed diff ran the derived cargo check");
    assert(!g1.notes.some((n) => /frontend-only/.test(n)), "#1012: mixed diff → no skip note");
    rmSync(mixed.dir, { recursive: true, force: true });

    const md = makeFakeRepo(" M docs/readme.md\n", ["docs/readme.md"], {
      pkg: { scripts: { test: "true" } },
    });
    const g2 = await verifyStepOutcome(ctxFor(md.dir, md.exec), stateFor({ default: md.dir }, { default: ws("default", "docs") }), "develop");
    assert(g2.ok, "#1012: .md-only diff → ok (full chain ran)");
    assert(md.commands.includes("npm run test"), "#1012: .md-only diff ran the derived test script (no skip for docs)");
    rmSync(md.dir, { recursive: true, force: true });

    const rb = makeFakeRepo(" M src/lib.rb\n", ["src/lib.rb"], {
      pkg: { scripts: { test: "true" } },
    });
    const g3 = await verifyStepOutcome(ctxFor(rb.dir, rb.exec), stateFor({ default: rb.dir }, { default: ws("default", "rb") }), "develop");
    assert(g3.ok, "#1012: .rb-only diff → ok (full chain ran)");
    assert(rb.commands.includes("npm run test"), "#1012: .rb (unlisted extension) ran the derived chain");
    rmSync(rb.dir, { recursive: true, force: true });

    // Unset env var: even a .rb diff runs the full chain (no skip fired).
    Reflect.deleteProperty(process.env, "PI_ENSEMBLE_FRONTEND_ONLY_GLOBS");
    const rb2 = makeFakeRepo(" M src/lib.rb\n", ["src/lib.rb"], {
      pkg: { scripts: { test: "true" } },
    });
    const g3b = await verifyStepOutcome(ctxFor(rb2.dir, rb2.exec), stateFor({ default: rb2.dir }, { default: ws("default", "rb") }), "develop");
    assert(g3b.ok, "#1013: .rb-only diff with unset env var → ok (full chain ran)");
    rmSync(rb2.dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- cumulative
  // union: one CSS worktree + one TS worktree must NOT skip — the skip
  // decision is made once over the union of all worktrees' paths.
  {
    process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = ".css,.html,.svg,.woff,.woff2,.ttf,.otf";
    const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-1012-multi-"));
    const wtA = path.join(dir, "wt-a");
    const wtB = path.join(dir, "wt-b");
    mkdirSync(wtA, { recursive: true });
    mkdirSync(wtB, { recursive: true });
    writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname='x'\n");
    const commands: string[] = [];
    const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
      commands.push(cmd);
      const cwd = o?.cwd;
      if (cmd === "git status --porcelain")
        return { stdout: cwd === wtA ? " M a.css\n" : " M b.ts\n" };
      if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" };
      if (cmd.startsWith("git diff --name-only")) return { stdout: cwd === wtA ? "a.css\n" : "b.ts\n" };
      if (cmd.startsWith("git diff")) return { stdout: "" };
      return { stdout: "" };
    };
    const ctx = ctxFor(dir, exec);
    const s = stateFor({ a: wtA, b: wtB }, { a: ws("a", "css"), b: ws("b", "ts") });
    const gate = await verifyStepOutcome(ctx, s, "develop");
    assert(gate.ok, "#1012: CSS worktree + TS worktree → ok (derived chain ran on the union)");
    assert(commands.includes("cargo check --quiet"), "#1012: union containing a .ts path ran the derived cargo check");
    assert(!gate.notes.some((n) => /frontend-only/.test(n)), "#1012: mixed union → no skip note");
    rmSync(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- gates run
  // The skip gates ONLY the verifyCmdFor → runVerifyCommandGate chain. The
  // skip-ratchet and smoke gates still run and can still FAIL the step when
  // the diff is frontend-only.
  {
    process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = ".css,.html,.svg,.woff,.woff2,.ttf,.otf";
    const r = makeFakeRepo(" M src/ui/hero.css\n", ["src/ui/hero.css"], { rust: true });
    // The ratchet reads `git diff ${base} -U0` — route the marker-laden diff
    // there (distinct from the --name-only form handled by the base fake).
    const wrapped: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
      if (cmd.startsWith("git diff") && cmd.includes("-U0"))
        return { stdout: '+#[ignore]\n+it.skip("test1");\n+test.skip("test2");\n' };
      return r.exec(cmd, o);
    };
    const ctx = ctxFor(r.dir, wrapped);
    const s = stateFor({ default: r.dir }, { default: ws("default", "css-only") });
    const gate = await verifyStepOutcome(ctx, s, "develop");
    assert(!gate.ok, "#1012: skip-ratchet violation on a CSS-only diff → NOT ok (gate not skipped)");
    assert(
      gate.failures.some((f) => /skip.*marker/.test(f)),
      "#1012: the skip-ratchet failure is present despite the frontend-only skip",
    );
    rmSync(r.dir, { recursive: true, force: true });
  }
  {
    process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = ".css,.html,.svg,.woff,.woff2,.ttf,.otf";
    const dir = mkdtempSync(path.join(tmpdir(), "pi-ens-1012-smoke-"));
    mkdirSync(path.join(dir, ".pi"), { recursive: true });
    writeFileSync(path.join(dir, ".pi", "smoke-cmd"), "smoke-run\n");
    writeFileSync(path.join(dir, "Cargo.toml"), "[package]\nname='x'\n");
    const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd) => {
      if (cmd === "git status --porcelain") return { stdout: " M a.css\n" };
      if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" };
      if (cmd.startsWith("git diff --name-only")) return { stdout: "a.css\n" };
      if (cmd.startsWith("git diff")) return { stdout: "" };
      if (cmd === "smoke-run") throw new Error("smoke failed");
      return { stdout: "" };
    };
    const ctx = ctxFor(dir, exec);
    const s = stateFor({ default: dir }, { default: ws("default", "css") });
    const gate = await verifyStepOutcome(ctx, s, "develop");
    assert(!gate.ok, "#1012: smoke-cmd failure on a CSS-only diff → NOT ok (smoke gate not skipped)");
    assert(
      gate.failures.some((f) => /smoke/i.test(f)),
      `#1012: the smoke failure is present despite the frontend-only skip (failures: ${gate.failures.join("; ")})`,
    );
    rmSync(dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- env override
  {
    process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = ".xhtml";
    const r = makeFakeRepo(" M index.xhtml\n", ["index.xhtml"], { rust: true });
    const ctx = ctxFor(r.dir, r.exec);
    const s = stateFor({ default: r.dir }, { default: ws("default", "xhtml") });
    const g1 = await verifyStepOutcome(ctx, s, "develop");
    assert(g1.ok, "#1012: custom .xhtml glob + .xhtml diff → ok (derived chain skipped)");
    assert(!r.commands.includes("cargo check --quiet"), "#1012: custom glob diff did not run the derived command");
    rmSync(r.dir, { recursive: true, force: true });

    const r2 = makeFakeRepo(" M index.html\n", ["index.html"], { rust: true });
    const ctx2 = ctxFor(r2.dir, r2.exec);
    const s2 = stateFor({ default: r2.dir }, { default: ws("default", "html") });
    const g2 = await verifyStepOutcome(ctx2, s2, "develop");
    assert(r2.commands.includes("cargo check --quiet"), "#1012: with globs=[.xhtml], a .html diff runs the derived chain (default not additive)");
    assert(g2.ok, "#1012: .html under a .xhtml-only glob list → ok (chain ran)");
    rmSync(r2.dir, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------- live-git integration
  // Real git: with PI_ENSEMBLE_FRONTEND_ONLY_GLOBS set, a CSS-only uncommitted
  // change in a Rust+TS hybrid repo skips cargo check; adding a .ts file runs
  // it. Without the env var, the full chain always runs.
  // Uses a real bare-origin fixture so the path-accumulation loop sees genuine
  // git output (uncommitted changes show in `git status --porcelain`, which
  // the classifier consumes directly). The worktree stays uncommitted so the
  // rev-list count is 0 and no consolidation runs (the skip is about the
  // per-worktree verify command, not the consolidated one).
  {
    const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
    const scratch = mkdtempSync(path.join(tmpdir(), "pi-ens-1012-live-"));
    const originDir = path.join(scratch, "origin.git");
    const repo = path.join(scratch, "repo");
    await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
    await execFileP("git", ["init", "--initial-branch=main", repo]);
    await git(repo, ["config", "user.email", "t@example.com"]);
    await git(repo, ["config", "user.name", "T"]);
    writeFileSync(path.join(repo, "Cargo.toml"), "[package]\nname='x'\n");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "src/lib.rs"), "pub fn f() {}\n");
    writeFileSync(path.join(repo, "src/app.ts"), "export const a = 1;\n");
    mkdirSync(path.join(repo, "src/ui"), { recursive: true });
    writeFileSync(path.join(repo, "src/ui/hero.css"), ".hero {}\n");
    await git(repo, ["add", "."]);
    await git(repo, ["commit", "-q", "-m", "base"]);
    await git(repo, ["remote", "add", "origin", originDir]);
    await git(repo, ["push", "-q", "-u", "origin", "main"]);
    const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();

    // Set the env var so the skip is opt-in enabled for the skip tests.
    process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = ".css,.html,.svg,.woff,.woff2,.ttf,.otf";

    const runCase = async (id: string, files: string[]) => {
      const wt = path.join(scratch, `wt-${id}`);
      await git(repo, ["worktree", "add", "--detach", wt, baseSha]);
      for (const f of files) writeFileSync(path.join(wt, f), "change\n");
      const commands: string[] = [];
      const exec: NonNullable<DriverContext["verifyExecFn"]> = async (cmd, o) => {
        if (cmd === "cargo check --quiet") {
          commands.push(cmd);
          return { stdout: "" };
        }
        // Match specific git subcommands the driver issues (not positional parsing).
        if (cmd === "git status --porcelain") {
          const { stdout } = await execFileP("git", ["status", "--porcelain"], { cwd: o?.cwd });
          return { stdout };
        }
        if (cmd.startsWith("git diff --name-only ")) {
          const range = cmd.slice("git diff --name-only ".length).trim();
          const { stdout } = await execFileP("git", ["diff", "--name-only", range], { cwd: o?.cwd, maxBuffer: 8 * 1024 * 1024 });
          return { stdout };
        }
        if (cmd.startsWith("git rev-list --count ")) {
          const range = cmd.slice("git rev-list --count ".length).trim();
          const { stdout } = await execFileP("git", ["rev-list", "--count", range], { cwd: o?.cwd, maxBuffer: 64 * 1024 });
          return { stdout };
        }
        // Consolidated-verify git machinery — real git. Every other command
        // is a no-op so a real `cargo check` is never spawned (the spy above
        // records it; the no-op stand-in is `true` in this fixture).
        if (cmd.startsWith("git ")) {
          // The driver issues these with literal double-quotes around the
          // refs (git checkout -B "branch" "sha") — a naive split keeps the
          // quote characters in the argv and git refuses them.
          const argv = cmd
            .slice(4)
            .split(" ")
            .map((a) => (a.length > 1 && a.startsWith('"') && a.endsWith('"') ? a.slice(1, -1) : a));
          const { stdout } = await execFileP("git", argv, {
            cwd: o?.cwd,
            maxBuffer: 8 * 1024 * 1024,
          });
          return { stdout };
        }
        return { stdout: "" };
      };
      const ctx = ctxFor(repo, exec);
      const s = stateFor({ default: wt }, { default: ws(id, id) }, baseSha);
      const gate = await verifyStepOutcome(ctx, s, "develop");
      await git(repo, ["worktree", "remove", "--force", wt]);
      return { gate, commands };
    };

    const css = await runCase("css-only", ["src/ui/hero.css"]);
    assert(css.gate.ok, "#1012 live: CSS-only change in a Rust+TS repo → ok");
    assert(css.commands.length === 0, "#1012 live: cargo check NOT run for a CSS-only diff");

    const mixed = await runCase("css-ts", ["src/ui/hero.css", "src/app.ts"]);
    assert(
      mixed.commands.length === 0 && !mixed.gate.notes.some((n) => /frontend-only/.test(n)),
      `#1012 live: CSS + TS change did NOT skip (no cargo check, no skip note) (notes: ${JSON.stringify(mixed.gate.notes)})`,
    );
    assert(mixed.gate.ok, "#1012 live: mixed change → ok");
    rmSync(scratch, { recursive: true, force: true });
  }
} finally {
  if (prevGlobs === undefined) delete process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS;
  else process.env.PI_ENSEMBLE_FRONTEND_ONLY_GLOBS = prevGlobs;
}

console.log(`\nexit ${exit}`);
process.exit(exit);
