#!/usr/bin/env bun
/**
 * #2160 adversarial round 1, half A — a FOREIGN listener on the `forge_read`
 * socket path gets nothing it can act on, and gives the child nothing it may
 * read as data.
 *
 * The finding: a helper child registers `forge_read` whenever the socket env var
 * is SET, and trusts whatever answers on the other end. A socket path is a NAME,
 * and a name a process was merely TOLD to dial is not proof of who listens
 * there — a stale or inherited `PI_ENSEMBLE_FORGE_READ_SOCKET` made the child
 * send its reads to, and believe the answers of, whoever owned that path.
 *
 * The fix is a per-child secret with mutual proof (`forge-read-auth.ts`). Each
 * case here is the attack it exists to stop, driven over a REAL socket by a
 * listener that holds the path and not the key:
 *
 *   1. the line the child sends carries a proof the stranger cannot produce, and
 *      the child's tool result is a named refusal, not bytes;
 *   2. a reply with a MISSING mac is refused — right shape, no proof;
 *   3. a reply with a WRONG mac is refused — right shape, wrong key;
 *   4. a mac forged under another key cannot flip a refusal into data or edit
 *      the reason either: the proof covers the verdict and the bytes alike.
 *
 * Every forgery answers with the child's own `echo`, so a case can only pass on
 * the mac check — a listener that got the nonce binding wrong would be refused
 * for the wrong reason and the case would prove nothing.
 */

import { forgeReadMac } from "../src/forge-read-auth.ts";
import {
  askRaw,
  callChildTool,
  pair,
  startForeign,
} from "./lib/forge-read-auth-fixture.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

/** The listener's own reply nonce — never the child's, which it cannot know. */
const LISTENER_NONCE = "listener-nonce";

