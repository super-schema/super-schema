/**
 * Metadata attributes in TypeSpec TEXT (a stored or frozen source, which the event payload renderer compiles as is): strip the extension
 * decorators of given keys, and read the model-level extension values of one model.
 *
 * Decorators are found with TypeSpec's OWN parser (`DecoratorExpression` / `AugmentDecoratorStatement` nodes), the one the compiler reads the
 * source with, so whatever spacing, comments or qualification a decorator is written with, the set seen here is the set that would be
 * applied. A hand-written scanner was bypassable (a line break or a comment before `(`, spaces around `.`). Pure.
 */

import { parse, SyntaxKind, visitChildren, type Node, type TypeSpecScriptNode } from "@typespec/compiler/ast";
import { tryParseTypeSpecValueLiteral } from "@/lib/compiler/governance-decorators";

/** The internal metadata attributes of a source could not be removed safely: the source must not be compiled for a target output. */
export class MetadataStripError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetadataStripError";
  }
}

/** An argument expression (only its kind, span and, for a string literal, its value are read). */
type Expression = Node & { value?: unknown };

interface DecoratorNodeLike {
  kind: SyntaxKind;
  pos: number;
  end: number;
  target: Node & { sv?: string; id?: { sv: string } };
  arguments: readonly Expression[];
}

/** One `…extension(...)` decorator (any qualification) or augment decorator, as the parser sees it. */
interface ExtensionDecorator {
  pos: number;
  end: number;
  /** The key when the key argument is a plain string literal; undefined for anything else (an identifier, a template, ...). */
  key: string | undefined;
  /** The value argument. */
  value: Expression | undefined;
  augment: boolean;
}

/** The name a decorator target ends in (`extension` for `@extension`, `@TypeSpec . JsonSchema . extension`, `@@OpenAPI.extension`). */
function targetName(target: DecoratorNodeLike["target"]): string | undefined {
  if (target.kind === SyntaxKind.Identifier) return target.sv;
  if (target.kind === SyntaxKind.MemberExpression) return target.id?.sv;
  return undefined;
}

function toExtension(node: DecoratorNodeLike, augment: boolean): ExtensionDecorator | undefined {
  if (targetName(node.target) !== "extension") return undefined;
  const [keyArg, value] = node.arguments;
  const key = keyArg && keyArg.kind === SyntaxKind.StringLiteral && typeof keyArg.value === "string" ? keyArg.value : undefined;
  return { pos: node.pos, end: node.end, key, value, augment };
}

interface ParsedSource {
  script: TypeSpecScriptNode;
  extensions: ExtensionDecorator[];
  parseErrors: number;
}

/** The source as the parser sees it, with every extension decorator (augment ones included) in source order; undefined when the parser throws. */
function parseSource(source: string): ParsedSource | undefined {
  try {
    const script = parse(source);
    const extensions: ExtensionDecorator[] = [];
    const visit = (node: Node): void => {
      if (node.kind === SyntaxKind.DecoratorExpression || node.kind === SyntaxKind.AugmentDecoratorStatement) {
        const ext = toExtension(node as unknown as DecoratorNodeLike, node.kind === SyntaxKind.AugmentDecoratorStatement);
        if (ext) extensions.push(ext);
      }
      // The callback must return nothing: a truthy return stops the walk.
      visitChildren(node, visit);
    };
    visit(script);
    extensions.sort((a, b) => a.pos - b.pos);
    return { script, extensions, parseErrors: script.parseDiagnostics.filter((d) => d.severity === "error").length };
  } catch {
    return undefined;
  }
}

/**
 * `source` without every extension decorator whose key is in `keys`: `@…extension("<key>", …)` and the augment form
 * `@@…extension(Target, "<key>", …);`, however written. A decorator alone on its line takes the line with it; every other byte stays. The
 * same string when there are no keys or nothing is removed.
 *
 * Fails CLOSED, throwing {@link MetadataStripError}:
 * - an extension decorator whose key is not a plain string literal (a constant, a string template): its key cannot be proven safe;
 * - a source the parser cannot read (diagnostics, or a parser failure) that mentions one of the keys. One that mentions none passes
 *   through: the compiler rejects it anyway.
 */
export function stripExtensionDecorators(source: string, keys: readonly string[]): string {
  if (keys.length === 0) return source;
  const parsed = parseSource(source);
  const mentioned = keys.filter((k) => source.includes(k));
  if (!parsed || parsed.parseErrors > 0) {
    if (mentioned.length === 0) return source;
    throw new MetadataStripError(`The source mentions the internal metadata attribute(s) ${mentioned.join(", ")} but could not be parsed, so it is not emitted.`);
  }
  const unreadable = parsed.extensions.find((d) => d.key === undefined);
  if (unreadable) {
    throw new MetadataStripError("An extension decorator's key is not a plain string literal, so it cannot be shown not to be an internal metadata attribute; the source is not emitted.");
  }
  const doomed = parsed.extensions.filter((d) => keys.includes(d.key as string));
  if (doomed.length === 0) return source;
  let out = source;
  for (const d of [...doomed].reverse()) {
    const lineStart = out.lastIndexOf("\n", d.pos - 1) + 1;
    const nl = out.indexOf("\n", d.end);
    const lineEnd = nl < 0 ? out.length : nl;
    if (out.slice(lineStart, d.pos).trim() === "" && out.slice(d.end, lineEnd).trim() === "") {
      out = out.slice(0, lineStart) + out.slice(nl < 0 ? lineEnd : lineEnd + 1);
    } else {
      let end = d.end;
      while (end < out.length && /[ \t]/.test(out[end])) end++;
      out = out.slice(0, d.pos) + out.slice(end);
    }
  }
  return out;
}

/** The extension values written on `model <modelName>` itself (its own decorators, not its properties'), by key; the first of a pair wins. */
export function modelExtensionsInSource(source: string, modelName: string): Record<string, unknown> {
  const parsed = parseSource(source);
  if (!parsed) return {};
  let model: (Node & { decorators: readonly DecoratorNodeLike[] }) | undefined;
  const find = (node: Node): void => {
    if (model) return;
    if (node.kind === SyntaxKind.ModelStatement && (node as unknown as { id: { sv: string } }).id.sv === modelName) {
      model = node as unknown as Node & { decorators: readonly DecoratorNodeLike[] };
      return;
    }
    visitChildren(node, find);
  };
  find(parsed.script);
  const out: Record<string, unknown> = {};
  for (const d of model?.decorators ?? []) {
    const ext = toExtension(d, false);
    if (!ext?.key || !ext.value || ext.key in out) continue;
    const literal = tryParseTypeSpecValueLiteral(source.slice(ext.value.pos, ext.value.end));
    if (literal.ok) out[ext.key] = literal.value;
  }
  return out;
}
