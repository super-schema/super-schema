# GitOps storage — plan roadmap

Spec: `docs/superpowers/specs/2026-11-02-gitops-storage-design.md`

Implementation status (2026-11-11): phases 2–6 are implemented together in [the integration plan](2026-11-10-gitops-implementation.md), including the default same-repository environment workflow. See [the operating guide](../../gitops-storage.md) and [executed verification](../../testing/gitops-storage-verification.md). Live App registration and ingress activation remain operator setup prerequisites.

The spec covers six subsystems. Each phase gets its own plan, written when the previous one ships, and each produces working, testable
software.

| # | Phase | Spec § | Ships | Plan |
|---|---|---|---|---|
| 1 | Snapshot → promote versioning (both modes) | §7, §8 (version stage) | DB mode: Save snapshot / Promote, SemVer with PATCH | `2026-11-02-phase1-snapshot-versioning.md` |
| 2 | Git provider + identity + bindings | §5.2–5.3, §9.1 (1–2), §10, §11 | `GitProvider`/`GitHubProvider`, GitHub App admin config, Connect GitHub, `TenantGitBinding`, real Test connection; `CONTENT_STORAGE` flag (git mode read-only until phase 4) | `2026-11-10-gitops-implementation.md` |
| 3 | Sync + indexer (projection from Git) | §5.1–5.2, §6, §9.6 | bounded Git object API reads, webhooks + polling, canonical YAML schema + serializer, indexer, IndexError, freshness banner, `superschema validate` CI action | `2026-11-10-gitops-implementation.md` |
| 4 | Change sets + PRs | §8 (change set), §9.2–9.3, §10 | `ChangeSet`/`ChangeSetItem`, `GitContentStore`, Submit → branch/commit/PR as user, PR state mirroring, overlap warnings, stale-base + 3-way refresh, Export to Git bootstrap | `2026-11-10-gitops-implementation.md` |
| 5 | Promotion PRs + CODEOWNERS sync | §7 (4), §9.4, §12 | promotion PR (folder rename, identity rewrite), owners-sync PR | `2026-11-10-gitops-implementation.md` |
| 6 | Product targets + artifact delivery | §9.1 (4), §9.5 | Product settings → Git & targets, delivery worker, rolling delivery PRs, `DeliveryPullRequest`, extended `EmissionTargetStatus` | `2026-11-10-gitops-implementation.md` |

Order rationale: phase 1 has no git dependency and changes the version model every later phase serializes; phases 2→3 give a
read-only git mode before any write path exists; 4 adds writes; 5 and 6 depend on merges being detected by 3.

## Tenant storage follow-up (2026-11-12)

Storage selection is now per tenant. Settings supports database/Git selection, repository root and workflow configuration, GitHub connection, initial PR/index readiness and new tenant onboarding. See [implementation and acceptance](2026-11-12-tenant-storage-onboarding.md) and [operating guide](../../gitops-storage.md). `CONTENT_STORAGE` only initializes legacy null choices; explicit choices survive deployment environment changes.
