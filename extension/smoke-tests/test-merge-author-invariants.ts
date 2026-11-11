#!/usr/bin/env bun
/**
 * #2181 — the merge-author gate's INVARIANTS, read off the source of the modules
 * that implement it.
 *
 * Split from `test-merge-author-allowlist.ts` for the §12 size cap; that file keeps
 * the reader's behaviour table. What lives here is the part that cannot be expressed
 * as a behaviour arm, because each claim is a property of a whole module rather than
 * of one call:
 *
 *   - no override reaches the gate (R2's core claim): the switches that widen every
 *     other merge gate — `PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE`,
 *     `PI_ENSEMBLE_MERGE_AUTHORITY`, `--merge` — must not be read on this path at
 *     all, or a PM that passes `--merge` lands strangers;
 *   - the file is read at a COMMIT, never a tree (the #406 rule): every spec is
 *     `<sha>:<path>`, so a PR that adds a permissive gate file cannot widen its own
 *     allowlist;
 *   - the three merge paths reach the SAME function, so the rule cannot be
 *     implemented twice and drift.
 *
 * Comments are stripped before every name scan on purpose: both gate modules
 * document, in their own headers, the switches they deliberately do NOT consult, and
 * matching prose would fail on the documentation of the guarantee rather than on its
 * absence.
 */

import {
	MERGE_AUTHORS_FILE,
	isMergeAuthorTreeRead,
	mergeAuthorGate,
	mergeAuthorTreeLine,
	readMergeAuthorAllowlist,
} from "../src/merge-author-allowlist.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
	if (cond) {
		console.log(`\u2713 ${msg}`);
	} else {
		failures++;
		console.log(`\u2717 ${msg}`);
	}
}

/** The allowlist body a stub reader answers with when the case does not name one. */
const DEFAULT_BODY = "# the maintainers\nalice\nBob\n";
const SHA = "0123456789abcdef0123456789abcdef01234567";

/**
 * Drop comments, so a scan for a name asks whether the CODE reads it.
 */
function stripComments(text: string): string {
	return text
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.split("\n")
		.filter((l) => !l.trimStart().startsWith("//"))
		.join("\n");
}

// -------------------------------------- no override reaches the gate (R2's core claim)
{
	// The three switches that widen every other merge gate. If any of them is read on
	// this path, a PM that passes `--merge` or an operator who exported the escape
	// hatch lands strangers — which is the whole failure this issue exists to stop.
	const src = stripComments(
		await Bun.file(
			new URL("../src/merge-guard-author.ts", import.meta.url),
		).text(),
	);
	const reader = stripComments(
		await Bun.file(
			new URL("../src/merge-author-allowlist.ts", import.meta.url),
		).text(),
	);
	for (const knob of [
		"PI_ENSEMBLE_ALLOW_UNREVIEWED_MERGE",
		"PI_ENSEMBLE_MERGE_AUTHORITY",
		"ALLOW_UNREVIEWED_MERGE",
		"process.env",
	]) {
		assert(
			!src.includes(knob) && !reader.includes(knob),
			`neither gate module reads ${knob}: the author rule is not a review rule and not a permission rule`,
		);
	}
}

// ------------------------------------------------ the file is read at a commit, never a tree
{
	// The 406 rule: the copy a cycle is judged by is the one at its base commit, so a
	// PR that adds a permissive `.pi/merge-authors` cannot widen its own allowlist.
	const specs: string[] = [];
	const exec = async (
		_cmd: string,
		opts?: { argv?: string[] },
	): Promise<{ stdout: string }> => {
		const argv = opts?.argv ?? [];
		if (isMergeAuthorTreeRead(argv)) {
			// The tree read names the revision as its own argument, not a `<sha>:<path>`
			// spec, so it is recorded as that argument — which still has to be the commit.
			specs.push(argv[argv.indexOf("ls-tree") + 1] ?? "");
			return { stdout: mergeAuthorTreeLine("100644", MERGE_AUTHORS_FILE) };
		}
		specs.push(argv[argv.length - 1] ?? "");
		if (argv.includes("cat-file")) return { stdout: "blob\n" };
		return { stdout: DEFAULT_BODY };
	};
	await readMergeAuthorAllowlist(exec, "/r", SHA);
	assert(
		specs.length >= 3 &&
			specs.every((s) => s.startsWith(`${SHA}:`) || s === SHA),
		`every read names the base commit — as a <sha>:${MERGE_AUTHORS_FILE} spec or as ls-tree's own revision, never a bare path (${specs.join(" | ")})`,
	);
	assert(
		!specs.some((s) => s.startsWith("./") || s.startsWith("/")),
		"…and no spec is a working-tree path",
	);
}

// --------------------------------------------------- the driver/lean wiring reads the file
{
	// Structural: the three paths all reach the SAME function, so the rule cannot be
	// implemented twice and drift. The per-path behaviour tests in the sibling file are
	// what prove the gate decides; these prove the wiring calls it.
	const driver = await Bun.file(
		new URL("../src/work-driver-merged.ts", import.meta.url),
	).text();
	const land = await Bun.file(
		new URL("../src/lean/land.ts", import.meta.url),
	).text();
	const landDeps = await Bun.file(
		new URL("../src/lean/land-deps.ts", import.meta.url),
	).text();
	const guard = await Bun.file(
		new URL("../src/merge-guard.ts", import.meta.url),
	).text();
	assert(
		driver.includes("heldForMergeAuthor") && driver.includes("authorGate"),
		"the driver's merged step consults the shared gate",
	);
	assert(
		land.includes("heldForMergeAuthor") &&
			landDeps.includes("heldForMergeAuthor"),
		"lean's land step consults it through its injected deps, so a case can name an author without a forge",
	);
	assert(
		guard.includes("guardMergeAuthorRefusal"),
		"the hand-run guard consults the same gate through the hook",
	);
	for (const [name, text] of [
		["driver", driver],
		["land", land],
	] as const) {
		assert(
			!text.includes("readMergeAuthorAllowlist("),
			`${name} does not read the allowlist itself — it has no local copy of the rule to drift`,
		);
	}
}

// ------------------------------------------------ the gate actually decides (mutation anchor)
// This file's other arms are structural. This one exercises the decision the
// mutant weakens: a stranger is refused. If this block ever stays green while the
// allowlist check accepts any author, the mutant is not caught here.
{
	const allowlist = {
		ok: true,
		logins: ["alice"],
		set: new Set(["alice"]),
	} as const;
	const refused = mergeAuthorGate({
		allowlist,
		author: { ok: true, login: "stranger" },
	});
	assert(
		refused.ok === false,
		"the gate refuses a login that is not on the allowlist",
	);
}

if (failures > 0) {
	console.log(`\nFAILED ${failures} assertion(s)`);
	process.exit(1);
}
console.log("\nall assertions passed");
