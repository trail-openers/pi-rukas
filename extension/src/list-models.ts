import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { trace } from "./trace.ts";

const execFileP = promisify(execFile);

export interface PiModel {
  provider: string;
  model: string;
  id: string; // "<provider>/<model>"
  context?: string;
  maxOut?: string;
  thinking?: string;
  images?: string;
}

/**
 * Run `pi --list-models` and parse the column-aligned table it prints.
 * The first row is the header (provider | model | context | max-out | thinking | images).
 *
 * Pi formats the table with spaces, not tabs, and column widths vary. We split
 * on 2+ whitespace, which is robust across Pi versions.
 *
 * Stream selection: Pi 0.75 wrote the table to stdout; Pi 0.78 writes it to
 * stderr (probably to keep stdout clean for piping). We read both and
 * concatenate so the parser works across both versions without a runtime
 * Pi-version probe.
 */
export async function listAvailableModels(query?: string): Promise<PiModel[]> {
  const args = ["--list-models"];
  if (query) args.push(query);
  let combined = "";
  try {
    const r = await execFileP("pi", args, { maxBuffer: 4 * 1024 * 1024 });
    combined = `${r.stdout}\n${r.stderr}`;
  } catch (err) {
    trace(`list-models: pi --list-models failed: ${(err as Error).message}`);
    return [];
  }
  const rows = combined
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (rows.length < 2) {
    trace(`list-models: too few rows (${rows.length}); first 200 chars: ${combined.slice(0, 200)}`);
    return [];
  }

  // Find the header row — stdout and stderr might be interleaved with our
  // own extension activation traces, so we anchor on the literal column
  // header rather than assuming row 0.
  const headerIdx = rows.findIndex((l) => /^provider\s+model\b/i.test(l));
  if (headerIdx < 0) {
    trace(`list-models: header row not found; rows[0..3]=${JSON.stringify(rows.slice(0, 3))}`);
    return [];
  }

  const out: PiModel[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const line = rows[i];
    if (!line) continue;
    if (line.startsWith("...") || line.includes("No models matching")) continue;
    const cols = line.split(/\s{2,}/);
    if (cols.length < 2) continue;
    const provider = cols[0]?.trim();
    const model = cols[1]?.trim();
    if (!provider || !model) continue;
    out.push({
      provider,
      model,
      id: `${provider}/${model}`,
      context: cols[2]?.trim(),
      maxOut: cols[3]?.trim(),
      thinking: cols[4]?.trim(),
      images: cols[5]?.trim(),
    });
  }
  return out;
}
