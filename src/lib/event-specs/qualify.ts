import { compareStrings } from "./diagnostics";

/**
 * Spec §7.2 step 5 name-clash qualification, deterministic regardless of input order.
 *
 * - Names unique in the document stay as they are.
 * - Same name from different owners: items owned by the spec's home product keep
 *   the plain name; foreign items become `<owner>.<name>` (`checkout.orders`).
 * - Anything still colliding (same owner, same name — e.g. two versions of one
 *   Message in one spec) gets `_2`, `_3`, … in key order and is reported.
 *
 * Format qualification (`OrderCreated_avro` / `OrderCreated_json`) is applied by
 * the caller to `name` before calling this (see `assembleAsyncApi3`).
 */

export type NameCandidate = {
  /** Stable identity of the item (catalog id, or `id|formatSuffix` for message variants). */
  key: string;
  /** Unqualified name. */
  name: string;
  /** Owning product (or level) slug. */
  owner: string;
};

export type QualifiedNames = {
  names: Map<string, string>;
  /** Keys that needed a numeric suffix, sorted. */
  disambiguated: string[];
};

export function qualifyNames(items: NameCandidate[], homeOwner: string): QualifiedNames {
  const owners = new Map<string, Set<string>>();
  for (const item of items) {
    const set = owners.get(item.name) ?? new Set<string>();
    set.add(item.owner);
    owners.set(item.name, set);
  }

  const proposals = items.map((item) => {
    const clash = (owners.get(item.name)?.size ?? 0) > 1;
    return { key: item.key, proposal: clash && item.owner !== homeOwner ? `${item.owner}.${item.name}` : item.name };
  });
  proposals.sort((a, b) => compareStrings(a.proposal, b.proposal) || compareStrings(a.key, b.key));

  const taken = new Set<string>();
  const names = new Map<string, string>();
  const disambiguated: string[] = [];
  for (const { key, proposal } of proposals) {
    let name = proposal;
    if (taken.has(name)) {
      let n = 2;
      while (taken.has(`${proposal}_${n}`)) n++;
      name = `${proposal}_${n}`;
      disambiguated.push(key);
    }
    taken.add(name);
    names.set(key, name);
  }
  return { names, disambiguated: disambiguated.sort(compareStrings) };
}
