// Dev page: hand-written logs -> buildGraph -> layout -> mount, with a step slider.
import '../theme.css';
import { buildGraph, eventLabel, stateAt } from '@machines/log';
import type { EventLog, GraphModel } from '@machines/log';
import {
  attrRowsFor,
  edgeLabelsFor,
  moreMethodsFor,
  createLegend,
  layout,
  mount,
} from '../src/index';
import type { DiagramController } from '../src/index';
import { SCENARIOS } from './models';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const scenario = $<HTMLSelectElement>('scenario');
const slider = $<HTMLInputElement>('slider');
const label = $<HTMLOutputElement>('label');
const logEl = $('log');
const theme = $<HTMLSelectElement>('theme');
const params = new URLSearchParams(location.search);

scenario.innerHTML = SCENARIOS.map((s, k) => `<option value="${k}">${s.name}</option>`).join('');
$('legend').append(createLegend(document, params.has('legend')));

let ctl: DiagramController | null = null;
let model: GraphModel;
let log: EventLog;

const note = (msg: string): void => {
  logEl.textContent = msg;
};
const controller = (): DiagramController =>
  (ctl ??= mount($('stage'), {
    onSelectNode: (id) => note(`select ${id}`),
    onHoverEdge: (id, at) =>
      note(id ? `hover ${id} at ${Math.round(at.x)},${Math.round(at.y)}` : 'hover off'),
    onClickEdge: (id) => note(`click wire ${id}`),
    onOpenDocs: (t, id) => note(`docs ${t.module ?? ''} ${t.name} (from ${id})`),
  }));

function show(step: number): void {
  const st = stateAt(model, log, step);
  controller().setState(st, log);
  label.textContent = `${Math.min(step, model.steps.length)} of ${model.steps.length}`;
  if (st.current !== null) note(eventLabel(log, st.current));
}

// `?fixture=golden_linreg` loads fixtures/logs/<name>.json instead of a hand-written scenario.
const fixtures = import.meta.glob('../../../fixtures/logs/*.json', { eager: true }) as Record<
  string,
  { default: EventLog }
>;
async function load(): Promise<void> {
  const sc = SCENARIOS[Number(scenario.value)]!;
  const fx = params.get('fixture');
  const fixture = fx ? fixtures[`../../../fixtures/logs/${fx}.json`]?.default : undefined;
  log = fixture ?? sc.log();
  model = buildGraph(log, { expanded: new Set() });
  const laid = await layout(model, {
    attrRows: attrRowsFor(model, log),
    moreMethods: moreMethodsFor(model, log),
    edgeLabels: edgeLabelsFor(model, log),
  });
  controller().setGraph(model, laid);
  slider.max = String(model.steps.length);
  const at = params.get('step');
  slider.value = at === null ? String(model.steps.length) : at;
  show(Number(slider.value));
  document.body.dataset.ready = '1';
}

scenario.addEventListener('change', () => void load());
slider.addEventListener('input', () => show(Number(slider.value)));
theme.addEventListener('change', () => {
  if (theme.value) document.documentElement.dataset.theme = theme.value;
  else delete document.documentElement.dataset.theme;
});
if (params.get('scenario')) scenario.value = params.get('scenario')!;
if (params.get('theme')) {
  theme.value = params.get('theme')!;
  theme.dispatchEvent(new Event('change'));
}
void load();
