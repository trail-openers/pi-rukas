#!/usr/bin/env bun
/**
 * oo prompt-hygiene ratchet (#1081).
 *
 * Fails when a prompt or doctrine source under agents-base/, modules/,
 * manifests/ or pi-prompts/ newly instructs an agent to type an `oo <command>`
 * by hand. The vocabulary is OO_PREFIXES, read from the same export the
 * rewrite hook uses, so the gate cannot drift from the hook's list.
 *
 * Rule: a line is an instruction when it contains `oo ` followed by a complete
 * OO_PREFIXES entry at a word boundary (e.g. `oo cargo test`, `oo bun run build`).
 * oo's own subcommands (recall, forget, help, patterns, learn) are not
 * prefixes and are never flagged. A mention is exempt only when a negation
 * (not, never, no, don't, do not, must not, avoid) sits within the few words
 * immediately before it ("Do NOT run oo git push"); a negation governing some
 * other verb earlier in the clause does not exempt it.
 *
 * Ratchet: known instances are listed in EXCEPTIONS, keyed by file and
 * normalised line text (never line number). The list may only shrink. An
 * exception whose line has been removed is a harmless stale entry; a new
 * instance with no entry fails the gate.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { OO_PREFIXES } from "../src/oo-rewrite-guard.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["agents-base", "modules", "manifests", "pi-prompts"];

interface Exception {
  file: string;
  line: string;
  ticket: string;
}

const EXCEPTIONS: Exception[] = [
  {
    file: "agents-base/developer.md",
    line: "- **Keep check output out of the report** — verbose runners (`cargo test`, `bun test`, `npm test`, `pytest`, …) emit 50+ lines of per-test noise that bloats the dispatch report PM reads. Prefer codemode (when registered in your toolset) to run the checks and return only failures, or bound the output with the native limiting flags. For single short commands, a plain bash call is simpler. A bare command starting with one of these runners may still be silently rewritten to its `oo`-prefixed form for developer/ops subagents in trust/sandbox mode by the pi-rukas extension (`oo-rewrite-guard`) — a rewritten command is equivalent, so neither form is required of you. In strict or headless mode there is no rewrite: until the allowlist gains bare runner rows (#1029), the allowlisted form of a verbose runner is the `oo`-prefixed one (for example `oo cargo test`, `oo bun test`).",
    ticket: "#1029",
  },
];

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const NEGATION = /\b(?:not|never|no|don['’]t|do not|must not|avoid)\b/i;
// A negation only exempts the `oo` mention when it sits in the same clause and
// within the last NEGATION_WINDOW words before it ("Do NOT run oo git push"),
// so "Don't skip the check and run oo cargo test" is still flagged.
const CLAUSE_BREAK = /[.,;:!?()]/;
const NEGATION_WINDOW = 4;

function isNegated(before: string): boolean {
  const clause = before.split(CLAUSE_BREAK).pop() ?? "";
  const tail = clause.trim().split(/\s+/).slice(-NEGATION_WINDOW).join(" ");
  return NEGATION.test(tail);
}

function prefixRe(): RegExp {
  const alts = [...OO_PREFIXES]
    .sort((a, b) => b.length - a.length)
    .map((p) => p.split(" ").join("\\s+"))
    .join("|");
  return new RegExp(`(?<![\\w-])oo\\s+(?:${alts})(?![\\w-])`, "g");
}

const normalise = (s: string) => s.replace(/\s+/g, " ").trim();

/** Violating lines of one file, as normalised text with 1-based line numbers. */
export function violationsIn(text: string): { lineNo: number; line: string }[] {
  const re = prefixRe();
  const out: { lineNo: number; line: string }[] = [];
  text.split("\n").forEach((raw, i) => {
    for (const m of raw.matchAll(re)) {
      if (!isNegated(raw.slice(0, m.index))) {
        out.push({ lineNo: i + 1, line: normalise(raw) });
        return;
      }
    }
  });
  return out;
}

function isExcepted(file: string, line: string): boolean {
  return EXCEPTIONS.some((e) => e.file === file && e.line === line);
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

// Canary: the gate must be able to fail, and must not flag prose or subcommands.
{
  const fixtures: [string, number][] = [
    ["Run the suite with `oo cargo test` to keep the report short.", 1],
    ["Run `oo bun run build` before committing.", 1],
    ["Do NOT run oo cargo test here.", 0],
    ["There is no rewrite. Run `oo cargo test` instead.", 1],
    ["Use `oo recall` to fetch memory, `oo help` for usage.", 0],
    ["Run `cargo test` directly.", 0],
    ["foo cargo test oo", 0],
    ["Run oo cargo test2 later", 0],
    ["Don't skip the check and run `oo cargo test`", 1],
    ["Do NOT run oo git push", 0],
    ["Avoid bare runners and run `oo bun test`", 1],
    ["Do not use this, use `oo cargo test`", 1],
    ["Don’t skip the check and run `oo cargo test`", 1],
  ];
  const bad = fixtures.filter(([t, n]) => violationsIn(t).length !== n).map(([t]) => t);
  assert(
    bad.length === 0,
    `oo hygiene canary: fixtures classified correctly${bad.length ? ` (failed: ${bad.join(" | ")})` : ""}`,
  );
  assert(OO_PREFIXES.length > 0, "OO_PREFIXES is exported and non-empty");
}

const scanned = SCAN_DIRS.flatMap((d) => walk(path.join(ROOT, d))).map((f) =>
  path.relative(ROOT, f).split(path.sep).join("/"),
);
assert(scanned.length > 0, `scan covers ${scanned.length} source files`);

const newInstances: string[] = [];
let excepted = 0;
for (const rel of scanned) {
  const hits = violationsIn(readFileSync(path.join(ROOT, rel), "utf8"));
  for (const h of hits) {
    if (isExcepted(rel, h.line)) excepted++;
    else newInstances.push(`  ${rel}:${h.lineNo}: ${h.line.slice(0, 120)}`);
  }
}

assert(
  newInstances.length === 0,
  newInstances.length === 0
    ? `no new hand-typed oo instructions (${excepted} known instance(s) listed as exceptions)`
    : `${newInstances.length} new hand-typed oo instruction(s); remove them or add an EXCEPTIONS entry with a ticket:\n${newInstances.join("\n")}`,
);

console.log(`\nexit ${exit}`);
process.exit(exit);
