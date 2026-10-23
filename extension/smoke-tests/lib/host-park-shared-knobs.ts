/**
 * smoke-tests/lib/host-park-shared-knobs — the #1696 review-round-1 canary that
 * the two park memories share their TWO knobs, split out of
 * `test-host-park-signal.ts` for the §12 file-size cap (that file states which
 * behaviours the suite pins).
 *
 * Why this exists: the host signal used to carry its OWN copies of the refusal
 * threshold and the `PI_ENSEMBLE_REPEAT_PARK` switch, so raising one guard's
 * bar left the other silently refusing on the old number — a divergence with no
 * symptom until a cycle was wrongly stopped. Both now import the pair from
 * `work-driver-park-record.ts`, the leaf both memories already sit on.
 *
 * The claim is checked THREE ways, because each catches a different regression:
 *
 *  1. **Source**: neither memory DECLARES either knob (a local definition is the
 *     duplicate this item exists to delete), and each imports it from the leaf.
 *  2. **Covered memory, runtime**: what `repeatParkVerdict` compares against is
 *     the leaf's number, and the leaf's switch is the one that silences it.
 *  3. **Host memory, behaviourally**: the host guard ARMS at exactly the leaf's
 *     count and goes silent when the leaf's switch is set to `0`. A test that
 *     only compared exported literals would still pass if the guard stopped
 *     consulting either of them, so this one runs the guard.
 *
 * It also pins the fingerprint SOURCE preference the guard owes the writer:
 * with a cached artifact present the guard hashes the artifact and never the
 * fetched body, so a refusal compares the text this cycle actually published
 * (and an artifact outside the work-state dir is refused, not trusted).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CAP, ISSUE, type World, seams, signalPath, world } from "./host-park-harness.ts";

type Assert = (cond: boolean, msg: string) => void;

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** sha256 of a body in the shape the fingerprint hashes (raw title + body). */
function hash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** A row the writer itself could have produced, armed to `count`. */
function armedRow(count: number, body: string): string {
  return JSON.stringify([
    {
      // The cap is OUTSIDE the covered three — the whole point of the host
      // memory — and "" is what `hostParkOf` produces for a cap that states no
      // cause (`parkReason ?? planVerdict ?? ""`), so this is the row identity
      // the writer actually writes, not one a fixture invented.
      cap: CAP,
      reason: "",
      fingerprint: hash(body),
      deliveredCount: count,
      firstAt: Date.now() - 2000,
      lastAt: Date.now() - 1000,
      // A fixed epoch, so the row is inside the reader's 2020-to-now window
      // while staying far behind `Date.now()`.
      lastCycleId: 1_700_000_000_500,
    },
  ]);
}

/**
 * The host guard, asked directly rather than through a cycle: the channel is
 * read from the environment at call time, so this sets what the handoff step
 * would have set and clears it again — leaving `host` in the environment would
 * turn every later forge-channel case into a host one.
 */
async function ask(w: World, localArtifact?: string) {
  const { hostParkVerdict } = await import("../../src/work-driver-park-memory-host.ts");
  process.env.PI_ENSEMBLE_HANDOFF_CHANNEL = "host";
  try {
    return await hostParkVerdict(
      { repoRoot: w.repo, issue: ISSUE, issues: [ISSUE], ...seams(w) } as never,
      [ISSUE],
      localArtifact,
    );
  } finally {
    delete process.env.PI_ENSEMBLE_HANDOFF_CHANNEL;
  }
}

