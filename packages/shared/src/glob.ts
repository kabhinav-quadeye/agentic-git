/**
 * Lightweight glob matcher supporting *, **, ?, and {a,b} brace expansion.
 * Used consistently for both git branch patterns and diff file path patterns.
 */
function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match || match.index === undefined) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice(match.index + match[0].length);
  const options = match[1].split(",");
  const results: string[] = [];
  for (const opt of options) {
    for (const expanded of expandBraces(prefix + opt + suffix)) {
      results.push(expanded);
    }
  }
  return results;
}

function singleGlobToRegExp(glob: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // Consume optional following slash so **/ matches zero or more directories
        if (glob[i + 2] === "/") {
          regex += "(?:.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
      } else {
        regex += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regex += "[^/]";
      i += 1;
    } else if (".+^$()|[]\\".includes(ch)) {
      regex += "\\" + ch;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  regex += "$";
  return new RegExp(regex);
}

export function matchGlob(value: string, pattern: string): boolean {
  const normalized = value.replace(/^\/+/, "");
  const normalizedPattern = pattern.replace(/^\/+/, "");
  for (const expanded of expandBraces(normalizedPattern)) {
    if (singleGlobToRegExp(expanded).test(normalized)) {
      return true;
    }
  }
  return false;
}

export function matchAnyGlob(value: string, patterns: string[]): boolean {
  return patterns.some((p) => matchGlob(value, p));
}
