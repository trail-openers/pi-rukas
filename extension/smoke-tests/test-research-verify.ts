#!/usr/bin/env bun
/**
 * research-verify — the deterministic verification layer, in isolation.
 *
 * Pins: liveness classes (bot-filter 403/429/405 = unreachable, NEVER dead;
 * a thrown fetch = unreachable), the URL cap and dedupe, content-based
 * driver-side classification (an https URL the child labelled "code" is
 * liveness-checked; a local path is stat-checked, never fetched; an
 * external repo is never grounded against the local tree; a doc reference
 * matching no rule is unchecked and does NOT count as verified), compound
 * source splitting (split first, then classify each part; the claim status
 * is the mapping live > unreachable > dead over the liveness parts,
 * skipped-cap never promotes; all parts recorded in verification.parts),
 * code grounding against the pinned commit (path present in the tree via
 * git cat-file; symbol present IN THAT FILE at that commit via
 * path-scoped git grep; an unknown sha degrades to unchecked, never
 * ungrounded), local-file stat checks (present → local-present, missing
 * → local-missing, directory → local-present), and the abstention
 * predicate (a doc-sourced claim with no passing check does NOT count;
 * local-present does).
 */

import type { ResearchClaim } from "../src/research-types.ts";
import {
  LIVENESS_URL_CAP,
  aggregateLivenessStatuses,
  checkLocalFile,
  checkUrlLiveness,
  classifyLiveness,
  entailableClaims,
  groundCodeSource,
  isVerifiedFinding,
  parseCodeSource,
  pinnedCommit,
  splitCompoundSource,
  verifyClaims,
} from "../src/research-verify.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------------------ liveness

{
  assert(classifyLiveness(200) === "live", "200 → live");
  assert(classifyLiveness(301) === "live", "3xx → live (redirects followed)");
  assert(classifyLiveness(404) === "dead", "404 → dead");
  assert(classifyLiveness(410) === "dead", "410 → dead");
  assert(classifyLiveness(500) === "dead", "500 → dead");
  assert(classifyLiveness(403) === "unreachable", "403 bot-filter → unreachable, not dead");
  assert(classifyLiveness(429) === "unreachable", "429 rate-limit → unreachable, not dead");
  assert(classifyLiveness(405) === "unreachable", "405 method-rejected → unreachable, not dead");
}

{
  const calls: string[] = [];
  const fetchStub = async (url: string) => {
    calls.push(url);
    if (url.includes("dead")) return { status: 404 };
    if (url.includes("bot")) return { status: 403 };
    if (url.includes("boom")) throw new Error("network");
    return { status: 200 };
  };
  const m = await checkUrlLiveness(
    ["https://a/ok", "https://a/ok", "https://a/dead", "https://a/bot", "https://a/boom"],
    fetchStub as never,
  );
  assert(calls.length === 4, `dedupe: 5 inputs, ${calls.length} fetches (unique only)`);
  assert(m.get("https://a/ok") === "live", "live classed");
  assert(m.get("https://a/dead") === "dead", "dead classed");
  assert(m.get("https://a/bot") === "unreachable", "bot-filter classed unreachable");
  assert(m.get("https://a/boom") === "unreachable", "thrown fetch classed unreachable");

  // Cap: past-cap URLs are recorded in the map as skipped-cap (distinct
  // from absent/unchecked), and only the cap-many are fetched.
  const many = Array.from({ length: LIVENESS_URL_CAP + 10 }, (_, i) => `https://a/${i}`);
  const fetchCalls: string[] = [];
  const capped = await checkUrlLiveness(many, (async (u: string) => {
    fetchCalls.push(u);
    return { status: 200 };
  }) as never);
  assert(fetchCalls.length === LIVENESS_URL_CAP, `cap: exactly ${LIVENESS_URL_CAP} fetches`);
  assert(capped.size === LIVENESS_URL_CAP + 10, `cap: map records ALL inputs (${capped.size})`);
  let skipped = 0;
  for (const [, s] of capped) if (s === "skipped-cap") skipped++;
  assert(
    skipped === 10,
    `cap: ${skipped} past-cap URLs marked skipped-cap (not absent, not unchecked)`,
  );
  assert(
    capped.get(`https://a/${LIVENESS_URL_CAP}`) === "skipped-cap",
    "first past-cap URL → skipped-cap",
  );
  assert(capped.get("https://a/0") === "live", "within-cap URL checked as before");
}

