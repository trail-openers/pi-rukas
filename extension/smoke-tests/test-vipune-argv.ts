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
 *
 * ## Rule 3 polices a SET, and the set is derived, not remembered
 *
 * Rule 3 forbids prose teaching a vipune verb no role can run. Its verb list
 * used to be a hand-written 14-entry `Set` — so a prose line teaching
 * `vipune export rows.jsonl` passed, because `export` had never been added
 * (#1386 measured it). Now the policed set must EQUAL every verb the installed
 * `vipune --help` lists minus every verb `agents.json` grants (asserted against
 * the binary when present, skipped with a notice otherwise), and the guard's
 * refused set in `memory-write-guard.ts` must equal that same difference plus
 * `update` — which is refused for its mutating flags, not as a bare verb. A
 * future `agents.json` grant of a refused verb therefore fails the gate instead
 * of silently contradicting the code refusal, and a vipune release that adds a
 * verb eventually breaks the gate instead of going unpoliced.
 *
 * The exemption is prohibition grammar in the SAME CLAUSE as the verb (the
 * text between two clause breaks — `; : — . (newlines`, backticks, brackets —
 * containing it), not keyword adjacency anywhere on the line: measured, a line
 * teaching `vipune export` that merely said "the operator" nearby passed.
 */

import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  EXEMPT_VIPUNE_VERBS,
  REFUSED_VIPUNE_VERBS,
  refusesMemoryWrite,
} from "../src/memory-write-guard.ts";
import { searchArgv, vipuneChildEnv } from "../src/vipune.ts";

const execFileAsync = promisify(execFile);

/**
 * The verb list `vipune --help` prints, or null when the binary is absent.
 *
 * Parsed from the `Commands:` block (two-space indent, name then optional
 * description) rather than from a committed fixture — the same offline/live dual
 * shape `test-vipune-capability.ts` uses, so the gate still runs where vipune
 * is not installed. Bounded: a hanging binary is a skip, not a hung suite.
 */
async function listVipuneHelpVerbs(): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync("vipune", ["--help"], { timeout: 10_000 });
    const lines = stdout.split("\n");
    const start = lines.findIndex((l) => /^Commands:/.test(l));
    if (start < 0) return null;
    const verbs = new Set<string>();
    for (const line of lines.slice(start + 1)) {
      if (/^\S/.test(line)) break; // the next top-level section (`Options:`)
      const m = /^ {2}(\w[\w-]*)/.exec(line);
      // `help` is clap's own verb, not a vipune capability.
      if (m?.[1] && m[1] !== "help") verbs.add(m[1]);
    }
    return verbs.size > 0 ? verbs : null;
  } catch {
    return null;
  }
}

/**
 * Does the clause containing the vipune verb also PROHIBIT it?
 *
 * A clause is the run of text around the verb up to the nearest break: `;` `:`
 * `.` `(` `)` `[` `]` a backtick, an em/en dash set off by spaces, or a line
 * break. Whole-line keyword adjacency was the bug: it exempted a line that
 * TEACHED `vipune export` and merely mentioned "operator" three clauses away.
 */
