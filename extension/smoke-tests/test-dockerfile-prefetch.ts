#!/usr/bin/env bun
/**
 * vipune model pre-fetch gate — #2055.
 *
 * The image pre-fetches vipune's embedding model with `hf download` and the
 * entrypoint seeds the mounted cache volume from /opt/hf-cache-seed. Both halves
 * once masked their own failure, so the image shipped with no model and every
 * offline `vipune search` died with the 404 that docs/troubleshooting.md tells
 * users to fix by refreshing. What is checked is only what made that failure
 * visible: the download must not fail quietly, the files vipune opens must be
 * asserted where written and copied, and the revision one literal across files.
 *
 * An assertion over a path suffix is not an assertion: `test -f
 * …/anything/model.onnx` passes on a tree that put the model nowhere vipune
 * looks, so each asserted path is compared to the whole path built from the seed
 * root in the entrypoint, the cache root in the pre-fetch, the repo id and the
 * Dockerfile's own `--revision`.
 *
 * `check` is the whole gate and reads three texts; it returns one string per
 * failed check. `main` runs it on the real files and the canary runs the same
 * function on one mutated Dockerfile text, so a green real run means the
 * assertions can fail. No escape hatch: this file reads no `process.env` — a
 * gate the build can switch off is a gate that never fails. argv[2] retargets
 * the three files to a directory, which is how the gate is shown red on a
 * mutated copy.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FILES = [".devcontainer/Dockerfile", ".devcontainer/entrypoint.sh", "docs/troubleshooting.md"];
const ONNX = "onnx/model.onnx";
const TOKENIZER = "tokenizer.json";
const REPO_ID = "BAAI/bge-small-en-v1.5"; // vipune's model: the download arg and cache dir name
const REPO_DIR = `models--${REPO_ID.replace("/", "--")}`;
/** RUN instructions with backslash continuations joined by a space — line
 * scanning only, and comment lines dropped so prose never satisfies a check. */
function runs(text: string): { start: number; body: string }[] {
  const out: { start: number; body: string }[] = [];
  let body = "";
  let start = 0;
  rawLines(text).forEach((raw, i) => {
    const line = raw.trim();
    if (body === "") {
      if (line === "" || line.startsWith("#")) return;
      if (!/^RUN\b/.test(line)) return;
      start = i + 1;
      body = line;
    } else {
      body += " " + (line.startsWith("#") ? "" : line);
    }
    if (!body.endsWith("\\")) {
      out.push({ start, body: body.replace(/\\/g, "") });
      body = "";
    }
  });
  return out;
}

const rawLines = (text: string): string[] => text.split("\n");
/** Text with comment lines dropped, so a check never matches explanatory prose. */
const executableLines = (text: string): string =>
  rawLines(text)
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
const findRun = (text: string, needle: string) => runs(text).find((r) => r.body.includes(needle));
/** The line number of the `COPY . <dir>` of the checkout, or 0 when absent —
 * the ordering checks must not pass because the COPY went missing. */
const copyLine = (text: string) =>
  rawLines(text).findIndex((l) => /^COPY\b/.test(l.trim()) && /\s\.\s/.test(l.trim())) + 1;
const has = (hay: string, needle: string) => hay.includes(needle);
const masking = (run: string) => [/\|\|\s*echo\b/, /\|\|\s*true\b/, /\|\|\s*:(\s|$)/, /2>\/dev\/null/].find((re) => re.test(run))?.source ?? "";
/** One `test -f X`/`test -s X` operand — trailing continuation stripped. */
const testOperand = (line: string) => /^\s*(?:&&\s*)?test -[fs]\s+(\S+?)\s*\\?\s*$/.exec(line)?.[1] ?? "";
/** `test -f X` immediately followed by `&& test -s X` over the SAME path, which
 * must be exactly `want` — both flags, because a directory passes `-s` and an
 * empty file passes `-f`; an exact path, because a suffix match would let a
 * model written nowhere vipune looks pass as seeded. */
function assertedTwice(run: string, want: string): boolean {
  for (const f of run.matchAll(/test\s+-f\s+(\S+)/g)) {
    if (f[1] !== want) continue;
    const s = /^\s*&&\s*test\s+-s\s+(\S+)/.exec(run.slice(f.index + f[0].length));
    if (s && s[1] === want) return true;
  }
  return false;
}

