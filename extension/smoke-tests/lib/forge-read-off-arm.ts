/**
 * lib/forge-read-off-arm — the transport the #2284 forge-off cases drive a REAL
 * broker through, with the read left PRODUCTION.
 *
 * Every other broker suite injects `runRead`, and that seam replaces the whole
 * read half — `detectForge` included — so a `none` case written there passes
 * without ever reaching the code that decides whether to shell `gh`. These cases
 * must therefore dial a broker that was bound with no `runRead` at all, and judge
 * what the parent actually issued via the broker's `execFn` seam
 * (`forge-fixtures.ts`'s `mkExec`), which records every command — the `gh`/`glab`
 * calls AND the `git config --get remote.*` / `git remote` reads that precede them.
 *
 * Two things this file guarantees so a green case means what it says:
 *
 *   - it REFUSES a `runRead` from its caller. The trap this test class keeps
 *     falling into is a `none` case that injects the read and so asserts zero
 *     commands against a code path it never entered;
 *   - the line it sends is proved the way the child's own tool proves one (a
 *     fresh nonce plus the HMAC over the signed bytes), so it reaches the refusal
 *     that sits AFTER authentication and `nonces.serve` rather than the plain
 *     auth refusal.
 *
 * The broker is bound on a `/parent/repo` root that exists nowhere: with the read
 * production, an unresolvable root is what makes the pre-fix arm reach `detectForge`
 * without touching the real repository the suite runs in.
 */

import { createConnection } from "node:net";
import { forgeReadMac, newForgeReadNonce, newForgeReadSecret } from "../../src/forge-read-auth.ts";
import { type ForgeReadBrokerOptions, bindForgeReadSocket } from "../../src/forge-read-broker.ts";
import { mkExec } from "../forge-fixtures.ts";

/** The recorded reply with its per-call proof fields removed — the comparable half. */
export interface ReplyFields {
  type?: unknown;
  ok?: unknown;
  output?: unknown;
  reason?: unknown;
}

export interface OffArmRun {
  /** The reply, minus `mac`/`nonce`/`echo`, which are fresh random values per call. */
  fields: ReplyFields;
  /** Every command the parent issued for this read, in order. */
  calls: string[];
  /** The exec options each recorded command was issued with, positionally aligned. */
  opts: Array<Record<string, unknown> | undefined>;
}

/** The canned `gh issue view 42` answer the fixture repo's issue 42 replies with. */
export const OFF_ARM_ISSUE_JSON =
  '{"number":42,"title":"T","body":"B","state":"OPEN","url":"https://github.com/acme/widget/issues/42","author":{"login":"dev"},"labels":[],"createdAt":"2026-09-01T00:00:00Z","updatedAt":"2026-09-02T00:00:00Z"}';

/** The canned `git config` answer that makes the pre-fix arm resolve a GitHub remote. */
export const OFF_ARM_REMOTE_URL = "git@github.com:acme/widget.git\n";

/**
 * The executor the pre-fix arm answers with: a GitHub remote for the detection,
 * and one canned issue for the read. Any OTHER command is recorded and answers
 * empty — which is how a case notices the parent started asking for something
 * `none` should have forbidden rather than silently serving it.
 */
export function offArmExec(): ReturnType<typeof mkExec> {
  return mkExec({
    "git config --get remote.origin.url": { stdout: OFF_ARM_REMOTE_URL },
    "gh issue view": { stdout: OFF_ARM_ISSUE_JSON },
  });
}

/** The request the off-arm case asks for, as the child's tool would send it. */
export const OFF_ARM_REQUEST = { verb: "issue_view", number: 42 } as const;

/**
 * Drive one proved `forge_read` through a real bound broker whose read is the
 * production `runForgeRead`, and report the reply plus every command the parent
 * issued.
 *
 * `opts.runRead` is refused on purpose (see the header). A caller that wants to
 * replace the read is in the wrong file.
 */
export async function driveProvedRead(
  opts: { execFn?: ForgeReadBrokerOptions["execFn"]; timeoutMs?: number } = {},
  request: Record<string, unknown> = OFF_ARM_REQUEST,
): Promise<OffArmRun> {
  const withRead = opts as Record<string, unknown>;
  if ("runRead" in withRead) {
    throw new Error("driveProvedRead refuses a runRead: it would bypass runForgeRead");
  }
  const secret = newForgeReadSecret();
  const bound = await bindForgeReadSocket("/parent/repo", {
    secret,
    timeoutMs: opts.timeoutMs ?? 5_000,
    ...(opts.execFn === undefined ? {} : { execFn: opts.execFn }),
  });
  try {
    const nonce = newForgeReadNonce();
    const unsigned: Record<string, unknown> = { type: "forge-read-request", ...request, nonce };
    const line = `${JSON.stringify({
      ...unsigned,
      auth: forgeReadMac(secret, nonce, JSON.stringify(unsigned)),
    })}\n`;
    const res = await askRaw(bound.socketPath, line);
    const { mac: _mac, nonce: _rn, echo: _echo, ...fields } = res;
    return { fields: fields as ReplyFields, ...drainCommands(opts) };
  } finally {
    bound.stop();
  }
}

/** The recorder's commands, when the case handed one in. */
function drainCommands(opts: { execFn?: ForgeReadBrokerOptions["execFn"] }): {
  calls: string[];
  opts: Array<Record<string, unknown> | undefined>;
} {
  const rec = opts.execFn as { calls?: string[]; opts?: Array<Record<string, unknown> | undefined> };
  return { calls: rec?.calls ?? [], opts: rec?.opts ?? [] };
}

/** One raw JSON line to a socket, returning the parsed reply line. */
export function askRaw(socketPath: string, line: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const conn = createConnection(socketPath, () => conn.write(line));
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      conn.destroy();
      try {
        resolve(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      } catch (err) {
        reject(err as Error);
      }
    });
    conn.on("error", reject);
    const timer = setTimeout(() => {
      conn.destroy();
      reject(new Error("the broker did not answer"));
    }, 8_000);
    timer.unref();
  });
}
