export { $lib } from "./lib.js";
export { $table, $primaryKey, $unique, $references, $index, $autoIncrement, $schema, $decimalPrecision, $columnOption, } from "./decorators.js";
export { isTable, getPrimaryKeys, isUnique, getReferences, getIndexes, isAutoIncrement, getSchema, getDecimalPrecision, getColumnOptions, } from "./accessors.js";
export type { IndexDef, ReferenceInfo, DecimalPrecisionInfo } from "./accessors.js";
export declare const namespace = "TypeSpec.DB";
