#!/usr/bin/env bun
/**
 * #2181 A7 — the arms behind the opt-in half of the merge-author gate.
 *
 * The gate is **opt-in per repository**: a repository that has never committed the
 * gate file has never named anyone, and the author rule is simply not applied
 * there — lean and `/work` run in repositories other than this one (including
 * seeded trial repos), and an allowlist that opted out by default would refuse
 * every landing in them. A file that DOES exist is judged fail-closed: a tree, a
 * symlink, an unreadable blob, or a file that names nobody all refuse, as does an
 * author the forge never reported.
 *
 * The arms are here rather than in the test so both decision suites — the shared
 * gate and lean's `land` step — drive ONE table and cannot drift on what each arm
 * is supposed to answer. The gate file's path is assembled from parts so importing
 * this module never puts the gate file's name in a file-size or text scan as one
 * token (the same discipline the fixtures already keep).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitTestEnv } from "./git-test-env.ts";

/** The gate file's path, assembled. */
export const GATE_FILE = [".pi", "merge-authors"].join("/");

/** The allowlist body an arm answers with when it does not name one. */
export const ARMS_ALLOWED = "alice\nBob\n";

/**
 * One arm of the opt-in table. Exactly one of the shapes is set; the rest answer
 * the happy path, so an arm says only what it changes.
 */
export type OptInArm = {
	/** `cat-file -t` answers this instead of `blob` (a directory, a symlink). */
	type?: string;
	/** The path is not in the commit at all — git's own failure for that shape. */
	absent?: boolean;
	/** The blob exists but the bytes cannot be read. */
	showThrows?: boolean;
	/** The bytes the blob answers with (default: the two logins above). */
	body?: string;
};

/** A git executor answering like git, from an {@link OptInArm} table. */
export function optInExec(arm: OptInArm, calls: string[] = []) {
	const exec = async (
		_cmd: string,
		opts?: { argv?: string[] },
	): Promise<{ stdout: string }> => {
		const argv = opts?.argv ?? [];
		calls.push(argv.join(" "));
		if (argv.includes("cat-file")) {
			if (arm.absent === true)
				throw new Error(
					"fatal: path does not exist in '<base>:<gate file>'",
				);
			return { stdout: `${arm.type ?? "blob"}\n` };
		}
		if (arm.showThrows === true) throw new Error("fatal: bad object");
		return { stdout: arm.body ?? ARMS_ALLOWED };
	};
	return { exec, calls };
}

/** A real throwaway clone, with or without the gate file at its base commit. */
export function repoWithOptionalGateFile(opts: {
	/** `undefined` — the repository never opted in; a string is the file's bytes. */
	allowlist?: string;
	/** Write the file as a symlink instead of a blob (the A7 symlink arm). */
	symlinkTo?: string;
}): { repoRoot: string; dispose: () => void } {
	const repoRoot = mkdtempSync(join(tmpdir(), "author-optin-"));
	const git = (...args: string[]) => {
		const child = spawnSync("git", args, { cwd: repoRoot, env: gitTestEnv() });
		if (child.status !== 0) {
			throw new Error(
				`git ${args.join(" ")}: ${child.stderr?.toString().slice(0, 200)}`,
			);
		}
		return child.stdout.toString().trim();
	};
	git("init", "-b", "main");
	git("config", "user.email", "opt-in@test.invalid");
	git("config", "user.name", "Author opt-in test");
	git("config", "commit.gpgsign", "false");
	mkdirSync(join(repoRoot, ".pi"), { recursive: true });
	writeFileSync(join(repoRoot, "README.md"), "# opt-in fixture repo\n");
	if (opts.symlinkTo !== undefined) {
		symlinkSync(opts.symlinkTo, join(repoRoot, GATE_FILE));
	} else if (opts.allowlist !== undefined) {
		writeFileSync(join(repoRoot, GATE_FILE), opts.allowlist);
	}
	git("add", "-A");
	git("commit", "-m", "chore: base");
	return {
		repoRoot,
		/** The commit the file is (or is not) in — what a cycle records as its base. */
		baseSha: git("rev-parse", "HEAD"),
		dispose: () => rmSync(repoRoot, { recursive: true, force: true }),
	};
}
