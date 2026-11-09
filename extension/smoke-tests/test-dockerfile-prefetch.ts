#!/usr/bin/env bun
/**
 * vipune model pre-fetch gate — #2055.
 *
 * The image pre-fetches vipune's embedding model (BAAI/bge-small-en-v1.5) at
 * build time and the entrypoint seeds the named cache volume from that seed on
 * start. Both halves used to mask their own failure: the download ran
 * `huggingface-cli download … || echo WARNING`, the seed copy ran behind
 * `if [ -d … ]`, and the entrypoint copy ran `cp -rn … 2>/dev/null || true`.
 * huggingface_hub 2.x renamed `huggingface-cli` to `hf`, so the download
 * exited 127, every layer after it "succeeded", and the published image
 * shipped without the model — the exact failure docs/troubleshooting.md tells
 * users to fix by rebuilding.
 *
 * This gate keeps the pre-fetch honest on the REAL files:
 *   1. the pre-fetch runs `hf download` (not the renamed `huggingface-cli`),
 *      pinned to a released huggingface_hub that ships the `hf` CLI, with no
 *      masking suffix and no `if [ -d ]` guard on the pre-fetch or the seed
 *      copy;
 *   2. the same RUN that downloads asserts the snapshot's config.json and a
 *      non-empty model blob, and asserts the seed directory is non-empty;
 *   3. the pre-fetch, the seed copy and the seed creation all sit ABOVE the
 *      repo COPY (they read no checkout — below it they re-ran on every merge);
 *   4. the entrypoint copies the seed with `cp -a`, keeps the
 *      don't-overwrite-an-existing-cache check, and asserts after the copy;
 *   5. the seed path in the Dockerfile, SEED_DIR in the entrypoint and the
 *      path in the troubleshooting entry are the same path, and that entry's
 *      verification command names the FULL `ghcr.io/` image reference.
 *
 * Proven in both directions (AGENTS.md §12 canary discipline): each detector
 * fires on an inline fixture carrying the shipped defect shape and stays quiet
 * on the matching fix fixture, so a green real-file run means the detectors
 * actually look.
 *
 * No escape hatch: unlike its sibling gates, this file reads no `process.env`
 * at all — a test the build can switch off is a test that never fails.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DOCKERFILE = path.join(REPO_ROOT, ".devcontainer", "Dockerfile");
const ENTRYPOINT = path.join(REPO_ROOT, ".devcontainer", "entrypoint.sh");
const TROUBLESHOOTING = path.join(REPO_ROOT, "docs", "troubleshooting.md");
const MODEL = "BAAI/bge-small-en-v1.5";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------------- parsing

/**
 * Executable RUN instructions with their shell text, each joined across
 * backslash continuations and joined to the `USER` directive that was in
 * force at its first line. Comment lines are dropped so prose that quotes the
 * defective command to explain the fix can never trip a detector.
 */
export type RunInstruction = { startLine: number; user: string; text: string };

export function runInstructions(text: string): RunInstruction[] {
  const raw = text.split("\n");
  const out: RunInstruction[] = [];
  let user = "";
  let current: RunInstruction | null = null;
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]!.trim();
    if (t === "" || t.startsWith("#")) continue;
    const continued = t.endsWith("\\");
    const body = continued ? t.slice(0, -1).trim() : t;
    if (/^RUN\b/.test(body)) {
      if (current !== null) out.push(current);
      current = { startLine: i + 1, user, text: body };
    } else if (current === null) {
      const u = body.match(/^USER\s+(\S+)/);
      if (u) user = u[1]!;
      continue;
    }
    current.text += " " + body;
    if (!continued) {
      out.push(current);
      current = null;
    }
  }
  if (current !== null) out.push(current);
  return out;
}

