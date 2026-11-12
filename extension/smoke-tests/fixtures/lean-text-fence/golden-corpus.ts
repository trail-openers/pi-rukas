/**
 * lean fenceText golden — the corpus and the provenance constants.
 *
 * Two readers, one file:
 *
 *   - `test-lean-text-fence-golden.ts` imports `CASES` and the `BASE_*` constants and asserts
 *     the committed JSON against them — the set of inputs a reviewer approved, stated once;
 *   - `generate-golden.sh` (beside this file) runs `main()` from a temp dir over the release
 *     tag's own `text-fence.ts` and writes that JSON.
 *
 * The renderer is a *parameter* (`render`), never an import here: a module this file imported
 * would be this checkout's code, and a golden recorded from the code under test pins that code
 * against itself and goes green whatever it does. `main()` refuses any run from inside the
 * repository for that reason — the wrapper runs its recorder from a temp mirror outside the tree,
 * with the import rewritten to the tag module it extracted and hashed. Nothing but the JSON lands
 * in the tracked tree.
 *
 * Strings are stored whole: no codec between a recorded byte and the byte the test compares.
 *
 * The corpus is hand-picked because the first one was not. `shapes` is spelled once per fence
 * character and the whole set was then taken at every cap, which is what a generator does and
 * what made the fixture 230 KB — too large for the review tool's diff buffer, so the change it
 * pinned could not be read at all. A generator has to pay for its bytes explicitly:
 * `filler(max)` is one line and 40 KB, `filler(max - 2) + "```"` is one line and 100 bytes, and
 * the two assert the same thing about the renderer. So the set is taken at the small cap, and
 * only what no short case can make — a fence run the cut lands inside — is carried at the three
 * production bounds.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ISSUE_TRUNCATION_MARKER, MAX_ISSUE_CHARS } from "../../../src/adversarial-prompts.ts";

/** The tag the golden is captured from, and the commit `generate-golden.sh` must resolve it to. */
export const BASE_TAG = "v0.14.71";
export const BASE_COMMIT = "2769cdb7";
/** What the wrapper extracts that tag's `text-fence.ts` under, in the temp dir it runs from. */
export const BASE_FILE = "v71-fence.ts";
/**
 * sha-256 of that module at BASE_COMMIT — the check that makes the stamp mean something. The
 * wrapper resolves BASE_TAG to a full oid and refuses anything but BASE_COMMIT, then compares
 * the extracted bytes against this digest, so the golden can only be stamped v0.14.71 by a run
 * over those exact bytes. Retargeting the golden means changing both constants, and the wrapper
 * reports a mismatch rather than recording whatever arrived.
 */
export const BASE_SHA256 = "e3b8fe7a8fe9cd1586a060c967c528df1e3a7d29ffdf6517800978b5a1eebfc4";
/** The fixture's path, relative to this file — the same directory in the tree and in the mirror. */
export const FIXTURE_NAME = "fenceText-v0.14.71.json";

/** The caps the corpus renders at. Typed, not imported: the two big bounds are private
 *  constants in their own modules and the test re-reads them, so drift fails an assertion
 *  rather than quietly leaving a caller uncovered. 50 is no caller's bound — it is the size at
 *  which a fence case can be read, and it carries the shape set: a fence run only has to be
 *  long enough to be a run to test the rule, and 3 and 4 are the lengths that exist. */
export const SMALL = 50;
export const REASON = 2_000; // handback's REASON_CLIP, publish-body's VERIFY_REASON_CLIP
export const FINDINGS = 20_000; // review-deps' three blocks and both lens-fix prompts
export const ISSUE = MAX_ISSUE_CHARS + ISSUE_TRUNCATION_MARKER.length + 1; // fencedIssueBody's

/** The bounds a real caller passes, and so the ones the golden must carry a straddling run at. */
export const PRODUCTION_BOUNDS: number[] = [REASON, FINDINGS, ISSUE];

const filler = (n: number): string => "abcdefghij".repeat(Math.ceil(n / 10)).slice(0, n);

/**
 * `git rev-parse --show-toplevel` for `dir`, or undefined where no work tree contains it.
 *
 * git's own discovery, so a worktree's `.git`-file counts as well as a clone's `.git` directory — a
 * hand-counted `..` walk does not, and a depth written out once silently stops firing the moment the
 * fixture moves.
 *
 * `unaskable` reports whether git itself could not be run (`spawnSync`'s `error`: no git on PATH, an
 * unresolvable cwd). "git refused to answer" is not "there is no work tree" and a guard must not
 * conflate them; `undefined` below is the second, and only the second means outside.
 */
