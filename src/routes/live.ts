import { handleApi } from '../http.js';
import type { ApiRequest, ApiResponse } from '../http.js';
import { runLiveBoard, DEFAULT_LIVE_OPTIONS } from '../live.js';
import { authenticateAccount } from '../accountstore.js';
import { rememberLiveMints } from '../liveCache.js';

/**
 * GET /api/live — everything minting right now.
 *
 * Reads only. No wallet is touched and nothing is signed, so this works before
 * anyone has funded anything — which is the point: the board is what you look
 * at while deciding whether to.
 *
 * Query parameters:
 *   seconds  — how long to watch the feed, 5..45 (default 20)
 *   minMints — mints a collection needs since it started, 1..1000 (default 12)
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const accountId = header(req, 'x-account-id');
  const accountToken = header(req, 'x-account-token');
  const asAccount = Boolean(accountId && accountToken);

  await handleApi(
    req,
    res,
    { methods: ['GET'], publicRoute: asAccount, limit: 'hunt' },
    async (_body, query) => {
      // An account's own endpoint is used for the contract reads too, so the
      // board reflects the route its mints would actually take.
      let rpcUrls: string[] | undefined;
      let namespace: string | undefined;
      if (asAccount) {
        const account = await authenticateAccount(accountId, accountToken);
        namespace = account.id;
        if (account.rpcUrl) rpcUrls = [account.rpcUrl];
      }

      const board = await runLiveBoard(
        {
          windowSec: clamp(query.get('seconds'), 5, 45, DEFAULT_LIVE_OPTIONS.windowSec),
          minMints: clamp(query.get('minMints'), 1, 1000, DEFAULT_LIVE_OPTIONS.minMints),
        },
        process.env,
        rpcUrls,
      );

      // Kept so the Mint button on a row does not have to re-sample the feed to
      // rediscover calldata this request already has.
      await rememberLiveMints(board.mints, process.env, namespace);

      return board;
    },
  );
}

function header(req: ApiRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function clamp(raw: string | null, min: number, max: number, fallback: number): number {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
