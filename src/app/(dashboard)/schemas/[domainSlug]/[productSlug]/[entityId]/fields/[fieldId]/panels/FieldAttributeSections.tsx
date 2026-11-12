"use client";
import type { PickableEntity } from "@/lib/references/entity-reference";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion";
import {
  FIELD_ATTRIBUTE_SECTIONS,
  activeValidationKeys,
  evolutionVersions,
  fieldAttributeErrors,
  fieldDeprecation,
  legacyEnumSymbols,
} from "@/lib/field-attributes";
import type {
  Identity,
  TypeSpecDecorators,
} from "@/types/schemas/typespec-decorator.schema";
import { IdentityPanel } from "./IdentityPanel";
import { TypeDetailsPanel } from "./TypeDetailsPanel";
import { DocumentationPanel } from "./DocumentationPanel";
import { ValidationPanel } from "./ValidationPanel";
import {
  GovernancePanel,
  StorageHintsPanel,
  type PolicyContext,
} from "./GovernancePanel";
import { QualityPanel } from "./QualityPanel";
import { VisibilityPanel } from "./VisibilityPanel";
import { WireFormatPanel } from "./WireFormatPanel";
import { ExtensionsPanel } from "./ExtensionsPanel";
import { VersioningPanel } from "./VersioningPanel";

