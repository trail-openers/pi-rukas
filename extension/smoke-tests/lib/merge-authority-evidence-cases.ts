// ─────────────────────────────────────────────────────────────────────────────
// The evidence half of #380 — what `gatherMergeEvidence` accepts as a merge
// verdict — split out of `test-merge-authority.ts` for the AGENTS.md §12 cap.
//
// The seam is the parent file's own section boundary: everything here is the
// EXECUTED forge read (a CLEAN board, a moved head, an unreadable `gh`, the
// pinned argv), and everything that stayed is the narration/demotion arms and the
// operator-facing hold actions, which read the same `MergeEvidence` shape but
// never shell out. The one fake (`fakeGh`), the fixture pair (`GREEN_HEAD` /
// `GREEN_STATE`) and the assertions that consume them all moved together, so no
// fixture is defined on one side of the seam and used on the other.
//
// The forge is named explicitly on every call below. `gatherMergeEvidence`
// resolves one from the repo when the caller does not, and `/x` is not a repo; an
// unresolved forge is a tooling refusal rather than a silent fall-through to the
// gh path (#2226), so an arm that means "this is GitHub" has to say so.
// ─────────────────────────────────────────────────────────────────────────────

import { gatherMergeEvidence } from "../../src/work-driver-merge-evidence.ts";

/** The assertion seam the parent owns, so its counter sees these failures too. */
export type Assert = (cond: boolean, msg: string) => void;

type Call = { cmd: string };

/** Answer the forge reads a merge decision is taken from; anything else throws. */
export function fakeGh(
	responses: Record<string, string | Error>,
	checksFrag = "pr checks",
) {
	const calls: Call[] = [];
	const fn = async (cmd: string) => {
		calls.push({ cmd });
		for (const [frag, res] of Object.entries(responses)) {
			const key = frag === "pr checks" ? checksFrag : frag;
			if (cmd.includes(key)) {
				if (res instanceof Error) throw res;
				return { stdout: res };
			}
		}
		throw new Error(`unexpected command: ${cmd}`);
	};
	return { fn, calls };
}

// #1533 — the head OID the CI verdict is read at rides the SAME response, so
// the fixtures that stand in for `gh pr view` answer it the way gh does.
export const GREEN_HEAD = "a".repeat(40);
export const GREEN_STATE = JSON.stringify({
	mergeStateStatus: "CLEAN",
	state: "OPEN",
	headRefOid: GREEN_HEAD,
});
export const passing = (name: string) => ({
	name,
	state: "SUCCESS",
	bucket: "pass",
});

/**
 * The forge every arm below means. Named on each call rather than left to
 * detection: `/x` is not a repository, so an unnamed forge resolves to
 * "unknown" and the gatherer refuses as tooling — which is the point of the
 * positive dispatch (#2226), and why an arm that means GitHub says so.
 */
export const GH = "github" as const;

