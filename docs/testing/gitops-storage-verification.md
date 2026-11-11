# GitOps storage verification

Implementation: 2026-11-10–11. Operating guide: [gitops-storage.md](../gitops-storage.md).

## Executed checks

- Fresh Prisma generation and additive migration application to isolated in-memory PGlite databases.
- TypeScript `tsc --noEmit --incremental false`: passed.
- Production `next build --webpack` on Node 22.22.2: passed. Used `DB_PROVIDER=postgresql` and an isolated, unreachable build-only URL; no live PGlite directory was opened. Existing middleware deprecation and JSON Schema parser dynamic-dependency warnings remain.
- Focused GitOps/deployment/startup tests: 71 passed across 4 files. Combined with the affected regressions below: 294 tests across 23 files.
- Affected GitHub/deployment/middleware/encryption/migration tests: 223 passed across 19 files.
- Scoped ESLint and `git diff --check`: passed.
- Bundled CI validator: valid canonical trees passed in repository-root and folder modes; released-byte mutations failed with both explicit and pull-request-event base SHAs. `node scripts/verify-gitops-validator.mjs`.
- Headless Chrome using the actual `GitOpsWorkspace` component and existing design-system CSS: desktop light (1512px), mobile dark (390px), viewer light (1280px, repository root), viewer mobile dark (390px). All four passed, no page errors and no horizontal overflow. Verified source selection, author creation and viewer read-only source. Actions were mocked in this browser fixture; service mutations are exercised by database and hosted tests. Screenshots: `/tmp/super-schema-gitops-ui/`.

The migrated-database tests cover bootstrap/index-after-merge, private draft visibility, same-PR updates, stale tabs, RBAC, invalid hand edits preserving the projection, immutable releases and frozen IDs, ordered environment promotion, exact product source identity, stable rebuild/version IDs, semantic snapshot increases, lossless released-folder rename, external PR three-way refresh, assembled AsyncAPI history/reference restoration, and leased concurrent job draining.

Reproduce the focused checks with the supported Node version:

```bash
npx vitest run tests/unit/lib/gitops/canonical.test.ts tests/integration/db/gitops-storage-pglite.test.ts tests/integration/db/deployment-workflows-pglite.test.ts tests/unit/lib/db-built-in-traits.test.ts
npx tsc --noEmit --incremental false
CHROME_EXECUTABLE='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/verify-gitops-ui.mjs
```

Set `CHROME_EXECUTABLE` to an installed browser, or install Playwright Chromium and omit it. The preview has no live server actions and cannot mutate GitHub.

## Hosted GitHub proof

Repository: `OnePayPal/event-schema-central`. Run `20261111T015317-d93e5605`, under `.superschema-gitops-proof/20261111T015317-d93e5605`. The real `GitHubProvider` and content/sync/delivery services used a verified human GitHub CLI token and an isolated, migrated in-memory application database.

| Behavior | GitHub evidence |
|---|---|
| Full bootstrap and index after merge | [PR #4](https://github.com/OnePayPal/event-schema-central/pull/4) |
| Private edit, then update the same source PR | [PR #5](https://github.com/OnePayPal/event-schema-central/pull/5) |
| Real TypeSpec JSON Schema artifact PR | [PR #6](https://github.com/OnePayPal/event-schema-central/pull/6) |
| Ordered staging, QA, production | [PR #7](https://github.com/OnePayPal/event-schema-central/pull/7), [#8](https://github.com/OnePayPal/event-schema-central/pull/8), [#9](https://github.com/OnePayPal/event-schema-central/pull/9) |
| Snapshot-to-release PR | [PR #10](https://github.com/OnePayPal/event-schema-central/pull/10) |

The proof checked that the draft left the published projection unchanged, the generated UUID field was a required string with `format: uuid`, four canonical entries appeared in workspace data, and all three environment receipts reached `DELIVERED`. All PRs merged into temporary test branches. The test repository's `main` stayed at `dc7d014bafcbc069f664bbc12e1f747d6e5acdd8` before and after.

Only this run's temporary branches were removed. Cleanup was verified; the repository, `main` and all pre-existing branches remained. The local report is `/tmp/super-schema-gitops-hosted-20261111T015317-d93e5605.json`.

The hosted proof validates real Git operations and the default workflow, not registration of a production GitHub App. Production installation-token exchange, the human OAuth browser callback, signed webhook ingress and organizational branch-protection policy require the operator's App registration and reachable deployment. HMAC validation, private draft/RBAC boundaries and API middleware isolation have automated coverage. The installed application's database/configuration was not changed or activated by these checks.

## Maintenance

Rebuild `.github/actions/gitops-validate/validate.cjs` with `npm run gitops:build-validator` after changing the canonical validator. The smoke script is opt-in and refuses a repository other than the authorized test repository; it creates and cleans only its own uniquely named test branches. Read `scripts/gitops-hosted-smoke.ts` before rerunning it because it creates real PRs.
