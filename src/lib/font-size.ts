"use client";

import { useState, useEffect, useCallback } from "react";

/** Available font-size scale labels. */
export type FontScale = "small" | "medium" | "large";

/** Multipliers applied to the 16px base. */
export const fontScaleValues: Record<FontScale, number> = {
  small: 0.875,
  medium: 1.0,
  large: 1.125,
};

export const FONT_SCALE_STORAGE_KEY = "super-schema:font-scale";

const CSS_VAR = "--font-scale";

function getStoredScale(): FontScale {
  if (typeof window === "undefined") return "medium";
  const stored = localStorage.getItem(FONT_SCALE_STORAGE_KEY);
  if (stored && stored in fontScaleValues) return stored as FontScale;
  return "medium";
}

function applyScale(scale: FontScale) {
  document.documentElement.style.setProperty(
    CSS_VAR,
    String(fontScaleValues[scale])
  );
}

/**
 * React hook to manage the global font-size scale.
 *
 * Sets a `--font-scale` CSS variable on `<html>` so that
 * `font-size: calc(16px * var(--font-scale, 1))` in globals.css
 * scales all rem-based dimensions proportionally.
 */
export function useFontSize() {
  const [scale, setScaleState] = useState<FontScale>("medium");

  // Hydrate on mount
  useEffect(() => {
    const stored = getStoredScale();
    setScaleState(stored);
    applyScale(stored);

    function onFontChange(e: Event) {
      const detail = (e as CustomEvent<FontScale>).detail;
      if (detail in fontScaleValues) {
        setScaleState(detail);
        applyScale(detail);
      }
    }
    window.addEventListener("super-schema:font-scale-change", onFontChange);
    return () =>
      window.removeEventListener(
        "super-schema:font-scale-change",
        onFontChange
      );
  }, []);

  const setScale = useCallback((next: FontScale) => {
    localStorage.setItem(FONT_SCALE_STORAGE_KEY, next);
    setScaleState(next);
    applyScale(next);
    window.dispatchEvent(
      new CustomEvent("super-schema:font-scale-change", { detail: next })
    );
  }, []);

  return { scale, setScale };
}
