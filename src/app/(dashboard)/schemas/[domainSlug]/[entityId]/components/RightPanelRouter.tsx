"use client";

import { useEffect } from "react";
import { FieldQuickEditPanel } from "@/components/custom/FieldQuickEditPanel";
import { TypeSpecPreview } from "@/components/custom/TypeSpecPreview";
import { useRightPanelContent } from "@/hooks/useRightPanelContent";

type RightPanelTab = "quick-edit" | "typespec-preview";

interface FieldData {
  id: string;
  name: string;
  type: string;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isKey: boolean;
  fieldNumber: number | null;
  description: string;
  classification: string | null;
  aliases: string[];
  decorators: Record<string, unknown>;
  sortOrder: number;
}

interface RightPanelRouterProps {
  selectedField: FieldData | null;
  entityId: string;
  entitySlug?: string;
  domainSlug: string;
  isReadOnly: boolean;
  rightPanelTab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  onUpdateField: (id: string, data: Record<string, unknown>) => Promise<void>;
  typeSpecTrigger: number;
}

const TABS: { id: RightPanelTab; label: string }[] = [
  { id: "quick-edit", label: "Quick Edit" },
  { id: "typespec-preview", label: "TypeSpec" },
];

export function RightPanelRouter({
  selectedField,
  entityId,
  entitySlug,
  domainSlug,
  isReadOnly,
  rightPanelTab,
  onTabChange,
  onUpdateField,
  typeSpecTrigger,
}: RightPanelRouterProps) {
  const { setContent: setRightPanelContent } = useRightPanelContent();

  useEffect(() => {
    const rightPanelTabBar = (
      <div className="flex items-center gap-space-1 px-space-3 border-b border-border/50">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`px-space-2 py-space-2 text-caption font-medium transition-colors border-b-2 -mb-px ${
              rightPanelTab === tab.id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
    );

    let tabContent: React.ReactNode = null;

    if (rightPanelTab === "quick-edit") {
      if (selectedField) {
        tabContent = (
          <FieldQuickEditPanel
            key={selectedField.id}
            field={selectedField}
            entityId={entityId}
            entitySlug={entitySlug}
            domainSlug={domainSlug}
            isReadOnly={isReadOnly}
            onUpdateField={onUpdateField}
          />
        );
      } else {
        tabContent = (
          <div className="p-space-4">
            <p className="text-body-small text-muted-foreground">
              Select a field to edit its properties.
            </p>
          </div>
        );
      }
    } else if (rightPanelTab === "typespec-preview") {
      tabContent = (
        <TypeSpecPreview
          entityId={entityId}
          trigger={typeSpecTrigger}
        />
      );
    }

    setRightPanelContent(
      <>
        {rightPanelTabBar}
        <div className="flex-1 overflow-hidden flex flex-col">
          {tabContent}
        </div>
      </>
    );

    return () => {
      setRightPanelContent(null);
    };
  }, [
    rightPanelTab,
    selectedField,
    entityId,
    entitySlug,
    domainSlug,
    isReadOnly,
    onUpdateField,
    typeSpecTrigger,
    setRightPanelContent,
    onTabChange,
  ]);

  // This component renders nothing itself -- it pushes content into the layout's RightPanel via context
  return null;
}
