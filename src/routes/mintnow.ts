import { formatEther } from 'viem';
import type { Address, Hex } from 'viem';
import { handleApi } from '../http.js';
import type { ApiRequest, ApiResponse } from '../http.js';
import { loadHuntRuntime, loadHuntConfig } from '../config.js';
import { RpcClient } from '../rpc.js';
import { loadWallets } from '../wallet.js';
import { inspectContract } from '../inspect.js';
import { loadBillingConfig } from '../billing.js';
import { mintCandidate } from '../hunt.js';
import { recallLiveMint } from '../liveCache.js';
import { authenticateAccount } from '../accountstore.js';
import { privateKeysOf } from '../accounts.js';
import type { TrackedCollection } from '../tracker.js';

/**
 * POST /api/mintnow — mint one collection from the live board, now.
 *
 * The board already found, for every row it shows, a transaction that mints
 * that collection successfully. This replays it: same candidate generation,
 * same simulation gate, same funded-wallet filter as the automatic hunter, so
 * there is exactly one implementation of "turn a stranger's calldata into a
 * mint for us" and one place the recipient-rewriting bug could ever live.
 *
 * Deliberately does *not* apply the hunt criteria. Those exist to decide what
 * to buy unattended; a person pressing a button on a specific row has already
 * made that decision, and second-guessing it would just be confusing. The
 * spending ceiling still applies, because that is not a preference.
 */
export default async function handler(req: ApiRequest, res: ApiResponse): Promise<void> {
  const accountId = header(req, 'x-account-id');
  const accountToken = header(req, 'x-account-token');
  const asAccount = Boolean(accountId && accountToken);

  await handleApi(
    req,
    res,
    { methods: ['POST'], publicRoute: asAccount, limit: 'mint' },
    async (body) => {
      const contract = String(body.contract ?? '').trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) {
        throw configError('Pick a collection from the board first.');
      }
      const dryRun = body.dryRun === true;

      let privateKeys: Hex[] | undefined;
      let rpcUrls: string[] | undefined;
      let namespace: string | undefined;
      if (asAccount) {
        const account = await authenticateAccount(accountId, accountToken);
        namespace = account.id;
        privateKeys = privateKeysOf(account).map((k) => k.privateKey);
        if (account.rpcUrl) rpcUrls = [account.rpcUrl];
      }

      const cached = await recallLiveMint(contract, process.env, namespace);
      if (!cached?.sampleCalldata) {
        throw configError(
          'That collection is no longer on the board, so there is no working mint left ' +
            'to copy. Refresh the board and try again.',
        );
      }

      const base = loadHuntRuntime(process.env, privateKeys === undefined);
      const config = { ...base, ...(privateKeys ? { privateKeys } : {}) };
      const wallets = loadWallets(config.privateKeys);

      const clients = [...(rpcUrls ?? []), ...config.rpcUrls].map(
        (u) => new RpcClient(u, { maxSockets: 16 }),
      );
      const submitOnly = (config.submitOnlyUrls ?? []).map(
        (u) => new RpcClient(u, { maxSockets: 16 }),
      );
      const primary = clients[0];

      try {
        const info = await inspectContract(primary, contract as Address, wallets[0].address);
        if (info.isNft === false || (info.isNft === undefined && !info.looksLikeNft)) {
          throw configError(
            'That address does not look like an NFT contract, so nothing was sent.',
          );
        }
        if (info.soldOut) throw configError('That collection is sold out.');

        // The ceiling is the operator's, not the caller's, and applies whether
        // the mint was chosen by a person or by the hunter.
        const hunt = loadHuntConfig();
        const price = BigInt(cached.priceWei || '0');
        if (price > hunt.criteria.maxPriceWei) {
          throw configError(
            `That mint costs ${formatEther(price)} ETH, above the ${formatEther(
              hunt.criteria.maxPriceWei,
            )} ETH per-mint ceiling this deployment allows.`,
          );
        }

        // Mints through a shared drop contract have to go back to that
        // contract; the collection would reject its own calldata.
        const sendTo = cached.mintVia ?? contract;

        // A synthetic row: the mint path only reads these fields, and the
        // cached sample is exactly what a hunt round would have handed it.
        const collection = {
          contract: sendTo,
          topSelector: cached.entrypoint as Hex | undefined,
          sampleCalldata: cached.sampleCalldata as Hex,
          sampleRaw: cached.sampleRaw as Hex | undefined,
          observedValueWei: price.toString(),
          isFree: cached.isFree,
        } as unknown as TrackedCollection;

        const minted = await mintCandidate({
          billing: loadBillingConfig(),
          collection,
          info,
          config,
          wallets,
          primary,
          submitClients: [...submitOnly, ...clients],
          dryRun,
          freeOnly: price === 0n,
          maxValueWei: hunt.criteria.maxPriceWei,
        });

        return { contract, name: info.name ?? cached.name, dryRun, ...minted };
      } finally {
        for (const c of [...clients, ...submitOnly]) c.destroy();
      }
    },
  );
}

/** Named so the route wrapper answers 400 rather than 500. */
function configError(message: string): Error {
  const err = new Error(message);
  err.name = 'ConfigError';
  return err;
}

function header(req: ApiRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
