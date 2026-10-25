"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Database,
  GitBranch,
  ShieldCheck,
  ClipboardCheck,
  Settings,
  Rocket,
  BookOpen,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const navItems = [
  { icon: Database, label: "Schema Editor", href: "/schemas" },
  { icon: BookOpen, label: "Glossary", href: "/glossary" },
  { icon: GitBranch, label: "Lineage Graph", href: "/lineage" },
  { icon: ShieldCheck, label: "Governance", href: "/governance" },
  { icon: ClipboardCheck, label: "Compliance", href: "/compliance" },
  { icon: Rocket, label: "Deployments", href: "/deployments" },
  { icon: Settings, label: "Admin", href: "/admin" },
];

export function ActivityBar() {
  const pathname = usePathname();

  return (
    <TooltipProvider>
      <nav
        data-testid="activity-bar"
        aria-label="Main navigation"
        className="w-12 surface-1 flex flex-col items-center pt-space-2 gap-space-1 border-r border-border"
      >
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          return (
            <Tooltip key={item.href}>
              <TooltipTrigger
                render={
                  <Link
                    href={item.href}
                    data-testid={`nav-${item.href.slice(1)}`}
                    aria-label={item.label}
                    aria-current={isActive ? "page" : undefined}
                    className={`relative w-10 h-10 flex items-center justify-center rounded-lg animate-field-hover ${
                      isActive
                        ? "text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {isActive && (
                      <span
                        className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full"
                        style={{
                          background:
                            "linear-gradient(135deg, #A477B2, #F5C0C0)",
                        }}
                      />
                    )}
                    <item.icon className="w-5 h-5" />
                  </Link>
                }
              />
              <TooltipContent side="right">
                <p>{item.label}</p>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </nav>
    </TooltipProvider>
  );
}
