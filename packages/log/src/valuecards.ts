// Value cards (svl-o6m): a plain value (number, string, bool, tuple of those...) bound to a module-level name
// is a shelf object like an instance, so `score = model.score(...)` leaves a `score` card behind. Pure: derived
// from the log's scope-0 bindings alone, no graph needed.
import type { EventLog, Token } from './types';

/**
 * One binding of a name to a plain value, and how long it stays the name's current value.
 *
 * Decisions (CONTRACTS.md section 8, "Value cards"):
 * - Module-level names only (scope 0). Function locals are not recorded, so they have no card.
 * - One card per (name, value). Rebinding a name to a different value ends the old card (`until`) and makes
 *   a new one: the two are never the same object, so no wire or card pretends `x = 1` became `x = 2`. A name
 *   rebound to the very same token (`x = x`, a loop re-binding an unchanged value) keeps its card.
 * - Augmented assignment (`x += 1`) on a number or string is a new value: a new card, the old card is the
 *   input of the step that made it.
 * - Two names bound to one token (`b = a`) are two cards (each name is a variable), both truthful.
 * - Names the recorder cannot follow (volatile bind sites) never get a card, and a name rebound to
 *   something the recorder does not track (a function, a module) ends its card (a binding with token '').
 */
export interface ValueCard {
  /** `val:<name>:<n>`: the card's node id on the shelf and the stage; `n` counts the name's cards from 0. Deterministic. */
  id: string;
  name: string;
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
  /** Event index of the rebinding that ends the card; the card is last on the shelf at that step. Null: still bound at the end. */
  until: number | null;
  /** Position of the binding in the log, for a stable order between cards of one event. */
  order: number;
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
  const open = new Map<string, ValueCard>();
  const count = new Map<string, number>();
  const bound = new Set<Token>();
  (scope0?.bindings ?? []).forEach(([ev, name, token], order) => {
    if (volatile.has(name)) return;
    const cur = open.get(name);
    const scalar = token.startsWith('s');
    if (cur && scalar && cur.token === token) return;
    if (cur) {
      cur.until = ev;
      open.delete(name);
    }
    if (!scalar) return; // an object, or '' (not tracked): the name no longer holds a plain value
    const n = count.get(name) ?? 0;
    count.set(name, n + 1);
    const p = producer.get(token);
    const v = log.values[token];
    const card: ValueCard = {
      id: `${VALUE_ID_PREFIX}${name}:${n}`,
      name,
      token,
      type: v?.type ?? null,
      text: v?.repr ?? null,
      at: !bound.has(token) && p !== undefined && p <= ev ? p : ev,
      until: null,
      order,
    };
    bound.add(token);
    open.set(name, card);
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
