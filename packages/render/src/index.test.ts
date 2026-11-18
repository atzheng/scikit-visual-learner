import { expect, test } from 'vitest';
import { RENDER_DEPENDS_ON, RENDER_PACKAGE } from './index';

test('render package depends on log', () => {
  expect(RENDER_PACKAGE).toBe('@machines/render');
  expect(RENDER_DEPENDS_ON).toBe('@machines/log');
});
