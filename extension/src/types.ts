export interface DispatchSpec {
  role: string;
  prompt: string;
  cwd?: string;
  /**
   * Short tag (≤16 chars) disambiguating same-role parallel members in the
   * live dispatch deck (#136). Used by dispatch_parallel only — single
   * dispatch_specialist calls render with the bare role and ignore this.
   * When set: deck row becomes "⏳ developer[task-A] 8s bash". When
   * omitted: dispatch_parallel falls back to "developer#1", "developer#2".
   */
  label?: string;
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
  /**
   * Set when the child exited with `stopReason: "error"` on its final
   * assistant message (provider HTTP timeout, transport failure, etc).
   * Pi turns these into a synthetic empty-content assistant message that
   * looks like a normal completion at the process level (exit 0). Without
   * this signal, the dispatch report mistakes the child's last successful
   * thinking block for the actual reply. When present, the report renders
   * as FAILED-PROVIDER-ERROR (see async-jobs.ts) and the scrollback shows
   * a distinct "terminated mid-stream" warning (see lifecycle-events.ts).
   */
  errorStop?: {
    /** stopReason from the synthetic final assistant message. */
    reason: string;
    /** errorMessage from the synthetic final assistant message, if any. */
    message?: string;
  };
}

export interface AdversarialVerdict {
  status: "APPROVED" | "ISSUES_FOUND" | "CRITICAL_ISSUES_FOUND";
  findings: string;
  raw: string;
}
