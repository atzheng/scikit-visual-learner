// Hand-written event logs for the dev page and tests (no recorder exists yet). Each mimics what the recorder
// would produce for the golden programs of the same name; not byte-identical to future fixtures.
import type { Event, EventLog, Input, Site, ValueSummary } from '@machines/log';

class Builder {
  sites: Site[] = [];
  events: Event[] = [];
  values: Record<string, ValueSummary> = {};
  bindings: [number, string, string][] = [];
  n = 0;
  site(text: string, line: number, extra: Partial<Site> = {}): number {
    const id = this.sites.length;
    this.sites.push({
      id,
      kind: 'call',
      line,
      col: 0,
      end_line: line,
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
    const i = this.n++;
    const e: Event = {
      i,
      ret: i,
      site,
      scope: 0,
      kind,
      name,
      module: kind === 'expr' || kind === 'store' ? null : 'sklearn',
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
    this.bindings.push([this.n - 1, name, token]);
  }
  log(extra: Partial<EventLog> = {}): EventLog {
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
      ...extra,
    };
  }
}

const wired = (param: string, value: string): Input => ({ param, origin: 'name', value });
const konst = (param: string, text: string): Input => ({ param, origin: 'const', text });

const df = (rows: number, cols: number): Partial<ValueSummary> => ({
  shape: [rows, cols],
  columns: Array.from({ length: cols }, (_, k) => `c${k}`),
});

/** golden_split shape: load, drop the target, split into four. */
export function splitLog(): EventLog {
  const x = new Builder();
  const s0 = x.site('df = pd.read_csv("housing.csv")', 1);
  const s1 = x.site('X = df.drop(columns="price")', 2);
  const s2 = x.site('y = df["price"]', 3, { kind: 'store' });
  const s3 = x.site(
    'X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=0)',
    4,
  );
  x.val('v1.0', 'DataFrame', df(506, 6));
  x.ev(s0, 'function', 'read_csv', {
    module: 'pandas',
    inputs: [konst('filepath', '"housing.csv"')],
    outputs: ['v1.0'],
  });
  x.bind('df', 'v1.0');
  x.val('v2.0', 'DataFrame', df(506, 5));
  x.ev(s1, 'method', 'DataFrame.drop', {
    module: 'pandas',
    owner: 'v1.0',
    inputs: [konst('columns', '"price"')],
    outputs: ['v2.0'],
  });
  x.bind('X', 'v2.0');
  x.val('v3.0', 'Series', { shape: [506] });
  x.ev(s2, 'expr', 'getitem', {
    module: null,
    owner: 'v1.0',
    inputs: [konst('key', '"price"')],
    outputs: ['v3.0'],
  });
  x.bind('y', 'v3.0');
  for (const [k, name, shape, type] of [
    [4, 'X_train', [404, 5], 'DataFrame'],
    [5, 'X_test', [102, 5], 'DataFrame'],
    [6, 'y_train', [404], 'Series'],
    [7, 'y_test', [102], 'Series'],
  ] as const) {
    x.val(`v${k}.0`, type, type === 'Series' ? { shape: [...shape] } : df(shape[0], shape[1]!));
    void name;
  }
  x.ev(s3, 'function', 'train_test_split', {
    inputs: [
      wired('arrays[0]', 'v2.0'),
      wired('arrays[1]', 'v3.0'),
      konst('test_size', '0.2'),
      konst('random_state', '0'),
    ],
    outputs: ['v4.0', 'v5.0', 'v6.0', 'v7.0'],
  });
  x.bind('X_train', 'v4.0');
  x.bind('X_test', 'v5.0');
  x.bind('y_train', 'v6.0');
  x.bind('y_test', 'v7.0');
  return x.log();
}

/** golden_linreg shape: split, fit a LinearRegression (attributes change), predict, score. */
export function linregLog(
  opts: { failAt?: 'fit' | 'predict'; interrupt?: boolean } = {},
): EventLog {
  const x = new Builder();
  const s0 = x.site('X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)', 1);
  const s1 = x.site('model = LinearRegression()', 2);
  const s2 = x.site('model.fit(X_train, y_train)', 3);
  const s3 = x.site('pred = model.predict(X_test)', 4);
  const s4 = x.site('r2 = r2_score(y_test, pred)', 5);
  x.val('v1.0', 'DataFrame', df(506, 5));
  x.val('v2.0', 'Series', { shape: [506] });
  // the split's inputs come from names bound before the program's first drawn event
  x.bind('X', 'v1.0');
  x.bind('y', 'v2.0');
  for (const [k, type, shape] of [
    [4, 'DataFrame', [404, 5]],
    [5, 'DataFrame', [102, 5]],
    [6, 'Series', [404]],
    [7, 'Series', [102]],
  ] as const) {
    x.val(`v${k}.0`, type, type === 'Series' ? { shape: [...shape] } : df(shape[0], shape[1]!));
  }
  x.ev(s0, 'function', 'train_test_split', {
    inputs: [wired('arrays[0]', 'v1.0'), wired('arrays[1]', 'v2.0'), konst('test_size', '0.2')],
    outputs: ['v4.0', 'v5.0', 'v6.0', 'v7.0'],
  });
  x.bind('X_train', 'v4.0');
  x.bind('X_test', 'v5.0');
  x.bind('y_train', 'v6.0');
  x.bind('y_test', 'v7.0');
  x.val('v8.0', 'LinearRegression', { machine: true, attrs: {} });
  x.ev(s1, 'constructor', 'LinearRegression', { outputs: ['v8.0'] });
  x.bind('model', 'v8.0');
  x.val('v9.0', 'ndarray', { shape: [5], dtype: 'float64' });
  x.val('s1', 'float', { repr: '22.5' });
  x.val('v8.1', 'LinearRegression', {
    machine: true,
    attrs: { coef_: 'v9.0', intercept_: 's1', n_features_in_: 's2' },
  });
  x.val('s2', 'int', { repr: '5' });
  const fit = x.ev(s2, 'method', 'LinearRegression.fit', {
    owner: 'v8.0',
    inputs: [wired('X', 'v4.0'), wired('y', 'v6.0')],
    returns_self: true,
    mutates: [['v8.0', 'v8.1']],
  });
  if (opts.failAt === 'fit') {
    fit.mutates = [];
    fit.returns_self = false;
    fit.error = { type: 'ValueError', message: 'Input X contains NaN.', handled: false };
    if (opts.interrupt) return x.log({ status: 'error' });
    return x.log({ status: 'error' });
  }
  x.val('v10.0', 'ndarray', { shape: [102], dtype: 'float64' });
  const pred = x.ev(s3, 'method', 'LinearRegression.predict', {
    owner: 'v8.1',
    inputs: [wired('X', 'v5.0')],
    outputs: ['v10.0'],
  });
  x.bind('pred', 'v10.0');
  if (opts.interrupt) {
    pred.interrupted = true;
    pred.outputs = [];
    return x.log({ status: 'stopped' });
  }
  x.val('s3', 'float', { repr: '0.7406' });
  x.ev(s4, 'function', 'r2_score', {
    inputs: [wired('y_true', 'v7.0'), wired('y_pred', 'v10.0')],
    outputs: ['s3'],
  });
  x.bind('r2', 's3');
  return x.log();
}

/** edge_loop shape: the same fit box runs three times (x3 badge). */
export function loopLog(): EventLog {
  const x = new Builder();
  const s0 = x.site('model = SGDRegressor()', 1);
  const s1 = x.site('model.partial_fit(X, y)', 3);
  x.val('v1.0', 'DataFrame', df(100, 3));
  x.val('v2.0', 'Series', { shape: [100] });
  x.bind('X', 'v1.0');
  x.bind('y', 'v2.0');
  x.val('v3.0', 'SGDRegressor', { machine: true, attrs: {} });
  x.ev(s0, 'constructor', 'SGDRegressor', { outputs: ['v3.0'] });
  x.bind('model', 'v3.0');
  for (let k = 1; k <= 3; k++) {
    x.val(`v3.${k}`, 'SGDRegressor', {
      machine: true,
      attrs: { n_iter_: `n${k}` },
    });
    x.val(`n${k}`, 'int', { repr: String(k) });
    x.ev(s1, 'method', 'SGDRegressor.partial_fit', {
      owner: `v3.${k - 1}`,
      inputs: [wired('X', 'v1.0'), wired('y', 'v2.0')],
      returns_self: true,
      mutates: [[`v3.${k - 1}`, `v3.${k}`]],
      count: k,
    });
  }
  return x.log();
}

/** `for k in range(3): model = SGDRegressor(); model.partial_fit(X, y)`: one box, three different objects (svl-tcy). */
export function objectLoopLog(): EventLog {
  const x = new Builder();
  const s0 = x.site('model = SGDRegressor()', 2);
  const s1 = x.site('model.partial_fit(X, y)', 3);
  x.val('v1.0', 'DataFrame', df(100, 3));
  x.val('v2.0', 'Series', { shape: [100] });
  x.bind('X', 'v1.0');
  x.bind('y', 'v2.0');
  for (let k = 1; k <= 3; k++) {
    const o = k + 2;
    x.val(`v${o}.0`, 'SGDRegressor', { machine: true, attrs: {} });
    x.ev(s0, 'constructor', 'SGDRegressor', { outputs: [`v${o}.0`], count: k });
    x.bind('model', `v${o}.0`);
    x.val(`v${o}.1`, 'SGDRegressor', { machine: true, attrs: { n_iter_: `n${k}` } });
    x.val(`n${k}`, 'int', { repr: String(k) });
    x.ev(s1, 'method', 'SGDRegressor.partial_fit', {
      owner: `v${o}.0`,
      inputs: [wired('X', 'v1.0'), wired('y', 'v2.0')],
      returns_self: true,
      mutates: [[`v${o}.0`, `v${o}.1`]],
      count: k,
    });
  }
  return x.log();
}

/** Two Ridge instances fitted one after the other: stepping onto b.fit must not mark a's attributes changed. */
export function twoModelsLog(): EventLog {
  const x = new Builder();
  const s0 = x.site('a = Ridge()', 1);
  const s1 = x.site('b = Ridge()', 2);
  const s2 = x.site('a.fit(X, y)', 3);
  const s3 = x.site('b.fit(X, y)', 4);
  x.val('v1.0', 'DataFrame', df(100, 3));
  x.val('v2.0', 'Series', { shape: [100] });
  x.bind('X', 'v1.0');
  x.bind('y', 'v2.0');
  x.val('v3.0', 'Ridge', { machine: true, attrs: {} });
  x.ev(s0, 'constructor', 'Ridge', { outputs: ['v3.0'] });
  x.bind('a', 'v3.0');
  x.val('v4.0', 'Ridge', { machine: true, attrs: {} });
  x.ev(s1, 'constructor', 'Ridge', { outputs: ['v4.0'] });
  x.bind('b', 'v4.0');
  x.val('ca', 'ndarray', { shape: [3] });
  x.val('cb', 'ndarray', { shape: [3] });
  x.val('v3.1', 'Ridge', { machine: true, attrs: { coef_: 'ca' } });
  x.val('v4.1', 'Ridge', { machine: true, attrs: { coef_: 'cb' } });
  const fitArgs = [wired('X', 'v1.0'), wired('y', 'v2.0')];
  x.ev(s2, 'method', 'Ridge.fit', {
    owner: 'v3.0',
    inputs: fitArgs,
    returns_self: true,
    mutates: [['v3.0', 'v3.1']],
  });
  x.ev(s3, 'method', 'Ridge.fit', {
    owner: 'v4.0',
    inputs: fitArgs,
    returns_self: true,
    mutates: [['v4.0', 'v4.1']],
  });
  return x.log();
}

export const SCENARIOS: { name: string; log: () => EventLog }[] = [
  { name: 'golden_split-shaped', log: splitLog },
  { name: 'golden_linreg-shaped', log: () => linregLog() },
  { name: 'linreg with error', log: () => linregLog({ failAt: 'fit' }) },
  { name: 'linreg interrupted', log: () => linregLog({ interrupt: true }) },
  { name: 'loop (x3 badge)', log: loopLog },
  { name: 'loop of new objects', log: objectLoopLog },
];
