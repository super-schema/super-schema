"use client";

import { ClassificationPicker } from "@/components/custom/ClassificationPicker";

import { NativeSelect } from "@/components/ui/native-select";
interface GovernanceSectionProps {
  classification: string | null;
  anonymization: string;
  encryption: string;
  isReadOnly?: boolean;
  onChange: (field: string, value: unknown) => void;
}

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

      {/* Anonymization */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Anonymization</label>
        <NativeSelect
          value={anonymization}
          onChange={(e) => onChange("anonymization", e.target.value)}
          disabled={isReadOnly}
          className="h-8 w-full"
        >
          {ANONYMIZATION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </NativeSelect>
      </div>

      {/* Encryption */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Encryption</label>
        <NativeSelect
          value={encryption}
          onChange={(e) => onChange("encryption", e.target.value)}
          disabled={isReadOnly}
          className="h-8 w-full"
        >
          {ENCRYPTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </NativeSelect>
      </div>
    </div>
  );
}
