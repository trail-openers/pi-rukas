/**
 * The no-leak property the #1788 guard exists to protect: a refusal tells the
 * agent WHERE a private term matched and never WHAT it was.
 *
 * Every other test in this family asserts the guard refuses. This one asserts
 * the refusal is safe to print, in the four places a matched term could escape:
 *
 * 1. the `reason` string returned to the agent;
 * 2. the `traceWarn` line, which is ungated stderr the headless console writer
 *    and the run transcript capture verbatim with no redaction in front of it
 *    (#1417 learned that the hard way with a merge refusal that quoted a held
 *    command — here the quoted text would be the secret itself);
 * 3. the structured verdict object, which a caller could log;
 * 4. the forge seam's thrown error (`forge.ts`'s `checkPublicText` →
 *    `PublicHygieneError`), which reaches a PR body or a handoff artifact.
 *
 * The synthetic terms are the ones the issue specifies. None is a real host,
 * address, or path, and the test never reads the operator's real denylist:
 * `PI_ENSEMBLE_PUBLIC_DENYLIST` is pinned to a temp file by every block.
 *
 * Run: bun run smoke-tests/test-public-hygiene-no-leak.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PublicHygieneError,
  publicTextRefusal,
  registerPublicHygieneGuard,
  resetPublicHygieneRegistrationForTests,
} from "../src/public-hygiene-guard.ts";
import {
  denylistRefusal,
  genericRefusal,
  unreadableRefusal,
} from "../src/public-hygiene-refusals.ts";
import {
  readPublicDenylist,
  resetDenylistCacheForTests,
  type DenylistRead,
} from "../src/public-denylist.ts";
import { withEnv } from "./lib/env-scope.ts";
import { assert, exit } from "./merge-guard-helpers.ts";

const dir = mkdtempSync(path.join(tmpdir(), "hygiene-no-leak-"));

/**
 * The terms, built from pieces. Assembled rather than literal so this FILE
 * cannot itself become a copy of the strings it is proving do not leak — the
 * public-hygiene guard reads its own denylist, and a real private host typed
 * into a tracked test file is exactly the leak under test.
 */
const TERMS: readonly string[] = [
  ["example", "private", "host"].join("-"),
  "10.1.2.3",
  ["/home/", "alice", "/work"].join(""),
  ["acme", "internal", "registry"].join("."),
];

const denylistPath = path.join(dir, "denylist");
writeFileSync(denylistPath, `${TERMS.join("\n")}\n`, "utf8");
const env = { PI_ENSEMBLE_PUBLIC_DENYLIST: denylistPath };

/** Every string a refusal could print, joined for one containment check. */
function leaks(haystack: string, label: string): void {
  for (const term of TERMS) {
    assert(!haystack.includes(term), `${label}: does not contain ${term.slice(0, 6)}…`);
  }
}

/** A denylist read that never touches the operator's own config. */
function deny(): DenylistRead {
  resetDenylistCacheForTests();
  return readPublicDenylist(env);
}

// ── 1. The pure text check: every term, every tier, no leak.
if (true) {
  await withEnv(env, async () => {
    const cases: readonly { label: string; text: string }[] = [
      { label: "issue body", text: `deploy to ${TERMS[0]} tonight` },
      { label: "pr title", text: `point the build at ${TERMS[1]}` },
      { label: "comment", text: `logs live in ${TERMS[2]}` },
      { label: "release notes", text: `pull from ${TERMS[3]}` },
    ];
    for (const c of cases) {
      const reason = publicTextRefusal(c.label, c.text, deny());
      assert(reason !== undefined, `${c.label}: refused`);
      if (reason === undefined) continue;
      leaks(reason, `${c.label}: refusal`);
      // The refusal must still be ACTIONABLE — a refusal that says nothing is a
      // refusal the agent cannot act on, which is how guards get disabled.
      assert(
        /line|category|private|denylist/i.test(reason),
        `${c.label}: refusal says what to look at`,
      );
      assert(
        reason.includes("PI_ENSEMBLE_PUBLIC_HYGIENE=0"),
        `${c.label}: refusal names the escape hatch`,
      );
    }
  });
}

