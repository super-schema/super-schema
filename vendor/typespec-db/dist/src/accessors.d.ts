import type { Model, ModelProperty, Namespace, Program, Scalar } from "@typespec/compiler";
export interface ReferenceInfo {
    target: Model;
    columns?: string[];
    onDelete?: string;
}
export interface IndexDef {
    columns: string[];
    name?: string;
    unique?: boolean;
}
export interface DecimalPrecisionInfo {
    precision: number;
    scale: number;
}
/**
 * Check if a model is decorated with `@table`.
 */
export declare function isTable(program: Program, model: Model): boolean;
/**
 * Get primary key properties for a model, sorted by order.
 * Properties with order -1 (default) are sorted by declaration order.
 */
export declare function getPrimaryKeys(program: Program, model: Model): {
    property: ModelProperty;
    order: number;
}[];
/**
 * Check if a property is decorated with `@unique`.
 */
export declare function isUnique(program: Program, property: ModelProperty): boolean;
/**
 * Get reference info for a property decorated with `@references`.
 */
export declare function getReferences(program: Program, property: ModelProperty): ReferenceInfo | undefined;
/**
 * Get all indexes defined on a model.
 */
export declare function getIndexes(program: Program, model: Model): IndexDef[];
/**
 * Check if a property is decorated with `@autoIncrement`.
 */
export declare function isAutoIncrement(program: Program, property: ModelProperty): boolean;
/**
 * Get the schema name for a namespace decorated with `@schema`.
 */
export declare function getSchema(program: Program, namespace: Namespace): string | undefined;
/**
 * Get the decimal precision/scale for a property or scalar decorated with
 * `@decimalPrecision`.
 *
 * When given a `ModelProperty`, the property is checked first; if it has no
 * direct setting, the property's type is walked up its `baseScalar` chain to
 * find an inherited setting.
 */
export declare function getDecimalPrecision(program: Program, target: ModelProperty | Scalar): DecimalPrecisionInfo | undefined;
/**
 * Get all generic key/value metadata options for a property decorated with
 * one or more `@columnOption` decorators.
 */
export declare function getColumnOptions(program: Program, target: ModelProperty): Record<string, unknown>;
