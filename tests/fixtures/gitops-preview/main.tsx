import React from "react";
import { createRoot } from "react-dom/client";
import { GitOpsWorkspace } from "@/components/custom/gitops/GitOpsWorkspace";
import { workspaceFixture } from "./fixture";
import "@/app/globals.css";
const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", query.has("dark"));
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-7xl p-4 sm:p-8">
    <GitOpsWorkspace
      initial={workspaceFixture(query.has("viewer"), query.has("root"))}
    />
  </main>,
);