/** One-sentence summary: an instruction is the pre-fetch when it downloads the model. */
export function prefetchInstruction(runs: RunInstruction[]): RunInstruction | undefined {
  return runs.find((r) => /\b(?:hf|huggingface-cli)\s+download\b/.test(r.text) && r.text.includes(MODEL));
}

/** The instruction that creates the image's model seed directory. */
export function seedCopyInstruction(runs: RunInstruction[], seed: string): RunInstruction | undefined {
  return runs.find((r) => /\bcp\b/.test(r.text) && r.text.includes(seed));
}

/** The instruction that copies the checkout into the image. */
export function repoCopyLine(text: string): number {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (/^COPY\b/.test(t) && /\s\.\s|\s\.\t/.test(t)) return i + 1;
  }
  return -1;
}

// ---------------------------------------------------------------- detectors

/**
 * A masking suffix on a shell command: a fallback that lets a failing command
 * report success. `|| echo …`, `|| true`, `|| :`, and the stderr-silencing
 * form `2>/dev/null || …`.
 */
export function maskingSuffix(command: string): string {
  const lines = command.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  for (const line of lines) {
    const m = line.match(/\|\|\s*(?:echo\b|true\b|:\s*$|:\s)/) ?? line.match(/\|\|\s*:/);
    if (m) return m[0].trim();
  }
  return "";
}

/** Whether a command redirects a command's stderr into /dev/null (comment lines excluded). */
export function silencesStderr(command: string): boolean {
  return command
    .split("\n")
    .map((l) => l.trim())
    .some((l) => !l.startsWith("#") && l.includes("2>/dev/null"));
}

/** Whether a command's run is wrapped in an `if [ -d … ]` existence guard. */
export function hasDirGuard(command: string): boolean {
  return /\bif\s+\[\s+-d\s/.test(command);
}

/** Whether a command tests for a directory's existence at all (`[ -d … ]` or `[ ! -d … ]`). */
export function testsDirExistence(command: string): boolean {
  return /\[\s+!?\s*-d\s/.test(command);
}

/** Whether a command copies recursively without preserving (`cp -r`/`-rn`/`-r…` but not `-a`). */
export function copiesWithoutPreserve(command: string): string {
  const m = command.match(/\bcp\s+(-[A-Za-z]+)\b/);
  if (!m) return "";
  const flags = m[1]!;
  if (flags.includes("a")) return "";
  return m[0];
}

/** A blob-size assertion (`-size +1M`-style) that also rejects a symlink (`! -L`). */
export function assertsRealBlob(command: string): boolean {
  return /-size\s+\+?\d+[MK]\b/.test(command) && (/-xtype\s+f\b/.test(command) || /!\s*-L\b/.test(command));
}

/** The huggingface_hub pin in the image (`"huggingface_hub==X"` on a pip install). "" when absent or unpinned. */
export function hubPin(text: string): string {
  const m = text.match(/pip3?\s+install[^\n]*?huggingface_hub\s*(?:==|>=|~=|<=)\s*([0-9][0-9a-z.+-]*)/);
  return m ? m[1]! : "";
}

/** Whether the huggingface_hub pin is an exact `==` pin (a range lets the CLI rename back in). */
export function hubPinIsExact(text: string): boolean {
  return /pip3?\s+install[^\n]*?huggingface_hub\s*==\s*[0-9]/.test(text);
}

/** Whether a command asserts the resolver ref file vipune needs to resolve the pinned revision. */
export function assertsResolverRef(command: string): boolean {
  // The literal SHA (the build RUNs) or the entrypoint's $REVISION variable —
  // both name the ref file vipune's resolver opens to resolve the pinned revision.
  return /test\s+-s\b[^\n]*\/refs\/([0-9a-f]{40}|\$\{?REVISION}?)/.test(command);
}

/** The `SEED_DIR="…"` value in the entrypoint, or "". */
export function entrypointSeedDir(entrypoint: string): string {
  const m = entrypoint.match(/^\s*SEED_DIR="([^"]+)"/m);
  return m ? m[1]! : "";
}

/** The entrypoint block that seeds the cache: from the SEED_DIR assignment to `exec "$@"`. */
export function entrypointSeedBlock(entrypoint: string): string {
  const start = entrypoint.search(/^\s*CACHE_DIR=/m);
  const end = entrypoint.lastIndexOf('exec "$@"');
  if (start === -1 || end === -1 || end < start) return "";
  return entrypoint.slice(start, end);
}

/** The troubleshooting entry for the vipune model failure: heading to the next `###`. */
export function prefetchTroubleshootingSection(md: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^###\s/.test(l) && /embedding model/.test(l));
  if (start === -1) return "";
  const end = lines.findIndex((l, i) => i > start && /^###\s/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** Every `/opt/…` path that appears to be the model seed (contains `hf-cache-seed`). */
export function seedPathsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\/opt\/[A-Za-z0-9._/-]*hf-cache-seed/g)].map((m) => m[0]))];
}

