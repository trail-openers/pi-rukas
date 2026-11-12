/**
 * forge-read-broker — the parent-side socket server that answers a helper
 * child's `forge_read` calls (#2160).
 *
 * Shape (the sibling of permission-broker.ts, and deliberately the same
 * mechanism):
 *
 *   parent Pi process                          child Pi process
 *   ─────────────────                          ──────────────────
 *   pi-rukas (parent mode)                     child-guards companion /
 *     - forge-read-broker (this file)            pi-rukas subagent mode
 *       listens on PI_ENSEMBLE_FORGE_READ_SOCKET   - forge_read tool forwards
 *                                                    one JSON-line request,
 *                                                    proved by a per-child secret
 *
 * The socket answers CONTENT with the parent's credential, so the NAME of the
 * socket is the whole trust question, and a name is not proof: whoever the child
 * was told to dial may be a stranger. That is why the request and the reply are
 * both proved with the per-child secret the spawn layer minted alongside this
 * socket (`forge-read-auth.ts`): the child's line carries a fresh nonce plus
 * `HMAC(secret, nonce + line)`, the broker refuses a line it cannot verify
 * BEFORE running any read, and the reply carries `HMAC(secret, nonce + reply)`
 * over the whole serialised line so neither the bytes nor the verdict can be
 * edited in transit. A child that cannot verify its broker gets a named refusal,
 * never data — the same shape as every other refusal here.
 *
 * The child holds no forge credential (`child-forge-env.ts` deleted them), so
 * the read has to run where the credential is: here, through
 * `createForge(detectForge(cwd))` with the PARENT's login. That is what makes
 * the reads authenticated and keeps them off the unauthenticated 60/hour limit.
 *
 * Served in EVERY permission mode, trust included: the socket is not a
 * permission gate (it answers reads, which every mode allows), and a trust
 * child would otherwise have a `forge_read` tool that always fails — the one
 * shape a gate must never take.
 *
 * The `cwd` is the parent's own repo root, never a value from the request: a
 * child that could name the directory would point the parent's credential at
 * another repository. The parent decides which repository `forge_read` reads.
 *
 * Two properties make the channel trustworthy, and both are about the NAME:
 *
 *   - the socket lives in a `mkdtempSync` directory of its own. A name built
 *     from caller input is a name someone else can occupy first, and this
 *     socket answers CONTENT, so a foreign daemon parked at the path the child
 *     was told to dial would answer the child's reads — the exact inversion of
 *     "the read runs where the credential is". `mkdtempSync` is unpredictable,
 *     collision-free (a `runId` is deliberately SHARED by every member of a
 *     parallel batch, so a derived name is not unique per child), and creates
 *     the directory 0700, so another uid cannot plant a listener there;
 *   - the bind is awaited before the path is handed out, and a failed bind
 *     rejects (`bindForgeReadSocket`). `server.listen` reports a bind failure
 *     on a later tick, so an error handler that only traces lets the caller
 *     publish a path that answers nothing. A stale path a child dials is worse
 *     than no path: it looks like a read.
 *
 * Those two bound who CAN own the name; the secret binds who the dialer is
 * TOLD it is. An inherited or stale env pair is the case: the child dials a
 * path its own parent never bound, and without the proof it would send its
 * reads to — and believe the answers of — whatever listener it found there.
 *
 * The server is bound ONLY when there is a child to hand the socket to, and its
 * `stop()` removes the whole temp tree — the socket and the child's
 * forge-config dir made inside it — when the child exits.
 *
 * A parsed line is never the request. `parseForgeReadRequest` rebuilds it field
 * by field, so the object the executor reads contains the fields the tool's
 * schema declares and nothing else — see `forge-read-tool.ts`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { detectForge } from "./forge-detect.ts";
import {
  type ForgeReadAuthedRequest,
  type ForgeReadAuthedResponse,
  forgeReadMac,
  missingRequestAuth,
  newForgeReadNonce,
  newForgeReadSecret,
  verifyForgeReadMac,
} from "./forge-read-auth.ts";
import { type ForgeReadExecuteOptions, executeForgeRead } from "./forge-read-execute.ts";
import {
  type ForgeReadRequest,
  type ForgeReadResponse,
  parseForgeReadRequest,
  validateForgeRead,
} from "./forge-read-tool.ts";
import { trace } from "./trace.ts";

/**
 * How the parent resolves and runs one validated read.
 *
 * The whole read half, detection included, so a test can observe exactly what
 * the broker hands downstream without a repository to resolve. The three
 * arguments are the values the broker's own plan owns — the repo root it chose,
 * the rebuilt request, and the options bag it built — which is what makes
 * passing them to a stand-in a check on the broker rather than on the forge.
 * `runForgeRead` is the production implementation and callers leave this out.
 */
export type RunForgeRead = (
  cwd: string,
  req: ForgeReadRequest,
  opts: ForgeReadExecuteOptions,
) => Promise<string>;

