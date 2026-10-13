-- CreateEnum
CREATE TYPE "ApiScope" AS ENUM ('DOMAIN', 'ENTITY');

-- AlterTable
ALTER TABLE "entities" ADD COLUMN "parentEntityId" TEXT;

-- CreateTable
CREATE TABLE "shared_enums" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "values" TEXT[],
    "description" TEXT NOT NULL DEFAULT '',
    "domainId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shared_enums_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "custom_scalars" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseType" TEXT NOT NULL,
    "format" TEXT,
    "pattern" TEXT,
    "description" TEXT NOT NULL DEFAULT '',
    "domainId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "custom_scalars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "union_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "memberTypes" TEXT[],
    "description" TEXT NOT NULL DEFAULT '',
    "domainId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "union_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_definitions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "basePath" TEXT NOT NULL DEFAULT '/',
    "domainId" TEXT NOT NULL,
    "scope" "ApiScope" NOT NULL DEFAULT 'DOMAIN',
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operations" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "httpMethod" TEXT NOT NULL,
    "httpPath" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "decorators" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_parameters" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "operation_parameters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_responses" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "type" TEXT,
    "description" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "operation_responses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interface_definitions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "domainId" TEXT NOT NULL,
    "operationIds" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interface_definitions_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "model_definitions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "domainId" TEXT NOT NULL,
    "sourceFormat" TEXT NOT NULL DEFAULT 'typespec',
    "sourceNamespace" TEXT,
    "extendsModelName" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_field_definitions" (
    "id" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "precision" INTEGER,
    "scale" INTEGER,
    "nullable" BOOLEAN NOT NULL DEFAULT true,
    "isKey" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL DEFAULT '',
    "aliases" TEXT[],
    "classification" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "decorators" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_field_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decorator_definitions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "signature" TEXT NOT NULL DEFAULT '',
    "targetTypes" TEXT[],
    "domainId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "decorator_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_concepts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL DEFAULT 'Core',
    "definition" TEXT NOT NULL DEFAULT '',
    "synonyms" TEXT[],
    "canonicalType" TEXT,
    "classification" TEXT,
    "tags" TEXT[],
    "ownerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_concepts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "field_concept_links" (
    "id" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "conceptId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "linkedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "field_concept_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shared_enums_name_domainId_key" ON "shared_enums"("name", "domainId");

-- CreateIndex
CREATE UNIQUE INDEX "custom_scalars_name_domainId_key" ON "custom_scalars"("name", "domainId");

-- CreateIndex
CREATE UNIQUE INDEX "union_types_name_domainId_key" ON "union_types"("name", "domainId");

-- CreateIndex
CREATE UNIQUE INDEX "service_definitions_name_domainId_key" ON "service_definitions"("name", "domainId");

-- CreateIndex
CREATE UNIQUE INDEX "interface_definitions_name_domainId_key" ON "interface_definitions"("name", "domainId");

-- CreateIndex
CREATE UNIQUE INDEX "model_definitions_name_domainId_key" ON "model_definitions"("name", "domainId");

-- CreateIndex
CREATE UNIQUE INDEX "model_field_definitions_modelId_name_key" ON "model_field_definitions"("modelId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "decorator_definitions_name_domainId_key" ON "decorator_definitions"("name", "domainId");

-- CreateIndex
CREATE UNIQUE INDEX "business_concepts_name_key" ON "business_concepts"("name");

-- CreateIndex
CREATE UNIQUE INDEX "field_concept_links_fieldId_conceptId_key" ON "field_concept_links"("fieldId", "conceptId");

-- AddForeignKey
ALTER TABLE "shared_enums"
ADD CONSTRAINT "shared_enums_domainId_fkey"
FOREIGN KEY ("domainId") REFERENCES "domains"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_scalars"
ADD CONSTRAINT "custom_scalars_domainId_fkey"
FOREIGN KEY ("domainId") REFERENCES "domains"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "union_types"
ADD CONSTRAINT "union_types_domainId_fkey"
FOREIGN KEY ("domainId") REFERENCES "domains"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_definitions"
ADD CONSTRAINT "service_definitions_domainId_fkey"
FOREIGN KEY ("domainId") REFERENCES "domains"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operations"
ADD CONSTRAINT "operations_serviceId_fkey"
FOREIGN KEY ("serviceId") REFERENCES "service_definitions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_parameters"
ADD CONSTRAINT "operation_parameters_operationId_fkey"
FOREIGN KEY ("operationId") REFERENCES "operations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation_responses"
ADD CONSTRAINT "operation_responses_operationId_fkey"
FOREIGN KEY ("operationId") REFERENCES "operations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interface_definitions"
ADD CONSTRAINT "interface_definitions_domainId_fkey"
FOREIGN KEY ("domainId") REFERENCES "domains"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entities"
ADD CONSTRAINT "entities_parentEntityId_fkey"
FOREIGN KEY ("parentEntityId") REFERENCES "entities"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_concept_links"
ADD CONSTRAINT "field_concept_links_fieldId_fkey"
FOREIGN KEY ("fieldId") REFERENCES "fields"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "field_concept_links"
ADD CONSTRAINT "field_concept_links_conceptId_fkey"
FOREIGN KEY ("conceptId") REFERENCES "business_concepts"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_definitions"
ADD CONSTRAINT "service_definitions_entityId_fkey"
FOREIGN KEY ("entityId") REFERENCES "entities"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_definitions"
ADD CONSTRAINT "model_definitions_domainId_fkey"
FOREIGN KEY ("domainId") REFERENCES "domains"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_field_definitions"
ADD CONSTRAINT "model_field_definitions_modelId_fkey"
FOREIGN KEY ("modelId") REFERENCES "model_definitions"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decorator_definitions"
ADD CONSTRAINT "decorator_definitions_domainId_fkey"
FOREIGN KEY ("domainId") REFERENCES "domains"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
