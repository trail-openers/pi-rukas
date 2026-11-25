// noni hook: a standing prompt reminder every turn, plus `noni brief` at session
// start and after each compaction. See README.md for install, limits, race and gate.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
const BRIEF_TIMEOUT_MS = 30_000;
const LINE_LIMIT = 300;
const PATH_TOKEN = /(?:[^\s"'`]+[\\/])+[^\s"'`]+/g;
const REMINDER =
  "noni holds this project's product direction and decisions. Work in the " +
  "order it gives and follow its recorded decisions; do not invent direction. " +
  "When something is undecided, ask the operator and record the answer with " +
  "the noni decide command.";
const CANDIDATES = [".noni-state", ""]; // pilot's dir first, then the bare cwd
// The state root: the env var, else the first candidate holding a noni/ directory.
function stateRoot(env: Record<string, string | undefined>, cwd: string) {
  const fromEnv = env["NONI_STATE_ROOT"];
  if (fromEnv) return fromEnv;
  for (const name of CANDIDATES) {
    const candidate = name ? join(cwd, name) : cwd;
    if (existsSync(join(candidate, "noni"))) return candidate;
  }
  return undefined;
}
// The first stderr line, capped, path tokens replaced by "state root".
function failureLine(reason: string): string {
  const first = reason.split("\n")[0]?.trim() || "no reason given";
  const scrubbed = first.replace(PATH_TOKEN, "state root");
  const line = `noni: could not read the brief (${scrubbed})`;
  return line.length <= LINE_LIMIT ? line : line.slice(0, LINE_LIMIT - 1) + "\u2026";
}
// Why a run printed nothing: a kill, an exit 0, else the stderr head.
function failureReason(r: { code: number; stderr: string; killed: boolean }) {
  if (r.killed) return "timed out";
  if (r.code === 0) return "printed nothing";
  return r.stderr.trim() || `exit code ${r.code}`;
}
export default function noniHook(pi: ExtensionAPI) {
  let pendingBrief: string | undefined;
  let epoch = 0;
  let inflight: Promise<string | undefined> | undefined;  // Returns its text, a failure line, or undefined with no root; never the slot.
  async function fetchBrief(cwd: string) {
    try {
      const root = stateRoot(process.env, cwd);
      if (!root) return undefined;
      const r = await pi.exec("noni", ["brief", "--repo", root], { timeout: BRIEF_TIMEOUT_MS });
      return r.stdout.trim() || failureLine(failureReason(r));
    } catch {
      return failureLine("could not run the brief");
    }
  }
  // The one writer of pendingBrief: epoch numbers each start and only the newest
  // number wins, so a late older fetch is dropped and one brief reaches the model.
  function startBrief(cwd: string) {
    const mine = ++epoch;
    return fetchBrief(cwd).then((text) => {
      if (mine === epoch) pendingBrief = text;
      return text;
    });
  }
  // The gate is the run mode: hasUI is true for RPC too, so only a "tui" run fetches.
  const start = (ctx: { cwd: string; mode: string }) => {
    if (ctx.mode === "tui") inflight = startBrief(ctx.cwd);
  };
  pi.on("session_start", (_e, ctx) => start(ctx));
  pi.on("session_compact", (_e, ctx) => start(ctx));

  pi.on("before_agent_start", async (event) => {
    const options = event.systemPromptOptions;
    const guidelines = options.promptGuidelines ?? [];
    if (!guidelines.includes(REMINDER)) guidelines.push(REMINDER);
    options.promptGuidelines = guidelines;
    if (event.messageType !== "user") return undefined;
    await inflight;
    if (pendingBrief === undefined) return undefined;
    const content = pendingBrief;
    pendingBrief = undefined;
    return { message: { customType: "noni-brief", content, display: true } };
  });
}
