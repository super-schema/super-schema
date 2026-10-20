import { createTypeSpecLibrary, paramMessage } from "@typespec/compiler";
const PACKAGE_NAME = "@typespec/db";
export const $lib = createTypeSpecLibrary({
    name: PACKAGE_NAME,
    diagnostics: {
        "invalid-primary-key": {
            severity: "warning",
            messages: {
                default: "Primary key property cannot be optional.",
            },
        },
        "invalid-reference-target": {
            severity: "error",
            messages: {
                default: paramMessage `Referenced model '${"modelName"}' must be decorated with @table.`,
            },
        },
        "invalid-index-column": {
            severity: "error",
            messages: {
                default: paramMessage `Column '${"columnName"}' does not exist on model '${"modelName"}'.`,
            },
        },
        "invalid-auto-increment-type": {
            severity: "error",
            messages: {
                default: "Auto-increment can only be applied to integer properties.",
            },
        },
        "invalid-decimal-precision": {
            severity: "error",
            messages: {
                default: "Decimal precision and scale must be non-negative.",
            },
        },
        "invalid-decimal-scale": {
            severity: "error",
            messages: {
                default: "Decimal scale cannot exceed precision.",
            },
        },
    },
});
const keys = [
    "table",
    "primaryKey",
    "unique",
    "references",
    "index",
    "autoIncrement",
    "schema",
    "decimalPrecision",
    "columnOption",
];
export const state = Object.fromEntries(keys.map((k) => [k, $lib.createStateSymbol(k)]));
