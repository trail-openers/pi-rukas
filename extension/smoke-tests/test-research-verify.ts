#!/usr/bin/env bun
/**
 * research-verify — the deterministic verification layer, in isolation.
 *
 * Pins: liveness classes (bot-filter 403/429/405 = unreachable, NEVER dead;
 * a thrown fetch = unreachable), the URL cap and dedupe, code grounding
 * against the injected exec (tracked path + present symbol = grounded;
 * missing = ungrounded; an exec failure that isn't "no match" leaves the
 * claim UNCHECKED — a check that could not run must not manufacture a
 * finding), the pinned-commit resolver, and the abstention predicate.
 */

import type { ResearchClaim } from "../src/research-types.ts";
import {
  LIVENESS_URL_CAP,
  checkUrlLiveness,
  classifyLiveness,
  groundCodeSource,
  isVerifiedFinding,
  pinnedCommit,
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

  const many = Array.from({ length: LIVENESS_URL_CAP + 10 }, (_, i) => `https://a/${i}`);
  const capped = await checkUrlLiveness(many, (async () => ({ status: 200 })) as never);
  assert(capped.size === LIVENESS_URL_CAP, `cap: ${capped.size}/${LIVENESS_URL_CAP} URLs checked`);
}

// ------------------------------------------------------- code grounding

function execStub(behavior: {
  tracked: string[];
  grepHits: boolean | "throw-other";
}): ExecFn {
  return async (cmd) => {
    if (cmd.startsWith("git rev-parse")) return { stdout: "abc1234def\n" };
    if (cmd.startsWith("git ls-files")) {
      const wanted = behavior.tracked.find((t) => cmd.includes(t));
      return { stdout: wanted ? `${wanted}\n` : "" };
    }
    if (cmd.startsWith("git grep")) {
      if (behavior.grepHits === true) return { stdout: "src/x.ts\n" };
      if (behavior.grepHits === "throw-other") throw new Error("fatal: not a git repository");
      throw new Error("exit 1"); // git grep: no match
    }
    throw new Error(`unexpected: ${cmd}`);
  };
}

{
  const ok = execStub({ tracked: ["src/x.ts"], grepHits: true });
  assert(
    (await groundCodeSource(ok, "/r", "src/x.ts#resolveModel")) === "grounded",
    "tracked path + present symbol → grounded",
  );
  assert(
    (await groundCodeSource(ok, "/r", "src/x.ts")) === "grounded",
    "tracked path alone → grounded",
  );
  const noSym = execStub({ tracked: ["src/x.ts"], grepHits: false });
  assert(
    (await groundCodeSource(noSym, "/r", "src/x.ts#ghostSymbol")) === "ungrounded",
    "absent symbol → ungrounded (git grep exit 1 is 'no match', not an error)",
  );
  const noPath = execStub({ tracked: [], grepHits: true });
  assert(
    (await groundCodeSource(noPath, "/r", "src/ghost.ts")) === "ungrounded",
    "untracked path → ungrounded",
  );
  const broken: ExecFn = async () => {
    throw new Error("fatal: not a git repository");
  };
  assert(
    (await groundCodeSource(broken, "/r", "src/x.ts")) === "unchecked",
    "an exec that cannot run leaves the claim unchecked, never condemned",
  );
  assert((await groundCodeSource(broken, "/r", "")) === "unchecked", "empty source → unchecked");
}

{
  assert(
    (await pinnedCommit(execStub({ tracked: [], grepHits: false }), "/r")) === "abc1234def",
    "pinned commit resolved",
  );
  const garbage: ExecFn = async () => ({ stdout: "not a sha!!\n" });
  assert((await pinnedCommit(garbage, "/r")) === "unknown", "non-sha output → unknown");
  const broken: ExecFn = async () => {
    throw new Error("no git");
  };
  assert((await pinnedCommit(broken, "/r")) === "unknown", "exec failure → unknown");
}

// --------------------------------------------------- abstention predicate

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
    isVerifiedFinding(claim({ sourceKind: "doc", source: "lib@1.2 docs" })),
    "doc-sourced finding counts (no deterministic check applies)",
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

console.log(`\nexit ${exit}`);
process.exit(exit);