// -------------------------------------------------------- compound status

{
  assert(aggregateLivenessStatuses(["dead", "live"]) === "live", "live + dead → live");
  assert(
    aggregateLivenessStatuses(["dead", "unreachable"]) === "unreachable",
    "dead + unreachable → unreachable (absence of an answer is not death)",
  );
  assert(aggregateLivenessStatuses(["dead"]) === "dead", "all dead → dead");
  assert(
    aggregateLivenessStatuses(["skipped-cap"]) === "skipped-cap",
    "skipped-cap alone never promotes",
  );
  assert(
    aggregateLivenessStatuses(["skipped-cap", "dead"]) === "dead",
    "skipped-cap does not promote a dead claim",
  );
}

// ------------------------------------------------------- code grounding

interface GroundBehavior {
  catFileOk: string[]; // paths present at the pinned commit
  grep: (symbol: string, sha: string, path: string) => "hits" | "no-match" | "throw-other";
}

function groundExecStub(behavior: GroundBehavior): ExecFn {
  const fn: ExecFn & { seen?: string[] } = async (cmd) => {
    fn.seen?.push(cmd);
    if (cmd.startsWith("git rev-parse")) return { stdout: "abc1234def\n" };
    const cat = cmd.match(/^git cat-file -e ([0-9a-f]+):(.+)$/);
    if (cat) {
      const p = JSON.parse(cat[2] as string) as string;
      if (behavior.catFileOk.includes(p)) return { stdout: "" };
      throw new Error("exit 1");
    }
    const grep = cmd.match(/^git grep -F -e (.+) ([0-9a-f]+) -- (.+)$/);
    if (grep) {
      const symbol = JSON.parse(grep[1] as string) as string;
      const sha = grep[2] as string;
      const p = JSON.parse(grep[3] as string) as string;
      const r = behavior.grep(symbol, sha, p);
      if (r === "hits") return { stdout: "match\n" };
      if (r === "no-match") throw new Error("exit 1");
      throw new Error("fatal: not a git repository");
    }
    throw new Error(`unexpected: ${cmd}`);
  };
  fn.seen = [];
  return fn;
}

const fnSeen = (fn: ExecFn) => (fn as ExecFn & { seen?: string[] }).seen ?? [];

