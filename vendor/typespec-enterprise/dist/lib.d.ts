export declare const $lib: import("@typespec/compiler").TypeSpecLibrary<{
    'require-documentation': {
        readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
    };
    'require-classification': {
        readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
    };
    'require-key': {
        readonly default: import("@typespec/compiler").CallableMessage<["model"]>;
    };
    'pii-requires-anonymization': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'pii-requires-restricted-classification': {
        readonly default: import("@typespec/compiler").CallableMessage<[]>;
    };
    'decimal-requires-precision': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'avro-fixed-requires-size': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'protobuf-no-duplicate-field-numbers': {
        readonly default: import("@typespec/compiler").CallableMessage<["model", "number", "first", "second"]>;
    };
}, Record<string, any>, never>;
export type EnterpriseLibrary = typeof $lib;
export declare const reportDiagnostic: <C extends "require-documentation" | "require-classification" | "require-key" | "pii-requires-anonymization" | "pii-requires-restricted-classification" | "decimal-requires-precision" | "avro-fixed-requires-size" | "protobuf-no-duplicate-field-numbers", M extends keyof {
    'require-documentation': {
        readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
    };
    'require-classification': {
        readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
    };
    'require-key': {
        readonly default: import("@typespec/compiler").CallableMessage<["model"]>;
    };
    'pii-requires-anonymization': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'pii-requires-restricted-classification': {
        readonly default: import("@typespec/compiler").CallableMessage<[]>;
    };
    'decimal-requires-precision': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'avro-fixed-requires-size': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'protobuf-no-duplicate-field-numbers': {
        readonly default: import("@typespec/compiler").CallableMessage<["model", "number", "first", "second"]>;
    };
}[C]>(program: import("@typespec/compiler").Program, diag: import("@typespec/compiler").DiagnosticReport<{
    'require-documentation': {
        readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
    };
    'require-classification': {
        readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
    };
    'require-key': {
        readonly default: import("@typespec/compiler").CallableMessage<["model"]>;
    };
    'pii-requires-anonymization': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'pii-requires-restricted-classification': {
        readonly default: import("@typespec/compiler").CallableMessage<[]>;
    };
    'decimal-requires-precision': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'avro-fixed-requires-size': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'protobuf-no-duplicate-field-numbers': {
        readonly default: import("@typespec/compiler").CallableMessage<["model", "number", "first", "second"]>;
    };
}, C, M>) => void, createDiagnostic: <C extends "require-documentation" | "require-classification" | "require-key" | "pii-requires-anonymization" | "pii-requires-restricted-classification" | "decimal-requires-precision" | "avro-fixed-requires-size" | "protobuf-no-duplicate-field-numbers", M extends keyof {
    'require-documentation': {
        readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
    };
    'require-classification': {
        readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
    };
    'require-key': {
        readonly default: import("@typespec/compiler").CallableMessage<["model"]>;
    };
    'pii-requires-anonymization': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'pii-requires-restricted-classification': {
        readonly default: import("@typespec/compiler").CallableMessage<[]>;
    };
    'decimal-requires-precision': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'avro-fixed-requires-size': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'protobuf-no-duplicate-field-numbers': {
        readonly default: import("@typespec/compiler").CallableMessage<["model", "number", "first", "second"]>;
    };
}[C]>(diag: import("@typespec/compiler").DiagnosticReport<{
    'require-documentation': {
        readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
    };
    'require-classification': {
        readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
    };
    'require-key': {
        readonly default: import("@typespec/compiler").CallableMessage<["model"]>;
    };
    'pii-requires-anonymization': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'pii-requires-restricted-classification': {
        readonly default: import("@typespec/compiler").CallableMessage<[]>;
    };
    'decimal-requires-precision': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'avro-fixed-requires-size': {
        readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
    };
    'protobuf-no-duplicate-field-numbers': {
        readonly default: import("@typespec/compiler").CallableMessage<["model", "number", "first", "second"]>;
    };
}, C, M>) => import("@typespec/compiler").Diagnostic;
declare const STATE_KEYS: readonly ["dataClassification", "pii", "businessOwner", "steward", "retentionPolicy", "anonymization", "qualityRule", "precision", "sourceMapping", "avroLogicalType", "avroFixedSize", "avroOrder", "avroNamespace", "avroRecordAliases", "protobufFieldNumber", "protobufOneofGroup", "partitionHint", "indexHint", "clusterHint", "deprecation"];
export declare const state: { [K in (typeof STATE_KEYS)[number]]: symbol; };
export {};
