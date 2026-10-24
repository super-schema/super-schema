/**
 * The precision and scale a source declares for a decimal (BigQuery `NUMERIC(12, 2)`, Avro `decimal`), checked before they are kept.
 *
 * They end up in two integer columns of the database (`fields.precision`, `fields.scale`: PostgreSQL `Int`), so a value that is not a safe
 * whole number (`99999999999`, `1e309`, `0.5`, a string) must not travel on: the create would fail with an unexpected error for a schema
 * that is otherwise fine. Beyond that, a pair no decimal type can have (a scale above the precision, a precision of 0) is a mistake of the
 * source, and the limits of the dialect say what its type allows. A pair that fails is NOT kept (the field stays a plain decimal) and the
 * import says so in a warning.
 */

export interface DecimalLimits {
  /** What the limits are of, for the warning ("NUMERIC"). */
  what: string;
  maxPrecision: number;
  maxScale: number;
  /** The most digits before the point: precision minus scale. */
  maxIntegerDigits: number;
}

/** No dialect: the widest decimal any of the supported sources has (BigQuery BIGNUMERIC: 76 digits). */
export const GENERIC_DECIMAL_LIMITS: DecimalLimits = { what: "a decimal", maxPrecision: 76, maxScale: 76, maxIntegerDigits: 76 };

/** GoogleSQL parameterized `NUMERIC(P[, S])` / `DECIMAL`: 1 <= P <= 38, 0 <= S <= 9, S <= P, P - S <= 29. */
export const BIGQUERY_NUMERIC_LIMITS: DecimalLimits = { what: "NUMERIC", maxPrecision: 38, maxScale: 9, maxIntegerDigits: 29 };

/** GoogleSQL parameterized `BIGNUMERIC(P[, S])` / `BIGDECIMAL`: 1 <= P <= 76, 0 <= S <= 38, S <= P, P - S <= 38. */
export const BIGQUERY_BIGNUMERIC_LIMITS: DecimalLimits = { what: "BIGNUMERIC", maxPrecision: 76, maxScale: 38, maxIntegerDigits: 38 };

export type DeclaredDecimal = { ok: true; precision: number; scale: number } | { ok: false; reason: string };

/** The declared pair when it is a safe whole-number pair within `limits` (a scale that is not given, `undefined`, is 0), else why not. */
export function declaredDecimalFacts(precision: unknown, scale: unknown, limits: DecimalLimits = GENERIC_DECIMAL_LIMITS): DeclaredDecimal {
  const precisionRange = `a whole number from 1 to ${limits.maxPrecision}`;
  if (typeof precision !== "number" || !Number.isSafeInteger(precision) || precision < 1 || precision > limits.maxPrecision) {
    return { ok: false, reason: `its precision must be ${precisionRange}` };
  }
  const declaredScale = scale === undefined ? 0 : scale;
  const top = Math.min(precision, limits.maxScale);
  if (typeof declaredScale !== "number" || !Number.isSafeInteger(declaredScale) || declaredScale < 0 || declaredScale > top) {
    return { ok: false, reason: `its scale must be a whole number from 0 to ${top} (never above the precision)` };
  }
  if (precision - declaredScale > limits.maxIntegerDigits) {
    return { ok: false, reason: `precision minus scale (the digits before the point) must be at most ${limits.maxIntegerDigits}` };
  }
  return { ok: true, precision, scale: declaredScale };
}
