#!/usr/bin/env bun
/**
 * research-verify classification — the content-based driver-side
 * classification and verifyClaims integration, in isolation.
 *
 * Pins: an https URL the child labelled "code" is liveness-checked (content
 * wins over the child's label); compound sources split FIRST then classify
 * each part (best-part status mapping, all parts in verification.parts);
 * local paths stat-checked (never fetched); owner/repo @ ref → external-code
 * unchecked with the "external repo" reason; a doc reference matching no
 * rule is unchecked; the liveness cap marker (skipped-cap, distinct from
 * unchecked); and mixed-kind compounds (liveness parts decide when present,
 * else code/local parts decide).
 */

import type { ResearchClaim } from "../src/research-types.ts";
import { LIVENESS_URL_CAP, splitCompoundSource, verifyClaims } from "../src/research-verify.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function claim(over: Partial<ResearchClaim>): ResearchClaim {
  return {
    kind: "finding",
    text: "t",
    source: "https://a",
    sourceKind: "url",
    confidence: "medium",
    staleness: "stable",
    angle: "x",
    verification: { check: "none", status: "unchecked" },
    ...over,
  };
}

function verifyExecStub(grepHits: boolean): ExecFn {
  return async (cmd) => {
    if (cmd.startsWith("git rev-parse")) return { stdout: "abc1234def\n" };
    if (cmd.startsWith("git cat-file")) return { stdout: "" };
    if (cmd.startsWith("git grep")) {
      if (grepHits) return { stdout: "hit\n" };
      throw new Error("exit 1");
    }
    throw new Error(`unexpected: ${cmd}`);
  };
}

const statStubFor = (present: Set<string>) =>
  (async (p: string) => (present.has(p) ? { isDirectory: false } : undefined)) as never;

{
  const fetched: string[] = [];
  const fetchStub = (async (u: string) => {
    fetched.push(u);
    return { status: u.includes("dead") ? 404 : 200 };
  }) as never;

  // An https URL the child labelled "code" → liveness-checked, not grounded.
  const out = await verifyClaims(
    [
      claim({ source: "https://a/ok", sourceKind: "code" }),
      claim({ source: "https://a/dead; https://a/ok", sourceKind: "url" }),
      claim({ source: "/Users/janni/present.txt", sourceKind: "url" }),
      claim({ source: "/Users/janni/missing.txt", sourceKind: "url" }),
      claim({ source: "KnockOutEZ/wigolo @ main", sourceKind: "code" }),
      claim({
        source: "https://github.com/KnockOutEZ/wigolo/blob/main/src/a.ts",
        sourceKind: "code",
      }),
      claim({ source: "src/x.ts#resolveModel", sourceKind: "code" }),
      claim({ source: "src/x.ts (annotation)", sourceKind: "code" }),
      claim({ source: "lib@1.2 docs", sourceKind: "doc" }),
      claim({ source: "outputs/*.provenance.md", sourceKind: "code" }),
    ],
    "/r",
    verifyExecStub(false),
    fetchStub,
    {
      statFn: statStubFor(new Set(["/Users/janni/present.txt"])),
      pinnedSha: "abc1234def",
    },
  );
  const by = (src: string) => out.find((c) => c.source === src)?.verification;

  const urlAsCode = by("https://a/ok");
  assert(
    urlAsCode?.check === "url-liveness" && urlAsCode?.status === "live",
    "https URL labelled 'code' → liveness-checked live (content wins over the child's label)",
  );
  const compound = by("https://a/dead; https://a/ok");
  assert(
    compound?.check === "url-liveness" && compound?.status === "live",
    "compound dead+live → live (best-part mapping)",
  );
  assert(
    (compound as { parts?: { status: string }[] } | undefined)?.parts?.length === 2,
    "compound parts recorded in verification.parts",
  );
  const lp = by("/Users/janni/present.txt");
  assert(
    lp?.check === "local-file" && lp?.status === "local-present",
    "local path labelled 'url' → stat-checked local-present, never fetched",
  );
  const lm = by("/Users/janni/missing.txt");
  assert(
    lm?.check === "local-file" && lm?.status === "local-missing",
    "missing local path → local-missing",
  );
  const extRef = by("KnockOutEZ/wigolo @ main");
  assert(
    extRef?.check === "none" &&
      extRef?.status === "unchecked" &&
      (extRef as { reason?: string }).reason === "external repo",
    "owner/repo @ ref → external-code, unchecked with the 'external repo' reason (no URL formable from a bare ref)",
  );
  const extBlob = by("https://github.com/KnockOutEZ/wigolo/blob/main/src/a.ts");
  assert(
    extBlob?.check === "url-liveness" && extBlob?.status === "live",
    "github blob URL → external-code, liveness-checked as a URL",
  );
  const codeSym = by("src/x.ts#resolveModel");
  assert(
    codeSym?.check === "code-grounding" && codeSym?.status === "ungrounded",
    "code source grounded at the pinned commit (stub: grep no-match → ungrounded)",
  );
  const codeAnn = by("src/x.ts (annotation)");
  assert(
    codeAnn?.check === "code-grounding" && codeAnn?.status === "grounded",
    "path (annotation) parsed, path grounded at pinned commit (no symbol → grounded)",
  );
  const doc = by("lib@1.2 docs");
  assert(
    doc?.check === "none" && doc?.status === "unchecked",
    "unmatched doc reference → doc/none, unchecked",
  );
  const glob = by("outputs/*.provenance.md");
  assert(
    glob?.check === "none" && glob?.status === "unchecked",
    "unmatched glob → doc/none, unchecked (not code)",
  );
  assert(
    fetched.every((u) => u.startsWith("http")),
    "local paths never fetched (fetch stub saw only http URLs)",
  );
}

