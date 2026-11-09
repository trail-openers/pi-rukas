#!/usr/bin/env bun
/** vipune model pre-fetch gate — #2055. The image pre-fetches vipune's model with `hf download` and the entrypoint seeds the mounted cache volume from
 * /opt/hf-cache-seed. Both halves once masked their own failure, so the image shipped with no model and every offline `vipune search` died with the 404
 * docs/troubleshooting.md tells users to fix by refreshing. Checked is what made that failure visible: the download must not fail quietly, the files vipune
 * opens must be asserted where written and copied, and the revision one literal across files. A suffix match is not an assertion — `test -f
 * …/anything/model.onnx` passes on a tree that put the model nowhere vipune looks — so every asserted path is the whole path, from the seed or cache root,
 * the repo id and the Dockerfile's own `--revision`. The entrypoint half is RUN, not read: `if false; then`, an `exit 0` where a non-zero is required, and a
 * `|| true` on a continuation line each fool a text check, and none fakes an exit code or a file on disk. The seed block is lifted verbatim from the
 * `CACHE_DIR=`/`SEED_DIR=` line to the `fi` closing the seed guard, prefixed with `set -eu`, and run under bash over a fake seed in a temp dir: a valid seed
 * must exit 0 with the three files non-empty in the cache; a seed without onnx/model.onnx must fail naming it; an existing cache must be left alone. The seed
 * root is retargeted by replacing the quoted literal `"/opt/hf-cache-seed"` wherever it appears — not by exporting SEED_DIR, which the block assigns itself —
 * so a mutation renaming the variable still runs on the temp tree, never /opt. argv[2] retargets the three texts to a directory, which is how the gate is
 * shown red on a mutated copy of either file. Reads no `process.env`: a gate the build can switch off never fails. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FILES = [".devcontainer/Dockerfile", ".devcontainer/entrypoint.sh", "docs/troubleshooting.md"];
const ONNX = "onnx/model.onnx";
const TOKENIZER = "tokenizer.json";
const REPO_ID = "BAAI/bge-small-en-v1.5"; // vipune's model: the download arg and cache dir name
const REPO_DIR = `models--${REPO_ID.replace("/", "--")}`;
/** A few files of `cp -a`; a hung child is a failure, never a pass. */
const RUN_TIMEOUT_MS = 4000;
/** Scratch root for every case this file builds; removed at the end of the run. */
const SCRATCH_ROOT = mkdtempSync(path.join(tmpdir(), "hf-seed-gate-"));
const rawLines = (text: string): string[] => text.split("\n");
/** RUN instructions with backslash continuations joined by a space; comment lines dropped so prose never satisfies a check. */
function runs(text: string): { start: number; body: string }[] {
  const out: { start: number; body: string }[] = [];
  let body = "";
  let start = 0;
  rawLines(text).forEach((raw, i) => {
    const line = raw.trim();
    if (body === "") {
      if (line === "" || line.startsWith("#") || !/^RUN\b/.test(line)) return;
      start = i + 1;
      body = line;
    } else body += " " + (line.startsWith("#") ? "" : line);
    if (body.endsWith("\\")) return;
    out.push({ start, body: body.replace(/\\/g, "") });
    body = "";
  });
  return out;
}
const findRun = (text: string, needle: string) => runs(text).find((r) => r.body.includes(needle));
/** The line of the `COPY . <dir>` of the checkout, or 0 when absent: ordering must not pass on a missing COPY. */
const copyLine = (text: string) => rawLines(text).findIndex((l) => /^COPY\b/.test(l.trim()) && /\s\.\s/.test(l.trim())) + 1;
const has = (hay: string, needle: string) => hay.includes(needle);
const masking = (run: string) => [/\|\|\s*echo\b/, /\|\|\s*true\b/, /\|\|\s*:(\s|$)/, /2>\/dev\/null/].find((re) => re.test(run))?.source ?? "";
/** One `test -f X`/`test -s X` operand — trailing continuation stripped. */
const testOperand = (line: string) => /^\s*(?:&&\s*)?test -[fs]\s+(\S+?)\s*\\?\s*$/.exec(line)?.[1] ?? "";
/** `test -f X` then `&& test -s X` over the SAME path, exactly `want`: both flags, since a directory passes `-s` and an empty file passes `-f`; an exact path,
 * since a suffix match lets a stray model pass as seeded. */
