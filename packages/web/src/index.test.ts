import { expect, test } from 'vitest';
import { WEB_PACKAGES } from './index';

test('web imports from log and render', () => {
  expect(WEB_PACKAGES).toEqual(['@machines/log', '@machines/render']);
});
