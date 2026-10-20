export declare const $lib: import("@typespec/compiler").TypeSpecLibrary<{
    "invalid-primary-key": {
        readonly default: "Primary key property cannot be optional.";
    };
    "invalid-reference-target": {
        readonly default: import("@typespec/compiler").CallableMessage<["modelName"]>;
    };
    "invalid-index-column": {
        readonly default: import("@typespec/compiler").CallableMessage<["columnName", "modelName"]>;
    };
    "invalid-auto-increment-type": {
        readonly default: "Auto-increment can only be applied to integer properties.";
    };
    "invalid-decimal-precision": {
        readonly default: "Decimal precision and scale must be non-negative.";
    };
    "invalid-decimal-scale": {
        readonly default: "Decimal scale cannot exceed precision.";
    };
}, Record<string, any>, never>;
export type DbLibrary = typeof $lib;
declare const keys: readonly ["table", "primaryKey", "unique", "references", "index", "autoIncrement", "schema", "decimalPrecision", "columnOption"];
export declare const state: { [K in (typeof keys)[number]]: symbol; };
export {};
