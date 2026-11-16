"use client";
import { Input } from "@/components/ui/input";
import { FieldGroup, FieldDescription } from "@/components/ui/field";
import { ClassificationPicker } from "@/components/custom/ClassificationPicker";
import { AttributeControl } from "@/components/custom/FieldAttributes/AttributeControl";
import { JsonObjectControl } from "@/components/custom/FieldAttributes/JsonObjectControl";
import type { Governance } from "@/types/schemas/typespec-decorator.schema";

import { NativeSelect } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
export interface PolicyContext {
  source: string;
  retention?: string;
  owner?: string;
}
interface Props {
  governance: Governance;
  onChange: (v: Governance) => void;
  fieldClassification: string | null;
  onClassificationChange: (v: string | null) => void;
  secret?: boolean;
  onSecretChange?: (v: boolean) => void;
  policyContext?: PolicyContext;
}
export function GovernancePanel({
  governance: g,
  onChange,
  fieldClassification,
  onClassificationChange,
  secret,
  onSecretChange,
  policyContext,
}: Props) {
  function update(patch: Partial<Governance>) {
    onChange({ ...g, ...patch });
  }
  const encryption = g.encryptionConfig ?? {};
  function updateEncryption(
    patch: NonNullable<Governance["encryptionConfig"]>,
  ) {
    const next = { ...encryption, ...patch };
    update({
      encryptionConfig: next,
      encryption: next.algorithm || next.scope || next.policyRef || null,
    });
  }
  return (
    <FieldGroup>
      <FieldDescription>
        Classification and protection requirements are metadata used by
        governance checks. Runtime protection is implemented by consuming
        systems.
      </FieldDescription>
      <AttributeControl label="Classification" group>
        <ClassificationPicker
          value={fieldClassification}
          onChange={onClassificationChange}
        />
      </AttributeControl>
      {onSecretChange && (
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={secret ?? false}
            onChange={(e) => onSecretChange(e.target.checked)}
            className="mt-1"
          />
          <span>
            Secret
            <span className="block text-xs text-muted-foreground">
              Marks a sensitive value. This annotation does not itself mask
              logs, redact responses, or encrypt data.
            </span>
          </span>
        </label>
      )}
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Semantic metadata
        </summary>
        <FieldGroup className="pt-3">
          {" "}
          <AttributeControl
            label="Sensitive data categories"
            help="Comma-separated categories, for example personal identifier, financial, or authentication."
          >
            <Input
              value={(g.sensitiveDataCategories ?? []).join(", ")}
              onChange={(e) =>
                update({
                  sensitiveDataCategories: e.target.value
                    .split(",")
                    .map((v) => v.trim()),
                })
              }
            />
          </AttributeControl>
          <AttributeControl
            label="Business term"
            help="Business glossary term identifier or URL."
          >
            <Input
              value={g.businessTerm ?? ""}
              onChange={(e) => update({ businessTerm: e.target.value || null })}
            />
          </AttributeControl>
          <AttributeControl
            label="Unit or semantic convention"
            help="For example USD, milliseconds, or UTC. This documents meaning; it does not convert values."
          >
            <Input
              value={g.unit ?? ""}
              onChange={(e) => update({ unit: e.target.value || null })}
            />
          </AttributeControl>
        </FieldGroup>
      </details>
      <AttributeControl
        label="Data treatment"
        help="A required treatment policy. Masking, hashing, and pseudonymization do not by themselves guarantee anonymity."
      >
        <NativeSelect
          value={
            Object.hasOwn(g, "anonymization")
              ? (g.anonymization ?? "none")
              : "inherit"
          }
          onChange={(e) =>
            e.target.value === "inherit"
              ? onChange(
                  Object.fromEntries(
                    Object.entries(g).filter(
                      ([key]) => key !== "anonymization",
                    ),
                  ),
                )
              : update({
                  anonymization:
                    e.target.value === "none" ? null : e.target.value,
                })
          }
        >
          <option value="inherit">Use existing source policy</option>
          <option value="none">No treatment requirement</option>
          {["mask", "hash", "redact", "pseudonymize"].map((v) => (
            <option key={v}>{v}</option>
          ))}
          {g.anonymization &&
            !["mask", "hash", "redact", "pseudonymize"].includes(
              g.anonymization,
            ) && <option>{g.anonymization}</option>}
        </NativeSelect>
      </AttributeControl>
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-2 text-sm font-medium">
          Encryption requirement
        </legend>
        {g.encryption && !g.encryptionConfig && (
          <FieldDescription>
            Existing requirement: {g.encryption}. It is preserved until you
            change these controls.
          </FieldDescription>
        )}
        <AttributeControl label="Encryption scope">
          <NativeSelect
            value={encryption.scope ?? ""}
            onChange={(e) =>
              updateEncryption({ scope: e.target.value || null })
            }
          >
            <option value="">No field override</option>
            <option value="field-level">Field-level</option>
            <option value="at-rest">At rest</option>
            <option value="in-transit">In transit</option>
          </NativeSelect>
        </AttributeControl>
        <AttributeControl label="Encryption algorithm">
          <Input
            value={encryption.algorithm ?? ""}
            placeholder="For example AES-256-GCM"
            onChange={(e) =>
              updateEncryption({ algorithm: e.target.value || null })
            }
          />
        </AttributeControl>
        <AttributeControl label="Protection policy reference">
          <Input
            value={encryption.policyRef ?? ""}
            placeholder="Policy identifier, never a key or secret"
            onChange={(e) =>
              updateEncryption({ policyRef: e.target.value || null })
            }
          />
        </AttributeControl>
      </fieldset>
      <fieldset className="flex min-w-0 flex-col gap-1 rounded-md border border-border p-3">
        <legend className="px-1 text-sm font-medium">Inherited context</legend>
        <FieldDescription>
          Source: {policyContext?.source ?? "Entity / domain policies"}
        </FieldDescription>
        <FieldDescription>
          Owner / steward: {policyContext?.owner ?? "Not specified"}
        </FieldDescription>
        <FieldDescription>
          Retention: {policyContext?.retention ?? "Not specified"}. Retention is
          managed at entity or domain level.
        </FieldDescription>
      </fieldset>
      <details>
        <summary className="cursor-pointer text-sm font-medium">
          Custom governance attributes
        </summary>
        <div className="pt-3">
          {" "}
          <JsonObjectControl
            label="Custom governance attributes"
            value={g.customAttributes ?? {}}
            stringsOnly
            onChange={(value) =>
              update({ customAttributes: value as Record<string, string> })
            }
          />
        </div>
      </details>
    </FieldGroup>
  );
}
export function StorageHintsPanel({
  governance: g,
  onChange,
}: Pick<Props, "governance" | "onChange">) {
  return (
    <FieldGroup>
      <FieldDescription>
        Requested physical-design hints. Target adapters or deployment tooling
        must support them; selecting a hint does not create an index or change a
        live table.
      </FieldDescription>
      {(["partition", "index", "cluster"] as const).map((key) => (
        <label key={key} className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={g.operationalHints?.[key] ?? false}
            onChange={(e) =>
              onChange({
                ...g,
                operationalHints: {
                  ...g.operationalHints,
                  [key]: e.target.checked,
                },
              })
            }
            className="mt-1"
          />
          <span>
            {
              {
                partition: "Partition key",
                index: "Index",
                cluster: "Cluster key",
              }[key]
            }
          </span>
        </label>
      ))}
    </FieldGroup>
  );
}
