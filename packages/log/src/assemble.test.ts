import { describe, expect, test } from 'vitest';
import { createAssembler } from './assemble';
import type { FromWorker } from './messages';
import type { Event, Site } from './types';
import { validateLog } from './validate';

type Batch = Extract<FromWorker, { type: 'batch' }>;

const site = (id: number): Site => ({
  id,
  kind: 'call',
  line: id + 1,
  col: 0,
  end_line: id + 1,
  end_col: 5,
  text: `f${id}()`,
  func_text: `f${id}`,
  args: [],
});
const sites = [site(0), site(1), site(2)];

function ev(i: number, s: number, extra: Partial<Event> = {}): Event {
  return {
    i,
    ret: i,
    site: s,
    scope: 0,
    kind: 'function',
    name: `f${s}`,
    module: 'pandas',
    owner: null,
    inputs: [],
    outputs: [`v${i}.0`],
    returns_self: false,
    mutates: [],
    count: 1,
    merge_key: `s${s}`,
    error: null,
    ...extra,
  };
}

function batch(runId: number, extra: Partial<Batch> = {}): Batch {
  return {
    type: 'batch',
    runId,
    events: [],
    open: [],
    values: {},
    bindings: [],
    output: [],
    diagnostics: [],
    ...extra,
  };
}

const vals = (...is: number[]): Batch['values'] =>
  Object.fromEntries(is.map((i) => [`v${i}.0`, { type: 'DF' }]));

