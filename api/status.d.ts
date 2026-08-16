import { type ApiRequest, type ApiResponse } from '../src/http.js';
/**
 * GET /api/status — chain reachability, endpoint latency, wallet balances.
 *
 * Authenticated: it derives wallet addresses from the configured keys, and
 * those should not be public.
 */
export default function handler(req: ApiRequest, res: ApiResponse): Promise<void>;