{
  // Mixed kinds: liveness parts decide when present, else code parts.
  const fetchStub = (async (u: string) => ({ status: u.includes("dead") ? 404 : 200 })) as never;
  const out = await verifyClaims(
    [
      claim({ source: "https://a/dead + /Users/janni/present.txt", sourceKind: "url" }),
      claim({ source: "/Users/janni/present.txt + src/x.ts", sourceKind: "url" }),
      claim({ source: "https://a/dead, src/x.ts", sourceKind: "url" }),
    ],
    "/r",
    verifyExecStub(false),
    fetchStub,
    { statFn: statStubFor(new Set(["/Users/janni/present.txt"])), pinnedSha: "abc1234def" },
  );
  const [mixed1, mixed2, mixed3] = out;
  assert(
    mixed1?.verification.check === "url-liveness" && mixed1?.verification.status === "dead",
    "mixed URL+local: the liveness part decides (dead)",
  );
  // "/Users/janni/present.txt + src/x.ts" now splits into two parts:
  // local (stat-checked → local-present) + code (grounded at pinned commit,
  // stub: cat-file succeeds, no symbol → grounded).
  // verifyClaims picks code first when no liveness parts exist.
  assert(
    mixed2?.verification.check === "code-grounding" && mixed2?.verification.status === "grounded",
    "local+code compound splits; code part decides (grounded in stub)",
  );
  assert(
    (mixed2?.verification as { parts?: { status: string }[] } | undefined)?.parts?.length === 2,
    "local+code compound: both parts recorded in verification.parts",
  );
  assert(
    mixed3?.verification.check === "url-liveness" && mixed3?.verification.status === "dead",
    "comma-split mixed compound → liveness part decides",
  );
}

{
  // The required fixture: `a.md (annotation) + src/x.ts#sym` must split.
  const parts = splitCompoundSource("a.md (annotation) + src/x.ts#sym");
  assert(parts.length === 2, `fixture splits into 2 parts (got ${parts.length})`);
  assert(parts[0] === "a.md (annotation)", "first part: doc with annotation");
  assert(parts[1] === "src/x.ts#sym", "second part: code with symbol");
}

{
  // Cap marker through verifyClaims: 61st unique URL → skipped-cap.
  const urls = Array.from({ length: LIVENESS_URL_CAP + 1 }, (_, i) => `https://a/${i}`);
  const sources = urls.map((u) => claim({ source: u, sourceKind: "url" }));
  const out = await verifyClaims(
    sources,
    "/r",
    verifyExecStub(false),
    (async () => ({ status: 200 })) as never,
    {
      pinnedSha: "abc1234def",
    },
  );
  const over = out[out.length - 1]?.verification;
  assert(
    over?.check === "none" && over?.status === "skipped-cap",
    "past-cap URL → skipped-cap, distinct from unchecked",
  );
  assert(out[0]?.verification.check === "url-liveness", "within-cap URLs still liveness-checked");
}

