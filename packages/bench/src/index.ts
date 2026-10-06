/** #699 — offline benchmark harness. See README.md for the manifest format. */
export { runBench, parseChangedFiles, type RunBenchOptions } from './runner.js';
export {
  gradeCase,
  gradeSkippedCase,
  computeMetrics,
  causeMatches,
  locationMatches,
} from './grader.js';
export {
  buildGrounding,
  disabledGrounding,
  type GroundingHandle,
  type MinimalOctokit,
} from './grounding.js';
export {
  RecordingProvider,
  StubProvider,
  SpendCapExceededError,
  UnpricedModelError,
  ModelEchoMismatchError,
  projectCaseCostUsd,
} from './provider.js';
export { createCaseStub, type StubOptions } from './stub.js';
export type * from './types.js';
