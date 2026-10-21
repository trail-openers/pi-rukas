#!/usr/bin/env bun
/**
 * #1740 — the stale-lock sweep's own contract, plus the two structural rules
 * that make it safe.
 *
 * The sweep is the single place that decides whether a lockfile may be
 * deleted, for both the claims registry lock and the integration lock. Every
 * case here is driven through its injected seams (`now`, `aliveOf`) rather
 * than by sleeping or by hunting for a pid that happens to be dead: a test
 * that ages a lock by waiting cannot express "past the hard ceiling", and a
 * test that trusts the real `kill(pid, 0)` cannot express "a recycled pid" at
 * all — which is exactly the case the hard ceiling exists for.
 *
 * The direction of every asymmetry is the same, and it is the reason the
 * module is one operation and not a read plus a delete: deleting a live
 * holder's lock puts two writers in the critical section at once (the lost
 * update the lock exists to remove), while waiting on a corpse costs one poll.
 *
 * ## The structural gate at the bottom
 *
 * A re-validation that can be paused is not a re-validation. If anything in the
 * sweep ever awaits, the scheduling gap between "the path still holds the bytes
 * I judged" and `unlinkSync` is exactly the window #1640 measured, and the
 * module's whole argument silently stops holding. That is not observable from
 * any behavioural test — the races it reopens land on the scheduler's side of a
 * coin — so it is asserted against the source, and comments are stripped first
 * so prose about the old async read cannot satisfy or break it.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sweepStaleLockfile } from "../src/stale-lock-sweep.ts";
import {
  LOCK_HARD_STALE_MS,
  LOCK_STALE_MS,
  sweepStaleLock,
} from "../src/work-driver-path-claims-lock-sweep.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

/** A clock the tests set, so "5 minutes old" is arithmetic and not a sleep. */
const NOW = 1_700_000_000_000;
const now = () => NOW;
/** A pid that is not us, so the self-pid exemption cannot be doing the work. */
const FOREIGN_PID = 4_242_424;
/** Hard ceiling as the module computes it — imported, never recomputed by hand. */
const HARD = LOCK_HARD_STALE_MS;

const dir = mkdtempSync(path.join(tmpdir(), "pi-sweep-"));
const LOCK = path.join(dir, "path-claims.lock");

/** Put `content` at the lock path and return the path. */
function seed(content: string): string {
  writeFileSync(LOCK, content);
  return LOCK;
}
function seeded(): string {
  try {
    return readFileSync(LOCK, "utf8");
  } catch {
    return "<gone>";
  }
}
function gone(): boolean {
  try {
    readFileSync(LOCK);
    return false;
  } catch {
    return true;
  }
}

/**
 * Move the lockfile's mtime back `ms` from the injected clock.
 *
 * The filesystem's own record of when the file appeared is the only age a
 * tokenless file can be judged by, so the shapes that lean on it have to be
 * aged — and they cannot be aged by waiting, because the clock under test is
 * injected while mtime is real.
 */
function ageBy(ms: number): void {
  const when = new Date(NOW - ms);
  utimesSync(LOCK, when, when);
}

/**
 * The INTEGRATION lock's shape: `unreadableIsStale` (fail-open — a corrupt
 * lockfile must not deadlock consolidation) over windows short enough for a
 * test to age through. The real 30-minute windows are pinned by
 * `test-integration-lock.ts`; what this module's contract depends on is the
 * option, not the number.
 */
const FAIL_OPEN = {
  staleMs: 10_000,
  hardStaleMs: 50_000,
  unreadableIsStale: true,
  now,
  aliveOf: () => false,
};

console.log("\n#1740 — the stale-lock sweep...");