/** The gate. One string per failed check; empty means the texts pass. */
function check(dockerfile: string, entrypoint: string, docs: string): string[] {
  const fails: string[] = [];
  const say = (ok: boolean, what: string) => {
    if (!ok) fails.push(what);
  };
  const pre = findRun(dockerfile, "hf download");
  const seed = runs(dockerfile).filter((r) => r !== pre).find((r) => /\bcp\b/.test(r.body) && has(r.body, "/opt/hf-cache-seed"));
  const copy = copyLine(dockerfile);
  // The two roots the asserted paths are built from, read where they are defined.
  // Operands match to end-of-token: a suffix match lets a wrong-directory model pass.
  const seedRoot = /^\s*SEED_DIR="([^"]*)"/m.exec(entrypoint)?.[1] ?? "";
  const cacheRoot = /--cache-dir\s+(\S+)/.exec(pre?.body ?? "")?.[1] ?? "";
  const rev = /--revision\s+([0-9a-f]{40})/.exec(pre?.body ?? "")?.[1] ?? "";
  const snapshotDir = (root: string) => `${root}/${REPO_DIR}/snapshots/${rev}`;

  say(pre !== undefined, `pre-fetch RUN containing \`hf download\` exists`);
  if (pre) {
    const r = pre.body;
    say(has(r, "hf download"), "pre-fetch invokes `hf download`");
    const args = r.slice(r.indexOf("hf download") + "hf download".length).trim().split(/\s+/);
    say(args[0] === REPO_ID, `pre-fetch names the model id ${REPO_ID} (found ${args[0] || "none"})`);
    say(has(r, "HF_HUB_DISABLE_XET=1"), "pre-fetch disables the xet transport");
    const m = masking(r);
    say(m === "", `pre-fetch has no masking suffix (found ${m || "none"})`);
    for (const [label, tail] of [
      [`refs/<revision> — ${cacheRoot}/${REPO_DIR}/refs/${rev}`, `${cacheRoot}/${REPO_DIR}/refs/${rev}`],
      [ONNX, `${snapshotDir(cacheRoot)}/${ONNX}`],
      [TOKENIZER, `${snapshotDir(cacheRoot)}/${TOKENIZER}`],
    ] as [string, string][]) {
      say(assertedTwice(r, tail), `pre-fetch asserts with test -s: ${label}`);
    }
    say(pre.start < copy, `pre-fetch (line ${pre.start}) sits above the repo COPY (line ${copy})`);
  }

  say(copy > 0, "Dockerfile has a `COPY . <dir>` of the checkout");
  const pin = /pip3?\s+install[^\n]*?huggingface_hub==([0-9][0-9A-Za-z.+-]*)/.exec(dockerfile)?.[1] ?? "";
  say(pin !== "", "Dockerfile pins huggingface_hub with an exact `==` version");
  // The comment's stated reason: 2.x renamed the `huggingface-cli` console
  // script to `hf`, so a major bump would break the pre-fetch below.
  say(/^[01]\./.test(pin), `huggingface_hub pin stays below 2.x (found ${pin || "none"})`);

  say(seed !== undefined, "seed-copy RUN creating /opt/hf-cache-seed exists");
  if (seed) {
    say(/\bcp\s+-a\b/.test(seed.body), `seed copy uses \`cp -a\` (found ${seed.body.match(/\bcp\s+\S+/)?.[0] ?? "no cp"})`);
    const sm = masking(seed.body);
    say(sm === "", `seed copy has no masking suffix (found ${sm || "none"})`);
    say(!/\bif\s+\[\s+-d\b/.test(seed.body), "seed copy is not wrapped in an `if [ -d ]` guard");
    for (const [label, tail] of [
      [`refs/<revision> — ${seedRoot}/hub/${REPO_DIR}/refs/${rev}`, `${seedRoot}/hub/${REPO_DIR}/refs/${rev}`],
      [ONNX, `${snapshotDir(`${seedRoot}/hub`)}/${ONNX}`],
      [TOKENIZER, `${snapshotDir(`${seedRoot}/hub`)}/${TOKENIZER}`],
    ] as [string, string][]) {
      say(assertedTwice(seed.body, tail), `seed copy asserts with test -s: ${label}`);
    }
    say(seed.start < copy, `seed copy (line ${seed.start}) sits above the repo COPY (line ${copy})`);
  }

  // From the seed block's `SEED_DIR=` line to the `exec` that boots the user,
  // with comment lines dropped: the entrypoint's own prose names `cp -r` and
  // `|| true` to explain their absence, and a check that read it would pass on
  // a script that actually did those things.
  const block = executableLines(entrypoint.slice(entrypoint.search(/^\s*SEED_DIR=/m), entrypoint.lastIndexOf(`"$@`)));
  say(block !== "", "entrypoint has a cache-seed block");
  say(/\bcp\s+-a\b/.test(block), "entrypoint seeds with `cp -a`");
  say(has(entrypoint, `[ ! -d "$MODEL_DIR" ]`), "entrypoint keeps the don't-overwrite-an-existing-cache check");
  // The `for _f in` line is what the seed loop actually checks, so the three
  // files must be named there rather than anywhere in the block.
  const forLine = rawLines(block).find((l) => /^\s*for\s+_f\s+in\b/.test(l)) ?? "";
  const wanted = [`"refs/$REVISION"`, `"snapshots/$REVISION/${ONNX}"`, `"snapshots/$REVISION/${TOKENIZER}"`];
  const missing = wanted.filter((w) => !has(forLine, w));
  say(missing.length === 0, `entrypoint's \`for _f in\` line lists ${wanted.join(", ")} (missing ${missing.join(", ") || "none"}; found ${forLine.trim() || "no such line"})`);
  const seedMask = block.split("\n").filter((l) => /\bcp\b/.test(l)).map(masking).find((m) => m !== "") ?? "";
  say(seedMask === "", `entrypoint seed copy has no masking suffix (found ${seedMask || "none"})`);
  const epRev = /^\s*REVISION="([0-9a-f]{40})"/m.exec(entrypoint)?.[1] ?? "";
  say(rev !== "" && rev === epRev, `entrypoint REVISION equals the Dockerfile --revision (${rev.slice(0, 8) || "none"} vs ${epRev.slice(0, 8) || "none"})`);

  say(/docker run[^\n]*ghcr\.io\/trail-openers\/pi-rukas:/.test(docs), "troubleshooting docker command names the `ghcr.io/trail-openers/pi-rukas:` image");
  return fails;
}

