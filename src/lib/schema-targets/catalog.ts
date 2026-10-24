export type SchemaTargetSource = "super-schema" | "typespec-official";
export type SchemaTargetRuntime = "native" | "typespec-cli";
export type SchemaTargetCategory = "schema" | "codegen";
export type SchemaTargetStability = "stable" | "preview" | "alpha";

/** A schema target's catalog key (`json-schema`, `avro`, ...). */
export type TargetId = string;

export interface SchemaTargetDefinition {
  key: string;
  displayName: string;
  description: string;
  targetFormat: string;
  outputLanguage: string;
  source: SchemaTargetSource;
  runtime: SchemaTargetRuntime;
  category: SchemaTargetCategory;
  stability: SchemaTargetStability;
  docsUrl?: string;
  packageName?: string;
  enabledInSchemaTab: boolean;
  supportsFieldOverrides: boolean;
  unavailableReason?: string;
  /**
   * The target emits a reference closure (an entity plus everything it references) as one file per entity
   * (`emitClosure`, closure-emit.ts). The DB targets do not: a reference stays a plain column there, so they emit the one entity.
   */
  closureEmission?: boolean;
}

export interface SchemaTargetAvailability {
  target: SchemaTargetDefinition;
  available: boolean;
  reason?: string;
}

const SCHEMA_TARGETS: SchemaTargetDefinition[] = [
  {
    key: "bigquery",
    displayName: "BigQuery DDL",
    description: "TypeSpec emitter (@typespec/bigquery) for Google BigQuery table DDL.",
    targetFormat: "bigquery",
    outputLanguage: "sql",
    source: "typespec-official",
    runtime: "typespec-cli",
    packageName: "@typespec/bigquery",
    category: "schema",
    stability: "stable",
    enabledInSchemaTab: true,
    supportsFieldOverrides: true,
  },
  {
    key: "avro",
    displayName: "Avro Schema",
    description: "Official TypeSpec emitter for Apache Avro schema output.",
    targetFormat: "avro",
    outputLanguage: "json",
    source: "typespec-official",
    runtime: "typespec-cli",
    packageName: "@typespec/avro",
    category: "schema",
    stability: "stable",
    enabledInSchemaTab: true,
    supportsFieldOverrides: false,
    closureEmission: true,
  },
  {
    key: "java-pojo",
    displayName: "Java POJO",
    description: "Official TypeSpec emitter for a Jackson-annotated Java POJO class.",
    targetFormat: "java-pojo",
    outputLanguage: "java",
    source: "typespec-official",
    runtime: "typespec-cli",
    packageName: "@typespec/java-pojo",
    category: "schema",
    stability: "preview",
    enabledInSchemaTab: true,
    supportsFieldOverrides: false,
    closureEmission: true,
  },
  {
    key: "spanner",
    displayName: "Spanner DDL",
    description: "TypeSpec emitter (@typespec/spanner) for Cloud Spanner DDL.",
    targetFormat: "spanner",
    outputLanguage: "sql",
    source: "typespec-official",
    runtime: "typespec-cli",
    packageName: "@typespec/spanner",
    category: "schema",
    stability: "stable",
    enabledInSchemaTab: true,
    supportsFieldOverrides: true,
  },
  {
    key: "postgresql",
    displayName: "PostgreSQL DDL",
    description: "TypeSpec emitter (@typespec/postgres) for PostgreSQL DDL output.",
    targetFormat: "postgresql",
    outputLanguage: "sql",
    source: "typespec-official",
    runtime: "typespec-cli",
    packageName: "@typespec/postgres",
    category: "schema",
    stability: "stable",
    docsUrl: "https://www.postgresql.org/docs/current/datatype.html",
    enabledInSchemaTab: true,
    supportsFieldOverrides: true,
  },
  {
    key: "openapi3",
    displayName: "OpenAPI 3 (TypeSpec)",
    description: "Official TypeSpec OpenAPI v3 emitter.",
    targetFormat: "openapi3",
    outputLanguage: "yaml",
    source: "typespec-official",
    runtime: "typespec-cli",
    category: "schema",
    stability: "stable",
    docsUrl: "https://typespec.io/docs/emitters/openapi3/openapi/",
    packageName: "@typespec/openapi3",
    enabledInSchemaTab: true,
    supportsFieldOverrides: false,
    closureEmission: true,
  },
  {
    key: "json-schema",
    displayName: "JSON Schema (TypeSpec)",
    description: "Official TypeSpec JSON Schema emitter.",
    targetFormat: "json-schema",
    outputLanguage: "json",
    source: "typespec-official",
    runtime: "typespec-cli",
    category: "schema",
    stability: "stable",
    docsUrl: "https://typespec.io/docs/emitters/json-schema/reference/",
    packageName: "@typespec/json-schema",
    enabledInSchemaTab: true,
    supportsFieldOverrides: false,
    closureEmission: true,
  },
  {
    key: "protobuf",
    displayName: "Protobuf (TypeSpec)",
    description: "Official TypeSpec Protobuf emitter.",
    targetFormat: "protobuf",
    outputLanguage: "protobuf",
    source: "typespec-official",
    runtime: "typespec-cli",
    category: "schema",
    stability: "preview",
    docsUrl: "https://typespec.io/docs/emitters/protobuf/guide/",
    packageName: "@typespec/protobuf",
    enabledInSchemaTab: true,
    supportsFieldOverrides: false,
    closureEmission: true,
  },
  {
    key: "http-client-js",
    displayName: "HTTP Client JS (TypeSpec)",
    description: "Official TypeSpec JavaScript/TypeScript HTTP client generator.",
    targetFormat: "http-client-js",
    outputLanguage: "typescript",
    source: "typespec-official",
    runtime: "typespec-cli",
    category: "codegen",
    stability: "preview",
    docsUrl: "https://typespec.io/docs/emitters/clients/http-client-js/reference/",
    packageName: "@typespec/http-client-js",
    enabledInSchemaTab: false,
    supportsFieldOverrides: false,
    unavailableReason:
      "Generates a multi-file SDK package. The Schemas tab currently stores single-file artifacts only.",
  },
  {
    key: "http-client-python",
    displayName: "HTTP Client Python (TypeSpec)",
    description: "Official TypeSpec Python HTTP client generator.",
    targetFormat: "http-client-python",
    outputLanguage: "python",
    source: "typespec-official",
    runtime: "typespec-cli",
    category: "codegen",
    stability: "preview",
    docsUrl: "https://typespec.io/docs/emitters/clients/http-client-python/reference/",
    packageName: "@typespec/http-client-python",
    enabledInSchemaTab: false,
    supportsFieldOverrides: false,
    unavailableReason:
      "Generates a multi-file SDK package. The Schemas tab currently stores single-file artifacts only.",
  },
  {
    key: "http-client-java",
    displayName: "HTTP Client Java (TypeSpec)",
    description: "Official TypeSpec Java HTTP client generator.",
    targetFormat: "http-client-java",
    outputLanguage: "java",
    source: "typespec-official",
    runtime: "typespec-cli",
    category: "codegen",
    stability: "preview",
    docsUrl: "https://typespec.io/docs/emitters/clients/http-client-java/reference/",
    packageName: "@typespec/http-client-java",
    enabledInSchemaTab: false,
    supportsFieldOverrides: false,
    unavailableReason:
      "Generates a multi-file SDK package and requires additional runtime/tooling setup beyond the Schemas tab.",
  },
  {
    key: "http-client-csharp",
    displayName: "HTTP Client C# (TypeSpec)",
    description: "Official TypeSpec C# HTTP client generator.",
    targetFormat: "http-client-csharp",
    outputLanguage: "csharp",
    source: "typespec-official",
    runtime: "typespec-cli",
    category: "codegen",
    stability: "preview",
    docsUrl: "https://typespec.io/docs/emitters/clients/http-client-csharp/reference/",
    packageName: "@typespec/http-client-csharp",
    enabledInSchemaTab: false,
    supportsFieldOverrides: false,
    unavailableReason:
      "Generates a multi-file SDK package and requires .NET-specific output handling beyond the Schemas tab.",
  },
  {
    key: "http-server-js",
    displayName: "HTTP Server JS (TypeSpec)",
    description: "Official TypeSpec JavaScript HTTP server generator.",
    targetFormat: "http-server-js",
    outputLanguage: "typescript",
    source: "typespec-official",
    runtime: "typespec-cli",
    category: "codegen",
    stability: "alpha",
    docsUrl: "https://typespec.io/docs/emitters/servers/http-server-js/project/",
    packageName: "@typespec/http-server-js",
    enabledInSchemaTab: false,
    supportsFieldOverrides: false,
    unavailableReason:
      "Generates a multi-file server project. The Schemas tab currently stores single-file artifacts only.",
  },
  {
    key: "http-server-csharp",
    displayName: "HTTP Server C# (TypeSpec)",
    description: "Official TypeSpec C# HTTP server generator.",
    targetFormat: "http-server-csharp",
    outputLanguage: "csharp",
    source: "typespec-official",
    runtime: "typespec-cli",
    category: "codegen",
    stability: "alpha",
    docsUrl: "https://typespec.io/docs/emitters/servers/asp-net/overview/",
    packageName: "@typespec/http-server-csharp",
    enabledInSchemaTab: false,
    supportsFieldOverrides: false,
    unavailableReason:
      "Generates a multi-file server project and requires .NET-specific output handling beyond the Schemas tab.",
  },
];

export function getSchemaTargetCatalog(): SchemaTargetDefinition[] {
  return [...SCHEMA_TARGETS];
}

export function getSchemaTargetDefinition(key: string): SchemaTargetDefinition | undefined {
  return SCHEMA_TARGETS.find((target) => target.key === key);
}

/** True for the targets that emit a reference closure as one file per entity (see {@link SchemaTargetDefinition.closureEmission}). */
export function supportsClosureEmission(key: string): boolean {
  return getSchemaTargetDefinition(key)?.closureEmission === true;
}

export function getSchemaTargetAvailabilities(): SchemaTargetAvailability[] {
  return SCHEMA_TARGETS.map((target) => ({
    target,
    available: target.enabledInSchemaTab,
    reason: target.enabledInSchemaTab ? undefined : target.unavailableReason,
  }));
}
