import { handleApi, type ApiRequest, type ApiResponse } from '../src/http.js';
import { loadProxyConfig, proxyRequest } from '../src/proxy.js';
import { buildInfo } from '../src/version.js';
import { loadHuntConfig } from '../src/config.js';
import { criteriaForDisplay } from '../src/hunt.js';
import { accountsAreDurable } from '../src/accountstore.js';

/**
 * GET /api/health — deployment readiness.
 *
 * Public, so the UI can tell you what is wrong before you have a token. It
 * reports only whether things are *configured*, never their values, so an
 * unauthenticated caller learns nothing exploitable.
 *
 * When TRACKER_UPSTREAM_URL points at a persistent tracker, its health is
 * included too.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  await handleApi(req, res, { methods: ['GET'], publicRoute: true }, async () => {
    const env = process.env;
    const configured = {
      apiToken: Boolean(env.API_TOKEN?.trim()),
      privateKeys: Boolean(env.PRIVATE_KEYS?.trim()),
      rpcUrls: Boolean(env.RPC_URLS?.trim()),
      network: env.NETWORK?.trim() || 'testnet',
      spendCeilingEth: env.MAX_MINT_VALUE_ETH?.trim() || '0.05',
      upstreamTracker: Boolean(env.TRACKER_UPSTREAM_URL?.trim()),
      // Sign-up cannot work without a key to seal wallets under, and storage
      // that forgets them on restart would strand whatever they hold.
      accounts: Boolean(env.ACCOUNT_ENCRYPTION_KEY?.trim()),
      accountsDurable: accountsAreDurable(env),
      marketPrices: Boolean(env.MARKET_API_URL?.trim()),
    };

    const problems: string[] = [];
    if (!configured.apiToken) {
      problems.push('API_TOKEN is not set — the mint endpoints will refuse to run.');
    }
    if (!configured.privateKeys && !configured.accounts) {
      problems.push(
        'Neither PRIVATE_KEYS nor ACCOUNT_ENCRYPTION_KEY is set, so there are no ' +
          'wallets to mint from. Set ACCOUNT_ENCRYPTION_KEY to let people sign up.',
      );
    }
    if (configured.accounts && !configured.accountsDurable) {
      problems.push(
        'Accounts are stored in memory, so generated wallets are lost on restart. ' +
          'Attach a database before anyone funds one.',
      );
    }
    if (!configured.rpcUrls) {
      problems.push(
        'RPC_URLS is not set — falling back to the public endpoint, which is rate limited.',
      );
    }

    let upstream: unknown;
    if (configured.upstreamTracker) {
      try {
        const { body } = await proxyRequest(loadProxyConfig(), '/api/health');
        upstream = body;
      } catch {
        upstream = { error: 'upstream tracker unreachable' };
      }
    }

    // The default thresholds ride along because the settings screen has to show
    // them, and they are the same for everyone — a tuning value, not a secret.
    // Without this the screen would need the operator token just to label its
    // own inputs.
    return {
      ok: problems.length === 0,
      build: buildInfo(),
      configured,
      criteria: criteriaForDisplay(loadHuntConfig(env).criteria),
      problems,
      upstream,
    };
  });
}