describe('assembler', () => {
  test('sorts events that arrive out of start order', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    // inner calls 1,2 finish first; the outer call 0 finishes later
    a.push(batch(1, { events: [ev(1, 1), ev(2, 2)], values: vals(1, 2) }));
    a.push(batch(1, { events: [ev(0, 0, { ret: 2 })], values: vals(0) }));
    a.push({ type: 'done', runId: 1, status: 'ok', error: null });
    const log = a.finish();
    expect(log.events.map((e) => e.i)).toEqual([0, 1, 2]);
    expect(log.events[0]!.ret).toBe(2);
    expect(log.status).toBe('ok');
    validateLog(log);
  });

  test('a slot event replaces the previous slot of its merge key only', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    a.push(
      batch(1, {
        events: [ev(0, 0), ev(1, 0, { slot: true, count: 2 }), ev(2, 1, { slot: true })],
        values: vals(0, 1, 2),
      }),
    );
    a.push(
      batch(1, {
        events: [ev(3, 0, { slot: true, count: 3 }), ev(4, 0, { count: 4 })],
        values: vals(3, 4),
      }),
    );
    const log = a.finish('ok');
    // full event 0 and the non-slot 4 survive; slot 1 is replaced by slot 3; other key's slot 2 survives
    expect(log.events.map((e) => e.i)).toEqual([0, 2, 3, 4]);
  });

  test('open stubs persist until the finished event arrives', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    const stub = { i: 0, site: 0, kind: 'function' as const, name: 'f0', module: 'pandas' };
    a.push(batch(1, { events: [], open: [stub] }));
    a.push(batch(1, { events: [ev(1, 1)], open: [stub], values: vals(1) })); // still open
    expect(a.finish('stopped').events.map((e) => [e.i, e.interrupted === true])).toEqual([
      [0, true],
      [1, false],
    ]);
    // finished event arrives: no stub conversion
    a.push(batch(1, { events: [ev(0, 0, { ret: 1 })], values: vals(0) }));
    const log = a.finish('stopped');
    expect(log.events.map((e) => e.interrupted === true)).toEqual([false, false]);
  });

  test('finish(timeout|stopped) interrupts stubs and a newer currentCall', () => {
    for (const status of ['timeout', 'stopped'] as const) {
      const a = createAssembler();
      a.push({ type: 'started', runId: 1, sites });
      a.push(
        batch(1, {
          events: [ev(2, 2)],
          values: vals(2),
          open: [
            { i: 0, site: 0, kind: 'function', name: 'outer', module: 'sklearn.x' },
            { i: 1, site: 1, kind: 'method', name: 'M.fit', module: 'sklearn.y' },
          ],
        }),
      );
      const log = a.finish(status, { i: 3, site: 2 });
      expect(log.status).toBe(status);
      expect(log.events.map((e) => e.i)).toEqual([0, 1, 2, 3]);
      const [outer, inner, , cur] = log.events as [Event, Event, Event, Event];
      expect(outer).toMatchObject({
        interrupted: true,
        ret: 0,
        outputs: [],
        inputs: [],
        name: 'outer',
      });
      expect(inner).toMatchObject({ kind: 'method', name: 'M.fit', ret: 1, interrupted: true });
      expect(cur).toMatchObject({ i: 3, site: 2, name: 'f2', interrupted: true, ret: 3, count: 2 });
      validateLog(log);
    }
  });

  test('currentCall that is already known is not duplicated', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    const stub = { i: 0, site: 0, kind: 'function' as const, name: 'f0', module: null };
    a.push(batch(1, { open: [stub] }));
    expect(a.finish('timeout', { i: 0, site: 0 }).events).toHaveLength(1);
  });

  test('currentCall that is an outer call with finished inner events is kept', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    a.push(batch(1, { events: [ev(4, 1), ev(5, 2)], values: vals(4, 5) }));
    const log = a.finish('stopped', { i: 3, site: 0 });
    expect(log.events.map((e) => e.i)).toEqual([3, 4, 5]);
    expect(log.events[0]).toMatchObject({ interrupted: true, site: 0, name: 'f0', ret: 3 });
    validateLog(log);
  });

  test('currentCall equal to a finished event i is not duplicated', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    a.push(batch(1, { events: [ev(1, 1), ev(2, 2)], values: vals(1, 2) }));
    const log = a.finish('stopped', { i: 1, site: 1 });
    expect(log.events.map((e) => [e.i, e.interrupted === true])).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  test('done ok clears stubs; error status and error are kept', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    a.push(batch(1, { open: [{ i: 0, site: 0, kind: 'function', name: 'f0', module: null }] }));
    const error = { type: 'ValueError', message: 'x', line: 1, traceback: [] };
    a.push({ type: 'done', runId: 1, status: 'error', error });
    const log = a.finish();
    expect(log.events).toEqual([]);
    expect(log.status).toBe('error');
    expect(log.error).toEqual(error);
  });

  test('values, bindings, output and diagnostics merge across batches', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    a.push(
      batch(1, {
        events: [ev(0, 0)],
        values: vals(0),
        bindings: [
          [0, 0, 'df', 'v0.0'],
          [1, 0, 'inner', 'v0.0'],
        ],
        output: [{ i: -1, stream: 'stdout', text: 'a' }],
        diagnostics: ['d1'],
      }),
    );
    a.push(
      batch(1, {
        events: [ev(1, 1)],
        values: vals(1),
        bindings: [[0, 1, 'df2', 'v1.0']],
        output: [{ i: 1, stream: 'stderr', text: 'b' }],
        diagnostics: ['d2'],
      }),
    );
    const log = a.finish('ok');
    expect(Object.keys(log.values).sort()).toEqual(['v0.0', 'v1.0']);
    expect(log.scopes.map((s) => s.id)).toEqual([0, 1]);
    expect(log.scopes[0]!.name).toBe('<module>');
    expect(log.scopes[0]!.bindings).toEqual([
      [0, 'df', 'v0.0'],
      [1, 'df2', 'v1.0'],
    ]);
    expect(log.scopes[1]!.bindings).toEqual([[0, 'inner', 'v0.0']]);
    expect(log.output.map((o) => o.i)).toEqual([-1, 1]);
    expect(log.diagnostics).toEqual(['d1', 'd2']);
    validateLog(log);
  });

  test('messages for an older or unstarted runId are ignored', () => {
    const a = createAssembler();
    a.push(batch(1, { events: [ev(0, 0)], values: vals(0) })); // before started
    a.push({ type: 'started', runId: 2, sites });
    a.push(batch(1, { events: [ev(0, 0)], values: vals(0) }));
    a.push({ type: 'done', runId: 1, status: 'error', error: null });
    a.push({ type: 'started', runId: 1, sites: [] }); // stale start must not reset
    a.push(batch(2, { events: [ev(5, 1)], values: vals(5) }));
    const log = a.finish();
    expect(log.events.map((e) => e.i)).toEqual([5]);
    expect(log.status).toBe('ok');
    expect(log.sites).toHaveLength(3);
  });

  test('a new started resets state', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    a.push(batch(1, { events: [ev(0, 0)], values: vals(0) }));
    a.push({ type: 'started', runId: 2, sites: [] });
    const log = a.finish();
    expect(log.events).toEqual([]);
    expect(log.values).toEqual({});
  });

  test('snapshot during a run is a valid EventLog and does not freeze the run', () => {
    const a = createAssembler();
    expect(validateLog(a.snapshot()).events).toEqual([]);
    a.push({ type: 'started', runId: 1, sites });
    a.push(
      batch(1, {
        events: [ev(1, 1)],
        values: vals(1),
        open: [{ i: 0, site: 0, kind: 'function', name: 'f0', module: null }],
      }),
    );
    const snap = a.snapshot();
    expect(snap.status).toBe('ok');
    expect(validateLog(snap).events.map((e) => e.i)).toEqual([1]);
    a.push(batch(1, { events: [ev(0, 0)], values: vals(0) }));
    expect(snap.events).toHaveLength(1); // earlier snapshot unaffected
    expect(a.snapshot().events).toHaveLength(2);
  });

  test('client-only messages are ignored', () => {
    const a = createAssembler();
    a.push({ type: 'ready', versions: {} });
    a.push({ type: 'progress', phase: 'pyodide', done: 1, total: 2 });
    a.push({ type: 'fileWritten', name: 'x.csv' });
    expect(a.snapshot().events).toEqual([]);
  });
});

