#!/usr/bin/env bun
/**
 * The prompt tree and the code seam must not disagree about how to search.
 *
 * They did, for the whole life of the feature. `modules/core/vipune-*.md` and
 * `skill/vipune/SKILL.md` prescribed `vipune search '<topic>' --hybrid
 * --recency 0.3 --limit 5` — the one invocation `vipuneSearch` throws on —
 * while the calibrated seam sat in the tree, imported by nothing.
 *
 * Measured, on the real store: under the prompts' command the single correct
 * memory came back rank 44 of 50, absent from the top 5 (0.2164). Under the
 * seam's, rank 1 at 0.7733. And it compounds — the same files pair that command
 * with a "0.80+ act / <0.60 ignore" table calibrated on semantic cosine, while
 * hybrid RRF scores ceiling at 0.0769. A perfectly compliant agent searched in
 * a mode that returns noise, then discarded all of it for being under threshold.
 *
 * This test is offline — no binary needed — so it runs in the ordinary CI loop
 * and cannot regress silently.
 *
 * ## The rule is not "never use recency"
 *
 * Recency is legitimate when age-ordering IS the intent: `--recency 0.9
 * --memory-type observation` to pull back what a sibling agent stored minutes
 * ago is a correct use, and this gate leaves it alone. What is banned is the
 * measured-broken pair and the incoherent one:
 *
 *   1. `--hybrid` with non-zero `--recency`. RRF's whole top-5 spread is ~0.044
 *      while the recency term spans w·1.0, so any non-zero weight re-sorts by
 *      age and discards relevance entirely.
 *   2. A similarity threshold quoted next to a non-zero `--recency`. Once the
 *      score is `(1-w)·raw + w·decay` it is not a similarity any more, so a
 *      cosine-calibrated band cannot be applied to it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { searchArgv, vipuneChildEnv } from "../src/vipune.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCAN = ["modules", "agents-base", "pi-prompts", "skill", "docs", "extension/src"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(md|ts)$/.test(e)) out.push(full);
  }
  return out;
}

const files = [
  ...SCAN.flatMap((d) => walk(path.join(ROOT, d))),
  path.join(ROOT, "README.md"),
  path.join(ROOT, "AGENTS.md"),
];

interface Line {
  file: string;
  n: number;
  text: string;
}

/**
 * The `--recency` weight on a line, or undefined when the flag is absent.
 *
 * Parsed as a number rather than matched as a pattern: a negative lookahead for
 * "not zero" silently fails on `0.3`, because `\b` matches between the `0` and
 * the `.`. That bug would have made this whole gate vacuous.
 */
