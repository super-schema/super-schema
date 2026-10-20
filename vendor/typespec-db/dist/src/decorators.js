import { $lib, state } from "./lib.js";
export function $table(context, target) {
    context.program.stateSet(state.table).add(target);
}
export function $primaryKey(context, target, order) {
    if (target.optional) {
        $lib.reportDiagnostic(context.program, {
            code: "invalid-primary-key",
            target,
        });
        return;
    }
    context.program.stateMap(state.primaryKey).set(target, order ?? -1);
}
export function $unique(context, target) {
    context.program.stateSet(state.unique).add(target);
}
export function $references(context, target, foreignModel, options) {
    // Validate that the foreign model is decorated with @table
    if (!context.program.stateSet(state.table).has(foreignModel)) {
        $lib.reportDiagnostic(context.program, {
            code: "invalid-reference-target",
            format: { modelName: foreignModel.name },
            target,
        });
        return;
    }
    const refInfo = { target: foreignModel };
    if (options && options.kind === "Model") {
        const columnsVal = options.properties.get("columns");
        if (columnsVal) {
            const colType = columnsVal.type;
            if (colType.kind === "Tuple") {
                refInfo.columns = colType.values.map((v) => v.value);
            }
        }
        const onDeleteVal = options.properties.get("onDelete");
        if (onDeleteVal) {
            const odType = onDeleteVal.type;
            if (odType.kind === "String") {
                refInfo.onDelete = odType.value;
            }
        }
    }
    context.program.stateMap(state.references).set(target, refInfo);
}
export function $index(context, target, ...indexes) {
    const stateMap = context.program.stateMap(state.index);
    const existing = stateMap.get(target) ?? [];
    for (const idx of indexes) {
        if (idx.kind !== "Model")
            continue;
        const indexDef = {};
        const columnsVal = idx.properties.get("columns");
        if (columnsVal) {
            const colType = columnsVal.type;
            if (colType.kind === "Tuple") {
                const columns = colType.values.map((v) => v.value);
                indexDef.columns = columns;
                // Validate column names exist on the model
                for (const col of columns) {
                    if (!target.properties.has(col)) {
                        $lib.reportDiagnostic(context.program, {
                            code: "invalid-index-column",
                            format: { columnName: col, modelName: target.name },
                            target,
                        });
                    }
                }
            }
        }
        const nameVal = idx.properties.get("name");
        if (nameVal && nameVal.type.kind === "String") {
            indexDef.name = nameVal.type.value;
        }
        const uniqueVal = idx.properties.get("unique");
        if (uniqueVal && uniqueVal.type.kind === "Boolean") {
            indexDef.unique = uniqueVal.type.value;
        }
        existing.push(indexDef);
    }
    stateMap.set(target, existing);
}
export function $autoIncrement(context, target) {
    // Validate that the property type is an integer scalar
    const type = target.type;
    const isInteger = type.kind === "Scalar" &&
        (type.name === "int8" ||
            type.name === "int16" ||
            type.name === "int32" ||
            type.name === "int64" ||
            type.name === "uint8" ||
            type.name === "uint16" ||
            type.name === "uint32" ||
            type.name === "uint64" ||
            type.name === "integer" ||
            type.name === "safeint");
    if (!isInteger) {
        $lib.reportDiagnostic(context.program, {
            code: "invalid-auto-increment-type",
            target,
        });
        return;
    }
    context.program.stateSet(state.autoIncrement).add(target);
}
export function $schema(context, target, name) {
    context.program.stateMap(state.schema).set(target, name);
}
export function $decimalPrecision(context, target, precision, scale) {
    const scaleVal = scale ?? 0;
    if (precision < 0 || scaleVal < 0) {
        $lib.reportDiagnostic(context.program, {
            code: "invalid-decimal-precision",
            target,
        });
        return;
    }
    if (scaleVal > precision) {
        $lib.reportDiagnostic(context.program, {
            code: "invalid-decimal-scale",
            target,
        });
        return;
    }
    context.program
        .stateMap(state.decimalPrecision)
        .set(target, { precision, scale: scaleVal });
}
export function $columnOption(context, target, key, value) {
    const stateMap = context.program.stateMap(state.columnOption);
    const existing = stateMap.get(target) ?? {};
    existing[key] = value;
    stateMap.set(target, existing);
}
export const namespace = "TypeSpec.DB";
