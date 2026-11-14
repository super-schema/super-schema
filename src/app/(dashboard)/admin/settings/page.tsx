"use client";

import { SettingsPanel } from "@/components/custom/SettingsPanel/SettingsPanel";
import { useTranslations } from "@/lib/i18n";

/**
 * Settings tab within the Admin section.
 *
 * Provides user-level preferences: theme, font size, and language.
 */
export default function SettingsPage() {
  const t = useTranslations("settings");

  return (
    <div className="space-y-space-4">
      <div>
        <h2 className="text-heading-3 text-foreground">{t("title")}</h2>
        <p className="text-body-small text-muted-foreground">
          Manage your personal preferences.
        </p>
      </div>
      <SettingsPanel />
    </div>
  );
}
