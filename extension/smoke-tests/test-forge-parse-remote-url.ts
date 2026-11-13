#!/usr/bin/env bun
/**
 * #609 / #2257 — `parseRemoteUrl`: the remote-URL parser behind every forge
 * read in the driver.
 *
 * Split from `test-forge-detect.ts` (AGENTS.md §12 line cap) along the seam
 * between the parser and the classifier: this file pins what a URL yields,
 * that one what `detectForge` decides from it. Fully offline by construction —
 * the parser is a pure function over a string.
 *
 * Harness pattern: pinned literals, no framework (test-clip-title.ts shape).
 */

import { MAX_SEGMENTS, MIN_SEGMENTS, parseRemoteUrl } from "../src/forge-detect.ts";
import { isSegment, parseRepoIdentity } from "../src/plan-target.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq<T>(actual: T, expected: T, msg: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, `${msg} — got ${a}${a === e ? "" : `, expected ${e}`}`);
}

// ======================================================================
// parseRemoteUrl — the 4 URL forms from the spec
// ======================================================================

console.log("\n--- parseRemoteUrl ---");

eq(
  parseRemoteUrl("git@github.com:owner/repo.git"),
  { host: "github.com", path: ["owner", "repo"] },
  "github.com SSH scp-style",
);
eq(
  parseRemoteUrl("https://github.com/owner/repo.git"),
  { host: "github.com", path: ["owner", "repo"] },
  "github.com HTTPS with .git",
);
eq(
  parseRemoteUrl("https://github.com/owner/repo"),
  { host: "github.com", path: ["owner", "repo"] },
  "github.com HTTPS without .git",
);
eq(
  parseRemoteUrl("git@gitlab.com:owner/repo.git"),
  { host: "gitlab.com", path: ["owner", "repo"] },
  "gitlab.com SSH scp-style",
);
eq(
  parseRemoteUrl("https://gitlab.com/owner/repo"),
  { host: "gitlab.com", path: ["owner", "repo"] },
  "gitlab.com HTTPS",
);
eq(
  parseRemoteUrl("ssh://git@mygitlab.example.com:2222/owner/repo.git"),
  { host: "mygitlab.example.com", path: ["owner", "repo"] },
  "ssh:// with user and non-standard port",
);
eq(
  parseRemoteUrl("ssh://gitlab.example.com/owner/repo"),
  { host: "gitlab.example.com", path: ["owner", "repo"] },
  "ssh:// without user",
);
eq(
  parseRemoteUrl("ssh://git@HOST:2222/owner/repo"),
  { host: "host", path: ["owner", "repo"] },
  "ssh://git@HOST:2222 (spec example, host lowercased)",
);
eq(
  parseRemoteUrl("git://github.com/owner/repo.git"),
  { host: "github.com", path: ["owner", "repo"] },
  "git:// scheme",
);

// Fail-closed: unparseable inputs
eq(parseRemoteUrl(""), undefined, "empty string → undefined");
eq(parseRemoteUrl("not a url"), undefined, "garbage → undefined");
eq(parseRemoteUrl("https://github.com"), undefined, "https with no path → undefined");
eq(parseRemoteUrl("git@github.com:owner"), undefined, "scp-style with no /owner/repo → undefined");

// ======================================================================
// parseRemoteUrl — a GitLab namespace path of any depth (#2257)
//
// The docs (`docs/headless.md`, `docs/troubleshooting.md`) promise that a
// self-hosted remote under a subgroup parses to its host. Each shape below
// is one URL form the parser handles as its own branch, so each gets a row.
// ======================================================================

console.log("\n--- parseRemoteUrl: GitLab subgroup path ---");

const SUBGROUP = ["group", "sub", "project"];

eq(
  parseRemoteUrl("https://gitlab.example.com/group/sub/project.git"),
  { host: "gitlab.example.com", path: SUBGROUP },
  "https:// subgroup parses to host + full namespace path",
);
eq(
  parseRemoteUrl("ssh://git@gitlab.example.com:2222/group/sub/project.git"),
  { host: "gitlab.example.com", path: SUBGROUP },
  "ssh:// with user and port parses a subgroup path",
);
eq(
  parseRemoteUrl("git@gitlab.example.com:group/sub/project.git"),
  { host: "gitlab.example.com", path: SUBGROUP },
  "scp-style subgroup parses",
);
eq(
  parseRemoteUrl("git://gitlab.example.com/group/sub/project.git"),
  { host: "gitlab.example.com", path: SUBGROUP },
  "git:// scheme parses a subgroup path",
);
eq(
  parseRemoteUrl("https://gitlab.example.com/a/b/c/d/e"),
  { host: "gitlab.example.com", path: ["a", "b", "c", "d", "e"] },
  "five segments is the deepest accepted path",
);
eq(
  parseRemoteUrl("https://gitlab.example.com/a/b/c/d/e/f"),
  undefined,
  "six segments is past the bound → undefined",
);
eq(
  parseRemoteUrl("https://gitlab.example.com/a"),
  undefined,
  "a single segment is not a repository path",
);
eq(
  parseRemoteUrl("https://gitlab.example.com/../etc/passwd"),
  undefined,
  "a traversal path → undefined",
);
eq(
  parseRemoteUrl("https://gitlab.example.com/group/../project"),
  undefined,
  "an interior `..` segment → undefined",
);
eq(
  parseRemoteUrl("https://gitlab.example.com/group//project"),
  undefined,
  "an empty segment from a doubled slash → undefined",
);
eq(
  parseRemoteUrl("https://gitlab.example.com/group/pro ject"),
  undefined,
  "a segment outside the path grammar → undefined",
);

