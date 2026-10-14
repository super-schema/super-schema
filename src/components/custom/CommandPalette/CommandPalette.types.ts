export interface CommandPaletteEntity {
  id: string;
  name: string;
  slug?: string;
  domainName: string;
  /** null for tenant-level (enterprise) entities. */
  domainSlug: string | null;
  /** null / undefined for tenant-level (enterprise) entities. */
  productSlug?: string | null;
  status?: string;
  fieldCount?: number;
}

export interface CommandPaletteField {
  id: string;
  slug?: string;
  name: string;
  type: string;
  entityId: string;
  entitySlug?: string;
  entityName: string;
  domainSlug: string;
  productSlug?: string;
}

export interface CommandPaletteAction {
  id: string;
  label: string;
  icon: React.ReactNode;
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
}

export interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  entities?: CommandPaletteEntity[];
  fields?: CommandPaletteField[];
  actions?: CommandPaletteAction[];
}