/** Resolve the forge the parent reads from and run one read through it. */
const runForgeRead = (cwd: string, req: ForgeReadRequest, opts: ForgeReadExecuteOptions) =>
  detectForge(cwd, { allowProbe: false, execTimeoutMs: opts.timeoutMs }).then((det) =>
    executeForgeRead(det, cwd, req, opts),
  );

export interface ForgeReadBrokerHandle {
  /** The temp dir the socket lives in, created 0700 by `mkdtempSync`. */
  dir: string;
  /** The path the parent actually bound — the only path the child may dial. */
  socketPath: string;
  /**
   * The secret the child must prove knowledge of, the other half of the pair
   * the spawn layer hands down. Never logged; never on the wire.
   */
  secret: string;
  /**
   * Close the server and remove the socket dir. `extra` removes one further
   * path the caller made (the child's forge-config dir when it did NOT share
   * this tree). Idempotent, never throws.
   */
  stop(extra?: string): void;
}

/**
 * How long a connection may stay silent before the parent drops it. Comfortably
 * above the child's own request timeout, so a connection is only ever reaped for
 * having sent nothing at all, never for waiting on a read being served.
 */
const CONNECTION_IDLE_MS = 90_000;

/**
 * The ceiling on one request line. A read request is a verb and a handful of
 * short fields; anything past this is not a request, and buffering it is work
 * done on the parent's memory for a child that will never be answered.
 */
const MAX_LINE_BYTES = 64 * 1024;

/**
 * Bind the parent's forge-read server and resolve ONLY once it is genuinely
 * listening. Every failure — the `mkdtemp` that makes the name AND the
 * `listen` that fills it — rejects, so a caller that hands `socketPath` to a
 * child cannot name a socket nobody serves, and a dispatch is never failed by
 * a temp root it cannot write (`spawn-permission.ts` turns a rejection into
 * `forge.socketPath === undefined`). The fail-closed shape is no socket at all.
 *
 * The socket lives in its own `mkdtemp` directory rather than a name derived
 * from the caller's `runId` + role: that pair is deliberately NOT unique (one
 * `runId` covers a whole parallel batch) and a predictable name in a shared
 * temp root is a name another process can be listening on already. This socket
 * answers CONTENT, so a leftover listener would answer this child's reads.
 *
 * The bind is `exclusive: true` so a socket file at the path is a refusal rather
 * than a silent unlink — unlinking someone else's socket and answering on its
 * name is precisely the takeover this avoids.
 */
export function bindForgeReadSocket(
  cwd: string,
  opts: { timeoutMs?: number; runRead?: RunForgeRead; secret?: string } = {},
): Promise<ForgeReadBrokerHandle> {
  // One key per broker, minted here (or supplied by the spawn layer, which owns
  // the child and the teardown). A caller-supplied key must be the shape this
  // module mints: a broker that verified against a short, empty or non-hex key
  // would be a broker anyone could prove itself to, so a malformed one is a bind
  // failure — which `spawn-permission.ts` already turns into "no socket at all".
  const secret = opts.secret ?? newForgeReadSecret();
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    return Promise.reject(new Error("forge-read-broker: broker secret is malformed"));
  }
  let dir: string;
  try {
    dir = mkdtempSync(path.join(os.tmpdir(), "pi-rukas-forge-read-"));
  } catch (err) {
    // An unwritable temp root is a bind failure like any other: reject, and the
    // plan carries no socket. Throwing out of here would fail the dispatch.
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }
  const socketPath = path.join(dir, "broker.sock");
  const server: Server = createServer((conn) => {
    let buffer = "";
    // An idle connection is one that sent a partial line and will send no more:
    // the client writes its whole request on `connect`, so anything still silent
    // past the bound is a stuck child, and it would otherwise hold a server-side
    // socket for the child's whole life. The bound sits above the child's own
    // request timeout, so a connection is never reaped for waiting on a read that
    // is being served.
    conn.setTimeout(CONNECTION_IDLE_MS, () => conn.destroy());
    conn.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      // The request line has a ceiling. A reader that only acts on newlines will
      // happily buffer whatever a stuck or hostile child keeps sending, and the
      // child is the only dialer, so this is work done on the parent's memory for
      // a request that will never be answered.
      if (buffer.length > MAX_LINE_BYTES) {
        trace("forge-read-broker: request line passed its ceiling — connection dropped");
        conn.destroy();
        return;
      }
      let nl = buffer.indexOf("\n");
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        void handleLine(line, conn, cwd, opts, secret);
      }
    });
    conn.on("error", (err) => {
      trace(`forge-read-broker: connection error: ${err.message}`);
    });
  });
  return new Promise<ForgeReadBrokerHandle>((resolve, reject) => {
    const fail = (err: Error): void => {
      try {
        server.close();
      } catch {
        /* never opened */
      }
      // Nothing was bound, so the temp dir is ours to remove — the caller never
      // learns a path it did not pay for.
      removeSocketDir(dir);
      reject(err);
    };
    server.once("error", fail);
    server.once("listening", () => {
      trace(`forge-read-broker: listening on ${socketPath} (cwd=${cwd})`);
      let stopped = false;
      resolve({
        dir,
        socketPath,
        secret,
        stop(extra?: string): void {
          if (stopped) return;
          stopped = true;
          try {
            server.close();
          } catch {
            /* already closed */
          }
          // The tree holds the socket AND the child's forge-config dir, which
          // `spawn-permission.ts` made inside it: one teardown removes both, and
          // no `pi-rukas-forge-*` leftover outlives the child.
          removeSocketDir(dir);
          if (extra) removeSocketDir(extra);
          trace(`forge-read-broker: stopped, socket ${socketPath} removed`);
        },
      });
    });
    server.listen({ path: socketPath, exclusive: true }, () => {
      /* `listening` is the single success signal — see the promise above. */
    });
  });
}

