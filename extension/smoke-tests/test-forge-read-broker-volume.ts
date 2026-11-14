#!/usr/bin/env bun
/**
 * #2160 lens fix — what ONE CONNECTION may cost the parent.
 *
 * The wire tests (`test-forge-read-wire.ts`) judge what a request may contain
 * and the auth tests judge who may send it; the plan tests
 * (`test-forge-read-broker.ts`) judge what a child is handed. This file judges
 * the two properties that are about VOLUME rather than content, and had no
 * owner:
 *
 *   1. NONCE REPLAY. The request's proof binds a nonce the CHILD chose, so a
 *      captured proved line IS a complete request: whoever recorded it holds a
 *      proof that verifies forever, because nothing on the parent's side ever
 *      consumed the nonce. The broker therefore remembers the nonces it has
 *      served and refuses a repeat — the same reason a reply carries a nonce the
 *      PARENT chose rather than an echo of the request's.
 *   2. FAN-OUT. Every request line launches a credentialed command in the
 *      parent. Handling a line without awaiting it means the number of commands
 *      in flight at once is whatever the child decided to write, and the child
 *      is a stripped helper whose whole point is that it holds no credential.
 *      Lines on one connection are served one at a time, the way
 *      permission-broker.ts serves its verdicts.
 *
 * Both cases drive a real bound broker over a real socket: the property is about
 * the connection, and the connection is the thing under test.
 */

import { connect } from "node:net";
import { ciRunJobsCmd } from "../src/forge-commands.ts";
import { forgeReadMac, newForgeReadNonce } from "../src/forge-read-auth.ts";
import { type RunForgeRead, bindForgeReadSocket } from "../src/forge-read-broker.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

/** The probe broker's key — shared by every case, which is a probe, not a child. */
const PROBE_SECRET = "1".repeat(64);

/**
 * A proved request line under `PROBE_SECRET`. Proving the line is not this
 * file's subject (that is `test-forge-read-auth.ts`); it is what gets a case
 * past the auth gate so the assertion below judges what it set out to judge.
 */
function proved(obj: Record<string, unknown>, nonce = newForgeReadNonce()): string {
  const unsigned = { ...obj, nonce };
  return JSON.stringify({
    ...unsigned,
    auth: forgeReadMac(PROBE_SECRET, nonce, JSON.stringify(unsigned)),
  });
}

interface Dial {
  replies: Record<string, unknown>[];
}

/**
 * One connection that writes `lines` and collects every reply line the broker
 * writes, settling when all `expected` replies have arrived or the socket goes
 * quiet.
 *
 * Replies are collected rather than awaited one at a time because a fan-out
 * case has to observe the broker's own concurrency, and the case decides when
 * the FIRST read is released — so "were two reads in flight" is measured across
 * a real gap the case created, not a race that may not have happened.
 */
function dial(socketPath: string, lines: string[], expected = lines.length): Promise<Dial> {
  return new Promise((resolve, reject) => {
    const conn = connect(socketPath);
    const replies: Record<string, unknown>[] = [];
    let buf = "";
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      conn.destroy();
      resolve({ replies });
    };
    conn.on("connect", () => conn.write(`${lines.join("\n")}\n`));
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          replies.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          reject(new Error(`the broker wrote a non-JSON line: ${raw.slice(0, 80)}`));
          return;
        }
        nl = buf.indexOf("\n");
      }
      if (replies.length >= expected) finish();
    });
    conn.on("close", finish);
    conn.on("error", () => {
      // A reset after the replies arrived is the drop, not a failure: the
      // broker closes what it has finished serving.
      if (replies.length > 0) finish();
      else reject(new Error(`connection to the broker failed with ${replies.length} replies`));
    });
    const timer = setTimeout(finish, 6000);
    timer.unref();
  });
}

