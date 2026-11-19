// describeStep (svl-dnj): a snapshot of every step of every golden fixture (fixtures/summaries/*.txt,
// reviewed by hand), hand-built cases for each event kind, and the "never claim more than the log says" rules.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeStep, summaryText } from './describe';
import type { SummaryPart } from './describe';
import { buildGraph } from './graph';
import type { Event, EventLog, Site, ValueSummary } from './types';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures');
const names = readdirSync(join(ROOT, 'logs'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .sort();
const readLog = (n: string): EventLog =>
  JSON.parse(readFileSync(join(ROOT, 'logs', `${n}.json`), 'utf8')) as EventLog;

function sentences(log: EventLog): string[] {
  const model = buildGraph(log);
  const out: string[] = [];
  for (let s = 0; s <= model.steps.length; s++) {
    const ev = s > 0 ? model.steps[s - 1] : -1;
    out.push(`${s} (event ${ev}): ${summaryText(describeStep(model, log, s))}`);
  }
  return out;
}

describe('describeStep on the golden fixtures', () => {
  for (const n of names) {
    it(`${n}: every step`, async () => {
      const text = sentences(readLog(n)).join('\n') + '\n';
      await expect(text).toMatchFileSnapshot(join(ROOT, 'summaries', `${n}.txt`));
    });
  }
});

// ---- hand-built logs, one per event kind and per "do not claim" rule

class B {
  sites: Site[] = [];
  events: Event[] = [];
  values: Record<string, ValueSummary> = {};
  bindings: [number, string, string][] = [];
  site(text: string, extra: Partial<Site> = {}): number {
    const id = this.sites.length;
    this.sites.push({
      id,
      kind: 'call',
      line: id + 1,
      col: 0,
      end_line: id + 1,
      end_col: text.length,
      text,
      func_text: text.split('(')[0],
      ...extra,
    });
    return id;
  }
  val(token: string, type: string, extra: Partial<ValueSummary> = {}): string {
    this.values[token] = { type, ...extra };
    return token;
  }
  ev(site: number, kind: Event['kind'], name: string, extra: Partial<Event> = {}): Event {
    const i = this.events.length;
    const e: Event = {
      i,
      ret: i,
      site,
      scope: 0,
      kind,
      name,
      module: kind === 'expr' || kind === 'store' ? null : 'lib',
      owner: null,
      inputs: [],
      outputs: [],
      returns_self: false,
      mutates: [],
      count: 1,
      merge_key: `s${site}`,
      error: null,
      ...extra,
    };
    this.events.push(e);
    return e;
  }
  bind(name: string, token: string): void {
    this.bindings.push([this.events.length - 1, name, token]);
  }
  log(): EventLog {
    return {
      version: 2,
      status: 'ok',
      error: null,
      sites: this.sites,
      scopes: [
        {
          id: 0,
          name: '<module>',
          parent_event: null,
          lexical_parent: null,
          bindings: this.bindings,
        },
      ],
      values: this.values,
      events: this.events,
      output: [],
      diagnostics: [],
    };
  }
}

const say = (log: EventLog, step: number, short = false): string => {
  const model = buildGraph(log);
  return summaryText(describeStep(model, log, step, { short }));
};

describe('describeStep, hand-built', () => {
  it('step 0, and an empty run', () => {
    const b = new B();
    b.ev(b.site('f()'), 'function', 'f');
    expect(say(b.log(), 0)).toBe('Before the program runs.');
    expect(say(new B().log(), 0)).toBe('');
  });

  it('import: one name, an alias, several names, a plain module', () => {
    const b = new B();
    const imp = (text: string, imports: NonNullable<Site['imports']>): void => {
      b.ev(b.site(text, { kind: 'import', imports }), 'import', text);
    };
    imp('from m import A', [{ name: 'A', module: 'm', attr: 'A', sole: true }]);
    imp('from m import A, B as C', [
      { name: 'A', module: 'm', attr: 'A', sole: true },
      { name: 'C', module: 'm', attr: 'B', sole: true },
    ]);
    imp('import numpy as np', [{ name: 'np', module: 'numpy', attr: null, sole: true }]);
    imp('import a.b.c', [{ name: 'a', module: 'a', attr: null, dotted: 'a.b.c', sole: true }]);
    imp('import x, y', [
      { name: 'x', module: 'x', attr: null, sole: true },
      { name: 'y', module: 'y', attr: null, sole: true },
    ]);
    const log = b.log();
    expect(say(log, 1)).toBe('Imported A from m.');
    expect(say(log, 2)).toBe('Imported A and B as C from m.');
    expect(say(log, 3)).toBe('Imported numpy as np.');
    expect(say(log, 4)).toBe('Imported a.b.c.');
    expect(say(log, 5)).toBe('Imported x and y.');
  });

  it('function call: created and named, multiple returns, a scalar, nothing', () => {
    const b = new B();
    b.ev(b.site('load("a.csv")'), 'function', 'load', {
      outputs: [b.val('v0.0', 'DF', { shape: [3, 2] })],
    });
    b.bind('df', 'v0.0');
    b.ev(b.site('split(df)'), 'function', 'split', {
      outputs: [
        b.val('v1.0', 'DF', { shape: [2, 2] }),
        b.val('v2.0', 'Series', { shape: [2], dtype: 'int64' }),
      ],
    });
    b.bind('a', 'v1.0');
    b.ev(b.site('total(df)'), 'function', 'total', {
      outputs: [b.val('s0', 'int', { repr: '7' })],
    });
    b.ev(b.site('noop()'), 'function', 'noop');
    const log = b.log();
    expect(say(log, 1)).toBe(
      'Called load("a.csv"). It created a new DataFrame object (3 × 2), df.',
    );
    expect(say(log, 2)).toBe(
      'Called split(df). It returned 2 objects: a (DataFrame, 2 × 2), a Series of int64 (2).',
    );
    expect(say(log, 3)).toBe('Called total(df). It returned an int (7).');
    expect(say(log, 4)).toBe('Called noop().');
  });

  it('does not say "created" for an object that already existed, nor name a later binding', () => {
    const b = new B();
    b.ev(b.site('load()'), 'function', 'load', {
      outputs: [b.val('v0.0', 'DF', { shape: [1, 1] })],
    });
    b.bind('df', 'v0.0');
    b.ev(b.site('same(df)'), 'function', 'same', {
      inputs: [{ param: 'x', origin: 'name', value: 'v0.0' }],
      outputs: ['v0.0'],
    });
    b.ev(b.site('make()'), 'function', 'make', {
      outputs: [b.val('v1.0', 'DF', { shape: [1, 1] })],
    });
    b.ev(b.site('other()'), 'function', 'other');
    b.bind('late', 'v1.0');
    const log = b.log();
    expect(say(log, 2)).toBe('Called same(df). It returned a DataFrame (1 × 1).');
    expect(say(log, 3)).toBe('Called make(). It created a new DataFrame object (1 × 1).');
  });

  it('a volatile name is never given', () => {
    const b = new B();
    b.site('globals()', { kind: 'bind', targets: ['df'], volatile: true });
    b.ev(b.site('load()'), 'function', 'load', {
      outputs: [b.val('v0.0', 'DF', { shape: [1, 1] })],
    });
    b.bind('df', 'v0.0');
    expect(say(b.log(), 1)).toBe('Called load(). It created a new DataFrame object (1 × 1).');
  });

  it('method on an instance: changed attributes, returns self', () => {
    const b = new B();
    b.val('s0', 'float', { repr: '1.0' });
    b.val('s1', 'ndarray', { repr: 'array(...)' });
    b.val('s2', 'ndarray', { repr: 'array(...)' });
    b.val('s3', 'float', { repr: '0.5' });
    b.ev(b.site('Model()'), 'constructor', 'Model', {
      outputs: [b.val('v0.0', 'Model', { machine: true, attrs: { alpha: 's0' } })],
    });
    b.bind('model', 'v0.0');
    b.val('v0.1', 'Model', {
      machine: true,
      attrs: { alpha: 's0', coef_: 's1', intercept_: 's3', a_: 's2', b_: 's2', c_: 's2', d_: 's2' },
    });
    b.ev(b.site('model.fit(X, y)', { func_text: 'model.fit' }), 'method', 'Model.fit', {
      owner: 'v0.0',
      returns_self: true,
      mutates: [['v0.0', 'v0.1']],
    });
    const log = b.log();
    expect(say(log, 2)).toBe(
      'Called model.fit(X, y). It changed 6 attributes of model: coef_, intercept_, a_, b_ (and 2 more). It returned model itself.',
    );
    expect(say(log, 2, true)).toBe(
      'It changed 6 attributes of model: coef_, intercept_, a_, b_ (and 2 more). It returned model itself.',
    );
  });

  it('an attribute with the same whole repr is not changed; a truncated repr is', () => {
    const b = new B();
    b.val('s0', 'float', { repr: '1.0' });
    b.val('s1', 'float', { repr: '1.0' });
    b.val('s2', 'str', { repr: "'abcdefghijklmnopqrstuvwxyz…" });
    b.val('s3', 'str', { repr: "'abcdefghijklmnopqrstuvwxyz…" });
    b.val('v0.0', 'Model', { machine: true, attrs: { a: 's0', b: 's2' } });
    b.val('v0.1', 'Model', { machine: true, attrs: { a: 's1', b: 's3' } });
    b.ev(b.site('Model()'), 'constructor', 'Model', { outputs: ['v0.0'] });
    b.ev(b.site('m.go()', { func_text: 'm.go' }), 'method', 'Model.go', {
      owner: 'v0.0',
      mutates: [['v0.0', 'v0.1']],
    });
    expect(say(b.log(), 2)).toBe('Called m.go(). It changed 1 attribute of m: b.');
  });

  it('a method on an unnamed owner does not name it', () => {
    const b = new B();
    b.val('s0', 'int', { repr: '1' });
    b.val('s1', 'int', { repr: '2' });
    b.val('v0.0', 'Model', { machine: true, attrs: { a: 's0' } });
    b.val('v0.1', 'Model', { machine: true, attrs: { a: 's1' } });
    b.ev(b.site('Model()'), 'constructor', 'Model', { outputs: ['v0.0'] });
    b.ev(b.site('Model().go()', { func_text: 'Model().go' }), 'method', 'Model.go', {
      owner: 'v0.0',
      returns_self: true,
      mutates: [['v0.0', 'v0.1']],
    });
    expect(say(b.log(), 2)).toBe(
      'Called Model().go(). It changed 1 attribute of the object: a. It returned the object itself.',
    );
  });

  it('store: a column, a dict key, an attribute, and anything else in place', () => {
    const b = new B();
    b.ev(b.site('load()'), 'function', 'load', {
      outputs: [b.val('v0.0', 'DF', { shape: [1, 1] })],
    });
    b.bind('df', 'v0.0');
    const store = (text: string, token: string): void => {
      b.ev(b.site(text, { kind: 'store', root: text.split(/[[.]/)[0]! }), 'store', text, {
        outputs: [token],
      });
    };
    store('df["a"] = 0', b.val('v0.1', 'DF', { shape: [1, 1] }));
    store('df.loc[m, "a"] = 0', b.val('v0.2', 'DF', { shape: [1, 1] }));
    store('d["k"] = 1', b.val('v1.1', 'dict[1]'));
    store('o.x = 1', b.val('v2.1', 'Thing'));
    const log = b.log();
    expect(say(log, 2)).toBe('Set column a of df.');
    expect(say(log, 3)).toBe('Changed df in place.');
    expect(say(log, 4)).toBe('Set key k of d.');
    expect(say(log, 5)).toBe('Set attribute x of o.');
  });

  it('in-place method on data', () => {
    const b = new B();
    b.ev(b.site('load()'), 'function', 'load', {
      outputs: [b.val('v0.0', 'DF', { shape: [1, 1] })],
    });
    b.val('v0.1', 'DF', { shape: [1, 1] });
    b.ev(
      b.site('df.dropna(inplace=True)', { func_text: 'df.dropna' }),
      'method',
      'DataFrame.dropna',
      {
        owner: 'v0.0',
        mutates: [['v0.0', 'v0.1']],
      },
    );
    expect(say(b.log(), 2)).toBe('Called df.dropna(inplace=True). It changed df in place.');
  });

  it('expr: type, shape and name', () => {
    const b = new B();
    b.ev(b.site('mask = df["p"] > 1', { kind: 'bind' }), 'expr', 'df["p"] > 1', {
      outputs: [b.val('v0.0', 'Series', { shape: [95], dtype: 'bool' })],
    });
    b.bind('mask', 'v0.0');
    expect(say(b.log(), 1)).toBe('Computed df["p"] > 1, a Series of bool (95), named mask.');
  });

  it('errors: raised, handled, and a stopped run', () => {
    const b = new B();
    b.ev(b.site('f()'), 'function', 'f', {
      error: { type: 'ValueError', message: 'bad\nthing', handled: false },
    });
    b.ev(b.site('g()'), 'function', 'g', {
      error: { type: 'KeyError', message: "'k'", handled: true },
    });
    b.ev(b.site('h()'), 'function', 'h', { interrupted: true });
    const log = b.log();
    expect(say(log, 1)).toBe('Called f(). It raised ValueError: bad thing.');
    expect(say(log, 2)).toBe("Called g(). It raised KeyError: 'k' (handled).");
    expect(say(log, 3)).toBe('Called h(). The run was stopped during this step.');
  });

  it('loops: names the pass when a box runs more than once', () => {
    const b = new B();
    const s = b.site('f(i)');
    for (let k = 0; k < 3; k++) {
      b.ev(s, 'function', 'f', {
        count: k + 1,
        outputs: [b.val(`s${k}`, 'int', { repr: String(k) })],
      });
    }
    expect(say(b.log(), 2)).toBe('Called f(i). It returned an int (1) (pass 2 of 3).');
  });

  it('parts: names and source are code runs, the rest text', () => {
    const log = readLog('golden_linreg');
    const model = buildGraph(log);
    const parts: SummaryPart[] = describeStep(model, log, 10);
    expect(parts.filter((p) => p.kind === 'code').map((p) => p.text)).toEqual(
      expect.arrayContaining(['model.fit(X_train, y_train)', 'coef_', 'model']),
    );
    expect(summaryText(parts)).toContain('coef_');
  });

  it('is deterministic and out-of-range steps say nothing', () => {
    const log = readLog('golden_linreg');
    const model = buildGraph(log);
    expect(describeStep(model, log, 10)).toEqual(describeStep(model, log, 10));
    expect(describeStep(model, log, 999)).toEqual([]);
    expect(describeStep(model, log, -1)).toEqual([]);
  });
});
