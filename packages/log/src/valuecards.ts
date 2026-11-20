// Value cards (svl-o6m): a plain value (number, string, bool, tuple of those...) bound to a module-level name
// is a shelf object like an instance, so `score = model.score(...)` leaves a `score` card behind. Pure: derived
// from the log's scope-0 bindings alone, no graph needed.
import type { EventLog, Token } from './types';

/**
 * A plain value and the names that hold it (svl-o6m). One card per value's lifetime: names bound to one token
 * at the same time (`b = a`) share the card, like an instance's alias names, so a line that says `b` never
 * shows a card that says only `a`.
 *
 * Decisions (CONTRACTS.md section 8, "Value cards"):
 * - Module-level names only (scope 0). Function locals are not recorded, so they have no card.
 * - A name rebound to a different token leaves the card (its span ends) and starts or joins another card: the
 *   two values are never one object. Rebinding to the same token keeps the name. The card ends when no name
 *   holds its token any more. A name bound again to a token whose card ended gets a new card.
 * - Augmented assignment (`x += 1`) on a number or string is a new value: a new card, and the old card is the
 *   input of the step that made it.
 * - Names the recorder cannot follow (volatile bind sites) never get a card, and a name rebound to something
 *   the recorder does not track (a function, a module) leaves its card (a binding with token '').
 */
export interface ValueCard {
  /** `val:<first name>:<n>`: the card's node id on the shelf and the stage; `n` counts the cards that first-named it. Deterministic. */
  id: string;
  /** The name that first held the value (the shelf slot's label); `valueNames` says the current names. */
  name: string;
  /** Every name that held the value, with when. In binding order. */
  names: ValueName[];
  token: Token;
  type: string | null;
  /** The recorded repr (already cut by the recorder: see `reprTruncated`); null when the recorder kept none. */
  text: string | null;
  /**
   * Event index at which the card exists: the event that produced the value when this is the first name bound
   * to it (a call's return value, an expression), else the latest event started before the binding. As an
   * instance on the shelf, the card is on the stage while that event is current and on the shelf after it.
   */
  at: number;
  /** Event index of the rebinding that took the last name away; the card is last on the shelf at that step. Null: still held at the end. */
  until: number | null;
  /** Position of the binding in the log, for a stable order between cards of one event. */
  order: number;
}

/** A name's time on a card: from the binding's event (exclusive for all but the first name) to `until`. */
export interface ValueName {
  name: string;
  from: number;
  until: number | null;
}

/**
 * The names a card shows at event `cur` (null: the end of the run): the first name from the card's `at`, the
 * others once their binding has passed (`from < cur`), each until its rebinding step (`cur <= until`).
 */
export function valueNames(card: ValueCard, cur: number | null): string[] {
  return card.names
    .filter((n, k) =>
      cur === null
        ? n.until === null
        : (k === 0 ? card.at <= cur : n.from < cur) && (n.until === null || cur <= n.until),
    )
    .map((n) => n.name);
}

const cache = new WeakMap<EventLog, ValueCard[]>();

export const VALUE_ID_PREFIX = 'val:';

/** The value cards of the run, in creation order (`at`, then binding order). */
export function valueCards(log: EventLog): ValueCard[] {
  const hit = cache.get(log);
  if (hit) return hit;
  const out: ValueCard[] = [];
  const volatile = new Set<string>();
  for (const s of log.sites)
    if (s.kind === 'bind' && s.volatile) for (const n of s.targets ?? []) volatile.add(n);
  const producer = new Map<Token, number>();
  for (const e of log.events)
    if (e.scope === 0)
      for (const t of e.outputs) if (t.startsWith('s') && !producer.has(t)) producer.set(t, e.i);
  const scope0 = log.scopes.find((s) => s.id === 0);
  const open = new Map<string, ValueCard>(); // name -> the card it is on
  const live = new Map<Token, ValueCard>(); // token -> its card while some name holds it
  const count = new Map<string, number>();
  const bound = new Set<Token>();
  (scope0?.bindings ?? []).forEach(([ev, name, token], order) => {
    if (volatile.has(name)) return;
    const cur = open.get(name);
    const scalar = token.startsWith('s');
    if (cur && scalar && cur.token === token) return;
    if (cur) {
      const span = cur.names.find((x) => x.name === name && x.until === null)!;
      span.until = ev;
      open.delete(name);
      if (cur.names.every((x) => x.until !== null)) {
        cur.until = ev;
        live.delete(cur.token);
      }
    }
    if (!scalar) return; // an object, or '' (not tracked): the name no longer holds a plain value
    const shared = live.get(token);
    if (shared) {
      shared.names.push({ name, from: ev, until: null });
      open.set(name, shared);
      return;
    }
    const n = count.get(name) ?? 0;
    count.set(name, n + 1);
    const p = producer.get(token);
    const v = log.values[token];
    const card: ValueCard = {
      id: `${VALUE_ID_PREFIX}${name}:${n}`,
      name,
      names: [{ name, from: ev, until: null }],
      token,
      type: v?.type ?? null,
      text: v?.repr ?? null,
      at: !bound.has(token) && p !== undefined && p <= ev ? p : ev,
      until: null,
      order,
    };
    bound.add(token);
    open.set(name, card);
    live.set(token, card);
    out.push(card);
  });
  // a card rebound before the next step (`until === at`) is only ever on the stage, as the output of its event
  const kept = out.sort((a, b) => a.at - b.at || a.order - b.order);
  cache.set(log, kept);
  return kept;
}

/**
 * The card that holds `token` at event `cur`: for an output of the event, the card made by it (`at === cur`);
 * for an input, the earliest-bound card that is on the shelf before the event and not yet replaced by it.
 */
export function valueCardFor(
  log: EventLog,
  token: Token,
  cur: number,
  role: 'input' | 'output',
): ValueCard | undefined {
  return valueCards(log).find(
    (c) =>
      c.token === token &&
      (role === 'output' ? c.at === cur : c.at < cur && (c.until === null || cur <= c.until)),
  );
}
