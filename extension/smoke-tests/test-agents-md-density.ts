#!/usr/bin/env bun
/**
 * density — size discipline for the scaffolded AGENTS.md.
 *
 * The SINGLE density constraint for the 7-section scaffold render, stated in
 * this test only (the 32 KiB hard safety cap in test-agents-md-size.ts is a
 * separate, unmodified gate):
 *
 *   1. A realistic full-featured rendered AGENTS.md — all 4 managed sections
 *      (quality-gates, commands, environment, decision-ledger) plus all 7
 *      scaffold sections (minimalist-engineering, git-workflow,
 *      documentation-policy, issue-driven-development, code-review-doctrine,
 *      context7-protocol, testing-standards) plus a populated decision ledger
 *      — totals <= 550 lines.
 *
 *   2. Each of the two NEW scaffold bodies is individually budgeted:
 *      Context7 Protocol <= 20 lines and Testing Standards <= 20 lines.
 *      The per-section density check is the real quality gate; the
 *      document-total number is secondary.
 *
 * The render is pure and FS-free (like test-agents-md-size.ts's inline
 * fixture): renderAgent for the 4 managed sections, computeScaffold for the
 * 7 scaffold bodies, runScaffoldPostPass to splice them in document order.
 */

import type { DetectedFacts } from "../src/agents-md/detect.ts";
import type { LedgerRow } from "../src/agents-md/ledger.ts";
import { renderAgent } from "../src/agents-md/renderer.ts";
import {
	type ScaffoldOpts,
	computeScaffold,
	runScaffoldPostPass,
} from "../src/agents-md/scaffold.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
	if (cond) console.log(`✓ ${msg}`);
	else {
		console.error(`✗ ${msg}`);
		exit = 1;
	}
}

// ---------------------------------------------------------------- the fixture

// A maximal-but-realistic DetectedFacts: every managed section emitted, a
// realistic (not maximal) command list — the shape a real createAgent would
// produce for a healthy repo.
const facts: DetectedFacts = {
	manifest: "package.json",
	runner: "bun",
	packageManager: "bun",
	language: "typescript",
	ciWorkflows: ["ci.yml", "release.yml"],
	notes: [],
	commands: [
		"test",
		"lint",
		"check",
		"typecheck",
		"build",
		"test:unit",
		"test:integration",
		"dev",
		"deploy:staging",
		"deploy:prod",
	].map((name) => ({
		name,
		command: `bun run ${name}`,
		kind: "test" as const,
		runner: "bun",
	})),
};

// A populated decision ledger: auto rows plus several operator rows.
const ledger: LedgerRow[] = [
	{
		key: "ci-provider",
		value: "github-actions",
		provenance: "auto",
		date: "2026-01-01",
	},
	{
		key: "deploy-target",
		value: "prod-eu",
		provenance: "asked",
		date: "2026-01-02",
	},
	{
		key: "merge-strategy",
		value: "squash",
		provenance: "asked",
		date: "2026-01-03",
	},
	{
		key: "ci-cache",
		value: "bun install",
		provenance: "auto",
		date: "2026-01-04",
	},
	{
		key: "release-channel",
		value: "stable",
		provenance: "asked",
		date: "2026-01-05",
	},
].map((r) => ({ ...r }));

// The managed document: preamble + 4 managed sections, as renderAgent emits
// them. `managedIds` is the managed-id set the scaffold post-pass skips.
const managedIds = [
	"quality-gates",
	"commands",
	"environment",
	"decision-ledger",
];
const managed = renderAgent({
	facts,
	ledger,
	preamble: "# AGENTS.md\n\n\n",
	version: 1,
});

// The 7 scaffold sections + (when answers are given) the operator-choices
// section, in document order after the managed sections.
const scaffoldOpts: ScaffoldOpts = {
	scaffold: true,
	answers: {
		coverageThreshold: "80%+",
		reviewBlockingSeverity: "MEDIUM",
		mergeAuthority: "squash-merge when gates pass",
	},
};
const scaffold = computeScaffold(new Set(managedIds), scaffoldOpts);
const full = runScaffoldPostPass(managed, scaffold, false);

const lines = full.bytes.split("\n").length;
console.log(`  full-featured render = ${lines} lines`);

// ------------------------------------------------- the 550-line quality ceiling

assert(
	lines <= 550,
	`full-featured AGENTS.md (4 managed + 7 scaffold sections) is <= 550 lines (${lines} <= 550)`,
);

// ------------------------------------------------- per-section body budgets

// Body = the section text between its "# Heading" line and the next heading
// (or end of file), blank-trimmed — so the budget measures the section's
// content, not inter-section blank lines.
function bodyLines(doc: string, heading: string): number | undefined {
	const lines = doc.split("\n");
	const start = lines.findIndex((l) => l === `# ${heading}`);
	if (start === -1) return undefined;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^#{1,6}\s/.test(lines[i])) {
			end = i;
			break;
		}
	}
	const body = lines
		.slice(start + 1, end)
		.join("\n")
		.trim();
	return body === "" ? 0 : body.split("\n").length;
}

const c7 = bodyLines(full.bytes, "Context7 Protocol");
const ts = bodyLines(full.bytes, "Testing Standards");

assert(
	c7 !== undefined,
	"Context7 Protocol section is present in the rendered document",
);
assert(
	ts !== undefined,
	"Testing Standards section is present in the rendered document",
);
if (c7 !== undefined) {
	console.log(`  Context7 Protocol body = ${c7} lines`);
	assert(
		c7 <= 20,
		`Context7 Protocol body is within its ~20-line budget (${c7} <= 20)`,
	);
}
if (ts !== undefined) {
	console.log(`  Testing Standards body = ${ts} lines`);
	assert(
		ts <= 20,
		`Testing Standards body is within its ~20-line budget (${ts} <= 20)`,
	);
}

console.log(exit === 0 ? "\nAll density checks passed." : "\nFAILED");
process.exit(exit);
