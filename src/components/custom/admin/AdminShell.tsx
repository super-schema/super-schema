"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Users, Globe, Zap, Activity, Tags, Settings, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AdminCapabilities } from "@/lib/access/capabilities";

type TabId = "settings" | "users" | "domains" | "emitters" | "health" | "classifications";

/**
 * The tabs of the Admin area, each with the capability that lets a person use it (`null`: every signed-in person, personal settings). The capabilities are
 * the server's reading of the policy (`adminCapabilities`), handed down by the layout: nothing here looks at a role name.
 */
const ADMIN_TABS: ReadonlyArray<{ id: TabId; label: string; icon: typeof Users; href: string; needs: keyof AdminCapabilities | null }> = [
  { id: "settings", label: "Settings", icon: Settings, href: "/admin/settings", needs: null },
  { id: "users", label: "Users", icon: Users, href: "/admin", needs: "users" },
  { id: "domains", label: "Domains", icon: Globe, href: "/admin/domains", needs: "domains" },
  { id: "emitters", label: "Emitters", icon: Zap, href: "/admin/emitters", needs: "emitters" },
  { id: "health", label: "Health", icon: Activity, href: "/admin/health", needs: "health" },
  { id: "classifications", label: "Classifications", icon: Tags, href: "/admin/classifications", needs: "classifications" },
];

/** The tab a path belongs to, whether or not the person may use it (an unknown path under /admin is the Users tab, as it always was). */
export function tabOfPath(pathname: string): TabId {
  if (pathname === "/admin") return "users";
  for (const tab of ADMIN_TABS) {
    if (tab.href !== "/admin" && pathname.startsWith(tab.href)) return tab.id;
  }
  return "users";
}

/** The tabs the capabilities allow, in the order they are shown. */
export function allowedTabs(capabilities: AdminCapabilities) {
  return ADMIN_TABS.filter((tab) => tab.needs === null || capabilities[tab.needs]);
}

/** What a page of the Admin area shows when the signed-in person may not use it: said plainly, with the way back to what they may use. */
export function AdminNoPermission({ settingsHref }: { settingsHref: string | null }) {
  return (
    <section data-testid="admin-no-permission" aria-labelledby="admin-no-permission-title" className="mx-auto flex max-w-lg flex-col items-center gap-space-3 py-space-8 text-center">
      <ShieldOff className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <h2 id="admin-no-permission-title" className="text-heading-3 text-foreground">You do not have permission to use this page</h2>
      <p className="text-body-small text-muted-foreground">
        Administration is for the administrators of this tenant and of the platform. If you need something changed, ask one of them.
      </p>
      {settingsHref && (
        <Link href={settingsHref} className="text-body-small text-primary underline-offset-4 hover:underline">
          Go to your settings
        </Link>
      )}
    </section>
  );
}

/**
 * The header and the tabs of the Admin area around the page. Only the tabs the capabilities allow are drawn, and a page whose tab the person may not use
 * is replaced by the no-permission screen (the page is not rendered, so it asks the server for nothing). This is what a person is shown; every action
 * the pages call asks the policy again on the server.
 */
export function AdminShell({ capabilities, children }: { capabilities: AdminCapabilities; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const tabs = allowedTabs(capabilities);
  const activeTab = tabOfPath(pathname);
  const allowed = tabs.some((tab) => tab.id === activeTab);
  const settings = tabs.find((tab) => tab.id === "settings");

  return (
    <div className="flex flex-col h-full">
      {/* Admin header */}
      <div className="border-b border-border px-space-6 py-space-3">
        <h1 className="text-heading-2 text-foreground mb-space-3">Administration</h1>

        {/* Tab navigation */}
        <nav aria-label="Administration" className="flex gap-space-1" role="tablist">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = allowed && activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                data-testid={`admin-tab-${tab.id}`}
                onClick={() => router.push(tab.href)}
                className={cn(
                  "flex items-center gap-space-2 px-space-3 py-space-2 rounded-md text-body-small transition-colors",
                  isActive ? "bg-accent text-foreground font-medium" : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                )}
              >
                <Icon className="w-4 h-4" aria-hidden="true" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-space-6">{allowed ? children : <AdminNoPermission settingsHref={settings?.href ?? null} />}</div>
    </div>
  );
}
