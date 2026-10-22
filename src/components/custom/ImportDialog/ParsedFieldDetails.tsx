"use client";

/**
 * Shared, presentational "what did the import do with this?" views, used by both import review screens
 * (`FieldPreview` for a single entity, `TypeSpecImportReviewScreen` for several assets).
 *
 * Everything the importer produced is shown, in three labeled groups (the label is the signal; the colour only
 * reinforces it): "Used" (mapped into the model), "Preserved (kept, not interpreted)" (extensions) and
 * "Ignored (not supported)" (standard keywords the importer recognized but cannot map).
 */

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ValidationIndicator } from "@/components/custom/ValidationIndicator";
import { getClassificationConfig } from "@/lib/importers/classification-config";
import type { ImportConfidence, ParsedEntity, ParsedField } from "@/lib/importers/types";

// ---------------------------------------------------------------------------
// Group chrome — success / info / warning tokens, the same ones ConfidenceBadge and ValidationIndicator use.
// ---------------------------------------------------------------------------

type GroupKind = "used" | "preserved" | "ignored";

const GROUP_STYLE: Record<GroupKind, { label: string; box: string; title: string }> = {
  used: { label: "Used", box: "border-success/30 bg-success/5", title: "text-success" },
  preserved: {
    label: "Preserved (kept, not interpreted)",
    box: "border-info/30 bg-info/5",
    title: "text-info",
  },
  ignored: { label: "Ignored (not supported)", box: "border-warning/30 bg-warning/5", title: "text-warning" },
};

function Group({ kind, testId, children }: { kind: GroupKind; testId: string; children: React.ReactNode }) {
  const style = GROUP_STYLE[kind];
  return (
    <section className={`rounded-md border px-2.5 py-1.5 ${style.box}`} data-testid={testId} aria-label={style.label}>
      <h5 className={`text-[11px] font-semibold uppercase tracking-wide mb-1 ${style.title}`}>{style.label}</h5>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-caption">
      <dt className="text-muted-foreground min-w-[7rem]">{label}</dt>
      <dd className="text-foreground font-mono break-all">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confidence + dangling reference
// ---------------------------------------------------------------------------

const CONFIDENCE_STYLE: Record<ImportConfidence, { dot: string; text: string }> = {
  high: { dot: "bg-success", text: "High" },
  medium: { dot: "bg-warning", text: "Medium" },
  low: { dot: "bg-destructive", text: "Low" },
};

function ConfidenceTag({ confidence }: { confidence: ImportConfidence }) {
  const style = CONFIDENCE_STYLE[confidence] ?? CONFIDENCE_STYLE.low;
  return (
    <span className="inline-flex items-center gap-1" data-testid="parsed-field-confidence">
      <span className={`w-2 h-2 rounded-full ${style.dot}`} aria-hidden="true" />
      {style.text} confidence
    </span>
  );
}

/**
 * Dangling reference of a field: the importer's own `danglingRef` marker (URL import) wins; otherwise a
 * low-confidence `reference` whose target is not an entity of this import (when `entityNames` is known).
 */
export function danglingReferenceOf(
  field: ParsedField,
  entityNames?: ReadonlySet<string>,
): { ref: string; reason: string } | undefined {
  if (field.danglingRef) return { ref: field.danglingRef.ref, reason: field.danglingRef.reason };
  const refLike = field.type === "reference" || field.arrayElementType === "reference";
  if (
    refLike &&
    field.confidence === "low" &&
    field.referencedEntityName &&
    entityNames &&
    !entityNames.has(field.referencedEntityName)
  ) {
    return {
      ref: field.referencedEntityName,
      reason: `"${field.referencedEntityName}" is not an entity in this import; it must already exist in the catalog.`,
    };
  }
  return undefined;
}

function DanglingBadge({ dangling }: { dangling: { ref: string; reason: string } }) {
  return (
    <span className="inline-flex items-center gap-1 text-warning" data-testid="parsed-field-dangling">
      <ValidationIndicator status="suggestion" tooltipContent={`${dangling.ref}: ${dangling.reason}`} />
      <span>
        Dangling reference <span className="font-mono">{dangling.ref}</span> — {dangling.reason}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Extension values (pretty JSON; long ones collapsed but always in the DOM)
// ---------------------------------------------------------------------------

const LONG_VALUE_CHARS = 240;
const LONG_VALUE_LINES = 8;

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function ExtensionValue({ name, value }: { name: string; value: unknown }) {
  const text = prettyJson(value);
  const isLong = text.length > LONG_VALUE_CHARS || text.split("\n").length > LONG_VALUE_LINES;
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <pre
        className={`text-[11px] font-mono text-foreground whitespace-pre-wrap break-all ${
          isLong && !expanded ? "max-h-16 overflow-hidden" : ""
        }`}
        data-testid={`parsed-extension-value-${name}`}
        data-collapsed={isLong && !expanded ? "true" : "false"}
      >
        {text}
      </pre>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] text-info hover:underline"
          aria-expanded={expanded}
        >
          {expanded ? "Collapse value" : "Expand value"}
        </button>
      )}
    </div>
  );
}

