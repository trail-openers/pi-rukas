#!/usr/bin/env bun
/**
 * #2257 — the two docs statements about how deep a remote path parses must
 * match what `parseRemoteUrl` actually accepts.
 *
 * Both entries used to tell an operator that a GitLab subgroup remote
 * (`group/sub/project`) parses to its host. The parser refused any path
 * deeper than two segments, so the promise was false in exactly the case the
 * operator hits on a self-hosted instance with subgroups.
 *
 * The bound is taken from the parser's own `MIN_SEGMENTS`/`MAX_SEGMENTS` and
 * then confirmed empirically against `parseRemoteUrl`, so neither half of the
 * AC3 promise can be satisfied by prose alone: rewording the docs clears the
 * needle only while it still states the code's numbers, and moving a bound in
 * the parser without touching the docs turns this gate red.
 *
 * Precedent for a docs needle read with `readFileSync`:
 * `test-AC4-troubleshooting-second-commit-pr.ts`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { MAX_SEGMENTS, MIN_SEGMENTS, parseRemoteUrl } from "../src/forge-detect.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const NUMBERS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];
const wordOf = (n: number): string => {
  const w = NUMBERS[n];
  if (w === undefined) throw new Error(`docs gate cannot word the bound ${n}`);
  return w;
};

// ── the parser's own bound, read from the code rather than from the docs ──

const segs = (n: number): string => Array.from({ length: n }, (_, i) => `s${i}`).join("/");
assert(
  parseRemoteUrl(`https://gitlab.example.com/${segs(MIN_SEGMENTS)}`) !== undefined,
  `the parser accepts its stated floor of ${MIN_SEGMENTS} segments`,
);
assert(
  parseRemoteUrl(`https://gitlab.example.com/${segs(MAX_SEGMENTS)}`) !== undefined,
  `the parser accepts its stated ceiling of ${MAX_SEGMENTS} segments`,
);
assert(
  parseRemoteUrl(`https://gitlab.example.com/${segs(MAX_SEGMENTS + 1)}`) === undefined,
  `…and refuses one past it (${MAX_SEGMENTS + 1})`,
);

// The sentence the docs must contain, assembled from those numbers.
const DEPTH = new RegExp(`${wordOf(MIN_SEGMENTS)} to ${wordOf(MAX_SEGMENTS)} segments?`);
const NO_HOST = /yields? no host|parses? to no host|parsed as no host/;

const headless = readFileSync(path.join(ROOT, "docs", "headless.md"), "utf8");
const troubleshooting = readFileSync(path.join(ROOT, "docs", "troubleshooting.md"), "utf8");

const headlessEntry = headless
  .split(/^## /m)
  .slice(1)
  .find((s) => /\.pi\/forge/.test(s) && DEPTH.test(s));
assert(
  headlessEntry !== undefined && NO_HOST.test(headlessEntry),
  `docs/headless.md states the parser's bound (${MIN_SEGMENTS} to ${MAX_SEGMENTS}) AND what happens outside it`,
);
assert(
  headlessEntry === undefined ||
    !/Give the remote a host and an `owner\/repo` path/.test(headlessEntry),
  "docs/headless.md no longer tells the operator to give the remote an `owner/repo` path",
);

const tsEntry = troubleshooting
  .split(/^### /m)
  .slice(1)
  .find((s) => /gitlab/i.test(s) && DEPTH.test(s));
assert(
  tsEntry !== undefined && NO_HOST.test(tsEntry),
  `docs/troubleshooting.md states the parser's bound (${MIN_SEGMENTS} to ${MAX_SEGMENTS}) AND what happens outside it`,
);
assert(
  tsEntry === undefined ||
    !/The remote must carry a host \*\*and\*\* an `owner\/repo` path/.test(tsEntry),
  "docs/troubleshooting.md no longer demands an `owner/repo` path from the remote",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
