import { mailtoHref, parseMailbox } from "@/lib/mailbox";
import type { ProductContacts as ProductContactsData } from "@/lib/product-contacts";

/** The stored contacts of a product (canonical mailbox text). */
export type ProductContactsValue = ProductContactsData;

/** One stored mailbox: the name (or the address) as a mailto link, with the address beside a name. Unparseable text stays text. */
function MailboxLink({ stored }: { stored: string }) {
  const parsed = parseMailbox(stored);
  if (!parsed.success) return <span>{stored.trim()}</span>;
  const { name, email } = parsed.data;
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1">
      <a href={mailtoHref(email)} className="text-primary hover:underline">
        {name ?? email}
      </a>
      {name && <span className="text-muted-foreground">{email}</span>}
    </span>
  );
}

function present(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The product's contacts for the page header: Engineering Lead, Manager and the team's addresses, each as a mailto link.
 * Renders nothing at all when the product has none.
 */
export function ProductContacts({ contacts }: { contacts: ProductContactsValue | null | undefined }) {
  if (!contacts) return null;
  const team = (contacts.teamEmails ?? []).filter(present);
  const lead = present(contacts.engineeringLead) ? contacts.engineeringLead : null;
  const manager = present(contacts.manager) ? contacts.manager : null;
  if (!lead && !manager && team.length === 0) return null;

  return (
    <dl
      data-testid="product-contacts"
      aria-label="Product contacts"
      className="flex flex-wrap gap-x-space-6 gap-y-space-2 text-body-small mb-space-4"
    >
      {lead && (
        <div data-testid="product-contact-engineering-lead" className="flex items-baseline gap-space-2">
          <dt className="text-muted-foreground">Engineering Lead</dt>
          <dd>
            <MailboxLink stored={lead} />
          </dd>
        </div>
      )}
      {manager && (
        <div data-testid="product-contact-manager" className="flex items-baseline gap-space-2">
          <dt className="text-muted-foreground">Manager</dt>
          <dd>
            <MailboxLink stored={manager} />
          </dd>
        </div>
      )}
      {team.length > 0 && (
        <div data-testid="product-contact-team" className="flex items-baseline gap-space-2">
          <dt className="text-muted-foreground">Team</dt>
          <dd className="flex flex-wrap gap-x-space-3 gap-y-space-1">
            {team.map((stored, index) => (
              <MailboxLink key={`${index}:${stored}`} stored={stored} />
            ))}
          </dd>
        </div>
      )}
    </dl>
  );
}