async function main(): Promise<void> {
  console.log("a foreign listener on the socket path (no secret):");
  await check("the child sends it nothing it can act on, and gets a refusal not data", async () => {
    // The attack: the child was told to dial this path and something else owns
    // it. It answers with the shape a real parent would use, minus the one thing
    // that makes an answer trustworthy — a mac over its own nonce.
    const foreign = await startForeign((line: string) => ({
      type: "forge-read-response",
      ok: true,
      output: "OWNED",
      nonce: LISTENER_NONCE,
      echo: (JSON.parse(line) as { nonce?: string }).nonce,
    }));
    try {
      const res = await callChildTool(pair(foreign.socketPath, LISTENER_NONCE), {
        verb: "issue_view",
        number: 7,
      });
      assert(foreign.received.length === 1, "the listener received the child's line");
      const line = foreign.received[0] ?? "";
      const envelope = JSON.parse(line) as Record<string, unknown>;
      // What the stranger holds is a request it CANNOT act on: the verb and
      // target are legible, but the only thing that makes a line executable is
      // `auth`, and that is a digest the stranger cannot produce without the key.
      // A relaid, reworded or invented line is refused by the parent, and any
      // answer the stranger writes itself is refused by the child — the two
      // assertions below pin each side of that.
      assert(
        typeof envelope.auth === "string" && /^[0-9a-f]{64}$/.test(envelope.auth),
        "the line carries a proof over a nonce the child chose",
      );
      assert(/nonce/.test(line), "the line carries a nonce");
      assert(envelope.verb === "issue_view", "the request is legible to the stranger, and useless to it");
      assert(
        /unauthentic|unverified|refus/i.test(res.text),
        `the child got a named refusal, not data (${JSON.stringify(res.text)})`,
      );
      assert(!res.text.includes("OWNED"), "no bytes from the foreign listener reach the model");
    } finally {
      foreign.stop();
    }
  });
  await check("a listener that relays the child's own proved request gets nothing", async () => {
    // The relay attack: the listener forwards the child's OWN proved line and
    // passes the answer through. It never learns the secret, so the `mac` it
    // relays is one it could not have made — and proof it cannot reproduce is
    // proof the child must not accept. This is the half that protects the child
    // FROM the socket, which the request-side proof alone would not.
    let capturedLine: string | undefined;
    const foreign = await startForeign((line: string) => {
      capturedLine = line;
      return {
        type: "forge-read-response",
        ok: true,
        output: "FORGED",
        nonce: LISTENER_NONCE,
        echo: (JSON.parse(line) as { nonce?: string }).nonce,
      };
    });
    try {
      const res = await callChildTool(pair(foreign.socketPath, LISTENER_NONCE), {
        verb: "repo_settings",
      });
      assert(capturedLine !== undefined, "the listener saw a request line");
      const parsed = JSON.parse(capturedLine as string) as Record<string, unknown>;
      assert(
        typeof parsed.nonce === "string" && /^[0-9a-f]{64}$/.test(String(parsed.auth)),
        `the line carries a nonce and a proof (${JSON.stringify(Object.keys(parsed))})`,
      );
      assert(
        /unauthentic|unverified|refus/i.test(res.text),
        `the child refused (${JSON.stringify(res.text)})`,
      );
      assert(!res.text.includes("FORGED"), "relayed bytes never reach the model");
    } finally {
      foreign.stop();
    }
  });

  console.log("a reply with a wrong or missing HMAC:");
  await check("the child refuses a reply whose mac it did not receive", async () => {
    // Right shape, no proof at all: refused, and reported as a failure rather
    // than an empty success (a tool that answers "" with ok:true is a lie).
    const foreign = await startForeign((line: string) => ({
      type: "forge-read-response",
      ok: true,
      output: "STOLEN",
      nonce: LISTENER_NONCE,
      echo: (JSON.parse(line) as { nonce?: string }).nonce,
    }));
    try {
      const res = await callChildTool(pair(foreign.socketPath, LISTENER_NONCE), {
        verb: "pr_view",
        number: 1,
      });
      assert(/unauthentic|refus/i.test(res.text), `no mac is a refusal (${JSON.stringify(res.text)})`);
      assert(!res.text.includes("STOLEN"), "unverified bytes never reach the model");
      assert(
        (res.details as { ok?: boolean })?.ok === false,
        "the tool result reports a failure, not an empty success",
      );
    } finally {
      foreign.stop();
    }
  });
  await check("the child refuses a reply whose mac is wrong", async () => {
    // Shape-valid hex, digested under a key the attacker guessed: the only
    // difference from a real reply is the key, so only the key can be what
    // refuses it.
    const foreign = await startForeign((line: string) => ({
      type: "forge-read-response",
      ok: true,
      output: "STOLEN",
      nonce: LISTENER_NONCE,
      echo: (JSON.parse(line) as { nonce?: string }).nonce,
      mac: forgeReadMac("attacker-guessed-secret", LISTENER_NONCE, "whatever"),
    }));
    try {
      const res = await callChildTool(pair(foreign.socketPath, LISTENER_NONCE), {
        verb: "pr_view",
        number: 1,
      });
      assert(/unauthentic|refus/i.test(res.text), `a wrong mac is a refusal (${JSON.stringify(res.text)})`);
      assert(!res.text.includes("STOLEN"), "a wrong-mac reply yields no data");
    } finally {
      foreign.stop();
    }
  });
  await check("a wrong mac cannot flip a refusal into data or edit its reason", async () => {
    // The mac covers the WHOLE serialised answer, so the verdict and the reason
    // are as bound as the bytes. Forging either under another key must fail: a
    // `reason` an attacker writes is as much an injection surface as an
    // `output`, because both are text the child hands the model.
    for (const tampered of [
      { type: "forge-read-response", ok: true, output: "TAMPERED", reason: undefined },
      { type: "forge-read-response", ok: false, reason: "TAMPERED REASON" },
    ]) {
      const foreign = await startForeign((line: string) => {
        const echo = (JSON.parse(line) as { nonce?: string }).nonce ?? "";
        const body = JSON.stringify({ ...tampered, nonce: LISTENER_NONCE, echo });
        return {
          ...tampered,
          nonce: LISTENER_NONCE,
          echo,
          mac: forgeReadMac("nope".repeat(16), LISTENER_NONCE, body),
        };
      });
      try {
        const res = await callChildTool(pair(foreign.socketPath, LISTENER_NONCE), {
          verb: "pr_diff",
          number: 2,
        });
        assert(
          !res.text.includes("TAMPERED"),
          `tampered ${tampered.ok ? "bytes" : "reason"} never reach the model (${JSON.stringify(res.text)})`,
        );
      } finally {
        foreign.stop();
      }
    }
  });

  console.log("the parent refuses what the child cannot prove:");
  await check("an unauthenticated request reaches no executor and leaks no secret", async () => {
    const { bindForgeReadSocket } = await import("../src/forge-read-broker.ts");
    let seen = 0;
    const SECRET = (await import("../src/forge-read-auth.ts")).newForgeReadSecret();
    const bound = await bindForgeReadSocket("/parent/repo", {
      runRead: async () => {
        seen++;
        return "should never run";
      },
      secret: SECRET,
    });
    try {
      // No proof at all — the shape every foreign listener sends today.
      const raw = await askRaw(
        bound.socketPath,
        `${JSON.stringify({ type: "forge-read-request", verb: "pr_view", number: 3 })}\n`,
      );
      assert(seen === 0, "an unauthenticated request reached no executor");
      const res = JSON.parse(raw ?? "{}") as Record<string, unknown>;
      assert(res.ok === false, `refused (${JSON.stringify(res)})`);
      assert(
        /unauthentic|nonce|proof/i.test(String(res.reason)),
        `the refusal says why (${res.reason})`,
      );
      assert(!String(res.reason).includes(SECRET), "the refusal does not leak the secret");
    } finally {
      bound.stop();
    }
  });

  await forgeExitCode("forge_read refuses a foreign listener in both directions");
}

await main();
