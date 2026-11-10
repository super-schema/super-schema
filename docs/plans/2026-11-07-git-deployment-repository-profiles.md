# Git deployment and Event Schema Central integration

Status: implementation complete 2026-11-07, with external-service acceptance pending configured destinations. The user selected an opinionated Super Schema hierarchy. This replaces the earlier configurable organization/profile proposal. See the [canonical operating guide](../deployment-workflows.md).

## Hierarchy decision

Identity maps directly from saved tenant/domain/product/schema slugs. The GitHub publisher accepts any configured repository on an approved GitHub host. No organization name is hard-coded into provider operations.

```text
schemas/<tenant>/<domain>/<product>/<schema>/<contractVersion>/<format>/
  <original complete artifact files>
  superschema-manifest.json
```

The format directory separates independent outputs at the same destination SemVer. Source artifact counters never implicitly choose destination SemVer. Generic format/version directories are immutable.

Event Schema Central shares the organizational hierarchy and adds its own contract file grammar:

```text
schemas/<tenant>/<domain>/<product>/<schema>/
  <schema>.yaml
  <semver>_snapshot/
    <schema>.schema.avsc          # or .schema.json
    <schema>.metadata.yaml
    <schema>.example.yaml
    generated/                   # Topic only, from destination tooling
      <schema>.event.yaml
      <schema>_sdk.py
```

Existing parent manifests are required. Reusable `kind: Entity` contracts use the repository's own applicable grammar. Event preparation does not force CloudEvents/SDK sidecars onto generic repositories.

## Gaps closed

| Previous gap | Implementation |
| --- | --- |
| Fabricated export commits and PRs | Real GitHub REST operations; legacy entry points return WORKFLOW_REQUIRED |
| Singleton/global destination selection | Explicit tenant connection and entity workflow; encrypted credentials; administrative legacy import |
| Missing tenant and contract-version identity | Fixed slug hierarchy and explicit destination SemVer |
| Implicit newest artifact or draft export | Exact published version, frozen bytes/files/hash, full reference authorization |
| Field-list intake cannot preserve arbitrary emitted payloads | Preparation-only helper consumes the full pinned artifact; no field-list reconstruction |
| Missing sidecars and generated contract outputs | Repository model/scaffold/generator/SDK/manifest tooling and authored metadata/examples |
| Missing prospective validation | Full make check and evolution gate on an isolated prospective tree before any Git write |
| Duplicate retry or unsafe overwrite | Stable intent/branch, pinned parent, complete tree/content comparison, real PR reconciliation; no force push |
| Deployment result conflated with live deployment | PR receipt and refreshed status, separate manual environment assertions |

## Destination revision constraint

The assessed Event Schema Central checkout is `/Users/jsenjaliya/src/my/event-schema-central`, branch `jay-MS-5917-schema-onboarding`, HEAD `6b1db89`. Its modern working-tree conventions are not all in that commit or the locally cached `origin/main` (`dc7d014`). This is local assessment evidence; no remote ref refresh is claimed.

The preparation adapter checks the actual fetched base and refuses missing modern tooling. Land the target's contract migration or choose a compatible branch before opening a delivery PR. Do not send working-tree conventions to an unmigrated default branch.

## Contract preparation and safety

An operator allowlists each trusted contract repository and installs its toolchain. The remote base is materialized in a disposable directory and checked without passing publishing credentials to the helper. Repository validators execute as the application's OS user, so operational process/container isolation remains necessary. The user's original checkout and index are not touched.

Select Topic/Entity, create/new snapshot/update snapshot, destination version, metadata and a valid example. Existing shared topic configuration is preserved unless explicitly edited. Payload bytes remain exact; incompatible dialect, names, policy, examples or references fail validation. Only the selected contract and product manifest are returned. Released-version edits and promotion are refused by this preparation flow.

## Verified implementation and external gates

Controlled GitHub API tests verify branch/commit/PR creation, base movement, repeat reconciliation and refusal of unrelated branch edits. Tenant authorization, encrypted credentials, frozen plans, durable claims/recovery and audit redaction are covered on actual migrated PGlite tables. Generic file manifests and format isolation are tested.

Disposable copies of the inspected Event Schema Central working tree passed full make check and prospective-tree evolution for Avro `scm-case-created:2.0.0_snapshot` and Draft 2020-12 JSON Schema `user-link-tracked:1.0.0_snapshot`, preserving the pinned payloads. These tests validate the modern local contract. They do not claim a hosted PR exists on the current remote base.

The remaining operational gates are database migration, compatible target branch, configured connection credentials and worker, and live PR acceptance in the intended repositories. GitLab/other Git providers, configurable identity mappings, parent hierarchy onboarding, automatic merge/promotion, independent reusable-entity mapping and downstream application deployment are outside this opinionated first implementation.
