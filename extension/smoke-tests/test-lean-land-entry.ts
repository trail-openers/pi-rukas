#!/usr/bin/env bun
/**
 * lean/land — the ENTRY POINT is what runs, end to end, on evidence.
 *
 * `test-lean-land.ts` pins the branches of the decision through a recorder. This
 * file pins that the entry point `landOutcome` — the one the handler table wires
 * and the merge actually goes through — reaches each of those branches when
 * driven the way the engine drives it, with no helper in between: a grant plus a
 * matching head must arrive at `merged` with the merge pinned and read back, and
 * a head mismatch must refuse naming BOTH oids. If the entry point ever stopped
 * consulting the grant, the evidence, the pin or the readback, a case here goes
 * red even if a helper-level suite stayed green.
 *
 *   (l1) granted + ok evidence + head == verified head -> `merged`, and:
 *        the merge call carried the verified oid, `squash`, and a subject;
 *        the state was read back and said MERGED.
 *   (l2) the PR head is not the verified head -> `refused`, naming both oids in
 *        full-ish form, and the merge seam was NEVER called.
 *   (l3) `autoMerge: false` -> refused naming the grant; no merge.
 *   (l4) an unreadable config -> refused naming the unreadable config, in words
 *        that are NOT "the project declined to grant it" (the two need different
 *        operator actions).
 *   (l5) the merge call returned but the forge says OPEN -> refused; `merged` is
 *        only ever a read-back claim.
 *   (l6) no verified head on the log -> refused before the forge is touched.
 *
 * The log is the real fixture (a real commit whose oid the verify step records),
 * so `merged` is never asserted over a record the loader would refuse.
 */

import { rmSync } from "node:fs";
import {
  mergeEvidenceGlMrCmd,
  mergeEvidenceGlPipelinesCmd,
} from "../src/forge-commands-gl-evidence.ts";
import type { HandlerCtx } from "../src/lean/engine.ts";
import type { LandDeps, MergeCall } from "../src/lean/land-deps.ts";
import { landOutcome } from "../src/lean/land.ts";
import type { Outcome } from "../src/lean/state.ts";
import type { MergeEvidence } from "../src/work-driver-merge-evidence.ts";
import { gatherMergeEvidence } from "../src/work-driver-merge-evidence.ts";
import { ROOTS, ciLandLog } from "./lib/lean-ci-land-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
	if (cond) console.log(`✓ ${msg}`);
	else {
		console.error(`✗ ${msg}`);
		exit = 1;
	}
}

function ok(over: Partial<MergeEvidence> = {}): MergeEvidence {
	return { ok: true, failing: [], inconclusive: [], ...over };
}

interface Drive {
	calls: MergeCall[];
	statesRead: number;
	grantsRead: number;
	evidenceRead: number;
}

/**
 * Drive the real entry point with a recording forge.
 *
 * Every seam records that it was consulted, so a case asserting "refused" can
 * also assert the irreversible seam was never reached — the difference between a
 * gate that decided and a gate that happened to be downstream of the merge.
 */
async function drive(
	issue: number,
	opts: {
		autoMerge?: boolean;
		configThrows?: boolean;
		ev?: (head: string) => MergeEvidence | undefined;
		after?: string | undefined;
		mergeThrows?: boolean;
		subject?: string;
		noVerifiedHead?: boolean;
	} = {},
): Promise<{ outcome?: Outcome; threw?: Error; d: Drive; head: string }> {
	const f = ciLandLog(
		issue,
		opts.noVerifiedHead === true ? { noVerifiedHead: true } : {},
	);
	const head = f.head;
	const d: Drive = { calls: [], statesRead: 0, grantsRead: 0, evidenceRead: 0 };
	const deps: LandDeps = {
		evidence: async () => {
			d.evidenceRead++;
			return opts.ev === undefined
				? ok({ headOid: head, mergeStateStatus: "CLEAN" })
				: opts.ev(head);
		},
		openPr: async () => 42,
		merge: async (_repo, call) => {
			d.calls.push(call);
			if (opts.mergeThrows === true)
				throw new Error("branch protection refused it");
		},
		stateAfter: async () => {
			d.statesRead++;
			return opts.after === undefined ? "MERGED" : opts.after;
		},
		// #2181 — the author gate, answered the way the production seam answers it for a
		// forge that reports an allowlisted login: these cases are about the seams AFTER
		// it (the merge call, the state read-back, the grant). The refusals themselves are
		// the gate's own suite, test-merge-author-allowlist.ts, and the driver arms in
		// test-work-driver-merged-gate-files.ts.
		checkAuthor: async () => ({ ok: true }),
		loadConfig: async () => {
			d.grantsRead++;
			if (opts.configThrows === true)
				throw new Error("git show <base>:.pi/work.json: unable to read tree");
			return { autoMerge: opts.autoMerge !== false };
		},
		...(opts.subject === undefined ? {} : { mergeSubject: () => opts.subject }),
	};
	try {
		return { outcome: await landOutcome(f.ctx as HandlerCtx, deps), d, head };
	} catch (err) {
		return { threw: err as Error, d, head };
	}
}

