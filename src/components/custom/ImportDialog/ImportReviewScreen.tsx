"use client";

import { useState } from "react";
import { pluralize } from "@/lib/pluralize";
import { Trash2 } from "lucide-react";
import type { ParsedEntity, ParsedField } from "@/lib/importers/types";
import { ConfidenceBadge } from "./ConfidenceBadge";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
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
      prev.map((f, i) => (i === index ? { ...f, nullable, ...(nullable ? {} : { nullableType: undefined, requiredNullable: undefined }) } : f))
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
          <NativeSelect
            data-testid="import-domain-selector"
            value={selectedDomainId}
            onChange={(e) => setSelectedDomainId(e.target.value)}
            className="w-full"
          >
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </NativeSelect>
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
        <Table>
          <TableHeader>
            <TableRow className="surface-1 hover:bg-transparent">
              <TableHead className="text-caption text-muted-foreground">
                Name
              </TableHead>
              <TableHead className="text-caption text-muted-foreground">
                Type
              </TableHead>
              <TableHead className="text-caption text-muted-foreground text-center">
                Nullable
              </TableHead>
              <TableHead className="text-caption text-muted-foreground text-center">
                Confidence
              </TableHead>
              <TableHead className="text-caption text-muted-foreground">
                Description
              </TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((field, index) => (
              <TableRow key={index}>
                <TableCell>
                  <input
                    type="text"
                    value={field.name}
                    onChange={(e) => updateFieldName(index, e.target.value)}
                    className="bg-transparent text-mono-small text-foreground outline-none w-full"
                  />
                </TableCell>
                <TableCell>
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
                </TableCell>
                <TableCell className="text-center">
                  <Checkbox
                    checked={field.nullable}
                    onChange={(e) =>
                      updateFieldNullable(index, e.target.checked)
                    }
                  />
                </TableCell>
                <TableCell className="text-center">
                  <ConfidenceBadge
                    confidence={field.confidence}
                    originalType={field.originalType}
                    mappedType={field.type}
                  />
                </TableCell>
                <TableCell>
                  <span className="text-caption text-muted-foreground truncate block max-w-[200px]">
                    {field.description || "-"}
                  </span>
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => removeField(index)}
                    aria-label={`Remove field ${field.name}`}
                    className="text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-space-2">
        <Button
          variant="ghost"
          onClick={onCancel}
          className="text-muted-foreground"
        >
          Cancel
        </Button>
        <Button
          data-testid="confirm-import-button"
          onClick={handleConfirm}
          disabled={!entityName.trim() || fields.length === 0 || !selectedDomainId}
        >
          Confirm Import
        </Button>
      </div>
    </div>
  );
}
