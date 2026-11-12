"use client";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FieldGroup } from "@/components/ui/field";
import { AttributeControl } from "@/components/custom/FieldAttributes/AttributeControl";
import { EnumValuesEditor } from "@/components/custom/FieldAttributes/EnumValuesEditor";
import { legacyEnumSymbols } from "@/lib/field-attributes";
import {
  referencePickChangesNothing,
  applyReferencePick,
  type PickableEntity,
} from "@/lib/references/entity-reference";
import { TypePicker } from "@/components/custom/TypePicker";

export function TypeDetailsPanel({
  type,
  precision,
  scale,
  aliases,
  decorators,
  onChange,
  referenceTargets,
}: {
  referenceTargets?: PickableEntity[];
  type: string;
  precision: number | null;
  scale: number | null;
  aliases: string[];
  decorators: Record<string, unknown>;
  onChange: (v: {
    precision?: number | null;
    scale?: number | null;
    aliases?: string[];
    decorators?: Record<string, unknown>;
  }) => void;
}) {
  const structured = type === "array" || type === "map";
  const ts = (decorators.typespec ?? {}) as {
    validation?: { pattern?: string };
  };
  const legacyValues = legacyEnumSymbols(ts.validation?.pattern);
  const enumValues =
    type === "enum"
      ? aliases.length
        ? aliases
        : legacyValues
      : Array.isArray(decorators.enumValues)
        ? (decorators.enumValues as string[])
        : [];
  function setEnumValues(values: string[]) {
    onChange(
      type === "enum"
        ? { aliases: values }
        : { decorators: { ...decorators, enumValues: values } },
    );
  }
  return (
    <FieldGroup>
      {["decimal", "decimal128", "numeric"].includes(type) && (
        <>
          <AttributeControl
            label="Precision"
            help="Total decimal digits. Target-specific limits are checked during generation."
          >
            <Input
              type="number"
              min={1}
              step={1}
              value={precision ?? ""}
              onChange={(e) =>
                onChange({
                  precision:
                    e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </AttributeControl>
          <AttributeControl
            label="Scale"
            help="Digits after the decimal point; no greater than precision."
          >
            <Input
              type="number"
              min={0}
              step={1}
              value={scale ?? ""}
              onChange={(e) =>
                onChange({
                  scale: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </AttributeControl>
        </>
      )}
      {structured && (
        <AttributeControl
          label={type === "array" ? "Array item type" : "Map value type"}
          group
        >
          <TypePicker
            entities={referenceTargets}
            promptTypes={["reference"]}
            onComplexTypeConfig={(_type, config) =>
              !referencePickChangesNothing(decorators, config) &&
              onChange({
                decorators: {
                  ...applyReferencePick(decorators, config),
                  [type === "array" ? "arrayElementType" : "mapValueType"]:
                    "reference",
                },
              })
            }
            value={String(
              decorators[
                type === "array" ? "arrayElementType" : "mapValueType"
              ] ?? "string",
            )}
            onChange={(value) =>
              onChange({
                decorators: {
                  ...decorators,
                  [type === "array" ? "arrayElementType" : "mapValueType"]:
                    value,
                },
              })
            }
          />
        </AttributeControl>
      )}
      {type === "map" && (
        <AttributeControl
          label="Map key type"
          help="TypeSpec Record keys are strings. Other targets may impose additional restrictions."
        >
          <Input
            value={String(decorators.mapKeyType ?? "string")}
            onChange={(e) =>
              onChange({
                decorators: { ...decorators, mapKeyType: e.target.value },
              })
            }
          />
        </AttributeControl>
      )}
      {type === "enum" ||
      (structured &&
        [decorators.arrayElementType, decorators.mapValueType].includes(
          "enum",
        )) ? (
        <EnumValuesEditor
          label="Enum values"
          itemLabel="value"
          values={enumValues}
          onChange={setEnumValues}
          help="Order is the generated symbol order. Press Enter or type a comma to add; paste a list to add several. Click a value to edit it, or use Alt+Left and Alt+Right to move it."
        />
      ) : (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Advanced aliases
          </summary>
          <div className="pt-3">
            {" "}
            <AttributeControl
              label="Aliases"
              help="One alternative name per line. Interpretation depends on the output target."
            >
              <Textarea
                value={aliases.join("\n")}
                rows={2}
                onChange={(e) =>
                  onChange({
                    aliases: e.target.value ? e.target.value.split("\n") : [],
                  })
                }
                spellCheck={false}
              />
            </AttributeControl>
          </div>
        </details>
      )}
    </FieldGroup>
  );
}