/** A single canonical seed path: `/opt/hf-cache-seed` with no trailing slash. */
function canonicalSeed(p: string): string {
  return p.replace(/\/+$/, "");
}

// ---------------------------------------------------------------- the gate

const dockerfile = readFileSync(DOCKERFILE, "utf8");
const entrypoint = readFileSync(ENTRYPOINT, "utf8");
const troubleshooting = readFileSync(TROUBLESHOOTING, "utf8");

const runs = runInstructions(dockerfile);
const prefetch = prefetchInstruction(runs);
const seed = seedPathsIn(dockerfile)[0] ?? "/opt/hf-cache-seed";
const seedCopy = seedCopyInstruction(runs, seed);
const copyLine = repoCopyLine(dockerfile);

console.log("— the pre-fetch fails the build when the download fails");

assert(prefetch !== undefined, `Dockerfile has a RUN that downloads ${MODEL}`);
if (prefetch) {
  assert(/\bhf\s+download\b/.test(prefetch.text), "the pre-fetch invokes `hf download` (not the renamed `huggingface-cli`)");
  assert(!/huggingface-cli/.test(prefetch.text), "the pre-fetch does not invoke `huggingface-cli` (removed in huggingface_hub 2.x)");
  assert(maskingSuffix(prefetch.text) === "", `the pre-fetch has no masking suffix (found: ${maskingSuffix(prefetch.text) || "none"})`);
  assert(!silencesStderr(prefetch.text), "the pre-fetch does not silence its stderr");
  assert(!hasDirGuard(prefetch.text), "the pre-fetch is not wrapped in an `if [ -d ]` guard");
  assert(prefetch.user !== "root", `the pre-fetch runs as the cache owner, not root (USER ${prefetch.user || "unset"})`);
  assert(
    prefetch.text.includes("--cache-dir") && prefetch.text.includes("/home/vscode/.cache/huggingface"),
    "the pre-fetch downloads into the vscode user's HF cache",
  );
  assert(
    /--revision\s+[0-9a-f]{40}/.test(prefetch.text),
    "the pre-fetch pins the model revision to a commit SHA",
  );
  assert(
    /test\s+(?:-s|-f|-d)\b[^\n]*snapshots[^\n]*config\.json/.test(prefetch.text),
    "the same RUN asserts the snapshot's config.json exists and is non-empty",
  );
  assert(
    assertsRealBlob(prefetch.text),
    "the same RUN asserts a non-empty, non-symlink model blob (a xet symlink is not a seed)",
  );
  assert(
    /HF_HUB_DISABLE_XET=1/.test(prefetch.text),
    "the pre-fetch disables the xet transport (xet blobs are symlinks outside hub/, invisible to the seed)",
  );
  assert(
    /refs\/[0-9a-f]{40}/.test(prefetch.text),
    "the pre-fetch writes refs/<revision>, which vipune's resolver reads to resolve the pinned revision",
  );
}

