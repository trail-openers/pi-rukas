#!/usr/bin/env bun
/**
 * #2160 — what a child may put on the forge-read wire, and what the parent will
 * act on.
 *
 * The broker answers CONTENT with the parent's credential, so the request line
 * is the whole attack surface a stripped child has. Three properties, none of
 * which any other file in this suite asserts:
 *
 *   1. A parsed line is rebuilt, never forwarded. The child's payload is parsed
 *      JSON and the executor reads its options off the object handed to it —
 *      including the seam that decides WHICH factory builds the forge the reads
 *      run through. A key the child invents must therefore never reach it, so
 *      this drives a real bound broker over a real socket with a payload that
 *      carries one: the injected factory is never called, while a plain read on
 *      the same broker still answers.
 *   2. The child cannot name the forge or the directory: what the broker hands
 *      downstream carries no path, slug or identity the payload supplied.
 *   3. The connection is bounded: a request line past the ceiling is refused
 *      rather than buffered.
 *   4. A filter the command builders would not accept (`state`, `sourceBranch`)
 *      is refused at this seam, before the read runs — the broker injects the
 *      read, so a refusal that lived only in the executor would not be visible
 *      here, and these two fields are child-supplied text that reaches the
 *      parent's credentialed command string.
 *
 * The read is injected at the broker's own `runRead` seam, so this judges the
 * BROKER's boundary — what it hands downstream — rather than trusting the
 * executor to refuse for its own reasons.
 */

import { newForgeReadNonce, forgeReadMac } from "../src/forge-read-auth.ts";
import { type RunForgeRead, bindForgeReadSocket } from "../src/forge-read-broker.ts";
import type { ForgeReadRequest } from "../src/forge-read-tool.ts";
import { parseForgeReadRequest } from "../src/forge-read-tool.ts";
import { assert, check, forgeExitCode } from "./lib/forge-harness.ts";

/** One round trip against a broker whose read is this file's stand-in. */
async function probe(
  line: string,
  opts: { timeoutMs?: number; runRead?: RunForgeRead } = {},
): Promise<{ res?: Record<string, unknown>; seen: Seen; closed: boolean }> {
  const seen: Seen = { calls: 0 };
  // The read is ALWAYS injected: these cases judge what the broker hands
  // downstream, and a production read would answer with a forge error before
  // the assertion could see the objects.
  const runRead: RunForgeRead =
    opts.runRead ??
    (async (_cwd, req, execOpts) => {
      seen.req = req;
      seen.opts = execOpts;
      seen.calls++;
      return "answered by the parent's own forge";
    });
  const handle = await bindForgeReadSocket("/parent/repo", {
    ...opts,
    runRead,
    // The key is this probe's own: a line that cannot prove itself is refused
    // before the executor runs, so a case that expects a READ must present a
    // proved request (see `proved`) rather than a bare line.
    secret: opts.secret ?? PROBE_SECRET,
  });
  try {
    return await dial(handle.socketPath, line, seen);
  } finally {
    handle.stop();
  }
}

/** The probe broker's key — shared by every case, which is a probe, not a child. */
const PROBE_SECRET = "0".repeat(64);

/**
 * A proved request line for this file's broker, so a case that judges what the
 * broker hands DOWNSTREAM can get past the authentication gate at all. Proving a
 * line is the transport's job, not this file's subject; the gate itself, the
 * reply's proof, and the refusal of an unproved line are
 * `test-forge-read-auth.ts`'s subject. `obj` is the request the executor will
 * see, so a case that smuggles a key does it HERE and the assertion below still
 * sees whether the broker forwarded it.
 */
function proved(obj: Record<string, unknown>): string {
  const nonce = newForgeReadNonce();
  const unsigned = { ...obj, nonce };
  return `${JSON.stringify({ ...unsigned, auth: forgeReadMac(PROBE_SECRET, nonce, JSON.stringify(unsigned)) })}\n`;
}

interface Seen {
  req?: ForgeReadRequest;
  opts?: Record<string, unknown>;
  calls: number;
}

function dial(
  socketPath: string,
  line: string,
  seen: Seen,
): Promise<{ res?: Record<string, unknown>; seen: Seen; closed: boolean }> {
  return import("node:net").then((net) => {
    return new Promise((resolve, reject) => {
      const conn = net.createConnection(socketPath, () => conn.write(line));
      let buf = "";
      // The broker writes its answer and the child hangs up; the `close` event
      // then arrives on a later tick, sometimes BEFORE the reply is read. So the
      // answer wins whenever it exists, and `closed` is only reported for the
      // case where nothing was ever written — which is the case the oversized-row
      // asserts. Settling once, on the reply or the drop, is what keeps the
      // difference between those two from depending on event order.
      let settled = false;
      const finish = (res?: Record<string, unknown>, closed = false): void => {
        if (settled) return;
        settled = true;
        conn.destroy();
        resolve({ res, seen, closed });
      };
      conn.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl < 0) return;
        try {
          finish(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
        } catch (err) {
          reject(err as Error);
        }
      });
      conn.on("close", () => finish(undefined, true));
      conn.on("error", reject);
      const timer = setTimeout(() => finish(undefined, false), 4000);
      timer.unref();
    });
  });
}

