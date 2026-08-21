import { describe, it, expect } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  describeBoard,
  describeEvents,
  toLiveMint,
  DEFAULT_LIVE_OPTIONS,
} from '../src/live.js';
import type { TrackedCollection } from '../src/tracker.js';
import type { ContractInfo } from '../src/inspect.js';

/**
 * The live board.
 *
 * A different question from the hunter's, and the tests reflect that: nothing
 * here is about whether to buy. It is about whether the numbers on screen match
 * the chain, and whether the one or two things worth saying out loud are the
 * ones that get said.
 */

const CONTRACT = '0x00000000000000000000000000000000000000aa' as Address;

function tracked(over: Partial<TrackedCollection> = {}): TrackedCollection {
  return {
    contract: CONTRACT,
    firstSeenAt: Date.now() - 120_000,
    lastSeenAt: Date.now(),
    ageSec: 120,
    lastSeenSecAgo: 1,
    status: 'live',
    attempts: 640,
    freeAttempts: 640,
    paidAttempts: 0,
    uniqueMinters: 60,
    attemptsInWindow: 90,
    attemptsPerMinute: 320,
    totalValueWei: '0',
    observedValueWei: '0',
    isFree: true,
    topSelector: '0xa0712d68' as Hex,
    sampleCalldata: '0xa0712d6801' as Hex,
    sampleRaw: '0x02f8aa' as Hex,
    entrypoint: 'known',
    flagged: true,
    ...over,
  } as TrackedCollection;
}

function info(over: Partial<ContractInfo> = {}): ContractInfo {
  return {
    contract: CONTRACT,
    hasCode: true,
    isNft: true,
    looksLikeNft: true,
    name: 'Solar Cats',
    symbol: 'SCAT',
    totalSupply: { value: '820', source: 'totalSupply()' },
    maxSupply: { value: '1000', source: 'maxSupply()' },
    progressPct: 82,
    remaining: '180',
    soldOut: false,
    summary: '',
    ...over,
  } as ContractInfo;
}

describe('describeEvents', () => {
  const base = {
    soldOut: false, progressPct: 40, projectedSelloutSec: undefined as number | undefined,
    uniqueMinters: 5, ageSec: 600, mintsPerMinute: 20, mints: 200, status: 'live',
  };

  it('leads with sold out, and says how fast it went', () => {
    const events = describeEvents({ ...base, soldOut: true, ageSec: 90 });
    expect(events[0].kind).toBe('sold-out');
    expect(events[1].text).toMatch(/Gone in/);
  });

  it('says nothing else once it is gone', () => {
    // Speed and crowd size stop mattering the moment there is nothing left.
    const events = describeEvents({
      ...base, soldOut: true, uniqueMinters: 200, mintsPerMinute: 900,
    });
    expect(events.map((e) => e.kind)).not.toContain('crowd');
  });

  it('warns when supply is about to run out', () => {
    const events = describeEvents({ ...base, projectedSelloutSec: 34 });
    expect(events[0].kind).toBe('minting-out');
    expect(events[0].text).toMatch(/34s left/);
  });

  it('does not call a stalled collection urgent', () => {
    // A projection built from a rate that stopped is arithmetic, not urgency.
    const events = describeEvents({ ...base, projectedSelloutSec: 20, status: 'quiet' });
    expect(events.map((e) => e.kind)).not.toContain('minting-out');
  });

  it('reports the crowd the way a person would say it', () => {
    // The line this whole board exists to produce.
    const events = describeEvents({ ...base, uniqueMinters: 60, ageSec: 120 });
    expect(events.some((e) => e.text === '60 wallets in 2m')).toBe(true);
  });

  it('ignores a crowd of one bot', () => {
    const events = describeEvents({ ...base, uniqueMinters: 3, mints: 800 });
    expect(events.map((e) => e.kind)).not.toContain('crowd');
  });

  it('always says something', () => {
    // A row with no headline still needs a line, or it reads as broken.
    const events = describeEvents({ ...base, mints: 42 });
    expect(events).toHaveLength(1);
    expect(events[0].text).toBe('42 minted so far');
  });
});