console.log("— the huggingface_hub pin ships the `hf` CLI");

const pin = hubPin(dockerfile);
assert(pin !== "", `Dockerfile pins huggingface_hub (found: ${pin || "absent"})`);
assert(hubPinIsExact(dockerfile), `huggingface_hub is an exact \`==\` pin, not a range (pin: ${pin || "absent"})`);
{
  const major = Number.parseInt(pin.split(".")[0] ?? "", 10);
  assert(
    Number.isFinite(major) && major < 2,
    `the huggingface_hub pin predates the 2.x CLI rename that removed \`huggingface-cli\` (pin: ${pin || "absent"})`,
  );
}

console.log("— the seed copy fails the build when the seed is missing");

assert(seedCopy !== undefined, `Dockerfile has a RUN that creates ${canonicalSeed(seed)}`);
if (seedCopy) {
  assert(maskingSuffix(seedCopy.text) === "", `the seed copy has no masking suffix (found: ${maskingSuffix(seedCopy.text) || "none"})`);
  assert(!silencesStderr(seedCopy.text), "the seed copy does not silence its stderr");
  assert(!hasDirGuard(seedCopy.text), "the seed copy is not wrapped in an `if [ -d ]` guard");
  assert(copiesWithoutPreserve(seedCopy.text) === "", `the seed copy preserves metadata (cp flag: ${copiesWithoutPreserve(seedCopy.text) || "-a"})`);
  assert(
    /test\s+-s\s+[^\n]*config\.json/.test(seedCopy.text),
    "the seed copy asserts the snapshot's config.json survived the copy",
  );
  assert(assertsResolverRef(seedCopy.text), "the seed copy asserts refs/<revision> survived the copy");
}
assert(copyLine !== -1, "Dockerfile has a `COPY . <dir>` of the checkout");
if (prefetch && seedCopy && copyLine !== -1) {
  assert(prefetch.startLine < copyLine, `the pre-fetch (line ${prefetch.startLine}) sits above the repo COPY (line ${copyLine})`);
  assert(seedCopy.startLine < copyLine, `the seed copy (line ${seedCopy.startLine}) sits above the repo COPY (line ${copyLine})`);
}

console.log("— the entrypoint seeds the cache and asserts it");

const block = entrypointSeedBlock(entrypoint);
assert(block !== "", "entrypoint has a cache-seed block");
assert(entrypointSeedDir(entrypoint) !== "", `entrypoint declares SEED_DIR (found: ${entrypointSeedDir(entrypoint) || "absent"})`);
assert(testsDirExistence(block), "the entrypoint keeps the don't-overwrite-an-existing-cache check");
assert(
  /\bcp\s+-a\b/.test(block),
  `the entrypoint copies the seed with \`cp -a\` (found: ${block.match(/\bcp\s+\S+/)?.[0] ?? "no cp"})`,
);
assert(copiesWithoutPreserve(block) === "", `the entrypoint's cp preserves metadata (flag: ${copiesWithoutPreserve(block) || "-a"})`);
assert(maskingSuffix(block) === "", `the entrypoint seed copy has no masking suffix (found: ${maskingSuffix(block) || "none"})`);
assert(!silencesStderr(block), "the entrypoint seed copy does not silence its stderr");
assert(
  /test\s+-s\b[^\n]*config\.json/.test(block),
  "the entrypoint asserts the seeded model after the copy",
);
assert(assertsRealBlob(block), "the entrypoint's post-copy assertion rejects a symlink blob");
assert(
  assertsResolverRef(block),
  "the entrypoint asserts the refs/<revision> file vipune's resolver needs (its absence is the offline 404)",
);

console.log("— the seed path is one path across the Dockerfile, entrypoint and docs");

