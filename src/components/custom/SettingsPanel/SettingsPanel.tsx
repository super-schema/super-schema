"use client";

import { useTheme } from "@/lib/theme";
import { Sun, Moon, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLocale, useTranslations } from "@/lib/i18n";
import { useFontSize, type FontScale } from "@/lib/font-size";
import { locales, localeNames, type Locale } from "@/i18n/config";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/* ------------------------------------------------------------------ */
/*  Theme Card                                                         */
/* ------------------------------------------------------------------ */

function ThemeCard({
  value,
  label,
  icon: Icon,
  active,
  onClick,
}: {
  value: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      data-testid={`theme-${value}`}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-space-2 rounded-lg border-2 p-space-4 transition-colors cursor-pointer",
        active
          ? "border-primary bg-primary/10"
          : "border-border hover:border-primary/40 hover:bg-accent/30"
      )}
    >
      {/* Visual preview */}
      <div
        className={cn(
          "w-16 h-12 rounded-md flex items-center justify-center",
          value === "light"
            ? "bg-white text-gray-800"
            : value === "dark"
              ? "bg-[#14141C] text-gray-200 border border-[#333340]"
              : "bg-gradient-to-br from-white to-[#14141C] text-gray-500"
        )}
      >
        <Icon className="w-5 h-5" />
      </div>
      <span className="text-body-small font-medium">{label}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Font Scale Button                                                  */
/* ------------------------------------------------------------------ */

function FontScaleButton({
  value,
  label,
  active,
  sampleSize,
  onClick,
}: {
  value: FontScale;
  label: string;
  active: boolean;
  sampleSize: string;
  onClick: () => void;
}) {
  return (
    <button
      data-testid={`font-${value}`}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-space-3 rounded-lg border-2 px-space-4 py-space-3 transition-colors cursor-pointer flex-1 min-w-[120px]",
        active
          ? "border-primary bg-primary/10"
          : "border-border hover:border-primary/40 hover:bg-accent/30"
      )}
    >
      <span style={{ fontSize: sampleSize }} className="font-semibold leading-none">
        Aa
      </span>
      <span className="text-body-small">{label}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/*  Section wrapper                                                    */
/* ------------------------------------------------------------------ */

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-space-3">
      <div>
        <h3 className="text-heading-3 text-foreground">{title}</h3>
        <p className="text-body-small text-muted-foreground">{description}</p>
      </div>
      <div>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Panel                                                         */
/* ------------------------------------------------------------------ */

export function SettingsPanel() {
  const { theme, setTheme } = useTheme();
  const { scale, setScale } = useFontSize();
  const { locale, setLocale } = useLocale();
  const t = useTranslations("settings");

  const themes = [
    { value: "light", label: t("light"), icon: Sun },
    { value: "dark", label: t("dark"), icon: Moon },
    { value: "system", label: t("system"), icon: Monitor },
  ] as const;

  const fontScales: { value: FontScale; label: string; sample: string }[] = [
    { value: "small", label: t("small"), sample: "13px" },
    { value: "medium", label: t("medium"), sample: "16px" },
    { value: "large", label: t("large"), sample: "19px" },
  ];

  return (
    <div data-testid="settings-panel" className="space-y-space-8 max-w-2xl">
      {/* ---- Appearance / Theme ---- */}
      <SettingsSection title={t("appearance")} description={t("appearanceDesc")}>
        <div className="flex flex-wrap gap-space-3">
          {themes.map((th) => (
            <ThemeCard
              key={th.value}
              value={th.value}
              label={th.label}
              icon={th.icon}
              active={theme === th.value}
              onClick={() => setTheme(th.value)}
            />
          ))}
        </div>
      </SettingsSection>

      {/* ---- Font Size ---- */}
      <SettingsSection title={t("fontSize")} description={t("fontSizeDesc")}>
        <div className="flex flex-wrap gap-space-3">
          {fontScales.map((fs) => (
            <FontScaleButton
              key={fs.value}
              value={fs.value}
              label={fs.label}
              sampleSize={fs.sample}
              active={scale === fs.value}
              onClick={() => setScale(fs.value)}
            />
          ))}
        </div>
      </SettingsSection>

      {/* ---- Language ---- */}
      <SettingsSection title={t("language")} description={t("languageDesc")}>
        <Select
          value={locale}
          onValueChange={(val) => setLocale(val as Locale)}
        >
          <SelectTrigger className="w-60" data-testid="locale-select" aria-label={t("language")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {locales.map((loc) => (
              <SelectItem key={loc} value={loc}>
                {localeNames[loc]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingsSection>
    </div>
  );
}
