---
title: Git deployment branch per environment
author: Jsenjaliya
date: 2026-11-12
branch: main
cost: { minutes: 1, tokens: 1026 }
id: l-d9e933bc
scope: repo
status: active
src: agent
---

Before this change, in CONTENT_STORAGE=database mode the deployment environment never affected the Git PR base branch: gitOpsWorkflowPolicy returns null outside git mode, so preview used the connection's single baseBranch (often the GitOps binding branch, since ensureDefaultWorkflow copies binding.branch into the auto-created connection). Now resolution is GitOps product stage branch (any storage mode, via gitOpsStageDestinations) -> connection.environmentBranches[env] -> connection.baseBranch, and the workspace sends resolved gitDestinations so the UI shows the same branch the server will use. GitOps invariant still holds: stage[0].branch must equal binding.branch (settings.ts rejects otherwise), so the first environment PRs into the binding branch by design. Generic Git layout dropped the schemas/<tenant>/ prefix and the <format>/ dir; per-format manifests live in <version>/.superschema/<format>.manifest.json, and same-extension targets (bigquery/postgresql/spanner .sql) collide at one contract version — preview refuses differing bytes.
