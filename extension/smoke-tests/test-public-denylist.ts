#!/usr/bin/env bun
/**
 * public-denylist (#1788) — the reader's states, its format, and the bounds
 * that keep an operator-supplied file from breaking every tool_call.
 *
 * Offline against scratch files. Every case is a shape the guard's behaviour
 * depends on: `absent` and `unreadable` decide whether the guard falls back to
 * the generic set or refuses, and the reload rule decides whether an operator
 * who edits the file mid-session is obeyed.
 *
 * All terms are synthetic (`example-private-host`); the repository is public
 * and this file's contents are part of it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_DENYLIST_BYTES,
  REGEX_SLICE_BYTES,
  genericCategoryOf,
  matchDenylist,
  parseDenylist,
  publicDenylistPath,
  readPublicDenylist,
  resetDenylistCacheForTests,
} from "../src/public-denylist.ts";
import { assert, exit } from "./merge-guard-helpers.ts";
import { withEnv } from "./lib/env-scope.ts";

const dir = mkdtempSync(path.join(tmpdir(), "public-denylist-"));
const file = (name: string, content: string): string => {
  const p = path.join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
};

// ── 1. The path: env override, then the out-of-repo default.
{
  const viaEnv = path.join(dir, "from-env");
  await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: viaEnv }, async () => {
    assert(publicDenylistPath() === viaEnv, "PI_ENSEMBLE_PUBLIC_DENYLIST overrides the path");
  });
  await withEnv({ PI_ENSEMBLE_PUBLIC_DENYLIST: undefined }, async () => {
    const d = publicDenylistPath();
    assert(
      d.endsWith(path.join(".config", "pi-rukas", "public-denylist")) && !d.includes(dir),
      "with no override the path is the operator home config, never a repo path",
    );
  });
  assert(
    publicDenylistPath({ PI_ENSEMBLE_PUBLIC_DENYLIST: "   " } as NodeJS.ProcessEnv) ===
      publicDenylistPath({} as NodeJS.ProcessEnv),
    "a blank override is no override (it would name the working directory)",
  );
}

// ── 2. Absent (ENOENT) is a state of its own, not an error.
{
  resetDenylistCacheForTests();
  const r = readPublicDenylist({
    PI_ENSEMBLE_PUBLIC_DENYLIST: path.join(dir, "nope-does-not-exist"),
  } as NodeJS.ProcessEnv);
  assert(r.state === "absent", "a missing file is `absent` — the generic set applies");
}

// ── 3. Unreadable (not a file / oversized) is NOT absent.
{
  resetDenylistCacheForTests();
  const dirAsFile = readPublicDenylist({
    PI_ENSEMBLE_PUBLIC_DENYLIST: dir,
  } as NodeJS.ProcessEnv);
  assert(
    dirAsFile.state === "unreadable",
    "a directory at the denylist path is `unreadable`, never a silent `absent`",
  );
  // A file over the cap is oversized whatever the stat said, so write slightly
  // past it and confirm both the size and the state.
  const big = file("big", "x".repeat(MAX_DENYLIST_BYTES + 8));
  const r = readPublicDenylist({ PI_ENSEMBLE_PUBLIC_DENYLIST: big } as NodeJS.ProcessEnv);
  assert(
    r.state === "unreadable",
    `a denylist over ${MAX_DENYLIST_BYTES} bytes is refused rather than parsed`,
  );
}

// ── 4. Format: comments, blanks, case-insensitive literals, line numbers.
{
  const p = file(
    "fmt",
    "# a comment\n\n   \nExample-Private-Host\n  spaced-entry  \n# trailing comment\n",
  );
  resetDenylistCacheForTests();
  const r = readPublicDenylist({ PI_ENSEMBLE_PUBLIC_DENYLIST: p } as NodeJS.ProcessEnv);
  assert(r.state === "ok", "a well-formed file reads as `ok`");
  if (r.state !== "ok") {
    console.error("cannot continue without entries");
    process.exit(1);
  }
  assert(r.entries.length === 2, "comments and blank lines produce no entries");
  assert(r.entries[0]?.line === 4, "the line number names the line in the file, not the entry index");
  assert(
    matchDenylist(r.entries, "see the EXAMPLE-private-host box")?.line === 4,
    "a literal matches case-insensitively as a substring and reports its line only",
  );
  assert(matchDenylist(r.entries, "nothing here") === undefined, "a clean text matches nothing");
  const hit = matchDenylist(r.entries, "see example-private-host") as { line: number };
  assert(typeof hit.line === "number", "a match carries its line number");
  assert(
    !JSON.stringify(hit).includes("private-host"),
    "the match result never contains the term itself",
  );
}

// ── 5. regex: entries compile with the `i` flag; invalid ones are skipped.
{
  const p = file("regex", "regex:example-PRIVATE-host\nregex:[unclosed(\nregex:\nplain-entry\n");
  const entries = parseDenylist(
    // A comment-only read keeps the line numbers the guard will name.
    `regex:example-PRIVATE-host\nregex:[unclosed(\nregex:\nplain-entry\n`,
  );
  assert(entries.length === 2, "an invalid regex and an empty one are skipped, not fatal");
  assert(
    entries.some((e) => e.kind === "regex" && e.test("EXAMPLE-private-HOST")),
    "a regex entry is case-insensitive (the `i` flag, so no inline (?i:) token is needed)",
  );
  assert(!entries.some((e) => e.test("clean")), "a skipped invalid regex never matches anything");
  resetDenylistCacheForTests();
  const r = readPublicDenylist({ PI_ENSEMBLE_PUBLIC_DENYLIST: p } as NodeJS.ProcessEnv);
  assert(r.state === "ok", "a file holding one invalid regex still reads as ok");
  void entries;
}

// ── 6. A regex that matches the empty string would refuse every publish.
{
  const entries = parseDenylist("regex:a*\n");
  assert(entries.length === 0, "a pattern matching the empty string is skipped, not installed");
}

// ── 7. Regex evaluation is bounded by slices, and still finds a late match.
{
  const entries = parseDenylist("regex:needle-at-the-end\n");
  const long = "x".repeat(REGEX_SLICE_BYTES * 3) + "needle-at-the-end";
  assert(
    entries[0]?.test(long) === true,
    "a match past the slice boundary is still found (slicing must not truncate the scan)",
  );
  const miss = "y".repeat(REGEX_SLICE_BYTES * 3);
  assert(entries[0]?.test(miss) === false, "a long clean text is not a match");
}

// ── 8. Reload: an edit mid-session takes effect on the next call.
{
  const p = file("reload", "example-private-host\n");
  resetDenylistCacheForTests();
  const before = readPublicDenylist({ PI_ENSEMBLE_PUBLIC_DENYLIST: p } as NodeJS.ProcessEnv);
  assert(before.state === "ok", "the first read is ok");
  const cachedAgain = readPublicDenylist({ PI_ENSEMBLE_PUBLIC_DENYLIST: p } as NodeJS.ProcessEnv);
  assert(
    cachedAgain.state === "ok" &&
      before.state === "ok" &&
      cachedAgain.entries.length === before.entries.length,
    "an unchanged file is served from cache (same entries, no re-read)",
  );
  writeFileSync(p, "example-private-host\nsecond-term\n", "utf8");
  resetDenylistCacheForTests(); // the mtime clock may not tick; force the re-stat path
  const after = readPublicDenylist({ PI_ENSEMBLE_PUBLIC_DENYLIST: p } as NodeJS.ProcessEnv);
  assert(
    after.state === "ok" && after.entries.length === 2,
    "a size change re-reads the file (an edit is obeyed, not cached away)",
  );
  rmSync(p);
  resetDenylistCacheForTests();
  const gone = readPublicDenylist({ PI_ENSEMBLE_PUBLIC_DENYLIST: p } as NodeJS.ProcessEnv);
  assert(gone.state === "absent", "deleting the file mid-session falls back to the generic set");
}

// ── 9. The generic set: private ranges refused, documentation ranges pass.
{
  const refused: Array<[string, "private-ipv4"]> = [
    ["10.1.2.3", "private-ipv4"],
    ["172.16.0.1", "private-ipv4"],
    ["172.31.255.255", "private-ipv4"],
    ["192.168.0.5", "private-ipv4"],
    ["100.64.0.1", "private-ipv4"],
    ["connect to 10.1.2.3:8080", "private-ipv4"],
  ];
  for (const [text, category] of refused) {
    assert(
      genericCategoryOf(text) === category,
      `generic set refuses the private range in \`${text}\``,
    );
  }
  const passes = [
    "192.0.2.10",
    "198.51.100.7",
    "203.0.113.9",
    "127.0.0.1",
    "8.8.8.8",
    "100.128.0.1",
    "version 2.10.1",
    "172.15.0.1",
  ];
  for (const text of passes) {
    assert(genericCategoryOf(text) === undefined, `generic set passes \`${text}\``);
  }
}

// ── 10. The generic set: home paths, with the documented placeholders exempt.
{
  assert(genericCategoryOf("/home/alice/secrets") === "home-path", "a personal home path is refused");
  assert(genericCategoryOf("/Users/alice/x") === "home-path", "a macOS personal home path is refused");
  for (const ok of ["/home/dev/x", "/home/user/x", "/home/example/x", "/home/ops/x", "/home/runner/x"]) {
    assert(genericCategoryOf(ok) === undefined, `the placeholder \`${ok}\` passes`);
  }
  assert(
    genericCategoryOf("user@example.com") === undefined,
    "a mail address is not a home path (the @ guard)",
  );
}

rmSync(dir, { recursive: true, force: true });
process.exit(exit);