console.log("the request is rebuilt, not forwarded:");
await check("a child-supplied buildForge seam never reaches the executor's options", async () => {
  // THE finding this file exists for. `buildForge` is the options-bag seam that
  // decides which factory builds the forge the reads run through, and the
  // executor calls whatever it finds there. Handing the executor an options
  // object assembled from the request would let this payload put a key in that
  // bag; the broker therefore builds the bag itself, from its own config.
  const { res, seen } = await probe(
    proved({
      type: "forge-read-request",
      verb: "issue_view",
      number: 42,
      buildForge: "child-supplied",
    }),
  );
  assert(seen.calls === 1, "the read ran through the parent's own executor");
  assert(res?.ok === true, `the read succeeded (${JSON.stringify(res)})`);
  assert(
    res?.output === "answered by the parent's own forge",
    `the bytes came from the parent's side (${JSON.stringify(res?.output)})`,
  );
  assert(
    seen.opts !== undefined && Object.keys(seen.opts).every((k) => k === "timeoutMs"),
    `the options bag carries only what the parent put there (${JSON.stringify(Object.keys(seen.opts ?? {}))})`,
  );
  assert(
    seen.req !== undefined && !("buildForge" in (seen.req as unknown as object)),
    `the request object carries no child key (${JSON.stringify(Object.keys(seen.req ?? {}))})`,
  );
});
await check("a child-supplied cwd/owner/repo cannot redirect the read", async () => {
  const { seen } = await probe(
    proved({
      type: "forge-read-request",
      verb: "repo_settings",
      cwd: "/etc",
      owner: "someone-else",
      repo: "someone-elses",
      host: "git.example.com",
    }),
  );
  assert(seen.calls === 1, "the read ran");
  const keys = Object.keys(seen.req ?? {}).sort();
  assert(
    JSON.stringify(keys) === JSON.stringify(["type", "verb"]),
    `what the broker handed downstream names no target the child sent (${JSON.stringify(keys)})`,
  );
});
await check("the caller's bound reaches the executor and the child's does not", async () => {
  const { seen } = await probe(
    proved({ type: "forge-read-request", verb: "repo_settings", timeoutMs: 1 }),
    { timeoutMs: 1234 },
  );
  assert(seen.calls === 1, "the read ran");
  assert(
    seen.opts?.timeoutMs === 1234,
    `the plan's bound is what the executor was offered (${JSON.stringify(seen.opts)})`,
  );
});
await check("only the declared fields survive the parse", () => {
  const req = parseForgeReadRequest(
    JSON.stringify({
      type: "forge-read-request",
      verb: "pr_view",
      number: 17,
      role: "the-child-claims-to-be",
      jobId: "job-1",
      buildForge: () => "nope",
      cwd: "/other/repo",
      execOpts: { timeout: 1 },
    }),
  );
  assert(req !== undefined, "a well-formed line parses");
  const keys = Object.keys(req as object).sort();
  assert(
    JSON.stringify(keys) === JSON.stringify(["number", "type", "verb"]),
    `the request carries the declared fields only (got ${JSON.stringify(keys)})`,
  );
  assert(!(req as unknown as { role?: unknown }).role, "a self-reported role does not cross");
  assert((req as unknown as { number: number }).number === 17, "declared values are kept");
});
await check("a field of the wrong type is dropped, not forwarded", () => {
  const req = parseForgeReadRequest(
    JSON.stringify({
      type: "forge-read-request",
      verb: "ci_run_log",
      // A string id would reach the command builder through `String(...)` and
      // land in a shell string; the validator is the second line of defence and
      // the parse is the first.
      id: "1; touch /tmp/pwned",
      state: 42,
    }),
  );
  assert(req !== undefined, "the line parses");
  assert(!("id" in (req as object)), `a string id is dropped (got ${JSON.stringify(req)})`);
  assert(!("state" in (req as object)), "a non-string state is dropped");
});
await check("a line that is not a request is refused", () => {
  for (const line of ["", "{", "[]", "null", '"str"', '{"verb":"pr_view"}']) {
    assert(parseForgeReadRequest(line) === undefined, `${JSON.stringify(line)} is refused`);
  }
});
await check("a filter the builders would not accept is refused before the read", async () => {
  // `state` and `sourceBranch` are the two child-supplied fields that reach the
  // parent's credentialed command string, so the broker must refuse a value the
  // builders do not accept rather than quote it through to the shell.
  const bad = [
    { verb: "issue_list", state: "x'$(touch /tmp/pwned)" },
    { verb: "pr_list", number: 1, sourceBranch: "--upload-pack=x" },
  ];
  for (const payload of bad) {
    const { res, seen } = await probe(proved({ type: "forge-read-request", ...payload }));
    assert(res?.ok === false, `${JSON.stringify(payload)} refused (${JSON.stringify(res)})`);
    assert(
      /state|sourceBranch/.test(String(res?.reason)),
      `the refusal names the field (${JSON.stringify(res?.reason)})`,
    );
    assert(seen.calls === 0, `${JSON.stringify(payload)} reached no executor`);
  }
});
await check("a refused line answers with a reason, never silence", async () => {
  const { res } = await probe("this is not json\n");
  assert(res?.ok === false, `malformed line refused (${JSON.stringify(res)})`);
  assert(typeof res?.reason === "string" && res.reason.length > 0, "the refusal names a reason");
});

console.log("a connection cannot be held open:");
await check("an oversized request line is refused rather than buffered", async () => {
  const pad = "a".repeat(70 * 1024);
  const { seen, closed } = await probe(`{"type":"forge-read-request","verb":"${pad}`);
  assert(seen.calls === 0, "an oversized line never reaches the executor");
  assert(closed, "the parent dropped the connection instead of buffering it");
});

await forgeExitCode("forge_read wire refuses child-supplied seams and bounds its connections");
