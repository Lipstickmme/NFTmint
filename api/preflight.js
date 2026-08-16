import { handleApi } from '../src/http.js';
import { runPreflightService } from '../src/service.js';
/**
 * POST /api/preflight — validate a mint and report gas. Sends nothing.
 *
 * Body accepts the same overrides as /api/mint, so the UI can check a
 * configuration before committing to it.
 */
export default async function handler(req, res) {
    await handleApi(req, res, { methods: ['POST'] }, async (body) => runPreflightService(body));
}
//# sourceMappingURL=preflight.js.map