/** Remove the broker's temp dir. Best-effort: a leftover dir is a temp leak, not a wrong answer. */
function removeSocketDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* the temp root is another process's to empty */
  }
}

/**
 * Answer one request line. Every failure path writes a refusal rather than
 * throwing back at the child — a child that hangs waiting for a verdict is
 * worse off than one that gets an error it can read.
 */
async function handleLine(
  line: string,
  conn: { write(data: string): boolean },
  cwd: string,
  opts: { timeoutMs?: number; runRead?: RunForgeRead },
  secret: string,
): Promise<void> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  // Authentication comes FIRST, before the verb is read and long before any
  // credentialed command could run: the request is a claim of identity, and a
  // claim this broker cannot verify is not a request at all. Its failure is a
  // PLAIN refusal — an unverified caller is answered nothing, not even a
  // mac-bearing line, because a mac on a refusal would teach a stranger what a
  // valid proof looks like. Only a request that proved itself gets proved
  // answers; the replies below all carry one fresh nonce, generated here rather
  // than echoed from the request, so the proof binds a value the child chose.
  const authGate = authenticateLine(trimmed);
  if (authGate.reason !== undefined) {
    writeResponse(conn, { type: "forge-read-response", ok: false, reason: authGate.reason });
    return;
  }
  // Only the bytes the proof covered become a request: `payload` is the read the
  // child signed, verified AGAINST this broker's key before a verb is read or a
  // command built. The request's own nonce travels back in the reply as `echo`,
  // so the answer's proof binds the request it answers — a reply captured from an
  // earlier call, or produced for another child, verifies under no nonce this
  // child holds.
  const requestNonce = authGate.nonce as string;
  const signedRequest = authGate.signedRequest as string;
  if (!verifyForgeReadMac(secret, requestNonce, signedRequest, authGate.auth)) {
    // One reason for a wrong proof and no detail about the key: the message may
    // reach a transcript, and nothing about the secret may.
    writeResponse(conn, {
      type: "forge-read-response",
      ok: false,
      reason: "forge_read: unauthenticated request",
    });
    return;
  }
  const nonce = newForgeReadNonce();
  const req = parseForgeReadRequest(signedRequest);
  if (req === undefined) {
    writeResponse(
      conn,
      {
        type: "forge-read-response",
        ok: false,
        reason:
          'malformed request: expected one JSON line of the shape {"type":"forge-read-request","verb":"…"}',
      },
      secret,
      nonce,
      requestNonce,
    );
    return;
  }
  try {
    // The filter fields are checked here rather than left to the executor: this
    // is the seam that decides whether a parent-credentialed command runs at
    // all, and a child-supplied `state`/`sourceBranch` lands in that command
    // string. A refusal must therefore cost no exec, whatever stands in for the
    // read below.
    const reason = validateForgeRead(req);
    if (reason !== undefined) {
      writeResponse(
        conn,
        { type: "forge-read-response", ok: false, reason },
        secret,
        nonce,
        requestNonce,
      );
      return;
    }
    // `timeoutMs` is the ONLY thing taken from the broker's own options into the
    // executor's options bag, and it is named rather than spread: an options
    // object assembled from a request would carry whatever keys the child sent.
    const output = await (opts.runRead ?? runForgeRead)(cwd, req, { timeoutMs: opts.timeoutMs });
    writeResponse(
      conn,
      { type: "forge-read-response", ok: true, output },
      secret,
      nonce,
      requestNonce,
    );
  } catch (err) {
    writeResponse(
      conn,
      {
        type: "forge-read-response",
        ok: false,
        reason: (err as Error).message ?? "forge read failed",
      },
      secret,
      nonce,
      requestNonce,
    );
  }
}

/**
 * The envelope's identity fields, checked for shape. The MAC itself is verified
 * by the caller, over the `payload` it returns — the bytes the child actually
 * signed — so this function holds no key and can be asked of any line.
 *
 * A `nonce`/`auth` that is not the shape this module mints is a refusal, not a
 * comparison, and a line whose `payload` is not an object is the same: there is
 * nothing to verify and therefore nothing to serve.
 */
function authenticateLine(line: string): {
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
function writeResponse(
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
