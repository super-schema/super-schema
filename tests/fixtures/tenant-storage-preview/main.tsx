import React from "react";
import { createRoot } from "react-dom/client";
import { TenantStorageSettings } from "@/components/custom/tenant-storage/TenantStorageSettings";
import { storageFixture } from "./fixture";
import "@/app/globals.css";
const query = new URLSearchParams(location.search);
document.documentElement.style.setProperty(
  "--font-geist-sans",
  "Arial, sans-serif",
);
document.documentElement.classList.toggle("dark", query.has("dark"));
createRoot(document.getElementById("root")!).render(
  <main>
    <TenantStorageSettings
      initial={storageFixture(query.has("git") ? "git" : "database")}
    />
  </main>,
);
