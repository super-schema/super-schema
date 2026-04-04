export interface CommandPaletteEntity {
  id: string;
  name: string;
  domainName: string;
  domainSlug: string;
  status?: string;
  fieldCount?: number;
}

export interface CommandPaletteField {
  id: string;
  name: string;
  type: string;
  entityId: string;
  entityName: string;
  domainSlug: string;
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
