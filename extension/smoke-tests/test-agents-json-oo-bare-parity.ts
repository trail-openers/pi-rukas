#!/usr/bin/env bun
/**
 * oo / bare parity for the developer and ops bash permission maps (#1084).
 *
 * Once the prompts stop typing the `oo` prefix (#1083), agents run bare
 * commands. In strict and headless mode the oo rewrite hook is inert, so a
 * bare command resolves against agents.json alone and falls to `"*": "ask"`
 * (a hard deny in headless mode) unless a bare row grants it.
 *
 * Two directions are checked:
 *   Forward (oo → bare). The scope is derived from agents.json itself: every
 *   developer/ops allow key starting with `oo ` is checked unless its family is
 *   in EXEMPT below or it is a catch-all (`oo <cmd> *`, `oo git -C *`). Each
 *   explicit verb row must have an IDENTICAL bare twin key with allow, and that
 *   bare row must resolve to the same verdict under matchBashSubcommand.
 *   Catch-all oo rows get no bare twin, for the reason in CATCH_ALL_REASON.
 *   No bare catch-all (`git *`, `npm *`, …, `git -C *`) may be allowed.
 *   Reverse (bare → oo). For every in-scope bare allow row (family in FAMILIES):
 *     - if an `oo <same key>` twin exists, its verdict must be identical, so no
 *       bare grant is broader than its oo form;
 *     - if no twin exists, the row must be in PRE_EXISTING: bare rows that
 *       predate the oo convention. Any other twinless in-scope bare row (a row
 *       #1084 added, or a new one) fails, so removing an oo twin of an added row
 *       is caught.
 *
 * EXEMPT is explicit and each entry carries its reason. Anything not exempt or
 * a catch-all is checked; nothing is silently skipped.
 *
 * Also asserts that ops' bare test-runner deny rows still deny, that bare
 * gh/glab merge stays `ask` (#912), and that neither role's bash map is
 * missing or vacuous.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { matchBashSubcommand } from "../src/bash-command-parser.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
	if (cond) console.log(`✓ ${msg}`);
	else {
		console.error(`✗ ${msg}`);
		exit = 1;
	}
}

/** Command families #1084 gives exact bare twins. */
const FAMILIES = ["git", "cargo", "bun", "npm", "pnpm", "yarn", "pytest", "go"];

const SCOPE_REASON =
	"outside #1084's scope (issue limits parity to git/cargo/bun/npm/pnpm/yarn/pytest/go)";
const IMAGEMAGICK = `ImageMagick CLI; no bare row, and ${SCOPE_REASON}`;

/** oo families excluded from parity, keyed by the first word of the oo pattern. */
const EXEMPT: Record<string, string> = {
	gh: "forge CLI; permanently out of parity so the #912 merge gate's surface is unchanged (bare gh stays ask)",
	glab: "forge CLI; permanently out of parity, same #912 reason (bare glab stays ask)",
	recall: "oo's own subcommand; no bare counterpart",
	forget: "oo's own subcommand; no bare counterpart",
	help: "oo's own subcommand; no bare counterpart",
	patterns: "oo's own subcommand; no bare counterpart",
	learn: "oo's own subcommand; no bare counterpart",
	init: "oo's own subcommand; no bare counterpart",
	version: "oo's own subcommand; no bare counterpart",
	uv: `no bare row; ${SCOPE_REASON}`,
	npx: `no bare row; ${SCOPE_REASON}`,
	ruff: `no bare row; ${SCOPE_REASON}`,
	jest: `no bare row; ${SCOPE_REASON}`,
	bats: `no bare row; ${SCOPE_REASON}`,
	shellcheck: `no bare row; ${SCOPE_REASON}`,
	animate: IMAGEMAGICK,
	compare: IMAGEMAGICK,
	composite: IMAGEMAGICK,
	conjure: IMAGEMAGICK,
	convert: IMAGEMAGICK,
	display: IMAGEMAGICK,
	identify: IMAGEMAGICK,
	import: IMAGEMAGICK,
	stream: IMAGEMAGICK,
};

/**
 * In-scope bare allow rows that already existed on origin/main before #1084,
 * generated from `git show origin/main:agents.json`. They predate the oo
 * convention and carry no `oo` twin by design. Every other in-scope bare allow
 * row must have an `oo` twin with the same verdict.
 */
