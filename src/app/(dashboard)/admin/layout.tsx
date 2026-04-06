"use client";

import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  Users,
  Globe,
  Zap,
  Activity,
  Tags,
  Settings,
} from "lucide-react";

const ADMIN_TABS = [
  { id: "settings", label: "Settings", icon: Settings, href: "/admin/settings" },
  { id: "users", label: "Users", icon: Users, href: "/admin" },
  { id: "domains", label: "Domains", icon: Globe, href: "/admin/domains" },
  { id: "emitters", label: "Emitters", icon: Zap, href: "/admin/emitters" },
  { id: "health", label: "Health", icon: Activity, href: "/admin/health" },
  { id: "classifications", label: "Classifications", icon: Tags, href: "/admin/classifications" },
] as const;

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  function getActiveTab() {
    if (pathname === "/admin") return "users";
    for (const tab of ADMIN_TABS) {
      if (tab.href !== "/admin" && pathname.startsWith(tab.href)) return tab.id;
    }
    return "users";
  }

  const activeTab = getActiveTab();

  return (
    <div className="flex flex-col h-full">
      {/* Admin header */}
      <div className="border-b border-border px-space-6 py-space-3">
        <h1 className="text-heading-2 text-foreground mb-space-3">
          Administration
        </h1>

        {/* Tab navigation */}
        <nav className="flex gap-space-1" role="tablist">
          {ADMIN_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                onClick={() => router.push(tab.href)}
                className={cn(
                  "flex items-center gap-space-2 px-space-3 py-space-2 rounded-md text-body-small transition-colors",
                  isActive
                    ? "bg-accent text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                )}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto p-space-6">
        {children}
      </div>
    </div>
  );
}
