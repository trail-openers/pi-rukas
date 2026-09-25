/**
 * Transcript-preview truncation limits (chars), shared with the dispatch
 * deck's live view (dispatch-deck-live.ts) so the two surfaces truncate the
 * same transcript content identically. `summariseTranscript`'s tool-result
 * previews use TOOL_RESULT_PREVIEW_MAX; `renderTranscript`'s tool-call arg
 * preview uses TOOL_ARGS_PREVIEW_MAX (after JSON.stringify, before newline
 * handling) and its tool-result line uses TOOL_RESULT_PREVIEW_MAX (after
 * newline collapse). The live view additionally caps assistant text at
 * 400 chars (its own LIVE_TEXT_MAX — PM decision 5; runs.ts accumulates
 * assistant text in full and only trims at render).
 */
export const TOOL_RESULT_PREVIEW_MAX = 400;
export const TOOL_ARGS_PREVIEW_MAX = 240;
/** `renderTranscript`'s tool-result line preview (after `replaceAll("\n", " ")`). */
export const TOOL_RESULT_LINE_MAX = 200;
