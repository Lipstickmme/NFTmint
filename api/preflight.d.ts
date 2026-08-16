import { type ApiRequest, type ApiResponse } from '../src/http.js';
/**
 * POST /api/preflight — validate a mint and report gas. Sends nothing.
 *
 * Body accepts the same overrides as /api/mint, so the UI can check a
 * configuration before committing to it.
 */
export default function handler(req: ApiRequest, res: ApiResponse): Promise<void>;
