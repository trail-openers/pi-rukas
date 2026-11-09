/**
 * The scripted-executor fixtures the merge-time protected-path tests share.
 *
 * Split out of `test-merge-protected-paths.ts` when the pinned-OID arms were
 * added (the 500-line cap, AGENTS.md §12): the two files drive the same
 * function with the same fakes, and a copy of the fixtures in each would mean a
 * drift in one and not the other — which is precisely the class of vacuous-fake
 * bug the fixtures exist to prevent (an unmatched call throws rather than
 * returning an empty change set, so a command-shape change fails loudly).
 */

import type { DriverContext } from "../../src/work-driver-context.ts";

export const CI = ".github/workflows/ci.yml";
export const BASE_SHA = "b".repeat(40);
export const HEAD_SHA = "a".repeat(40);
export const MAIN_SHA = "c".repeat(40);
/** A head that arrived after the caller pinned its own — the TOCTOU candidate. */
export const LATE_SHA = "d".repeat(40);

export type Call = { line: string; argv: string[] };
export type ScriptedExec = NonNullable<DriverContext["verifyExecFn"]>;

/** A NUL-separated `diff -z --name-status` stream for the given records. */
export function nameStatus(...records: string[]): string {
  return `${records.map((r) => r.split(" ").join("\0")).join("\0")}\0`;
}

/**
 * A scripted executor. `routes` are matched in order against the joined
 * `cmd argv` line; the first match answers. Unmatched calls throw, so a read
 * that issues a command nobody scripted is a failure, not an empty answer.
 */
export function scripted(
  routes: Array<[RegExp, string | (() => { stdout: string } | Promise<never>)]>,
): { exec: ScriptedExec; calls: Call[] } {
  return scriptedFn((line) => {
    for (const [re, answer] of routes) {
      if (re.test(line)) {
        return typeof answer === "string" ? { stdout: answer } : (answer() as { stdout: string });
      }
    }
    return undefined;
  });
}

/**
 * A scripted executor whose answers are chosen per CALL, so an arm can make a
 * ref answer differently on a later read (the moving-ref case) or count calls.
 * An unmatched call throws rather than answering empty.
 */
export function scriptedFn(
  route: (line: string, n: number) => { stdout: string } | undefined,
): { exec: ScriptedExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec = (async (cmd: string, opts?: { argv?: string[] }) => {
    const argv = opts?.argv ?? [];
    const line = [cmd, ...argv].join(" ");
    const n = calls.push({ line, argv }) - 1;
    const answer = route(line, n);
    if (!answer) throw new Error(`unscripted call: ${line}`);
    return answer;
  }) as ScriptedExec;
  return { exec, calls };
}

/**
 * The reads the branch form makes, scripted for one diff answer: fetch, resolve
 * both refs, take the merge base of those two OIDs, diff `<mb>..<head>`.
 */
export function readRoutes(
  diff: string,
  opts: { mergeBase?: string } = {},
): Array<[RegExp, string | (() => { stdout: string } | Promise<never>)]> {
  return [
    [/^git remote/, () => ({ stdout: "origin\n" })],
    [/^git config --get remote/, () => ({ stdout: "https://x.invalid/r.git\n" })],
    [/^git symbolic-ref/, () => ({ stdout: "origin/main\n" })],
    [/^git fetch/, () => ({ stdout: "" })],
    [/^git rev-parse --end-of-options origin\/feature/, () => ({ stdout: `${HEAD_SHA}\n` })],
    [/^git rev-parse --end-of-options origin\/main/, () => ({ stdout: `${MAIN_SHA}\n` })],
    [/^git merge-base/, () => ({ stdout: `${opts.mergeBase ?? BASE_SHA}\n` })],
    [/^git -c .*diff -z/, () => ({ stdout: diff })],
  ];
}

/**
 * The moving-ref fixture: a `<remote>/<branch>` that answers HEAD_SHA on its
 * first resolve and LATE_SHA on every later one, a merge base that only exists
 * between the PINNED head and the resolved mainline, and a diff answered per the
 * range actually asked for (the clean head has no protected file; the moved
 * commit has one). A read that re-resolves the ref instead of using the pin
 * therefore produces a range and a change set no reviewer ever saw.
 */
export function movingRefFixture(opts: { clean: boolean }): {
  exec: ScriptedExec;
  calls: Call[];
} {
  let headReads = 0;
  return scriptedFn((line) => {
    if (/^git remote$/.test(line)) return { stdout: "origin\n" };
    if (/^git config --get remote/.test(line)) return { stdout: "https://x.invalid/r.git\n" };
    if (/^git symbolic-ref/.test(line)) return { stdout: "origin/main\n" };
    if (/^git fetch/.test(line)) return { stdout: "" };
    if (/^git rev-parse --end-of-options origin\/feature/.test(line)) {
      headReads++;
      // Only a read that should not have happened sees the moved value: the
      // first resolve is the fetch's own, which legitimately sees what the
      // remote holds now.
      return { stdout: `${headReads === 1 ? HEAD_SHA : LATE_SHA}\n` };
    }
    if (/^git rev-parse --end-of-options origin\/main/.test(line))
      return { stdout: `${MAIN_SHA}\n` };
    if (/^git merge-base/.test(line)) {
      // The range's ends are the evidence: the first argument is whatever the
      // read believes the head to be, so a read that re-resolved a moved ref
      // names the late commit here — and gets a base off it, which moves the
      // whole range off the reviewed commits.
      const last = line.trim().split(/\s+/).slice(-2).join(" ");
      return { stdout: last === `${HEAD_SHA} ${MAIN_SHA}` ? `${BASE_SHA}\n` : `${LATE_SHA}\n` };
    }
    if (/^git -c .*diff -z/.test(line)) {
      // Answer the range that was actually asked for: the clean pinned head has
      // no protected file, the late commit does. A read that drifted off the pin
      // reports a protected path the PR does not contain.
      const range = line.trim().split(/\s+/).slice(-1)[0] ?? "";
      return {
        stdout:
          range === `${BASE_SHA}..${HEAD_SHA}`
            ? opts.clean
              ? ""
              : nameStatus(`M ${CI}`)
            : nameStatus(`M ${CI}`),
      };
    }
    return undefined;
  });
}
