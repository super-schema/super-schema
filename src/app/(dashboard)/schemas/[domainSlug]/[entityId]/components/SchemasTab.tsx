"use client";

import { useState, useEffect, useCallback } from "react";
import { Loader2, Database, FileJson, Globe } from "lucide-react";
import { getSchemaVersionsAction } from "../actions";
import type { SchemaVersionsMap } from "../actions";
import { TechnologyCard, type TargetInfo } from "./TechnologyCard";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FieldData {
  id: string;
  slug?: string;
  name: string;
  type: string;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isKey: boolean;
  fieldNumber: number | null;
  description: string;
  classification: string | null;
  aliases: string[];
  decorators: Record<string, unknown>;
  sortOrder: number;
}

export interface SchemasTabProps {
  entityId: string;
  entityName: string;
  fields: FieldData[];
  entity: {
    id: string;
    name: string;
    slug: string;
    domainSlug: string;
    version: number;
    metadata: Record<string, unknown> | null;
  };
}

// ---------------------------------------------------------------------------
// Target metadata (icon, display name)
// ---------------------------------------------------------------------------

const TARGET_INFO: Record<string, { displayName: string; iconComponent: typeof Database }> = {
  bigquery: { displayName: "BigQuery DDL", iconComponent: Database },
  avro: { displayName: "Avro Schema", iconComponent: FileJson },
  openapi: { displayName: "OpenAPI 3.1", iconComponent: Globe },
};

function getTargetInfo(key: string): TargetInfo {
  const info = TARGET_INFO[key];
  const IconComponent = info?.iconComponent ?? FileJson;
  return {
    key,
    displayName: info?.displayName ?? key,
    icon: <IconComponent className="w-4 h-4" />,
  };
}

// ---------------------------------------------------------------------------
// SchemasTab -- orchestrator
// ---------------------------------------------------------------------------

export function SchemasTab({ entityId, entityName, fields, entity }: SchemasTabProps) {
  const [schemaVersions, setSchemaVersions] = useState<SchemaVersionsMap>({});
  const [isLoading, setIsLoading] = useState(true);

  const targets = ["bigquery", "avro", "openapi"];

  const loadVersions = useCallback(async () => {
    const result = await getSchemaVersionsAction(entityId);
    if (result.schemaVersions) {
      setSchemaVersions(result.schemaVersions);
    }
    setIsLoading(false);
  }, [entityId]);

  useEffect(() => {
    loadVersions();
  }, [loadVersions]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-space-8">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        <span className="ml-space-2 text-body-small text-muted-foreground">
          Loading schemas...
        </span>
      </div>
    );
  }

  return (
    <div className="space-y-space-4" data-testid="schemas-tab">
      <div className="flex items-center justify-between">
        <h2 className="text-heading-2 text-foreground">Schemas</h2>
        <span className="text-caption text-muted-foreground">
          {entityName} &middot; v{entity.version}
        </span>
      </div>

      <div className="space-y-space-3">
        {targets.map((target) => (
          <TechnologyCard
            key={target}
            targetInfo={getTargetInfo(target)}
            versions={schemaVersions[target] ?? []}
            entityId={entityId}
            entityVersion={entity.version}
            fieldsCount={fields.length}
            onVersionsChange={loadVersions}
          />
        ))}
      </div>
    </div>
  );
}
