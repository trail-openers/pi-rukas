import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
 */
export async function listAvailableModels(query?: string): Promise<PiModel[]> {
  const args = ["--list-models"];
  if (query) args.push(query);
  let stdout = "";
  try {
    const r = await execFileP("pi", args, { maxBuffer: 4 * 1024 * 1024 });
    stdout = r.stdout;
  } catch {
    return [];
  }
  const rows = stdout
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  if (rows.length < 2) return [];

  // Strip any extension-activation stderr that leaked into stdout (defensive).
  const headerIdx = rows.findIndex((l) => /^provider\s+model\b/i.test(l));
  if (headerIdx < 0) return [];

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
