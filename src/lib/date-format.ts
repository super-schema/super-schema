type DateInput = Date | string | number | null | undefined;

const DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function toValidDate(value: DateInput): Date | null {
  if (value == null) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateOnly(value: DateInput): string {
  const date = toValidDate(value);
  return date ? DATE_FORMATTER.format(date) : "—";
}

export function formatDateTime(value: DateInput): string {
  const date = toValidDate(value);
  return date ? DATE_TIME_FORMATTER.format(date) : "—";
}
