"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { FieldEditor } from "./field-editor";
import { addFieldAction, updateFieldAction, deleteFieldAction } from "./actions";

interface FieldData {
  id: string;
  name: string;
  type: string;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isKey: boolean;
  fieldNumber: number | null;
  description: string;
  classification: string | null;
  sortOrder: number;
}

interface EntityWorkspaceProps {
  entity: {
    id: string;
    name: string;
    description: string;
    status: string;
    version: number;
    domainName: string;
    domainSlug: string;
  };
  fields: FieldData[];
}

export function EntityWorkspace({ entity, fields }: EntityWorkspaceProps) {
  const statusColor =
    entity.status === "ACTIVE"
      ? "bg-success"
      : entity.status === "DRAFT"
        ? "bg-warning"
        : "bg-muted-foreground";

  return (
    <div className="animate-auth-fade-up">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-space-1 text-body-small text-muted-foreground mb-space-4">
        <Link href="/schemas" className="hover:text-foreground transition-colors">
          Domains
        </Link>
        <ChevronRight className="w-3 h-3" />
        <Link
          href={`/schemas/${entity.domainSlug}`}
          className="hover:text-foreground transition-colors"
        >
          {entity.domainName}
        </Link>
        <ChevronRight className="w-3 h-3" />
        <span className="text-foreground font-medium font-mono">{entity.name}</span>
      </nav>

      {/* Header */}
      <div className="flex items-center justify-between mb-space-6">
        <div className="flex items-center gap-space-3">
          <h1 className="text-display text-foreground font-mono">{entity.name}</h1>
          <span className={`w-2.5 h-2.5 rounded-full ${statusColor}`} />
          <Badge variant="outline">{entity.status}</Badge>
          <Badge variant="secondary">v{entity.version}</Badge>
        </div>
      </div>

      {entity.description && (
        <p className="text-body text-muted-foreground mb-space-6">{entity.description}</p>
      )}

      {/* Field Editor */}
      <div className="mb-space-8">
        <h2 className="text-heading-2 text-foreground mb-space-4">
          Fields ({fields.length})
        </h2>
        <FieldEditor
          entityId={entity.id}
          domainSlug={entity.domainSlug}
          fields={fields}
          onAddField={async (name, type) => {
            await addFieldAction(entity.id, name, type);
          }}
          onUpdateField={async (id, data) => {
            await updateFieldAction(id, data);
          }}
          onDeleteField={async (id) => {
            await deleteFieldAction(id);
          }}
        />
      </div>

      {/* Implemented Schemas */}
      <div>
        <h2 className="text-heading-2 text-foreground mb-space-4">
          Implemented Schemas
        </h2>
        <div className="surface-glass rounded-xl border border-border p-space-8 text-center">
          <p className="text-body text-muted-foreground">
            No implementations yet — emit this entity to generate target schemas
          </p>
        </div>
      </div>
    </div>
  );
}