describe('validateLog', () => {
  test('rejects malformed logs with a path', () => {
    expect(() => validateLog(null)).toThrow(/\$/);
    expect(() => validateLog({ version: 1 })).toThrow(/version/);
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    a.push(batch(1, { events: [ev(0, 0)] })); // token v0.0 missing from values
    expect(() => validateLog(a.finish('ok'))).toThrow(/outputs\[0\].*no entry in values/);
  });

  test('rejects unsorted events', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    a.push(batch(1, { events: [ev(1, 1), ev(0, 0)], values: vals(0, 1) }));
    const log = a.finish('ok');
    log.events.reverse();
    expect(() => validateLog(log)).toThrow(/sorted/);
  });
});

describe('assembler review fixes', () => {
  test('snapshot after done returns the done status and error', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    const error = { type: 'ValueError', message: 'x', line: 1, traceback: [] };
    a.push({ type: 'done', runId: 1, status: 'error', error });
    const snap = a.snapshot();
    expect(snap.status).toBe('error');
    expect(snap.error).toEqual(error);
  });

  test('slot bindings replace earlier ones with the same slot_key (30 iterations)', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    const bindings: Batch['bindings'] = [];
    for (let k = 0; k < 30; k++) {
      bindings.push(k < 20 ? [0, k, 'x', `s${k}`] : [0, k, 'x', `s${k}`, 'b1.x']);
    }
    bindings.push([0, 5, 'y', 'sy', 'b2.y']); // other key survives
    a.push(batch(1, { bindings: bindings.slice(0, 25) }));
    a.push(batch(1, { bindings: bindings.slice(25) }));
    const b = a.finish('ok').scopes[0]!.bindings;
    expect(b.filter(([, n]) => n === 'x')).toHaveLength(21); // 20 full + the latest slot
    expect(b.find(([e, n]) => e === 29 && n === 'x')).toEqual([29, 'x', 's29']);
    expect(b.find(([, n]) => n === 'y')).toBeDefined();
    expect(b.every((t) => t.length === 3)).toBe(true);
    expect(b.map((t) => t[0])).toEqual([...b.map((t) => t[0])].sort((x, y) => x - y));
  });

  test('an older slot binding arriving late does not replace a newer one', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    a.push(batch(1, { bindings: [[0, 9, 'x', 's9', 'k']] }));
    a.push(batch(1, { bindings: [[0, 3, 'x', 's3', 'k']] }));
    expect(a.finish('ok').scopes[0]!.bindings).toEqual([[9, 'x', 's9']]);
  });

  test('open replaces the stub map instead of accumulating', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    const s0 = { i: 0, site: 0, kind: 'function' as const, name: 'f0', module: null };
    const s1 = { i: 1, site: 1, kind: 'function' as const, name: 'f1', module: null };
    a.push(batch(1, { open: [s0, s1] }));
    a.push(batch(1, { open: [s0] })); // s1 is no longer on the stack
    expect(a.finish('stopped').events.map((e) => e.i)).toEqual([0]);
  });

  test('interrupted count is the max count for the merge key plus one', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    a.push(
      batch(1, {
        events: [ev(0, 0, { count: 1 }), ev(5, 0, { slot: true, count: 25 })],
        values: vals(0, 5),
        open: [{ i: 6, site: 0, kind: 'function', name: 'f0', module: null }],
      }),
    );
    const log = a.finish('timeout');
    expect(log.events.find((e) => e.i === 6)!.count).toBe(26);
  });

  test('started with runId <= current is ignored', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 3, sites });
    a.push(batch(3, { events: [ev(0, 0)], values: vals(0) }));
    a.push({ type: 'started', runId: 3, sites: [] });
    a.push({ type: 'started', runId: 2, sites: [] });
    expect(a.finish('ok').events).toHaveLength(1);
  });

  test('createAssembler(runId) accepts only that run, including started', () => {
    const a = createAssembler(4);
    a.push({ type: 'started', runId: 3, sites });
    a.push(batch(3, { events: [ev(0, 0)], values: vals(0) }));
    expect(a.finish('ok').sites).toEqual([]);
    a.push({ type: 'started', runId: 4, sites });
    a.push(batch(4, { events: [ev(1, 1)], values: vals(1) }));
    expect(a.finish('ok').events.map((e) => e.i)).toEqual([1]);
  });

  test('an incoming slot with a lower i does not replace a newer slot', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    a.push(batch(1, { events: [ev(7, 0, { slot: true, count: 8 })], values: vals(7) }));
    a.push(batch(1, { events: [ev(3, 0, { slot: true, count: 4 })], values: vals(3) }));
    expect(a.finish('ok').events.map((e) => e.i)).toEqual([7]);
  });
});

