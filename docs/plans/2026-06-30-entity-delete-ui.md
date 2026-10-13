# Entity Delete UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add visible delete buttons for entities in all three surfaces: entity detail page (EntityToolbar), domain list view rows, and tile view (always visible, not hover-only).

**Architecture:** Three independent UI changes wiring the existing `deleteEntityAction` server action into missing surfaces. Entity detail page requires navigation back to domain after deletion. All surfaces use a confirmation dialog before destroying data.

**Tech Stack:** Next.js App Router, React client components, Tailwind CSS, Vitest + Testing Library

---

## Context: What Already Exists

- `deleteEntityAction(entityId)` lives in `src/app/(dashboard)/schemas/[domainSlug]/actions.ts`
- `EntityCard` (tile view) has a delete button, but only visible on hover (`opacity-0 group-hover:opacity-100`)
- `DomainWorkspace` already has `deleteConfirm` state + confirmation modal + `handleDeleteEntity` — tile view uses it
- Entity detail page (`EntityWorkspace` + `EntityToolbar`) has zero delete mechanism
- `isReadOnly(status)` returns `true` only for `RETIRED` — delete works for all statuses

---

### Task 1: EntityCard — Always-visible delete button

**Files:**
- Modify: `src/components/custom/EntityCard.tsx:54`
- Test: `tests/unit/components/entity-card-navigation.test.tsx`

**Step 1: Run existing test baseline**

```bash
npx vitest run tests/unit/components/entity-card-navigation.test.tsx
```
Expected: PASS

**Step 2: Add failing test**

Append to `tests/unit/components/entity-card-navigation.test.tsx`:

```typescript
it("delete button is not hidden by opacity (always visible)", () => {
  const onDelete = vi.fn();
  render(
    <EntityCard
      id="entity-1" name="Customer" slug="customer" description="Customer entity"
      status="DRAFT" version={1} fieldCount={3} domainName="Customer Data"
      domainSlug="customer-data" updatedAt={new Date("2026-01-01T00:00:00.000Z")}
      onDelete={onDelete}
    />
  );
  const deleteButton = screen.getByRole("button", { name: /Delete entity Customer/i });
  expect(deleteButton.className).not.toContain("opacity-0");
});
```

**Step 3: Run to verify FAIL**

```bash
npx vitest run tests/unit/components/entity-card-navigation.test.tsx
```
Expected: FAIL — second test fails because `opacity-0` exists.

**Step 4: Fix EntityCard**

In `src/components/custom/EntityCard.tsx` line ~54, change the delete button className:

```tsx
// BEFORE
className="absolute right-space-6 top-space-6 opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"

// AFTER
className="absolute right-space-6 top-space-6 p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
```

**Step 5: Run tests — expect PASS**

```bash
npx vitest run tests/unit/components/entity-card-navigation.test.tsx
```

**Step 6: Commit**

```bash
git add src/components/custom/EntityCard.tsx tests/unit/components/entity-card-navigation.test.tsx
git commit -m "feat: make entity card delete button always visible"
```

---

### Task 2: Domain list view — Delete button per row

**Files:**
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/domain-workspace.tsx` (tbody rows ~line 834)

**Step 1: Add delete button `<td>` to list rows**

In the `<tbody>` section, each `<tr>` has 5 `<td>` cells ending with `formatDateOnly(entity.updatedAt)`.
Add a 6th `<td>` after the date cell:

```tsx
<td className="px-space-4 py-space-3">
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      setDeleteConfirm({ id: entity.id, name: entity.name, type: "entity" });
    }}
    className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
    title={`Delete entity ${entity.name}`}
    aria-label={`Delete entity ${entity.name}`}
  >
    <Trash2 className="w-3.5 h-3.5" />
  </button>
</td>
```

Note: `Trash2` is already imported at the top of `domain-workspace.tsx`.

Also add a blank header to match — in the `columns` array `[{ key: "name", label: "Name" }, ...]`, append:

```tsx
{ key: "actions", label: "" },
```

**Step 2: Verify dev — switch to list view, confirm delete icon appears per row**

**Step 3: Commit**

```bash
git add src/app/\(dashboard\)/schemas/\[domainSlug\]/domain-workspace.tsx
git commit -m "feat: add delete button to entity list view rows"
```

---

### Task 3: EntityToolbar — Accept onDelete prop

**Files:**
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/components/EntityToolbar.tsx`

**Step 1: Replace EntityToolbar content**

Full new content for the file:

```tsx
"use client";

import { PanelRightClose, PanelRightOpen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useRightPanelContent } from "@/hooks/useRightPanelContent";

interface EntityToolbarProps {
  onDelete?: () => void;
}

export function EntityToolbar({ onDelete }: EntityToolbarProps) {
  const { togglePanel, isPanelCollapsed: isCollapsed } = useRightPanelContent();

  return (
    <div className="flex items-center gap-space-2">
      {onDelete && (
        <Button
          variant="outline"
          onClick={onDelete}
          className="gap-1.5 text-muted-foreground hover:text-destructive hover:border-destructive/50"
          title="Delete entity"
        >
          <Trash2 className="w-4 h-4" />
          Delete
        </Button>
      )}
      <Button
        variant="outline"
        onClick={togglePanel}
        className="gap-1.5"
        title={isCollapsed ? "Open side panel" : "Close side panel"}
      >
        {isCollapsed ? (
          <PanelRightOpen className="w-4 h-4" />
        ) : (
          <PanelRightClose className="w-4 h-4" />
        )}
      </Button>
    </div>
  );
}
```

**Step 2: Run regression check**

```bash
npx vitest run tests/unit/components/entity-workspace.test.ts
```
Expected: PASS

**Step 3: Commit**

```bash
git add src/app/\(dashboard\)/schemas/\[domainSlug\]/\[entityId\]/components/EntityToolbar.tsx
git commit -m "feat: add onDelete prop to EntityToolbar"
```

---

### Task 4: EntityWorkspace — Wire delete + confirm dialog

**Files:**
- Modify: `src/app/(dashboard)/schemas/[domainSlug]/[entityId]/entity-workspace.tsx`

**Step 1: Add imports at top of file**

Add alongside existing imports:

```tsx
import { useRouter } from "next/navigation";
import { deleteEntityAction } from "../actions";
```

**Step 2: Add state inside EntityWorkspace function**

After `const [isEmitting, setIsEmitting] = useState(false);`, add:

```tsx
// Entity delete state
const router = useRouter();
const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
const [isDeletingEntity, setIsDeletingEntity] = useState(false);
```

**Step 3: Add delete handler**

After `handleAcknowledge`, add:

```tsx
const handleDeleteEntity = useCallback(async () => {
  setIsDeletingEntity(true);
  try {
    const result = await deleteEntityAction(entity.id);
    if (result.error) {
      toast.error(result.error);
    } else {
      toast.success(`"${entity.name}" deleted`);
      router.push(`/schemas/${entity.domainSlug}`);
    }
  } catch {
    toast.error("Failed to delete entity");
  } finally {
    setIsDeletingEntity(false);
    setDeleteConfirmOpen(false);
  }
}, [entity.id, entity.name, entity.domainSlug, router]);
```

**Step 4: Pass onDelete to EntityToolbar**

Find the `toolbar={<EntityToolbar />}` prop in the JSX and change to:

```tsx
toolbar={
  <EntityToolbar onDelete={() => setDeleteConfirmOpen(true)} />
}
```

**Step 5: Add confirmation dialog**

Inside the return, right before `<div className="animate-auth-fade-up">`, add:

```tsx
{deleteConfirmOpen && (
  <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
    <div className="bg-background border border-border rounded-xl shadow-xl p-space-6 max-w-sm w-full mx-4">
      <h3 className="text-heading-3 text-foreground mb-2">
        Delete &ldquo;{entity.name}&rdquo;?
      </h3>
      <p className="text-body-small text-muted-foreground mb-4">
        Permanently deletes this entity and all its fields. This action cannot be undone.
      </p>
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDeleteConfirmOpen(false)}
          disabled={isDeletingEntity}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={handleDeleteEntity}
          disabled={isDeletingEntity}
        >
          {isDeletingEntity ? "Deleting..." : "Delete"}
        </Button>
      </div>
    </div>
  </div>
)}
```

**Step 6: Run tests**

```bash
npx vitest run tests/unit
```
Expected: All pass (or same pre-existing failures)

**Step 7: Commit**

```bash
git add src/app/\(dashboard\)/schemas/\[domainSlug\]/\[entityId\]/entity-workspace.tsx
git commit -m "feat: wire entity delete into entity detail page"
```

---

### Task 5: Smoke test checklist

Start dev server: `npm run dev`

- [ ] Tile view: delete button visible on every card (no hover required)
- [ ] Tile view: clicking delete shows confirm dialog with entity name
- [ ] Tile view: Cancel closes dialog, entity stays
- [ ] Tile view: Confirm deletes entity, card disappears
- [ ] List view: trash icon visible in rightmost column of every row
- [ ] List view: same confirm + delete flow works
- [ ] Entity detail page: "Delete" button visible in toolbar (right side of header)
- [ ] Entity detail page: clicking Delete shows confirm dialog
- [ ] Entity detail page: Confirm deletes entity and navigates to domain page
- [ ] Entity detail page: Cancel closes dialog, stays on page