const docSection = prefetchTroubleshootingSection(troubleshooting);
assert(docSection !== "", "docs/troubleshooting.md has the vipune embedding-model entry");
{
  const dockerSeeds = seedPathsIn(dockerfile).map(canonicalSeed);
  const entrySeeds = seedPathsIn(entrypoint).map(canonicalSeed);
  const docSeeds = seedPathsIn(docSection).map(canonicalSeed);
  assert(dockerSeeds.length === 1, `Dockerfile names exactly one seed path (${dockerSeeds.join(", ") || "none"})`);
  assert(entrySeeds.length === 1, `entrypoint names exactly one seed path (${entrySeeds.join(", ") || "none"})`);
  assert(docSeeds.length >= 1, `the troubleshooting entry names a seed path (${docSeeds.join(", ") || "none"})`);
  const all = new Set([...dockerSeeds, ...entrySeeds, ...docSeeds]);
  assert(
    entrySeeds.length === 1 && entrySeeds[0] === entrypointSeedDir(entrypoint),
    `SEED_DIR is the entrypoint's seed path (${entrypointSeedDir(entrypoint) || "absent"})`,
  );
  assert(
    all.size === 1 && dockerSeeds.length === 1,
    `one seed path everywhere: Dockerfile, entrypoint SEED_DIR, troubleshooting (${[...all].join(" vs ") || "none"})`,
  );
}
assert(
  /docker run[^\n]*ghcr\.io\/trail-openers\/pi-rukas:[A-Za-z0-9._-]+/.test(docSection),
  "the troubleshooting verification command names the full `ghcr.io/trail-openers/pi-rukas:` image reference",
);
assert(
  !/docker run[^\n]*(?<!ghcr\.io\/)trail-openers\/pi-rukas:/.test(docSection),
  "the troubleshooting verification command does not use the un-prefixed `trail-openers/pi-rukas:` image name",
);

// ---------------------------------------------------------------- canaries

console.log("— canaries: every detector fires on the defect and stays quiet on the fix");

const PREFETCH_DEFECT = [
  "RUN huggingface-cli download \\",
  "      BAAI/bge-small-en-v1.5 \\",
  "      --revision 5c38ec7c405ec4b44b94cc5a9bb96e735b38267a \\",
  "      --cache-dir /home/vscode/.cache/huggingface/hub \\",
  '    || echo "WARNING: pre-fetch failed"',
].join("\n");
const PREFETCH_FIX = [
  "RUN set -e; HF_HUB_DISABLE_XET=1 hf download \\",
  "      BAAI/bge-small-en-v1.5 \\",
  "      --revision 5c38ec7c405ec4b44b94cc5a9bb96e735b38267a \\",
  "      --cache-dir /home/vscode/.cache/huggingface/hub \\",
  "    && test -s /home/vscode/.cache/huggingface/hub/models--BAAI--bge-small-en-v1.5/snapshots/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/config.json \\",
  "    && test -n \"$(find /home/vscode/.cache/huggingface/hub/models--BAAI--bge-small-en-v1.5/blobs -maxdepth 1 -xtype f -size +1M -print -quit)\"",
].join("\n");
const SEED_DEFECT = "RUN if [ -d /home/vscode/.cache/huggingface ]; then \\\n      cp -r /home/vscode/.cache/huggingface /opt/hf-cache-seed; \\\n    fi";
const SEED_FIX = "RUN set -e; cp -a /home/vscode/.cache/huggingface /opt/hf-cache-seed \\\n    && chown -R vscode:vscode /opt/hf-cache-seed \\\n    && test -s /opt/hf-cache-seed/hub/models--BAAI--bge-small-en-v1.5/snapshots/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a/config.json \\\n    && test -n \"$(find /opt/hf-cache-seed/hub/models--BAAI--bge-small-en-v1.5/blobs -maxdepth 1 -xtype f -size +1M -print -quit)\"";
const ENTRYPOINT_DEFECT = [
  'CACHE_DIR="${HOME}/.cache/huggingface"',
  'SEED_DIR="/opt/hf-cache-seed"',
  'if [ -d "$SEED_DIR" ] && [ ! -d "$MODEL_DIR" ]; then',
  '  cp -rn "$SEED_DIR"/. "$CACHE_DIR"/ 2>/dev/null || true',
  "fi",
  'exec "$@"',
].join("\n");
const ENTRYPOINT_FIX = [
  'CACHE_DIR="${HOME}/.cache/huggingface"',
  'SEED_DIR="/opt/hf-cache-seed"',
  'if [ -d "$SEED_DIR" ] && [ ! -d "$MODEL_DIR" ]; then',
  '  cp -a "$SEED_DIR"/. "$CACHE_DIR"/',
  '  test -s "$MODEL_DIR/snapshots/$REVISION/config.json"',
  '  test -n "$(find "$MODEL_DIR/blobs" -maxdepth 1 -xtype f -size +1M -print -quit)"',
  "fi",
  'exec "$@"',
].join("\n");