{
  const ok = groundExecStub({
    catFileOk: ["src/x.ts", "src/a.ts", "src/b.ts", "ext/src/y.ts"],
    grep: (sym, _sha, p) => (p === "src/x.ts" && sym === "resolveModel" ? "hits" : "no-match"),
  });
  assert(
    (await groundCodeSource(ok, "/r", "src/x.ts#resolveModel", "abc1234def")) === "grounded",
    "path present at sha + symbol in THAT file at sha → grounded",
  );
  assert(
    (await groundCodeSource(ok, "/r", "src/x.ts", "abc1234def")) === "grounded",
    "path present at sha alone → grounded",
  );
  assert(fnSeen(ok).at(-1)?.includes('git cat-file -e abc1234def:"src/x.ts"') === true, "grounding pins to the commit");
  assert(fnSeen(ok).filter((c) => c.includes("git grep")).some((c) => c.includes('abc1234def -- "src/x.ts"')) === true, "symbol grep is scoped to the file at the sha");

  const noSym = groundExecStub({
    catFileOk: ["src/x.ts"],
    grep: () => "no-match",
  });
  assert(
    (await groundCodeSource(noSym, "/r", "src/x.ts#ghostSymbol", "abc1234def")) === "ungrounded",
    "symbol absent from the cited file → ungrounded",
  );

  // The load-bearing #894 case: symbol exists but in a DIFFERENT file.
  // The stub's grep is scoped to the cited file, so it only sees src/a.ts.
  // For the symbol to be "in a different file", the stub must return no-match
  // for the cited file (the symbol is in src/b.ts, not src/a.ts).
  const wrongFile = groundExecStub({
    catFileOk: ["src/a.ts", "src/b.ts"],
    grep: (_sym, _sha, p) => (p === "src/a.ts" ? "no-match" : "hits"),
  });
  assert(
    (await groundCodeSource(wrongFile, "/r", "src/a.ts#symFromB", "abc1234def")) === "ungrounded",
    "symbol in a DIFFERENT file → ungrounded (scoped grep, not repo-wide)",
  );
  void wrongFile;

  const noPath = groundExecStub({
    catFileOk: [],
    grep: () => "hits",
  });
  assert(
    (await groundCodeSource(noPath, "/r", "src/ghost.ts", "abc1234def")) === "ungrounded",
    "path absent at the pinned commit → ungrounded",
  );

  const broken: ExecFn = async () => {
    throw new Error("fatal: not a git repository");
  };
  assert(
    (await groundCodeSource(broken, "/r", "src/x.ts", "abc1234def")) === "unchecked",
    "cat-file exec failure that is not 'path absent' (non-repo) → unchecked, never throws",
  );
  // A rejecting exec whose message does NOT mean 'path absent' → unchecked
  // (a check that could not run must not manufacture a finding), and
  // verifyClaims still resolves (see the integration block below).
  const grepBroken = groundExecStub({
    catFileOk: ["src/x.ts"],
    grep: () => "throw-other",
  });
  assert(
    (await groundCodeSource(grepBroken, "/r", "src/x.ts#sym", "abc1234def")) === "unchecked",
    "a grep failure that isn't 'no match' leaves the claim unchecked, never condemned",
  );
  assert(
    (await groundCodeSource(
      groundExecStub({ catFileOk: ["src/x.ts"], grep: () => "hits" }),
      "/r",
      "src/x.ts",
      "unknown",
    )) === "unchecked",
    "unknown sha → unchecked, not ungrounded",
  );
  assert(
    (await groundCodeSource(broken, "/r", "", "abc1234def")) === "unchecked",
    "empty source → unchecked",
  );

  // Symbol argv safety: a symbol starting with `-` must reach git grep as
  // the pattern (via -e), not as an option. The stub's grep regex requires
  // the `-e <json> <sha> -- <path>` shape, so if the `-e` were dropped the
  // command would not match and the claim would be unchecked, not grounded.
  const dashSym = groundExecStub({
    catFileOk: ["src/x.ts"],
    grep: (sym) => (sym === "-foo" ? "hits" : "no-match"),
  });
  assert(
    (await groundCodeSource(dashSym, "/r", "src/x.ts#-foo", "abc1234def")) === "grounded",
    "symbol starting with '-' reaches git grep as the pattern (-e), grounded",
  );
}

// parse forms

{
  const f = (s: string) => parseCodeSource(s);
  assert(f("src/x.ts").path === "src/x.ts" && f("src/x.ts").symbol === null, "parse: path");
  const ps = f("src/x.ts#resolveModel");
  assert(ps.path === "src/x.ts" && ps.symbol === "resolveModel", "parse: path#symbol");
  assert(
    f("src/x.ts:42").path === "src/x.ts" && f("src/x.ts:42").symbol === null,
    "parse: path:line",
  );
  assert(
    f("src/x.ts#L42").path === "src/x.ts" && f("src/x.ts#L42").symbol === null,
    "parse: path#Lline",
  );
  const pa = f("src/x.ts (formatRow)");
  assert(pa.path === "src/x.ts" && pa.symbol === null, "parse: path (annotation)");
  const pl = f("src/x.ts … line ~25");
  assert(pl.path === "src/x.ts" && pl.symbol === null, "parse: path … line ~N");
  const pline = f("src/x.ts#L42#sym");
  assert(
    pline.path === "src/x.ts" && pline.symbol === "sym",
    "parse: path#L42#sym → line 42, symbol sym",
  );
}

