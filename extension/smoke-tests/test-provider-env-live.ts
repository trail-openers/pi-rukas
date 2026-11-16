#!/usr/bin/env bun
/**
 * `PI_ENSEMBLE_BASE_URL_<PROVIDER>` / `PI_ENSEMBLE_API_KEY_<PROVIDER>` against
 * the real pi binary: a child loaded the way spawn-support.ts loads one
 * (`--no-extensions` + the child-guards companion) sends its model request to
 * a URL that is only in the environment, carrying a key that is only in the
 * environment, and the key lands in no file the run writes. With the pair
 * unset the same run goes to the `models.json` endpoint with the file's key.
 *
 * Spawns pi, so it is `-live`; it spends no tokens — the "provider" is a local
 * HTTP server that records each request and answers with one short completion.
 */
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { CHILD_GUARDS_PATH } from "../src/child-guards.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

interface Hit {
  port: number;
  url: string;
  auth: string;
}
const hits: Hit[] = [];
function sse(res: import("node:http").ServerResponse) {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({
      id: "c",
      object: "chat.completion.chunk",
      created: 0,
      model: "m",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    `${chunk({ role: "assistant", content: "ok" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`,
  );
}
async function listen(): Promise<number> {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const port = (server.address() as AddressInfo).port;
      hits.push({ port, url: req.url ?? "", auth: String(req.headers.authorization ?? "") });
      sse(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  server.unref();
  return (server.address() as AddressInfo).port;
}

const filePort = await listen();
const envPort = await listen();
const FILE_KEY = "file-key-not-a-secret";
const ENV_KEY = `env-key-${process.pid}-${Date.now()}`;

const root = mkdtempSync(path.join(os.tmpdir(), "provider-env-live-"));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "work");
for (const d of [agentDir, cwd]) mkdirSync(d, { recursive: true });
writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      "proxy-x": {
        baseUrl: `http://127.0.0.1:${filePort}/file/v1`,
        apiKey: FILE_KEY,
        api: "openai-completions",
        models: [{ id: "m" }],
      },
    },
  }),
);

/** Run one child turn (async: the fake provider shares this event loop). */
async function run(extraEnv: Record<string, string>): Promise<{ hits: Hit[]; err: string }> {
  const before = hits.length;
  const env: Record<string, string | undefined> = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_ENSEMBLE_CHILD_CODEMODE: "0",
    ...extraEnv,
  };
  for (const k of Object.keys(env)) if (k.startsWith("PI_ENSEMBLE_SUBAGENT_MODE")) delete env[k];
  const child = spawn(
    process.env.PI_ENSEMBLE_PI_BIN ?? "pi",
    [
      "-p",
      "--no-extensions",
      "--extension",
      CHILD_GUARDS_PATH,
      "--provider",
      "proxy-x",
      "--model",
      "m",
      "say ok",
    ],
    { cwd, env, stdio: ["ignore", "ignore", "pipe"], timeout: 60_000 },
  );
  let err = "";
  child.stderr.on("data", (d) => {
    err += d;
  });
  await new Promise((r) => child.on("close", r));
  return { hits: hits.slice(before), err: err.slice(-400) };
}

// Unset pair: the file is in charge.
const plain = await run({});
assert(plain.hits.length > 0, `unset pair: the request is sent (${plain.err})`);
assert(
  plain.hits.every((h) => h.port === filePort && h.url.startsWith("/file/v1/")),
  "unset pair: the request goes to the models.json baseUrl",
);
assert(
  plain.hits.every((h) => h.auth === `Bearer ${FILE_KEY}`),
  "unset pair: the request carries the models.json key",
);

// Set pair: the environment is in charge, the file untouched.
const modelsBefore = readFileSync(path.join(agentDir, "models.json"), "utf8");
const set = await run({
  PI_ENSEMBLE_BASE_URL_PROXY_X: `http://127.0.0.1:${envPort}/env/v1`,
  PI_ENSEMBLE_API_KEY_PROXY_X: ENV_KEY,
});
assert(set.hits.length > 0, `set pair: the request is sent (${set.err})`);
assert(
  set.hits.every((h) => h.port === envPort && h.url.startsWith("/env/v1/")),
  "set pair: the request reaches the URL that is only in the environment",
);
assert(
  set.hits.every((h) => h.auth === `Bearer ${ENV_KEY}`),
  "set pair: the request carries the key that is only in the environment",
);
assert(
  readFileSync(path.join(agentDir, "models.json"), "utf8") === modelsBefore,
  "set pair: models.json is unchanged",
);

// The key is in no file the run wrote (sessions, settings, logs, auth).
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
const written = [...files(agentDir), ...files(cwd)];
const leaks = written.filter((f) => readFileSync(f, "utf8").includes(ENV_KEY));
assert(written.length > 1, `the run wrote files to scan (${written.length})`);
assert(leaks.length === 0, `the key is in no file the run wrote (${leaks.join(", ")})`);

rmSync(root, { recursive: true, force: true });
process.exit(exit);
