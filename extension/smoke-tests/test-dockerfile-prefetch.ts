#!/usr/bin/env bun
/**
 * vipune model pre-fetch gate — #2055.
 *
 * The image pre-fetches vipune's embedding model (BAAI/bge-small-en-v1.5) at
 * build time and the entrypoint seeds the named cache volume from that seed on
 * start. Both halves used to mask their own failure — `… download || echo
 * WARNING`, an `if [ -d … ]` guard, `cp -rn … 2>/dev/null || true` — so the
 * published image shipped without the model and every offline `vipune search`
 * died with the 404 docs/troubleshooting.md tells users to fix by rebuilding.
 *
 * The gate reads the REAL files and keeps four things true:
 *   1. the pre-fetch runs `hf download` (not the renamed `huggingface-cli`),
 *      pinned to a huggingface_hub that still ships that CLI, as the cache
 *      owner, with xet off, no masking suffix and no `if [ -d ]` guard;
 *   2. the pre-fetch, the seed copy and the entrypoint all assert the files
 *      vipune actually opens — `refs/<revision>` (as `-f` AND `-s`: a directory
 *      satisfies `-s` alone), `snapshots/<revision>/onnx/model.onnx` and
 *      `snapshots/<revision>/tokenizer.json` (`src/embedding/engine.rs` opens
 *      exactly those three, and `test -s` follows the snapshot symlink, so a
 *      dangling link fails). A generic "some blob is big" check passes on an
 *      image whose model file is the one vipune never asked for;
 *   3. the pre-fetch and seed copy sit ABOVE the repo COPY, and the Dockerfile's
 *      `--revision` is the entrypoint's REVISION — two literals that may drift;
 *   4. the seed path is one path across Dockerfile, entrypoint and docs, and the
 *      docs entry names the full `ghcr.io/` image reference.
 *
 * Proven in both directions (AGENTS.md §12 canary discipline): each detector
 * fires on an inline fixture carrying the shipped defect shape and stays quiet
 * on the matching fix fixture, so a green real-file run means the detectors
 * actually look.
 *
 * No escape hatch: unlike its sibling gates, this file reads no `process.env`
 * at all — a test the build can switch off is a test that never fails.
 */

import {
  DOCKERFILE,
  ENTRYPOINT,
  MODEL,
  MODEL_LABELS,
  MODEL_NEEDLES,
  MODEL_ONNX,
  MODEL_TOKENIZER,
  SHA,
  TROUBLESHOOTING,
  assertsModelFile,
  canonicalSeed,
  copiesWithoutPreserve,
  entrypointRevision,
  entrypointSeedBlock,
  entrypointSeedDir,
  hasDirGuard,
  hubPin,
  hubPinIsExact,
  maskingSuffix,
  namesFailedPath,
  prefetchInstruction,
  prefetchTroubleshootingSection,
  repoCopyLine,
  runInstructions,
  seedCopyInstruction,
  seedPathsIn,
  silencesStderr,
  testsDirExistence,
} from "./lib/dockerfile-prefetch-detectors.ts";
import { readFileSync } from "node:fs";

let exit = 0;

function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}


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
  assert(/HF_HUB_DISABLE_XET=1/.test(prefetch.text), "the pre-fetch disables the xet transport (xet blobs are links outside hub/, invisible to the seed)");
  for (const [i, pattern] of MODEL_NEEDLES.entries()) {
    assert(
      assertsModelFile(prefetch.text, pattern),
      `the pre-fetch RUN asserts the model file vipune loads: ${MODEL_LABELS[i]}`,
    );
  }
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

console.log("— the seed copy, the entrypoint and the revision are consistent");

