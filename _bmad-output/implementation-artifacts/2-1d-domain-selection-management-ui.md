# Story 2.1d: Domain Selection & Management UI

Status: review

## Story

As an **administrator**,
I want a domain management landing page with a card grid where I can view, create, and select domains,
So that logical entities are always organized under a domain and users start their workflow by choosing a domain context.

## Acceptance Criteria

**Given** the domain service layer and database schema exist (Stories 2.1–2.1c complete)
**When** the domain management UI is implemented
**Then** navigating to `/schemas` renders a Domain Selection page showing all domains as a responsive card grid
**And** the Left Sidebar displays an explorer-style tree hierarchy showing domains as collapsible folders with entities as children
**And** clicking a domain card navigates to `/schemas/{domain-slug}`
**And** the `/schemas/{domain-slug}` route renders entity workspace scoped to the selected domain
**And** only Admin role users see the "+ Create Domain" button
**And** system domains (Public, Playground) cannot be deleted
**And** a search/filter bar filters domains and entities across the tree
**And** seeded system domains (Public, Playground) always appear first

## Tasks / Subtasks

### Task 1: Database seed script for default domains
- [x] Create `prisma/seed.ts` — idempotently creates Public and Playground system domains
- [x] Configure seed command in `package.json`: `"prisma:seed": "npx tsx prisma/seed.ts"`
- [x] Run seed and verify domains exist

### Task 2: Domain slug utilities
- [x] Create `src/lib/domain-utils.ts` with `toSlug(name)` and `fromSlug(slug)` functions
- [x] Slug format: lowercase, spaces→hyphens, strip non-alphanumeric except hyphens

### Task 3: Domain card grid page (`/schemas`)
- [x] Rewrite `src/app/(dashboard)/schemas/page.tsx` as server component that fetches domains
- [x] Create `src/components/custom/DomainCard.tsx` — glass card with name, description, entity count, system badge
- [x] Public domain card: primary color border accent
- [x] Playground domain card: secondary color border accent + tagline
- [x] Search/filter bar at top of center panel
- [x] "+ Create Domain" button (admin-only, initially visible to all until RBAC in Story 8.1)
- [x] Create domain dialog with name + description inputs
- [x] Entrance animation using `animate-auth-fade-up`

### Task 4: Explorer tree sidebar
- [x] Update `src/components/layout/LeftSidebar.tsx` — replace placeholder with domain→entity tree
- [x] Each domain: folder icon, name, entity count badge, collapsible
- [x] Each entity: monospace name, status dot (green/amber/gray)
- [x] Search filter at top filters across entire tree
- [x] "+" hover button on domain nodes to create entity
- [x] Click domain → navigate to `/schemas/{domain-slug}`
- [x] Click entity → navigate to `/schemas/{domain-slug}/{entityId}`

### Task 5: Domain-scoped entity route
- [x] Create `src/app/(dashboard)/schemas/[domainSlug]/page.tsx` — entity list within domain
- [x] Breadcrumb: "Domains" → "{Domain Name}"
- [x] Empty state when domain has no entities

### Task 6: Server actions for domain CRUD
- [x] Create `src/app/(dashboard)/schemas/actions.ts` — createDomain, getDomains server actions
- [x] Wire up to domain service layer

### Task 7: Unit tests
- [x] Test DomainCard renders correctly
- [x] Test slug utilities
- [x] Test domain grid renders seeded domains first

## Dev Notes

### Architecture
- Server components fetch domain data directly via Prisma (no oRPC needed for initial load)
- Client components use server actions for mutations (createDomain)
- Sidebar tree fetches via oRPC from client side
- Domain slug derived from name for URL-friendly routes

### File Structure
```
prisma/seed.ts                                    # NEW
src/lib/domain-utils.ts                           # NEW
src/app/(dashboard)/schemas/page.tsx               # REWRITE
src/app/(dashboard)/schemas/actions.ts             # NEW
src/app/(dashboard)/schemas/[domainSlug]/page.tsx  # NEW
src/components/custom/DomainCard.tsx               # NEW
src/components/layout/LeftSidebar.tsx              # REWRITE
```

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6 (1M context)

### Completion Notes List
- All 7 tasks completed. 110 total tests pass (7 new), build clean.
- Seed script creates Public + Playground system domains idempotently
- Domain card grid at /schemas with search, create dialog, entrance animation
- Explorer tree sidebar with collapsible domains, entity children, status dots, search filter
- /schemas/[domainSlug] route with breadcrumb, entity cards, empty state
- /api/domains-tree API route for sidebar data
- DomainCard component with system badge, entity count, playground tagline

### Change Log
- 2026-04-03: Story 2.1d implementation complete
