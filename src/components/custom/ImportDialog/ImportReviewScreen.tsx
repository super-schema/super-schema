"use client";

import { useState } from "react";
import { pluralize } from "@/lib/pluralize";
import { Trash2 } from "lucide-react";
import type { ParsedEntity, ParsedField } from "@/lib/importers/types";
import { ConfidenceBadge } from "./ConfidenceBadge";

interface ImportReviewScreenProps {
  parsedEntity: ParsedEntity;
  warnings: string[];
  onConfirm: (entity: ParsedEntity, domainId: string) => void;
  onCancel: () => void;
  domains: { id: string; name: string }[];
}

export function ImportReviewScreen({
  parsedEntity,
  warnings,
  onConfirm,
  onCancel,
  domains,
}: ImportReviewScreenProps) {
  const [entityName, setEntityName] = useState(parsedEntity.name);
  const [selectedDomainId, setSelectedDomainId] = useState(
    domains[0]?.id || ""
  );
  const [fields, setFields] = useState<ParsedField[]>([...parsedEntity.fields]);

  function removeField(index: number) {
    setFields((prev) => prev.filter((_, i) => i !== index));
  }

  function updateFieldName(index: number, name: string) {
    setFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, name } : f))
    );
  }

  function updateFieldType(index: number, type: string) {
    setFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, type } : f))
    );
  }

  function updateFieldNullable(index: number, nullable: boolean) {
    setFields((prev) =>
      prev.map((f, i) => (i === index ? { ...f, nullable } : f))
    );
  }

  function handleConfirm() {
    onConfirm(
      {
        ...parsedEntity,
        name: entityName,
        fields,
      },
      selectedDomainId
    );
  }

  return (
    <div
      data-testid="import-review-screen"
      className="flex flex-col gap-space-4"
    >
      {/* Entity name + domain */}
      <div className="flex gap-space-3">
        <div className="flex-1">
          <label className="text-caption text-muted-foreground block mb-1">
            Entity Name
          </label>
          <input
            data-testid="import-entity-name"
            type="text"
            value={entityName}
            onChange={(e) => setEntityName(e.target.value)}
            className="w-full bg-muted rounded-lg px-space-3 py-1.5 text-body-small text-foreground outline-none border border-border focus:border-primary"
          />
        </div>
        <div className="w-48">
          <label className="text-caption text-muted-foreground block mb-1">
            Domain
          </label>
          <select
            data-testid="import-domain-selector"
            value={selectedDomainId}
            onChange={(e) => setSelectedDomainId(e.target.value)}
            className="w-full bg-muted rounded-lg px-space-3 py-1.5 text-body-small text-foreground outline-none border border-border focus:border-primary"
          >
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Source format badge */}
      <div className="flex items-center gap-space-2">
        <span className="text-caption text-muted-foreground">
          Source format:
        </span>
        <span className="text-caption font-medium bg-muted px-2 py-0.5 rounded">
          {parsedEntity.sourceFormat}
        </span>
        <span className="text-caption text-muted-foreground">
          {pluralize(fields.length, "field")}
        </span>
      </div>

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="bg-warning/10 border border-warning/30 rounded-lg p-space-3">
          <p className="text-caption font-medium text-warning mb-1">
            Warnings
          </p>
          {warnings.map((w, i) => (
            <p key={i} className="text-caption text-muted-foreground">
              {w}
            </p>
          ))}
        </div>
      )}

      {/* Fields table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="surface-1 border-b border-border">
              <th className="text-caption text-muted-foreground text-left px-space-3 py-2">
                Name
              </th>
              <th className="text-caption text-muted-foreground text-left px-space-3 py-2">
                Type
              </th>
              <th className="text-caption text-muted-foreground text-center px-space-3 py-2">
                Nullable
              </th>
              <th className="text-caption text-muted-foreground text-center px-space-3 py-2">
                Confidence
              </th>
              <th className="text-caption text-muted-foreground text-left px-space-3 py-2">
                Description
              </th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {fields.map((field, index) => (
              <tr
                key={index}
                className="border-b border-border last:border-0 hover:bg-accent/30"
              >
                <td className="px-space-3 py-1.5">
                  <input
                    type="text"
                    value={field.name}
                    onChange={(e) => updateFieldName(index, e.target.value)}
                    className="bg-transparent text-mono-small text-foreground outline-none w-full"
                  />
                </td>
                <td className="px-space-3 py-1.5">
                  <input
                    type="text"
                    value={field.type}
                    onChange={(e) => updateFieldType(index, e.target.value)}
                    className="bg-transparent text-mono-small text-foreground outline-none w-full"
                  />
                  {(field.referencedEntityName || field.arrayElementType) && (
                    <span className="block text-caption text-muted-foreground">
                      {field.type === "array"
                        ? `items: ${
                            field.arrayElementType === "reference"
                              ? `→ ${field.referencedEntityName ?? "?"}`
                              : field.arrayElementType ?? "?"
                          }`
                        : field.referencedEntityName
                          ? `→ ${field.referencedEntityName}`
                          : ""}
                    </span>
                  )}
                </td>
                <td className="px-space-3 py-1.5 text-center">
                  <input
                    type="checkbox"
                    checked={field.nullable}
                    onChange={(e) =>
                      updateFieldNullable(index, e.target.checked)
                    }
                    className="accent-primary"
                  />
                </td>
                <td className="px-space-3 py-1.5 text-center">
                  <ConfidenceBadge
                    confidence={field.confidence}
                    originalType={field.originalType}
                    mappedType={field.type}
                  />
                </td>
                <td className="px-space-3 py-1.5">
                  <span className="text-caption text-muted-foreground truncate block max-w-[200px]">
                    {field.description || "-"}
                  </span>
                </td>
                <td className="px-space-2 py-1.5">
                  <button
                    onClick={() => removeField(index)}
                    className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-space-2">
        <button
          onClick={onCancel}
          className="px-4 py-1.5 rounded-lg text-body-small text-muted-foreground hover:bg-accent animate-field-hover"
        >
          Cancel
        </button>
        <button
          data-testid="confirm-import-button"
          onClick={handleConfirm}
          disabled={!entityName.trim() || fields.length === 0 || !selectedDomainId}
          className="px-4 py-1.5 rounded-lg text-body-small bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Confirm Import
        </button>
      </div>
    </div>
  );
}