assert(seedCopy !== undefined, `Dockerfile has a RUN that creates ${canonicalSeed(seed)}`);
if (seedCopy) {
  assert(maskingSuffix(seedCopy.text) === "", `the seed copy has no masking suffix (found: ${maskingSuffix(seedCopy.text) || "none"})`);
  assert(!silencesStderr(seedCopy.text), "the seed copy does not silence its stderr");
  assert(!hasDirGuard(seedCopy.text), "the seed copy is not wrapped in an `if [ -d ]` guard");
  assert(copiesWithoutPreserve(seedCopy.text) === "", `the seed copy preserves metadata (cp flag: ${copiesWithoutPreserve(seedCopy.text) || "-a"})`);
  assert(
    /test\s+-f\b[^\n]*refs\/[0-9a-f]{40}/.test(seedCopy.text),
    "the seed copy asserts refs/<revision> is a FILE (`-s` alone passes on a directory)",
  );
  for (const [i, pattern] of MODEL_NEEDLES.entries()) {
    assert(
      assertsModelFile(seedCopy.text, pattern),
      `the seed copy asserts the seeded model file: ${MODEL_LABELS[i]}`,
    );
  }
}
assert(copyLine !== -1, "Dockerfile has a `COPY . <dir>` of the checkout");
if (prefetch && seedCopy && copyLine !== -1) {
  assert(prefetch.startLine < copyLine, `the pre-fetch (line ${prefetch.startLine}) sits above the repo COPY (line ${copyLine})`);
  assert(seedCopy.startLine < copyLine, `the seed copy (line ${seedCopy.startLine}) sits above the repo COPY (line ${copyLine})`);
}
{
  const revision = entrypointRevision(entrypoint);
  assert(/^[0-9a-f]{40}$/.test(revision), `entrypoint declares REVISION as a commit SHA (found: ${revision || "absent"})`);
  const dockerRevision = prefetch?.text.match(/--revision\s+([0-9a-f]{40})/)?.[1] ?? "";
  assert(
    revision !== "" && dockerRevision === revision,
    `the Dockerfile's --revision equals the entrypoint's REVISION (Dockerfile ${dockerRevision.slice(0, 8) || "none"} vs entrypoint ${revision.slice(0, 8) || "none"})`,
  );
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
for (const [i, pattern] of MODEL_NEEDLES.entries()) {
  assert(
    assertsModelFile(block, pattern),
    `the entrypoint asserts the seeded model file vipune loads: ${MODEL_LABELS[i]}`,
  );
}
assert(namesFailedPath(block), "the entrypoint's failed post-copy assertion prints the missing path before exiting non-zero");

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

const M = "models--BAAI--bge-small-en-v1.5";

/** A pre-fetch RUN carrying `-f`/`-s` pairs for the named snapshot files, so a
 * canary can omit exactly one of them. Lines are concatenated rather than
 * templated: the continuation backslash before a closing delimiter breaks the
 * parser inside a template literal. */
function prefetchFixture(needles: string[]): string {
  const tests = needles
    .flatMap((n) => [
      "    && test -f /home/vscode/.cache/huggingface/hub/" +
        M +
        "/snapshots/" +
        SHA +
        "/" +
        n +
        " \\",
      "    && test -s /home/vscode/.cache/huggingface/hub/" +
        M +
        "/snapshots/" +
        SHA +
        "/" +
        n +
        " \\",
    ])
    .join("\n");
  return [
    "USER vscode",
    "RUN set -e; HF_HUB_DISABLE_XET=1 hf download \\",
    "      " + MODEL + " \\",
    "      --revision " + SHA + " \\",
    "      --cache-dir /home/vscode/.cache/huggingface/hub \\",
    "    && printf '%s' " + SHA + " > /home/vscode/.cache/huggingface/hub/" + M + "/refs/" + SHA + " \\",
    "    && test -f /home/vscode/.cache/huggingface/hub/" + M + "/refs/" + SHA + " \\",
    "    && test -s /home/vscode/.cache/huggingface/hub/" + M + "/refs/" + SHA + " \\",
    tests.replace(/ \\$/, ""),
  ].join("\n");
}

const ALL_NEEDLES = ["onnx/model.onnx", "tokenizer.json"];
const PREFETCH_FIX = prefetchFixture(ALL_NEEDLES);
const PREFETCH_DEFECT = [  "USER vscode",
  "RUN huggingface-cli download \\",
  `      ${MODEL} \\`,
  `      --revision ${SHA} \\`,
  "      --cache-dir /home/vscode/.cache/huggingface/hub \\",
  '    || echo "WARNING: pre-fetch failed"',
].join("\n");
// The shape this gate was written against: a generic find over blobs/sha256
// instead of the files vipune opens. It must read as asserting NONE of them.
const PREFETCH_GENERIC_BLOB = prefetchFixture(["config.json"]).replace(
  /config\.json$/,
  `"$(find /home/vscode/.cache/huggingface/hub/${M}/blobs -maxdepth 1 -xtype f -size +1M -print -quit)"`,
);
// Written line by line, the way the Dockerfile itself is written: the seed copy
// is one continued RUN, so `runInstructions` joins these lines into the single
// command string the detectors read.
const SEED_DEFECT = [
  "RUN if [ -d /home/vscode/.cache/huggingface ]; then \\",
  "      cp -r /home/vscode/.cache/huggingface /opt/hf-cache-seed; \\",
  "    fi",
].join("\n");
const SEED_FIX_LINES = [
  "RUN set -e; cp -a /home/vscode/.cache/huggingface /opt/hf-cache-seed \\",
  "    && chown -R vscode:vscode /opt/hf-cache-seed \\",
  "    && test -f /opt/hf-cache-seed/hub/" + M + "/refs/" + SHA + " \\",
  "    && test -s /opt/hf-cache-seed/hub/" + M + "/refs/" + SHA + " \\",
  "    && test -f /opt/hf-cache-seed/hub/" + M + "/snapshots/" + SHA + "/onnx/model.onnx \\",
  "    && test -s /opt/hf-cache-seed/hub/" + M + "/snapshots/" + SHA + "/onnx/model.onnx \\",
  "    && test -f /opt/hf-cache-seed/hub/" + M + "/snapshots/" + SHA + "/tokenizer.json \\",
  "    && test -s /opt/hf-cache-seed/hub/" + M + "/snapshots/" + SHA + "/tokenizer.json",
];
const SEED_FIX = SEED_FIX_LINES.join("\n");
/** The assertion flag (`f` or `s`) a fixture line opens with, after its `&&`. */
const seedFlag = (line: string): string =>
  line
    .trim()
    .replace(/^&&\s*/u, "")
    .replace(/^test\s+-/u, "")
    .slice(0, 1);
const SEED_F_LINES = SEED_FIX_LINES.filter((l) => seedFlag(l) === "f");
// Entries 2 and 3 are the refs `-f`/`-s` pair; dropping the `-f` leaves `-s`
// alone, the form a directory passes. The assertions below pin the indices and
// the flags, so a fixture edit that moves them reddens the gate rather than
// quietly leaving the `-f` in place.
const SEED_S_ONLY = SEED_FIX_LINES.filter((_, i) => i !== 2).join("\n");
const ENTRYPOINT_DEFECT = [
  'CACHE_DIR="${HOME}/.cache/huggingface"',
  'SEED_DIR="/opt/hf-cache-seed"',
  'REVISION="' + SHA + '"',
  'if [ -d "$SEED_DIR" ] && [ ! -d "$MODEL_DIR" ]; then',
  '  cp -rn "$SEED_DIR"/. "$CACHE_DIR"/ 2>/dev/null || true',
  "fi",
  'exec "$@"',
].join("\n");
const ENTRYPOINT_FIX = [
  'CACHE_DIR="${HOME}/.cache/huggingface"',
  'SEED_DIR="/opt/hf-cache-seed"',
  'REVISION="' + SHA + '"',
  'if [ -d "$SEED_DIR" ] && [ ! -d "$MODEL_DIR" ]; then',
  '  cp -a "$SEED_DIR"/. "$CACHE_DIR"/',
  '  for _f in "refs/$REVISION" "snapshots/$REVISION/onnx/model.onnx" "snapshots/$REVISION/tokenizer.json"; do',
  '    if [ ! -f "$MODEL_DIR/$_f" ] || [ ! -s "$MODEL_DIR/$_f" ]; then',
  '      echo "pi-rukas: model seed is missing or empty: $MODEL_DIR/$_f" >&2',
  "      exit 1",
  "    fi",
  "  done",
  "fi",
  'exec "$@"',
].join("\n");
// The same block with the message removed: it still exits non-zero, but names
// nothing — the shape the naming assertion exists to catch.
const ENTRYPOINT_SILENT = ENTRYPOINT_FIX.replace(
  '      echo "pi-rukas: model seed is missing or empty: $MODEL_DIR/$_f" >&2',
  "      : # fail",
);

// Defect shapes the shipped files carried: each detector must catch them.
assert(maskingSuffix(PREFETCH_DEFECT) !== "", "canary: `|| echo WARNING` on the pre-fetch IS detected");
assert(maskingSuffix('RUN cp -rn "$S"/. "$C"/ 2>/dev/null || true') !== "", "canary: `|| true` IS detected");
assert(maskingSuffix("RUN hf download X || :") !== "", "canary: `|| :` IS detected");
assert(silencesStderr(ENTRYPOINT_DEFECT), "canary: `2>/dev/null` IS detected");
assert(hasDirGuard(SEED_DEFECT) && testsDirExistence(ENTRYPOINT_DEFECT), "canary: `if [ -d … ]` guards ARE detected");
assert(copiesWithoutPreserve(SEED_DEFECT) === "cp -r", "canary: `cp -r` IS detected as non-preserving");
assert(copiesWithoutPreserve('cp -rn "$S"/. "$C"/') === "cp -rn", "canary: `cp -rn` IS detected as non-preserving");
assert(hubPin('RUN pip3 install --no-cache-dir "huggingface_hub>=0.20"') === "0.20" && !hubPinIsExact('RUN pip3 install "huggingface_hub>=0.20"'), "canary: a `>=` huggingface_hub pin IS detected as unpinned");
assert(hubPin("RUN apt-get install curl") === "", "canary: a file with no pip install reports no pin");
assert(entrypointSeedBlock(ENTRYPOINT_DEFECT).includes("cp -rn"), "canary: the entrypoint seed block is captured on the defect fixture");
assert(entrypointRevision(ENTRYPOINT_FIX) === SHA, "canary: REVISION is read from the entrypoint fixture");
assert(entrypointRevision("CACHE_DIR=x\nexec \"$@\"\n") === "", "canary: an entrypoint with no REVISION reports none");

// The model-file detector, both directions — the heart of this gate.
{
  const all = runInstructions(PREFETCH_FIX)[0]!;
  for (const [i, pattern] of MODEL_NEEDLES.entries()) {
    assert(assertsModelFile(all.text, pattern), `canary: a ${MODEL_LABELS[i]} assertion IS detected when present`);
  }
  const noOnnx = runInstructions(prefetchFixture(["tokenizer.json"]))[0]!;
  assert(
    !assertsModelFile(noOnnx.text, MODEL_NEEDLES[0]!) && assertsModelFile(noOnnx.text, MODEL_NEEDLES[1]!),
    "canary: a pre-fetch MISSING the onnx/model.onnx assertion IS detected (the tokenizer one still detected)",
  );
  const noTokenizer = runInstructions(prefetchFixture(["onnx/model.onnx"]))[0]!;
  assert(
    !assertsModelFile(noTokenizer.text, MODEL_NEEDLES[1]!),
    "canary: a pre-fetch MISSING the tokenizer.json assertion IS detected",
  );
  {
    // The refs assertion is inherited from the pre-fetch fixture; only the
    // snapshot assertions are the generic `find blobs -size +1M` form, and
    // that is the part which must assert NONE of the files vipune opens.
    const generic = runInstructions(PREFETCH_GENERIC_BLOB)[0]!;
    assert(
      !assertsModelFile(generic.text, MODEL_ONNX) && !assertsModelFile(generic.text, MODEL_TOKENIZER),
      "canary: the generic `find blobs -size +1M` assertion asserts NONE of the files vipune loads",
    );
  }
  assert(
    !assertsModelFile(`test -s /opt/hf-cache-seed/hub/${M}/snapshots/${SHA}/config.json`, MODEL_NEEDLES[0]!),
    "canary: a config.json assertion is NOT mistaken for the onnx model",
  );
  assert(
    !assertsModelFile(SEED_S_ONLY, MODEL_NEEDLES[2]!),
    "canary: a refs assertion written as `-s` only does not satisfy the `-f` requirement",
  );
  assert(
    SEED_FIX_LINES.length === 8 &&
      SEED_F_LINES.length === 3 &&
      seedFlag(SEED_FIX_LINES[2]!) === "f" &&
      seedFlag(SEED_FIX_LINES[3]!) === "s" &&
      SEED_S_ONLY !== SEED_FIX &&
      assertsModelFile(SEED_FIX, MODEL_NEEDLES[2]!) &&
      !assertsModelFile(SEED_S_ONLY, MODEL_NEEDLES[2]!),
    "canary: dropping the refs `-f` assertion is a real change and the detector sees it",
  );
  assert(
    assertsModelFile(SEED_FIX, MODEL_NEEDLES[2]!),
    "canary: the `test -f` refs assertion IS detected",
  );
}
assert(!namesFailedPath(ENTRYPOINT_SILENT), "canary: an entrypoint that exits without naming the path IS detected");
assert(namesFailedPath(entrypointSeedBlock(ENTRYPOINT_FIX)), "canary: an entrypoint that names the missing path IS detected");
assert(!namesFailedPath(entrypointSeedBlock(ENTRYPOINT_DEFECT)), "canary: the old silent `cp -rn || true` block names no path");

// The fix shapes: the same detectors must go quiet, or the real-file passes above are meaningless.
assert(maskingSuffix(PREFETCH_FIX) === "", "canary: the fixed pre-fetch reports no masking suffix");
assert(!silencesStderr(PREFETCH_FIX) && !silencesStderr(SEED_FIX), "canary: the fixed RUNs report no silenced stderr");
assert(!hasDirGuard(PREFETCH_FIX) && !hasDirGuard(SEED_FIX), "canary: the fixed RUNs report no `if [ -d ]` guard");
assert(copiesWithoutPreserve(SEED_FIX) === "" && copiesWithoutPreserve(ENTRYPOINT_FIX) === "", "canary: `cp -a` reports no non-preserving flag");
assert(testsDirExistence(ENTRYPOINT_FIX), "canary: the fixed entrypoint still keeps the existence check");
assert(maskingSuffix(ENTRYPOINT_FIX) === "", "canary: the fixed entrypoint reports no masking suffix");
{
  const fp = runInstructions(PREFETCH_FIX)[0]!;
  const fs_ = seedCopyInstruction(runInstructions(SEED_FIX), "/opt/hf-cache-seed");
  assert(fp !== undefined && fp.user === "vscode", "canary: the fixed pre-fetch parses as a vscode USER RUN");
  assert(fs_ !== undefined, "canary: the fixed seed copy parses as a RUN");
  assert(runInstructions("COPY --chown=vscode:vscode . /opt/pi-rukas").length === 0, "canary: COPY is not treated as a RUN");
}
{
  const seeds = seedPathsIn(`RUN cp -a /home/vscode/.cache/huggingface /opt/hf-cache-seed && ls /opt/hf-cache-seed/`);
  assert(seeds.length === 1 && canonicalSeed(seeds[0]!) === "/opt/hf-cache-seed", "canary: a trailing-slash seed canonicalises to one path");
  assert(seedPathsIn("RUN echo nothing").length === 0, "canary: a file with no seed path reports none");
}
assert(prefetchTroubleshootingSection('### `vipune search` returns "Failed to download embedding model"\nbody\n### next\n') !== "", "canary: the troubleshooting entry is captured");
assert(prefetchTroubleshootingSection("### unrelated\n### next\n") === "", "canary: an unrelated heading is not the entry");
assert(
  /docker run[^\n]*ghcr\.io\/trail-openers\/pi-rukas:/.test("docker run --rm ghcr.io/trail-openers/pi-rukas:latest ls /opt/hf-cache-seed"),
  "canary: the full image reference form is detected",
);
assert(
  !/docker run[^\n]*(?<!ghcr\.io\/)trail-openers\/pi-rukas:/.test("docker run --rm ghcr.io/trail-openers/pi-rukas:latest ls"),
  "canary: the ghcr-prefixed form is not reported as the un-prefixed form",
);

if (exit === 0) console.log("dockerfile-prefetch gate: PASS");
process.exit(exit);

