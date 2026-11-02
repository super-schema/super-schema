import type { AuditTrailFilter } from "@/types/schemas/compliance";

/**
 * The Audit Trail's date range, as the screen reads its two date inputs. An input holds a LOCAL calendar day ("YYYY-MM-DD", what a user picked),
 * and the range it makes is the instants that bound that day in the viewer's time zone: `from` is the local midnight that starts the first day,
 * and `to` is EXCLUSIVE, the local midnight that starts the day after the last one (see `AuditTrailFilterSchema`). So a whole day is in the
 * range, wherever the viewer is, and nothing is ever read as UTC midnight.
 */

export type DateRange = NonNullable<AuditTrailFilter["dateRange"]>;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The local midnight that starts the day `value` ("YYYY-MM-DD"); `undefined` for an empty or a day that does not exist (2026-02-30). */
export function dayStart(value: string): Date | undefined {
  const match = DAY.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  // setFullYear, not the constructor: the constructor reads years 0-99 as 1900-1999.
  const date = new Date(0);
  date.setFullYear(year, month, day);
  date.setHours(0, 0, 0, 0);
  const exists = date.getFullYear() === year && date.getMonth() === month && date.getDate() === day;
  return exists ? date : undefined;
}

/** The local midnight that starts the day AFTER `value`: the exclusive end of the day `value`. `undefined` as `dayStart`. */
export function dayAfterStart(value: string): Date | undefined {
  const start = dayStart(value);
  if (!start) return undefined;
  const next = new Date(start.getTime());
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return next;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** The value of a date input for the local day a moment falls on ("" for none). */
export function dayInputValue(moment: Date | undefined): string {
  if (!moment) return "";
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
}

/** The value of the "To" input for an exclusive end: the last local day the range holds (the moment before the end is on it). */
export function lastDayInputValue(exclusiveEnd: Date | undefined): string {
  return exclusiveEnd ? dayInputValue(new Date(exclusiveEnd.getTime() - 1)) : "";
}

/** The range with one of its bounds changed; `undefined` when neither bound is left (no filter at all). */
export function withDateBound(range: DateRange | undefined, bound: { from?: Date; to?: Date }): DateRange | undefined {
  const next: DateRange = { ...range, ...bound };
  return next.from || next.to ? next : undefined;
}
