"use client";

// src/features/events/builder/sections/MessagePropertiesCard.tsx
// "Message properties (Trait)" inside a message form: the sets applied to THIS message, each expandable to its properties.
import type { DocMessage } from "@/lib/events/document/types";
import { PropertiesCard, type PropertiesCardProps } from "./PropertiesCard";

export function MessagePropertiesCard({ message, index, ...card }: Omit<PropertiesCardProps, "kind" | "target" | "traitKeys" | "errorPointer"> & { message: DocMessage; index: number }) {
  return <PropertiesCard {...card} kind="MESSAGE" target={{ kind: "message", key: message.key }} traitKeys={message.traitKeys} errorPointer={`/messages/${index}/traitKeys`} />;
}