// split compound sources

{
  const s = (x: string) => splitCompoundSource(x).join("␟");
  assert(s("https://a/1; https://b/2") === "https://a/1␟https://b/2", "split: ; separator");
  assert(s("https://a/1 + https://b/2") === "https://a/1␟https://b/2", "split: + separator");
  assert(s("https://a/1, https://b/2") === "https://a/1␟https://b/2", "split: , separator");
  assert(
    s("https://a/1 https://b/2") === "https://a/1␟https://b/2",
    "split: whitespace between URLs",
  );
  assert(s("https://a/1") === "https://a/1", "no split: single URL");
  assert(s("src/x.ts#sym") === "src/x.ts#sym", "no split: code source");
  assert(s("lib@1.2 docs") === "lib@1.2 docs", "no split: doc reference");
  assert(
    s("outputs/*.provenance.md (all 30 sidecars)") === "outputs/*.provenance.md (all 30 sidecars)",
    "no split: glob + annotation",
  );
  // The real fixture shape: parenthetical annotation stays with its URL.
  const annotated = splitCompoundSource(
    "https://github.com/trail-openers/pi-rukas/commit/9855a08 (label: formatRow(e, now) added at line 234); https://github.com/trail-openers/pi-rukas/issues/709",
  );
  assert(annotated.length === 2, `annotation stays with its URL (got ${annotated.length} parts)`);
  assert(
    annotated[1] === "https://github.com/trail-openers/pi-rukas/issues/709",
    "second part clean",
  );
  assert(
    annotated[0]?.startsWith("https://github.com/trail-openers/pi-rukas/commit/9855a08") === true,
    "first part keeps its URL",
  );
}

// local file stat (injectable seam)

{
  const statStub = (async (p: string) =>
    p.endsWith("missing") || p.endsWith("/missing") ? undefined : { isDirectory: false }) as never;
  assert(
    (await checkLocalFile("/r/present.txt", statStub)) === "local-present",
    "stat: present → local-present",
  );
  assert(
    (await checkLocalFile("/r/missing", statStub)) === "local-missing",
    "stat: missing → local-missing",
  );
  const dirStub = (async () => ({ isDirectory: true })) as never;
  assert(
    (await checkLocalFile("/r/dir", dirStub)) === "local-present",
    "stat: directory → local-present",
  );
}

