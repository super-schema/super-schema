"use client";

import { GlossaryBrowser } from "@/features/glossary/GlossaryBrowser";

export default function GlossaryPage() {
  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-border">
        <h1 className="text-heading-1 text-foreground">Business Glossary</h1>
        <p className="text-caption text-muted-foreground mt-1">
          Define and manage canonical business concepts across your data estate
        </p>
      </div>
      <div className="flex-1 overflow-hidden">
        <GlossaryBrowser />
      </div>
    </div>
  );
}
