export declare const requireDocumentation: import("@typespec/compiler").LinterRuleDefinition<"require-documentation", {
    readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
}>;
export declare const requireClassification: import("@typespec/compiler").LinterRuleDefinition<"require-classification", {
    readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
}>;
export declare const requireKey: import("@typespec/compiler").LinterRuleDefinition<"require-key", {
    readonly default: import("@typespec/compiler").CallableMessage<["model"]>;
}>;
export declare const piiRequiresAnonymization: import("@typespec/compiler").LinterRuleDefinition<"pii-requires-anonymization", {
    readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
}>;
export declare const piiRequiresRestrictedClassification: import("@typespec/compiler").LinterRuleDefinition<"pii-requires-restricted-classification", {
    readonly default: import("@typespec/compiler").CallableMessage<["property", "classification"]>;
}>;
export declare const decimalRequiresPrecision: import("@typespec/compiler").LinterRuleDefinition<"decimal-requires-precision", {
    readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
}>;
export declare const avroFixedRequiresSize: import("@typespec/compiler").LinterRuleDefinition<"avro-fixed-requires-size", {
    readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
}>;
export declare const protobufNoDuplicateFieldNumbers: import("@typespec/compiler").LinterRuleDefinition<"protobuf-no-duplicate-field-numbers", {
    readonly default: import("@typespec/compiler").CallableMessage<["model", "number", "first", "second"]>;
}>;
export declare const allRules: (import("@typespec/compiler").LinterRuleDefinition<"require-documentation", {
    readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
}> | import("@typespec/compiler").LinterRuleDefinition<"require-classification", {
    readonly default: import("@typespec/compiler").CallableMessage<["target"]>;
}> | import("@typespec/compiler").LinterRuleDefinition<"require-key", {
    readonly default: import("@typespec/compiler").CallableMessage<["model"]>;
}> | import("@typespec/compiler").LinterRuleDefinition<"pii-requires-anonymization", {
    readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
}> | import("@typespec/compiler").LinterRuleDefinition<"pii-requires-restricted-classification", {
    readonly default: import("@typespec/compiler").CallableMessage<["property", "classification"]>;
}> | import("@typespec/compiler").LinterRuleDefinition<"decimal-requires-precision", {
    readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
}> | import("@typespec/compiler").LinterRuleDefinition<"avro-fixed-requires-size", {
    readonly default: import("@typespec/compiler").CallableMessage<["property"]>;
}> | import("@typespec/compiler").LinterRuleDefinition<"protobuf-no-duplicate-field-numbers", {
    readonly default: import("@typespec/compiler").CallableMessage<["model", "number", "first", "second"]>;
}>)[];
