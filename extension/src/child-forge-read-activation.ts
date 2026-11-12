/**
 * child-forge-read-activation — the `forge_read` tool inside a helper child,
 * and the `session_start` append that turns it on (#2160).
 *
 * The tool is REGISTERED in the child by the child-guards companion — the same
 * `--extension` companion pattern `report_finding` and `report_policy` use —
 * and its handler does nothing but forward the request to the PARENT over the
 * parent-owned forge-read socket (`PI_ENSEMBLE_FORGE_READ_SOCKET`, the sibling
 * of `PI_ENSEMBLE_PERM_SOCKET`). The parent runs `createForge(detectForge(…))`
 * with its own login and sends the bytes back (`forge-read-broker.ts`).
 *
 * So the two halves of the contract hold at once: the tool exists in the
 * child's roster (which is what activation can append to, and what a child can
 * call), and no credential ever crosses into the child (`child-forge-env.ts`
 * deleted them, and the child never sees the parent's).
 *
 * Activation follows the codemode precedent exactly (`child-codemode.ts`): an
 * APPEND to the current active tool set, never a replace — a replace built from
 * less than the current set drops the `mcp__codebase_memory__*` tools. Each
 * child gets exactly one append, from the entry point that runs in its mode:
 *   - trust-mode children: `child-guards.ts`'s `session_start`;
 *   - strict/headless children: `registerSubagentGuard`'s `session_start`, whose
 *     registration sits ABOVE the sandbox/trust short-circuits — so it runs in
 *     every mode, including the sandbox and trust containers where the companion
 *     (and this guard's hook half) have stood down. The companion's own
 *     `session_start` is not one of these: under `PI_ENSEMBLE_SUBAGENT_MODE=1`
 *     it has already no-oped, which is why the two sites are mutually exclusive
 *     and neither is the other's backstop.
 *
 * Registration follows activation. The companion registers the tool through
 * `registerChildForgeReadTool`, which applies the same predicate activation
 * does — a stripped role AND a parent-served broker socket — so a child is
 * never offered a `forge_read` that can only answer "no parent forge-read
 * broker". A trust-mode helper (the interactive default, which loads no other
 * pi-rukas extension) is the case this exists for: its env carries no login, so
 * without the tool it has no forge surface at all.
 *
 * Ops is excluded, and so is the parent. Ops is the role that still holds the
 * login and runs `gh`/`glab` itself, so it has no reason to proxy reads; the
 * parent registers no `forge_read` at all. Both exclusions are decided HERE, by
 * the role the spawn set in `PI_ENSEMBLE_ROLE` — one predicate, so a roster can
 * never disagree with the env strip about who still has a login.
 */

import { type Socket, createConnection } from "node:net";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { keepsForgeLogin } from "./child-forge-env.ts";
import {
  FORGE_READ_SECRET_ENV,
  type ForgeReadAuthedResponse,
  forgeReadMac,
  newForgeReadNonce,
  verifyForgeReadMac,
} from "./forge-read-auth.ts";
import { trace } from "./trace.ts";

/** The tool name, exported so the tests and agents.json agree on one spelling. */
export const FORGE_READ_TOOL = "forge_read";

/** The env the child reads the parent's broker path from. */
export const FORGE_READ_SOCKET_ENV = "PI_ENSEMBLE_FORGE_READ_SOCKET";

/** The env the child reads the parent's broker secret from. */
export { FORGE_READ_SECRET_ENV };

/** Per-request bound on the socket round trip — a hung parent must not hang the child's turn. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Whether this role's child gets the tool. Ops keeps its login, so it does not proxy. */
export function forgeReadEnabledForRole(role: string | undefined): boolean {
  if (!role) return false;
  return !keepsForgeLogin(role);
}

/**
 * Whether this child may have the tool at all: registration AND activation
 * answer this one predicate, so the two can never disagree about who holds a
 * broker to talk to.
 *
 * Both halves matter — and "the socket" now means the socket AND its key. The
 * role: ops keeps its own login, so it has no reason to proxy reads, and the
 * parent's strip never gave it a socket. The pair: a child whose parent served no
 * broker — an ops plan, or a bind that failed — can only ever be answered
 * `forge_read: no parent forge-read broker`, which is the
 * registered-but-always-refuses shape the broker's docstring refuses to take, and
 * half a pair is the same shape by another route: a path with no key has nothing
 * to authenticate its dialer with, so every call would come back a refusal. Pi's
 * `setActiveTools` silently ignores unregistered names, so a registered tool is
 * what a roster can offer at all; gating registration on the same condition keeps
 * an unusable tool out of the child's surface instead of relying on that silence.
 */
