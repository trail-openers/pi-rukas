#!/usr/bin/env bun
/**
 * #1020 — driver fixtures carry the host under `host`, not `pi`.
 *
 * `DriverContext` replaced its `pi: ExtensionAPI` key with `host: DriverHost`.
 * Smoke fixtures live outside `extension/tsconfig.json` (`src/**` only), and
 * most of them build the context as `{ ... } as unknown as DriverContext`, so
 * `tsc --noEmit` cannot see a stale `pi:` key. The failure is silent: the
 * driver reads `ctx.host` as `undefined` and the test passes or fails for the
 * wrong reason, never exercising the host seam.
 *
 * This gate scans every smoke test for a `pi:` key inside an object literal
 * that also carries `repoRoot:` and `issue:` within a few lines. Only a
 * DriverContext literal has that shape; helper returns such as
 * `{ pi, sent }` and slow-notice inputs do not carry `repoRoot`. The detector
 * is proven on an in-memory fixture first, so a detector that stopped matching
 * would fail here rather than let the scan pass vacuously.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Matches `pi:` (key) and `pi,` / `pi }` (shorthand key). Not `const pi =`,
// `piSessionHost`, or a value position (`host: pi,`), which is `(?<!:\s*)`.
const PI_KEY = /(^|[{,(\s])(?<!:\s*)pi(\s*:|\s*,|\s*\})/;
const WINDOW = 4;

/** Line numbers (1-based) where a `pi:` key sits in a DriverContext-shaped literal. */
function staleHostKeyLines(source: string): number[] {
  const lines = source.split("\n");
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (!PI_KEY.test(line)) return;
    // A type annotation (`pi: ExtensionAPI`) is not a fixture value.
    if (/pi:\s*(ExtensionAPI|Pick<|DispatchHost|DriverHost)\b/.test(line)) return;
    // A destructuring binding (`const { pi } = mkPi()`) names a local, not a context key.
    if (/\b(const|let|var)\s*\{[^}]*\bpi\b/.test(line)) return;
    const lo = Math.max(0, i - WINDOW);
    const hi = Math.min(lines.length, i + WINDOW + 1);
    const near = lines.slice(lo, hi).join("\n");
    if (/\brepoRoot\s*[:,}]/.test(near) && /\bissue\s*[:,}]/.test(near)) hits.push(i + 1);
  });
  return hits;
}

// Detector self-test: it must flag a stale literal and ignore a correct one.
const STALE =
  "const ctx = {\n  pi: fake,\n  repoRoot: dir,\n  issue: 1,\n} as unknown as DriverContext;";
const FRESH =
  "const ctx = {\n  host: fake,\n  repoRoot: dir,\n  issue: 1,\n} as unknown as DriverContext;";
const HELPER =
  "function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {\n  return { pi: stub, sent };\n}";
const SHORTHAND = "const ctx = { pi, repoRoot: dir, issue: 1 } as unknown as DriverContext;";
const SHORTHAND_ONLY = "const ctx = { pi };\nconst r = { repoRoot: dir, issue: 1 };";
const NOT_KEY = "const pi = path.join(a);\nconst r = { repoRoot: dir, issue: 1 };";
const NOT_IDENT = "const x = piSessionHost(x);\nconst r = { repoRoot: dir, issue: 1 };";
assert(staleHostKeyLines(STALE).length === 1, "detector flags a stale `pi:` DriverContext literal");
assert(staleHostKeyLines(FRESH).length === 0, "detector ignores a correct `host:` literal");
assert(staleHostKeyLines(HELPER).length === 0, "detector ignores a `{ pi, sent }` helper return");
assert(
  staleHostKeyLines(SHORTHAND).length === 1,
  "detector flags shorthand `{ pi, repoRoot, issue }`",
);
assert(staleHostKeyLines(SHORTHAND_ONLY).length === 1, "detector flags shorthand `{ pi }`");
assert(staleHostKeyLines(NOT_KEY).length === 0, "detector ignores `const pi = path.join(a)`");
assert(staleHostKeyLines(NOT_IDENT).length === 0, "detector ignores `piSessionHost(x)`");
const VALUE_POS = "const ctx = {\n  host: pi,\n  repoRoot: dir,\n  issue: 1,\n};";
const DESTRUCT = "const { pi } = mkPi();\nconst ctx = {\n  repoRoot: dir,\n  issue: 1,\n};";
assert(staleHostKeyLines(VALUE_POS).length === 0, "detector ignores `host: pi` value position");
assert(
  staleHostKeyLines(DESTRUCT).length === 0,
  "detector ignores a `const { pi } =` destructuring binding",
);
const UNSPACED = "const ctx = {\n  pi:fake,\n  repoRoot:dir,\n  issue:1,\n} as unknown as DriverContext;";
const SHORTHAND_CTX = "const ctx = {\n  pi,\n  repoRoot,\n  issue\n} as unknown as DriverContext;";
assert(staleHostKeyLines(UNSPACED).length === 1, "detector flags unspaced `pi:fake,` key");
assert(
  staleHostKeyLines(SHORTHAND_CTX).length === 1,
  "detector flags shorthand `pi,` with shorthand `repoRoot,` / `issue` context",
);

const dir = path.join(import.meta.dir);
const files = readdirSync(dir).filter(
  (f) => f.endsWith(".ts") && f !== path.basename(import.meta.path),
);
const libFiles = readdirSync(path.join(dir, "lib"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join("lib", f));
const all = [...files, ...libFiles];

const offenders: string[] = [];
for (const f of all) {
  const lines = staleHostKeyLines(readFileSync(path.join(dir, f), "utf8"));
  for (const n of lines) offenders.push(`${f}:${n}`);
}
assert(
  offenders.length === 0,
  `no smoke fixture keys the driver host as \`pi:\` (${all.length} files scanned)${
    offenders.length ? `\n    ${offenders.join("\n    ")}` : ""
  }`,
);

process.exit(exit);
