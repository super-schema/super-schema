import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

const globalsCss = fs.readFileSync(
  path.resolve(__dirname, "../../src/app/globals.css"),
  "utf-8"
);

describe("Design System Tokens", () => {
  describe("Color tokens", () => {
    const expectedColors: Record<string, string> = {
      "--background": "#14141C",
      "--foreground": "#e3e1e4",
      "--card": "#1c1c26",
      "--popover": "#22222e",
      "--primary": "#A477B2",
      "--secondary": "#F5C0C0",
      "--muted": "#2a2a36",
      "--muted-foreground": "#8a8694",
      "--accent": "#3a3a48",
      "--border": "#333340",
      "--destructive": "#e55b5b",
      "--success": "#5bc27a",
      "--warning": "#e5a93b",
      "--info": "#6ba3e8",
    };

    for (const [token, hex] of Object.entries(expectedColors)) {
      it(`defines ${token} as ${hex}`, () => {
        expect(globalsCss).toContain(`${token}: ${hex}`);
      });
    }
  });

  describe("Classification badge colors", () => {
    it("defines PII badge", () => {
      expect(globalsCss).toContain("badge-pii");
      expect(globalsCss).toContain("rgba(229, 91, 91, 0.15)");
    });

    it("defines SENSITIVE badge", () => {
      expect(globalsCss).toContain("badge-sensitive");
      expect(globalsCss).toContain("rgba(229, 169, 59, 0.15)");
    });

    it("defines INTERNAL badge", () => {
      expect(globalsCss).toContain("badge-internal");
      expect(globalsCss).toContain("rgba(107, 163, 232, 0.15)");
    });

    it("defines PUBLIC badge", () => {
      expect(globalsCss).toContain("badge-public");
      expect(globalsCss).toContain("rgba(91, 194, 122, 0.15)");
    });
  });

  describe("Typography", () => {
    it("defines Inter font family", () => {
      expect(globalsCss).toContain('"Inter"');
    });

    it("defines JetBrains Mono font family", () => {
      expect(globalsCss).toContain('"JetBrains Mono"');
    });

    it("defines Fira Code fallback", () => {
      expect(globalsCss).toContain('"Fira Code"');
    });
  });

  describe("Spacing tokens", () => {
    const spacingTokens: Record<string, string> = {
      "--spacing-space-1": "4px",
      "--spacing-space-2": "8px",
      "--spacing-space-3": "12px",
      "--spacing-space-4": "16px",
      "--spacing-space-6": "24px",
      "--spacing-space-8": "32px",
      "--spacing-space-10": "40px",
    };

    for (const [token, value] of Object.entries(spacingTokens)) {
      it(`defines ${token} as ${value}`, () => {
        expect(globalsCss).toContain(`${token}: ${value}`);
      });
    }
  });

  describe("Border radius", () => {
    it("defines global radius as 12px", () => {
      expect(globalsCss).toContain("--radius: 12px");
    });
  });

  describe("Custom design tokens", () => {
    it("defines --glass-bg", () => {
      expect(globalsCss).toContain("--glass-bg: rgba(28, 28, 38, 0.8)");
    });

    it("defines --glass-blur", () => {
      expect(globalsCss).toContain("--glass-blur: blur(12px)");
    });

    it("defines --gradient-border", () => {
      expect(globalsCss).toContain("--gradient-border: linear-gradient(135deg, #A477B2, #F5C0C0)");
    });

    it("defines --transition-spring", () => {
      expect(globalsCss).toContain("--transition-spring: cubic-bezier(0.34, 1.56, 0.64, 1)");
    });

    it("defines --field-complete", () => {
      expect(globalsCss).toContain("--field-complete: #5bc27a");
    });

    it("defines --field-suggestion", () => {
      expect(globalsCss).toContain("--field-suggestion: #e5a93b");
    });

    it("defines --field-error", () => {
      expect(globalsCss).toContain("--field-error: #e55b5b");
    });

    it("defines --mono-size", () => {
      expect(globalsCss).toContain("--mono-size: 13px");
    });
  });

  describe("Surface system", () => {
    it("defines surface-base class", () => {
      expect(globalsCss).toContain(".surface-base");
    });

    it("defines surface-1 class", () => {
      expect(globalsCss).toContain(".surface-1");
    });

    it("defines surface-2 class", () => {
      expect(globalsCss).toContain(".surface-2");
    });

    it("defines surface-glass class", () => {
      expect(globalsCss).toContain(".surface-glass");
    });

    it("defines surface-overlay class", () => {
      expect(globalsCss).toContain(".surface-overlay");
    });
  });

  describe("Animations", () => {
    it("defines prefers-reduced-motion media query", () => {
      expect(globalsCss).toContain("prefers-reduced-motion: reduce");
    });

    it("defines slide-in keyframes", () => {
      expect(globalsCss).toContain("@keyframes slide-in");
    });

    it("defines badge-pop keyframes", () => {
      expect(globalsCss).toContain("@keyframes badge-pop");
    });
  });
});
