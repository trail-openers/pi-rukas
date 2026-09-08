/**
 * test-forge-mapping-shapes.ts — pure mapper behaviour for the forge
 * adapter (S2 of epic #608), split out of test-forge-gitlab.ts /
 * test-forge-github.ts at the 500-line seam (AGENTS.md §12).
 *
 * Covers the SHARED parsing/mapping primitives that don't belong to one
 * forge's path:
 *   - `parsePrNumberFromResponse`: plain-URL vs JSON tolerance, and the
 *     anchor/whitespace capture rule (the URL must NOT carry a `#fragment`)
 *   - `mapGlIssue`: required-field failure (missing iid)
 *   - `mapGlMr`: field normalisation
 *   - `mapGlPipelineJobs`: status uppercasing
 *   - `mapGlRepo`: merge-method boolean derivation
 *
 * Run: cd extension && bun run smoke-tests/test-forge-mapping-shapes.ts
 */

import {
  mapGlIssue,
  mapGlMr,
  mapGlPipelineJobs,
  mapGlRepo,
  parsePrNumberFromResponse,
} from "../src/forge-mapping.ts";
import { GL_JOBS, GL_MR, GL_PROJECT } from "./forge-fixtures.ts";

let exitCode = 0;
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok: ${name}`))
    .catch((e) => {
      console.error(`  FAIL: ${name} — ${e?.message ?? e}`);
      exitCode = 1;
    });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  // ── parsePrNumberFromResponse: shape + capture rules ───────────────────
  console.log("parsePrNumberFromResponse:");
  await check("issue URL capture stops at a #anchor fragment", () => {
    const parsed = parsePrNumberFromResponse(
      "see https://gitlab.com/acme/widget/-/issues/42#discussion_r123 for details",
    );
    assert(parsed !== undefined, "parsed");
    assert(parsed!.number === 42, `number ${parsed!.number}`);
    assert(
      parsed!.url === "https://gitlab.com/acme/widget/-/issues/42",
      `url must stop at # (got ${parsed!.url})`,
    );
  });
  await check("plain URL: gh issue (no anchor)", () => {
    const parsed = parsePrNumberFromResponse("https://github.com/acme/widget/issues/42\n");
    assert(parsed !== undefined && parsed.number === 42, `got ${JSON.stringify(parsed)}`);
    assert(parsed!.url === "https://github.com/acme/widget/issues/42", `url ${parsed!.url}`);
  });
  await check("plain URL: gl merge request (no anchor)", () => {
    const parsed = parsePrNumberFromResponse("https://gitlab.com/acme/widget/-/merge_requests/17\n");
    assert(parsed !== undefined && parsed.number === 17, `got ${JSON.stringify(parsed)}`);
    assert(parsed!.url === "https://gitlab.com/acme/widget/-/merge_requests/17", `url ${parsed!.url}`);
  });
  await check("JSON payload: number + web_url (GitLab)", () => {
    const parsed = parsePrNumberFromResponse(
      JSON.stringify({ iid: 42, web_url: "https://gitlab.com/o/r/-/issues/42" }),
    );
    assert(parsed !== undefined && parsed.number === 42, `got ${JSON.stringify(parsed)}`);
    assert(parsed!.url === "https://gitlab.com/o/r/-/issues/42", `url ${parsed!.url}`);
  });
  await check("JSON payload: number + url (GitHub)", () => {
    const parsed = parsePrNumberFromResponse(
      JSON.stringify({ number: 17, url: "https://github.com/o/r/pull/17" }),
    );
    assert(parsed !== undefined && parsed.number === 17, `got ${JSON.stringify(parsed)}`);
    assert(parsed!.url === "https://github.com/o/r/pull/17", `url ${parsed!.url}`);
  });
  await check("garbage (neither URL nor JSON) → undefined", () => {
    const parsed = parsePrNumberFromResponse("some other output\n");
    assert(parsed === undefined, `got ${JSON.stringify(parsed)}`);
  });

  // ── Direct mappers (pure functions) ────────────────────────────────────
  console.log("mappers:");
  await check("mapGlIssue throws on missing iid", () => {
    try {
      mapGlIssue({ title: "x", description: "y", state: "opened", web_url: "u" } as Record<
        string,
        unknown
      >);
      throw new Error("should have thrown");
    } catch (e) {
      assert((e as Error).message.includes("iid"), `wrong error: ${(e as Error).message}`);
    }
  });
  await check("mapGlMr normalizes", () => {
    const mr = mapGlMr(GL_MR as Record<string, unknown>);
    assert(mr.number === 17, "number");
    assert(mr.headRefName === "feature/issue-17-x", "head");
    assert(mr.baseRefName === "main", "base");
    assert(mr.state === "OPEN", "state");
  });
  await check("mapGlPipelineJobs uppercases status", () => {
    const jobs = mapGlPipelineJobs(GL_JOBS as unknown);
    assert(jobs[0]!.state === "SUCCESS", `state ${jobs[0]!.state}`);
  });
  await check("mapGlRepo derives squash from method", () => {
    const r = mapGlRepo(GL_PROJECT as Record<string, unknown>);
    assert(r.squashMergeAllowed === true, "squash");
    assert(r.mergeCommitAllowed === false, "merge");
  });

  console.log("");
  if (exitCode !== 0) {
    console.error("FAILURES — see above");
    process.exit(1);
  }
  console.log("All forge-mapping-shapes tests passed.");
}

main().catch((e) => {
  console.error("unhandled:", e);
  process.exit(1);
});
