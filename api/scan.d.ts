import { type ApiRequest, type ApiResponse } from '../src/http.js';
/**
 * GET /api/scan?seconds=20 — sample the sequencer feed and rank collections
 * by mint velocity.
 *
 * A serverless function cannot hold the feed open between requests, so this
 * takes a snapshot of the current window rather than watching continuously.
 * Longer windows see more, bounded by the function's max duration.
 */
export default function handler(req: ApiRequest, res: ApiResponse): Promise<void>;
