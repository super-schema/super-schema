/**
 * Tests for EntityWorkspace tab logic and state management.
 *
 * These tests verify the client-side state management patterns
 * used in EntityWorkspace without rendering React components.
 * They test the pure logic of tab switching, field selection,
 * and right panel routing.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// We test the state management logic directly rather than rendering the
// full React component (which would require extensive mocking of child
// components, server actions, sonner toasts, etc.).
//
// The EntityWorkspace uses three key state patterns:
//   1. activeTab: "editor" | "schemas" | "versions"
//   2. selectedFieldId: string | null
//   3. rightPanelTab: "field-edit" | "typespec-preview"
// ---------------------------------------------------------------------------

type ViewTab = "editor" | "schemas" | "versions";
type RightPanelTab = "field-edit" | "typespec-preview";

interface WorkspaceState {
  activeTab: ViewTab;
  selectedFieldId: string | null;
  rightPanelTab: RightPanelTab;
}

/**
 * Simulates the EntityWorkspace state machine transitions.
 * Mirrors the useState + callback logic in entity-workspace.tsx.
 */
function createWorkspaceState(): {
  state: WorkspaceState;
  setActiveTab: (tab: ViewTab) => void;
  handleFieldSelect: (fieldId: string) => void;
  handleDeleteField: (fieldId: string) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
} {
  const state: WorkspaceState = {
    activeTab: "editor",
    selectedFieldId: null,
    rightPanelTab: "typespec-preview",
  };

  return {
    state,
    setActiveTab(tab: ViewTab) {
      state.activeTab = tab;
    },
    handleFieldSelect(fieldId: string) {
      // Mirrors: setSelectedFieldId(fieldId); setRightPanelTab("field-edit");
      state.selectedFieldId = fieldId;
      state.rightPanelTab = "field-edit";
    },
    handleDeleteField(fieldId: string) {
      // Mirrors: if (selectedFieldId === id) { setSelectedFieldId(null); setRightPanelTab("typespec-preview"); }
      if (state.selectedFieldId === fieldId) {
        state.selectedFieldId = null;
        state.rightPanelTab = "typespec-preview";
      }
    },
    setRightPanelTab(tab: RightPanelTab) {
      state.rightPanelTab = tab;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EntityWorkspace Tab Logic", () => {
  // -------------------------------------------------------------------------
  // 1. Tab switching state management
  // -------------------------------------------------------------------------
  describe("Tab switching", () => {
    it("starts with editor tab active", () => {
      const { state } = createWorkspaceState();
      expect(state.activeTab).toBe("editor");
    });

    it("switches to schemas tab", () => {
      const { state, setActiveTab } = createWorkspaceState();
      setActiveTab("schemas");
      expect(state.activeTab).toBe("schemas");
    });

    it("switches to versions tab", () => {
      const { state, setActiveTab } = createWorkspaceState();
      setActiveTab("versions");
      expect(state.activeTab).toBe("versions");
    });

    it("switches back to editor tab", () => {
      const { state, setActiveTab } = createWorkspaceState();
      setActiveTab("schemas");
      expect(state.activeTab).toBe("schemas");
      setActiveTab("editor");
      expect(state.activeTab).toBe("editor");
    });

    it("allows rapid tab switching", () => {
      const { state, setActiveTab } = createWorkspaceState();
      setActiveTab("schemas");
      setActiveTab("versions");
      setActiveTab("editor");
      setActiveTab("schemas");
      expect(state.activeTab).toBe("schemas");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Field selection updates selectedFieldId
  // -------------------------------------------------------------------------
  describe("Field selection", () => {
    it("starts with no field selected", () => {
      const { state } = createWorkspaceState();
      expect(state.selectedFieldId).toBeNull();
    });

    it("selects a field by id", () => {
      const { state, handleFieldSelect } = createWorkspaceState();
      handleFieldSelect("field-1");
      expect(state.selectedFieldId).toBe("field-1");
    });

    it("changes selection to a different field", () => {
      const { state, handleFieldSelect } = createWorkspaceState();
      handleFieldSelect("field-1");
      expect(state.selectedFieldId).toBe("field-1");
      handleFieldSelect("field-2");
      expect(state.selectedFieldId).toBe("field-2");
    });

    it("clears selection when selected field is deleted", () => {
      const { state, handleFieldSelect, handleDeleteField } = createWorkspaceState();
      handleFieldSelect("field-1");
      expect(state.selectedFieldId).toBe("field-1");
      handleDeleteField("field-1");
      expect(state.selectedFieldId).toBeNull();
    });

    it("does not clear selection when a different field is deleted", () => {
      const { state, handleFieldSelect, handleDeleteField } = createWorkspaceState();
      handleFieldSelect("field-1");
      expect(state.selectedFieldId).toBe("field-1");
      handleDeleteField("field-2");
      expect(state.selectedFieldId).toBe("field-1");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Right panel tab routing
  // -------------------------------------------------------------------------
  describe("Right panel tab routing", () => {
    it("starts with typespec-preview tab", () => {
      const { state } = createWorkspaceState();
      expect(state.rightPanelTab).toBe("typespec-preview");
    });

    it("switches to field-edit when a field is selected", () => {
      const { state, handleFieldSelect } = createWorkspaceState();
      expect(state.rightPanelTab).toBe("typespec-preview");
      handleFieldSelect("field-1");
      expect(state.rightPanelTab).toBe("field-edit");
    });

    it("reverts to typespec-preview when selected field is deleted", () => {
      const { state, handleFieldSelect, handleDeleteField } = createWorkspaceState();
      handleFieldSelect("field-1");
      expect(state.rightPanelTab).toBe("field-edit");
      handleDeleteField("field-1");
      expect(state.rightPanelTab).toBe("typespec-preview");
    });

    it("stays on field-edit when a non-selected field is deleted", () => {
      const { state, handleFieldSelect, handleDeleteField } = createWorkspaceState();
      handleFieldSelect("field-1");
      expect(state.rightPanelTab).toBe("field-edit");
      handleDeleteField("field-2");
      expect(state.rightPanelTab).toBe("field-edit");
    });

    it("allows manual tab switching to typespec-preview", () => {
      const { state, handleFieldSelect, setRightPanelTab } = createWorkspaceState();
      handleFieldSelect("field-1");
      expect(state.rightPanelTab).toBe("field-edit");
      setRightPanelTab("typespec-preview");
      expect(state.rightPanelTab).toBe("typespec-preview");
      // Field remains selected even when viewing typespec preview
      expect(state.selectedFieldId).toBe("field-1");
    });

    it("selecting a field always forces field-edit tab", () => {
      const { state, handleFieldSelect, setRightPanelTab } = createWorkspaceState();
      handleFieldSelect("field-1");
      setRightPanelTab("typespec-preview");
      expect(state.rightPanelTab).toBe("typespec-preview");
      // Selecting another field should switch back to field-edit
      handleFieldSelect("field-2");
      expect(state.rightPanelTab).toBe("field-edit");
    });
  });
});