// The defect shapes the shipped files carried: each detector must catch them.
assert(maskingSuffix(PREFETCH_DEFECT) !== "", "canary: `|| echo WARNING` on the pre-fetch IS detected");
assert(maskingSuffix('RUN cp -rn "$S"/. "$C"/ 2>/dev/null || true') !== "", "canary: `|| true` IS detected");
assert(maskingSuffix("RUN hf download X || :") !== "", "canary: `|| :` IS detected");
assert(silencesStderr(ENTRYPOINT_DEFECT), "canary: `2>/dev/null` IS detected");
assert(hasDirGuard(SEED_DEFECT), "canary: `if [ -d … ]` on the seed copy IS detected");
assert(copiesWithoutPreserve(SEED_DEFECT) === "cp -r", "canary: `cp -r` IS detected as non-preserving");
assert(copiesWithoutPreserve('cp -rn "$S"/. "$C"/') === "cp -rn", "canary: `cp -rn` IS detected as non-preserving");
assert(hasDirGuard(ENTRYPOINT_DEFECT) && testsDirExistence(ENTRYPOINT_DEFECT), "canary: the entrypoint guard shape IS detected");
assert(!/hf\s+download/.test(PREFETCH_DEFECT) && /huggingface-cli/.test(PREFETCH_DEFECT), "canary: the renamed CLI in the pre-fetch IS detectable");
assert(hubPin('RUN pip3 install --no-cache-dir "huggingface_hub>=0.20"') === "0.20" && !hubPinIsExact('RUN pip3 install "huggingface_hub>=0.20"'), "canary: a `>=` huggingface_hub pin IS detected as unpinned");
assert(hubPin("RUN apt-get install curl") === "", "canary: a file with no pip install reports no pin");
assert(entrypointSeedBlock(ENTRYPOINT_DEFECT).includes("cp -rn"), "canary: the entrypoint seed block is captured on the defect fixture");

