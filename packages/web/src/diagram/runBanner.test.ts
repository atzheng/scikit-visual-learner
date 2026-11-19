import { describe, expect, test } from 'vitest';
import { runBanner, tooManyMessage } from './runBanner';

describe('runBanner', () => {
  test('no banner for ok and error', () => {
    expect(runBanner('ok', false)).toBeNull();
    expect(runBanner('error', false)).toBeNull();
  });
  test('limit, timeout and stopped say what happened and what is shown', () => {
    expect(runBanner('limit', false)).toMatch(/event limit/);
    expect(runBanner('timeout', true)).toMatch(/time limit.*call that was running/);
    expect(runBanner('stopped', false)).toMatch(/You stopped/);
  });
  test('too many boxes', () => {
    expect(tooManyMessage({ shown: 600, total: 812, line: 65 })).toMatch(
      /first 600 boxes \(up to line 65\).*812/,
    );
  });
});
