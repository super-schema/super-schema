import { $autoIncrement, $columnOption, $decimalPrecision, $index, $primaryKey, $references, $schema, $table, $unique, } from "./decorators.js";
export { $lib } from "./lib.js";
/** @internal */
export const $decorators = {
    "TypeSpec.DB": {
        table: $table,
        primaryKey: $primaryKey,
        unique: $unique,
        references: $references,
        index: $index,
        autoIncrement: $autoIncrement,
        schema: $schema,
        decimalPrecision: $decimalPrecision,
        columnOption: $columnOption,
    },
};
