#!/usr/bin/env bun
/**
 * vipune model pre-fetch gate — the detectors #2055's gate runs. Split out so
 * the gate file stays readable and under the size cap; every function here is
 * pure text inspection over a Dockerfile RUN or an entrypoint block, and each
 * is proven red-then-green by `test-dockerfile-prefetch.ts`.
 */

import path from "node:path";


const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const DOCKERFILE = path.join(REPO_ROOT, ".devcontainer", "Dockerfile");
const ENTRYPOINT = path.join(REPO_ROOT, ".devcontainer", "entrypoint.sh");
const TROUBLESHOOTING = path.join(REPO_ROOT, "docs", "troubleshooting.md");
const MODEL = "BAAI/bge-small-en-v1.5";

type RunInstruction = { startLine: number; user: string; text: string };

function runInstructions(text: string): RunInstruction[] {
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
      // `body`, not `t`: with the continuation backslash kept, a last line that
      // happens to begin with RUN would be taken for the start of a new one.
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

/** The instruction that downloads the model — the pre-fetch. */
function prefetchInstruction(runs: RunInstruction[]): RunInstruction | undefined {
  return runs.find((r) => /\b(?:hf|huggingface-cli)\s+download\b/.test(r.text) && r.text.includes(MODEL));
}

/** The instruction that creates the image's model seed directory. */
function seedCopyInstruction(runs: RunInstruction[], seed: string): RunInstruction | undefined {
  return runs.find((r) => /\bcp\b/.test(r.text) && r.text.includes(seed));
}

/** The line of the `COPY . <dir>` of the checkout, or -1. */
function repoCopyLine(text: string): number {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (/^COPY\b/.test(t) && /\s\.\s|\s\.\t/.test(t)) return i + 1;
  }
  return -1;
}

// ---------------------------------------------------------------- detectors

/** Drop comment lines so a detector judges only what the shell executes. */
function executable(command: string): string[] {
  return command.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
}

/** A masking suffix: `|| echo …`, `|| true`, `|| :`, or stderr silenced into one. */
function maskingSuffix(command: string): string {
  for (const line of executable(command)) {
    const m = line.match(/\|\|\s*(?:echo\b|true\b|:\s*$|:\s)/) ?? line.match(/\|\|\s*:/);
    if (m) return m[0].trim();
  }
  return "";
}

/** Whether any executed line redirects stderr into /dev/null. */
function silencesStderr(command: string): boolean {
  return executable(command).some((l) => l.includes("2>/dev/null"));
}

