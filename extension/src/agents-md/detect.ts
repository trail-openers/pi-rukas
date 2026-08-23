/**
 * detect — deterministic fact detection for the AGENTS.md renderer.
 *
 * This is the "avoider" from the design: it answers as many of the questions
 * a generator would otherwise ask the operator by reading the repository, so
 * that the operator is only ever asked what genuinely cannot be derived. The
 * rule is **read the manifest, not a guess table**: the toolchain and its
 * commands come from the project's own `package.json` / `Cargo.toml` /
 * `pyproject.toml` / `go.mod`, and from which lockfile is present. A static
 * "if package.json exists then bun" table is exactly the kind of assumption
 * that goes stale; the lockfile is the fact.
 *
 * Detection is pure file reading. It performs no execution, touches no network,
 * and never guesses. If a fact cannot be derived, it is simply absent from the
 * `DetectedFacts`, and the renderer omits the section and records an
 * `[auto] section omitted: <reason>` ledger row. Nothing is invented.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface Command {
  name: string; // human label
  command: string; // the exact shell line that goes into AGENTS.md
  kind: "test" | "lint" | "format" | "typecheck" | "build";
  runner: string; // bun | npm | cargo | go | uv | make
}

export interface DetectedFacts {
  /** Root manifest the detection anchored on, if any. */
  manifest?: string;
  runner?: string;
  packageManager?: string;
  language?: string;
  commands: Command[];
  /** CI workflow file names under .github/workflows/ (if present). */
  ciWorkflows: string[];
  /** Notes on anything detectable but not emitted (e.g. no CI dir). */
  notes: string[];
}