async function main(): Promise<void> {
  console.log("a captured proved line is not a request:");
  await check("a request nonce is served once and refused the second time", async () => {
    // The attack is a relay that holds the socket path and a RECORDING of one
    // honest request. It holds no key, so it can neither mint a line of its own
    // nor edit this one — but it can send it AGAIN, and a broker that never
    // consumed the nonce runs the read a second time under the parent's login.
    const line = proved({ type: "forge-read-request", verb: "issue_view", number: 42 });
    let seen = 0;
    const runRead: RunForgeRead = async () => {
      seen++;
      return "the parent's forge answered";
    };
    const bound = await bindForgeReadSocket("/parent/repo", { runRead, secret: PROBE_SECRET });
    try {
      const first = await dial(bound.socketPath, [line]);
      assert(
        first.replies[0]?.ok === true,
        `the first request was served (${JSON.stringify(first.replies[0])})`,
      );
      assert(seen === 1, "the read ran once");
      const second = await dial(bound.socketPath, [line]);
      assert(
        second.replies[0]?.ok === false,
        `the replay refused (${JSON.stringify(second.replies[0])})`,
      );
      assert(
        /replay|nonce/i.test(String(second.replies[0]?.reason ?? "")),
        `the refusal names what it refused (${JSON.stringify(second.replies[0]?.reason)})`,
      );
      assert(seen === 1, `the replay ran no read (reads run: ${seen})`);
    } finally {
      bound.stop();
    }
  });
  await check("a replay on the SAME connection is refused too", async () => {
    // One connection is the shape the child actually uses, so the guard cannot
    // live in a per-connection map that resets between dials.
    const line = proved({ type: "forge-read-request", verb: "repo_settings" });
    let seen = 0;
    const bound = await bindForgeReadSocket("/parent/repo", {
      runRead: async () => {
        seen++;
        return "ok";
      },
      secret: PROBE_SECRET,
    });
    try {
      const { replies } = await dial(bound.socketPath, [line, line]);
      assert(replies.length === 2, `both lines answered (${replies.length})`);
      assert(replies[0]?.ok === true && replies[1]?.ok === false, JSON.stringify(replies));
      assert(seen === 1, `the repeat ran no read (reads run: ${seen})`);
    } finally {
      bound.stop();
    }
  });
  await check("distinct nonces are still served (the arm that keeps the broker honest)", async () => {
    // A guard that refused EVERYTHING would satisfy both cases above, so this
    // pins that the rule is about repeats and not about lines.
    const lines = [1, 2, 3].map((n) =>
      proved({ type: "forge-read-request", verb: "issue_view", number: n }),
    );
    const bound = await bindForgeReadSocket("/parent/repo", {
      runRead: async () => "ok",
      secret: PROBE_SECRET,
    });
    try {
      const { replies } = await dial(bound.socketPath, lines);
      assert(replies.length === 3, `three replies (${replies.length})`);
      assert(
        replies.every((r) => r.ok === true),
        `three distinct requests were all served (${JSON.stringify(replies)})`,
      );
    } finally {
      bound.stop();
    }
  });

  console.log("one connection cannot launch an army:");
  await check("lines on one connection are served one at a time", async () => {
    // The finding: a line handled without awaiting it means N written lines are
    // N credentialed commands running at once in the parent, bounded by nothing
    // but the child's appetite. The gate below is the case's own — the first
    // read is held until the case decides, so an unawaited second line has
    // already started its read while the first is still parked, and `peak` shows
    // it.
    let running = 0;
    let peak = 0;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    const bound = await bindForgeReadSocket("/parent/repo", {
      secret: PROBE_SECRET,
      runRead: async () => {
        running++;
        peak = Math.max(peak, running);
        await gate;
        running--;
        return "ok";
      },
    });
    try {
      const lines = [1, 2, 3].map((n) =>
        proved({ type: "forge-read-request", verb: "issue_view", number: n }),
      );
      const dialed = dial(bound.socketPath, lines);
      // Let the first read start and hold it, so the question "did the second
      // line launch its own read meanwhile?" has a real interval to be answered
      // in rather than a tick both sides happen to share.
      await new Promise((r) => setTimeout(r, 200));
      assert(peak >= 1, "non-vacuity: a read really started");
      releaseGate();
      const { replies } = await dialed;
      assert(peak === 1, `at most one credentialed read ran at once (peak ${peak})`);
      assert(replies.length === 3, `all three lines answered (${replies.length})`);
      assert(
        replies.every((r) => r.ok === true),
        `served in sequence, not refused (${JSON.stringify(replies.map((r) => r.reason))})`,
      );
    } finally {
      releaseGate();
      bound.stop();
    }
  });

  console.log("the CI builders keep their slug and id on one side of the shell:");
  await check("ciRunJobsCmd quotes the slug and refuses a run id that is not a positive integer", () => {
    const cmd = ciRunJobsCmd("github", "acme", "widget", 7);
    assert(/actions\/runs\/7\/jobs/.test(cmd), `a plain run id passes through (${cmd})`);
    for (const slug of ["acme'; touch /tmp/pwned; '", "a b", "$(id)", "-x"] as const) {
      const built = ciRunJobsCmd("github", slug, "widget", 7);
      assert(
        !built.includes(`${slug}/actions`),
        `slug ${JSON.stringify(slug)} reaches the command quoted (${built.slice(0, 100)})`,
      );
    }
    for (const bad of [-1, 0, 1.5, Number.NaN]) {
      let refused = false;
      try {
        ciRunJobsCmd("github", "acme", "widget", bad);
      } catch {
        refused = true;
      }
      assert(refused, `run id ${bad} refused rather than interpolated into the command`);
    }
  });

  await forgeExitCode("forge_read broker consumes its nonces and serves one read at a time");
}

await main();