// --------------------------------------------------- git-unavailability safety

{
  // A rejecting exec (git missing / non-repo) must NOT throw out of
  // groundCodeSource or verifyClaims — the code claim stays unchecked and
  // the promise resolves.
  const rejectExec: ExecFn = async () => {
    throw new Error("spawn git ENOENT");
  };
  let threw = false;
  let out: import("../src/research-types.ts").ResearchClaim[] = [];
  try {
    out = await verifyClaims(
      [claim({ source: "src/x.ts#resolveModel", sourceKind: "code" })],
      "/r",
      rejectExec,
      undefined,
      { statFn: statStubFor(new Set()), pinnedSha: "abc1234def" },
    );
  } catch {
    threw = true;
  }
  assert(!threw, "verifyClaims resolves when the exec seam rejects (git unavailable)");
  assert(
    out[0]?.verification.check === "none" && out[0]?.verification.status === "unchecked",
    "a code claim whose git could not run is unchecked (never ungrounded, never a throw)",
  );

  // Containment: a sibling dir whose name shares the repoRoot prefix is NOT
  // inside the repo — it must classify local, not code.
  const { resolveSourcePart } = await import("../src/research-verify.ts");
  const sibling = resolveSourcePart("/a/b-evil/x.ts", "/a/b");
  assert(
    sibling.kind === "local" && sibling.localPath === "/a/b-evil/x.ts",
    "sibling dir /a/b-evil is local, not code (prefix containment uses path.sep)",
  );
  const inside = resolveSourcePart("/a/b/x.ts", "/a/b");
  assert(
    inside.kind === "code" && inside.path === "x.ts",
    "a path actually inside the repo still classifies code",
  );
}

// --------------------------------------------------- classification regressions

{
  // The per-run grounding memo: two claims citing the same (sha, path)
  // must not re-spawn git — duplicate citations share one memoized result.
  const catFileCallsByPath = new Map<string, number>();
  const memoExec: ExecFn = async (cmd) => {
    const m = cmd.match(/^git cat-file -e [0-9a-f]+:(.+)$/);
    if (m) {
      const p = JSON.parse(m[1] as string) as string;
      catFileCallsByPath.set(p, (catFileCallsByPath.get(p) ?? 0) + 1);
      return { stdout: "" };
    }
    if (cmd.startsWith("git grep")) return { stdout: "hit\n" };
    throw new Error(`unexpected: ${cmd}`);
  };
  const out = await verifyClaims(
    [
      claim({ source: "src/x.ts", sourceKind: "code" }),
      claim({ source: "src/x.ts", sourceKind: "code" }),
      claim({ source: "src/x.ts#resolveModel", sourceKind: "code" }),
    ],
    "/r",
    memoExec,
    (async () => ({ status: 200 })) as never,
    { statFn: statStubFor(new Set()), pinnedSha: "abc1234def" },
  );
  // The two bare src/x.ts claims share one git cat-file (the #-symbol claim
  // carries a different source string and grounds itself).
  assert(
    catFileCallsByPath.get("src/x.ts") === 2,
    `grounding memo: 2 identical src/x.ts claims share 1 cat-file, the #sym claim adds 1 (got ${catFileCallsByPath.get("src/x.ts")})`,
  );
  assert(
    out.every(
      (c) => c.verification.check === "code-grounding" && c.verification.status === "grounded",
    ),
    "memoized duplicate citations all grounded",
  );
}

{
  // Extensionless / bare-word shapes that real research claims carry:
  // `Makefile` (single-segment known filename) and `bin/pi-rukas`,
  // `extension/src` (multi-segment paths) classify as CODE, not doc.
  const { resolveSourcePart } = await import("../src/research-verify.ts");
  assert(resolveSourcePart("Makefile", "/r").kind === "code", "Makefile → code");
  assert(resolveSourcePart("bin/pi-rukas", "/r").kind === "code", "bin/pi-rukas → code");
  assert(resolveSourcePart("extension/src", "/r").kind === "code", "extension/src → code");
  assert(resolveSourcePart("Dockerfile", "/r").kind === "code", "Dockerfile → code");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