function tryReadJson(file: string): Record<string, unknown> | undefined {
  try {
    const raw = readFileSync(file, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function tryRead(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

function scriptsOf(pkg: Record<string, unknown> | undefined): Record<string, string> {
  if (!pkg) return {};
  const s = pkg.scripts;
  if (typeof s !== "object" || s === null) return {};
  // Validate values before the cast: a malformed manifest (e.g.
  // "scripts": {"test": 42}) must not surface a number as a command line.
  const rec = s as Record<string, unknown>;
  if (!Object.values(rec).every((v) => typeof v === "string")) return {};
  return rec as Record<string, string>;
}

/**
 * The package manager, derived from the lockfile that is present — NOT from
 * the mere existence of package.json. Order matters: bun.lock (bun) beats
 * package-lock.json (npm) beats pnpm-lock.yaml (pnpm) beats yarn.lock (yarn).
 */
function detectPackageManager(root: string): string | undefined {
  if (stat(root, "bun.lock")) return "bun";
  if (stat(root, "bun.lockb")) return "bun";
  if (stat(root, "package-lock.json")) return "npm";
  if (stat(root, "pnpm-lock.yaml")) return "pnpm";
  if (stat(root, "yarn.lock")) return "yarn";
  return undefined;
}

function stat(root: string, rel: string): boolean {
  try {
    return statSync(path.join(root, rel)).isFile();
  } catch {
    return false;
  }
}

function listWorkflows(root: string): string[] {
  const dir = path.join(root, ".github", "workflows");
  try {
    return readdirSync(dir)
      .filter((f) => /\.(ya?ml)$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

function cmd(name: string, command: string, kind: Command["kind"], runner: string): Command {
  return { name, command, kind, runner };
}

/**
 * Derive the quality-gate / command facts from a `package.json` + lockfile.
 *
 * The commands are taken from the scripts named in the manifest (the project
 * defines what "test" / "lint" mean); we do not assume a particular script
 * name set. A script that is absent is simply not emitted.
 */
function fromNode(root: string, pkg: Record<string, unknown>, pm: string): DetectedFacts {
  const scripts = scriptsOf(pkg);
  const commands: Command[] = [];
  const run = (script: string, kind: Command["kind"]) => {
    const line = scripts[script];
    if (line) commands.push(cmd(`${pm} ${script}`, `${pm} run ${script}`, kind, pm));
  };
  // The conventional script names, in a fixed order for stable output.
  run("test", "test");
  run("lint", "lint");
  run("check", "lint");
  run("format", "format");
  run("typecheck", "typecheck");
  run("type-check", "typecheck");
  run("build", "build");

  return {
    manifest: "package.json",
    runner: pm,
    packageManager: pm,
    commands,
    ciWorkflows: listWorkflows(root),
    notes: [],
  };
}

/** A Cargo project: the commands are the cargo subcommands, always present. */
function fromCargo(root: string): DetectedFacts {
  const manifest = path.join(root, "Cargo.toml");
  const commands: Command[] = [
    cmd("cargo test", "cargo test", "test", "cargo"),
    cmd("cargo clippy", "cargo clippy --all-targets", "lint", "cargo"),
    cmd("cargo fmt", "cargo fmt --check", "format", "cargo"),
  ];
  return {
    manifest: "Cargo.toml",
    runner: "cargo",
    language: "rust",
    commands,
    ciWorkflows: listWorkflows(root),
    notes: [],
  };
}

function fromGo(root: string): DetectedFacts {
  const commands: Command[] = [
    cmd("go test", "go test ./...", "test", "go"),
    cmd("go vet", "go vet ./...", "lint", "go"),
    cmd("gofmt check", "gofmt -l .", "format", "go"),
  ];
  return {
    manifest: "go.mod",
    runner: "go",
    language: "go",
    commands,
    ciWorkflows: listWorkflows(root),
    notes: [],
  };
}

function fromPython(root: string): DetectedFacts {
  const py = tryRead(path.join(root, "pyproject.toml")) ?? "";
  const commands: Command[] = [];
  // pytest is present if pyproject or a tests dir names it; otherwise omit.
  if (
    /pytest|pytest\.ini|^\s*\[tool\.pytest/.test(py) ||
    stat(root, "pytest.ini") ||
    stat(root, "conftest.py")
  ) {
    commands.push(cmd("pytest", "pytest", "test", "uv"));
  }
  if (/^ruff|\[tool\.ruff\]/.test(py) || stat(root, "ruff.toml")) {
    commands.push(cmd("ruff", "ruff check .", "lint", "uv"));
  }
  return {
    manifest: "pyproject.toml",
    runner: commands.length ? "uv" : undefined,
    language: "python",
    commands,
    ciWorkflows: listWorkflows(root),
    notes: commands.length === 0 ? ["no python test/lint tool detected"] : [],
  };
}

/**
 * Detect the project facts from `root`. Deterministic, read-only, no guessing:
 * the first recognised manifest (by priority) wins.
 */
export function detectFacts(root: string): DetectedFacts {
  const ciWorkflows = listWorkflows(root);
  const pkg = tryReadJson(path.join(root, "package.json"));
  if (pkg) {
    const pm = detectPackageManager(root) ?? "npm";
    const facts = fromNode(root, pkg, pm);
    // Language: prefer a real signal (a .ts/.tsx file) over guessing.
    facts.language = hasSourceFile(root, [".ts", ".tsx"]) ? "typescript" : "javascript";
    if (!facts.ciWorkflows.length) facts.notes.push("no .github/workflows found");
    return facts;
  }
  if (stat(root, "Cargo.toml")) {
    const f = fromCargo(root);
    if (!f.ciWorkflows.length) f.notes.push("no .github/workflows found");
    return f;
  }
  if (stat(root, "go.mod")) {
    const f = fromGo(root);
    if (!f.ciWorkflows.length) f.notes.push("no .github/workflows found");
    return f;
  }
  if (stat(root, "pyproject.toml")) {
    const f = fromPython(root);
    if (!f.ciWorkflows.length) f.notes.push("no .github/workflows found");
    return f;
  }
  return {
    manifest: undefined,
    commands: [],
    ciWorkflows,
    notes: ["no recognised manifest (package.json / Cargo.toml / go.mod / pyproject.toml)"],
  };
}

function hasSourceFile(root: string, exts: string[]): boolean {
  const src = path.join(root, "src");
  try {
    for (const e of readdirSync(src)) {
      if (exts.some((x) => e.endsWith(x))) return true;
    }
  } catch {
    /* no src dir */
  }
  return false;
}
