export interface ParsedDiffRow {
  kind: "hunk" | "add" | "del" | "context";
  oldLine: number | null;
  newLine: number | null;
  prefix: string;
  content: string;
}

/**
 * Parses a unified git patch into structured rows with accurate old/new line numbers
 * for authentic GitHub-style unified diff rendering.
 */
export function parseUnifiedPatch(patch: string): ParsedDiffRow[] {
  const lines = patch.replace(/\n$/, "").split("\n");
  const rows: ParsedDiffRow[] = [];
  let oldNum = 0;
  let newNum = 0;
  let inHunk = false;

  for (const raw of lines) {
    if (
      raw.startsWith("diff --git ") ||
      raw.startsWith("index ") ||
      raw.startsWith("--- ") ||
      raw.startsWith("+++ ") ||
      raw.startsWith("new file mode") ||
      raw.startsWith("deleted file mode")
    ) {
      continue;
    }

    const hunkMatch = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunkMatch) {
      inHunk = true;
      oldNum = Number.parseInt(hunkMatch[1], 10);
      newNum = Number.parseInt(hunkMatch[2], 10);
      rows.push({
        kind: "hunk",
        oldLine: null,
        newLine: null,
        prefix: "",
        content: raw,
      });
      continue;
    }

    if (!inHunk && raw === "") continue;

    if (raw.startsWith("+")) {
      rows.push({
        kind: "add",
        oldLine: null,
        newLine: newNum++,
        prefix: "+",
        content: raw.slice(1),
      });
    } else if (raw.startsWith("-")) {
      rows.push({
        kind: "del",
        oldLine: oldNum++,
        newLine: null,
        prefix: "-",
        content: raw.slice(1),
      });
    } else if (raw.startsWith("\\ No newline")) {
      rows.push({
        kind: "hunk",
        oldLine: null,
        newLine: null,
        prefix: "",
        content: raw,
      });
    } else {
      rows.push({
        kind: "context",
        oldLine: oldNum++,
        newLine: newNum++,
        prefix: " ",
        content: raw.startsWith(" ") ? raw.slice(1) : raw,
      });
    }
  }

  return rows;
}
