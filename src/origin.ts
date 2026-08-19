import { RpcClient } from './rpc.js';
import { feedFor, sequencerRpcFor, type NetworkName } from './chain.js';

/**
 * Where a mint actually enters the chain.
 *
 * Worth being exact about what can and cannot be known here, because the
 * appealing answer is not the available one:
 *
 *   NOT knowable — where the *other* minters are. A transaction on the feed
 *   carries a signature and calldata, nothing about the machine that made it.
 *   Any map claiming to show competing minters by country would be invented.
 *
 *   Knowable, and the thing that actually decides races — where *your*
 *   transaction enters. Robinhood Chain orders first-come-first-served with no
 *   priority auction, so the only lever is how long your bytes take to reach
 *   the sequencer. That is a property of the endpoint you submit through and
 *   the distance between it and the sequencer, and it is measurable.
 *
 * So this reports the route your own mints take: which provider and region each
 * configured endpoint belongs to, how far away each one measures, and which of
 * them the mint will actually leave from.
 */

export interface Endpoint {
  url: string;
  /** Hostname only — the URL may carry an API key. */
  host: string;
  /** Recognised provider, or 'unknown'. */
  provider: string;
  /** Region parsed out of the hostname, when the provider encodes one. */
  region?: string;
  /** Median round trip in milliseconds, or undefined if unreachable. */
  rttMs?: number;
  /** What this endpoint is used for. */
  role: 'read' | 'submit' | 'feed';
  error?: string;
}

export interface OriginReport {
  network: NetworkName;
  chainId: number;
  /** The sequencer: the machine whose clock decides who was first. */
  sequencer: Endpoint;
  feed: Endpoint;
  endpoints: Endpoint[];
  /** The endpoint a mint will actually be broadcast through first. */
  submitsThrough?: Endpoint;
  /** Plain-language read of the route, and whether it is a good one. */
  summary: string;
  /** Named so the UI never implies it knows where other minters are. */
  note: string;
}

/**
 * Providers recognised by hostname, with the region marker they encode.
 *
 * Deliberately conservative: a host that does not match is reported as
 * 'unknown' rather than guessed at. A wrong region is worse than no region,
 * because someone would relocate a deployment on the strength of it.
 */
const PROVIDERS: Array<{ match: RegExp; name: string }> = [
  { match: /\.g\.alchemy\.com$/i, name: 'Alchemy' },
  { match: /\.alchemyapi\.io$/i, name: 'Alchemy' },
  { match: /\.infura\.io$/i, name: 'Infura' },
  { match: /\.quiknode\.pro$/i, name: 'QuickNode' },
  { match: /\.quicknode\.com$/i, name: 'QuickNode' },
  { match: /\.ankr\.com$/i, name: 'Ankr' },
  { match: /\.blastapi\.io$/i, name: 'Blast' },
  { match: /\.drpc\.org$/i, name: 'dRPC' },
  { match: /\.chainstack\.com$/i, name: 'Chainstack' },
  { match: /\.tenderly\.co$/i, name: 'Tenderly' },
  { match: /\.llamarpc\.com$/i, name: 'LlamaNodes' },
  { match: /\.publicnode\.com$/i, name: 'PublicNode' },
  { match: /sequencer\..*\.robinhood\.com$/i, name: 'Robinhood sequencer' },
  { match: /feed\..*\.robinhood\.com$/i, name: 'Robinhood feed' },
  { match: /\.chain\.robinhood\.com$/i, name: 'Robinhood public RPC' },
];

/** Region codes providers commonly put in a hostname. */
const REGIONS: Array<{ match: RegExp; name: string }> = [
  { match: /(^|[.-])us-?east|(^|[.-])use\d?([.-]|$)/i, name: 'US East' },
  { match: /(^|[.-])us-?west|(^|[.-])usw\d?([.-]|$)/i, name: 'US West' },
  { match: /(^|[.-])us-?central([.-]|$)/i, name: 'US Central' },
  { match: /(^|[.-])eu-?west|(^|[.-])euw\d?([.-]|$)/i, name: 'EU West' },
  { match: /(^|[.-])eu-?central|(^|[.-])euc\d?([.-]|$)/i, name: 'EU Central' },
  { match: /(^|[.-])ap-?southeast|(^|[.-])apse\d?([.-]|$)/i, name: 'Asia Pacific SE' },
  { match: /(^|[.-])ap-?northeast([.-]|$)/i, name: 'Asia Pacific NE' },
  { match: /(^|[.-])ap-?south([.-]|$)/i, name: 'Asia South' },
  { match: /(^|[.-])sa-?east([.-]|$)/i, name: 'South America' },
];

