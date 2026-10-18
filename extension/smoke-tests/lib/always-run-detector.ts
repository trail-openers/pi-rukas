/**
 * #1647 — the ALWAYS_RUN detector. Test-only: it generates and checks the list in
 * src/work-driver-verify-always-run.ts, and nothing in the shipped extension
 * imports it.
 *
 * A smoke test that reads repository source or configuration AS TEXT depends on
 * files no import graph shows (it opens `src/x.ts` by name, or walks a
 * directory), so a selection built from imports would never run it for a change
 * to the file it reads. A test is a reader when it makes a read call AND one of
 * its string literals (or a `path.join`/`resolve` argument) names a repository
 * path. That is judged on the lexed code, so a comment or a message that quotes
 * a path does not count, and a word that merely equals a directory name does
 * not count unless it is a path argument.
 *
 * Live tests (`-live.ts`) never run offline, so they are not readers here.
 * Regenerate the list with `bun smoke-tests/lib/always-run-detector.ts --write`.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { lexSource } from "../../src/work-driver-verify-select-lex.ts";

/** Repository directories a reader may name, as a leading path segment. */
const REPO_DIRS = [
  "src",
  "smoke-tests/lib",
  ".pi",
  "modules",
  "manifests",
  "agents-base",
  "pi-prompts",
  "skill",
  "docs",
  "bin",
  "dist",
  ".github",
  ".devcontainer",
];
/** Repository files a reader may name. `tsconfig*.json` is matched separately. */
const REPO_FILES = [
  "agents.json",
  "package.json",
  "bunfig.toml",
  "release-please-config.json",
  "Dockerfile",
  "install.sh",
  "build.sh",
  "AGENTS.md",
  "README.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
];
const READ_CALL_RE =
  /\b(?:readFileSync|readdirSync|readFile|readdir|openSync|readSync|createReadStream|opendirSync)\s*\(|\bBun\.file\b/;
/** A call to join or resolve on lexed code; the group is its argument list. */
const JOIN_CALL_RE = /\b(?:join|resolve)\s*\(([^()]*)\)/g;
/** A string token on lexed code (`<i>` or template `<i>`). */
const TOKEN_RE = /[](\d+)[]/g;
/** A leading interpolation or relative prefix that does not change which repository path a literal names. */
const LEADING_RE = /^(?:\$\{[^}]*\}\/|\.{1,2}\/|extension\/)*/;

function isRepoPath(value: string): boolean {
  const rest = value.replace(LEADING_RE, "");
  if (REPO_FILES.includes(rest) || /^tsconfig[\w.-]*\.json$/.test(rest)) return true;
  return REPO_DIRS.some((d) => rest === d || rest.startsWith(`${d}/`));
}

/** True when the file reads and names a repository path. Unlexable text reads as a reader: it cannot be judged. */
export function readsRepositoryText(raw: string): boolean {
  const lexed = lexSource(raw);
  if (lexed === undefined) return READ_CALL_RE.test(raw);
  if (!READ_CALL_RE.test(lexed.code)) return false;
  if (lexed.strings.some(isRepoPath) || lexed.templates.some(isRepoPath)) return true;
  // `path.join(ext, "src", "x.ts")`: a bare directory segment passed to join or resolve.
  for (const m of lexed.code.matchAll(JOIN_CALL_RE)) {
    for (const t of (m[1] ?? "").matchAll(TOKEN_RE)) {
      const value = lexed.strings[Number(t[1])] ?? lexed.templates[Number(t[1])];
      if (value !== undefined && (REPO_DIRS.includes(value) || REPO_FILES.includes(value))) {
        return true;
      }
    }
  }
  return false;
}

/** Offline smoke test files (top level, extension-relative) that read repository text. */
export function textReadingTests(extensionDir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(extensionDir, "smoke-tests"))) {
    if (!/^test-[^/]+\.ts$/.test(name) || /-live\.ts$/.test(name)) continue;
    const text = readFileSync(path.join(extensionDir, "smoke-tests", name), "utf8");
    if (readsRepositoryText(text)) out.push(`smoke-tests/${name}`);
  }
  return out.sort();
}

if (import.meta.main && process.argv.includes("--write")) {
  const extensionDir = path.resolve(import.meta.dirname, "../..");
  const tests = textReadingTests(extensionDir);
  const body = tests.map((t) => `  "${t}",`).join("\n");
  const file = path.join(extensionDir, "src", "work-driver-verify-always-run.ts");
  const source = readFileSync(file, "utf8");
  const start = source.indexOf("export const ALWAYS_RUN");
  // A missing marker must fail loudly: slicing at -1 would truncate the file.
  if (start < 0) throw new Error(`no "export const ALWAYS_RUN" marker in ${file}`);
  const head = source.slice(0, start);
  writeFileSync(
    file,
    `${head}export const ALWAYS_RUN: readonly string[] = [\n${body}\n];\n`,
    "utf8",
  );
  console.log(`ALWAYS_RUN: ${tests.length} entries`);
}
