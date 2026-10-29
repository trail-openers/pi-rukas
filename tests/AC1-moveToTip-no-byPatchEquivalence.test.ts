#!/usr/bin/env bun
/**
 * AC1 — #1908: `moveToTip` has no `byPatchEquivalence` parameter, and no source
 * file under `extension/src` references the name.
 *
 * The parameter is dead: both call sites in
 * `work-driver-lens-fix-reposition-gate.ts` pass the literal `true` (the
 * fast-forward arm runs `merge --ff-only` and returns directly, never through
 * here), so the value is a constant and the `RepositionResult` field it filled
 * is always the same — a caller reading the signature believes it has a choice
 * to make and does not.
 *
 * Three reads, because each catches a different way the removal can be faked:
 *
 *  - the RUNTIME arity of the exported function, taken from the real entry
 *    point. `Function.prototype.length` counts the parameters before the first
 *    default or rest, so this is the signature the module actually exports, not
 *    what somebody commented out;
 *  - the DECLARED parameter list. Arity alone cannot tell "the parameter is
 *    gone" from "the parameter became optional": an optional `byPatchEquivalence?`
 *    keeps the dead value alive and reports the reduced arity. This read names
 *    every declared parameter, so a soft reintroduction fails here too;
 *  - the whole-tree reference scan under `extension/src` (comments stripped,
 *    the same reading `test-seams-wired.ts` applies), which is the criterion's
 *    own wording and the only one that catches a caller left behind.
 *
 * Each case carries a positive control: the canary this test writes into the
 * module must itself turn the read red, so a check that matches nothing at all
 * can never read as "the removal is complete".
 */
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { moveToTip } from "../extension/src/work-driver-lens-fix-reposition-move.ts";

const FILE = "AC1-moveToTip-no-byPatchEquivalence.test.ts";
const TERM = "[0m";
const RED = `[31m`;

let exitCode = 0;
function fail(msg: string): void {
  // The runner's contract: a failing file names itself.
  console.error(`${RED}FAIL ${FILE}: ${msg}${TERM}`);
  exitCode = 1;
}
function pass(msg: string): void {
  console.log(`✓ ${msg}`);
}

const SRC = path.resolve(import.meta.dirname, "..", "extension", "src");
const MOVE_MODULE = path.join(SRC, "work-driver-lens-fix-reposition-move.ts");
/** The 8 parameters #1908 leaves behind; `byPatchEquivalence` is the 9th today. */
const EXPECTED_PARAMS = [
  "execFn",
  "tree",
  "branchName",
  "issues",
  "issueTitle",
  "treeSha",
  "tipSha",
  "why",
];
const DEAD = "byPatchEquivalence";
const CANARY = "__ac1-1908-canary.ts";

/** Comments carry the word today (the parameter's own doc block), so a scan
 *  that counted them could never go green. Stripped the way the export-wiring
 *  gate strips them. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

function listSources(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(dir, f));
}

/** Every .ts under `dir` whose CODE (not prose) contains `needle`. */
function referencesIn(dir: string, needle: string): string[] {
  return listSources(dir)
    .filter((f) => stripComments(readFileSync(f, "utf8")).includes(needle))
    .map((f) => path.relative(dir, f))
    .sort();
}

/**
 * The parameter list of `export async function <fn>(` in `file`, as an array of
 * names, or `undefined` when no such declaration exists.
 *
 * Balanced-paren split rather than the project's pinned `typescript` package:
 * the file is run as `bun <path>` from wherever the parent happens to be, and
 * `bun` resolves bare specifiers from the ENTRY file's directory — a root-level
 * test cannot resolve `typescript` out of `extension/node_modules`. The read is
 * still structural (it splits on top-level commas, so the `issues: number[]`
 * and `issueTitle: string | undefined` annotations cannot confuse it), and the
 * canary below proves it fires on the real declaration.
 *
 * Comments are stripped FIRST: this signature carries a doc block on each of
 * its last two parameters, and those `*`-and-`/` runs are both `,`-bearing and
 * `{}`-free, so an unstripped read turns one parameter into several.
 */
