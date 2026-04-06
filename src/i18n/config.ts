/**
 * i18n configuration for Super Schema.
 *
 * Supported locales and their display names.
 */
export const defaultLocale = "en" as const;

export const locales = ["en", "es", "fr", "de", "ja", "zh"] as const;

export type Locale = (typeof locales)[number];

export const localeNames: Record<Locale, string> = {
  en: "English",
  es: "Espanol",
  fr: "Francais",
  de: "Deutsch",
  ja: "Japanese",
  zh: "Chinese",
};

/** localStorage key used to persist the user's locale preference. */
export const LOCALE_STORAGE_KEY = "super-schema:locale";