function toplevel(dir: string): { top: string | undefined; unaskable: boolean } {
	try {
		const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: dir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (res.error !== undefined) return { top: undefined, unaskable: true };
		const top = res.stdout?.trim();
		return res.status === 0 && top !== ""
			? { top: resolve(top), unaskable: false }
			: { top: undefined, unaskable: false };
	} catch {
		return { top: undefined, unaskable: true };
	}
}

/**
 * Whether the recorder's own directory belongs to a checkout — which is what makes a run self-pinning.
 *
 * Run from inside the checkout, the recorder's renderer import beside these files resolves to this
 * checkout's own `fenceText` and the golden certifies the code that wrote it. So the question is asked
 * of the recorder's directory itself, never of "any `.git` above us": `--show-toplevel` names the work
 * tree `dir` lives in, and `ls-files -- .` then says whether that tree TRACKS anything under `dir`.
 * A recorder copied into a checkout — at any depth — sits beside tracked siblings and is refused. The
 * wrapper's mirror is a fresh `mktemp -d` nothing has ever committed, so it answers "nothing tracked"
 * and records.
 *
 * Tracking, rather than mere containment, is the distinction that has to be drawn on a host like this
 * one, where `$TMPDIR` is itself a git repo: every temp dir sits under *a* work tree there, so a
 * containment test refuses the wrapper's own run and then silently records no fixture — the exact
 * failure the review found. And it is asked of git, not by a hand-counted `..` walk, because the
 * answer must survive the fixture moving depth and because a worktree's `.git` is a file.
 *
 * Fails closed: git unaskable refuses. No proof of provenance means no recording.
 */
function recorderPathIsTracked(dir: string): boolean {
	const top = toplevel(dir);
	if (top.unaskable) return true;
	if (top.top === undefined) return false;
	// The pathspec is `.` because git resolves one against the cwd it was run in, which IS `dir`:
	// the query is "does this work tree track anything under the recorder's own directory".
	const tracked = runGit(dir, ["ls-files", "--", "."]);
	return tracked.unaskable || tracked.out !== "";
}

