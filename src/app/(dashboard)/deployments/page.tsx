"use client";

import Link from "next/link";
import { Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function DeploymentsPage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-space-4 gap-space-4 overflow-auto">
      <div className="flex flex-col items-center text-center max-w-md space-y-space-4">
        <div className="rounded-full bg-muted/40 p-4">
          <Rocket className="w-8 h-8 text-muted-foreground" />
        </div>
        <h1 className="text-heading-2 text-foreground">Deployment Tracking</h1>
        <p className="text-body text-muted-foreground">
          Track which schema versions are deployed to production environments.
          Deploy schemas from the entity Schemas tab.
        </p>
        <Link href="/schemas">
          <Button variant="outline" className="gap-1.5">
            Go to Schemas
          </Button>
        </Link>
      </div>
    </div>
  );
}
