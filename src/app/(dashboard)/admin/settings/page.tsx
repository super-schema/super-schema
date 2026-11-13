"use client";

import { SettingsPanel } from "@/components/custom/SettingsPanel/SettingsPanel";
import { useTranslations } from "@/lib/i18n";
import Link from "next/link";
import { Button } from "@/components/ui/button";

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
      <section
        className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border p-5"
        aria-labelledby="tenant-storage-heading"
      >
        <div className="flex flex-col gap-1">
          <h3 id="tenant-storage-heading" className="text-heading-3">
            Tenant storage and onboarding
          </h3>
          <p className="text-body-small text-muted-foreground">
            Choose database or Git storage for this tenant, connect a
            repository, or onboard a new tenant. Managed by tenant and platform
            administrators.
          </p>
        </div>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href="/admin/settings/storage" />}
        >
          Manage tenant storage
        </Button>
      </section>
      <section
        className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border p-5"
        aria-labelledby="tenant-dictionaries-heading"
      >
        <div className="flex flex-col gap-1">
          <h3 id="tenant-dictionaries-heading" className="text-heading-3">
            Dictionaries
          </h3>
          <p className="text-body-small text-muted-foreground">
            Define reusable fields and metadata attributes for this tenant, and
            install attribute packs. Managed by tenant administrators.
          </p>
        </div>
        <Button
          variant="outline"
          nativeButton={false}
          render={<Link href="/admin/settings/dictionaries" />}
        >
          Manage dictionaries
        </Button>
      </section>
    </div>
  );
}