describe('re-sent and coarse-flush events', () => {
  const failed = (i: number, extra: Partial<Event> = {}): Event =>
    ev(i, 0, {
      outputs: [],
      error: { type: 'ValueError', message: 'boom', handled: false },
      ...extra,
    });
  const handled = (e: Event): Event => ({ ...e, error: { ...e.error!, handled: true } });

  test('an event re-sent with the same i replaces the first (handled flips)', () => {
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    a.push(batch(1, { events: [failed(0), ev(1, 1)] }));
    a.push(batch(1, { events: [handled(failed(0))] }));
    const events = a.finish('ok').events;
    expect(events.map((e) => e.i)).toEqual([0, 1]);
    expect(events[0]!.error!.handled).toBe(true);
  });

  test('a re-sent slot event replaces the current slot, and is dropped once a newer one exists', () => {
    const slot = (i: number, count: number): Event =>
      failed(i, { slot: true, count, merge_key: 's0' });
    const a = createAssembler();
    a.push({ type: 'started', runId: 1, sites });
    a.push(batch(1, { events: [slot(5, 30)] }));
    a.push(batch(1, { events: [handled(slot(5, 30))] }));
    expect(a.snapshot().events).toHaveLength(1);
    expect(a.snapshot().events[0]!.error!.handled).toBe(true);
    a.push(batch(1, { events: [slot(9, 31)] })); // newer slot replaces it
    a.push(batch(1, { events: [handled(slot(5, 30))] })); // stale re-send: ignored
    const events = a.finish('ok').events;
    expect(events.map((e) => [e.i, e.error!.handled])).toEqual([[9, false]]);
  });

  test('one batch holding two slot events with the same merge key keeps the later', () => {
    for (const order of [
      [5, 9],
      [9, 5],
    ]) {
      const a = createAssembler();
      a.push({ type: 'started', runId: 1, sites });
      const slots = order.map((i) => ev(i, 0, { slot: true, count: i, merge_key: 's0' }));
      a.push(batch(1, { events: slots, values: vals(5, 9) }));
      expect(a.finish('ok').events.map((e) => e.i)).toEqual([9]);
    }
  });
});
