#!/usr/bin/env bun
/**
 * #2160 — the develop brief's issue re-fetch is a `forge_read` read.
 *
 * The driver caches each active issue's body to a file and the brief points at
 * `cat <path>`, so the fetch line below is the FALLBACK: it runs on the cycle
 * where the cache is missing and tells the child how to get the acceptance
 * criteria. A developer child holds no forge login (`child-forge-env.ts` deleted
 * the five token vars and both config roots), so a fallback that says `gh issue
 * view` is a fallback to a call the child cannot make authenticated — it comes
 * back rate-limited, or refused on a private repo, and the child proceeds
 * without its DoD. The parent answers the same read through `forge_read`.
 *
 * The instruction that FORBIDS re-fetching is left naming the CLI it forbids:
 * naming the thing the child might otherwise run is the point of a prohibition,
 * and a prohibition cannot authenticate anything.
 *
 * The explore brief is NOT asserted here: the driver builds one `inlineExplorePrompt`
 * string for a PM-driven `/research` brief and a stripped explore child alike, so a
 * line added there cannot be gated on the role that set out to make it.
 */

import { inlineDevelopPrompt } from "../src/work-driver-prompts-early.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ws = {
  id: "task-a",
  scope: "Name the read path in the develop brief",
  paths: ["extension/src/work-driver-prompts-early.ts"],
  outOfScope: [],
};

/** The bare positional arguments every existing call site passes. */
const develop = (issues: number[], artifactPaths?: string[]): string =>
  inlineDevelopPrompt(issues, "/tmp/scratch", ws, "task-a", undefined, undefined, undefined, undefined, artifactPaths);

console.log("single issue:");
{
  const prompt = develop([2160]);
  assert(
    /forge_read[\s\S]*issue_view[\s\S]*2160/.test(prompt),
    `the re-fetch names forge_read with the issue_view verb and the number (${prompt.split("\n").find((l) => /re-fetch|issue_view|gh issue view/.test(l))?.slice(0, 140)})`,
  );
  assert(
    !/gh issue view 2160/.test(prompt),
    "the fallback no longer hands a credential-less child a gh read",
  );
}

console.log("multi issue:");
{
  const prompt = develop([2160, 2161]);
  assert(
    /forge_read/.test(prompt) && /issue_view/.test(prompt),
    "the multi-issue re-fetch is a forge_read read too",
  );
  assert(
    prompt.includes("#2160") && prompt.includes("#2161"),
    "every issue number is still named so the child knows which to fetch",
  );
  assert(
    !/gh issue view <N>/.test(prompt),
    `no \`gh issue view <N>\` line survives (${prompt.split("\n").find((l) => /gh issue view/.test(l))?.slice(0, 140)})`,
  );
}

console.log("the cached-artifact arm keeps its prohibition:");
{
  const cached = "/home/user/.pi/work-state/2160/issue-body.txt";
  const prompt = develop([2160], [cached]);
  assert(
    prompt.includes(`cat ${cached}`),
    "the child is still pointed at the driver-cached file",
  );
  assert(
    /Do NOT re-fetch/.test(prompt),
    "the prohibition on re-fetching is unchanged",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