function ExtensionList({
  extensions,
  classificationKey,
}: {
  extensions: Record<string, unknown>;
  classificationKey?: string;
}) {
  return (
    <ul className="space-y-1">
      {Object.entries(extensions).map(([key, value]) => (
        <li key={key} className="text-caption">
          <span className="font-mono text-foreground">{key}</span>
          {classificationKey === key && (
            <Badge variant="outline" className="ml-1.5 text-[9px] h-3.5">
              raw classification block
            </Badge>
          )}
          <ExtensionValue name={key} value={value} />
        </li>
      ))}
    </ul>
  );
}

function KeywordList({ keywords }: { keywords: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1">
      {keywords.map((keyword) => (
        <li key={keyword}>
          <Badge variant="outline" className="font-mono text-[10px] h-4 border-warning/40 text-warning">
            {keyword}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

const CONSTRAINT_LABEL: Record<string, string> = {
  minLength: "min length",
  maxLength: "max length",
  pattern: "pattern",
  minValue: "min value",
  maxValue: "max value",
  minItems: "min items",
  maxItems: "max items",
};

/** Compact badges for a collapsed field's summary row: nothing here is the only place a fact appears. */
export function ParsedFieldSummaryBadges({
  field,
  entityNames,
}: {
  field: ParsedField;
  entityNames?: ReadonlySet<string>;
}) {
  const dangling = danglingReferenceOf(field, entityNames);
  const preserved = Object.keys(field.extensions ?? {}).length;
  const ignored = field.ignoredKeywords?.length ?? 0;
  return (
    <>
      {field.isKey && (
        <Badge variant="outline" className="text-[9px] h-3.5">
          key
        </Badge>
      )}
      {!field.nullable && (
        <Badge variant="outline" className="text-[9px] h-3.5">
          required
        </Badge>
      )}
      {field.classification && (
        <Badge variant="outline" className="text-[9px] h-3.5">
          {field.classification}
        </Badge>
      )}
      {dangling && (
        <Badge variant="outline" className="text-[9px] h-3.5 border-warning/40 text-warning">
          dangling ref
        </Badge>
      )}
      {preserved > 0 && (
        <Badge variant="outline" className="text-[9px] h-3.5 border-info/40 text-info">
          {preserved} preserved
        </Badge>
      )}
      {ignored > 0 && (
        <Badge variant="outline" className="text-[9px] h-3.5 border-warning/40 text-warning">
          {ignored} ignored
        </Badge>
      )}
    </>
  );
}

interface ParsedFieldDetailsProps {
  field: ParsedField;
  /** Names of the entities in this import; lets a low-confidence reference to a missing one show as dangling. */
  entityNames?: ReadonlySet<string>;
  /** Hide the details visually (they stay in the DOM). */
  collapsed?: boolean;
  /** Entity-level extension key used to tag the raw classification block (defaults to the configured key). */
  classificationKey?: string;
}

export function ParsedFieldDetails({ field, entityNames, collapsed = false, classificationKey }: ParsedFieldDetailsProps) {
  const dangling = danglingReferenceOf(field, entityNames);
  const extensions = field.extensions && Object.keys(field.extensions).length > 0 ? field.extensions : undefined;
  const ignored = field.ignoredKeywords && field.ignoredKeywords.length > 0 ? field.ignoredKeywords : undefined;
  const key = classificationKey ?? getClassificationConfig().extensionKey;
  const typeDiffers = field.originalType && field.originalType !== field.type;

  return (
    <div
      className="space-y-1.5 py-1"
      hidden={collapsed}
      data-testid={`parsed-field-details-${field.name}`}
    >
      <Group kind="used" testId="parsed-field-used">
        <dl className="space-y-0.5">
          <Row label="Name">{field.name}</Row>
          <Row label="Type">{field.type}</Row>
          {typeDiffers && <Row label="Original type">{field.originalType}</Row>}
          <Row label="Required">{field.nullable ? "No (nullable)" : "Yes (required)"}</Row>
          <Row label="Key">{field.isKey ? "Yes" : "No"}</Row>
          {field.description && <Row label="Description">{field.description}</Row>}
          {field.format && <Row label="Format">{field.format}</Row>}
          {field.constraints?.map((c) => (
            <Row key={`${c.type}`} label={`Constraint: ${CONSTRAINT_LABEL[c.type] ?? c.type}`}>
              {String(c.value)}
            </Row>
          ))}
          {field.minValueExclusive !== undefined && (
            <Row label="Exclusive min value">{String(field.minValueExclusive)}</Row>
          )}
          {field.maxValueExclusive !== undefined && (
            <Row label="Exclusive max value">{String(field.maxValueExclusive)}</Row>
          )}
          {field.deprecated && (
            <Row label="Deprecated">{field.deprecatedMessage ? `Yes — ${field.deprecatedMessage}` : "Yes"}</Row>
          )}
          {field.classification && <Row label="Classification">{field.classification}</Row>}
          {field.governance?.dataClass && <Row label="Data class">{field.governance.dataClass}</Row>}
          {field.governance?.dataCategory && <Row label="Data category">{field.governance.dataCategory}</Row>}
          {field.enumName && <Row label="Enum">{field.enumName}</Row>}
          {field.enumValues && field.enumValues.length > 0 && (
            <Row label="Enum values">{field.enumValues.join(", ")}</Row>
          )}
          {field.referencedEntityName && <Row label="References">{field.referencedEntityName}</Row>}
          {field.arrayElementType && <Row label="Array element type">{field.arrayElementType}</Row>}
          {field.mapKeyType && <Row label="Map key type">{field.mapKeyType}</Row>}
          {field.mapValueType && <Row label="Map value type">{field.mapValueType}</Row>}
          {field.unionName && <Row label="Union">{field.unionName}</Row>}
          {field.unionMembers && field.unionMembers.length > 0 && (
            <Row label="Union members">{field.unionMembers.join(" | ")}</Row>
          )}
          {field.fieldNumber != null && <Row label="Field number">{String(field.fieldNumber)}</Row>}
          <Row label="Confidence">
            <ConfidenceTag confidence={field.confidence} />
          </Row>
        </dl>
        {dangling && (
          <div className="mt-1">
            <DanglingBadge dangling={dangling} />
          </div>
        )}
      </Group>

      {extensions && (
        <Group kind="preserved" testId="parsed-field-preserved">
          <ExtensionList extensions={extensions} classificationKey={field.governance?.dataClass ? key : undefined} />
        </Group>
      )}

      {ignored && (
        <Group kind="ignored" testId="parsed-field-ignored">
          <KeywordList keywords={ignored} />
        </Group>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Entity
// ---------------------------------------------------------------------------

interface ParsedEntityDetailsProps {
  entity: Pick<ParsedEntity, "name" | "description" | "extends" | "extensions" | "ignoredKeywords">;
  /** Every warning of the import — all of them, none truncated. */
  warnings?: string[];
  /** Hide the "Used" group (name / description / extends) when the host screen already shows those prominently. */
  showUsed?: boolean;
}

export function ParsedEntityDetails({ entity, warnings = [], showUsed = true }: ParsedEntityDetailsProps) {
  const extensions = entity.extensions && Object.keys(entity.extensions).length > 0 ? entity.extensions : undefined;
  const ignored = entity.ignoredKeywords && entity.ignoredKeywords.length > 0 ? entity.ignoredKeywords : undefined;
  return (
    <div className="space-y-1.5" data-testid="parsed-entity-details">
      {showUsed && (
        <Group kind="used" testId="parsed-entity-used">
          <dl className="space-y-0.5">
            <Row label="Entity name">{entity.name}</Row>
            {entity.description && <Row label="Description">{entity.description}</Row>}
            {entity.extends && <Row label="Extends">{entity.extends}</Row>}
          </dl>
        </Group>
      )}
      {extensions && (
        <Group kind="preserved" testId="parsed-entity-preserved">
          <ExtensionList extensions={extensions} />
        </Group>
      )}
      {ignored && (
        <Group kind="ignored" testId="parsed-entity-ignored">
          <KeywordList keywords={ignored} />
        </Group>
      )}
      {warnings.length > 0 && (
        <div className="rounded-md border border-warning/30 bg-warning/5 p-2 space-y-1" data-testid="import-warnings">
          <h5 className="text-[11px] font-semibold uppercase tracking-wide text-warning">
            Warnings ({warnings.length})
          </h5>
          {warnings.map((warning, index) => (
            <p key={index} className="text-caption text-muted-foreground">
              {warning}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