export function forgeReadAvailableForRole(role: string | undefined): boolean {
  return (
    forgeReadEnabledForRole(role) &&
    !!process.env[FORGE_READ_SOCKET_ENV] &&
    !!process.env[FORGE_READ_SECRET_ENV]
  );
}

/**
 * Append `forge_read` to the child's active tool set. Safe on every
 * session_start: no-op for ops (no role, or the role that keeps the login),
 * for a child whose parent started no broker, and when the tool is already
 * active. `setActiveTools` ignores names that were never registered, so an
 * older Pi without the companion tool costs nothing.
 */
export function enableChildForgeRead(pi: ExtensionAPI, role: string | undefined): void {
  if (!forgeReadAvailableForRole(role)) {
    if (!forgeReadEnabledForRole(role)) {
      trace(`child-forge-read: not activated for role=${role ?? "<unset>"}`);
    } else {
      trace("child-forge-read: no parent broker socket and secret — activation skipped");
    }
    return;
  }
  try {
    const active = pi.getActiveTools();
    if (active.includes(FORGE_READ_TOOL)) return;
    pi.setActiveTools([...active, FORGE_READ_TOOL]);
    trace(
      `child-forge-read: ${FORGE_READ_TOOL} appended (${active.length} → ${active.length + 1})`,
    );
  } catch (err) {
    trace(`child-forge-read: activation failed (child continues without it): ${describe(err)}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The child's half of the request line — the parent authorises, not us.
 *
 * `verb` plus the six optional targets the tool's schema declares, and nothing
 * else. The cast on the model's arguments is not a check, so the payload is
 * assembled field by field below rather than by spreading `raw`: what goes on
 * the wire is exactly what this interface names.
 *
 * The fields are never serialised on their own — `requestForgeRead` folds them
 * into the one flat line it signs and sends — so a listener that is not this
 * child's parent can neither serve them nor answer for them: it holds no key, so
 * it can neither forge a request of its own nor a reply this child would believe.
 */
interface ForgeReadArgs {
  verb: string;
  number?: number;
  id?: number;
  query?: string;
  state?: string;
  sourceBranch?: string;
  allStates?: boolean;
}

/**
 * Build the request line from the tool's arguments, keeping only the fields
 * this tool declares.
 *
 * The arguments arrive from the model through a cast (`raw as ForgeReadArgs`),
 * which validates nothing, and the parent's broker parses a JSON line back into
 * an object it will hand to the code that builds its forge. A spread of an
 * unvalidated object would let any key the caller invented ride to that code.
 * So each field is copied by name and typed: an extra key is dropped here, and
 * a field of the wrong type never reaches the socket either.
 */
function forgeReadPayload(raw: unknown): ForgeReadArgs {
  const src = (raw ?? {}) as Record<string, unknown>;
  const args: ForgeReadArgs = { verb: typeof src.verb === "string" ? src.verb : "" };
  if (typeof src.number === "number") args.number = src.number;
  if (typeof src.id === "number") args.id = src.id;
  if (typeof src.query === "string") args.query = src.query;
  if (typeof src.state === "string") args.state = src.state;
  if (typeof src.sourceBranch === "string") args.sourceBranch = src.sourceBranch;
  if (typeof src.allStates === "boolean") args.allStates = src.allStates;
  return args;
}

/**
 * The read's own fields, in the shape the parent's parser accepts: the declared
 * `type`/`verb` and any target the caller supplied, named one by one rather than
 * spread — what can be proved and executed is what this interface names, so a key
 * the model invented reaches neither the socket nor the parent's forge.
 */
function forgeReadWire(args: ForgeReadArgs): Record<string, unknown> {
  const wire: Record<string, unknown> = { type: "forge-read-request", verb: args.verb };
  if (args.number !== undefined) wire.number = args.number;
  if (args.id !== undefined) wire.id = args.id;
  if (args.query !== undefined) wire.query = args.query;
  if (args.state !== undefined) wire.state = args.state;
  if (args.sourceBranch !== undefined) wire.sourceBranch = args.sourceBranch;
  if (args.allStates !== undefined) wire.allStates = args.allStates;
  return wire;
}

/**
 * Forward one read to the parent and return the bytes. A fresh connection per
 * call: a helper's forge reads are a handful per dispatch, not a stream, and a
 * cached socket across a long child turn is a socket the parent may have
 * already closed.
 *
 * The child generates a fresh nonce and signs the whole flat request line —
 * `type`, the verb, its target, and that nonce — with the per-child key, then
 * puts that line on the socket with `auth` appended. The proof is a
 * `HMAC-SHA256(secret, nonce + signed-request)` — a proof, not the secret — so
 * the child sends the parent its request (which no stranger can forge) while
 * proving who sent it. The reply is accepted only if its mac verifies over the
 * nonce the child chose; anything else — absent, malformed, wrong — is a refusal
 * that carries no bytes, because bytes from an unverified socket are the exact
 * thing this channel must never trust.
 */
function requestForgeRead(
  args: ForgeReadArgs,
): Promise<{ ok: boolean; output?: string; reason?: string }> {
  const socketPath = process.env[FORGE_READ_SOCKET_ENV];
  if (!socketPath) return Promise.resolve({ ok: false, reason: "no parent forge-read broker" });
  const secret = process.env[FORGE_READ_SECRET_ENV];
  // No key, no call. Registration already refuses this state; the second check is
  // the one that runs on the wire, so a future caller that reaches the transport
  // directly cannot send an unproved request or accept an unproved reply.
  if (!secret) return Promise.resolve({ ok: false, reason: "no parent forge-read secret" });
  // One object is signed and one object is sent, and the two differ by exactly
  // the `auth` key — a field cannot cover its own bytes. The parent rebuilds the
  // signed string the same way (parse, drop `auth`, re-serialise), so key order
  // cannot drift: the bytes it verifies are the bytes this wrote, minus a key it
  // appends last and never verifies. A stranger on the socket path reads the
  // whole line, verb and target included, and can act on none of it: it holds no
  // key, so it can neither mint a proof for a request of its own nor a reply the
  // child would believe. The refusal on the child's side is what makes the
  // channel safe, not the secrecy of the verb.
  const nonce = newForgeReadNonce();
  const unsigned: Record<string, unknown> = { ...forgeReadWire(args), nonce };
  const payload: Record<string, unknown> = {
    ...unsigned,
    auth: forgeReadMac(secret, nonce, JSON.stringify(unsigned)),
  };
  return new Promise((resolve) => {
    let settled = false;
    let buffer = "";
    let sock: Socket | undefined;
    const done = (v: { ok: boolean; output?: string; reason?: string }): void => {
      if (settled) return;
      settled = true;
      try {
        sock?.destroy();
      } catch {
        /* already gone */
      }
      resolve(v);
    };
    const timer = setTimeout(
      () => done({ ok: false, reason: "forge_read: parent timed out" }),
      REQUEST_TIMEOUT_MS,
    );
    try {
      sock = createConnection(socketPath);
    } catch (err) {
      clearTimeout(timer);
      resolve({ ok: false, reason: `forge_read: connect failed: ${describe(err)}` });
      return;
    }
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      try {
        sock.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        clearTimeout(timer);
        done({ ok: false, reason: `forge_read: write failed: ${describe(err)}` });
      }
    });
    sock.on("data", (chunk: string | Buffer) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      const replyLine = buffer.slice(0, nl);
      try {
        const v = JSON.parse(replyLine) as ForgeReadAuthedResponse;
        // The reply is accepted only as the bytes its `mac` covers. Those bytes
        // are the reply WITHOUT its `mac` key (a field cannot cover its own
        // bytes), built by deletion on the parsed object so the key order is the
        // order the bytes arrived in rather than a re-spelling that may not
        // match. On any mismatch — absent, wrong, a reply for another request — a
        // refusal that carries no bytes.
        // The parent signs with ITS OWN fresh nonce (so a reply for one request
        // can never be replayed as a reply for another), and names the request it
        // answers in `echo`. The proof is therefore checked over the parent's
        // nonce, and the binding to this call is the `echo` check below it:
        // requiring the two nonces to be equal would refuse every honest answer.
        // `echo` is the request's nonce as a STRING, but its provenance is the
        // untrusted socket, so the comparison is stringified on both sides rather
        // than trusting the received value's type.
        const replyNonce = v.nonce;
        if (typeof replyNonce !== "string" || v.echo !== String(nonce)) {
          done({ ok: false, reason: "forge_read: parent reply is for another request" });
          return;
        }
        const signedReply: Record<string, unknown> = { ...v };
        // `Reflect.deleteProperty` is `delete` written so biome's recommended
        // `noDelete` stays quiet — its autofix (assign `undefined`) would leave
        // the key PRESENT, which is the one thing this rebuild must not do: the
        // key's absence is what makes the bytes match what the parent signed.
        Reflect.deleteProperty(signedReply, "mac");
        if (!verifyForgeReadMac(secret, replyNonce, JSON.stringify(signedReply), v.mac)) {
          done({ ok: false, reason: "forge_read: unverified parent reply — refused" });
          return;
        }
        done({ ok: v.ok === true, output: v.output, reason: v.reason });
      } catch (err) {
        done({ ok: false, reason: `forge_read: malformed parent reply: ${describe(err)}` });
      }
    });
    sock.on("error", (err: Error) => {
      clearTimeout(timer);
      done({ ok: false, reason: `forge_read: socket error: ${err.message}` });
    });
    sock.on("close", () => {
      clearTimeout(timer);
      done({ ok: false, reason: "forge_read: parent closed the connection" });
    });
  });
}

/**
 * Register `forge_read` into a child, when this child can actually use it.
 * Called by BOTH child entry points (child-guards.ts and registerSubagentGuard),
 * each of which registers it at most once; the tool self-declares its
 * parameters and the parent does the work, so there is nothing mode-specific to
 * branch on here. The availability predicate is the one `enableChildForgeRead`
 * applies, so a tool this child was registered for always has the socket that
 * makes the call answer something — and a child that cannot reach a broker is
 * never given the tool.
 */
export function registerChildForgeReadTool(pi: ExtensionAPI): void {
  const role = process.env.PI_ENSEMBLE_ROLE;
  if (!forgeReadAvailableForRole(role)) {
    trace(`child-guards: forge_read not registered (role=${role ?? "<unset>"})`);
    return;
  }
  registerForgeReadTool(pi);
}

/**
 * The registration itself, ungated. Private to this module on purpose: the only
 * caller is `registerChildForgeReadTool` above, so "was this child given the
 * tool?" has exactly one answer in the codebase and cannot be short-circuited
 * by a site that registers it directly.
 */
function registerForgeReadTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: FORGE_READ_TOOL,
    label: "Forge Read",
    description:
      'Read the repository\u2019s forge (GitHub or GitLab) through the parent session\u2019s credential. You have no forge login of your own \u2014 this is the only way to read an issue, PR/MR, check, CI run or log. Read-only: there is no write verb, so nothing here can file, comment, merge or close. Call with {"verb": "<verb>", ...} where verb is one of: issue_view, issue_comments, issue_list, issue_search, pr_view, pr_list, pr_reviews, pr_checks, pr_diff, ci_run, ci_run_log, label_list, repo_settings. issue_view / issue_comments / pr_view / pr_reviews / pr_checks / pr_diff take "number"; ci_run / ci_run_log take "id"; issue_search takes "query"; issue_list and pr_list take an optional "state" (and pr_list also "sourceBranch"). The answer is the forge\u2019s raw JSON (or the raw diff / log text for pr_diff and ci_run_log), returned exactly as the forge sent it. Any other verb, or any attempt at a write, is refused.',
    parameters: Type.Object({
      verb: Type.String({ description: "One of the read verbs listed in the description." }),
      number: Type.Optional(Type.Number({ description: "Issue / PR / MR number." })),
      id: Type.Optional(Type.Number({ description: "CI run / pipeline id." })),
      query: Type.Optional(Type.String({ description: "Search query (issue_search)." })),
      state: Type.Optional(
        Type.String({ description: "State filter: open | closed | all (issue_list, pr_list)." }),
      ),
      sourceBranch: Type.Optional(Type.String({ description: "Head branch filter (pr_list)." })),
      allStates: Type.Optional(
        Type.Boolean({ description: "Include closed issues (issue_search)." }),
      ),
    }),
    async execute(_id, raw) {
      const args = forgeReadPayload(raw);
      const result = await requestForgeRead(args);
      if (!result.ok) {
        return {
          content: [
            {
              type: "text",
              text: result.reason ?? "forge_read: refused by the parent",
            },
          ],
          details: { ok: false, verb: args.verb },
        };
      }
      return {
        content: [{ type: "text", text: result.output ?? "" }],
        details: { ok: true, verb: args.verb },
      };
    },
  });
}
