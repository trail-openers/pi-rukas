#!/usr/bin/env bun
/**
 * Shared helpers for the merge-guard decision-matrix tests (test-merge-guard.ts
 * and test-merge-guard-round-cap.ts). Both files drive the REAL registerMergeGuard
 * hook through `opts.execFn`; this module holds the common ledger setup,
 * the fake-pi hook factory, and the `hookDecision` runner so the two files
 * share one implementation (the 500-line gate: the round-cap matrix is a
 * sibling file, and the shared harness lives here rather than being
 * duplicated).
 *
 * The forge/git ANSWERS the matrix reads live in `merge-guard-stub.ts` (also
 * §12): this file is registration, ledger state and the runner; that one is what
 * a `gh`/`glab`/`git` call is answered with.
 */

import { execSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { MERGE_AUTHORS_FILE } from "../src/merge-author-allowlist.ts";
import { registerMergeGuard } from "../src/merge-guard.ts";
import type { MergeTarget } from "../src/merge-target.ts";
import {
	type LedgerEntry,
	latestEntry,
	ledgerPathFor,
} from "../src/review-ledger.ts";
import { adversarialPassed, lensPassed } from "../src/review-ledger.ts";
import type { MergeGateEnv } from "./merge-guard-forge-fixture.ts";
import { type MergeGuardEnv, mergeGuardExec } from "./merge-guard-stub.ts";
// The hook reads the forge from PI_ENSEMBLE_FORGE (the detectForge hard
// override) so the decision matrix runs offline, without a real remote. A
// GitLab arm flips it for the duration of its own decision (see `makeHook`).
process.env.PI_ENSEMBLE_FORGE = "github";

let LEDGER_FILE: string | undefined;
let LEDGER_TMP_DIR: string | undefined;

export async function setupLedgerPath() {
	LEDGER_TMP_DIR = mkdtempSync(path.join(os.tmpdir(), "pi-ledger-"));
	process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE = path.join(
		LEDGER_TMP_DIR,
		"review-ledger.json",
	);
	const realExec = async (cmd: string) => ({
		stdout: execSync(cmd, { cwd: import.meta.dirname, encoding: "utf8" }),
	});
	const p = await ledgerPathFor(realExec, import.meta.dirname);
	if (!p)
		throw new Error("cannot resolve the ledger path for the decision matrix");
	// Canary: the ledger must NOT live inside any .git directory — that would
	// clobber the real per-clone review ledger shared by every worktree.
	assert(
		!/([/\\])\.git([/\\]|$)/.test(p),
		"canary: the test ledger is not inside a .git directory",
	);
	LEDGER_FILE = p;
}

export function teardownLedger() {
	if (LEDGER_TMP_DIR) {
		try {
			rmSync(LEDGER_TMP_DIR, { recursive: true, force: true });
		} catch (err) {
			console.error(
				`⚠ could not remove the ledger temp dir: ${(err as Error).message}`,
			);
		}
	}
}

export let exit = 0;
export function assert(cond: boolean, msg: string) {
	if (cond) console.log(`✓ ${msg}`);
	else {
		console.error(`✗ ${msg}`);
		exit = 1;
	}
}

export { ledgerPathFor, latestEntry, adversarialPassed, lensPassed };
export type { LedgerEntry, MergeTarget };
export type { MergeGuardEnv };

export const TARGET: MergeTarget = {
	forge: "github",
	prNumber: 12,
	headBranch: "feature/x",
	headOid: "abc123",
	baseBranch: "main",
	author: "dev",
	labels: [],
};

/**
 * #2181 — the logins the harness's default allowlist names.
 *
 * Placeholder logins only: this repository is public and the allowlist is the
 * operator's private list, so no fixture may carry a real one. `dev` — the author
 * the default `TARGET` carries — is on the list, which is what lets every arm
 * written before #2181 keep reaching the gates it was written to exercise. An arm
 * about the author gate names its own `target.author` or replaces the list.
 */
export const ALLOWED_AUTHOR = "dev";
/**
 * The login the real-git fixture commits into `.pi/merge-authors` (its forge stub
 * reports that same author for the fixture PR). Kept separate from `ALLOWED_AUTHOR`
 * because the two fixtures are separate worlds — the stub answers whatever an arm
 * asks, the real repository answers what its own base commit contains — and both
 * must agree with the author their own PR carries.
 */
export const REAL_ALLOWED_AUTHOR = "dev-user";
export const NOT_ALLOWED_AUTHOR = "stranger";
export const DEFAULT_AUTHOR_ALLOWLIST = `# The maintainers whose pull requests an agent may land.\n${ALLOWED_AUTHOR}\n`;

export const GOOD_ENTRIES: LedgerEntry[] = [
	{
		branch: "feature/x",
		kind: "adversarial",
		patchId: "p1",
		passed: true,
		at: 1,
	},
	{ branch: "feature/x", kind: "lens", patchId: "p1", passed: true, at: 2 },
];

/** Save/restore the shared ledger around a row so the matrix is side-effect-free. */
export async function withLedger(
	entries: LedgerEntry[],
	fn: () => Promise<unknown>,
) {
	const file = LEDGER_FILE;
	if (!file)
		throw new Error("ledger path not resolved — call setupLedgerPath() first");
	const saved = (() => {
		try {
			return readFileSync(file, "utf8");
		} catch {
			return null;
		}
	})();
	try {
		writeFileSync(file, JSON.stringify({ entries }, null, 2), "utf8");
	} catch (err) {
		throw new Error(
			`cannot write test ledger at ${file}: ${(err as Error).message}`,
		);
	}
	const done = () => {
		try {
			if (saved === null) {
				if (existsSync(file)) unlinkSync(file);
			} else {
				writeFileSync(file, saved, "utf8");
			}
		} catch (err) {
			console.error(
				`⚠ could not restore the ledger at ${file}: ${(err as Error).message}`,
			);
		}
	};
	try {
		return await fn();
	} finally {
		done();
	}
}

/**
 * Register the real guard on a fake pi and drive it through the shared stub.
 *
 * The one entry point a matrix has: it registers `registerMergeGuard` and hands it
 * `mergeGuardExec`'s arms, so no test reaches the stub directly and none can
 * register the guard twice in a process.
 *
 * The #2226 forge switch lives here, around the handler. The gatherer resolves
 * the forge through the real `detectForge`, whose FIRST precedence is
 * `PI_ENSEMBLE_FORGE` — pinned to `github` at module scope above for the GitHub
 * matrices — so a GitLab arm flips it for the duration of its own decision and
 * restores it afterwards. Flipping it per-decision rather than at module scope
 * is what lets ONE file drive both arms without the second silently inheriting
 * the first's forge (which would send a GitLab arm down the gh path, or a
 * GitHub arm down the glab one, and have each pass on the wrong forge's stub).
 *
 * The flip is REAPPLIED on every call to the returned handler and restored when
 * that call settles — it is not held from here to there. A caller that set it
 * once and threw before invoking the handler (or never invoked it) would leave
 * `gitlab` in `process.env` for every later arm in the same process, and those
 * arms would silently drive the glab stub.
 */
export async function makeHook(
	env: MergeGuardEnv,
): Promise<(event: unknown, ctx: unknown) => Promise<unknown>> {
	let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | undefined;
	const fakePi = {
		on: (
			name: string,
			fn: (event: unknown, ctx: unknown) => Promise<unknown>,
		) => {
			if (name === "tool_call") handler = fn;
		},
	} as never;
	registerMergeGuard(fakePi, {
		execFn: mergeGuardExec(env),
		// #2226 — the guard's OWN forge decision (merge-target.ts → detectForge) is
		// driven from an env the harness supplies rather than the ambient one, so an
		// arm may withhold `PI_ENSEMBLE_FORGE` from everything EXCEPT that decision
		// (see `unsetForgeEnv`, and the origin-URL arm of the stub). Production gets
		// the same precedence from the real environment, where the variable is set by
		// the operator or not at all — and the gatherer keeps classifying the clone
		// from the remote, which is the point of the arm.
		...(env.target.forge === "gitlab" && env.unsetForgeEnv === true
			? { forgeOpts: { env: { PI_ENSEMBLE_FORGE: "gitlab" } } }
			: {}),
	});
	const call = handler;
	if (!call)
		throw new Error("the merge guard did not register a tool_call handler");
	const isGl = env.target.forge === "gitlab";
	// #2226 — the threading witness withholds the pin (see `unsetForgeEnv`): with
	// the pin present, detection's first precedence answers whatever the target
	// already carries, so an arm about the REMOTE has to remove the shortcut to
	// mean what it says. Restored in `finally` below, exactly as the flip is.
	const dropForgeEnv = env.unsetForgeEnv === true;
	return async (event: unknown, ctx: unknown) => {
		const forgeEnvBefore = process.env.PI_ENSEMBLE_FORGE;
		if (isGl) process.env.PI_ENSEMBLE_FORGE = "gitlab";
		if (dropForgeEnv) Reflect.deleteProperty(process.env, "PI_ENSEMBLE_FORGE");
		try {
			return await call(event, ctx);
		} finally {
			if (forgeEnvBefore === undefined)
				Reflect.deleteProperty(process.env, "PI_ENSEMBLE_FORGE");
			else process.env.PI_ENSEMBLE_FORGE = forgeEnvBefore;
		}
	};
}

export async function hookDecision(
	command: string,
	entries: LedgerEntry[],
	opts: {
		target?: MergeTarget;
		patchId?: string;
		fetchedHead?: string;
		failGh?: boolean;
		failFetch?: boolean;
		ledgerCommonDir?: string;
		remote?: string;
		/** #2226 — see `MergeGateEnv.failRemoteUrl` / `unsetForgeEnv`. */
		failRemoteUrl?: boolean;
		unsetForgeEnv?: boolean;
		ghComments?: string;
		mainline?: string;
		mergeBase?: string;
		branchNumber?: "throws" | "empty";
		/** #2181 — the allowlist text, or the fail-closed shapes (see makeHook). */
		authorAllowlist?: string;
		noAllowlist?: boolean;
		allowlistReadThrows?: boolean;
		evidenceAuthor?: string | null;
		/**
		 * #2181 — what the cycle recorded as its base commit, which is what the
		 * allowlist is read at. The guard asks for `<remote>/<mainline>`; the `/work`
		 * driver records `baseSha`, which `work-driver-branch-ops.ts` writes as a REF
		 * (`origin/main`), not a sha — so the driver's own shape is what makes the
		 * reader's `bad-base-sha` arm reachable. An arm names its own value.
		 */
		baseRef?: string;
		/** #2181 — the base-commit resolve fails: an unresolvable ref (fail-closed arm). */
		unresolvableBase?: boolean;
		/**
		 * #2181 — what the base resolve answers when it is the arm's subject:
		 * `"garbage"` = a non-OID, `"moved"` = a commit other than the run's base.
		 */
		baseResolve?: "garbage" | "moved";
		/** #1529 — the protected-path read's answer (see MergeGateEnv). */
		protectedDiff?: string;
		protectedDiffThrows?: boolean;
		/** The mainline OID resolve answers a non-OID (fail-closed arm). */ failBaseOid?:
			| "throws"
			| "garbage";
		/** #2226 — the GitLab arms' fixture knobs, declared here (see MergeGateEnv). */
		glMr?: string;
		glMrStatus?: string;
		glPipelines?: string;
		glPipelinesPage2?: string;
		glJobs?: string;
		glJobsPage2?: string;
	} & MergeGateEnv = {},
) {
	const env: MergeGuardEnv = {
		target: opts.target ?? TARGET,
		currentPatchId: opts.patchId ?? "p1",
		fetchedHead: opts.fetchedHead ?? "abc123",
		failGh: opts.failGh,
		failFetch: opts.failFetch,
		ledgerCommonDir:
			opts.ledgerCommonDir ?? (LEDGER_FILE ? path.dirname(LEDGER_FILE) : ""),
		calls: [] as string[],
		/** #2107 — the `timeout` each exec was given, so a test can assert the bound. */
		timeouts: [] as number[],
		remote: opts.remote ?? "origin",
		failRemoteUrl: opts.failRemoteUrl,
		unsetForgeEnv: opts.unsetForgeEnv,
		ghComments: opts.ghComments,
		mainline: opts.mainline,
		mergeBase: opts.mergeBase,
		branchNumber: opts.branchNumber,
		authorAllowlist: opts.authorAllowlist,
		noAllowlist: opts.noAllowlist,
		allowlistReadThrows: opts.allowlistReadThrows,
		evidenceAuthor: opts.evidenceAuthor,
		baseRef: opts.baseRef,
		unresolvableBase: opts.unresolvableBase,
		baseResolve: opts.baseResolve,
		protectedDiff: opts.protectedDiff,
		protectedDiffThrows: opts.protectedDiffThrows,
		failBaseOid: opts.failBaseOid,
		prChecks: opts.prChecks,
		mergeStateStatus: opts.mergeStateStatus,
		failEvidence: opts.failEvidence,
		failChecks: opts.failChecks,
		evidenceHeadOid: opts.evidenceHeadOid,
		hangChecks: opts.hangChecks,
		glMr: opts.glMr,
		glMrStatus: opts.glMrStatus,
		glPipelines: opts.glPipelines,
		glPipelinesPage2: opts.glPipelinesPage2,
		glJobs: opts.glJobs,
		glJobsPage2: opts.glJobsPage2,
		repoFlag: opts.repoFlag,
		targetRepo: opts.targetRepo,
	};
	const handler = await makeHook(env);
	// The command the hook is handed: the caller's text plus the `-R <repo>` the
	// arm declared. A caller that is NOT testing a merge at all (the reader-threw
	// arm hands over a non-string to make the classifier throw) gets its value
	// untouched — stringifying it would hand the classifier a readable `"[object
	// Object]"` and the arm would exercise the ordinary no-merge path instead of
	// the throw it exists to pin.
	const commandText = () =>
		typeof command === "string" ? command + (env.repoFlag ?? "") : command;
	// #1417 round 2 — capture the HELD trace lines alongside the verdict. The
	// line is the only place a hold's CODE is recorded (the rendered refusal
	// deliberately carries no command text, and the trace carries the code and
	// the length only), so a matrix that asserted only the block/reason could
	// not tell a correct hold from one logged under someone else's cause.
	const traces: string[] = [];
	const realWrite = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array) => {
		traces.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	let r: unknown;
	try {
		r = await withLedger(entries, () =>
			handler(
				{ toolName: "bash", input: { command: commandText() } },
				undefined as never,
			),
		);
	} finally {
		process.stderr.write = realWrite;
	}
	return {
		block: (r as { block?: boolean } | undefined)?.block === true,
		reason: (r as { reason?: string } | undefined)?.reason,
		calls: env.calls,
		/** #2107 — every `timeout` the hook passed to an exec, in call order. */
		timeouts: env.timeouts,
		/**
		 * Every `merge-guard: HELD …` OR `merge-guard: BLOCKED …` trace line the
		 * hook emitted for this command. #1479 — the filter used to match `HELD`
		 * only, so a blocked merge (kind `merge`, unresolvable number) logged its
		 * `merge-guard: BLOCKED` trace line and no test could ever see it. The
		 * line is stored WITHOUT the `[pi-rukas] WARN ` prefix `traceWarn` adds,
		 * so an assertion can anchor on `^merge-guard:` without depending on the
		 * console prefix — which is harness plumbing, not the trace contract.
		 * (Renamed from `holds` in #1479: it now carries BLOCKED lines too, and
		 * `traces` matches the doc — these are the guard's trace lines.)
		 */
		traces: traces
			.filter(
				(l) =>
					l.includes("merge-guard: HELD") || l.includes("merge-guard: BLOCKED"),
			)
			.map((l) =>
				// #1479 lens fix — strip ANY trace level word, not just `WARN`: the
				// prefix is harness plumbing (`[pi-rukas] LEVEL msg`), and a future
				// level must not silently change which lines the filter sees.
				l
					.trim()
					.replace(/^\[pi-rukas\] [A-Z]+ /, ""),
			),
	};
}
