"use client";

import { useState } from "react";
import { ArrowLeft, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { TypeGrid } from "./TypeGrid";
import { qualifiedName, type PickableEntity } from "@/lib/references/entity-reference";

export type { PickableEntity };

export interface ComplexTypeConfig {
  /** For array: the element type */
  arrayElementType?: string;
  /** For map: key type */
  mapKeyType?: string;
  /** For map: value type */
  mapValueType?: string;
  /** For reference: entity name */
  referencedEntityName?: string;
  /** For reference: the picked entity's id (absent when only a name was typed) */
  referencedEntityId?: string;
  /** For reference: `domain/product/entity` of the picked entity */
  referencedQualifiedName?: string;
  /** For reference: cardinality */
  referenceCardinality?: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
  /** For enum: list of values */
  enumValues?: string[];
}

interface ComplexTypePromptProps {
  complexType: "array" | "map" | "reference" | "enum";
  onConfirm: (config: ComplexTypeConfig) => void;
  onBack: () => void;
  entities?: PickableEntity[];
}

/** The stored qualified name of a picked entity (`domain/product/entity`), when it carries its domain and product. */
const qualifiedOf = (e: PickableEntity) =>
  e.domain && e.product ? qualifiedName({ domain: e.domain, product: e.product, entity: e.name }) : undefined;

/** How a person reads an entity in the list: `domain / product / entity`. */
const labelOf = (e: PickableEntity) => (e.domain && e.product ? `${e.domain} / ${e.product} / ${e.name}` : e.name);

export function ComplexTypePrompt({
  complexType,
  onConfirm,
  onBack,
  entities = [],
}: ComplexTypePromptProps) {
  return (
    <div className="p-3 space-y-3">
      <button
        onClick={onBack}
        className="flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground transition-colors"
      >
        <ArrowLeft className="w-3 h-3" />
        Back to types
      </button>

      {complexType === "array" && (
        <ArrayPrompt onConfirm={onConfirm} />
      )}
      {complexType === "map" && (
        <MapPrompt onConfirm={onConfirm} />
      )}
      {complexType === "reference" && (
        <ReferencePrompt onConfirm={onConfirm} entities={entities} />
      )}
      {complexType === "enum" && (
        <EnumPrompt onConfirm={onConfirm} />
      )}
    </div>
  );
}

// ── Array Prompt ──────────────────────────────────────────────────────

function ArrayPrompt({ onConfirm }: { onConfirm: (config: ComplexTypeConfig) => void }) {
  const [elementType, setElementType] = useState("string");

  return (
    <div className="space-y-2">
      <label className="text-caption text-foreground font-medium block">
        Element type:
      </label>
      <div className="border border-border/50 rounded-lg overflow-hidden max-h-[240px] overflow-y-auto">
        <TypeGrid
          value={elementType}
          onSelect={setElementType}
          excludeComplex
        />
      </div>
      <Button
        size="sm"
        className="w-full"
        onClick={() => onConfirm({ arrayElementType: elementType })}
      >
        Confirm array&lt;{elementType}&gt;
      </Button>
    </div>
  );
}

// ── Map Prompt ────────────────────────────────────────────────────────

function MapPrompt({ onConfirm }: { onConfirm: (config: ComplexTypeConfig) => void }) {
  const [keyType, setKeyType] = useState("string");
  const [valueType, setValueType] = useState("string");

  const keyTypes = [
    { id: "string", label: "string" },
    { id: "integer", label: "integer" },
  ];

  return (
    <div className="space-y-3">
      <div>
        <label className="text-caption text-foreground font-medium block mb-1">
          Key type:
        </label>
        <div className="flex gap-1">
          {keyTypes.map((kt) => (
            <button
              key={kt.id}
              onClick={() => setKeyType(kt.id)}
              className={`px-3 py-1 rounded text-caption border transition-colors ${
                keyType === kt.id
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border/50 text-muted-foreground hover:border-primary/40"
              }`}
            >
              {kt.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="text-caption text-foreground font-medium block mb-1">
          Value type:
        </label>
        <div className="border border-border/50 rounded-lg overflow-hidden max-h-[200px] overflow-y-auto">
          <TypeGrid
            value={valueType}
            onSelect={setValueType}
            excludeComplex
          />
        </div>
      </div>
      <Button
        size="sm"
        className="w-full"
        onClick={() => onConfirm({ mapKeyType: keyType, mapValueType: valueType })}
      >
        Confirm map&lt;{keyType}, {valueType}&gt;
      </Button>
    </div>
  );
}

// ── Reference Prompt ──────────────────────────────────────────────────

function ReferencePrompt({
  onConfirm,
  entities,
}: {
  onConfirm: (config: ComplexTypeConfig) => void;
  entities: PickableEntity[];
}) {
  const [entityName, setEntityName] = useState("");
  const [picked, setPicked] = useState<PickableEntity | undefined>();
  const [cardinality, setCardinality] = useState<ComplexTypeConfig["referenceCardinality"]>("many-to-one");
  const [searchQuery, setSearchQuery] = useState("");

  const filteredEntities = entities.filter((e) =>
    e.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // A typed name that is exactly one entity's name IS that entity (it is written qualified, with its id). One that several entities
  // share is never guessed: the author picks which from the list, so confirming waits for that. One that matches none stays a plain
  // name, as a legacy reference does.
  const typed = entityName.trim();
  const sameName = picked || !typed ? [] : entities.filter((e) => e.name === typed);
  const resolved = picked ?? (sameName.length === 1 ? sameName[0] : undefined);
  const needsPick = sameName.length > 1;

  const cardinalities: { value: ComplexTypeConfig["referenceCardinality"]; label: string }[] = [
    { value: "one-to-one", label: "1:1" },
    { value: "one-to-many", label: "1:N" },
    { value: "many-to-one", label: "N:1" },
    { value: "many-to-many", label: "N:N" },
  ];

  return (
    <div className="space-y-3">
      <div>
        <label className="text-caption text-foreground font-medium block mb-1">
          Referenced entity:
        </label>
        <Input
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            setEntityName(e.target.value);
            setPicked(undefined);
          }}
          placeholder="Search or type entity name..."
          className="h-7 text-body-small"
        />
        {searchQuery && filteredEntities.length > 0 && (
          <div className="border border-border/50 rounded-lg mt-1 max-h-[120px] overflow-y-auto">
            {filteredEntities.map((e) => (
              <button
                type="button"
                key={e.id}
                data-testid="reference-prompt-candidate"
                aria-pressed={picked?.id === e.id}
                onClick={() => {
                  setEntityName(e.name);
                  setSearchQuery(e.name);
                  setPicked(e);
                }}
                className={`w-full text-left px-2 py-1 text-caption hover:bg-accent/30 transition-colors ${picked?.id === e.id ? "bg-accent/40" : ""}`}
              >
                {labelOf(e)}
              </button>
            ))}
          </div>
        )}
        {needsPick && (
          <p data-testid="reference-prompt-ambiguous" className="mt-1 text-caption text-warning">
            {sameName.length} entities are named &quot;{typed}&quot;. Choose which one from the list.
          </p>
        )}
      </div>
      <div>
        <label className="text-caption text-foreground font-medium block mb-1">
          Cardinality:
        </label>
        <div className="flex gap-1">
          {cardinalities.map((c) => (
            <button
              key={c.value}
              onClick={() => setCardinality(c.value)}
              className={`px-3 py-1 rounded text-caption border transition-colors ${
                cardinality === c.value
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border/50 text-muted-foreground hover:border-primary/40"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <Button
        size="sm"
        className="w-full"
        disabled={!typed || needsPick}
        onClick={() =>
          onConfirm({
            referencedEntityName: typed,
            ...(resolved && { referencedEntityId: resolved.id, referencedQualifiedName: qualifiedOf(resolved) }),
            referenceCardinality: cardinality,
          })
        }
      >
        Confirm ref({entityName || "?"})
      </Button>
    </div>
  );
}

// ── Enum Prompt ───────────────────────────────────────────────────────

function EnumPrompt({ onConfirm }: { onConfirm: (config: ComplexTypeConfig) => void }) {
  const [values, setValues] = useState<string[]>([]);
  const [inputValue, setInputValue] = useState("");

  function addValue() {
    const v = inputValue.trim();
    if (v && !values.includes(v)) {
      setValues((prev) => [...prev, v]);
      setInputValue("");
    }
  }

  function removeValue(val: string) {
    setValues((prev) => prev.filter((v) => v !== val));
  }

  return (
    <div className="space-y-2">
      <label className="text-caption text-foreground font-medium block">
        Enum values:
      </label>
      <div className="flex gap-1">
        <Input
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Add value..."
          className="h-7 text-body-small flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addValue();
            }
          }}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={addValue}
          disabled={!inputValue.trim()}
          className="h-7 px-2"
        >
          <Plus className="w-3 h-3" />
        </Button>
      </div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {values.map((v) => (
            <Badge
              key={v}
              variant="secondary"
              className="text-[10px] h-5 px-1.5 gap-1 font-mono"
            >
              {v}
              <button
                onClick={() => removeValue(v)}
                className="hover:text-destructive transition-colors"
              >
                <X className="w-2.5 h-2.5" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Button
        size="sm"
        className="w-full"
        disabled={values.length === 0}
        onClick={() => onConfirm({ enumValues: values })}
      >
        Confirm enum({values.length} values)
      </Button>
    </div>
  );
}
