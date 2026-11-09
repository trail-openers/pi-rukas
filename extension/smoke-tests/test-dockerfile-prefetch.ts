#!/usr/bin/env bun
/**
 * vipune model pre-fetch gate — #2055.
 *
 * The image pre-fetches vipune's embedding model with `hf download` and the
 * entrypoint seeds the mounted cache volume from /opt/hf-cache-seed. Both
 * halves once masked their own failure, so the published image shipped with no
 * model and every offline `vipune search` died with the 404 that
 * docs/troubleshooting.md tells users to fix by refreshing. What is checked is
 * only what made that failure visible: the download must not be able to fail
 * quietly, the files vipune opens must be asserted where they are written and
 * where they are copied, and the revision must be one literal across files.
 *
 * `check` is the whole gate and reads three texts; it returns one string per
 * failed check. `main` runs it on the real files and the canary runs the same
 * function on one mutated Dockerfile text, so a green real run means the
 * assertions can fail.
 *
 * No escape hatch: this file reads no `process.env` — a gate the build can
 * switch off is a gate that never fails. argv[2] retargets the three files to
 * a directory, which is how the gate was shown red at the pre-fix commit.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FILES = [".devcontainer/Dockerfile", ".devcontainer/entrypoint.sh", "docs/troubleshooting.md"];
const ONNX = "onnx/model.onnx";
const TOKENIZER = "tokenizer.json";

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

/** `test -f X` immediately followed by `&& test -s X` over the SAME path — both
 * flags, because a directory passes `-s` and an empty file passes `-f`. */
function assertedTwice(run: string, tail: RegExp): boolean {
  for (const f of run.matchAll(/test\s+-f\s+(\S+)/g)) {
    const gap = run.slice(f.index + f[0].length);
    const s = /&&\s*test\s+-s\s+(\S+)/.exec(gap);
    if (s && s[1] === f[1] && !gap.slice(0, s.index).includes("test") && tail.test(f[1]!)) return true;
  }
  return false;
}

/** The gate. Returns one string per failed check; empty means the texts pass. */
function check(dockerfile: string, entrypoint: string, docs: string): string[] {
  const fails: string[] = [];
  const say = (ok: boolean, what: string) => {
    if (!ok) fails.push(what);
  };
  const pre = findRun(dockerfile, "hf download");
  const seed = runs(dockerfile).filter((r) => r !== pre).find((r) => /\bcp\b/.test(r.body) && has(r.body, "/opt/hf-cache-seed"));
  const copy = copyLine(dockerfile);

  say(pre !== undefined, `pre-fetch RUN containing \`hf download\` exists`);
  if (pre) {
    const r = pre.body;
    say(has(r, "hf download"), "pre-fetch invokes `hf download`");
    say(has(r, "HF_HUB_DISABLE_XET=1"), "pre-fetch disables the xet transport");
    const m = masking(r);
    say(m === "", `pre-fetch has no masking suffix (found ${m || "none"})`);
    for (const [label, tail] of [
      ["refs/<revision>", /\/refs\//],
      [ONNX, new RegExp(`/${ONNX}$`)],
      [TOKENIZER, new RegExp(`/${TOKENIZER}$`)],
    ] as [string, RegExp][]) {
      say(assertedTwice(r, tail), `pre-fetch asserts with test -s: ${label}`);
    }
    say(pre.start < copy, `pre-fetch (line ${pre.start}) sits above the repo COPY (line ${copy})`);
  }

  say(copy > 0, "Dockerfile has a `COPY . <dir>` of the checkout");

  const pin = /pip3?\s+install[^\n]*?huggingface_hub==([0-9][0-9A-Za-z.+-]*)/.exec(dockerfile)?.[1] ?? "";
  say(pin !== "", "Dockerfile pins huggingface_hub with an exact `==` version");

  say(seed !== undefined, "seed-copy RUN creating /opt/hf-cache-seed exists");
  if (seed) {
    say(/\bcp\s+-a\b/.test(seed.body), `seed copy uses \`cp -a\` (found ${seed.body.match(/\bcp\s+\S+/)?.[0] ?? "no cp"})`);
    const sm = masking(seed.body);
    say(sm === "", `seed copy has no masking suffix (found ${sm || "none"})`);
    say(!/\bif\s+\[\s+-d\b/.test(seed.body), "seed copy is not wrapped in an `if [ -d ]` guard");
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
  say(has(block, ONNX) && has(block, TOKENIZER), "entrypoint names onnx/model.onnx and tokenizer.json");
  const seedLine = block.split("\n").find((l) => /\bcp\b/.test(l)) ?? "";
  const seedMask = masking(seedLine);
  say(seedMask === "", `entrypoint seed copy has no masking suffix (found ${seedMask || "none"})`);
  const rev = /^\s*REVISION="([0-9a-f]{40})"/m.exec(entrypoint)?.[1] ?? "";
  const dockerRev = /--revision\s+([0-9a-f]{40})/.exec(pre?.body ?? "")?.[1] ?? "";
  say(rev !== "" && rev === dockerRev, `entrypoint REVISION equals the Dockerfile --revision (${dockerRev.slice(0, 8) || "none"} vs ${rev.slice(0, 8) || "none"})`);

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
const mutated = texts[0]!.split("\n")
  .map((l) => (l.startsWith("      --cache-dir") ? l.replace(/ \\\s*$/, " || echo WARNING \\\\") : l))
  .filter((l) => !/test -s \/home\/vscode\/\.cache\/huggingface\/hub\/models--BAAI--bge-small-en-v1\.5\/snapshots\/[0-9a-f]{40}\/onnx\/model\.onnx/.test(l))
  .join("\n");
const mutantFails = check(mutated, texts[1]!, texts[2]!);
const namesOnnx = mutantFails.some((f) => f.includes("onnx/model.onnx"));
const namesMask = mutantFails.some((f) => f.includes("masking suffix"));
console.log(`✓ canary: unmutated texts pass (${failures.length} failures)`);
console.log(`${namesOnnx && namesMask ? "✓" : "✗"} canary: the mutated Dockerfile fails, naming the missing onnx assertion and the masking suffix [${mutantFails.join(" | ")}]`);
if (failures.length !== 0 || !namesOnnx || !namesMask) process.exit(1);
console.log("dockerfile-prefetch gate: PASS");
