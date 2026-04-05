"use client";

import { ClassificationPicker } from "@/components/custom/ClassificationPicker";

interface GovernanceSectionProps {
  classification: string | null;
  retention: string;
  anonymization: string;
  encryption: string;
  isReadOnly?: boolean;
  onChange: (field: string, value: unknown) => void;
}

const RETENTION_OPTIONS = [
  { value: "", label: "Not set" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "1y", label: "1 year" },
  { value: "3y", label: "3 years" },
  { value: "7y", label: "7 years" },
  { value: "forever", label: "Forever" },
];

const ANONYMIZATION_OPTIONS = [
  { value: "", label: "None" },
  { value: "hash", label: "Hash" },
  { value: "mask", label: "Mask" },
  { value: "redact", label: "Redact" },
  { value: "pseudonymize", label: "Pseudonymize" },
  { value: "generalize", label: "Generalize" },
];

const ENCRYPTION_OPTIONS = [
  { value: "", label: "None" },
  { value: "at-rest", label: "At rest" },
  { value: "in-transit", label: "In transit" },
  { value: "both", label: "Both" },
  { value: "field-level", label: "Field-level" },
];

export function GovernanceSection({
  classification,
  retention,
  anonymization,
  encryption,
  isReadOnly = false,
  onChange,
}: GovernanceSectionProps) {
  return (
    <div className="space-y-space-3">
      {/* Classification */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Classification</label>
        <div className="h-8 flex items-center">
          <ClassificationPicker
            value={classification}
            onChange={(val) => onChange("classification", val)}
          />
        </div>
      </div>

      {/* Retention */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Retention</label>
        <select
          value={retention}
          onChange={(e) => onChange("retention", e.target.value)}
          disabled={isReadOnly}
          className="h-8 w-full rounded-lg border border-border bg-popover px-2 text-body-small text-foreground disabled:opacity-50"
        >
          {RETENTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Anonymization */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Anonymization</label>
        <select
          value={anonymization}
          onChange={(e) => onChange("anonymization", e.target.value)}
          disabled={isReadOnly}
          className="h-8 w-full rounded-lg border border-border bg-popover px-2 text-body-small text-foreground disabled:opacity-50"
        >
          {ANONYMIZATION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Encryption */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Encryption</label>
        <select
          value={encryption}
          onChange={(e) => onChange("encryption", e.target.value)}
          disabled={isReadOnly}
          className="h-8 w-full rounded-lg border border-border bg-popover px-2 text-body-small text-foreground disabled:opacity-50"
        >
          {ENCRYPTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}
