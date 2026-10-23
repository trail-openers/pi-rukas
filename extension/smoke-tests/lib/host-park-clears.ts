/**
 * smoke-tests/lib/host-park-clears.ts — what CLEARS #1696's host park signal,
 * and what must never refuse on nothing. Split out of
 * `test-host-park-signal.ts` for the §12 file-size cap (that file states which
 * behaviours the suite pins and owns the stub world's two ways of parking).
 *
 * The refusal is a hard stop taken BEFORE any step is dispatched, so the price of
 * a false positive is a cycle that should have run and did not — and nothing can
 * give it back. Every case here is therefore the negative of a refusal: the
 * guard's own bar must be the thing that stops it, and anything the guard could
 * not honestly judge must let the start through.
 *
 *   - an EDITED issue body clears it: the row's fingerprint is the comparison, so
 *     a new text is a new park, which is the documented way out;
 *   - `PI_ENSEMBLE_REPEAT_PARK=0` clears it, and clears it WITHOUT touching the
 *     signal — the switch silences the guard, it does not destroy the memory the
 *     next start reads;
 *   - an UNREADABLE body fails OPEN: the guard cannot compare, and a refusal on a
 *     comparison it could not make is the false positive above;
 *   - a MALFORMED file, an implausible `deliveredCount`, an integer no writer
 *     could produce (`1e18`, an integer to `Number.isInteger` and nothing else),
 *     and a row past the 14-day floor all read as NO signal. Each of those is a
 *     field the reader could not have stamped, and the refusal is the one place a
 *     believed-but-wrong field becomes a hard stop.
 */
import { rmSync, writeFileSync } from "node:fs";
import {
  ISSUE,
  type World,
  park,
  refused,
  signalOf,
  signalPath,
  start,
  tamperSignal,
  world,
} from "./host-park-harness.ts";

type Assert = (cond: boolean, msg: string) => void;

/** Two host cycles that publish an identical uncovered park. */
async function twice(w: World) {
  await park(w, { host: true });
  await park(w, { host: true });
}

export async function hostParkClears(assert: Assert): Promise<void> {
  // ── 1. An edited issue body is a DIFFERENT park: the fingerprint is the
  //        comparison, and revising the body is the remedy the refusal names.
  {
    const w = world("edited");
    await twice(w);
    w.body = `title:\tmock #${ISSUE}\n\nREVISED: the sandbox has no network`;
    assert(
      !refused(await start(w, true)),
      "an edited issue body: the third start proceeds — the fingerprint is the comparison",
    );
    rmSync(w.repo, { recursive: true, force: true });
  }

  // ── 2. The documented switch, and the memory it must NOT destroy.
  {
    const w = world("disabled");
    await twice(w);
    process.env.PI_ENSEMBLE_REPEAT_PARK = "0";
    try {
      assert(
        !refused(await start(w, true)),
        "PI_ENSEMBLE_REPEAT_PARK=0: the handoff is delivered regardless",
      );
      assert(
        signalOf(w)[0]?.deliveredCount === 2,
        "…and the signal survives the disable — the switch silences the guard, it does not erase the memory",
      );
    } finally {
      delete process.env.PI_ENSEMBLE_REPEAT_PARK;
      rmSync(w.repo, { recursive: true, force: true });
    }
  }

  // ── 3. An unreadable body is a comparison the guard could not make, and a
  //        refusal on one is the false positive this whole file is about.
  {
    const w = world("unreadable-body");
    await twice(w);
    w.bodyReadable = false;
    assert(
      !refused(await start(w, true)),
      "issue body unreadable: fails OPEN — no refusal on a comparison it could not make",
    );
    rmSync(w.repo, { recursive: true, force: true });
  }

  // ── 4. A file the reader cannot parse is ABSENT, never trusted.
  {
    const w = world("malformed-signal");
    await twice(w);
    writeFileSync(signalPath(w), "{not json", "utf8");
    assert(
      !refused(await start(w, true)),
      "a malformed signal file is ABSENT, never trusted: the start proceeds",
    );
    rmSync(w.repo, { recursive: true, force: true });
  }

  // ── 5. A `deliveredCount` that is not the writer's shape arms nothing. The
  //        refusal is a hard stop, so a field no writer could have stamped reads
  //        as NO protection rather than as an arbitrarily large count.
  {
    const w = world("implausible-count");
    await twice(w);
    tamperSignal(w, (r) => {
      r.deliveredCount = "lots";
    });
    assert(
      !refused(await start(w, true)),
      "a `deliveredCount` that is not an integer arms nothing — the refusal is a hard stop",
    );
    rmSync(w.repo, { recursive: true, force: true });
  }
  {
    const w = world("absurd-count");
    await twice(w);
    tamperSignal(w, (r) => {
      // An integer to `Number.isInteger`, but not one any writer could produce.
      r.deliveredCount = 1e18;
    });
    assert(
      !refused(await start(w, true)),
      "a `deliveredCount` of 1e18 reads as NO protection — a safe-integer bar, so a hand-edited file cannot arm the hard stop",
    );
    rmSync(w.repo, { recursive: true, force: true });
  }

  // ── 6. A row past the age the sweep deletes its directory under arms nothing:
  //        the guard and the sweep share one clock, and a memory neither believes
  //        cannot be the reason a start stops.
  {
    const w = world("expired");
    await twice(w);
    const old = Date.now() - 15 * 24 * 60 * 60 * 1000;
    tamperSignal(w, (r) => {
      r.firstAt = old;
      r.lastAt = old;
    });
    assert(
      !refused(await start(w, true)),
      "a row past the 14-day floor the sweep deletes under arms nothing",
    );
    rmSync(w.repo, { recursive: true, force: true });
  }
}
