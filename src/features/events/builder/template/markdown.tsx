// src/features/events/builder/template/markdown.tsx
// A small, safe Markdown renderer for the preview toggle of a markdown field. It builds React elements from the text, so nothing the
// user types is ever parsed as HTML (no dangerouslySetInnerHTML, no dependency). It understands what AsyncAPI descriptions use:
// paragraphs, headings, **bold**, *italic*, `code`, fenced code blocks, bullet and numbered lists, and links that are http(s) or mailto.
import type { ReactNode } from "react";

/** The URL when it may be linked (an absolute http, https or mailto URL), otherwise `null` (javascript:, data:, relative, ...). */
export function safeHref(url: string): string | null {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? trimmed : null;
  } catch {
    return null;
  }
}

const CODE = /^`([^`\n]+)`/;
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;
const BOLD_STAR = /^\*\*(?=\S)([\s\S]*?\S)\*\*/;
const BOLD_UNDERSCORE = /^__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9])/;
const ITALIC_STAR = /^\*(?=\S)([\s\S]*?\S)\*/;
const ITALIC_UNDERSCORE = /^_(?=\S)([\s\S]*?\S)_(?![A-Za-z0-9])/;

/** Inline elements of one line of text: the first rule that matches at a position wins; anything else is literal text. */
function parseInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let literal = "";
  const flush = () => {
    if (literal) nodes.push(literal);
    literal = "";
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const previous = i > 0 ? text[i - 1] : "";
    const afterWord = /[A-Za-z0-9]/.test(previous);
    let match: RegExpMatchArray | null;
    if ((match = rest.match(CODE))) {
      flush();
      nodes.push(<code key={nodes.length} className="rounded-sm bg-muted px-1 font-mono text-caption">{match[1]}</code>);
    } else if ((match = rest.match(LINK))) {
      flush();
      const href = safeHref(match[2]);
      nodes.push(
        href
          ? <a key={nodes.length} href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">{match[1]}</a>
          : match[1],
      );
    } else if ((match = rest.match(BOLD_STAR)) || (!afterWord && (match = rest.match(BOLD_UNDERSCORE)))) {
      flush();
      nodes.push(<strong key={nodes.length} className="font-semibold">{parseInline(match[1])}</strong>);
    } else if ((match = rest.match(ITALIC_STAR)) || (!afterWord && (match = rest.match(ITALIC_UNDERSCORE)))) {
      flush();
      nodes.push(<em key={nodes.length}>{parseInline(match[1])}</em>);
    } else {
      literal += text[i];
      i += 1;
      continue;
    }
    i += match[0].length;
  }
  flush();
  return nodes;
}

type Block =
  | { type: "p"; text: string }
  | { type: "h"; level: number; text: string }
  | { type: "code"; text: string }
  | { type: "ul" | "ol"; items: string[] };

const FENCE = /^\s*```/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: "p", text: paragraph.join(" ") });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let match: RegExpMatchArray | null;
    if (FENCE.test(line)) {
      endParagraph();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "code", text: code.join("\n") });
    } else if (line.trim() === "") {
      endParagraph();
    } else if ((match = line.match(HEADING))) {
      endParagraph();
      blocks.push({ type: "h", level: match[1].length, text: match[2].trim() });
    } else if (BULLET.test(line) || NUMBERED.test(line)) {
      endParagraph();
      const type = BULLET.test(line) ? "ul" : "ol";
      const pattern = type === "ul" ? BULLET : NUMBERED;
      const items: string[] = [];
      while (i < lines.length && (match = lines[i].match(pattern))) {
        items.push(match[1].trim());
        i += 1;
      }
      i -= 1;
      blocks.push({ type, items });
    } else {
      paragraph.push(line.trim());
    }
  }
  endParagraph();
  return blocks;
}

const HEADING_TAGS = ["h3", "h3", "h4", "h5", "h6", "h6"] as const;

/** Renders Markdown `source` as React elements. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseBlocks(source);
  return (
    <div className={className ?? "space-y-space-2 text-body-small text-foreground"}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case "p":
            return <p key={index}>{parseInline(block.text)}</p>;
          case "h": {
            const Tag = HEADING_TAGS[block.level - 1];
            return <Tag key={index} className="font-semibold">{parseInline(block.text)}</Tag>;
          }
          case "code":
            return (
              <pre key={index} className="overflow-x-auto rounded-md bg-muted p-space-2 font-mono text-caption">
                <code>{block.text}</code>
              </pre>
            );
          case "ul":
            return <ul key={index} className="list-disc space-y-space-1 pl-space-4">{block.items.map((item, i) => <li key={i}>{parseInline(item)}</li>)}</ul>;
          case "ol":
            return <ol key={index} className="list-decimal space-y-space-1 pl-space-4">{block.items.map((item, i) => <li key={i}>{parseInline(item)}</li>)}</ol>;
        }
      })}
    </div>
  );
}