function prohibitsVerb(text: string, verbEnd: number): boolean {
  // A backtick OPENS or CLOSES quoting; it is not a boundary you can stop at,
  // because the prohibition almost always sits on the other side of the closing
  // one (`` never run `vipune update`, it replaces content ``). So: step over a
  // backtick and keep scanning, and treat the NEXT non-backtick character as
  // the real edge of that run.
  const isBreak = (ch: string): boolean =>
    /[;:.()\[\]\n\r]/.test(ch) || /\s[\u2014\u2013]\s/.test(ch);
  const at = (i: number): string => text[i] ?? "";
  let from = verbEnd;
  while (from > 0) {
    const prev = at(from - 1);
    if (prev !== "`" && !isBreak(prev)) {
      from--;
      continue;
    }
    if (prev === "`") {
      from--;
      // Only a run whose character BEFORE the backtick is still clause-internal
      // is the same clause; a `.` or `;` before it ends the clause.
      if (from > 0 && at(from - 1) !== "`" && !isBreak(at(from - 1))) continue;
      break;
    }
    break;
  }
  let to = verbEnd;
  while (to < text.length) {
    const cur = at(to);
    if (cur !== "`" && !isBreak(cur)) {
      to++;
      continue;
    }
    if (cur === "`") {
      to++;
      if (at(to) !== "`" && !isBreak(at(to))) continue;
      break;
    }
    break;
  }
  const clause = text.slice(from, to);
  // `deny` covers "denied"/"denies"; `refus` covers refusal/refused.
  return /denied|deny|denies|cannot|not available|forbidden|refus|never|granted to no|not granted|operator action|operator command|operator's|operator runs|operator reviews|out of scope|do not|don't/i.test(
    clause,
  );
}

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
    !allowedVerbs.has("delete") &&
      !allowedVerbs.has("update") &&
      !allowedVerbs.has("prune") &&
      !allowedVerbs.has("promote"),
    "...and none of `delete`, `update`, `prune` or `promote` is among them",
  );

  /**
   * The offline fallback verb set (`vipune --help` as of 0.9.0). A word that is
   * not one of these is prose. When the binary is installed, the block below
   * asserts THIS set equals what the binary lists — so a vipune release that
   * adds a verb breaks the gate here rather than leaving that verb unpoliced.
   */
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
    // Both are operator-only verbs and both appeared in prose that taught agents
    // to run them (#1386): the consolidation pass originally read "promote the
    // candidate" / "prune the stale row" as instructions. They are policed here
    // so the prose cannot drift back to teaching them.
    "promote",
    "prune",
    // #1386 measured the three whole-store verbs as unpoliced: `export`,
    // `backup` and `import` copy or load every project's plaintext rows, and a
    // prose line teaching one of them passed because none was ever listed.
    "export",
    "backup",
    "import",
    // The lifecycle-hook handler. Policed as a verb the prose must not TEACH
    // (no role needs to invoke it — the binary runs it from a hook), while
    // EXEMPT_VIPUNE_VERBS keeps it out of the code refusal. The two lists are
    // deliberately different; the equation below reconciles them.
    "hook",
  ]);

  // ---------- the two equations the gap gate adopted (#1437)
  //
  // policed set == `vipune --help` minus every verb agents.json grants
  // guard's refused set == that same difference, plus `update`
  //
  // `update` is the one verb refused for its FLAGS rather than as a bare verb
  // (an update with no mutating flag changes nothing), so it is ungranted and
  // policed but not in the bare-verb refusal list. `hook` is the mirror case:
  // the binary invokes it from a hook, so it is policed against prose but
  // deliberately not refused by code. Both reconciliations are explicit below,
  // and a future agents.json grant of a refused verb fails here instead of
  // silently contradicting the code refusal.
  const expectedPoliced = new Set(
    [...VIPUNE_SUBCOMMANDS].filter((v) => !allowedVerbs.has(v)),
  );
  const policedDelta = [...expectedPoliced].filter((v) => !VIPUNE_SUBCOMMANDS.has(v));
  assert(
    policedDelta.length === 0,
    `the policed set equals every listed verb minus the granted ones${policedDelta.length ? ` — unexpected ${policedDelta.join(", ")}` : ""}`,
  );

  const helpVerbs = await listVipuneHelpVerbs();
  if (helpVerbs === null) {
    console.log("… vipune absent — skipping the `vipune --help` verb-set assertion (offline fallback in use)");
  } else {
    const unpoliced = [...helpVerbs].filter((v) => !VIPUNE_SUBCOMMANDS.has(v));
    const phantom = [...VIPUNE_SUBCOMMANDS].filter((v) => !helpVerbs.has(v));
    assert(
      unpoliced.length === 0,
      `the policed set covers every verb the installed binary lists${unpoliced.length ? ` — missing ${unpoliced.join(", ")}` : ""}`,
    );
    assert(
      phantom.length === 0,
      `...and lists nothing the binary does not${phantom.length ? ` — unknown ${phantom.join(", ")}` : ""}`,
    );
  }

  const refused = new Set<string>(REFUSED_VIPUNE_VERBS);
  const expectedRefused = new Set(
    [...expectedPoliced].filter((v) => v !== "update" && !EXEMPT_VIPUNE_VERBS.includes(v)),
  );
  const refusedDelta = [...expectedRefused].filter((v) => !refused.has(v));
  const refusedExtra = [...refused].filter((v) => !expectedRefused.has(v));
  assert(
    refusedDelta.length === 0,
    `memory-write-guard refuses every ungranted verb the prose polices${refusedDelta.length ? ` — missing ${refusedDelta.join(", ")}` : ""}`,
  );
  assert(
    refusedExtra.length === 0,
    `...and nothing outside that set${refusedExtra.length ? ` — unexpected ${refusedExtra.join(", ")}` : ""}`,
  );
  assert(
    !refused.has("update"),
    "`update` is refused for its mutating flags, not as a bare verb (asserted behaviourally in test-memory-write-guard.ts)",
  );
  assert(
    allowedVerbs.size > 0 && !refused.has("add"),
    "`add` is granted and never refused — the driver writes memory through it",
  );
  assert(
    refusesMemoryWrite("vipune update 1 --status active") !== undefined,
    "canary: a future agents.json grant of `vipune update` would still leave the mutating-flag refusal standing",
  );

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
      // documentation, not a violation of it — but the prohibition has to be
      // IN THE SAME CLAUSE as the verb. The old test matched its keyword list
      // against the WHOLE line, so a line teaching `vipune export rows.jsonl`
      // that merely said "the operator" three clauses away passed (measured).
      // A clause is the run of text between two breaks — `;` `:` `—` `.`
      // `(`, brackets, a backtick, or a line break — so the negative wording
      // has to sit next to the verb it governs.
      if (prohibitsVerb(text, (m.index ?? 0) + (m[0]?.length ?? 0))) return;
      taught.push(`${path.relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert(
    taught.length === 0,
    `no prose teaches a vipune verb the roles cannot run${taught.length ? ` — ${taught.join(", ")}` : ""}`,
  );

  // Not vacuous: the whole-line adjacency the previous exemption relied on must
  // now FAIL. A teaching line that only mentions the operator elsewhere is
  // exactly the shape that used to slip through.
  const teachingLine =
    "Run `vipune export rows.jsonl` before the handoff, the operator reviews the file afterwards.";
  assert(
    !prohibitsVerb(teachingLine, teachingLine.indexOf("export") + 6),
    "canary: a line that TEACHES `vipune export` while merely mentioning the operator elsewhere IS flagged",
  );
  assert(
    prohibitsVerb("Never run `vipune update` - an operator action.", 26),
    "...and the same verb named inside a prohibition clause is not",
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
