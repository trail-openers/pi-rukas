/**
 * Transcript-preview truncation limits (chars). The consumer is
 * runs-viewer.ts (`/runs`): `summariseTranscript`'s tool-result previews
 * use TOOL_RESULT_PREVIEW_MAX; `renderTranscript`'s tool-call arg preview
 * uses TOOL_ARGS_PREVIEW_MAX (after JSON.stringify, before newline
 * handling) and its tool-result line uses TOOL_RESULT_LINE_MAX (after
 * newline collapse).
 */
export const TOOL_RESULT_PREVIEW_MAX = 400;
export const TOOL_ARGS_PREVIEW_MAX = 240;
/** `renderTranscript`'s tool-result line preview (after `replaceAll("\n", " ")`). */
export const TOOL_RESULT_LINE_MAX = 200;