/** Run the evidence arms against the fake forge. True when any assertion failed. */
export async function runEvidenceCases(say: Assert): Promise<boolean> {
	let failed = false;
	const check = (cond: boolean, msg: string): void => {
		if (!cond) failed = true;
		say(cond, msg);
	};
	// The arms below arrived from the parent verbatim, where the seam was the
	// module-level `assert`. Inside this function that seam is `check`, which is
	// what lets a failure here reach the parent's counter instead of throwing.
	const assert = check;

	{
		// #1533 — the verified head the merge is pinned to comes out of the SAME
		// bounded read that answered the CI verdict, so a head that moved between two
		// reads cannot be papered over. Three refusals and one success, all from the
		// shape of that one field.
		const checks = JSON.stringify([passing("build")]);
		const green = await gatherMergeEvidence(
			fakeGh({ "pr view": GREEN_STATE, "pr checks": checks }).fn,
			"/x",
			7,
			GH,
		);
		assert(
			green.ok &&
				green.headOid === GREEN_HEAD &&
				green.headOidError === undefined,
			`#1533: a CLEAN read carries the head OID the verdict describes (${JSON.stringify(green)})`,
		);

		const absent = await gatherMergeEvidence(
			fakeGh({
				"pr view": JSON.stringify({ mergeStateStatus: "CLEAN", state: "OPEN" }),
				"pr checks": checks,
			}).fn,
			"/x",
			7,
			GH,
		);
		assert(
			absent.headOid === undefined &&
				/no head OID/.test(absent.headOidError ?? ""),
			`#1533: an absent head OID names the failed read (${JSON.stringify(absent.headOidError)})`,
		);

		const abbrev = await gatherMergeEvidence(
			fakeGh({
				"pr view": JSON.stringify({
					mergeStateStatus: "CLEAN",
					state: "OPEN",
					headRefOid: "abc1234",
				}),
				"pr checks": checks,
			}).fn,
			"/x",
			7,
			GH,
		);
		assert(
			abbrev.headOid === undefined &&
				/not a full 40-char SHA/.test(abbrev.headOidError ?? ""),
			`#1533: an abbreviated OID is refused and named, not silently trusted (${JSON.stringify(abbrev.headOidError)})`,
		);

		const threw = await gatherMergeEvidence(
			fakeGh({
				"pr view": new Error("gh: connection reset"),
				"pr checks": checks,
			}).fn,
			"/x",
			7,
			GH,
		);
		assert(
			threw.headOid === undefined && /failed/.test(threw.headOidError ?? ""),
			`#1533: a read that threw names the failed read rather than reporting nothing (${JSON.stringify(threw.headOidError)})`,
		);
	}

	{
		// #745 — the exact argv the gate shells out to is pinned here for the same
		// reason the vipune argv gate pins its flags: a single unsupported field
		// made the whole invocation fail closed on every host.
		const { fn, calls } = fakeGh({
			"pr view": GREEN_STATE,
			"pr checks": JSON.stringify([passing("build"), passing("test")]),
		});
		const e = await gatherMergeEvidence(fn, "/x", 7, GH);
		assert(
			e.ok,
			"all required checks passing + CLEAN → evidence gate allows the merge",
		);
		assert(
			calls.length >= 2,
			"the gate issues two reads: the PR state and the checks",
		);
		assert(
			// #1533 — `headRefOid` is requested by the SAME read: the CI verdict and
			// the merge pin must describe one moment on the forge, so the field list is
			// part of this gate's pinned argv. #2181 adds `author` to the same read for the
			// same reason: the login judged against `.pi/merge-authors` and the OID pinned
			// come from one moment, not two — which is exactly what this assertion protects.
			calls[0]!.cmd ===
				"gh pr view 7 --json mergeStateStatus,mergeable,state,headRefOid,author",
			`argv: gh pr view requests exactly the fields the gate knows how to read (got: ${calls[0]!.cmd})`,
		);
		assert(
			calls[1]!.cmd === "gh pr checks 7 --json name,state,bucket",
			`argv: gh pr checks requests only fields gh 2.98.0 supports (got: ${calls[1]!.cmd}) — isRequired is NOT one of them`,
		);
	}
	{
		// The GitHub-docs trap: "Successful check statuses are success, skipped and
		// neutral". A required workflow that gains a `paths-ignore:` becomes a gate
		// that cannot fail.
		const { fn } = fakeGh({
			"pr view": GREEN_STATE,
			"pr checks": JSON.stringify([
				passing("build"),
				{ name: "test", state: "SKIPPED", bucket: "skipping", isRequired: true },
			]),
		});
		const e = await gatherMergeEvidence(fn, "/x", 7, GH);
		assert(
			!e.ok,
			"a required check reporting `skipped` is NOT passing, though GitHub says it is",
		);
		assert(
			e.inconclusive.includes("test"),
			"and the skipped check is named for the operator",
		);
	}
	{
		const { fn } = fakeGh({
			"pr view": GREEN_STATE,
			"pr checks": JSON.stringify([
				passing("build"),
				{ name: "test", state: "FAILURE", bucket: "fail" },
			]),
		});
		const e = await gatherMergeEvidence(fn, "/x", 7, GH);
		assert(
			!e.ok && e.failing.includes("test"),
			"a failing required check blocks the merge",
		);
	}
	{
		const { fn } = fakeGh({
			"pr view": GREEN_STATE,
			"pr checks": JSON.stringify([
				passing("build"),
				{ name: "test", state: "PENDING", bucket: "pending", isRequired: true },
			]),
		});
		assert(
			(await gatherMergeEvidence(fn, "/x", 7, GH)).ok === false,
			"a still-running required check blocks the merge (no racing CI)",
		);
	}
	{
		const { fn } = fakeGh({
			"pr view": JSON.stringify({ mergeStateStatus: "BLOCKED", state: "OPEN" }),
			"pr checks": JSON.stringify([passing("build")]),
		});
		const e = await gatherMergeEvidence(fn, "/x", 7, GH);
		assert(
			!e.ok,
			"mergeStateStatus BLOCKED blocks the merge even when every check is green",
		);
		assert(
			/BLOCKED/.test(e.reason ?? ""),
			"...because branch protection knows about reviews and conversations that checks do not",
		);
	}
	{
		const { fn } = fakeGh({
			"pr view": JSON.stringify({ mergeStateStatus: "CLEAN", state: "MERGED" }),
		});
		assert(
			(await gatherMergeEvidence(fn, "/x", 7, GH)).ok === false,
			"an already-MERGED / non-OPEN PR is not re-merged",
		);
	}
	{
		// Fails CLOSED — the opposite of every other gate in the driver, because
		// this one is followed by an irreversible act.
		const { fn } = fakeGh({ "pr view": new Error("gh: not authenticated") });
		const e = await gatherMergeEvidence(fn, "/x", 7, GH);
		assert(
			!e.ok,
			"an unreadable `gh` blocks the merge — no evidence is not evidence of green",
		);
	}
	{
		// #745 — the crash-versus-verdict distinction. A gate whose OWN gh
		// invocation errors used to produce the "could not read PR checks" reason,
		// which the queue summary rendered as "check the incomplete required
		// checks" — a CI verdict about a system where no check data was ever read.
		const { fn } = fakeGh({
			"pr view": GREEN_STATE,
			"pr checks": new Error("exit 1"),
		});
		const e = await gatherMergeEvidence(fn, "/x", 7, GH);
		assert(
			e.ok === false,
			"`gh pr checks` erroring blocks the merge (fail-closed is preserved)",
		);
		assert(
			e.failureKind === "tooling",
			"a gh invocation error is tagged `tooling`, textually distinct from a CI verdict",
		);
	}
	{
		// gh 2.98.0 exits non-zero with EMPTY stdout when checks are still pending
		// (exit 8) — the CLI answered nothing, so the operator must not be pointed
		// at CI. The same tag applies: the fault is the invocation, not the checks.
		const { fn } = fakeGh({
			"pr view": GREEN_STATE,
			"pr checks": new Error("exit 8"),
		});
		const e = await gatherMergeEvidence(fn, "/x", 7, GH);
		assert(e.ok === false, "a non-zero exit with no data still blocks the merge");
		assert(
			e.failureKind === "tooling",
			"a non-zero exit with no data is tooling, not 'no checks'",
		);
	}
	{
		// A CLEAN PR with a successfully-read EMPTY check list is still a CI
		// verdict, not a tooling one: the invocation returned what GitHub has, so
		// the refusal is "the checks say no", which the operator acts on by
		// configuring required checks — unlike a crashed query, which they cannot.
		const { fn } = fakeGh({
			"pr view": GREEN_STATE,
			"pr checks": "[]",
		} as Record<string, string>);
		const e = await gatherMergeEvidence(fn, "/x", 7, GH);
		assert(
			!e.ok,
			"zero checks with a CLEAN status still blocks — no evidence of green checks",
		);
		assert(
			e.failureKind !== "tooling",
			"an empty (but successfully read) list is a CI verdict, not tooling",
		);
	}
	{
		// #745 review — an exit-0 invocation that returns EMPTY stdout is no data
		// at all, not an empty check list: coercing it to `[]` would let the gate
		// say "no checks reported" (a CI verdict) about a query that answered with
		// nothing, so it is tagged tooling like a non-zero exit.
		const { fn } = fakeGh(
			{
				"pr view": GREEN_STATE,
				"pr checks": "  \n",
			} as Record<string, string>,
			"pr check",
		);
		const e = await gatherMergeEvidence(fn, "/x", 7, GH);
		assert(
			!e.ok,
			"empty stdout from an exit-0 `gh pr checks` still blocks (fail-closed)",
		);
		assert(
			e.failureKind === "tooling",
			"empty stdout is no data read — a tooling failure, not a 'no checks' CI verdict",
		);
	}
	{
		// #745 review — an exit-0 invocation whose stdout is NOT an array is a data
		// regression, not a tooling failure: the CLI answered, its shape just isn't
		// what the gate reads. The reason must show WHAT came back (truncated),
		// and must NOT carry the tooling tag that would send the operator to fix
		// their tooling instead of the malformed response.
		const { fn } = fakeGh(
			{
				"pr view": GREEN_STATE,
				"pr checks": "<html>Internal Server Error</html> not-json",
			} as Record<string, string>,
			"pr check",
		);
		const e = await gatherMergeEvidence(fn, "/x", 7, GH);
		assert(
			!e.ok,
			"non-array stdout from an exit-0 `gh pr checks` blocks (fail-closed)",
		);
		assert(
			e.failureKind !== "tooling",
			"malformed data is not tagged `tooling` (that would mislead)",
		);
		assert(
			/data the gate could not read as a check list/.test(e.reason ?? ""),
			"the reason names the data regression, not a broken gh setup",
		);
		assert(
			/could not read as a check list|got:/.test(e.reason ?? ""),
			"and names the regression explicitly (raw slice or an explicit no-data note)",
		);
	}
	{
		// #745 review — mergeStateStatus is a string the CLI passes through, and it
		// lands verbatim in handoffs; a hostile/anomalous value must not yield an
		// unbounded operator-facing string.
		const longStatus = "X".repeat(200);
		const { fn } = fakeGh(
			{
				"pr view": JSON.stringify({
					mergeStateStatus: longStatus,
					state: "OPEN",
				}),
				"pr checks": JSON.stringify([passing("build")]),
			} as Record<string, string>,
			"pr check",
		);
		const e = await gatherMergeEvidence(fn, "/x", 7, GH);
		assert(
			!e.ok,
			"an anomalous mergeStateStatus still blocks (fail-closed, not in the blocking set)",
		);
		assert(
			(e.reason ?? "").length < 120,
			`the rendered reason is bounded (got ${e.reason?.length}) — mergeStateStatus is truncated on read`,
		);
		assert(
			e.mergeStateStatus?.length === 64,
			"the stored value itself is bounded at read time",
		);
	}

	{
	  // #2226 — the fail direction of the forge branch. An unresolved forge used to
	  // fall through to the gh path, so a repo whose remote does not resolve read
	  // CI evidence off whatever CLI was installed. `unknown` is a refusal now, and
	  // it issues no read at all — which is also why every arm above names its forge.
	  const calls: string[] = [];
	  const e = await gatherMergeEvidence(
	    // The fake records every command it is handed, so the arm can also say the
	    // refusal issued none.
	    (async (cmd: string) => {
	      calls.push(cmd);
	      return { stdout: "{}" };
	    }) as unknown as Parameters<typeof gatherMergeEvidence>[0],
	    "/x",
	    7,
	    "unknown",
	  );
	  assert(
	    e.ok === false && e.failureKind === "tooling",
	    `#2226: an unresolved forge refuses as tooling (${JSON.stringify(e)})`,
	  );
	  assert(/forge/i.test(e.reason ?? ""), `…and names the unresolved forge (${e.reason})`);
	  assert(calls.length === 0, `…issuing no read at all (${JSON.stringify(calls)})`);
	}


	return failed;
}
