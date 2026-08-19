/**
 * Build identity, surfaced in the UI and in /api/health.
 *
 * Exists because "the page looks like an older version" is otherwise very hard
 * to diagnose: a cached front end talking to a fresh API looks like broken
 * behaviour rather than a stale asset. With this, a single glance at the footer
 * or one curl of /api/health settles which build is actually live.
 *
 * UI_VERSION is bumped by hand whenever the interface changes shape enough that
 * someone might otherwise mistake an old copy for a bug.
 */
export const UI_VERSION = '6-minimal';

/**
 * Vercel exposes the deploying commit as VERCEL_GIT_COMMIT_SHA. Absent when
 * running locally, which is itself useful information.
 */
export function buildInfo(env: NodeJS.ProcessEnv = process.env): {
  uiVersion: string;
  commit: string;
  deployedAt: string;
} {
  return {
    uiVersion: UI_VERSION,
    commit: env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local',
    deployedAt: env.VERCEL_DEPLOYMENT_ID ? 'vercel' : 'local',
  };
}
