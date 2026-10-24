"use client";

import { BookOpen, Wand2, FileInput, Plus } from "lucide-react";

export type CreationMethod =
  | "standards"
  | "natural-language"
  | "schema"
  | "blank";

interface TemplateSelectorProps {
  onSelect: (method: CreationMethod) => void;
  /** Methods that do not apply to the current target (e.g. AI generation needs a domain). */
  hiddenMethods?: readonly CreationMethod[];
}

const METHODS = [
  {
    id: "standards" as const,
    icon: BookOpen,
    title: "Standards Library",
    description: "Start from industry standards like Schema.org, Financial, or Healthcare templates",
    color: "text-blue-400",
    borderColor: "hover:border-blue-400/40",
  },
  {
    id: "natural-language" as const,
    icon: Wand2,
    title: "Describe in Natural Language",
    description: "Describe your entity and let AI generate the schema for you",
    color: "text-purple-400",
    borderColor: "hover:border-purple-400/40",
  },
  {
    id: "schema" as const,
    icon: FileInput,
    title: "Import or Build Schema",
    description: "Drop a schema file, paste one, or build it field by field. Avro, Protobuf, JSON Schema, BigQuery DDL, TypeSpec and OpenAPI",
    color: "text-emerald-400",
    borderColor: "hover:border-emerald-400/40",
  },
  {
    id: "blank" as const,
    icon: Plus,
    title: "Start Blank",
    description: "Create an empty entity and add fields manually",
    color: "text-amber-400",
    borderColor: "hover:border-amber-400/40",
  },
] as const;

export function TemplateSelector({ onSelect, hiddenMethods = [] }: TemplateSelectorProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-space-4">
      {METHODS.filter((method) => !hiddenMethods.includes(method.id)).map((method) => {
        const Icon = method.icon;
        return (
          <button
            key={method.id}
            data-testid={`creation-method-${method.id}`}
            onClick={() => onSelect(method.id)}
            className={`surface-glass rounded-xl border border-border/50 p-space-6 text-left transition-all ${method.borderColor} hover:bg-accent/20 group cursor-pointer`}
          >
            <div className="flex items-start gap-space-4">
              <div className={`p-3 rounded-lg bg-accent/30 ${method.color} group-hover:scale-110 transition-transform`}>
                <Icon className="w-6 h-6" />
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-heading-2 text-foreground mb-space-1">
                  {method.title}
                </h3>
                <p className="text-body-small text-muted-foreground">
                  {method.description}
                </p>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