describe('toLiveMint', () => {
  it('carries supply, price and round through', () => {
    const m = toLiveMint(tracked(), info({
      priceWei: { value: '5000000000000000', source: 'price()' },
      phase: 'public',
      maxPerWallet: { value: '3', source: 'maxPerWallet()' },
    }));

    expect(m.totalSupply).toBe('820');
    expect(m.maxSupply).toBe('1000');
    expect(m.progressPct).toBe(82);
    expect(m.remaining).toBe('180');
    expect(m.priceEth).toBe('0.005');
    expect(m.isFree).toBe(false);
    expect(m.phase).toBe('public');
    expect(m.maxPerWallet).toBe('3');
  });

  it('prefers the contract\'s price over what the feed saw', () => {
    // Observed value is an average across attempts and drifts; the contract is
    // the actual number someone will pay.
    const m = toLiveMint(
      tracked({ observedValueWei: '9000000000000000' }),
      info({ priceWei: { value: '1000000000000000', source: 'mintPrice()' } }),
    );
    expect(m.priceEth).toBe('0.001');
  });

  it('falls back to the observed value when the contract will not say', () => {
    const m = toLiveMint(tracked({ observedValueWei: '2000000000000000' }), info());
    expect(m.priceEth).toBe('0.002');
  });

  it('projects a sellout from supply left and the current rate', () => {
    // 180 left at 320/min is a little under 34 seconds.
    const m = toLiveMint(tracked(), info());
    expect(m.projectedSelloutSec).toBeCloseTo(33.75, 1);
  });

  it('carries the calldata needed to mint it from the board', () => {
    const m = toLiveMint(tracked(), info());
    expect(m.sampleCalldata).toBe('0xa0712d6801');
    expect(m.sampleRaw).toBe('0x02f8aa');
  });

  it('renders a sold-out collection without a sellout projection', () => {
    const m = toLiveMint(
      tracked({ status: 'quiet' }),
      info({ soldOut: true, remaining: '0', progressPct: 100 }),
    );
    expect(m.soldOut).toBe(true);
    expect(m.events[0].kind).toBe('sold-out');
  });

  it('survives a contract that answers nothing beyond being an NFT', () => {
    const m = toLiveMint(tracked(), info({
      totalSupply: undefined, maxSupply: undefined, progressPct: undefined,
      remaining: undefined, name: undefined,
    }));
    expect(m.progressPct).toBeUndefined();
    expect(m.soldOut).toBe(false);
    expect(m.events.length).toBeGreaterThan(0);
  });
});

describe('what the board keeps', () => {
  it('marks a contract nothing could be established about as unverified', () => {
    // These are held off the board. Being permissive here is what put a shared
    // drop contract on it with three thousand mints a minute and no NFT
    // interface anywhere in sight.
    const m = toLiveMint(tracked(), undefined);
    expect(m.kind).toBe('unverified');
  });

  it('marks a contract ERC-165 vouched for as confirmed', () => {
    expect(toLiveMint(tracked(), info()).kind).toBe('confirmed');
  });

  it('marks an older collection with the right shape as likely', () => {
    const m = toLiveMint(tracked(), info({ isNft: undefined, looksLikeNft: true }));
    expect(m.kind).toBe('likely');
  });
});

describe('describeMetrics', () => {
  function metricsFor(over: Partial<TrackedCollection>, i?: Partial<ContractInfo>) {
    const m = toLiveMint(tracked(over), info(i));
    const by: Record<string, string> = {};
    for (const x of m.metrics) by[x.label] = x.tone;
    return { row: m, tone: by };
  }

  it('reads a busy, crowded, free public drop as good', () => {
    const { tone } = metricsFor({}, { phase: 'public' });
    expect(tone.speed).toBe('good');
    expect(tone.wallets).toBe('good');
    expect(tone.price).toBe('good');
    expect(tone.round).toBe('good');
  });

  it('calls out a crowd of one bot', () => {
    // Many mints from three addresses is a bot fight, not demand.
    expect(metricsFor({ uniqueMinters: 3 }).tone.wallets).toBe('bad');
  });

  it('calls out a drop that has nearly gone', () => {
    // Past ninety per cent you mostly pay gas to lose the race.
    const { tone } = metricsFor({}, { progressPct: 96 });
    expect(tone.minted).toBe('bad');
  });

  it('calls out an allowlist round, which is a closed door', () => {
    expect(metricsFor({}, { phase: 'allowlist' }).tone.round).toBe('bad');
  });

  it('calls out a collection that has stopped', () => {
    expect(metricsFor({ lastSeenSecAgo: 400 }).tone['last mint']).toBe('bad');
  });

  it('says a per-wallet cap above one is worth having', () => {
    const { tone } = metricsFor({}, { maxPerWallet: { value: '5', source: 'maxPerWallet()' } });
    expect(tone['max each']).toBe('good');
  });

  it('gives every metric a verdict', () => {
    // A metric with no tone renders in the default colour and reads as an
    // oversight rather than a neutral judgement.
    const { row } = metricsFor({});
    for (const metric of row.metrics) {
      expect(['good', 'bad', 'neutral']).toContain(metric.tone);
      expect(metric.value.length).toBeGreaterThan(0);
    }
  });
});