// ── (l1) the entry point merges, pinned and read back ────────────────────
{
	const r = await drive(601, {
		subject: "fix(retry): make a transient failure retry",
	});
	assert(
		r.outcome?.kind === "merged",
		`(l1) grant + ok + matching head -> merged via landOutcome (${JSON.stringify(r.outcome ?? r.threw?.message)})`,
	);
	assert(r.d.calls.length === 1, "(l1) exactly one merge was attempted");
	assert(r.d.calls[0]?.headOid === r.head, "(l1) pinned to the verified head");
	assert(r.d.calls[0]?.method === "squash", "(l1) as a squash");
	assert(
		r.d.calls[0]?.subject === "fix(retry): make a transient failure retry",
		"(l1) carrying the squash subject",
	);
	assert(
		r.d.statesRead === 1,
		"(l1) and the state was read back from the forge, once",
	);
	assert(
		r.d.grantsRead === 1 && r.d.evidenceRead === 1,
		"(l1) both gates were consulted, not assumed",
	);
	assert(
		typeof r.d.calls[0]?.headOid === "string" &&
			/^[0-9a-f]{40}$/.test(r.d.calls[0]!.headOid),
		"(l1) the pin is a full 40-hex oid, not a prefix",
	);
}

// ── (l2) head mismatch: refuse naming BOTH oids, and never merge ─────────
{
	const moved = "c".repeat(40);
	const r = await drive(602, {
		ev: () => ok({ headOid: moved, mergeStateStatus: "CLEAN" }),
	});
	assert(
		r.outcome?.kind === "refused",
		`(l2) a moved PR head -> refused (${JSON.stringify(r.outcome)})`,
	);
	const reason = r.outcome?.reason ?? "";
	assert(
		reason.includes("is not the verified head"),
		`(l2) it names the relation (${reason})`,
	);
	assert(
		reason.includes(moved.slice(0, 12)),
		`(l2) and the PR head it saw (${reason})`,
	);
	assert(
		reason.includes(r.head.slice(0, 12)),
		`(l2) and the verified head it expected (${reason})`,
	);
	assert(r.d.calls.length === 0, "(l2) the merge seam was NEVER called");
	assert(
		r.d.statesRead === 0,
		"(l2) and nothing was read back after a merge that did not happen",
	);
}

// ── (l3) no grant ────────────────────────────────────────────────────────
{
	const r = await drive(603, { autoMerge: false });
	assert(r.outcome?.kind === "refused", "(l3) autoMerge false -> refused");
	assert(
		(r.outcome?.reason ?? "").includes("autoMerge"),
		"(l3) naming the missing grant",
	);
	assert(r.d.calls.length === 0, "(l3) no merge was attempted");
}

// ── (l4) unreadable config is NOT reported as "the project declined" ─────
{
	const r = await drive(604, { configThrows: true });
	const reason = r.outcome?.reason ?? "";
	assert(
		r.outcome?.kind === "refused",
		`(l4) an unreadable config -> refused (${JSON.stringify(r.outcome)})`,
	);
	assert(
		/could not be READ/i.test(reason),
		`(l4) the refusal names the unreadable config (${reason})`,
	);
	assert(
		!/^land refused: autoMerge is not true/.test(reason),
		`(l4) and does NOT read as the project declining to grant (${reason})`,
	);
	assert(r.d.calls.length === 0, "(l4) no merge was attempted");
}

// ── (l5) the call returned; the forge did not merge ─────────────────────
{
	const r = await drive(605, { after: "OPEN" });
	assert(
		r.outcome?.kind === "refused",
		"(l5) a merge that did not merge -> refused",
	);
	assert(
		(r.outcome?.reason ?? "").includes("not MERGED"),
		"(l5) because it was read back",
	);
	assert(
		r.d.calls.length === 1,
		"(l5) the merge was attempted exactly once, then refused",
	);
}

