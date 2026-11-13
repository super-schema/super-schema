-- Keep legacy rows nullable until the application can materialize its old CONTENT_STORAGE default.
ALTER TABLE "tenants" ADD COLUMN "contentStorage" TEXT;
ALTER TABLE "tenants" ALTER COLUMN "contentStorage" SET DEFAULT 'database';
ALTER TABLE "tenants" ADD COLUMN "storageRevision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "tenant_git_bindings" ADD COLUMN "workflowDefaults" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "gitops_oauth_states" ADD COLUMN "returnTo" TEXT NOT NULL DEFAULT '/admin/workflows/gitops';
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_content_storage_check"
  CHECK ("contentStorage" IS NULL OR "contentStorage" IN ('database', 'git'));

-- Resolve ownership inside the mutating transaction. This also covers nested writes,
-- bulk operations, FK cascades and SQL clients without relying on a browser's active tenant.
CREATE FUNCTION superschema_content_tenant(table_name TEXT, row_data JSONB) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE tenant_id TEXT;
BEGIN
  CASE table_name
    WHEN 'tenants' THEN RETURN row_data->>'id';
    WHEN 'domains', 'entities', 'event_specs', 'traits', 'shared_enums', 'custom_scalars', 'union_types', 'service_definitions'
      THEN RETURN row_data->>'tenantId';
    WHEN 'products', 'model_definitions', 'decorator_definitions', 'interface_definitions'
      THEN SELECT "tenantId" INTO tenant_id FROM "domains" WHERE id = row_data->>'domainId';
    WHEN 'fields', 'entity_versions'
      THEN SELECT "tenantId" INTO tenant_id FROM "entities" WHERE id = row_data->>'entityId';
    WHEN 'event_spec_versions'
      THEN SELECT "tenantId" INTO tenant_id FROM "event_specs" WHERE id = row_data->>'eventSpecId';
    WHEN 'model_field_definitions'
      THEN SELECT d."tenantId" INTO tenant_id FROM "model_definitions" m JOIN "domains" d ON d.id=m."domainId" WHERE m.id=row_data->>'modelId';
    WHEN 'operations'
      THEN SELECT "tenantId" INTO tenant_id FROM "service_definitions" WHERE id=row_data->>'serviceId';
    WHEN 'operation_parameters', 'operation_responses'
      THEN SELECT s."tenantId" INTO tenant_id FROM "operations" o JOIN "service_definitions" s ON s.id=o."serviceId" WHERE o.id=row_data->>'operationId';
    WHEN 'schema_references' THEN
      CASE row_data->>'fromKind'
        WHEN 'ENTITY_VERSION' THEN SELECT e."tenantId" INTO tenant_id FROM "entity_versions" v JOIN "entities" e ON e.id=v."entityId" WHERE v.id=row_data->>'fromId';
        WHEN 'EVENT_SPEC_VERSION' THEN SELECT e."tenantId" INTO tenant_id FROM "event_spec_versions" v JOIN "event_specs" e ON e.id=v."eventSpecId" WHERE v.id=row_data->>'fromId';
        WHEN 'EVENT_SPEC' THEN SELECT "tenantId" INTO tenant_id FROM "event_specs" WHERE id=row_data->>'fromId';
        WHEN 'TRAIT' THEN SELECT "tenantId" INTO tenant_id FROM "traits" WHERE id=row_data->>'fromId';
        ELSE tenant_id := NULL; -- legacy/orphan reference-cache records have no live content owner
      END CASE;
    ELSE tenant_id := NULL;
  END CASE;
  RETURN tenant_id;
END;
$$;

CREATE FUNCTION superschema_guard_tenant_content() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  before_document JSONB;
  after_document JSONB;
  owner_id TEXT;
  storage TEXT;
BEGIN
  IF current_setting('superschema.gitops_projection_write', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_TABLE_NAME = 'tenants' THEN
    IF TG_OP <> 'DELETE' THEN
      IF NEW."contentStorage" IS NULL THEN NEW."contentStorage" := 'database'; END IF;
    END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN before_document := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN after_document := to_jsonb(NEW); END IF;

  -- Hierarchy inserts are provisioning; a nested content insert still fires its own guard.
  IF TG_OP = 'INSERT' AND TG_TABLE_NAME IN ('tenants','domains','products') THEN RETURN NEW; END IF;
  -- Operational tenant settings stay in the application database in both content modes.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'tenants' AND
    (before_document - ARRAY['updatedAt','contentStorage','storageRevision','deploymentEnvironments','deploymentEnvironmentDetails','deploymentTargetMethods']) =
    (after_document - ARRAY['updatedAt','contentStorage','storageRevision','deploymentEnvironments','deploymentEnvironmentDetails','deploymentTargetMethods'])
    THEN RETURN NEW;
  END IF;

  FOREACH owner_id IN ARRAY ARRAY[
    superschema_content_tenant(TG_TABLE_NAME, before_document),
    superschema_content_tenant(TG_TABLE_NAME, after_document)
  ] LOOP
    IF owner_id IS NULL THEN CONTINUE; END IF;
    -- The shared row lock lasts until the content write commits, serializing a storage cutover
    -- against in-flight writes while allowing concurrent database-tenant authoring.
    SELECT "contentStorage" INTO storage FROM "tenants" WHERE id=owner_id FOR SHARE;
    IF storage = 'git' THEN
      RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='GITOPS_AUTHORING_REQUIRED: This tenant stores contracts in Git. Use GitOps authoring and a pull request.';
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'tenants','domains','products','entities','fields','entity_versions','event_specs','event_spec_versions',
    'traits','shared_enums','custom_scalars','union_types','service_definitions','operations','operation_parameters',
    'operation_responses','model_definitions','model_field_definitions','decorator_definitions','interface_definitions','schema_references'
  ] LOOP
    EXECUTE format('CREATE TRIGGER tenant_content_storage_guard BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION superschema_guard_tenant_content()',table_name);
  END LOOP;
END;
$$;