/** One git call, with the answer separated from "git could not be run". */
function runGit(dir: string, argv: string[]): { out: string; unaskable: boolean } {
	try {
		const res = spawnSync("git", argv, {
			cwd: dir,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return res.error !== undefined
			? { out: "", unaskable: true }
			: { out: res.status === 0 ? (res.stdout ?? "").trim() : "", unaskable: false };
	} catch {
		return { out: "", unaskable: true };
	}
}

/** The shapes one fence character takes, spelled identically for both of them so the two
 *  classes cannot drift apart: alone, in prose, ending exactly at the cut, and opening a
 *  block whose closer is the OTHER character — so within one case one delimiter reaches the
 *  render and the other never does, which is the claim the whole corpus rests on. Four
 *  shapes, at both 3 and 4: 3 is the shortest thing that is a fence run at all, and 4 is the
 *  length at which a closer can out-rank its opener, so a neutralisation that got either
 *  width wrong differs from the golden. */
function shapes(ch: string, other: string): string[] {
	const run = (n: number): string => ch.repeat(n);
	const close = other.repeat(3);
	return [
		run(3),
		run(4),
		`prose ${run(3)} more prose`,
		`prose ${run(4)} more prose`,
		`${filler(SMALL - 3)}${run(3)}`,
		`${filler(SMALL - 4)}${run(4)}`,
		["line one", run(3), "## INJ", other.repeat(4), "last"].join("\n"),
		[run(3), close, "## INJ", close].join("\n"),
	];
}

/**
 * v0.14.71 and v0.14.73 differ on two classes — a run of 3+ tildes, which v0.14.73 swapped
 * for U+02DC, and a backtick run the clip cuts, which it neutralised BEFORE the slice,
 * leaving look-alikes where v0.14.71 leaves a raw fragment. Both are spelled for each
 * character above, so a tilde case always has its backtick twin in the same position: that
 * twin is what makes "tildes survive" a decision rather than an omission, since a renderer
 * that neutralised nothing would pass the tilde cases alone.
 *
 * The three long inputs are `filler` at each production bound carrying a backtick run the cut
 * lands INSIDE. The straddling run is the one claim no short case can make, and the reason
 * those three are not filler alone: the two releases differ on whether a run is neutralised
 * before the slice or after it, and the only payloads where that order changes a byte are ones
 * whose run survives the cut as a raw fragment — a run sitting wholly inside, or wholly
 * outside, the window renders the same either way. Measured: with plain at-cap fillers there an
 * order-flipped renderer agrees with the golden on every input. Every other case sits at 50:
 * past 4 characters a run renders the way the same run at 4 does, because both releases either
 * swap a run of 3+ whole or leave it whole, so a longer run than the 3-and-4 pair re-asserts
 * nothing while costing its full length twice over, once in `input` and once in `output`.
 *
 * There is deliberately no long TILDE twin to these three. A run that starts at `max` sits
 * wholly past the clip, so it reaches neither render: the stored output carries no `~~~` and no
 * look-alike, and the case passes for a renderer that swaps tildes and for one that does not —
 * 40 KB to assert what the short tilde cases already assert. The straddling tildes that DO
 * reach a render are the two at 50 (`filler(46)` + a run, below).
 */
export const CASES: [string, number][] = [
	...shapes("~", "`").map((input): [string, number] => [input, SMALL]),
	...shapes("`", "~").map((input): [string, number] => [input, SMALL]),
	// Both characters in one line, in each order, and each opener straddling the cut: the
	// slice falls inside the run, where v0.14.71 leaves a raw two-character fragment and
	// v0.14.73 left look-alikes. The empty payload is the empty payload at any cap, so it
	// appears once — repeating it at the other three would be bytes without a claim.
	["mixed ~~~ and ``` in one line", SMALL],
	["mixed ``` and ~~~ in one line", SMALL],
	[`${filler(46)}\`\`\`\n~~~\n## INJ\n~~~`, SMALL],
	[`${filler(46)}~~~\n~~~\n## INJ\n~~~`, SMALL],
	["", SMALL],
	// The same two classes at the lengths real payloads arrive at: a build-log tail a
	// handback quotes, and an issue block a lens reviewer was handed.
	["a\n~~~\n## hidden\n~~~\nb", REASON],
	["a\n```\n## INJ\n```\nb", REASON],
	["~~~\n## INJ\n~~~", FINDINGS],
	["```\n## INJ\n```", FINDINGS],
	["~~~\n## INJ\n~~~", ISSUE],
	["```\n## INJ\n```", ISSUE],
	// One straddling backtick run per bound, which also carries the marker's presence on a
	// payload one character too long. `max - 2` is where a 3-run has to start to actually be
	// cut: at `max - 3` it ends on the bound and both orders neutralise it whole, so it asserts
	// what the short cases already do and costs its length twice.
	...PRODUCTION_BOUNDS.flatMap((max): [string, number][] => [[`${filler(max - 2)}\`\`\``, max]]),
];

/**
 * Records the golden. `render` is the release's own `fenceText`, handed in by the wrapper's copy
 * of the recorder — the one thing that keeps a recorded byte from being this checkout's byte.
 */
export function main(render: (s: string, max: number) => string, recordedFrom: string): void {
	// The guard the parameter alone cannot be, asserted on the run's own directory rather than on a
	// constant: the danger is where the recorder's renderer import resolves from, so a copy of this
	// file run from a path inside a checkout must refuse whatever this file happens to sit in.
	if (recorderPathIsTracked(recordedFrom)) {
		console.error(
			`golden-corpus.ts: refusing to record from inside the repository (${recordedFrom}).`,
			"From here the renderer is this checkout's own fenceText. Run generate-golden.sh.",
		);
		process.exit(1);
	}

	const fixture = join(import.meta.dirname, FIXTURE_NAME);
	const recorded: { input: string; max: number }[] | undefined = existsSync(fixture)
		? JSON.parse(readFileSync(fixture, "utf8")).inputs
		: undefined;
	// A re-record must not quietly follow a corpus edit: the set of inputs is what a reviewer
	// approved, and CASES above is the only place that set is stated.
	if (
		recorded !== undefined &&
		JSON.stringify(recorded.map((c) => [c.input, c.max])) !== JSON.stringify(CASES)
	) {
		console.error(
			`golden-corpus.ts: the committed fixture's inputs differ from CASES.`,
			`Confirm the new cases are wanted, then delete ${fixture} and run the wrapper again.`,
		);
		process.exit(1);
	}

	const golden = {
		source: `fenceText goldens captured from release tag ${BASE_TAG} (commit ${BASE_COMMIT}) by extension/smoke-tests/fixtures/lean-text-fence/generate-golden.sh, which runs that tag's own text-fence.ts over the corpus in golden-corpus.ts beside it. Strings are stored whole; the three long inputs are the ten-character filler repeated to a production cap and ending in a backtick run the clip cuts in half.`,
		base: {
			tag: BASE_TAG,
			commit: BASE_COMMIT,
			sha256: BASE_SHA256,
			file: "extension/src/lean/text-fence.ts",
		},
		inputs: CASES.map(([input, max]) => ({ input, max, output: render(input, max) })),
	};

	writeFileSync(fixture, `${JSON.stringify(golden, null, 1)}\n`);
	console.log(
		`wrote ${fixture}: ${String(golden.inputs.length)} inputs, ${String(readFileSync(fixture, "utf8").length)} bytes`,
	);
}