export interface FieldAttributeExtras {
  precision: number | null;
  scale: number | null;
  aliases: string[];
  decorators: Record<string, unknown>;
}
interface Props {
  referenceTargets?: PickableEntity[];
  fieldType: string;
  typespec: TypeSpecDecorators;
  identity: Identity;
  optional: boolean;
  allowNull: boolean;
  classification: string | null;
  fieldNumber: number | null;
  extras: FieldAttributeExtras;
  expanded: number[];
  onExpandedChange: (v: number[]) => void;
  readOnly?: boolean;
  policyContext?: PolicyContext;
  knownVersions?: string[];
  onTypespecChange: (
    key: keyof TypeSpecDecorators,
    value: TypeSpecDecorators[keyof TypeSpecDecorators],
  ) => void;
  onIdentityChange: (v: Identity) => void;
  onOptionalChange: (v: boolean) => void;
  onAllowNullChange: (v: boolean) => void;
  onClassificationChange: (v: string | null) => void;
  onFieldNumberChange: (v: number | null) => void;
  onExtrasChange: (v: Partial<FieldAttributeExtras>) => void;
}
export function FieldAttributeSections(p: Props) {
  const ts = p.typespec;
  const change = p.onTypespecChange;
  const governance = ts.governance ?? {};
  const documentation = {
    ...ts.documentation,
    deprecated: fieldDeprecation({ ...p.extras.decorators, typespec: ts }),
  };
  const errors = fieldAttributeErrors({
    type: p.fieldType,
    ...p.extras,
    fieldNumber: p.fieldNumber,
    decorators: { ...p.extras.decorators, typespec: ts },
  });
  const summaries = [
    [
      p.identity.key ? "Key" : undefined,
      p.optional ? "Optional" : "Required",
      p.allowNull ? "Allows null" : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    ts.documentation?.example != null ? "Example" : "",
    activeValidationKeys(ts.validation, p.fieldType).length ? "Configured" : "",
    governance.qualityRules?.length
      ? `${governance.qualityRules.length} ${governance.qualityRules.length === 1 ? "rule" : "rules"}`
      : "",
    [p.classification, p.identity.secret ? "Secret" : undefined]
      .filter(Boolean)
      .join(" · "),
    ts.visibility?.invisible || ts.visibility?.phases?.length === 0
      ? "Invisible"
      : (ts.visibility?.phases?.join(", ") ?? ""),
    ts.wireFormat?.encode ?? "",
    Object.entries(governance.operationalHints ?? {})
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", "),
    Object.keys(ts.extensions?.openapi ?? {}).length
      ? `${Object.keys(ts.extensions!.openapi!).length} ${Object.keys(ts.extensions!.openapi!).length === 1 ? "entry" : "entries"}`
      : "",
    documentation.deprecated != null
      ? "Deprecated"
      : evolutionVersions([{ decorators: { typespec: ts } }]).join(", "),
  ];
  const panels = [
    <div key="core" className="flex min-w-0 flex-col gap-4">
      <IdentityPanel
        validation={ts.validation}
        identity={p.identity}
        fieldType={p.fieldType}
        isOptional={p.optional}
        allowNull={p.allowNull}
        onIdentityChange={p.onIdentityChange}
        onOptionalChange={p.onOptionalChange}
        onAllowNullChange={p.onAllowNullChange}
      />
      <TypeDetailsPanel
        type={p.fieldType}
        referenceTargets={p.referenceTargets}
        {...p.extras}
        decorators={{ ...p.extras.decorators, typespec: ts }}
        onChange={(v) => {
          if (p.fieldType === "enum" && v.aliases)
            change("validation", { ...ts.validation, pattern: null });
          p.onExtrasChange(v);
        }}
      />
    </div>,
    <DocumentationPanel
      validation={ts.validation}
      key="docs"
      documentation={documentation}
      fieldType={p.fieldType}
      legacyDocumentation={p.extras.decorators.legacyDocumentation}
      onChange={(v) => change("documentation", v)}
    />,
    <ValidationPanel
      key="validation"
      validation={ts.validation ?? {}}
      fieldType={p.fieldType}
      enumSymbolsInPattern={
        p.fieldType === "enum" &&
        p.extras.aliases.length === 0 &&
        legacyEnumSymbols(ts.validation?.pattern).length > 0
      }
      onChange={(v) => change("validation", v)}
    />,
    <QualityPanel
      key="quality"
      governance={governance}
      onChange={(v) => change("governance", v)}
    />,
    <GovernancePanel
      key="governance"
      governance={governance}
      fieldClassification={p.classification}
      onClassificationChange={p.onClassificationChange}
      onChange={(v) => change("governance", v)}
      secret={p.identity.secret}
      onSecretChange={(secret) => p.onIdentityChange({ ...p.identity, secret })}
      policyContext={p.policyContext}
    />,
    <VisibilityPanel
      key="visibility"
      visibility={ts.visibility ?? {}}
      onChange={(v) => change("visibility", v)}
    />,
    <WireFormatPanel
      key="wire"
      wireFormat={ts.wireFormat ?? {}}
      fieldType={p.fieldType}
      fieldNumber={p.fieldNumber}
      onFieldNumberChange={p.onFieldNumberChange}
      onChange={(v) => change("wireFormat", v)}
    />,
    <StorageHintsPanel
      key="storage"
      governance={governance}
      onChange={(v) => change("governance", v)}
    />,
    <ExtensionsPanel
      key="extensions"
      extensions={ts.extensions ?? {}}
      onChange={(v) => change("extensions", v)}
    />,
    <VersioningPanel
      key="evolution"
      versioning={ts.versioning ?? {}}
      versions={
        p.knownVersions ?? evolutionVersions([{ decorators: { typespec: ts } }])
      }
      documentation={documentation}
      onChange={(v) => change("versioning", v)}
      onDocumentationChange={(v) => change("documentation", v)}
      discriminator={p.identity.discriminator}
      onDiscriminatorChange={(discriminator) =>
        p.onIdentityChange({ ...p.identity, discriminator })
      }
    />,
  ];
  return (
    <div className="min-w-0">
      <h2 className="sr-only">Field attributes</h2>
      {errors.length > 0 && (
        <div
          role="alert"
          className="flex flex-col gap-1 px-3 py-2 text-xs text-destructive"
        >
          {errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
      <Accordion
        value={p.expanded}
        onValueChange={(v: number[]) => p.onExpandedChange(v)}
      >
        {FIELD_ATTRIBUTE_SECTIONS.map((label, i) => (
          <AccordionItem value={i} key={label}>
            <AccordionTrigger className="px-3">
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-left">
                {label}
                {summaries[i] && (
                  <Badge
                    aria-hidden="true"
                    variant="outline"
                    className="max-w-full whitespace-normal break-words"
                  >
                    {summaries[i]}
                  </Badge>
                )}
              </span>
            </AccordionTrigger>
            <AccordionContent className="px-3">
              <fieldset disabled={p.readOnly} className="min-w-0 border-0 p-0">
                <legend className="sr-only">{label} settings</legend>
                {panels[i]}
              </fieldset>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}
