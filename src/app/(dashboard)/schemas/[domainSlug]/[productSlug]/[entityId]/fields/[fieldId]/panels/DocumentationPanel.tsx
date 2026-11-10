"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { FieldGroup } from "@/components/ui/field";
import { AttributeControl } from "@/components/custom/FieldAttributes/AttributeControl";
import { Markdown } from "@/features/events/builder/template/markdown";
import { getTypeInfo } from "@/lib/data-types";
import { valueConstraintErrors } from "@/lib/field-attributes";
import {
  previewLiteral,
  defaultInput,
} from "@/lib/compiler/typed-value-literal";
import type {
  Documentation,
  ValidationConstraints,
} from "@/types/schemas/typespec-decorator.schema";

interface Props {
  validation?: ValidationConstraints;
  documentation: Documentation;
  fieldType: string;
  onChange: (value: Documentation) => void;
  description?: string;
  onDescriptionChange?: (value: string) => void;
  legacyDocumentation?: unknown;
}
export function DocumentationPanel({
  documentation,
  fieldType,
  validation,
  onChange,
  description = "",
  onDescriptionChange,
  legacyDocumentation,
}: Props) {
  const [preview, setPreview] = useState(false);
  const [typedExample, setTypedExample] = useState<{
    stored: unknown;
    text: string;
  } | null>(null);
  const example = documentation.example;
  const exampleText =
    typedExample && typedExample.stored === example
      ? typedExample.text
      : example == null
        ? ""
        : typeof example === "object"
          ? JSON.stringify(example, null, 2)
          : String(example);
  const examplePreview =
    example != null ? previewLiteral(example, fieldType) : undefined;
  function update(value: Partial<Documentation>) {
    onChange({ ...documentation, ...value });
  }
  const history = Array.isArray(legacyDocumentation)
    ? (legacyDocumentation.filter((v) => v && typeof v.text === "string") as {
        source: string;
        text: string;
      }[])
    : [];
  return (
    <FieldGroup>
      {onDescriptionChange && (
        <>
          <AttributeControl
            label="Description"
            help="One description shared by both editors and generated schemas. Markdown is supported."
          >
            <Textarea
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              rows={4}
            />
          </AttributeControl>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={preview}
            onClick={() => setPreview(!preview)}
          >
            {preview ? "Hide preview" : "Preview description"}
          </Button>
          {preview && (
            <div
              className="min-w-0 break-words rounded-md border border-border p-3"
              aria-label="Description preview"
            >
              <Markdown source={description || "No description"} />
            </div>
          )}
        </>
      )}
      {history.length > 0 && (
        <details className="min-w-0 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            Preserved previous documentation ({history.length})
          </summary>
          {history.map((entry, i) => (
            <p className="whitespace-pre-wrap break-words py-2" key={i}>
              {entry.text}
            </p>
          ))}
        </details>
      )}
      <AttributeControl
        label="Example"
        help="An example documents a value; it does not supply a default."
        error={
          examplePreview && !examplePreview.ok
            ? examplePreview.reason
            : valueConstraintErrors(example, fieldType, validation).join(" ") ||
              undefined
        }
      >
        <Textarea
          value={exampleText}
          rows={typeof example === "object" && example != null ? 4 : 2}
          spellCheck={false}
          onChange={(e) => {
            const text = e.target.value;
            let value: unknown = text || null;
            if (text && !["string", "url", "enum"].includes(fieldType)) {
              const numeric =
                getTypeInfo(fieldType)?.category === "Number"
                  ? defaultInput(text, fieldType)
                  : undefined;
              if (numeric?.status === "value") value = numeric.value;
              else {
                try {
                  value = JSON.parse(text);
                } catch {
                  value = text;
                }
              }
            }
            setTypedExample({ stored: value, text });
            update({ example: value });
          }}
        />
      </AttributeControl>
      {examplePreview?.ok && (
        <code className="break-all text-xs text-muted-foreground">
          {examplePreview.text}
        </code>
      )}
      <AttributeControl label="External documentation URL">
        <Input
          type="url"
          value={documentation.externalDocsUrl ?? ""}
          onChange={(e) => update({ externalDocsUrl: e.target.value || null })}
          placeholder="https://docs.example.com/field"
        />
      </AttributeControl>
      <AttributeControl label="External documentation label">
        <Input
          value={documentation.externalDocsDescription ?? ""}
          onChange={(e) =>
            update({ externalDocsDescription: e.target.value || null })
          }
        />
      </AttributeControl>
    </FieldGroup>
  );
}

export function DescriptionEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <FieldGroup>
      <AttributeControl
        label="Description"
        help="Shared with generated schemas. Markdown is supported."
      >
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
        />
      </AttributeControl>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={preview}
        onClick={() => setPreview(!preview)}
      >
        {preview ? "Hide description preview" : "Preview description"}
      </Button>
      {preview && (
        <div aria-label="Description preview" className="min-w-0 break-words">
          <Markdown source={value || "No description"} />
        </div>
      )}
    </FieldGroup>
  );
}
