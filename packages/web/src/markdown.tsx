import React from "react";

export type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; lang: string; code: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; items: Array<{ text: string; checked: boolean | null }> }
  | { kind: "paragraph"; text: string };

export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code block
    const fenceMatch = line.match(/^```(\w*)\s*$/);
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? "";
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      blocks.push({ kind: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      blocks.push({ kind: "heading", level: headingMatch[1].length, text: headingMatch[2].trim() });
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ kind: "quote", text: quoteLines.join("\n") });
      continue;
    }

    // Bullet / task list
    if (/^\s*[-*]\s+/.test(line)) {
      const items: Array<{ text: string; checked: boolean | null }> = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const raw = lines[i].replace(/^\s*[-*]\s+/, "");
        const taskMatch = raw.match(/^\[([ xX])\]\s+(.*)$/);
        if (taskMatch) {
          items.push({ text: taskMatch[2], checked: taskMatch[1].toLowerCase() === "x" });
        } else {
          items.push({ text: raw, checked: null });
        }
        i++;
      }
      blocks.push({ kind: "list", items });
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !/^#{1,4}\s+/.test(lines[i]) &&
      !lines[i].startsWith("> ") &&
      !/^\s*[-*]\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "paragraph", text: paraLines.join("\n") });
  }

  return blocks;
}

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenRegex = /(`[^`]+`|\*\*[^*]+\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s)]+)/g;
  let lastIdx = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(text.slice(lastIdx, match.index));
    }
    const token = match[0];
    if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code key={key++} className="gh-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("[")) {
      nodes.push(
        <a key={key++} href={match[3]} target="_blank" rel="noreferrer" className="gh-link">
          {match[2]}
        </a>,
      );
    } else {
      nodes.push(
        <a key={key++} href={token} target="_blank" rel="noreferrer" className="gh-link">
          {token}
        </a>,
      );
    }
    lastIdx = match.index + token.length;
  }

  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx));
  }
  return nodes;
}

export const MarkdownView: React.FC<{ text: string }> = ({ text }) => {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className="gh-md">
      {blocks.map((b, idx) => {
        if (b.kind === "heading") {
          const Tag = (`h${Math.min(b.level + 1, 5)}` as "h2" | "h3" | "h4" | "h5");
          return (
            <Tag key={idx} className="gh-md-heading">
              {renderInline(b.text)}
            </Tag>
          );
        }
        if (b.kind === "code") {
          return (
            <pre key={idx} className="gh-md-pre">
              <code>{b.code}</code>
            </pre>
          );
        }
        if (b.kind === "quote") {
          return (
            <blockquote key={idx} className="gh-md-quote">
              {renderInline(b.text)}
            </blockquote>
          );
        }
        if (b.kind === "list") {
          return (
            <ul key={idx} className="gh-md-list">
              {b.items.map((item, j) => (
                <li key={j} className={item.checked !== null ? "gh-md-task" : undefined}>
                  {item.checked !== null && (
                    <input type="checkbox" checked={item.checked} readOnly style={{ marginRight: 6 }} />
                  )}
                  <span>{renderInline(item.text)}</span>
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={idx} className="gh-md-p">
            {renderInline(b.text)}
          </p>
        );
      })}
    </div>
  );
};
