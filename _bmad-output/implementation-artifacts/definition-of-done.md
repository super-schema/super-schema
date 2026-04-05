# Definition of Done (DoD)

> Standard checklist applied to every story before marking it as "done".
> Created 2026-04-05.

---

## Checklist

A story is considered **done** when ALL of the following are satisfied:

### Functional Verification
- [ ] All Acceptance Criteria (AC) verified in the running application
- [ ] Feature works end-to-end for the happy path
- [ ] Edge cases and error states handled gracefully

### Code Quality
- [ ] TypeScript compiles cleanly (`npx tsc --noEmit` passes with zero errors)
- [ ] Unit tests pass (`npm test` or `npx vitest run` passes)
- [ ] No console errors on affected pages (check browser DevTools)
- [ ] No new lint warnings introduced (`npm run lint` passes)

### Testing
- [ ] Unit tests written for new services and utility functions
- [ ] Existing tests not broken by changes
- [ ] Test coverage adequate for critical paths (service layer, validation logic)

### Review & Documentation
- [ ] Code reviewed (by peer or via code-review workflow)
- [ ] Sprint status updated in `sprint-status.yaml` (story status set to "done")
- [ ] Deferred items documented in `deferred-work.md` with priority and effort estimate
- [ ] Story file updated with implementation notes (what was built, what deviated from spec)

### Integration
- [ ] No regressions in other features (smoke test adjacent pages)
- [ ] Database migrations applied cleanly (if applicable)
- [ ] Environment variables documented (if new ones added)

---

## Notes

- **E2E tests**: Playwright E2E tests are currently deferred across all stories. When the E2E test sprint begins, each story's E2E criteria should be revisited.
- **Partial completion**: If a story cannot fully meet all AC, document the gaps in `deferred-work.md` and note the deviation in the story file's implementation notes. The story can still be marked "done" if core functionality is delivered and gaps are tracked.
- **Prisma migrations**: Many stories use in-memory stores for MVP. When migrating to database-backed storage, treat the migration as a new story or tech-debt item.
