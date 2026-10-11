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
 * other verb earlier in the clause, or separated by a conjunction ("not X so
 * run oo ..."), does not exempt it.
 *
 * Ratchet: known instances are listed in EXCEPTIONS as file + anchor substring
 * (never line number), so a reword of the surrounding sentence keeps the anchor
 * while the instruction is unchanged. Every entry must match a live violation,
 * so a stale entry fails the gate and the list can only shrink. A new instance
 * with no entry fails the gate.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { OO_PREFIXES } from "../src/oo-rewrite-guard.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SCAN_DIRS = ["agents-base", "modules", "manifests", "pi-prompts"];

interface Exception {
	file: string;
	/** Substring that must appear in the violating (normalised) line. */
	anchor: string;
	/** Ticket whose completion removes this instance (e.g. "#1029"). */
	ticket: string;
}

// Empty: no prompt instructs a hand-typed oo prefix (#1083). The list is kept
// so a future exception is a reviewed, ticketed addition, and the stale-entry
// check below still applies to any entry added later.
const EXCEPTIONS: Exception[] = [];

for (const e of EXCEPTIONS) {
	assert(
		/^#\d+$/.test(e.ticket),
		`exception ${e.file} "${e.anchor.slice(0, 40)}" is tagged with a ticket`,
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

const NEGATION = /\b(?:not|never|no|don['’]t|do not|must not|avoid)\b/i;
// A negation only exempts the `oo` mention when it sits in the same clause and
// within the last NEGATION_WINDOW words before it ("Do NOT run oo git push"),
// so "Don't skip the check and run oo cargo test" is still flagged.
const CLAUSE_BREAK = /[.,;:!?()]|\b(?:so|and|but|then|or|while|because)\b/i;
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
function violationsIn(text: string): { lineNo: number; line: string }[] {
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
		["not relevant so run oo cargo test", 1],
	];
	const bad = fixtures
		.filter(([t, n]) => violationsIn(t).length !== n)
		.map(([t]) => t);
	assert(
		bad.length === 0,
		`oo hygiene canary: fixtures classified correctly${bad.length ? ` (failed: ${bad.join(" | ")})` : ""}`,
	);
	assert(OO_PREFIXES.length > 0, "OO_PREFIXES is exported and non-empty");
}

for (const dir of SCAN_DIRS) {
	assert(existsSync(path.join(ROOT, dir)), `scan dir ${dir} exists`);
}

const scanned = SCAN_DIRS.filter((d) => existsSync(path.join(ROOT, d)))
	.flatMap((d) => walk(path.join(ROOT, d)))
	.map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
assert(scanned.length > 0, `scan covers ${scanned.length} source files`);

const newInstances: string[] = [];
let excepted = 0;
const matchedAnchors = new Set<Exception>();
for (const rel of scanned) {
	const hits = violationsIn(readFileSync(path.join(ROOT, rel), "utf8"));
	for (const h of hits) {
		const ex = EXCEPTIONS.find(
			(e) => e.file === rel && h.line.includes(e.anchor),
		);
		if (ex) {
			excepted++;
			matchedAnchors.add(ex);
		} else newInstances.push(`  ${rel}:${h.lineNo}: ${h.line.slice(0, 120)}`);
	}
}

for (const e of EXCEPTIONS) {
	assert(
		matchedAnchors.has(e),
		`exception still live: ${e.file} anchor "${e.anchor.slice(0, 60)}" matches a violation (remove the entry if not)`,
	);
}

assert(
	newInstances.length === 0,
	newInstances.length === 0
		? `no new hand-typed oo instructions (${excepted} known instance(s) listed as exceptions)`
		: `${newInstances.length} new hand-typed oo instruction(s); remove them or add an EXCEPTIONS entry with a ticket:\n${newInstances.join("\n")}`,
);

console.log(`\nexit ${exit}`);
process.exit(exit);