// ── (l6) nothing verified: refuse before the forge ──────────────────────
{
	const r = await drive(606, { noVerifiedHead: true });
	assert(r.outcome?.kind === "refused", "(l6) no verified head -> refused");
	assert(
		r.d.evidenceRead === 0 && r.d.calls.length === 0,
		"(l6) before the forge was touched at all",
	);
}

// ── (l7) a throwing merge is a refusal, never a `merged` ────────────────
{
	const r = await drive(607, { mergeThrows: true });
	assert(
		r.outcome?.kind === "refused",
		`(l7) a throwing merge -> refused, not merged (${JSON.stringify(r.outcome)})`,
	);
	assert(r.d.calls.length === 1, "(l7) attempted once, honestly recorded");
	assert(r.d.statesRead === 0, "(l7) nothing read back after a failed call");
}

// ── (l8) the production seam supplies a subject (never left to luck) ────
{
	// `landDeps()` must hand `land` a mergeSubject: a squash subject becomes the
	// commit record on main and release-please reads it, so the wiring being absent
	// is the bug, and it is invisible unless someone asserts it exists.
	const { landDeps } = await import("../src/lean/land-deps.ts");
	assert(
		typeof landDeps().mergeSubject === "function",
		"(l8) production wiring supplies mergeSubject",
	);
}

// ── (l9) #2226 — the evidence seam the land wiring uses is forge-aware ───
{
	// E6, driven through the same gatherer `landDeps()` wires: on a GitLab project
	// the evidence read must reach the GitLab arm and answer from `glab`, not
	// issue gh argv and refuse a green MR on the absence of evidence — the exact
	// shape that parked a GitLab pilot's work-lean run at `land`.
	const HEAD = "a".repeat(40);
	const asked: string[] = [];
	// The three fixture keys are the builders' OWN output, not hand-spelled argv:
	// a builder that grows a parameter used to leave this arm answering a read it
	// no longer issues, and the failure looked like a gatherer bug rather than a
	// fixture drift. The exact argv is pinned in test-gh-argv.ts.
	const rows: Record<string, string> = {
		[mergeEvidenceGlMrCmd(42)]: JSON.stringify({
			iid: 42,
			state: "opened",
			detailed_merge_status: "can_be_merged",
			has_conflicts: false,
			blocking_discussions_resolved: true,
			approvals_left: 0,
			sha: HEAD,
			diff_refs: { head_sha: HEAD },
			head_pipeline: { id: 5001, sha: HEAD, status: "success" },
		}),
		[mergeEvidenceGlPipelinesCmd(42)]: JSON.stringify([
			{ id: 5001, sha: HEAD, status: "success" },
		]),
		// Matched as a prefix, so it stays correct when the builder grows the page
		// pin (#2226) — the argv itself is pinned in test-gh-argv.ts.
		'glab api "/projects/:id/pipelines/5001/jobs': JSON.stringify([
			{ name: "build", status: "success", allow_failure: false },
			{ name: "test", status: "success", allow_failure: false },
			// The pilot shape: a manual deploy job the pipeline may fail must not
			// park the land step.
			{ name: "deploy-production", status: "manual", allow_failure: true },
		]),
	};
	const glExec = async (cmd: string) => {
		asked.push(cmd);
		for (const [frag, stdout] of Object.entries(rows)) {
			if (cmd.startsWith(frag)) return { stdout };
		}
		throw new Error(`unexpected exec: ${cmd}`);
	};
	// The seam's own forge source is `detectForge`, whose first precedence is
	// PI_ENSEMBLE_FORGE — the offline switch every forge matrix in this suite uses.
	const savedForge = process.env.PI_ENSEMBLE_FORGE;
	process.env.PI_ENSEMBLE_FORGE = "gitlab";
	try {
		const ev = await gatherMergeEvidence(glExec, "/x", 42);
		assert(
			ev.ok === true && ev.headOid === HEAD,
			`(l9) the land evidence read passes a green MR on GitLab (${JSON.stringify(ev)})`,
		);
		assert(
			asked.length > 0 && asked.every((c) => c.startsWith("glab ")),
			`(l9) …and issued ONLY glab reads — no gh argv on a GitLab project (${JSON.stringify(asked)})`,
		);
	} finally {
		if (savedForge === undefined)
			Reflect.deleteProperty(process.env, "PI_ENSEMBLE_FORGE");
		else process.env.PI_ENSEMBLE_FORGE = savedForge;
	}
}

for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true });
process.exit(exit);
