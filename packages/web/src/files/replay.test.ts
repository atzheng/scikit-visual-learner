import type { FromWorker, ToWorker } from '@machines/log';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RUN_CONFIG } from '../course';
import { RuntimeClient, type WorkerLike } from '../runtime/client';
import { replayFiles, type DataFile } from './upload';

class FakeWorker implements WorkerLike {
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  sent: ToWorker[] = [];
  postMessage(msg: ToWorker): void {
    this.sent.push(msg);
  }
  terminate(): void {}
  emit(msg: FromWorker): void {
    this.onmessage?.({ data: msg });
  }
}

const file = (name: string): DataFile => ({
  name,
  bytes: new TextEncoder().encode('a\n1\n'),
  rows: 1,
  origin: 'upload',
});

describe('replay before Run', () => {
  it('posts every file before a Run that follows, without waiting for acks', async () => {
    const w = new FakeWorker();
    const client = new RuntimeClient({
      workerUrl: new URL('http://localhost/worker.js'),
      onProgress: () => {},
      onReady: () => {},
      createWorker: () => w,
      isolated: false,
    });
    w.emit({ type: 'ready', versions: {} });
    const replay = replayFiles([file('a.csv'), file('b.csv'), file('c.csv')], (n, b) =>
      client.writeFile(n, b),
    );
    void client.run('x = 1', DEFAULT_RUN_CONFIG, () => {});
    expect(w.sent.map((m) => (m.type === 'file' ? `file:${m.name}` : m.type))).toEqual([
      'init',
      'file:a.csv',
      'file:b.csv',
      'file:c.csv',
      'run',
    ]);
    for (const n of ['a.csv', 'b.csv', 'c.csv']) w.emit({ type: 'fileWritten', name: n });
    expect(await replay).toEqual([]);
  });
});
