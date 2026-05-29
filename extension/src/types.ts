export interface DispatchSpec {
  role: string;
  prompt: string;
  cwd?: string;
  /**
   * Internal-only Pi model id of the form "<provider>/<model>[:thinking]"
   * or a Pi-supported glob like "*sonnet*". Reserved for future internal
   * callers. Agent-callable dispatch tools strip this field at the boundary
   * (see dispatch.ts:stripModelOverride and issue #92) — model choice for
   * subagents is user-authority-only via /ensemble-model and PI_ENSEMBLE_*
   * env vars.
   */
  model?: string;
}

export interface DispatchUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export interface DispatchResult {
  role: string;
  ok: boolean;
  text: string;
  toolUses: unknown[];
  ms: number;
  exitCode: number | null;
  usage?: DispatchUsage;
  /** Model id as reported by Pi (e.g. "zai-glm-4.7", "claude-sonnet-4"). */
  model?: string;
  /** Provider as reported by Pi (e.g. "cerebras", "anthropic"). */
  provider?: string;
  /** API surface as reported by Pi (e.g. "openai-completions", "anthropic-messages"). */
  api?: string;
  /**
   * Path to the child's session file (Pi native session JSON). Open with
   * `pi --session <path>` to resume/replay, or just read the file directly.
   */
  transcriptPath?: string;
  /** Where the spawn picked its model from. */
  modelSource?: "spec" | "config" | "config-default" | "role-env" | "subagent-env" | "default";
}

export interface AdversarialVerdict {
  status: "APPROVED" | "ISSUES_FOUND" | "CRITICAL_ISSUES_FOUND";
  findings: string;
  raw: string;
}
