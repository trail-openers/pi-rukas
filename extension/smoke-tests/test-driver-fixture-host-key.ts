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
 * that also carries `repoRoot:` and `issue:`. The literal is the enclosing
 * `{ … }` found by brace depth, not a line window, so a key six lines above
 * `repoRoot:` is still read as the same literal. A `pi` argument to a call
 * (`dispatch(pi, { … })`) is not a key: its nearest unmatched opener is `(`.
 * Only a DriverContext literal has that shape; helper returns such as
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
/**
 * The object literal enclosing `at`, found by brace depth. The nearest unmatched
 * opener going backwards must be a `{`; a `(` or `[` means `at` is a call or
 * array argument rather than a key. The literal runs to its matching `}`.
 */
function enclosingObjectLiteral(source: string, at: number): string | undefined {
  let depth = 0;
  let open = -1;
  for (let i = at - 1; i >= 0 && open < 0; i--) {
    const c = source[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth === 0) open = i;
      else depth--;
    }
  }
  if (open < 0 || source[open] !== "{") return undefined;
  depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open, i + 1);
  }
  return undefined;
}

/** Line numbers (1-based) where a `pi:` key sits in a DriverContext-shaped literal. */
function staleHostKeyLines(source: string): number[] {
  const lines = source.split("\n");
  const hits: number[] = [];
  let lineStart = 0;
  lines.forEach((line, i) => {
    const start = lineStart;
    lineStart += line.length + 1;
    const m = PI_KEY.exec(line);
    if (!m) return;
    // A type annotation (`pi: ExtensionAPI`) is not a fixture value.
    if (/pi:\s*(ExtensionAPI|Pick<|DispatchHost|DriverHost)\b/.test(line)) return;
    // A destructuring binding (`const { pi } = mkPi()`) names a local, not a context key.
    if (/\b(const|let|var)\s*\{[^}]*\bpi\b/.test(line)) return;
    const literal = enclosingObjectLiteral(source, start + m.index + m[1].length);
    if (
      literal !== undefined &&
      /\brepoRoot\s*[:,}]/.test(literal) &&
      /\bissue\s*[:,}]/.test(literal)
    )
      hits.push(i + 1);
  });
  return hits;
}

// `ctx.pi` reads the pre-#1020 key; the host is `ctx.host`.
const CTX_PI = /\bctx\.pi\b/;

// Detector self-test: it must flag a stale literal and ignore a correct one.
const STALE =
  "const ctx = {\n  pi: fake,\n  repoRoot: dir,\n  issue: 1,\n} as unknown as DriverContext;";
const FRESH =
  "const ctx = {\n  host: fake,\n  repoRoot: dir,\n  issue: 1,\n} as unknown as DriverContext;";
const HELPER =
  "function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {\n  return { pi: stub, sent };\n}";
const SHORTHAND = "const ctx = { pi, repoRoot: dir, issue: 1 } as unknown as DriverContext;";
const SHORTHAND_ONLY = "const ctx = {\n  pi,\n  repoRoot: dir,\n  issue: 1,\n};";
const NOT_KEY = "const pi = path.join(a);\nconst r = { repoRoot: dir, issue: 1 };";
const NOT_IDENT = "const x = piSessionHost(x);\nconst r = { repoRoot: dir, issue: 1 };";
assert(staleHostKeyLines(STALE).length === 1, "detector flags a stale `pi:` DriverContext literal");
assert(staleHostKeyLines(FRESH).length === 0, "detector ignores a correct `host:` literal");
assert(staleHostKeyLines(HELPER).length === 0, "detector ignores a `{ pi, sent }` helper return");
assert(
  staleHostKeyLines(SHORTHAND).length === 1,
  "detector flags shorthand `{ pi, repoRoot, issue }`",
);
assert(
  staleHostKeyLines(SHORTHAND_ONLY).length === 1,
  "detector flags shorthand `pi,` in a multi-line literal",
);
assert(staleHostKeyLines(NOT_KEY).length === 0, "detector ignores `const pi = path.join(a)`");
assert(staleHostKeyLines(NOT_IDENT).length === 0, "detector ignores `piSessionHost(x)`");
const VALUE_POS = "const ctx = {\n  host: pi,\n  repoRoot: dir,\n  issue: 1,\n};";
const DESTRUCT = "const { pi } = mkPi();\nconst ctx = {\n  repoRoot: dir,\n  issue: 1,\n};";
assert(staleHostKeyLines(VALUE_POS).length === 0, "detector ignores `host: pi` value position");
assert(
  staleHostKeyLines(DESTRUCT).length === 0,
  "detector ignores a `const { pi } =` destructuring binding",
);
const UNSPACED =
  "const ctx = {\n  pi:fake,\n  repoRoot:dir,\n  issue:1,\n} as unknown as DriverContext;";
const SHORTHAND_CTX = "const ctx = {\n  pi,\n  repoRoot,\n  issue\n} as unknown as DriverContext;";
assert(staleHostKeyLines(UNSPACED).length === 1, "detector flags unspaced `pi:fake,` key");
assert(
  staleHostKeyLines(SHORTHAND_CTX).length === 1,
  "detector flags shorthand `pi,` with shorthand `repoRoot,` / `issue` context",
);

const FAR_KEY =
  "const ctx = {\n  pi: fake,\n  a: 1,\n  b: 2,\n  c: 3,\n  d: 4,\n  e: 5,\n  repoRoot: dir,\n  issue: 1,\n} as unknown as DriverContext;";
const CALL_ARG = "const r = dispatch(pi, {\n  repoRoot: dir,\n  issue: 1,\n});";
assert(staleHostKeyLines(FAR_KEY).length === 1, "detector flags `pi:` six lines above `repoRoot:`");
assert(
  staleHostKeyLines(CALL_ARG).length === 0,
  "detector ignores `dispatch(pi, {repoRoot, issue})`",
);
assert(CTX_PI.test("await ctx.pi.sendUserMessage(text);"), "ctx.pi read is detected");
assert(!CTX_PI.test("await ctx.host.sendUserMessage(text);"), "ctx.host read is not flagged");

const dir = path.join(import.meta.dir);
const files = readdirSync(dir).filter(
  (f) => f.endsWith(".ts") && f !== path.basename(import.meta.path),
);
const libFiles = readdirSync(path.join(dir, "lib"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.join("lib", f));
const all = [...files, ...libFiles];

const offenders: string[] = [];
const ctxPiReads: string[] = [];
for (const f of all) {
  const source = readFileSync(path.join(dir, f), "utf8");
  for (const n of staleHostKeyLines(source)) offenders.push(`${f}:${n}`);
  source.split("\n").forEach((line, i) => {
    if (CTX_PI.test(line)) ctxPiReads.push(`${f}:${i + 1}`);
  });
}
assert(
  offenders.length === 0,
  `no smoke fixture keys the driver host as \`pi:\` (${all.length} files scanned)${
    offenders.length ? `\n    ${offenders.join("\n    ")}` : ""
  }`,
);
assert(
  ctxPiReads.length === 0,
  `no smoke file reads \`ctx.pi\` (use \`ctx.host\`)${
    ctxPiReads.length ? `\n    ${ctxPiReads.join("\n    ")}` : ""
  }`,
);

process.exit(exit);
