import { handleApi } from '../src/http.js';
import { scanFeedService } from '../src/service.js';
/**
 * GET /api/scan?seconds=20 — sample the sequencer feed and rank collections
 * by mint velocity.
 *
 * A serverless function cannot hold the feed open between requests, so this
 * takes a snapshot of the current window rather than watching continuously.
 * Longer windows see more, bounded by the function's max duration.
 */
export default async function handler(req, res) {
    await handleApi(req, res, { methods: ['GET'] }, async (_body, query) => {
        const seconds = Number(query.get('seconds') ?? 20);
        return scanFeedService(Number.isFinite(seconds) ? seconds : 20);
    });
}
//# sourceMappingURL=scan.js.map