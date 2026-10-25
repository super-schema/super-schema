/**
 * Union fields for the targets that have no union: a .proto message field cannot be a union (`@typespec/protobuf/unsupported-field-type`:
 * "a message field's type may not be a union"), and one such field makes the whole entity ungeneratable.
 */

import type { SuperSchemaModel } from "@/types/super-schema-model";

/**
 * The model with every union field (and every array of unions) typed `string`, and one warning per field that says so: the members it
 * cannot keep are named, never dropped in silence. The input is not changed; a model with no union field comes back as it is.
 */
export function withUnionFieldsAsString(model: SuperSchemaModel): { model: SuperSchemaModel; warnings: string[] } {
  const warnings: string[] = [];
  const fields = model.fields.map((field) => {
    const members = (field.complexType?.unionMembers ?? []).join(" | ");
    const of = members === "" ? "" : ` of ${members}`;
    if (field.type === "union") {
      warnings.push(`Field "${field.name}": a union${of}; protobuf has no union field, so it is written as string.`);
      return { ...field, type: "string" as const, complexType: undefined };
    }
    if (field.type === "array" && field.complexType?.arrayElementType === "union") {
      warnings.push(`Field "${field.name}": the items are a union${of}; protobuf has no union field, so they are written as string.`);
      return {
        ...field,
        complexType: { ...field.complexType, arrayElementType: "string", unionName: undefined, unionMembers: undefined },
      };
    }
    return field;
  });
  return warnings.length === 0 ? { model, warnings } : { model: { ...model, fields }, warnings };
}