function declaredParams(file: string, fn: string): string[] | undefined {
  const text = stripComments(readFileSync(file, "utf8"));
  const head = new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}\\s*\\(`).exec(text);
  if (head === null) return undefined;
  const open = head.index + head[0].length - 1;
  let depth = 0;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return undefined;
  const body = text.slice(open + 1, close);
  const parts: string[] = [];
  let level = 0;
  let current = "";
  for (const c of body) {
    if (c === "(" || c === "[" || c === "{") level++;
    else if (c === ")" || c === "]" || c === "}") level--;
    if (c === "," && level === 0) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  if (current.trim() !== "") parts.push(current);
  return parts.map((p) => p.split(":")[0].replace(/\s|\?/g, ""));
}

/** Drop the canary into the module, run `read` against it, always clean up. */
function withCanary<T>(read: () => T): T {
  const canary = path.join(SRC, CANARY);
  rmSync(canary, { force: true });
  try {
    return read();
  } finally {
    rmSync(canary, { force: true });
  }
}

// ── 1. The runtime signature: the real entry point, not a text match on it.
{
  const arity = (moveToTip as unknown as { (...args: unknown[]): unknown }).length;
  if (arity !== EXPECTED_PARAMS.length) {
    fail(
      `moveToTip still takes the dead parameter: expected ${EXPECTED_PARAMS.length} parameters ` +
        `(${EXPECTED_PARAMS.join(", ")}), got ${arity}`,
    );
  } else {
    pass(`moveToTip's exported signature takes ${arity} parameters`);
  }
}

// ── 2. The declared parameter list: catches an optional reintroduction that
//    would leave the arity assertion green.
{
  const params = declaredParams(MOVE_MODULE, "moveToTip");
  if (params === undefined) {
    fail(`no \`export async function moveToTip(\` declaration found to judge`);
  } else if (params.includes(DEAD)) {
    fail(
      `moveToTip still declares ${DEAD}: its parameter list is ${params.join(", ")}`,
    );
  } else if (params.join(",") !== EXPECTED_PARAMS.join(",")) {
    fail(
      `moveToTip's parameters are ${params.join(", ")} — expected exactly ${EXPECTED_PARAMS.join(", ")}`,
    );
  } else {
    pass(`moveToTip declares no ${DEAD} — parameters are ${params.join(", ")}`);
  }
  // Non-vacuity: the reader must extract the list from the real declaration.
  // A reader that returned `undefined`, or a list of empty strings, would let
  // every branch above fall through to a green it did not earn.
  const arity = (moveToTip as unknown as { (...args: unknown[]): unknown }).length;
  if (params === undefined || params.length !== arity) {
    fail(
      `the parameter reader found ${params?.length ?? "no"} names for a function of arity ${arity} — the check above judged nothing`,
    );
  } else {
    pass(`non-vacuity: the reader extracted ${params.length} names, matching the arity`);
  }
}

// ── 3. The whole-tree reference scan, with its positive control.
{
  withCanary(() => {
    const found = referencesIn(SRC, DEAD);
    if (found.length !== 0) {
      fail(`files under extension/src still reference ${DEAD}: ${found.join(", ")}`);
    } else {
      pass(`no source file under extension/src references ${DEAD}`);
    }
    // Without this, a scan that matched nothing — wrong directory, a typo in
    // the term, an over-eager comment strip — reports the same green.
    writeFileSync(path.join(SRC, CANARY), `export const probe = "${DEAD}";\n`);
    const fired = referencesIn(SRC, DEAD);
    if (!fired.includes(CANARY)) {
      fail(
        `the reference scan did not fire on a planted reference (${CANARY} absent from ${JSON.stringify(fired)}) — the scan above cannot be trusted`,
      );
    } else {
      pass(`non-vacuity: the scan fires on a planted reference (${CANARY})`);
    }
  });
}

process.exit(exitCode);