describe('ordering', () => {
  it('puts a sold-out collection behind one still minting', () => {
    // Verified through the board's own comparator by way of the fields it uses.
    const live = toLiveMint(tracked(), info());
    const gone = toLiveMint(tracked(), info({ soldOut: true }));
    expect(live.soldOut).toBe(false);
    expect(gone.soldOut).toBe(true);
  });

  it('keeps the age that the newest-first ordering sorts on', () => {
    expect(toLiveMint(tracked({ ageSec: 12 }), info()).ageSec).toBe(12);
  });
});

describe('the volume floor', () => {
  it('is low, because the board is a window and not a shortlist', () => {
    // The judgement on this page belongs to the person reading it. A high floor
    // turned it into a filter that showed nothing and then blamed the reader's
    // settings — the version this replaces reported "7301 mints seen" above an
    // empty list.
    expect(DEFAULT_LIVE_OPTIONS.minMints).toBeLessThanOrEqual(3);
    // Not zero: a single stray call to a contract is not a drop.
    expect(DEFAULT_LIVE_OPTIONS.minMints).toBeGreaterThan(1);
  });

  it('inspects enough contracts to fill a screen', () => {
    expect(DEFAULT_LIVE_OPTIONS.inspectTop).toBeGreaterThanOrEqual(20);
  });
});

describe('describeBoard', () => {
  const none = { seen: 0, belowFloor: 0, notNft: 0, notInspected: 0, unreadable: 0 };

  it('accounts for every contract it held back', () => {
    // "Loosen the filter" was useless twice over: it did not say what had been
    // dropped, and it blamed the reader for what was usually something else.
    const note = describeBoard(20, 3, {
      seen: 38, belowFloor: 31, notNft: 4, notInspected: 0, unreadable: 0,
    });
    expect(note).toContain('38 contract(s) seen, 3 shown');
    expect(note).toContain('31 under the mint floor');
    expect(note).toContain('4 not NFT contracts');
  });

  it('says plainly when the chain was quiet', () => {
    expect(describeBoard(20, 0, none)).toMatch(/no contracts being called/);
  });

  it('mentions what it could not read', () => {
    const note = describeBoard(20, 0, { ...none, seen: 2, unreadable: 2 });
    expect(note).toContain('2 unreadable');
  });

  it('stays quiet about categories with nothing in them', () => {
    const note = describeBoard(20, 5, { ...none, seen: 5 });
    expect(note).not.toContain('Held back');
    expect(note).not.toContain('could not be read');
  });

  it('does not claim a short window when a tracker did the watching', () => {
    // The rows came from a host that has been listening for as long as it has
    // been up. "Watched 20s" would make a thin board look like a broken feed.
    const note = describeBoard(20, 3, { ...none, seen: 9, belowFloor: 6 }, 'upstream');

    expect(note).not.toContain('20s');
    expect(note).toContain('watching continuously');
    expect(note).toContain('9 contract(s) seen, 3 shown');
    expect(note).toContain('6 under the mint floor');
  });

  it('says the tracker saw nothing, rather than that the window was short', () => {
    expect(describeBoard(20, 0, none, 'upstream')).toMatch(/watching continuously/);
    expect(describeBoard(20, 0, none, 'upstream')).not.toContain('20s');
  });
});
