// src/features/events/builder/template/controls/validate.ts
// Checks a form control runs on what the user typed. The value is written as typed (so text is never lost); these only decide
// which message to show next to the field.

export const URL_PROBLEM = "Enter a full web address starting with http:// or https://.";
export const EMAIL_PROBLEM = "Enter an email address like name@example.com.";
export const INTEGER_PROBLEM = "Enter a whole number.";

/** A message when `text` is not an absolute http(s) URL; null for an empty text (optional) or a good address. */
export function urlProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "" ? null : URL_PROBLEM;
  } catch {
    return URL_PROBLEM;
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A message when `text` is not a plain email address; null for an empty text or a good address. */
export function emailProblem(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" || EMAIL.test(trimmed) ? null : EMAIL_PROBLEM;
}

/** The whole number `text` stands for, `undefined` for an empty text, `null` when it is not a whole number. */
export function parseInteger(text: string): number | undefined | null {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}