function assertedTwice(run: string, want: string): boolean {
  for (const f of run.matchAll(/test\s+-f\s+(\S+)/g)) {
    const s = f[1] === want && /^\s*&&\s*test\s+-s\s+(\S+)/.exec(run.slice(f.index + f[0].length));
    if (s && s[1] === want) return true;
  }
  return false;
}
/** The three paths vipune opens, as `[label, path under root]` pairs. */
const wanted = (root: string, rev: string): [string, string][] => [
  [`refs/<revision> — ${root}/${REPO_DIR}/refs/${rev}`, `${root}/${REPO_DIR}/refs/${rev}`],
  [ONNX, `${root}/${REPO_DIR}/snapshots/${rev}/${ONNX}`],
  [TOKENIZER, `${root}/${REPO_DIR}/snapshots/${rev}/${TOKENIZER}`],
];
/** Non-empty regular file, following a symlink the way `test -s` does. */
const nonEmpty = (p: string): boolean => statSync(p, { throwIfNoEntry: false })?.isFile() === true && (statSync(p).size ?? 0) > 0;
/** The seed block verbatim: the first `CACHE_DIR=`/`SEED_DIR=` line through the `fi` at column 0 closing the seed guard. The block re-assigns SEED_DIR itself,
 * so retargeting goes through the literal, never the environment. */
function extractSeedBlock(entrypoint: string): string {
  const lines = rawLines(entrypoint);
  const from = lines.findIndex((l) => /^\s*(?:CACHE_DIR|SEED_DIR)=/.test(l));
  const guard = lines.findIndex((l) => /^\s*if\s+\[\s+-d\s+"\$SEED_DIR"\s+\]\s+&&\s+\[\s+!\s+-d\s+"\$MODEL_DIR"\s+\];\s*then\s*$/.test(l));
  if (from < 0 || guard < 0) return "";
  const to = lines.findIndex((l, i) => i > guard && l === "fi");
  return to < 0 ? "" : lines.slice(from, to + 1).join("\n");
}
/** The block with the seed root swapped: every occurrence of the literal `"/opt/hf-cache-seed"` — the assignment's value and every later quoted use — becomes
 * the temp seed dir, so a mutation renaming the variable still runs on the temp tree. */
const rewriteSeed = (block: string, seedDir: string) => block.replaceAll('"/opt/hf-cache-seed"', `"${seedDir}"`);
/** A seed shaped like the real one. The snapshot entries are RELATIVE links into blobs/, one `..` per directory below the model dir, as `HF_HUB_DISABLE_XET=1`
 * leaves them: a dangling link is a broken seed the block must fail on, and an absolute link would survive any copy and hide a copy that copied nothing. Only
 * entries the case supplies are verified. */
function buildSeed(seedDir: string, rev: string, opts: { withoutOnnx?: boolean } = {}): void {
  const model = path.join(seedDir, "hub", REPO_DIR);
  const asserted = [`snapshots/${rev}/${TOKENIZER}`, ...(opts.withoutOnnx ? [] : [`snapshots/${rev}/${ONNX}`])];
  mkdirSync(path.join(model, "refs"), { recursive: true });
  mkdirSync(path.join(model, "blobs"), { recursive: true });
  mkdirSync(path.join(model, "snapshots", rev, "onnx"), { recursive: true });
  writeFileSync(path.join(model, "refs", rev), rev);
  writeFileSync(path.join(model, "blobs", "sha-onnx"), "ONNX-BLOB");
  writeFileSync(path.join(model, "blobs", "sha-tok"), "TOKENIZER-JSON");
  if (!opts.withoutOnnx) symlinkSync("../../../blobs/sha-onnx", path.join(model, "snapshots", rev, "onnx", "model.onnx"));
  symlinkSync("../../blobs/sha-tok", path.join(model, "snapshots", rev, TOKENIZER));
  for (const rel of asserted) if (!nonEmpty(path.join(model, rel))) throw new Error(`fixture seed has a dangling ${rel}`);
}
/** Run the seed block as bash would, in a temp HOME over a temp seed. The caller calls `clean()` once it has asserted on what the run left: the seeded cache
 * is the evidence, so the run must not tidy it away. `preexisting` plants a file in the model directory first — an existing cache is never re-seeded, so that
 * case shows only that nothing was overwritten. */
