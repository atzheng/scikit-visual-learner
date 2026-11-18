import { expect, test } from 'vitest';
import { LOG_PACKAGE } from './index';

test('log package exports its name', () => {
  expect(LOG_PACKAGE).toBe('@machines/log');
});
