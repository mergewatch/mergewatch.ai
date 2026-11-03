/**
 * #779 — Amplify's SSR compute logs carry no runtime metadata (only START /
 * REPORT lines), so the Node version serving the dashboard is otherwise
 * unobservable. Log it once per server instance from `instrumentation.ts`.
 * Node runtime only: the edge runtime (middleware) has no `process.version`.
 */
export function logRuntimeVersion(log: (line: string) => void = console.log): void {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  log(`[mergewatch] dashboard server runtime: node ${process.version}`);
}