// ── 2. The refusal constructors themselves.
if (true) {
  leaks(denylistRefusal({ location: "body", line: 7 }), "denylistRefusal");
  leaks(genericRefusal("commit message", "private-ipv4"), "genericRefusal(ipv4)");
  leaks(genericRefusal("issue body", "home-path"), "genericRefusal(home)");
  leaks(unreadableRefusal("body file", "EACCES"), "unreadableRefusal");
  const dl = denylistRefusal({ location: "body", line: 7 });
  assert(dl.includes("line 7"), "the denylist refusal names the denylist line");
  assert(dl.includes("body"), "and the surface it matched in");
}

// ── 3. The tool_call hook: the reason AND the trace line carry no term.
if (true) {
  await withEnv(env, async () => {
    resetPublicHygieneRegistrationForTests();
    resetDenylistCacheForTests();
    const handlers: ((e: unknown, c: unknown) => Promise<unknown>)[] = [];
    const pi = {
      on(event: string, fn: (e: unknown, c: unknown) => Promise<unknown>) {
        if (event === "tool_call") handlers.push(fn);
      },
    } as unknown as ExtensionAPI;
    registerPublicHygieneGuard(pi, {
      env,
      readDenylist: () => deny(),
    });
    // Capture stderr for the duration: `traceWarn` writes it ungated, and the
    // transcript is exactly where a leaked term would persist.
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    let reason = "";
    try {
      for (const h of handlers) {
        const r = (await h(
          { toolName: "bash", input: { command: `gh issue edit 9 --body "on ${TERMS[0]} now"` } },
          {},
        )) as { block?: boolean; reason?: string } | undefined;
        if (r?.block) reason = r.reason ?? "";
      }
    } finally {
      process.stderr.write = realWrite;
    }
    assert(reason !== "", "the hook blocked the publish");
    leaks(reason, "hook reason");
    leaks(written.join(""), "hook stderr / trace line");
    const traceLine = written.join("");
    assert(
      traceLine.includes("public-hygiene") && traceLine.includes("BLOCKED"),
      "the trace line records the block (so the guard is auditable)",
    );
    assert(
      /line=\d+/.test(traceLine) || /category=/.test(traceLine),
      "and it names a line number or a category rather than content",
    );
  });
}

// ── 4. The forge seam's error: it reaches a PR body or a handoff artifact.
if (true) {
  await withEnv(env, async () => {
    resetDenylistCacheForTests();
    let message = "";
    try {
      const refusal = publicTextRefusal("pull request body", `host ${TERMS[0]}`, deny());
      if (refusal === undefined) throw new Error("the seam did not refuse");
      throw new PublicHygieneError(refusal);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    assert(message !== "" && message !== "the seam did not refuse", "the seam threw");
    leaks(message, "PublicHygieneError message");
  });
}

// ── 5. The generic set's own refusal names a CATEGORY, never the matched text.
// These two strings are in the generic set but NOT in the denylist above: with a
// denylist present the private tier is consulted first, so a string in both
// would (correctly) be reported as a denylist line and never reach the category
// sentence. Asserting the category sentence therefore needs category-only input.
if (true) {
  await withEnv(env, async () => {
    resetDenylistCacheForTests();
    for (const text of [`server 100.64.0.9`, `/home/alice/x.log`]) {
      const reason = publicTextRefusal("issue body", text, deny());
      assert(reason !== undefined, `generic tier: ${text.slice(0, 12)}… refused`);
      if (reason === undefined) continue;
      leaks(reason, "generic refusal");
      assert(
        /private network address|home directory/.test(reason),
        "and names the category it matched",
      );
    }
  });
}

// ── 6. A refusal never quotes the surface it read, even on an unreadable path.
if (true) {
  await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: path.join(dir, "no-such-file") }, async () => {
    resetDenylistCacheForTests();
    const reason = publicTextRefusal("issue body", `text with ${TERMS[0]} in it`, deny());
    assert(reason !== undefined, "an unreadable denylist refuses rather than passing");
    if (reason === undefined) return;
    leaks(reason, "unreadable-denylist refusal");
  });
}

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