// The fix shapes: the same detectors must go quiet, or the real-file passes above are meaningless.
assert(maskingSuffix(PREFETCH_FIX) === "", "canary: the fixed pre-fetch reports no masking suffix");
assert(!silencesStderr(PREFETCH_FIX) && !silencesStderr(SEED_FIX), "canary: the fixed RUNs report no silenced stderr");
assert(!hasDirGuard(PREFETCH_FIX) && !hasDirGuard(SEED_FIX), "canary: the fixed RUNs report no `if [ -d ]` guard");
assert(copiesWithoutPreserve(SEED_FIX) === "" && copiesWithoutPreserve(ENTRYPOINT_FIX) === "", "canary: `cp -a` reports no non-preserving flag");
assert(testsDirExistence(ENTRYPOINT_FIX), "canary: the fixed entrypoint still keeps the existence check");
assert(maskingSuffix(ENTRYPOINT_FIX) === "", "canary: the fixed entrypoint reports no masking suffix");
assert(/\bcp\s+-a\b/.test(ENTRYPOINT_FIX) && /test\s+-s\b/.test(ENTRYPOINT_FIX), "canary: the fixed entrypoint shape parses as cp -a + assert");
{
  const fixRuns = runInstructions(
    ["USER vscode", PREFETCH_FIX, "USER root", SEED_FIX, "COPY --chown=vscode:vscode . /opt/pi-rukas"].join("\n"),
  );
  const fp = prefetchInstruction(fixRuns);
  const fs_ = seedCopyInstruction(fixRuns, "/opt/hf-cache-seed");
  assert(fp !== undefined && fp.user === "vscode", "canary: the fixed pre-fetch parses as a vscode USER RUN");
  assert(fs_ !== undefined, "canary: the fixed seed copy parses as a RUN");
  assert(fp !== undefined && /test\s+-s\b[^\n]*config\.json/.test(fp.text), "canary: the config.json assertion is detected when present");
  assert(fp !== undefined && !/test\s+-s\b[^\n]*config\.json/.test(runInstructions(PREFETCH_DEFECT)[0]!.text), "canary: the config.json assertion is detected when absent");
  assert(fs_ !== undefined && runInstructions("COPY --chown=vscode:vscode . /opt/pi-rukas").length === 0, "canary: COPY is not treated as a RUN");
}
{
  const seeds = seedPathsIn("RUN cp -a /home/vscode/.cache/huggingface /opt/hf-cache-seed && ls /opt/hf-cache-seed/");
  assert(seeds.length === 1 && canonicalSeed(seeds[0]!) === "/opt/hf-cache-seed", "canary: a trailing-slash seed canonicalises to one path");
  assert(seedPathsIn("RUN echo nothing").length === 0, "canary: a file with no seed path reports none");
}
assert(prefetchTroubleshootingSection("### `vipune search` returns \"Failed to download embedding model\"\nbody\n### next\n") !== "", "canary: the troubleshooting entry is captured");
assert(prefetchTroubleshootingSection("### unrelated\n### next\n") === "", "canary: an unrelated heading is not the entry");
assert(
  assertsRealBlob(SEED_FIX) && assertsRealBlob(ENTRYPOINT_FIX),
  "canary: a `-size +1M ! -L` blob assertion IS detected as a real-blob assertion",
);
assert(
  !assertsRealBlob('test -n "$(find "$B" -maxdepth 1 -type f -size +1M -print -quit)"'),
  "canary: a blob assertion WITHOUT `! -L` IS detected as not rejecting a symlink",
);
assert(
  !assertsRealBlob('test -n "$(find "$B" -maxdepth 1 -type f ! -L -print -quit)"'),
  "canary: a `! -L` find with no size floor IS detected as not asserting a real blob",
);
assert(
  assertsResolverRef("&& test -s /opt/hf-cache-seed/hub/models--BAAI--bge-small-en-v1.5/refs/5c38ec7c405ec4b44b94cc5a9bb96e735b38267a"),
  "canary: a refs/<sha> assertion IS detected",
);
assert(
  !assertsResolverRef("&& test -s /opt/hf-cache-seed/hub/models--BAAI--bge-small-en-v1.5/snapshots/5c38ec/config.json"),
  "canary: a config.json assertion is NOT mistaken for the refs assertion",
);
assert(
  /docker run[^\n]*ghcr\.io\/trail-openers\/pi-rukas:/.test(
    "docker run --rm ghcr.io/trail-openers/pi-rukas:latest ls /opt/hf-cache-seed",
  ),
  "canary: the full image reference form is detected",
);
assert(
  !/docker run[^\n]*(?<!ghcr\.io\/)trail-openers\/pi-rukas:/.test(
    "docker run --rm ghcr.io/trail-openers/pi-rukas:latest ls",
  ),
  "canary: the ghcr-prefixed form is not reported as the un-prefixed form",
);

if (exit === 0) console.log("dockerfile-prefetch gate: PASS");
process.exit(exit);
