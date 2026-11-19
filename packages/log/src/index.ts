export const LOG_PACKAGE = '@machines/log';

export type * from './types';
export type * from './messages';
export { createAssembler } from './assemble';
export type { Assembler } from './assemble';
export { validateLog } from './validate';
export { buildGraph, MAX_NODES } from './graph';
export type {
  GraphModel,
  GNode,
  NodeBase,
  CallNode,
  InstanceNode,
  InstanceVersion,
  VersionKind,
  ExprNode,
  StoreNode,
  SourceNode,
  Port,
  Execution,
  GEdge,
} from './graph';
export { stateAt, eventLabel, stepOfEvent, attrsAround } from './timeline';
export type { StepState } from './timeline';
export { stageAt, shelfOrder, shelfAt } from './stage';
export type {
  StageModel,
  StageParticipant,
  StageRole,
  StageValue,
  ShelfEntry,
  ShelfSlot,
} from './stage';
export { attrRows, reprTruncated, sameValue } from './attrs';
export type { AttrRow } from './attrs';
export { describeStep, summaryText } from './describe';
export type { SummaryPart } from './describe';
