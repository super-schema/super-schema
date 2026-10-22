/**
 * Which editor shows a schema text in the Schema Workbench: CodeMirror (JSON / YAML, which `JsonEditor` supports) or, for the
 * formats it has no language for (Protobuf, TypeSpec, SQL DDL), a textarea with a coloured layer behind it.
 */

export type EditorKind =
  | { kind: "codemirror"; language: "json" | "yaml" }
  | { kind: "overlay"; highlight: "sql" | "code" };

export function sameKind(a: EditorKind, b: EditorKind): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "codemirror" ? a.language === (b as typeof a).language : a.highlight === (b as typeof a).highlight;
}

const SNIFF_CHARS = 2000;

/** First line of `text` that is not blank and not a `#` / `//` / `--` comment (YAML, Protobuf/TypeSpec and SQL comments). */
function firstCodeLine(head: string): string {
  for (const line of head.split("\n")) {
    const t = line.trim();
    if (t !== "" && !t.startsWith("#") && !t.startsWith("//") && !t.startsWith("--") && !t.startsWith("/*")) return t;
  }
  return "";
}

const CODE_START =
  /^(syntax\s*=|package\s|message\s|service\s|option\s|model\s|namespace\s|using\s|alias\s|union\s|interface\s|scalar\s|op\s|@\w+|import\s+["'])/;
const SQL_START = /^(create|alter|drop)\s/i;

/** The editor for `text`; `format` is the detected or chosen format when known (null while it is not, as when pasting). */
export function editorKindFor(format: string | null | undefined, text: string): EditorKind {
  if (format === "protobuf" || format === "typespec") return { kind: "overlay", highlight: "code" };
  if (format === "bigquery-ddl") return { kind: "overlay", highlight: "sql" };

  const head = text.slice(0, SNIFF_CHARS);
  const first = firstCodeLine(head);
  if (first === "" || first.startsWith("{") || first.startsWith("[")) return { kind: "codemirror", language: "json" };
  if (format === null || format === undefined) {
    if (CODE_START.test(first)) return { kind: "overlay", highlight: "code" };
    if (SQL_START.test(first)) return { kind: "overlay", highlight: "sql" };
  }
  return { kind: "codemirror", language: "yaml" };
}