function recencyWeight(text: string): number | undefined {
  const m = text.match(/--recency[= ]\s*(\d+(?:\.\d+)?)/);
  return m ? Number.parseFloat(m[1] ?? "") : undefined;
}
const isNonZero = (w: number | undefined) => w !== undefined && w > 0;
const searchLines: Line[] = [];
for (const f of files) {
  let content: string;
  try {
    content = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  content.split("\n").forEach((text, i) => {
    if (text.includes("vipune search"))
      searchLines.push({ file: path.relative(ROOT, f), n: i + 1, text });
  });
}

assert(
  searchLines.length > 20,
  `the scan finds the documented search lines (${searchLines.length})`,
);

// ------------------------------------------- rule 1: hybrid + recency is dead

{
  const bad = searchLines.filter(
    (l) => /--hybrid\b/.test(l.text) && isNonZero(recencyWeight(l.text)),
  );
  assert(
    bad.length === 0,
    `no line pairs --hybrid with a non-zero --recency${bad.length ? ` — ${bad.map((b) => `${b.file}:${b.n}`).join(", ")}` : ""}`,
  );
  // Not vacuous: the exact string that shipped must still be recognised as bad.
  const shipped = "vipune search 'topic' --hybrid --recency 0.3 --limit 5";
  assert(
    /--hybrid\b/.test(shipped) && isNonZero(recencyWeight(shipped)),
    "canary: the shipped `--hybrid --recency 0.3` line IS caught by this predicate",
  );
  assert(
    recencyWeight("... --recency 0.0 --limit 5") === 0 &&
      !isNonZero(recencyWeight("... --recency 0.0 --limit 5")),
    "...and an explicit --recency 0.0 is NOT caught",
  );
}

// ------------------- rule 2: a similarity threshold needs a raw similarity

{
  const THRESHOLD = /\b0\.(?:[5-9]\d?)\+?\b/;
  const bad = searchLines.filter(
    (l) =>
      isNonZero(recencyWeight(l.text)) &&
      THRESHOLD.test(l.text.replace(/--recency[= ]\s*[\d.]+/, "")),
  );
  assert(
    bad.length === 0,
    `no line applies a similarity threshold to a recency-blended score${bad.length ? ` — ${bad.map((b) => `${b.file}:${b.n}`).join(", ")}` : ""}`,
  );
}

// --------------------------------- the seam is the single source of the argv

{
  const argv = searchArgv("spawn-semaphore.ts", { cwd: "/x" });
  assert(argv[0] === "search", "searchArgv builds a search");
  assert(argv.includes("--no-hybrid"), "...semantic by default");
  assert(
    argv[argv.indexOf("--recency") + 1] === "0.0",
    "...always with an EXPLICIT --recency 0.0, never inheriting vipune's 0.3 default",
  );
  assert(argv.includes("--no-touch") && argv.includes("--json"), "...--no-touch and --json");
  assert(
    argv[argv.length - 2] === "--" && argv[argv.length - 1] === "spawn-semaphore.ts",
    "...and the query last after `--`, so a leading dash is not parsed as a flag",
  );

  const hybrid = searchArgv("x", { cwd: "/x", hybrid: true });
  assert(
    hybrid.includes("--hybrid") && hybrid[hybrid.indexOf("--recency") + 1] === "0.0",
    "the hybrid leg is also pinned to --recency 0.0 — the only combination it is calibrated for",
  );

  const typed = searchArgv("x", { cwd: "/x", memoryType: "guard" });
  assert(typed[typed.indexOf("--memory-type") + 1] === "guard", "a typed leg passes --memory-type");
}

// ------------------- rule 3: prose must not teach a command the roles cannot run

{
  // The failure this catches actually happened, in this very series: #424
  // denied `vipune update` to every role while three prompt files went on
  // instructing agents to run `vipune update <id> --status active`. An agent
  // following doctrine would have hit a permission denial with no explanation.
  //
  // Keyed on the permission file rather than a hardcoded list, so denying a new
  // verb automatically starts policing the prose for it.
  const agents = JSON.parse(readFileSync(path.join(ROOT, "agents.json"), "utf8")) as {
    agent: Record<string, { permission?: { bash?: Record<string, string> } }>;
  };

  const allowedVerbs = new Set<string>();
  for (const role of Object.values(agents.agent)) {
    for (const [pattern, verdict] of Object.entries(role.permission?.bash ?? {})) {
      const m = pattern.match(/^vipune (\w+)/);
      if (m?.[1] && verdict === "allow") allowedVerbs.add(m[1]);
    }
  }
  assert(allowedVerbs.size > 0, `the allowlist grants ${allowedVerbs.size} vipune verb(s)`);
  assert(
    !allowedVerbs.has("delete") && !allowedVerbs.has("update"),
    "...and neither `delete` nor `update` is among them",
  );

  /** `vipune --help` as of 0.9.0. A word that is not one of these is prose. */
  const VIPUNE_SUBCOMMANDS = new Set([
    "validate",
    "add",
    "search",
    "get",
    "list",
    "delete",
    "update",
    "doctor",
    "reindex",
    "project",
    "version",
    "mcp",
  ]);

  const taught: string[] = [];
  for (const f of files) {
    let content: string;
    try {
      content = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    content.split("\n").forEach((text, i) => {
      // A commented-out line is documentation about the prohibition, not an
      // instruction to run it.
      if (/^\s*(#|\/\/|<!--|\*)/.test(text)) return;
      // Only a real subcommand in command position counts. Prose like "vipune
      // memory" or "vipune searches" is not an instruction to run anything, and
      // matching any word after `vipune` flags 58 such lines.
      const m = text.match(/(?:^\s*|[`$]\s*)vipune (\w+)/);
      const verb = m?.[1];
      if (!verb || !VIPUNE_SUBCOMMANDS.has(verb) || allowedVerbs.has(verb)) return;
      // Prose that names the verb in order to FORBID it is the point of the
      // documentation, not a violation of it.
      if (/denied|deny|cannot|not available|forbidden|refus|granted to no|not granted/i.test(text))
        return;
      taught.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert(
    taught.length === 0,
    `no prose teaches a vipune verb the roles cannot run${taught.length ? ` — ${taught.join(", ")}` : ""}`,
  );
}

// ------------------------------------- the env covers what prose cannot reach

{
  const env = vipuneChildEnv();
  assert(
    env.VIPUNE_RECENCY_WEIGHT === "0",
    "every specialist child is spawned with VIPUNE_RECENCY_WEIGHT=0",
  );
  // This is the point of it: most documented lines pass no --recency at all and
  // would otherwise silently inherit 0.3, as would any query an agent composes.
  const noFlag = searchLines.filter((l) => !/--recency/.test(l.text));
  assert(
    noFlag.length > 0,
    `...which matters: ${noFlag.length} documented lines pass no --recency and rely on it`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