/** Whether the run is wrapped in an `if [ -d … ]` existence guard. */
function hasDirGuard(command: string): boolean {
  return /\bif\s+\[\s+-d\s/.test(command);
}

/** Whether the command tests a directory's existence at all. */
function testsDirExistence(command: string): boolean {
  return /\[\s+!?\s*-d\s/.test(command);
}

/** A recursive copy that does not preserve (`cp -r`/`-rn`, but not `-a`). */
function copiesWithoutPreserve(command: string): string {
  const m = command.match(/\bcp\s+(-[A-Za-z]+)\b/);
  if (!m) return "";
  return m[1]!.includes("a") ? "" : m[0];
}


/**
 * The regex fragments below match shell text — the literal `$REVISION` and
 * `$_f` spellings, and the `[ ! -f … ]` test form — that a JavaScript regex
 * literal written in this file would misread as anchors and character classes.
 * Every fragment is therefore concatenated from single-quoted pieces and
 * character codes. Where a fragment quotes a `$`, the `$` is `DOLLAR` as data:
 * in a regex source a `$` immediately before `]` is read as an anchor.
 */
const B = String.fromCharCode(92); // \
const LB = String.fromCharCode(91); // [
const CB = String.fromCharCode(93); // ]
const DQ = String.fromCharCode(34); // "
const EX = String.fromCharCode(33); // !
const NC = String.fromCharCode(94); // ^
const LC = String.fromCharCode(123); // {
const RC = String.fromCharCode(125); // }
const DOLLAR = String.fromCharCode(36); // $

/** The run of characters between two tokens of one shell line: neither a
 * newline nor a tab. Used between a `test -f` and the path it names, and
 * between that path and the `&&` that joins the next assertion. */
const GAP = LB + NC + B + "n" + B + "t" + CB + "*";
/** A run of characters short of a newline. */
const SAME_LINE = LB + NC + B + "n" + CB + "*";
/** `for _f in <same line>` — the entrypoint loop header that names the files. */
const LOOP_LIST = "for" + B + "s+_f" + B + "s+in" + B + "b" + SAME_LINE;
/** The entrypoint loop body: `[ ! -f "$MODEL_DIR/$_f" ]`, and its `-s` twin. */
const LOOP_BODY = (flag: string) =>
  B +
  LB +
  B +
  "s+" +
  EX +
  B +
  "s*-" +
  flag +
  B +
  "s+" +
  DQ +
  "?" +
  LB +
  DOLLAR +
  RC +
  CB +
  "?MODEL_DIR" +
  LB +
  RC +
  CB +
  "?/" +
  LB +
  DOLLAR +
  CB +
  "_f" +
  DQ +
  "?";

/**
 * A model file the seed must carry. `name` matches the path a `test -f`/`test
 * -s` pair names and must sit at the END of the asserted path — a snapshot
 * directory under `…/models--BAAI--bge-small-en-v1.5/` would otherwise let the
 * repository id alone satisfy a `refs/…` needle; `loop` matches the same path
 * as the entrypoint writes it in its `for _f in …` list.
 */
interface ModelNeedle {
  /** Literal trailing path component the assertion must end with — the whole
   * `test` operand is captured and compared, so no regex may meet a path. */
  tail: string;
  /** The same path as the entrypoint writes it in its `for _f in …` list. */
  loop: string;
}

/**
 * The files vipune loads — the ONNX session and the tokenizer it opens
 * (`src/embedding/engine.rs`: `onnx/model.onnx`, `tokenizer.json`) — plus the
 * ref its resolver reads to resolve the pinned revision without the network.
 */
const MODEL_ONNX: ModelNeedle = { tail: "/onnx/model.onnx", loop: "onnx/model[.]onnx" };
const MODEL_TOKENIZER: ModelNeedle = { tail: "/tokenizer.json", loop: "tokenizer[.]json" };
const SHA = "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a";
const MODEL_REF: ModelNeedle = { tail: "/refs/" + SHA, loop: "refs/[" + DOLLAR + "]REVISION" };
const MODEL_NEEDLES: ModelNeedle[] = [MODEL_ONNX, MODEL_TOKENIZER, MODEL_REF];
const MODEL_LABELS = ["onnx/model.onnx", "tokenizer.json", "refs/<revision>"];

/**
 * Whether a command asserts one model file and proves it both a FILE and
 * NON-EMPTY: `-f` because a directory satisfies `-s` alone, `-s` because `-f`
 * passes on a zero-byte file — a site has to say both, for the same path. A
 * Dockerfile RUN writes `test -f` and `test -s` over the literal path; the
 * entrypoint tests one `$_f` in a loop whose `for _f in …` list names the file,
 * so there the list carries the name and the body carries both tests.
 *
 * The patterns are built from character codes rather than written as regex
 * literals because they match shell text — `$REVISION`, `$_f`, the `[ ! -f … ]`
 * form — that a regex literal in this file misreads: a `$` just before `]` is
 * an anchor, not a dollar sign, which is how an earlier draft of these
 * detectors matched nothing at all and still reported green.
 */
function assertsModelFile(command: string, needle: ModelNeedle): boolean {
  // One assertion, not two unrelated checks: a `test -f X` immediately
  // followed by `&& test -s X` over the SAME path. Each test is matched on
  // its own and the paths compared by index, because a single pattern
  // spanning both halves silently stopped matching in this file — and a gate
  // whose model-file detector never matches reports green on an image shipped
  // without the model.
  const operand = LB + NC + B + "s" + CB + "+";
  const fHalf = "test" + B + "s+-f" + B + "s+(" + operand + ")";
  const sHalf = "&&" + B + "s*test" + B + "s+-s" + B + "s+(" + operand + ")";
  let direct = false;
  const fRe = new RegExp(fHalf, "g");
  const sRe = new RegExp(sHalf);
  let fm: RegExpExecArray | null = fRe.exec(command);
  while (fm !== null) {
    const gap = command.slice(fm.index + fm[0].length);
    const sm = sRe.exec(gap);
    // The pair names ONE path, and nothing but the joining `&&` may sit
    // between the two tests — the gap contains no other `test`, so a `-f`
    // cannot borrow a neighbouring file's `-s`.
    if (
      sm !== null &&
      sm[1] === fm[1] &&
      gap.slice(0, sm.index).indexOf("test") === -1 &&
      !fm[1]!.includes("$(") &&
      fm[1]!.endsWith(needle.tail)
    ) {
      direct = true;
      break;
    }
    fRe.lastIndex = fm.index + 1;
    fm = fRe.exec(command);
  }
  const looped =
    new RegExp(LOOP_LIST + needle.loop).test(command) &&
    new RegExp(LOOP_BODY("f")).test(command) &&
    new RegExp(LOOP_BODY("s")).test(command);
  return direct || looped;
}

/** Whether the entrypoint's post-copy failure path prints the missing path. */
function namesFailedPath(block: string): boolean {
  return (
    new RegExp("echo" + GAP + "MODEL_DIR/" + LB + DOLLAR + CB + "_f").test(block) &&
    new RegExp("exit" + B + "s+1").test(block)
  );
}

/** The huggingface_hub pin in the image ("" when absent or unpinned). */
function hubPin(text: string): string {
  const m = text.match(
    /pip3?\s+install[^\n]*?huggingface_hub\s*(?:==|>=|~=|<=)\s*([0-9][0-9a-z.+-]*)/,
  );
  return m ? m[1]! : "";
}

/** Whether the huggingface_hub pin is an exact `==` pin. */
function hubPinIsExact(text: string): boolean {
  return /pip3?\s+install[^\n]*?huggingface_hub\s*==\s*[0-9]/.test(text);
}

/** The `SEED_DIR="…"` value in the entrypoint, or "". */
function entrypointSeedDir(entrypoint: string): string {
  const m = entrypoint.match(new RegExp("^\\s*SEED_DIR=" + DQ + "([^" + DQ + "]+)" + DQ, "m"));
  return m ? m[1]! : "";
}

/** The `REVISION="…"` value in the entrypoint, or "". */
function entrypointRevision(entrypoint: string): string {
  const m = entrypoint.match(new RegExp("^\\s*REVISION=" + DQ + "([^" + DQ + "]+)" + DQ, "m"));
  return m ? m[1]! : "";
}

/**
 * The entrypoint block that seeds the cache: from its `CACHE_DIR=` line to the
 * line that execs the user command. The exec line is found by its `$@"` tail —
 * assembled from codes and matched as text, never as a pattern, because `$@` in
 * a pattern is an anchor.
 */
function entrypointSeedBlock(entrypoint: string): string {
  const start = entrypoint.search(/^\s*CACHE_DIR=/m);
  const end = entrypoint.lastIndexOf(DOLLAR + "@" + DQ);
  if (start === -1 || end === -1 || end < start) return "";
  return entrypoint.slice(start, end);
}

/** The troubleshooting entry for the vipune model failure: heading to the next `###`. */
function prefetchTroubleshootingSection(md: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^###\s/.test(l) && /embedding model/.test(l));
  if (start === -1) return "";
  const end = lines.findIndex((l, i) => i > start && /^###\s/.test(l));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

/** Every `/opt/…` path that appears to be the model seed. */
function seedPathsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\/opt\/[A-Za-z0-9._/-]*hf-cache-seed/g)].map((m) => m[0]))];
}

/** A canonical seed path: no trailing slash. */
function canonicalSeed(p: string): string {
  return p.replace(/\/+$/, "");
}

// ---------------------------------------------------------------- the gate


export {
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
};