{
  const os = await import("node:os");
  const fs2 = await import("node:fs");
  const path = await import("node:path");
  const tmp = await fs2.promises.mkdtemp(`${path.join(os.tmpdir(), "research-local-")}`);
  const realFile = path.join(tmp, "real.txt");
  await fs2.promises.writeFile(realFile, "x");
  const statReal: (p: string) => Promise<{ isDirectory: boolean } | undefined> = (p) =>
    fs2.promises
      .stat(p)
      .then((st) => ({ isDirectory: st.isDirectory() }))
      .catch(() => undefined);
  assert(
    (await checkLocalFile(realFile, statReal)) === "local-present",
    "stat seam: real file present",
  );
  assert(
    (await checkLocalFile(path.join(tmp, "nope.txt"), statReal)) === "local-missing",
    "stat seam: real missing leaf",
  );
  assert((await checkLocalFile(tmp, statReal)) === "local-present", "stat seam: directory present");
  await fs2.promises.rm(tmp, { recursive: true, force: true });
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

// --------------------------------------------------- abstention predicate

{
  assert(
    isVerifiedFinding(claim({ verification: { check: "url-liveness", status: "live" } })),
    "live-url finding is verified",
  );
  assert(
    isVerifiedFinding(claim({ verification: { check: "url-liveness", status: "unreachable" } })),
    "unreachable-url finding still counts (absence of an answer is not death)",
  );
  assert(
    !isVerifiedFinding(claim({ verification: { check: "url-liveness", status: "dead" } })),
    "dead-url finding does NOT count",
  );
  assert(
    isVerifiedFinding(
      claim({ sourceKind: "code", verification: { check: "code-grounding", status: "grounded" } }),
    ),
    "grounded code finding is verified",
  );
  assert(
    !isVerifiedFinding(
      claim({
        sourceKind: "code",
        verification: { check: "code-grounding", status: "ungrounded" },
      }),
    ),
    "ungrounded code finding does NOT count",
  );
  assert(
    !isVerifiedFinding(claim({ sourceKind: "doc", source: "lib@1.2 docs" })),
    "doc-sourced finding with NO passing check does NOT count (source kind is not evidence)",
  );
  assert(
    isVerifiedFinding(
      claim({ sourceKind: "doc", verification: { check: "url-liveness", status: "live" } }),
    ),
    "doc-labeled claim whose source was a URL (content classification) DOES count",
  );
  assert(
    isVerifiedFinding(claim({ verification: { check: "local-file", status: "local-present" } })),
    "local-present counts as verified",
  );
  assert(
    !isVerifiedFinding(claim({ verification: { check: "local-file", status: "local-missing" } })),
    "local-missing does NOT count",
  );
  assert(
    !isVerifiedFinding(claim({ verification: { check: "none", status: "skipped-cap" } })),
    "skipped-cap does NOT count",
  );
  assert(
    !isVerifiedFinding(claim({ verification: { check: "url-liveness", status: "skipped-cap" } })),
    "url-liveness/skipped-cap does NOT count (the liveness check was capped, not passed)",
  );
  assert(
    !isVerifiedFinding(claim({ sourceKind: "none", source: "none" })),
    "unsourced finding does NOT count",
  );
  assert(
    !isVerifiedFinding(claim({ kind: "gap", sourceKind: "doc" })),
    "non-finding kinds never count",
  );
}

{
  assert(
    (await pinnedCommit(verifyExecStub(false), "/r")) === "abc1234def",
    "pinned commit resolved",
  );
  const garbage: ExecFn = async () => ({ stdout: "not a sha!!\n" });
  assert((await pinnedCommit(garbage, "/r")) === "unknown", "non-sha output → unknown");
  const broken: ExecFn = async () => {
    throw new Error("no git");
  };
  assert((await pinnedCommit(broken, "/r")) === "unknown", "exec failure → unknown");
}

// --------------------------------------------------- entailment eligibility

{
  // Entailment reads the DRIVER-derived kinds, not the child's sourceKind.
  const localAsUrl = claim({
    sourceKind: "url",
    source: "/Users/janni/present.txt",
    verification: { check: "local-file", status: "local-present", derivedKinds: ["local"] },
  });
  const localAsUrlNone = claim({
    sourceKind: "url",
    source: "/Users/janni/missing.txt",
    verification: { check: "none", status: "unchecked", derivedKinds: ["local"] },
  });
  assert(entailableClaims([localAsUrl]).length === 1, "local-file check stays entailable");
  assert(
    entailableClaims([localAsUrlNone]).length === 0,
    "child-labelled `url` whose derived kind is `local` is NOT entailable (the label never counts)",
  );
  const docClaim = claim({
    sourceKind: "doc",
    source: "lib@1.2 docs",
    verification: { check: "none", status: "unchecked", derivedKinds: ["doc"] },
  });
  assert(entailableClaims([docClaim]).length === 1, "doc-derived claim with no check IS entailable");
  const noKinds = claim({
    sourceKind: "url",
    verification: { check: "none", status: "unchecked" },
  });
  assert(
    entailableClaims([noKinds]).length === 0,
    "child-labelled `url` with no derived kinds is NOT entailable (silence is not a url)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
