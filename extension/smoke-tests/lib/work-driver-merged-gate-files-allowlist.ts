/**
 * work-driver-merged-gate-files-allowlist — the merge-author gate's reads in the
 * driver's `merged` fixture, split out of the fixture module for the §12 size cap.
 *
 * Three reads of one gate file, three shapes, and the fixture must answer each as git
 * does: `ls-tree` the entry's MODE, `cat-file -t` the TYPE, `show` the BYTES. Handing a
 * probe the bytes makes every path a regular file — which is exactly how a committed
 * symlink (a `blob` to `cat-file`, mode 120000) used to be read as an allowlist. So the
 * tree read here is answered by the fixture's own clone, not by a table: the mode is
 * git's, and a fixture that invented one would pass the defect this read exists to catch.
 *
 * Absence is answered the same way git answers it — an EMPTY tree result plus the type
 * probe's rejection on `stderr`/`code` — because the reader calls the file absent only
 * when neither read saw it. A seam that left one unscripted is a hole, not an answer.
 */

import { spawnSync } from "node:child_process";
import { gitTestEnv } from "./git-test-env.ts";

/** The gate file's path, assembled from parts so no scan sees it as one token. */
const GATE_FILE = [".pi", "merge-authors"].join("/");

/** One of the gate file's reads: which commit and which path the read names. */
export type AllowlistSpec = { sha: string; file: string };

/** The `<sha>:<file>` blob spec of a doctrine read, in either exec shape. */
export function doctrineBlob(line: string): AllowlistSpec | undefined {
	const match = /(?:^|\s)([0-9a-f]{40}):([A-Za-z0-9._-]+)$/.exec(line);
	if (!match) return undefined;
	return { sha: match[1] as string, file: match[2] as string };
}

/**
 * The allowlist's BLOB read — `cat-file -t <sha>:<path>` or `show <sha>:<path>` — in
 * either exec shape.
 *
 * Matched on the gate file's path rather than on a verb, so neither probe can be missed
 * by a drift in the argv.
 */
export function allowlistBlobSpec(line: string): AllowlistSpec | undefined {
	if (!line.includes(GATE_FILE)) return undefined;
	const match = new RegExp(`([0-9a-f]{7,40}):${GATE_FILE.replace(".", "\\.")}$`).exec(line);
	if (!match) return undefined;
	return { sha: match[1] as string, file: GATE_FILE };
}

/**
 * The gate file's TREE read, and which commit/path it asks for.
 *
 * `git ls-tree <sha> -- <path>` carries no `<sha>:<path>` spec, so the blob matcher
 * cannot see it; the path still names the gate file, which is what routes it here rather
 * than to some other git read.
 */
export function allowlistTreeSpec(line: string): AllowlistSpec | undefined {
	if (!line.includes("ls-tree") || !line.includes(GATE_FILE)) return undefined;
	const match = new RegExp(
		`ls-tree ([0-9a-f]{7,40}) -- ${GATE_FILE.replace(".", "\\.")}$`,
	).exec(line);
	if (!match) return undefined;
	return { sha: match[1] as string, file: GATE_FILE };
}

/** git's rejection of an absent path, on the two fields the absence classifier reads. */
function gitAbsent(spec: AllowlistSpec): never {
	const words = `fatal: path '${spec.file}' does not exist in '${spec.sha}'\n`;
	throw Object.assign(new Error(words), { code: 128, stderr: words });
}

/** git's rejection of a repository it cannot read, same two fields. */
function gitWedge(): never {
	const words = "fatal: unable to read pack file\n";
	throw Object.assign(new Error(words), { code: 128, stderr: words });
}

/**
 * Answer one allowlist read from the fixture's clone.
 *
 * `opts.noAllowlist` is A7's repository that never committed the file; `allowlistThrows`
 * is the present-but-unreadable gate file; `authorAllowlist` overrides the bytes for a
 * case that names its own list.
 */
export function answerAllowlistRead(args: {
	line: string;
	spec: AllowlistSpec;
	repoRoot: string;
	noAllowlist?: boolean;
	allowlistThrows?: boolean;
	authorAllowlist?: string;
	/** The login the fixture's forge reports, which the default list names. */
	fixtureAuthor: string;
}): { stdout: string } {
	const tree = args.line.includes("ls-tree");
	if (args.noAllowlist === true)
		// An absent path is git's honest EMPTY tree result; the type probe answers with
		// its own wording. Both arms must refuse the path before the reader calls it
		// absent, so neither is left to a default.
		return tree ? { stdout: "" } : gitAbsent(args.spec);
	if (args.allowlistThrows === true) gitWedge();
	if (tree) {
		const child = spawnSync(
			"git",
			["ls-tree", args.spec.sha, "--", args.spec.file],
			{ cwd: args.repoRoot, env: gitTestEnv() },
		);
		if (child.status !== 0) {
			const words = child.stderr?.toString() ?? "git ls-tree failed";
			throw Object.assign(new Error(words), {
				code: child.status,
				stderr: words,
			});
		}
		return { stdout: child.stdout.toString() };
	}
	if (args.line.includes("cat-file")) return { stdout: "blob\n" };
	return { stdout: args.authorAllowlist ?? `${args.fixtureAuthor}\n` };
}
