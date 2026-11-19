import type { MethodDocTarget } from '@machines/render';
import { createContext } from 'react';

/**
 * Opens the docs panel for a target from a box in the diagram (`nodeId`). The diagram pane provides it to the
 * panels drawn beside it, so the instance attributes panel can show a row's docs too (svl-3du).
 */
export type OpenDocs = (target: MethodDocTarget, nodeId: string) => void;
export const DocsOpenerContext = createContext<OpenDocs | null>(null);