export async function sharedKnobs(assert: Assert): Promise<void> {
  // ── 1. Source: no local copies, and both read the leaf.
  // `lib/` is one level below smoke-tests/, so `src/` is two levels up — the
  // same spelling the other lib/ harnesses use for fixtures.
  const read = (name: string) =>
    readFileSync(path.resolve(import.meta.dirname, "..", "..", "src", name), "utf8");
  for (const name of ["work-driver-park-memory.ts", "work-driver-park-memory-host.ts"] as const) {
    const code = strip(read(name));
    assert(
      !/export (?:async )?(?:function|const) (?:repeatParkEnabled|REPEAT_PARK_REFUSAL_COUNT|HOST_PARK_REFUSAL_COUNT|hostParkEnabled)\b/.test(
        code,
      ),
      `${name} declares neither the refusal count nor the enable switch — it imports them`,
    );
    assert(
      /import\s+[^;]*\b(?:repeatParkEnabled|REPEAT_PARK_REFUSAL_COUNT)\b[^;]*from "\.\/work-driver-park-record\.ts"/.test(
        code,
      ),
      `${name} reads the shared knob(s) out of the record leaf`,
    );
  }

  // ── 2. The covered memory refuses on the leaf's number, and the leaf's
  //        switch is the one that turns it off.
  const record = await import("../../src/work-driver-park-record.ts");
  const memory = await import("../../src/work-driver-park-memory.ts");
  assert(
    memory.REPEAT_PARK_REFUSAL_COUNT === record.REPEAT_PARK_REFUSAL_COUNT,
    `the covered memory refuses on the record leaf's count (${record.REPEAT_PARK_REFUSAL_COUNT})`,
  );
  process.env.PI_ENSEMBLE_REPEAT_PARK = "0";
  const off = [record.repeatParkEnabled(), memory.repeatParkEnabled()];
  delete process.env.PI_ENSEMBLE_REPEAT_PARK;
  const on = [record.repeatParkEnabled(), memory.repeatParkEnabled()];
  assert(
    off.every((v) => v === false) && on.every((v) => v === true),
    `one switch judges both memories: ${JSON.stringify(off)} off, ${JSON.stringify(on)} on`,
  );

  // ── 3. The host guard, run rather than read: it arms at the leaf's number
  //        and no sooner, and the leaf's switch silences it.
  const w: World = world("shared-knobs");
  try {
    mkdirSync(path.dirname(signalPath(w)), { recursive: true });
    writeFileSync(signalPath(w), armedRow(record.REPEAT_PARK_REFUSAL_COUNT - 1, w.body), "utf8");
    assert(
      (await ask(w)) === undefined,
      "one publish below the shared count arms nothing",
    );
    writeFileSync(signalPath(w), armedRow(record.REPEAT_PARK_REFUSAL_COUNT, w.body), "utf8");
    const armed = await ask(w);
    assert(
      armed !== undefined && armed.deliveredCount === record.REPEAT_PARK_REFUSAL_COUNT,
      `…and the host guard arms at exactly the record leaf's count (${record.REPEAT_PARK_REFUSAL_COUNT})`,
    );
    // Fingerprint source: with a cached artifact the guard hashes THAT, not the
    // fetched body — so it compares the text this cycle published. An artifact
    // whose bytes match no row keeps the guard silent while the same rows arm
    // without it (the case above), which is the only reading under which both
    // assertions are about the artifact rather than about luck.
    const artifact = path.join(path.dirname(signalPath(w)), "issue-body.txt");
    writeFileSync(artifact, "a body this cycle never fetched", "utf8");
    assert(
      (await ask(w, artifact)) === undefined,
      "…and it reads the cycle's cached artifact in preference to the fetch — a different text is not the same park",
    );
    // Containment: an artifact outside `.pi/work-state/` is refused (the same
    // rule `readCachedBody` in work-develop-scope-fence-seam.ts applies), so a
    // state file cannot point the fingerprint at an arbitrary file. Refused
    // means "fall back to the fetch", and the fetch still matches — so the
    // guard arms again, which is the observable difference from trusting it.
    const outside = path.join(w.repo, "elsewhere.txt");
    writeFileSync(outside, "a body this cycle never fetched", "utf8");
    const escaped = await ask(w, outside);
    assert(
      escaped !== undefined && escaped.deliveredCount === record.REPEAT_PARK_REFUSAL_COUNT,
      "…an artifact OUTSIDE the work-state dir is refused, not trusted — the guard falls back to the fetched body rather than comparing a file it cannot vouch for",
    );
    process.env.PI_ENSEMBLE_REPEAT_PARK = "0";
    try {
      assert(
        (await ask(w)) === undefined,
        "the leaf's switch silences the host guard too — same env var, same meaning",
      );
    } finally {
      delete process.env.PI_ENSEMBLE_REPEAT_PARK;
    }
  } finally {
    rmSync(w.repo, { recursive: true, force: true });
  }
}
