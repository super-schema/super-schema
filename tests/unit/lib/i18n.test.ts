import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import {
  defaultLocale,
  locales,
  localeNames,
  LOCALE_STORAGE_KEY,
} from "@/i18n/config";

// Read message files directly for validation
function readMessages(locale: string) {
  const filePath = path.resolve(
    __dirname,
    `../../../src/i18n/messages/${locale}.json`
  );
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

describe("i18n config", () => {
  it("has 'en' as defaultLocale", () => {
    expect(defaultLocale).toBe("en");
  });

  it("defines 6 locales", () => {
    expect(locales).toHaveLength(6);
    expect(locales).toEqual(["en", "es", "fr", "de", "ja", "zh"]);
  });

  it("has a display name for every locale", () => {
    for (const loc of locales) {
      expect(localeNames[loc]).toBeTruthy();
    }
  });

  it("uses 'super-schema:locale' as storage key", () => {
    expect(LOCALE_STORAGE_KEY).toBe("super-schema:locale");
  });
});

describe("i18n message files", () => {
  const en = readMessages("en");

  const requiredNamespaces = ["nav", "common", "entity", "settings"];

  it("English has all required namespaces", () => {
    for (const ns of requiredNamespaces) {
      expect(en).toHaveProperty(ns);
    }
  });

  it("English settings namespace has required keys", () => {
    const requiredKeys = [
      "title",
      "language",
      "fontSize",
      "theme",
      "small",
      "medium",
      "large",
      "light",
      "dark",
      "system",
      "appearance",
    ];
    for (const key of requiredKeys) {
      expect(en.settings).toHaveProperty(key);
    }
  });

  // Ensure every locale has the same top-level keys as English
  for (const loc of locales) {
    if (loc === "en") continue;
    it(`${loc}.json has all namespaces from en.json`, () => {
      const msgs = readMessages(loc);
      for (const ns of requiredNamespaces) {
        expect(msgs).toHaveProperty(ns);
      }
    });

    it(`${loc}.json settings has same keys as en.json`, () => {
      const msgs = readMessages(loc);
      const enKeys = Object.keys(en.settings).sort();
      const locKeys = Object.keys(msgs.settings).sort();
      expect(locKeys).toEqual(enKeys);
    });
  }
});

describe("getStoredLocale (SSR fallback)", () => {
  it("returns defaultLocale when window is undefined (SSR)", async () => {
    // In Node/vitest without jsdom, window is typically undefined
    // getStoredLocale gracefully falls back to defaultLocale
    const { getStoredLocale } = await import("@/lib/i18n");
    expect(getStoredLocale()).toBe("en");
  });
});
