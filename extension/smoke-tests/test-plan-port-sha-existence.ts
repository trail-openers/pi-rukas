#!/usr/bin/env bun
/**
 * #1439 — a bare commit SHA named in an issue body is a port reference only if
 * it is a commit in this repo. An issue body quoting an example SHA ("fixed in
 * 7c6b0f1…") used to plan a cherry-pick of an object that does not exist, and
 * the developer stopped on it. URL and PR/MR references are not checked here.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	detectPortReference,
	portReferenceForCycle,
} from "../src/work-driver-plan-contract.ts";
import { initialState } from "../src/workflow-state-update.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
	if (cond) console.log(`✓ ${msg}`);
	else {
		console.error(`✗ ${msg}`);
		exit = 1;
	}
}

const NONEXISTENT = "7c6b0f1a2b3c4d5e6f708192a3b4c5d6e7f80912";
const dir = mkdtempSync(path.join(os.tmpdir(), "port-sha-"));
try {
	// A real repo with one commit, so `git cat-file` has an object to find.
	const repo = path.join(dir, "repo");
	execFileSync("git", ["init", "-q", repo]);
	writeFileSync(path.join(repo, "a.txt"), "x\n");
	execFileSync("git", ["-C", repo, "add", "a.txt"]);
	execFileSync("git", [
		"-C",
		repo,
		"-c",
		"user.name=t",
		"-c",
		"user.email=t@t",
		"commit",
		"-q",
		"-m",
		"init",
	]);
	const real = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
		encoding: "utf8",
	}).trim();

	const stateFor = (body: string): WorkState => {
		const bodyPath = path.join(
			dir,
			`body-${Math.random().toString(36).slice(2)}.txt`,
		);
		writeFileSync(bodyPath, body);
		const s = initialState(1439, 1);
		return {
			...s,
			pipelineState: { ...s.pipelineState, issueBodyArtifact: bodyPath },
		};
	};

	// 1. a SHA that is not in the repo is not a port
	const fake = `Behaviour is wrong. Fixed in ${NONEXISTENT} on main, see the test.`;
	assert(
		detectPortReference(fake) === NONEXISTENT,
		"canary: the detector still matches the fake SHA (the check is what rejects it)",
	);
	assert(
		(await portReferenceForCycle(stateFor(fake), [1439], repo)) === undefined,
		"a nonexistent SHA after 'fixed in' yields NO port reference",
	);

	// 2. a SHA that exists in this repo is still a port
	const present = `Fixed in ${real} on main.`;
	assert(
		(await portReferenceForCycle(stateFor(present), [1439], repo)) === real,
		"a SHA that exists in the repo still yields the port reference",
	);
	assert(
		(await portReferenceForCycle(
			stateFor(`Fixed in ${real.slice(0, 10)} on main.`),
			[1439],
			repo,
		)) === real.slice(0, 10),
		"an abbreviated SHA that exists is still a port reference",
	);

	// 3. a URL reference is not checked by the SHA existence test
	const url =
		"Landed upstream as https://github.com/example/repo/commit/abc1234 on main.";
	assert(
		(await portReferenceForCycle(stateFor(url), [1439], repo)) ===
			detectPortReference(url),
		"a URL reference is returned exactly as the detector finds it (not checked for existence)",
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
