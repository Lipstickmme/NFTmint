import { type ApiRequest, type ApiResponse } from '../src/http.js';
/**
 * GET /api/collections — live leaderboard from a persistent tracker.
 *
 * Optional. Only useful when TRACKER_UPSTREAM_URL points at a machine running
 * `nftmint serve`, which can hold the sequencer feed open continuously. For a
 * Vercel-only deployment use /api/scan instead, which samples a window inside
 * a single invocation.
 */
export default function handler(req: ApiRequest, res: ApiResponse): Promise<void>;