console.log("\n--- parseRemoteUrl: GitHub stays two segments ---");

eq(
  parseRemoteUrl("https://github.com/owner/repo/extra"),
  undefined,
  "github.com with three segments → undefined (a deep GitHub path is no repository)",
);
eq(
  parseRemoteUrl("https://gitlab.example.com/group/sub/project", "github"),
  undefined,
  "a caller that knows the forge gets the depth rule it asked for",
);
eq(
  parseRemoteUrl("git@github.com:group/sub/project.git", "gitlab"),
  undefined,
  "…but a caller CANNOT lift the `owner/repo` bound off a github.com URL: the argument asserts the site, and github.com serves no repository at a deeper path, so a mislabelled GitHub remote yields no slug for the visibility lookup to read as 'private, skip the scan'",
);
eq(
  parseRemoteUrl("git@github.com:group/sub/project.git"),
  undefined,
  "…and the unqualified parse refuses the same URL",
);
eq(
  parseRemoteUrl("git@github.com:owner/repo.git", "gitlab"),
  { host: "github.com", path: ["owner", "repo"] },
  "a two-segment github.com URL still parses however the caller labels the forge",
);

console.log("\n--- parseRemoteUrl: a trailing separator after `.git` ---");

// git itself tolerates and rewrites these, and they survive a copy-pasted remote
// URL. The separators are stripped before the `.git` suffix, so the last segment
// is `project` — a slug carrying `project.git` names no repository and would be
// handed to the forge CLI, the hygiene target and the plan identity alike.
eq(
  parseRemoteUrl("https://gitlab.example.com/group/sub/project.git/"),
  { host: "gitlab.example.com", path: SUBGROUP },
  "a subgroup path ending `.git/` still yields `project`, not `project.git`",
);
eq(
  parseRemoteUrl("git@github.com:owner/repo.git/"),
  { host: "github.com", path: ["owner", "repo"] },
  "…same for a two-segment GitHub URL",
);
eq(
  parseRemoteUrl("https://gitlab.example.com/a/b/c/d/e.git///"),
  { host: "gitlab.example.com", path: ["a", "b", "c", "d", "e"] },
  "…and for the deepest accepted path with several trailing separators",
);

console.log("\n--- the parser and the plan identity agree on a path segment ---");

// `forge-detect.ts` imports the segment grammar from `plan-target.ts` rather than
// restating it, so the two surfaces cannot disagree about what the same namespace
// string is: a segment the remote parser accepts and the identity rules refuse
// would be a repository a clone has a remote for and cannot name as a target.
// Every row is a path the parser must ACCEPT — a refusal on either side of a
// rejected string is agreement about nothing.
for (const s of ["x", "a.b", "proj.git", "pro_ject", "P1"]) {
  eq(
    parseRemoteUrl(`https://gitlab.example.com/group/${s}`)?.path,
    ["group", s.replace(/\.git$/i, "")],
    `the parser accepts a segment the identity rules accept: ${JSON.stringify(s)}`,
  );
  eq(
    isSegment(s),
    parseRepoIdentity(`gitlab.example.com/group/${s}`)?.segments.at(-1) === s,
    `…and both surfaces share one grammar for it: ${JSON.stringify(s)}`,
  );
}
for (const s of ["a b", "a%2Fb", "-", "", "-x", ".hidden"]) {
  eq(
    parseRemoteUrl(`https://gitlab.example.com/group/${s}`),
    undefined,
    `a segment the grammar refuses is refused by the parser too: ${JSON.stringify(s)}`,
  );
}

// The bound the docs state is the bound the parser has. `test-forge-subgroup-docs`
// pins the prose to these constants; this pins the parser's own behaviour at the
// boundary, so neither can drift from the other silently.
eq(
  parseRemoteUrl(`https://gitlab.example.com/${Array.from({ length: MAX_SEGMENTS }, (_, i) => `s${i}`).join("/")}`) !== undefined,
  true,
  `the deepest accepted path is MAX_SEGMENTS (${MAX_SEGMENTS})`,
);
eq(
  parseRemoteUrl(`https://gitlab.example.com/${Array.from({ length: MAX_SEGMENTS + 1 }, (_, i) => `s${i}`).join("/")}`),
  undefined,
  `one past it (${MAX_SEGMENTS + 1}) is refused`,
);
eq(
  parseRemoteUrl("https://gitlab.example.com/only-one"),
  undefined,
  `below MIN_SEGMENTS (${MIN_SEGMENTS}) is refused`,
);
console.log(`\nexit ${exit}`);
process.exit(exit);
