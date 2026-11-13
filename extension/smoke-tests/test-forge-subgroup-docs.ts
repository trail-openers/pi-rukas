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
 * Precedent for a docs needle read with `readFileSync`:
 * `test-AC4-troubleshooting-second-commit-pr.ts`. The needle is one the
 * parser's own rule is stated in — a bounded segment count and the
 * consequence of falling outside it — so the assertion fails when the docs
 * drift from the parser rather than merely re-phrasing them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const headless = readFileSync(path.join(ROOT, "docs", "headless.md"), "utf8");
const troubleshooting = readFileSync(path.join(ROOT, "docs", "troubleshooting.md"), "utf8");

// The depth claim, as the parser states it: two to five segments, and a
// path outside that range yields no host.
const DEPTH = /two to five segments/;
const NO_HOST = /yields? no host|parses? to no host|parsed as no host/;

const headlessEntry = headless
  .split(/^### /m)
  .slice(1)
  .find((s) => /\.pi\/forge/.test(s) && DEPTH.test(s));
assert(
  headlessEntry !== undefined && NO_HOST.test(headlessEntry),
  "docs/headless.md states the bounded segment count AND what happens outside it",
);
assert(
  headlessEntry === undefined || !/Give the remote a host and an `owner\/repo` path/.test(headlessEntry),
  "docs/headless.md no longer tells the operator to give the remote an `owner/repo` path",
);

const tsEntry = troubleshooting
  .split(/^### /m)
  .slice(1)
  .find((s) => /gitlab/i.test(s) && DEPTH.test(s));
assert(
  tsEntry !== undefined && NO_HOST.test(tsEntry),
  "docs/troubleshooting.md states the bounded segment count AND what happens outside it",
);
assert(
  tsEntry === undefined || !/The remote must carry a host \*\*and\*\* an `owner\/repo` path/.test(tsEntry),
  "docs/troubleshooting.md no longer demands an `owner/repo` path from the remote",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
