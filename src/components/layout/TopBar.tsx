"use client";

import { Bell, Search, User, LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { useSession, signOut } from "next-auth/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useCommandPalette } from "@/hooks/useCommandPalette";
import { modKey } from "@/lib/platform";

export function TopBar() {
  const { data: session } = useSession();
  const { open: openPalette } = useCommandPalette();
  const mod = modKey();

  return (
    <header
      data-testid="topbar"
      className="h-12 w-full surface-glass flex items-center justify-between px-space-4 border-b border-border z-10"
    >
      {/* Left: Logo */}
      <div className="flex items-center gap-space-2">
        <span className="text-heading-3 text-primary font-semibold">
          Super Schema
        </span>
      </div>

      {/* Center: Search — clickable to open command palette */}
      <div className="flex-1 max-w-md mx-space-6">
        <button
          onClick={openPalette}
          className="w-full flex items-center gap-space-2 bg-muted rounded-lg px-space-3 py-1.5 border border-border hover:border-primary/40 hover:bg-accent/30 transition-colors text-left"
          title={`Search (${mod}+K)`}
        >
          <Search className="w-4 h-4 text-muted-foreground" />
          <span className="text-body-small text-muted-foreground flex-1">
            Search or press {mod}+K...
          </span>
          <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground bg-background/50 rounded border border-border">
            {mod}+K
          </kbd>
        </button>
      </div>

      {/* Right: Bell + User */}
      <div className="flex items-center gap-space-3">
        <button className="relative p-1.5 rounded-lg hover:bg-accent animate-field-hover">
          <Bell className="w-5 h-5 text-muted-foreground" />
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-primary rounded-full flex items-center justify-center">
            <span className="text-[10px] text-primary-foreground font-medium">
              0
            </span>
          </span>
        </button>

        <Link
          href="/admin"
          className="p-1.5 rounded-lg hover:bg-accent animate-field-hover text-muted-foreground hover:text-foreground"
          title="Settings"
        >
          <Settings className="w-5 h-5" />
        </Link>

        <DropdownMenu>
          <DropdownMenuTrigger className="p-1.5 rounded-lg hover:bg-accent animate-field-hover outline-none">
            {session?.user?.email ? (
              <div className="w-6 h-6 bg-primary rounded-full flex items-center justify-center">
                <span className="text-xs text-primary-foreground font-medium">
                  {session.user.email[0].toUpperCase()}
                </span>
              </div>
            ) : (
              <User className="w-5 h-5 text-muted-foreground" />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {session?.user?.email && (
              <>
                <div className="px-2 py-1.5">
                  <p className="text-body-small text-foreground" data-testid="user-email">
                    {session.user.email}
                  </p>
                </div>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem>Profile</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => signOut({ callbackUrl: "/login" })}
              className="text-destructive"
            >
              <LogOut className="w-4 h-4 mr-2" />
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
