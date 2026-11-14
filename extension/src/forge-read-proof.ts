/**
 * forge-read-proof — the two halves of a `forge_read` line that are about the
 * PROOF rather than the read: the ledger of request nonces the broker has spent,
 * and the codec that checks a request's proof and makes a reply's.
 *
 * Split from forge-read-broker.ts for the AGENTS.md §12 500-line cap. The seam is
 * the proof: the broker owns the socket, the connection, and which read to run;
 * this module owns what a line must carry to be believed and what it must carry
 * to be believed BACK. Neither half touches a socket or a forge, which is why
 * neither belongs with the thing that does both.
 *
 * The direction each half faces is the reason they sit together. A request's
 * proof covers a nonce the CHILD chose, so the broker must remember the nonces it
 * served or a recorded line is a permanent capability; a reply's proof covers a
 * nonce the PARENT chose plus the request's nonce under `echo`, so an answer
 * cannot be made to look like a reply to a read the child never asked for. Both
 * are the same `HMAC(secret, nonce + "\n" + line)` from `forge-read-auth.ts`, and
 * both refuse a value that is not that shape rather than comparing it.
 */

import {
  type ForgeReadAuthedRequest,
  forgeReadMac,
  missingRequestAuth,
  newForgeReadNonce,
  verifyForgeReadMac,
} from "./forge-read-auth.ts";
import type { ForgeReadResponse } from "./forge-read-tool.ts";
import { trace } from "./trace.ts";

/**
 * How many served request nonces one broker remembers.
 *
 * A proved request line is a capability that does not expire: the proof covers a
 * nonce the CHILD chose, so whoever recorded one honest line can send it again
 * and the MAC still verifies. Consuming the nonce is what turns "proved" into
 * "proved once". The set is bounded because a broker lives as long as its child
 * and must not grow with the number of reads that child made; the ceiling is far
 * past any dispatch's read count, so the eviction is a memory bound and not a
 * window a legitimate read could fall outside of.
 */
const SERVED_NONCES = 1024;

/**
 * The nonces this broker has already answered, oldest first.
 *
 * Insertion order IS served order for a `Set`, so the oldest entry is the one an
 * overflow drops. `serve` answers whether a nonce may be served now, and records
 * it as spent in the same step: a check and a claim split across two calls is a
 * window in which two lines carrying the same nonce are both admitted.
 */
export function createNonceLedger(): { serve(nonce: string): boolean } {
  const served = new Set<string>();
  return {
    serve(nonce: string): boolean {
      if (served.has(nonce)) return false;
      served.add(nonce);
      while (served.size > SERVED_NONCES) {
        const oldest = served.values().next();
        if (oldest.done) break;
        served.delete(oldest.value);
      }
      return true;
    },
  };
}

/**
 * The envelope's identity fields, checked for shape. The MAC itself is verified
 * by the caller, over the `signedRequest` it returns — the bytes the child
 * actually signed — so this function holds no key and can be asked of any line.
 *
 * A `nonce`/`auth` that is not the shape this module mints is a refusal, not a
 * comparison, and a line that is not an object at all is the same: there is
 * nothing to verify and therefore nothing to serve.
 */
export function authenticateLine(line: string): {
  nonce?: string;
  signedRequest?: string;
  auth?: unknown;
  reason?: string;
} {
  let envelope: ForgeReadAuthedRequest;
  try {
    envelope = JSON.parse(line) as ForgeReadAuthedRequest;
  } catch {
    return { reason: "forge_read: request is not a JSON object" };
  }
  if (envelope === null || typeof envelope !== "object") {
    return { reason: "forge_read: request is not a JSON object" };
  }
  const missing = missingRequestAuth(envelope.nonce, envelope.auth);
  if (missing !== undefined) return { reason: missing };
  // The bytes the child signed are the received line MINUS its `auth` key — a
  // field cannot cover its own bytes. Rebuilt the same way the child built it
  // (the parsed object, that one key removed), so the key order the digest is
  // taken over is the order the bytes arrived in and cannot drift.
  const unsigned: Record<string, unknown> = { ...envelope };
  // `Reflect.deleteProperty` rather than `delete` (biome's `noDelete`): the
  // autofix it recommends — an `undefined` assignment — would leave the key
  // PRESENT, and the key's absence is what makes these bytes match what the
  // child signed. Absence is the whole point of the rebuild.
  Reflect.deleteProperty(unsigned, "auth");
  return {
    nonce: envelope.nonce as string,
    signedRequest: JSON.stringify(unsigned),
    auth: envelope.auth,
  };
}

/**
 * Write one reply, proved. The proof binds the answer AND the request it
 * answers: the request's own nonce comes back under `echo`, so the mac
 * covers both and the child can check that this answer is for the read it asked
 * for, not a reply captured from an earlier call. `mac` itself is excluded — a
 * field cannot cover its own bytes — which is what the child recomputes over.
 *
 * Without a `secret`/`nonce` the line goes out unproved, which is the shape only
 * a refusal to an UNVERIFIED caller may take: it answers nothing, so there is
 * nothing for the child to mistake for forge bytes.
 */
export function writeResponse(
  conn: { write(data: string): boolean; destroy?(): void },
  response: ForgeReadResponse,
  secret?: string,
  nonce?: string,
  echo?: string,
): void {
  if (secret === undefined || nonce === undefined) {
    try {
      conn.write(`${JSON.stringify(response)}\n`);
    } catch (err) {
      trace(`forge-read-broker: write failed: ${(err as Error).message}`);
    }
    return;
  }
  // ONE object, serialised twice: the mac must cover the exact bytes written,
  // and `JSON.stringify` of a mutated copy can order keys differently. The
  // `mac` key is added only after the digest, on a copy of the same shape.
  const unsigned: Record<string, unknown> = { ...response, nonce, echo };
  const body = JSON.stringify(unsigned);
  const mac = forgeReadMac(secret, nonce, body);
  const line = `${JSON.stringify({ ...unsigned, mac })}\n`;
  if (!verifyForgeReadMac(secret, nonce, body, mac)) {
    // Self-check, not a defence: a reply whose own proof does not verify under
    // the key that just made it means the two sides disagree about what was
    // signed, and a half-written answer is worse than no answer. The child would
    // refuse it anyway; this keeps the socket from being the place that happens.
    trace("forge-read-broker: internal reply proof did not verify — connection dropped");
    conn.destroy?.();
    return;
  }
  try {
    conn.write(line);
  } catch (err) {
    trace(`forge-read-broker: write failed: ${(err as Error).message}`);
  }
}
