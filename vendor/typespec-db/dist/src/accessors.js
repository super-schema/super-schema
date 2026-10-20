import { state } from "./lib.js";
/**
 * Check if a model is decorated with `@table`.
 */
export function isTable(program, model) {
    return program.stateSet(state.table).has(model);
}
/**
 * Get primary key properties for a model, sorted by order.
 * Properties with order -1 (default) are sorted by declaration order.
 */
export function getPrimaryKeys(program, model) {
    const pkMap = program.stateMap(state.primaryKey);
    const result = [];
    let declIndex = 0;
    for (const prop of model.properties.values()) {
        if (pkMap.has(prop)) {
            const order = pkMap.get(prop);
            result.push({ property: prop, order, declIndex });
        }
        declIndex++;
    }
    result.sort((a, b) => {
        const orderA = a.order === -1 ? a.declIndex : a.order;
        const orderB = b.order === -1 ? b.declIndex : b.order;
        return orderA - orderB;
    });
    return result.map(({ property, order }) => ({ property, order }));
}
/**
 * Check if a property is decorated with `@unique`.
 */
export function isUnique(program, property) {
    return program.stateSet(state.unique).has(property);
}
/**
 * Get reference info for a property decorated with `@references`.
 */
export function getReferences(program, property) {
    const refMap = program.stateMap(state.references);
    const ref = refMap.get(property);
    if (!ref)
        return undefined;
    return {
        target: ref.target,
        columns: ref.columns,
        onDelete: ref.onDelete ?? "noAction",
    };
}
/**
 * Get all indexes defined on a model.
 */
export function getIndexes(program, model) {
    const indexMap = program.stateMap(state.index);
    return indexMap.get(model) ?? [];
}
/**
 * Check if a property is decorated with `@autoIncrement`.
 */
export function isAutoIncrement(program, property) {
    return program.stateSet(state.autoIncrement).has(property);
}
/**
 * Get the schema name for a namespace decorated with `@schema`.
 */
export function getSchema(program, namespace) {
    return program.stateMap(state.schema).get(namespace);
}
/**
 * Get the decimal precision/scale for a property or scalar decorated with
 * `@decimalPrecision`.
 *
 * When given a `ModelProperty`, the property is checked first; if it has no
 * direct setting, the property's type is walked up its `baseScalar` chain to
 * find an inherited setting.
 */
export function getDecimalPrecision(program, target) {
    const map = program.stateMap(state.decimalPrecision);
    // Check the target (ModelProperty or Scalar) first.
    if (map.has(target)) {
        return map.get(target);
    }
    // Walk the scalar chain: prop.type -> baseScalar -> ... (or the scalar itself).
    let type = target.kind === "ModelProperty" ? target.type : target;
    while (type && type.kind === "Scalar") {
        if (map.has(type)) {
            return map.get(type);
        }
        type = type.baseScalar;
    }
    return undefined;
}
/**
 * Get all generic key/value metadata options for a property decorated with
 * one or more `@columnOption` decorators.
 */
export function getColumnOptions(program, target) {
    return program.stateMap(state.columnOption).get(target) ?? {};
}
