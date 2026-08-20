import { handleApi } from '../http.js';
import type { ApiRequest, ApiResponse } from '../http.js';
import { runPreflightService } from '../service.js';

/**
 * POST /api/preflight — validate a mint and report gas. Sends nothing.
 *
 * Body accepts the same overrides as /api/mint, so the UI can check a
 * configuration before committing to it.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  await handleApi(req, res, { methods: ['POST'], limit: 'read' }, async (body) =>
    runPreflightService(body),
  );
}
