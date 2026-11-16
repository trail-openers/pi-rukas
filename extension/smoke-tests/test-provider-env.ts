#!/usr/bin/env bun
/**
 * The offline half of the per-run provider endpoint and key (provider-env.ts):
 * `--capabilities` lists both families at scope `cycle` with the `models.json`
 * providers as `members` and never echoes a key, and an unset pair registers
 * nothing. The request itself is proved against real pi by
 * test-provider-env-live.ts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const agentDir = mkdtempSync(path.join(os.tmpdir(), "provider-env-"));
writeFileSync(
  path.join(agentDir, "models.json"),
  JSON.stringify({ providers: { "proxy-x": { baseUrl: "http://file" }, "lab.box": {} } }),
);
// Members are read when the input list is built, so the dir is set before import.
process.env.PI_CODING_AGENT_DIR = agentDir;
const KEY = "key-value-that-must-not-be-echoed";
process.env.PI_ENSEMBLE_API_KEY_PROXY_X = KEY;
const { agentDir: resolveAgentDir, providerOverrides } = await import("../src/provider-env.ts");
const { buildCapabilities } = await import("../src/headless/capabilities.ts");

const caps = buildCapabilities(path.resolve(import.meta.dirname, "../.."));
for (const name of ["PI_ENSEMBLE_BASE_URL_<PROVIDER>", "PI_ENSEMBLE_API_KEY_<PROVIDER>"]) {
  const entry = caps.inputs.find((i) => i.name === name);
  assert(entry?.type === "string" && entry.scope === "cycle", `${name} is a cycle string input`);
  assert(
    JSON.stringify(entry?.members) === JSON.stringify(["LAB_BOX", "PROXY_X"]),
    `${name} members are the models.json providers (${JSON.stringify(entry?.members)})`,
  );
}
assert(!JSON.stringify(caps).includes(KEY), "the capabilities answer never carries the key");

assert(
  providerOverrides({ PI_CODING_AGENT_DIR: agentDir }).length === 0,
  "an unset pair registers nothing: models.json stays in charge",
);
const set = providerOverrides({
  PI_CODING_AGENT_DIR: agentDir,
  PI_ENSEMBLE_BASE_URL_LAB_BOX: "http://env",
  PI_ENSEMBLE_API_KEY_LAB_BOX: KEY,
});
assert(
  JSON.stringify(set) ===
    JSON.stringify([
      ["lab.box", { baseUrl: "http://env", apiKey: "${PI_ENSEMBLE_API_KEY_LAB_BOX}" }],
    ]),
  `a set pair registers the URL and a reference to the key, never its value (${JSON.stringify(set)})`,
);

// The agent dir is read as Pi reads it: empty is unset, a leading `~` is home.
const home = os.homedir();
assert(
  resolveAgentDir({ PI_CODING_AGENT_DIR: "" }) === path.join(home, ".pi", "agent") &&
    resolveAgentDir({}) === path.join(home, ".pi", "agent"),
  "an empty or absent PI_CODING_AGENT_DIR is the default agent dir",
);
assert(
  resolveAgentDir({ PI_CODING_AGENT_DIR: "~/agent" }) === path.join(home, "agent") &&
    resolveAgentDir({ PI_CODING_AGENT_DIR: "~" }) === home,
  "a leading ~ in PI_CODING_AGENT_DIR is the home dir",
);

rmSync(agentDir, { recursive: true, force: true });
process.exit(exit);
