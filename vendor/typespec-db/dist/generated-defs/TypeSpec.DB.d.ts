import type { DecoratorContext, DecoratorValidatorCallbacks, Model, ModelProperty, Namespace, Scalar, Type } from "@typespec/compiler";
/**
 * Mark a model as a database table.
 */
export type TableDecorator = (context: DecoratorContext, target: Model) => DecoratorValidatorCallbacks | void;
/**
 * Mark a model property as a primary key column.
 * @param order Optional ordering index for composite primary keys.
 */
export type PrimaryKeyDecorator = (context: DecoratorContext, target: ModelProperty, order?: number) => DecoratorValidatorCallbacks | void;
/**
 * Mark a model property as having a unique constraint.
 */
export type UniqueDecorator = (context: DecoratorContext, target: ModelProperty) => DecoratorValidatorCallbacks | void;
/**
 * Mark a model property as a foreign key reference to another table.
 * @param foreignModel The model (table) being referenced.
 * @param options Optional reference configuration.
 */
export type ReferencesDecorator = (context: DecoratorContext, target: ModelProperty, foreignModel: Model, options?: Type) => DecoratorValidatorCallbacks | void;
/**
 * Define one or more indexes on a table model.
 * @param indexes The index definitions.
 */
export type IndexDecorator = (context: DecoratorContext, target: Model, ...indexes: Type[]) => DecoratorValidatorCallbacks | void;
/**
 * Mark a model property as auto-incrementing.
 */
export type AutoIncrementDecorator = (context: DecoratorContext, target: ModelProperty) => DecoratorValidatorCallbacks | void;
/**
 * Assign a database schema name to a namespace.
 * @param name The schema name.
 */
export type SchemaDecorator = (context: DecoratorContext, target: Namespace, name: string) => DecoratorValidatorCallbacks | void;
/**
 * Set the precision and scale for a decimal column or scalar.
 * @param precision Total number of significant digits.
 * @param scale Optional number of digits after the decimal point (defaults to 0). Must not exceed `precision`.
 */
export type DecimalPrecisionDecorator = (context: DecoratorContext, target: ModelProperty | Scalar, precision: number, scale?: number) => DecoratorValidatorCallbacks | void;
/**
 * Attach a generic key/value metadata option to a column.
 * @param key The option name.
 * @param value The option value.
 */
export type ColumnOptionDecorator = (context: DecoratorContext, target: ModelProperty, key: string, value: unknown) => DecoratorValidatorCallbacks | void;
export type TypeSpecDbDecorators = {
    table: TableDecorator;
    primaryKey: PrimaryKeyDecorator;
    unique: UniqueDecorator;
    references: ReferencesDecorator;
    index: IndexDecorator;
    autoIncrement: AutoIncrementDecorator;
    schema: SchemaDecorator;
    decimalPrecision: DecimalPrecisionDecorator;
    columnOption: ColumnOptionDecorator;
};
