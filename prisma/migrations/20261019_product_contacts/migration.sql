-- Product contacts: an Engineering Lead and a Manager (one mailbox each) and the team's email addresses. A mailbox is
-- stored as canonical text, "jane@acme.com" or "Jane Doe <jane@acme.com>" (the display name rides in the address; there is
-- no separate name column). All additive and optional: existing products keep NULL mailboxes and get an empty team list
-- (the column default fills existing rows). Idempotent so a partial apply can be re-run.
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "engineeringLead" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "manager" TEXT;
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "teamEmails" TEXT[] DEFAULT ARRAY[]::TEXT[];