export function describeEndpoint(url: string, role: Endpoint['role']): Endpoint {
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep the raw string; the caller still gets something readable */
  }

  return {
    // The path can carry an API key, so only the host is ever reported.
    url: `${host}`,
    host,
    provider: PROVIDERS.find((p) => p.match.test(host))?.name ?? 'unknown',
    region: REGIONS.find((r) => r.match.test(host))?.name,
    role,
  };
}

/**
 * Time an endpoint the same way the mint path will use it.
 *
 * `eth_chainId` because it is the cheapest call every node answers, so the
 * number reflects the network path rather than how hard the node had to work.
 * Median of a few samples, since a single sample on a shared network is noise.
 */
async function measure(url: string, samples = 3): Promise<{ rttMs?: number; error?: string }> {
  const client = new RpcClient(url, { maxSockets: 2 });
  const timings: number[] = [];
  try {
    for (let i = 0; i < samples; i += 1) {
      const started = performance.now();
      await client.call('eth_chainId', []);
      timings.push(performance.now() - started);
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    client.destroy();
  }
  if (timings.length === 0) return { error: 'no response' };
  timings.sort((a, b) => a - b);
  return { rttMs: Math.round(timings[Math.floor(timings.length / 2)]) };
}

export interface OriginInput {
  network: NetworkName;
  chainId: number;
  /** Endpoints used for reads, in preference order. */
  rpcUrls: string[];
  /** Broadcast-only endpoints, raced ahead of the read endpoints. */
  submitOnlyUrls: string[];
}

export async function describeOrigin(input: OriginInput): Promise<OriginReport> {
  const sequencerUrl = sequencerRpcFor(input.network).split(',')[0]?.trim() ?? '';
  const feedUrl = feedFor(input.network);

  const submit = input.submitOnlyUrls.map((u) => describeEndpoint(u, 'submit'));
  const reads = input.rpcUrls.map((u) => describeEndpoint(u, 'read'));

  // Measure every endpoint at once: they are independent, and doing it in
  // series would make the report take as long as the sum of the latencies it
  // is reporting on.
  const measured = await Promise.all(
    [...submit, ...reads].map(async (endpoint, i) => {
      const url = [...input.submitOnlyUrls, ...input.rpcUrls][i];
      return { ...endpoint, ...(await measure(url)) };
    }),
  );

  const sequencer: Endpoint = sequencerUrl
    ? { ...describeEndpoint(sequencerUrl, 'submit'), ...(await measure(sequencerUrl)) }
    : { url: '—', host: '—', provider: 'unknown', role: 'submit', error: 'not configured' };

  // Submission races every endpoint at once, so the one that matters is
  // whichever answers fastest, not whichever is listed first.
  const reachable = measured.filter((e) => e.rttMs !== undefined);
  const submitsThrough = [...reachable].sort((a, b) => (a.rttMs ?? 1e9) - (b.rttMs ?? 1e9))[0];

  return {
    network: input.network,
    chainId: input.chainId,
    sequencer,
    feed: describeEndpoint(feedUrl, 'feed'),
    endpoints: measured,
    submitsThrough,
    summary: summarize(submitsThrough, sequencer, measured.length, reachable.length),
    note:
      'This is where your own transactions enter the chain. The feed shows that ' +
      'other people are minting, but never where they are minting from — nothing ' +
      'in a signed transaction carries a location, so any map of rival minters ' +
      'would be made up.',
  };
}

function summarize(
  fastest: Endpoint | undefined,
  sequencer: Endpoint,
  total: number,
  reachable: number,
): string {
  if (!fastest) {
    return `None of your ${total} endpoint(s) answered, so nothing can be minted right now.`;
  }

  const where = fastest.region
    ? `${fastest.provider} in ${fastest.region}`
    : fastest.provider === 'unknown'
      ? fastest.host
      : fastest.provider;

  const parts = [`Mints leave through ${where}, ${fastest.rttMs}ms away.`];

  if (sequencer.rttMs !== undefined) {
    parts.push(`The sequencer answers in ${sequencer.rttMs}ms.`);
    // On a FCFS chain the gap between your endpoint and the sequencer is the
    // whole race, so it is worth calling out rather than leaving as two numbers.
    if (sequencer.rttMs + 25 < (fastest.rttMs ?? 0)) {
      parts.push(
        'Submitting straight to the sequencer is measurably faster than your ' +
          'RPC — keep SEQUENCER_URLS enabled.',
      );
    }
  }

  if (reachable < total) parts.push(`${total - reachable} endpoint(s) did not answer.`);
  if ((fastest.rttMs ?? 0) > 250) {
    parts.push(
      'Over 250ms is a long way on a chain that orders first-come-first-served. ' +
        'An endpoint nearer the sequencer would win races this one loses.',
    );
  }

  return parts.join(' ');
}
