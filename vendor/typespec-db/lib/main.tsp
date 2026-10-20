import "../dist/src/tsp-index.js";

using TypeSpec.Reflection;

namespace TypeSpec.DB;

/**
 * Mark a model as a database table.
 */
extern dec table(target: Model);

/**
 * Mark a model property as a primary key column.
 * @param order Optional ordering index for composite primary keys.
 */
extern dec primaryKey(target: ModelProperty, order?: valueof int32);

/**
 * Mark a model property as having a unique constraint.
 */
extern dec unique(target: ModelProperty);

/**
 * Options for the `@references` decorator.
 */
model ReferenceOptions {
  /** Specific columns on the foreign model to reference. */
  columns?: string[];
  /** Action to take when the referenced row is deleted. */
  onDelete?: "cascade" | "noAction" | "setNull";
}

/**
 * Mark a model property as a foreign key reference to another table.
 * @param foreignModel The model (table) being referenced.
 * @param options Optional reference configuration.
 */
extern dec references(target: ModelProperty, foreignModel: Model, options?: ReferenceOptions);

/**
 * Options for the `@index` decorator.
 */
model IndexOptions {
  /** Column names included in the index. */
  columns: string[];
  /** Optional name for the index. */
  name?: string;
  /** Whether this is a unique index. */
  unique?: boolean;
}

/**
 * Define one or more indexes on a table model.
 * @param indexes The index definitions.
 */
extern dec index(target: Model, ...indexes: IndexOptions[]);

/**
 * Mark a model property as auto-incrementing.
 */
extern dec autoIncrement(target: ModelProperty);

/**
 * Assign a database schema name to a namespace.
 * @param name The schema name.
 */
extern dec schema(target: Namespace, name: valueof string);

/**
 * Set the precision and scale for a decimal column or scalar.
 * @param precision Total number of significant digits.
 * @param scale Optional number of digits after the decimal point (defaults to 0). Must not exceed `precision`.
 */
extern dec decimalPrecision(
  target: decimal | ModelProperty,
  precision: valueof uint8,
  scale?: valueof uint8,
);

/**
 * Attach a generic key/value metadata option to a column. Acts as an escape
 * hatch for database-specific per-column settings. May be applied multiple
 * times with different keys.
 * @param key The option name.
 * @param value The option value.
 */
extern dec columnOption(target: ModelProperty, key: valueof string, value: valueof unknown);