function runSeed(block: string, rev: string, opts: { withoutOnnx?: boolean; preexisting?: string } = {}) {
  const root = mkdtempSync(path.join(SCRATCH_ROOT, "case-"));
  const seedDir = path.join(root, "seed");
  const home = path.join(root, "home");
  const model = path.join(home, ".cache", "huggingface", "hub", REPO_DIR);
  mkdirSync(home, { recursive: true });
  buildSeed(seedDir, rev, opts);
  if (opts.preexisting) {
    mkdirSync(model, { recursive: true });
    writeFileSync(path.join(model, opts.preexisting), "sentinel");
  }
  const script = path.join(root, "seed-block.sh");
  writeFileSync(script, `set -eu\n${rewriteSeed(block, seedDir)}\n`, { mode: 0o644 });
  const r = spawnSync("bash", [script], { encoding: "utf8", timeout: RUN_TIMEOUT_MS, env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: "/tmp" } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  // `brief` quotes what the child said, so a failure names its own cause.
  return { code: r.status, out, model, brief: `exit ${r.status ?? r.error?.message}; ${out.trim().slice(0, 140) || "no output"}`, clean: () => rmSync(root, { recursive: true, force: true }) };
}
/** Both halves of the gate. One string per failed check; empty means the texts pass. */
function check(dockerfile: string, entrypoint: string, docs: string): string[] {
  const fails: string[] = [];
  const say = (ok: boolean, what: string) => void (ok || fails.push(what));
  const pre = findRun(dockerfile, "hf download");
  const seed = runs(dockerfile).find((r) => r !== pre && /\bcp\b/.test(r.body) && has(r.body, "/opt/hf-cache-seed"));
  const copy = copyLine(dockerfile);
  // The two roots the asserted paths are built from, read where defined.
  const seedRoot = /^\s*SEED_DIR="([^"]*)"/m.exec(entrypoint)?.[1] ?? "";
  const cacheRoot = /--cache-dir\s+(\S+)/.exec(pre?.body ?? "")?.[1] ?? "";
  const rev = /--revision\s+([0-9a-f]{40})/.exec(pre?.body ?? "")?.[1] ?? "";
  say(pre !== undefined, `pre-fetch RUN containing \`hf download\` exists`);
  if (pre) {
    const r = pre.body;
    say(has(r, "hf download"), "pre-fetch invokes `hf download`");
    const args = r.slice(r.indexOf("hf download") + "hf download".length).trim().split(/\s+/);
    say(args[0] === REPO_ID, `pre-fetch names the model id ${REPO_ID} (found ${args[0] || "none"})`);
    say(has(r, "HF_HUB_DISABLE_XET=1"), "pre-fetch disables the xet transport");
    const m = masking(r);
    say(m === "", `pre-fetch has no masking suffix (found ${m || "none"})`);
    for (const [label, tail] of wanted(cacheRoot, rev)) say(assertedTwice(r, tail), `pre-fetch asserts with test -s: ${label}`);
    say(pre.start < copy, `pre-fetch (line ${pre.start}) sits above the repo COPY (line ${copy})`);
  }
  say(copy > 0, "Dockerfile has a `COPY . <dir>` of the checkout");
  const pin = /pip3?\s+install[^\n]*?huggingface_hub==([0-9][0-9A-Za-z.+-]*)/.exec(dockerfile)?.[1] ?? "";
  say(pin !== "", "Dockerfile pins huggingface_hub with an exact `==` version");
  // 2.x renamed the `huggingface-cli` script to `hf`; a major bump breaks the pre-fetch.
  say(/^[01]\./.test(pin), `huggingface_hub pin stays below 2.x (found ${pin || "none"})`);
  say(seed !== undefined, "seed-copy RUN creating /opt/hf-cache-seed exists");
  if (seed) {
    say(/\bcp\s+-a\b/.test(seed.body), `seed copy uses \`cp -a\` (found ${seed.body.match(/\bcp\s+\S+/)?.[0] ?? "no cp"})`);
    say(masking(seed.body) === "", "seed copy has no masking suffix");
    say(!/\bif\s+\[\s+-d\b/.test(seed.body), "seed copy is not wrapped in an `if [ -d ]` guard");
    for (const [label, tail] of wanted(`${seedRoot}/hub`, rev)) say(assertedTwice(seed.body, tail), `seed copy asserts with test -s: ${label}`);
    say(seed.start < copy, `seed copy (line ${seed.start}) sits above the repo COPY (line ${copy})`);
  }
  const block = extractSeedBlock(entrypoint);
  say(block !== "", "entrypoint has a seed block from SEED_DIR/CACHE_DIR to the closing `fi` of the seed guard");
  const epRev = /^\s*REVISION="([0-9a-f]{40})"/m.exec(entrypoint)?.[1] ?? "";
  say(rev !== "" && rev === epRev, `entrypoint REVISION equals the Dockerfile --revision (${rev.slice(0, 8) || "none"} vs ${epRev.slice(0, 8) || "none"})`);
  // Executed, not read: seed a real cache, fail loudly on a seed with no onnx model, leave an existing cache untouched. Each text check these replaced passed on a mutant.
  if (block !== "" && rev !== "") {
    const a = runSeed(block, rev, {}); // A: a valid seed lands all three files, non-empty.
    say(a.code === 0, `RUN seeds a valid cache (${a.brief})`);
    for (const rel of [`refs/${rev}`, `snapshots/${rev}/${ONNX}`, `snapshots/${rev}/${TOKENIZER}`]) say(nonEmpty(path.join(a.model, rel)), `RUN leaves a non-empty ${rel} in the seeded cache`);
    a.clean();
    const b = runSeed(block, rev, { withoutOnnx: true }); // B: fails, naming the file it could not find.
    say(b.code !== 0, `RUN fails on a seed without ${ONNX} (${b.brief})`);
    say(has(b.out, ONNX), `RUN names ${ONNX} when the seed lacks it (output ${b.out.trim() || "empty"})`);
    b.clean();
    const c = runSeed(block, rev, { preexisting: "SENTINEL" }); // C: an existing cache is left alone.
    say(c.code === 0, `RUN returns 0 for a pre-existing cache (${c.brief})`);
    say(nonEmpty(path.join(c.model, "SENTINEL")), "RUN leaves a pre-existing cache's SENTINEL in place");
    c.clean();
    // D: guard inverted, so the copy runs against an existing cache — where `cp -rn` skips the subtree and a continuation-line `|| true` hides a copy that copied nothing. Cases A-C never reach that branch.
    const d = runSeed(block.replace(/\[ ! -d "\$MODEL_DIR" \]/, '[ -d "$MODEL_DIR" ]'), rev, { withoutOnnx: true, preexisting: "SENTINEL" });
    say(d.code !== 0, `RUN fails on a seed without ${ONNX} with the seed guard inverted (${d.brief})`);
    say(has(d.out, ONNX), `RUN names ${ONNX} with the seed guard inverted (output ${d.out.trim() || "empty"})`);
    d.clean();
  }
  say(/docker run[^\n]*ghcr\.io\/trail-openers\/pi-rukas:/.test(docs), "troubleshooting docker command names the `ghcr.io/trail-openers/pi-rukas:` image");
  return fails;
}
const dir = process.argv[2] ? path.resolve(process.argv[2]) : REPO_ROOT;
const texts = FILES.map((f) => readFileSync(path.join(dir, f), "utf8"));
const failures = check(texts[0]!, texts[1]!, texts[2]!);
for (const f of failures) console.error(`✗ ${f}`);
// Canary pair: the real texts pass, and one mutated Dockerfile — the shipped defect shape (a masked download plus the dropped onnx assertion) — must fail naming both halves.
const preBody = findRun(texts[0]!, "hf download")?.body ?? "";
const preOnnxPath = `${/--cache-dir\s+(\S+)/.exec(preBody)?.[1] ?? ""}/${REPO_DIR}/snapshots/${/--revision\s+([0-9a-f]{40})/.exec(preBody)?.[1] ?? ""}/${ONNX}`;
const onnxAssertLine = (l: string) => /^\s*(?:&&\s*)?test -s\s/.test(l) && testOperand(l) === preOnnxPath;
const droppedOnnxLine = rawLines(texts[0]!).filter(onnxAssertLine).length;
const mut = check(rawLines(texts[0]!).map((l) => (l.startsWith("      --cache-dir") ? l.replace(/ \\\s*$/, " || echo WARNING \\") : l)).filter((l) => !onnxAssertLine(l)).join("\n"), texts[1]!, texts[2]!);
console.log(`✓ canary: unmutated texts pass (${failures.length} failures)`);
const named = mut.filter((f) => f.includes(ONNX)).length + mut.filter((f) => f.includes("masking suffix")).length;
console.log(`${named === 2 && droppedOnnxLine === 1 ? "✓" : "✗"} canary: the mutated Dockerfile drops the pre-fetch onnx \`test -s\` line (${droppedOnnxLine} matched) and fails, naming it and the masking suffix [${mut.join(" | ")}]`);
if (failures.length !== 0 || named !== 2 || droppedOnnxLine !== 1) process.exit(1);
rmSync(SCRATCH_ROOT, { recursive: true, force: true });
console.log("dockerfile-prefetch gate: PASS");

