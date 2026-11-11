#!/usr/bin/env bun
/**
 * A throwaway clone whose AGENTS.md exists ONLY at the SHA it returns as
 * `baseSha`, and not in the working tree.
 *
 * Extracted from work-driver-merged-gate-files-fixture.ts to keep that file
 * under the 500-line gate. The clone carries `.pi/merge-authors` at its base
 * commit so the merged step can reach the protected-path and gate-file gates.
 *
 * The shape matters: `readDoctrineAtBase` asks `git show <sha>:AGENTS.md`, and
 * when that sha's tree has no such file git answers the spec as a REVISION and
 * prints the deletion's commit metadata — a judge would then be handed a diff
 * and quote from it. So the doctrine gets its own commit (the base), and a
 * later commit removes it from the working tree.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitTestEnv } from "./git-test-env.ts";

/**
 * Build a throwaway doctrine repo. `agents` (when set) is committed as
 * AGENTS.md at the base commit and then removed from the working tree, so
 * `readDoctrineAtBase` reads it at `baseSha` but sees nothing on disk.
 * `fixtureAuthor` names the merge-author allowlist entry.
 */
export function doctrineRepo(
	agents: string | undefined,
	fixtureAuthor: string,
): {
	repoRoot: string;
	baseSha: string;
} {
	const repoRoot = mkdtempSync(path.join(tmpdir(), "wd-gate-files-"));
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
	git("config", "user.email", "gate-files@test.invalid");
	git("config", "user.name", "Gate files test");
	git("config", "commit.gpgsign", "false");
	// A bare `git init` has no `origin`, so every `<remote>/<ref>` read the merged
	// step makes is unanswerable and the cycle parks before the gate under test.
	// A local bare remote makes those reads answerable without a network.
	const originDir = mkdtempSync(path.join(tmpdir(), "wd-gate-origin-"));
	const origin = path.join(originDir, "origin.git");
	const bare = spawnSync("git", ["init", "--bare", "-b", "main", origin], {
		env: gitTestEnv(),
	});
	if (bare.status !== 0)
		throw new Error(`git init --bare: ${bare.stderr?.toString()}`);
	mkdirSync(path.join(repoRoot, ".git", "info"), { recursive: true });
	writeFileSync(path.join(repoRoot, "README.md"), "# gate-file fixture repo\n");
	// The merge-author gate reads `.pi/merge-authors` at the cycle's base commit
	// and fails closed, so the fixture must carry the gate file there. Committed
	// at the base commit (not left in the working tree) because that is where the
	// gate reads it. The login is a placeholder — the operator's real list is
	// private.
	mkdirSync(path.join(repoRoot, ".pi"), { recursive: true });
	writeFileSync(
		path.join(repoRoot, ".pi/merge-authors"),
		`${fixtureAuthor}\n`,
	);
	git("add", "-A");
	git("commit", "-m", "chore: base");
	let baseSha = git("rev-parse", "HEAD");
	if (agents !== undefined) {
		writeFileSync(path.join(repoRoot, "AGENTS.md"), agents);
		git("add", "-A");
		git(
			"commit",
			"-m",
			"docs: the doctrine, present only at the cycle's base commit",
		);
		baseSha = git("rev-parse", "HEAD");
		rmSync(path.join(repoRoot, "AGENTS.md"));
		git("add", "-A");
		git("commit", "-m", "chore: the doctrine is gone from the working tree");
	}
	// Publish what exists so `<remote>/main` resolves to a real commit. Done last:
	// the step judges doctrine and allowlist at `baseSha`, so the push cannot move
	// the commit the cycle is judged by — the 406 rule this fixture enforces.
	git("remote", "add", "origin", origin);
	git("push", "-q", "origin", "main");
	return { repoRoot, baseSha };
}