try {
  // ---------------------------------------------------------------- 1
  {
    // The availability fix. A pid that answers `kill(pid, 0)` is NOT proof of
    // a holder: it may be recycled onto another job, a zombie nobody reaped, or
    // a SIGSTOPped process — none of which can release a lockfile. Holders of
    // this lock measured milliseconds, so at 5× the stale window the age alone
    // convicts and the sweep must fire with `aliveOf` answering yes for
    // everyone.
    const f = seed(
      JSON.stringify({ pid: FOREIGN_PID, at: NOW - HARD - 1, nonce: "corpse-by-age" }),
    );
    const verdict = sweepStaleLock(f, { now, aliveOf: () => true });
    assert(verdict.status === "stale", "a lock past the hard ceiling is swept even though its pid answers (recycled pid / zombie / SIGSTOP)");
    assert(gone(), "the swept lockfile is actually gone");
    assert(
      verdict.status === "stale" && verdict.ageMs > HARD,
      `the verdict carries the age an operator reads (${verdict.status === "stale" ? verdict.ageMs : "n/a"}ms > ${HARD}ms)`,
    );
    assert(
      verdict.status === "stale" && verdict.pid === FOREIGN_PID,
      "the verdict names the pid it deleted the lock of",
    );
  }

  // ---------------------------------------------------------------- 2
  {
    // The other half of the same rule: below the ceiling, a live holder is
    // waited out no matter how long it has held on. This is the assertion that
    // fails the moment someone makes the age sweep unconditional again.
    const token = JSON.stringify({ pid: FOREIGN_PID, at: NOW - LOCK_STALE_MS - 1, nonce: "live" });
    const f = seed(token);
    const verdict = sweepStaleLock(f, { now, aliveOf: () => true });
    assert(verdict.status !== "stale", "a live holder younger than the hard ceiling is NOT swept");
    assert(seeded() === token, "the live holder's token is byte-identical after the sweep ran");
  }

  // ---------------------------------------------------------------- 3
  {
    // A non-finite `at` is not a timestamp. JSON permits `1e999`, and
    // `JSON.parse` hands back Infinity — an age computed from it is a number
    // only in type, and treating it as evidence would delete a lock on the
    // strength of a value that is not a time.
    for (const bad of ['{"pid":4242,"at":1e999}', '{"pid":4242,"at":"yesterday"}', '{"pid":4242}', '{"pid":4242,"at":0}', '{"pid":4242,"at":-5}']) {
      const f = seed(bad);
      const verdict = sweepStaleLock(f, { now, aliveOf: () => false });
      assert(
        verdict.status !== "stale",
        `an unusable \`at\` (${bad}) is waited out, never swept — even with the holder provably dead`,
      );
      assert(seeded() === bad, `the lockfile carrying ${bad} was left in place`);
    }
  }

  // ---------------------------------------------------------------- 4
  {
    // `JSON.parse("null")` succeeds and yields a non-object. The token is
    // typed `unknown` and rejected on shape, because `null.at` would otherwise
    // be a TypeError on the judge side and a phantom age on the delete side.
    for (const notToken of ["null", "[]", "{}", "true", '"a token"', "", "   ", "{not json"]) {
      const f = seed(notToken);
      const verdict = sweepStaleLock(f, { now, aliveOf: () => false });
      assert(
        verdict.status !== "stale",
        `a token that is not an object (${JSON.stringify(notToken)}) is never swept`,
      );
      assert(seeded() === notToken, `the ${JSON.stringify(notToken)} lockfile was left in place`);
    }
  }

  // ---------------------------------------------------------------- 5
  {
    // A token with no usable `pid` cannot be proven dead, so age alone must
    // not remove it below the ceiling. This is the case a `pid ?? 0` default
    // would silently turn into a theft: `!processAlive(0)` is trivially true.
    const missingPid = JSON.stringify({ at: NOW - LOCK_STALE_MS - 1 });
    const f = seed(missingPid);
    assert(
      sweepStaleLock(f, { now, aliveOf: () => false }).status !== "stale",
      "a lock with no pid is not swept on age alone below the ceiling",
    );
    assert(seeded() === missingPid, "the pid-less lockfile survived the sweep");

    const nanPid = JSON.stringify({ pid: "4242", at: NOW - LOCK_STALE_MS - 1 });
    const f2 = seed(nanPid);
    assert(
      sweepStaleLock(f2, { now, aliveOf: () => false }).status !== "stale",
      "and neither is one whose pid is not a number",
    );
    assert(seeded() === nanPid, "the non-numeric-pid lockfile survived the sweep");

    // ...while the same lock past the ceiling goes: the ceiling is the age
    // rule, and it does not need a pid to apply.
    const oldMissingPid = JSON.stringify({ at: NOW - HARD - 1 });
    const f3 = seed(oldMissingPid);
    assert(
      sweepStaleLock(f3, { now, aliveOf: () => false }).status === "stale",
      "past the hard ceiling a pid-less lock IS swept (the age alone convicts)",
    );
  }

  // ---------------------------------------------------------------- 6
  {
    // The rule the whole design rests on, in its positive direction: a
    // holder that is provably gone gives up its lock immediately, at any age,
    // so a killed cycle cannot pin the registry for the full stale window.
    const token = JSON.stringify({ pid: FOREIGN_PID, at: NOW, nonce: "fresh-corpse" });
    const f = seed(token);
    const verdict = sweepStaleLock(f, { now, aliveOf: () => false });
    assert(
      verdict.status === "stale" && verdict.pid === FOREIGN_PID,
      "a provably dead holder's lock is swept immediately, at zero age",
    );
    assert(gone(), "the corpse's lockfile is gone");
  }

  // ---------------------------------------------------------------- 7
  {
    // Bounds, checked from the stat alone and before any read: a FIFO would
    // block the read and a huge file would be paid for in full. Both are also
    // NOT deletable — an unreadable thing is not evidence of a corpse.
    const asDir = path.join(dir, "a-directory.lock");
    mkdirSync(asDir, { recursive: true });
    assert(
      sweepStaleLock(asDir, { now, aliveOf: () => true }).status !== "stale",
      "a lock path that is not a regular file is waited out",
    );

    const huge = "x".repeat(8192);
    const fHuge = seed(huge);
    assert(
      sweepStaleLock(fHuge, { now, aliveOf: () => false }).status !== "stale",
      "a lockfile past the size bound is waited out, not read and not deleted",
    );
    assert(seeded() === huge, "the oversized lockfile was left in place");
  }

  // ---------------------------------------------------------------- 8
  {
    // The `at` domain. `at` is a WALL-CLOCK timestamp, and the pre-domain check
    // accepted any finite number above zero — so `at: 1` was an age of ~54
    // years, which the hard ceiling reports as "unambiguously stale". A token
    // from a program that wrote something else into the path therefore used to
    // lose a LIVE holder its lock. Below the 2020 floor is not a time anyone
    // stamped, and it is not evidence of death even when the pid is running.
    for (const at of [1, 0, -1, 1e999]) {
      const bad = JSON.stringify({ pid: FOREIGN_PID, at });
      const f = seed(bad);
      const verdict = sweepStaleLock(f, { now, aliveOf: () => true });
      assert(
        verdict.status === "unreadable",
        `\`at\` ${String(at)} with a LIVE pid is reported unjudgeable, not aged (got ${verdict.status})`,
      );
      assert(
        verdict.status !== "stale" && seeded() === bad,
        `the lockfile carrying \`at\` ${String(at)} was left in place`,
      );
    }
  }

  // ---------------------------------------------------------------- 9
  {
    // The `pid` domain. The old check was `typeof pid === "number"`, so
    // `pid: 1.5` reached the liveness probe — where the real `kill(1.5, 0)`
    // throws EINVAL and an injected probe answers "not alive" — and a
    // fractional process id became proof of death. A pid the OS could not have
    // issued names no process, so it proves neither life nor death.
    for (const pid of [1.5, 0, -1]) {
      const bad = JSON.stringify({ pid, at: NOW - LOCK_STALE_MS - 1 });
      const f = seed(bad);
      const verdict = sweepStaleLock(f, { now, aliveOf: () => false });
      assert(
        verdict.status === "alive",
        `\`pid\` ${String(pid)} is no liveness evidence — waited out, not swept (got ${verdict.status})`,
      );
      assert(
        verdict.status !== "stale" && seeded() === bad,
        `the lockfile carrying \`pid\` ${String(pid)} was left in place`,
      );
    }
  }

  // ---------------------------------------------------------------- 10
  {
    // A READ ERROR is an errno, not a fact about a process — so it has no
    // delete in it at all, even for the fail-open lock, and even when the file
    // is ancient enough that the mtime escape would otherwise fire. This is the
    // difference between "we read it and it means nothing" and "we could not
    // read it": only the first is eligible for `unreadableIsStale`.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      console.log("\u2a2a skipped: running as root — chmod 000 does not block a read");
    } else {
      const unreadable = JSON.stringify({ pid: FOREIGN_PID, at: NOW - HARD - 1 });
      const f = seed(unreadable);
      ageBy(HARD + 1);
      chmodSync(f, 0o000);
      try {
        const claims = sweepStaleLock(f, { now, aliveOf: () => false });
        assert(
          claims.status === "unreadable" && claims.errno === "EACCES",
          `a read error is reported as unreadable with its errno (got ${claims.status}${"errno" in claims ? `/${String(claims.errno)}` : ""})`,
        );
        // The fail-open lock — the one that DOES delete unjudgeable files —
        // still refuses this one, which is the whole content of this case.
        const failOpen = sweepStaleLockfile(f, FAIL_OPEN);
        assert(
          failOpen.status === "unreadable" && failOpen.errno === "EACCES",
          `and NOT EVEN the fail-open lock deletes on a read error (got ${failOpen.status}${"errno" in failOpen ? `/${String(failOpen.errno)}` : ""})`,
        );
      } finally {
        chmodSync(f, 0o600);
      }
      assert(
        seeded() === unreadable,
        "the unreadable lockfile is byte-identical after BOTH locks judged it",
      );
    }
  }

  // ---------------------------------------------------------------- 11
  {
    // The last resort. A token that answers nothing (`bad-at`, oversized) is
    // not deletable by the claims lock at all, and by the fail-open lock only
    // once its mtime is past the hard ceiling — the same age rule that
    // convicts a live pid, applied to a token that names nothing. Below the
    // ceiling it waits; past it, consolidation is not held hostage forever.
    const badAt = JSON.stringify({ pid: FOREIGN_PID, at: 1 });
    seed(badAt);
    ageBy(1_000);
    assert(
      sweepStaleLockfile(LOCK, FAIL_OPEN).status === "alive",
      "a bad-at lockfile young by mtime is waited out even by the fail-open lock",
    );
    assert(
      sweepStaleLock(LOCK, { now, aliveOf: () => false }).status === "unreadable",
      "and the claims lock never deletes it at any age",
    );
    assert(seeded() === badAt, "both verdicts left the file in place");

    ageBy(50_001);
    const swept = sweepStaleLockfile(LOCK, FAIL_OPEN);
    assert(
      swept.status === "stale",
      `past the hard ceiling by mtime the fail-open lock sweeps the unjudgeable file (got ${swept.status})`,
    );
    assert(gone(), "and the swept file is actually gone");

    seed("x".repeat(8192));
    ageBy(50_001);
    assert(
      sweepStaleLockfile(LOCK, FAIL_OPEN).status === "stale",
      "the same last resort covers an oversized lockfile the fail-open lock could not even read",
    );
  }

  // ---------------------------------------------------------------- 12
  {
    // The windows are this module's whole behaviour, so a `NaN` or an inverted
    // pair is a programming mistake, not a lock state to be conservative
    // about. Silently waiting on `staleMs: NaN` looks exactly like a hung
    // lockfile and gets debugged as one.
    const refused: string[] = [];
    for (const bad of [
      { staleMs: Number.NaN },
      { staleMs: 0 },
      { staleMs: -1 },
      { staleMs: 1_000, hardStaleMs: Number.NaN },
      { staleMs: 1_000, hardStaleMs: 0 },
      { staleMs: 1_000, hardStaleMs: 999 },
    ]) {
      let threw = false;
      try {
        sweepStaleLockfile(path.join(dir, "nothing-here.lock"), { ...bad, now, aliveOf: () => true });
      } catch {
        threw = true;
      }
      refused.push(threw ? "throw" : "silent");
      assert(threw, `an unusable window (${JSON.stringify(bad)}) is a programmer error, not a wait`);
    }
    // And the legitimate boundary — ceiling EQUAL to the window, the shape the
    // integration lock passes — is not refused.
    let accepted = true;
    try {
      sweepStaleLockfile(path.join(dir, "nothing-here.lock"), {
        staleMs: 1_000,
        hardStaleMs: 1_000,
        now,
        aliveOf: () => true,
      });
    } catch {
      accepted = false;
    }
    assert(accepted, "hardStaleMs EQUAL to staleMs is valid (the integration lock's own shape)");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------- structural gate
{
  // Comments are stripped first: this file's own prose, and the module's, talks
  // about the async read it replaced, and a gate that counted words would be
  // satisfied by the documentation of the bug rather than by its absence.
  const strip = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  const src = readFileSync(
    path.resolve(import.meta.dirname, "..", "src", "stale-lock-sweep.ts"),
    "utf8",
  );
  const code = strip(src);
  assert(!/\basync\b/.test(code), "the sweep helper declares no async function");
  assert(!/\bawait\b/.test(code), "the sweep helper contains no await");
  assert(
    !/from\s+"node:fs\/promises"/.test(code),
    "the sweep helper does not import the promises view of the filesystem",
  );
  assert(
    /\bunlinkSync\(/.test(code) && /\bstatSync\(/.test(code),
    "and it still does its judging and its deleting with the synchronous primitives",
  );
}

console.log(exit === 0 ? "\nAll stale-lock-sweep checks passed." : "\nFAILED");
process.exit(exit);
