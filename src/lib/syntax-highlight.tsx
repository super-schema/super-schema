/**
 * Shared syntax highlighting for code previews.
 *
 * Provides line-level tokenizers for SQL, JSON, and YAML that return
 * React nodes with Tailwind CSS color classes.
 *
 * Color palette matches TypeSpecPreview's existing scheme:
 * - Keywords: text-blue-400
 * - Types/builtins: text-cyan-400
 * - Strings: text-green-400
 * - Numbers: text-amber-400
 * - Comments: text-muted-foreground/60 italic
 * - Decorators/special: text-purple-400
 *
 * Pure functions — no side effects.
 */

import React from "react";

// ---------------------------------------------------------------------------
// SQL highlighting (BigQuery, Spanner DDL)
// ---------------------------------------------------------------------------

const SQL_KEYWORDS = new Set([
  "CREATE", "TABLE", "NOT", "NULL", "PRIMARY", "KEY", "PARTITION", "BY",
  "CLUSTER", "INTERLEAVE", "IN", "PARENT", "ON", "DELETE", "CASCADE",
  "OPTIONS", "OR", "REPLACE", "IF", "EXISTS", "AS", "SELECT", "FROM",
  "WHERE", "AND", "SET", "DEFAULT", "ALTER", "ADD", "DROP", "COLUMN",
  "FOREIGN", "REFERENCES", "INDEX", "UNIQUE", "CHECK", "CONSTRAINT",
  "INSERT", "INTO", "VALUES", "UPDATE", "MAX",
]);

const SQL_TYPES = new Set([
  "STRING", "BYTES", "INT64", "FLOAT64", "FLOAT32", "NUMERIC", "BIGNUMERIC",
  "BOOL", "BOOLEAN", "DATE", "TIME", "DATETIME", "TIMESTAMP",
  "STRUCT", "ARRAY", "JSON", "GEOGRAPHY",
]);

export function highlightSQL(line: string): React.ReactNode {
  // Full-line comment
  if (line.trimStart().startsWith("--")) {
    return <span className="text-muted-foreground/60 italic">{line}</span>;
  }

  const tokens: React.ReactNode[] = [];
  // Tokenize: words, strings, numbers, punctuation
  const regex = /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b|[^\s\w]+|\s+)/g;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(line)) !== null) {
    const token = match[0];
    const upper = token.toUpperCase();

    if (token.startsWith("'") || token.startsWith('"')) {
      tokens.push(<span key={key++} className="text-green-400">{token}</span>);
    } else if (/^\d+(?:\.\d+)?$/.test(token)) {
      tokens.push(<span key={key++} className="text-amber-400">{token}</span>);
    } else if (SQL_KEYWORDS.has(upper)) {
      tokens.push(<span key={key++} className="text-blue-400 font-medium">{token}</span>);
    } else if (SQL_TYPES.has(upper)) {
      tokens.push(<span key={key++} className="text-cyan-400">{token}</span>);
    } else {
      tokens.push(<span key={key++}>{token}</span>);
    }
  }

  return <>{tokens}</>;
}

// ---------------------------------------------------------------------------
// JSON highlighting
// ---------------------------------------------------------------------------

export function highlightJSON(line: string): React.ReactNode {
  const tokens: React.ReactNode[] = [];
  // Tokenize: strings, numbers, booleans/null, brackets, other
  const regex = /("(?:[^"\\]|\\.)*"|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b|[{}[\]:,]|\s+|[^\s"{}[\]:,]+)/g;
  let match: RegExpExecArray | null;
  let key = 0;
  let expectValue = false;

  while ((match = regex.exec(line)) !== null) {
    const token = match[0];

    if (token.startsWith('"')) {
      // Check if this is a key (followed by `:`) or value
      const remaining = line.substring(regex.lastIndex).trimStart();
      if (remaining.startsWith(":") && !expectValue) {
        tokens.push(<span key={key++} className="text-blue-400">{token}</span>);
      } else {
        tokens.push(<span key={key++} className="text-green-400">{token}</span>);
        expectValue = false;
      }
    } else if (/^\d/.test(token)) {
      tokens.push(<span key={key++} className="text-amber-400">{token}</span>);
      expectValue = false;
    } else if (token === "true" || token === "false" || token === "null") {
      tokens.push(<span key={key++} className="text-purple-400">{token}</span>);
      expectValue = false;
    } else if (token === ":") {
      tokens.push(<span key={key++}>{token}</span>);
      expectValue = true;
    } else if (token === "," || token === "{" || token === "}" || token === "[" || token === "]") {
      tokens.push(<span key={key++}>{token}</span>);
      if (token === ",") expectValue = false;
    } else {
      tokens.push(<span key={key++}>{token}</span>);
    }
  }

  return <>{tokens}</>;
}

// ---------------------------------------------------------------------------
// YAML highlighting
// ---------------------------------------------------------------------------

export function highlightYAML(line: string): React.ReactNode {
  // Full-line comment
  if (line.trimStart().startsWith("#")) {
    return <span className="text-muted-foreground/60 italic">{line}</span>;
  }

  // Key: value pattern
  const kvMatch = line.match(/^(\s*)([\w$"'/.@-]+)(\s*:\s*)(.*)?$/);
  if (kvMatch) {
    const [, indent, key, colon, value] = kvMatch;
    const tokens: React.ReactNode[] = [];
    tokens.push(<span key="i">{indent}</span>);
    tokens.push(<span key="k" className="text-blue-400">{key}</span>);
    tokens.push(<span key="c">{colon}</span>);

    if (value !== undefined && value.length > 0) {
      tokens.push(highlightYAMLValue(value));
    }

    return <>{tokens}</>;
  }

  // List item: - value
  const listMatch = line.match(/^(\s*-\s+)(.*)?$/);
  if (listMatch) {
    return (
      <>
        <span>{listMatch[1]}</span>
        {listMatch[2] && highlightYAMLValue(listMatch[2])}
      </>
    );
  }

  return <span>{line}</span>;
}

function highlightYAMLValue(value: string): React.ReactNode {
  const trimmed = value.trim();

  // Inline comment
  const commentIdx = trimmed.indexOf(" #");
  if (commentIdx !== -1) {
    const actualValue = trimmed.substring(0, commentIdx);
    const comment = trimmed.substring(commentIdx);
    return (
      <>
        {highlightYAMLValue(actualValue)}
        <span className="text-muted-foreground/60 italic">{comment}</span>
      </>
    );
  }

  // Quoted string
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return <span className="text-green-400">{value}</span>;
  }

  // Boolean
  if (trimmed === "true" || trimmed === "false") {
    return <span className="text-purple-400">{value}</span>;
  }

  // Null
  if (trimmed === "null" || trimmed === "~") {
    return <span className="text-purple-400">{value}</span>;
  }

  // Number
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return <span className="text-amber-400">{value}</span>;
  }

  // $ref or special
  if (trimmed.startsWith("$ref") || trimmed.startsWith("#/")) {
    return <span className="text-green-400">{value}</span>;
  }

  return <span>{value}</span>;
}

// ---------------------------------------------------------------------------
// Language dispatcher
// ---------------------------------------------------------------------------

export function highlightLine(line: string, language: string): React.ReactNode {
  switch (language) {
    case "sql":
      return highlightSQL(line);
    case "json":
      return highlightJSON(line);
    case "yaml":
      return highlightYAML(line);
    default:
      return <span>{line}</span>;
  }
}
