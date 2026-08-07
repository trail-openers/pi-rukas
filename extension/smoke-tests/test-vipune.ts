#!/usr/bin/env bun
/**
 * #394 — the vipune seam.
 *
 * The v1 design of this feature shipped a retrieval rule that would have been
 * inert in production, and **its own acceptance criteria could not have caught
 * it**, because every score-dependent criterion was phrased "given a stub
 * vipune returning two rows…". A stub returns whatever similarity the test
 * author picks, so the suite goes green while production injects nothing.
 * That is the same defect class as #279's "fast green, full unrun" and #384's
 * empty-diff inference.
 *
 * So this file is split deliberately:
 *
 *   - **Fake-binary tests** for control flow that has nothing to do with
 *     scores: exit-code discrimination, ENOENT, timeout, secret refusal, argv
 *     shape. A fake is the right tool there.
 *   - **Live-binary tests** for everything score-dependent, run against real
 *     scratch databases. They skip cleanly when `vipune` is not installed, so
 *     the offline suite still passes on a machine without it — but they are
 *     the only thing that can prove the selection rule works.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  HYBRID_AGREEMENT,
  type MemoryHit,
  SIM_FLOOR,
  isIdentifierShaped,
  looksLikeSecret,
  renderBrief,
  selectResults,
  vipuneAdd,
  vipuneSearch,
} from "../src/vipune.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ------------------------------------------------- selection (the load-bearing rule)

const hit = (id: string, similarity: number): MemoryHit => ({ id, content: id, similarity });

{
  // Measured on three independent corpora: on the basename archetype the
  // floor alone admits a guard about an unrelated file. `merge-queue.ts`
  // scored 0.6785 semantically against a store whose guards were all about
  // OTHER pi-ensemble files, clearing a 0.65 floor — but its hybrid top1 was
  // 0.0385 (rank 1 in one retriever), not 0.0769 (rank 1 in both).
  const semantic = [hit("real", 0.8012), hit("wrong-file", 0.6785)];
  const hybrid = [hit("real", 0.0769), hit("wrong-file", 0.0385)];

  const floorOnly = selectResults(semantic, hybrid, { requireAgreement: false });
  assert(
    floorOnly.length === 2,
    "the floor ALONE admits the false positive — this is why it is not sufficient",
  );

  const conjunction = selectResults(semantic, hybrid, { requireAgreement: true });
  assert(
    conjunction.length === 1 && conjunction[0]?.id === "real",
    "floor AND agreement admits the real guard and rejects the wrong-file one",
  );

  // The defect the v2 spec shipped: a UNION is monotone, so it can only add
  // rows and can never remove the floor's false positive.
  const union = [
    ...floorOnly,
    ...hybrid.filter((h) => h.similarity >= HYBRID_AGREEMENT),
  ];
  assert(
    union.length >= floorOnly.length,
    "a UNION can never be smaller than the floor alone — which is why it cannot fix a false positive",
  );
}
{
  const belowFloor = selectResults([hit("a", 0.61)], [hit("a", 0.0769)], {
    requireAgreement: true,
  });
  assert(belowFloor.length === 0, "agreement alone does not rescue a row below the floor");
}
{
  const noHybrid = selectResults([hit("a", 0.9)], undefined, { requireAgreement: true });
  assert(
    noHybrid.length === 0,
    "a guard leg with no hybrid sibling injects NOTHING — it must not silently degrade to floor-only",
  );
}

// ------------------------------------------------------------ shape guards

{
  assert(isIdentifierShaped("work-driver-merged.ts"), "a real basename is identifier-shaped");
  assert(isIdentifierShaped("DriverContext"), "a CamelCase symbol is identifier-shaped");
  // Measured false-firers: BM25 ranks stopwords and sub-tokens first too.
  assert(!isIdentifierShaped("ts"), "a 2-char token is not — BM25 ranks it first and lies");
  assert(!isIdentifierShaped("never"), "a bare lowercase word is not (measured: 0.0742)");
  assert(!isIdentifierShaped("the"), "...nor a stopword (measured: 0.0697)");
  assert(!isIdentifierShaped("how do we merge"), "a multi-word phrase is not");
}

// ------------------------------------------------------------- secrets

{
  assert(looksLikeSecret("AWS key AKIAIOSFODNN7EXAMPLE here"), "an AWS key id is refused");
  assert(looksLikeSecret("token: sk-abcdefghijklmnop1234"), "an sk- token is refused");
  assert(looksLikeSecret("postgres://user:hunter2@db/x"), "a URL-embedded password is refused");
  assert(looksLikeSecret("api_key = 9f8a7b6c5d4e3f21"), "an api_key assignment is refused");
  // The regression the critic caught: an entropy-only rule ate git SHAs, so a
  // correction citing a commit was silently dropped on the highest-value path.
  assert(
    !looksLikeSecret("fixed in 7c6b0f1a2b3c4d5e6f708192a3b4c5d6e7f80912 on main"),
    "a 40-char git SHA is NOT a secret — an entropy-only rule silently ate corrections",
  );
  assert(
    !looksLikeSecret("error TS2345: Argument of type 'DriverContext' is not assignable"),
    "a compiler error line is not a secret",
  );
}

// -------------------------------------------- exit-code discrimination (fake binary)

const fakeBin = (script: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "vip-fake-"));
  const p = path.join(dir, "vipune");
  Bun.write(p, script);
  execFile("chmod", ["+x", p]);
  return p;
};

async function withFake(script: string, fn: (bin: string) => Promise<void>) {
  const bin = fakeBin(script);
  // chmod is async above; give it a beat then run.
  await new Promise((r) => setTimeout(r, 30));
  try {
    await fn(bin);
  } finally {
    rmSync(path.dirname(bin), { recursive: true, force: true });
  }
}

{
  // vipune#177 — exit 2 means BOTH "conflict detected" and "you typed the
  // flags wrong". Only stdout separates them, and getting this wrong makes
  // the driver answer its own argv bug with a supersede.
  await withFake(
    '#!/bin/sh\necho \'{"status":"conflicts","proposed":"x","conflicts":[{"id":"c1","content":"old","similarity":0.99}]}\'\nexit 2\n',
    async (bin) => {
      const r = await vipuneAdd("x", { cwd: "/tmp", memoryType: "fact", binary: bin });
      assert(
        r.kind === "conflict" && r.conflicts[0]?.id === "c1",
        "exit 2 WITH conflict JSON on stdout → conflict, carrying the conflicting id",
      );
    },
  );
  await withFake('#!/bin/sh\necho "error: unexpected argument" >&2\nexit 2\n', async (bin) => {
    const r = await vipuneAdd("x", { cwd: "/tmp", memoryType: "fact", binary: bin });
    assert(
      r.kind === "error",
      "exit 2 with EMPTY stdout → error, NOT conflict (this is the #177 trap)",
    );
    assert(
      r.kind === "error" && /not a conflict/.test(r.detail),
      "...and the detail says plainly that it was not a conflict",
    );
  });
}
{
  const r = await vipuneAdd("x", {
    cwd: "/tmp",
    memoryType: "fact",
    binary: "/nonexistent/vipune-9f3a",
  });
  assert(r.kind === "absent", "a missing binary is `absent`, not an error — memory is optional");
}
{
  await withFake("#!/bin/sh\nsleep 30\n", async (bin) => {
    const r = await vipuneAdd("x", {
      cwd: "/tmp",
      memoryType: "fact",
      binary: bin,
      timeoutMs: 300,
    });
    assert(r.kind === "timeout", "a hanging binary times out rather than blocking the cycle");
  });
}
{
  const r = await vipuneAdd("sk-abcdefghijklmnop1234", {
    cwd: "/tmp",
    memoryType: "fact",
    binary: "/nonexistent/vipune-9f3a",
  });
  assert(
    r.kind === "refused",
    "a secret is refused BEFORE the binary is invoked (note the binary here does not exist)",
  );
}
{
  let threw = false;
  try {
    await vipuneSearch("q", { cwd: "/tmp", hybrid: true, recency: 0 as 0 });
    await vipuneSearch("q", {
      cwd: "/tmp",
      hybrid: true,
      // biome-ignore lint/suspicious/noExplicitAny: deliberately violating the type to prove the guard
      recency: 0.3 as any,
    });
  } catch {
    threw = true;
  }
  assert(threw, "hybrid + non-zero recency throws — it is a recency sort, not a search");
}

// ----------------------------------------------- LIVE binary (score-dependent)

const haveVipune = await execFileP("which", ["vipune"])
  .then(() => true)
  .catch(() => false);

if (!haveVipune) {
  console.log("… vipune not installed — skipping live score tests (control-flow tests still ran)");
} else {
  const dir = mkdtempSync(path.join(tmpdir(), "vip-live-"));
  const db = path.join(dir, "m.db");
  const base = ["--db-path", db, "--project", "livetest"];
  const add = (text: string) =>
    execFileP("vipune", [...base, "add", text, "--memory-type", "guard", "--json"]);
  try {
    // Guards each naming a DIFFERENT source file — the archetype where the
    // floor alone fails, because every guard is "about a pi-ensemble file".
    await add("never call inlineDevelopPrompt from outside work-driver-branch-develop.ts");
    await add("work-driver-merged.ts must not merge without an explicit AGENTS.md grant");
    await add("work-driver-resume.ts write-ahead must persist before awaiting any dispatch");
    await add("work-driver-lens.ts must never approve on an unreadable diff");
    await add("work-queue.ts must not halt on a failure that was retried and recovered");
    await add("worktree.ts must always create detached worktrees at baseSha");

    const leg = async (q: string, hybrid: boolean) => {
      const r = await vipuneSearch(q, {
        cwd: dir,
        memoryType: "guard",
        hybrid,
        limit: 5,
        binary: "vipune",
        execFn: (file, args, opts) =>
          execFileP(file, [...base, ...args], opts).then((x) => ({
            stdout: String(x.stdout),
            stderr: String(x.stderr),
          })),
      });
      return r.kind === "hits" ? r.hits : [];
    };

    const inject = async (q: string) =>
      selectResults(await leg(q, false), await leg(q, true), { requireAgreement: true });

    for (const q of ["work-driver-merged.ts", "work-driver-lens.ts", "work-queue.ts"]) {
      const got = await inject(q);
      assert(got.length > 0, `LIVE: a basename that HAS a guard injects one (${q})`);
    }
    for (const q of ["merge-queue.ts", "session-store.ts", "widget-render.ts"]) {
      const got = await inject(q);
      assert(
        got.length === 0,
        `LIVE: a basename with NO guard injects nothing (${q}) — the case the floor alone got wrong`,
      );
    }

    // Anti-vacuity: prove the corpus is reachable at all, so the zero-injection
    // assertions above are not passing because everything is broken.
    const raw = await leg("work-driver-merged.ts", false);
    assert(raw.length > 0, "LIVE: the store is reachable (the negatives above are not vacuous)");
    assert(
      raw.some((h) => h.similarity >= SIM_FLOOR),
      "LIVE: and a true positive really does clear the floor",
    );

    // The RRF fact, measured rather than asserted.
    const hy = await leg("work-driver-merged.ts", true);
    assert(
      (hy[0]?.similarity ?? 0) >= HYBRID_AGREEMENT,
      "LIVE: a both-retrievers-rank-1 match reaches the agreement bit",
    );
    const hyNeg = await leg("session-store.ts", true);
    assert(
      (hyNeg[0]?.similarity ?? 1) < HYBRID_AGREEMENT,
      "LIVE: a one-retriever match does NOT — this is the whole discriminator",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ brief

{
  assert(renderBrief([]) === "", "no hits → no brief (never an empty heading)");
  const b = renderBrief([hit("abc-123", 0.9)]);
  assert(/HYPOTHESES/.test(b), "the brief frames memories as hypotheses, not facts");
  assert(/\[vipune:abc-123\]/.test(b), "...carries the id so the agent can cite it back");
  assert(/\[unverified\]/.test(b), "...and marks each line unverified");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