const dir = process.argv[2] ? path.resolve(process.argv[2]) : REPO_ROOT;
const texts = FILES.map((f) => readFileSync(path.join(dir, f), "utf8"));

const failures = check(texts[0]!, texts[1]!, texts[2]!);
for (const f of failures) console.error(`✗ ${f}`);

// One canary pair: the real texts pass, and one mutated Dockerfile — the
// shipped defect shape, a masked download plus the onnx assertion dropped —
// fails naming both.
const preBody = findRun(texts[0]!, "hf download")?.body ?? "";
const preOnnxPath = `${/--cache-dir\s+(\S+)/.exec(preBody)?.[1] ?? ""}/${REPO_DIR}/snapshots/${/--revision\s+([0-9a-f]{40})/.exec(preBody)?.[1] ?? ""}/${ONNX}`;
const onnxAssertLine = (l: string) => /^\s*(?:&&\s*)?test -s\s/.test(l) && testOperand(l) === preOnnxPath;
const droppedOnnxLine = rawLines(texts[0]!).filter(onnxAssertLine).length;
// The shipped defect shape in one text: a masked download plus the dropped onnx
// assertion. The mutant must fail naming both halves it broke, and must really
// have dropped the one line it claims to have dropped.
const mut = check(
  rawLines(texts[0]!)
    .map((l) => (l.startsWith("      --cache-dir") ? l.replace(/ \\\s*$/, " || echo WARNING \\\\") : l))
    .filter((l) => !onnxAssertLine(l))
    .join("\n"),
  texts[1]!,
  texts[2]!,
);
console.log(`✓ canary: unmutated texts pass (${failures.length} failures)`);
const named = mut.filter((f) => f.includes(ONNX)).length + mut.filter((f) => f.includes("masking suffix")).length;
console.log(
  `${named === 2 && droppedOnnxLine === 1 ? "✓" : "✗"} canary: the mutated Dockerfile drops the pre-fetch onnx \`test -s\` line (${droppedOnnxLine} matched) and fails, naming it and the masking suffix [${mut.join(" | ")}]`,
);
if (failures.length !== 0 || named !== 2 || droppedOnnxLine !== 1) process.exit(1);
console.log("dockerfile-prefetch gate: PASS");
