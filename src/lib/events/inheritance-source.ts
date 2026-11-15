import { parse, SyntaxKind, type ModelStatementNode } from "@typespec/compiler/ast";
import { sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";

/** Preserve the resolved base in canonical source without regenerating the author's own fields or decorators. */
export function withModelBase(source: string, entityName: string, baseName: string): string {
  const models = parse(source).statements.filter((node): node is ModelStatementNode => node.kind === SyntaxKind.ModelStatement);
  const model = models.find((node) => node.id.sv === sanitizeIdentifier(entityName)) ?? (models.length === 1 ? models[0] : undefined);
  if (!model || model.is || model.templateParameters.length > 0) throw new Error("The inherited entity must have an unambiguous, non-generic root model");
  const base = sanitizeIdentifier(baseName);
  if (model.extends) return source.slice(0, model.extends.pos) + base + source.slice(model.extends.end);
  return source.slice(0, model.id.end) + ` extends ${base}` + source.slice(model.id.end);
}

export interface FlattenedField { name: string; owner: string; index: number }

/** Avro and Protobuf have no model inheritance. Flatten only the emission projection, never the frozen canonical source. */
export function flattenModelInheritance(source: string, onFlatten?: (model: string, fields: FlattenedField[]) => void): string {
  const models = parse(source).statements.filter((node): node is ModelStatementNode => node.kind === SyntaxKind.ModelStatement);
  const byName = new Map(models.map((model) => [model.id.sv, model]));
  type Property = ModelStatementNode["properties"][number];
  type Entry = { node: Property; owner: string; index: number };
  const properties = (model: ModelStatementNode, seen: ReadonlySet<string>): Map<string, Entry> => {
    if (seen.has(model.id.sv)) throw new Error("Inheritance cycle in the payload source");
    if (model.is || model.templateParameters.length > 0) throw new Error("This payload base cannot be flattened safely");
    const path = new Set([...seen, model.id.sv]);
    let inherited = new Map<string, Entry>();
    if (model.extends) {
      const base = model.extends;
      if (model.templateParameters.length > 0 || base.kind !== SyntaxKind.TypeReference || base.target.kind !== SyntaxKind.Identifier || base.arguments.length > 0) {
        throw new Error("This payload inheritance cannot be flattened safely");
      }
      const parent = byName.get(base.target.sv);
      if (!parent) throw new Error("The payload's base model is missing from its pinned closure");
      inherited = properties(parent, path);
    }
    model.properties.forEach((node, index) => inherited.set(node.kind === SyntaxKind.ModelProperty ? node.id.sv : `spread:${node.pos}`, { node, owner: model.id.sv, index }));
    return inherited;
  };
  const edits = models.filter((model) => model.extends).map((model) => {
    const flattened = [...properties(model, new Set()).values()];
    onFlatten?.(model.id.sv, flattened.flatMap(({ node, owner, index }) => node.kind === SyntaxKind.ModelProperty ? [{ name: node.id.sv, owner, index }] : []));
    return {
      start: model.id.end,
      end: model.end,
      text: ` {\n${flattened.map(({ node }) => source.slice(node.pos, node.end) + ";").join("\n")}\n}`,
    };
  });
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return source;
}