const PRE_EXISTING: Record<"developer" | "ops", readonly string[]> = {
	developer: [
		"cargo test --test *",
		"go test -run *",
		"bun test --test *",
		"pytest *.py::*",
		"git blame*",
		"git branch*",
		"git cat-file*",
		"git check-ignore*",
		"git config --get*",
		"git describe*",
		"git diff*",
		"git for-each-ref*",
		"git log*",
		"git ls-files*",
		"git ls-remote*",
		"git ls-tree*",
		"git merge-base*",
		"git name-rev*",
		"git reflog*",
		"git remote*",
		"git rev-list*",
		"git rev-parse*",
		"git shortlog*",
		"git show*",
		"git stash list*",
		"git status*",
		"git symbolic-ref*",
		"git tag --list*",
		"git tag -l*",
		"git worktree list*",
	],
	ops: [
		"git status*",
		"git branch*",
		"git log --oneline*",
		"bun run build*",
		"npm run build*",
		"npm install*",
		"npm ci*",
		"pnpm run build*",
		"pnpm install*",
		"npm install -g corepack",
		"cargo build*",
		"cargo fmt*",
		"cargo --version",
		"git blame*",
		"git cat-file*",
		"git check-ignore*",
		"git config --get*",
		"git describe*",
		"git diff*",
		"git for-each-ref*",
		"git log*",
		"git ls-files*",
		"git ls-remote*",
		"git ls-tree*",
		"git merge-base*",
		"git name-rev*",
		"git reflog*",
		"git remote*",
		"git rev-list*",
		"git rev-parse*",
		"git shortlog*",
		"git show*",
		"git stash list*",
		"git symbolic-ref*",
		"git tag --list*",
		"git tag -l*",
		"git worktree list*",
	],
};

/**
 * The one rule for catch-all oo rows (`oo <cmd> *`, `oo git -C *`): they get no
 * bare twin. Only explicit verb rows get bare twins, because a bare catch-all
 * would allow every subcommand (force-push, reset --hard, publish, lifecycle
 * scripts, `git -c`/`-C`) in strict and headless mode.
 */
const CATCH_ALL_REASON =
	"a bare catch-all would allow every subcommand (force-push, reset --hard, publish, lifecycle scripts, `git -c`/`-C`) in strict/headless mode; only explicit verb rows get bare twins";

/** A catch-all oo row: `oo <cmd> *` with nothing after the command, or `oo git -C *`. */
function isCatchAll(key: string): boolean {
	return /^oo [^\s*]+ \*$/.test(key) || key === "oo git -C *";
}

/** Bare catch-alls that must never be allowed for developer or ops. */
const BARE_CATCH_ALLS: readonly string[] = [
	...FAMILIES.map((f) => `${f} *`),
	"git -C *",
];

const ROLES = ["developer", "ops"] as const;

const agentsPath = path.resolve(import.meta.dirname, "..", "..", "agents.json");
const agents = JSON.parse(readFileSync(agentsPath, "utf8")) as {
	agent: Record<string, { permission: { bash: Record<string, string> } }>;
};

/** A concrete command that the bare pattern should match (wildcard → "x"). */
function sampleFor(pattern: string): string {
	if (pattern.endsWith(" *")) return `${pattern.slice(0, -2)} x`;
	if (pattern.endsWith("*")) return pattern.slice(0, -1);
	return pattern;
}

/** First word of a pattern, with a trailing `*` or space-delimited arg stripped. */
function familyOf(pattern: string): string {
	return pattern.split(/[ *]/)[0] ?? "";
}

