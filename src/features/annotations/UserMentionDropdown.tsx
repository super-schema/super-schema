"use client";

import { useState, useEffect } from "react";

interface UserResult {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
}

interface UserMentionDropdownProps {
  query: string;
  onSelect: (user: UserResult) => void;
  visible: boolean;
}

export function UserMentionDropdown({
  query,
  onSelect,
  visible,
}: UserMentionDropdownProps) {
  const [users, setUsers] = useState<UserResult[]>([]);

  useEffect(() => {
    if (!visible || !query) {
      setUsers([]);
      return;
    }
    // In a real implementation this would call the annotation.searchUsers oRPC endpoint
    // Placeholder for demonstration
    setUsers([]);
  }, [query, visible]);

  if (!visible || users.length === 0) return null;

  return (
    <div className="absolute bottom-full mb-1 left-0 w-64 surface-1 border border-border rounded-lg shadow-lg backdrop-blur-sm z-50 overflow-hidden max-h-48 overflow-y-auto">
      {users.map((user) => (
        <button
          key={user.id}
          onClick={() => onSelect(user)}
          className="w-full flex items-center gap-space-2 px-space-3 py-space-2 hover:bg-accent/50 transition-colors text-left"
        >
          <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-caption text-primary font-medium shrink-0">
            {(user.name || user.email).charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-body-small font-medium text-foreground truncate">
              {user.name || user.email}
            </div>
            <div className="text-caption text-muted-foreground truncate">
              {user.email}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