for (const role of ROLES) {
	const bash = agents.agent[role]?.permission?.bash;
	assert(bash !== undefined, `${role}: bash permission map present`);
	if (!bash) continue;

	// Forward: every non-exempt oo allow row resolves to the same verdict bare.
	let checked = 0;
	let inScope = 0;
	for (const [key, verdict] of Object.entries(bash)) {
		if (!key.startsWith("oo ") || verdict !== "allow") continue;
		const bare = key.slice(3);
		const family = familyOf(bare);
		if (Object.hasOwn(EXEMPT, family)) {
			console.log(`- ${role}: "${key}" exempt: ${EXEMPT[family]}`);
			continue;
		}
		if (isCatchAll(key)) {
			console.log(
				`- ${role}: "${key}" catch-all, no bare twin: ${CATCH_ALL_REASON}`,
			);
			continue;
		}
		checked++;
		if (FAMILIES.includes(family)) inScope++;

		assert(
			bash[bare] === verdict,
			`${role}: "${key}" needs an identical bare twin "${bare}" with verdict ${verdict} (found ${bash[bare] ?? "none"})`,
		);
		const sample = sampleFor(bare);
		const got = matchBashSubcommand(sample, bash);
		assert(
			got === verdict,
			`${role}: "${key}" is ${verdict}; bare "${bare}" resolves ${got} on "${sample}"`,
		);
	}
	assert(
		checked > 0,
		`${role}: at least one non-exempt oo row checked (${checked})`,
	);
	assert(
		inScope > 0,
		`${role}: at least one in-scope oo row checked (${inScope})`,
	);

	// Reverse: every in-scope bare allow row is either twinned or pre-existing.
	const preExisting = new Set(PRE_EXISTING[role]);
	let bareInScope = 0;
	for (const [key, verdict] of Object.entries(bash)) {
		if (key.startsWith("oo ") || verdict !== "allow") continue;
		if (!FAMILIES.includes(familyOf(key))) continue;
		bareInScope++;

		const twinKey = `oo ${key}`;
		const twin = bash[twinKey];
		if (twin !== undefined) {
			assert(
				twin === verdict,
				`${role}: bare "${key}" is allow; oo twin "${twinKey}" must match (found ${twin})`,
			);
		} else {
			assert(
				preExisting.has(key),
				`${role}: bare "${key}" is allow with no "${twinKey}" twin and is not PRE_EXISTING (added without an oo twin)`,
			);
		}
	}
	for (const key of preExisting) {
		assert(
			bash[key] === "allow",
			`${role}: PRE_EXISTING "${key}" is still a bare allow row (stale entry otherwise)`,
		);
	}
	assert(
		bareInScope > 0,
		`${role}: at least one in-scope bare allow row checked (${bareInScope})`,
	);

	for (const key of BARE_CATCH_ALLS) {
		assert(
			bash[key] !== "allow",
			`${role}: no bare catch-all "${key}" is allowed (${CATCH_ALL_REASON})`,
		);
	}
}

const ops = agents.agent.ops?.permission?.bash ?? {};
for (const cmd of [
	"cargo test",
	"cargo clippy",
	"bun test",
	"npm test",
	"pytest",
	"pnpm test",
	"yarn test",
	"go test",
]) {
	assert(
		matchBashSubcommand(cmd, ops) === "deny",
		`ops: bare "${cmd}" stays deny`,
	);
}

// Recovery commands the prompts and refusal text tell ops to run must resolve
// allow through the production matcher, not just the oo/bare twin shape.
for (const cmd of [
	"git apply --3way --binary --index tmp/issue-1/x.patch",
	"git restore --staged src/a.ts",
	"git revert HEAD",
	"git stash push -m x",
	"git symbolic-ref --short HEAD",
	"git checkout main",
	"git pull --ff-only",
	"git push -u origin feature/x",
	"git worktree remove ../x",
	"git rebase --abort",
	"git diff --cached",
	"git branch --show-current",
]) {
	assert(
		matchBashSubcommand(cmd, ops) === "allow",
		`ops: recovery "${cmd}" resolves allow`,
	);
}

for (const role of ROLES) {
	const bash = agents.agent[role]?.permission?.bash ?? {};
	assert(
		matchBashSubcommand("gh pr merge 1", bash) === "ask",
		`${role}: bare gh pr merge stays ask`,
	);
	assert(
		matchBashSubcommand("glab mr merge 1", bash) === "ask",
		`${role}: bare glab mr merge stays ask`,
	);
}

assert(
	matchBashSubcommand("git -C /repo update-ref -d refs/heads/main", ops) ===
		"ask",
	"ops: bare git -C <p> update-ref stays ask",
);
assert(
	matchBashSubcommand("git -C /repo config --global x y", ops) === "ask",
	"ops: bare git -C <p> config stays ask",
);

console.log(exit === 0 ? "\nAll oo/bare parity checks passed." : "\nFAILED");
process.exit(exit);
