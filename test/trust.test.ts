/** The trust verdict rules, pinned: the same as Pactora's, in the same order. */
import {describe, expect, it} from 'vitest';
import {actionOf, incompleteReading, readEvents, verdictOf} from '../src/agents/trust.js';

const m = (o: Partial<Parameters<typeof verdictOf>[0]> = {}) => ({settled: 0, failed: 0, clientOwners: 0, topOwnerSettled: 0, selfFunded: 0, ...o});

describe('verdictOf', () => {
  it('calls an agent with no record new — unknown, not bad — and warns', () => {
    expect(verdictOf(m()).verdict).toBe('new');
    expect(actionOf('new')).toBe('warn');
  });

  it('blocks a record a fifth or more of which the worker paid for itself, even with one job', () => {
    const v = verdictOf(m({settled: 1, selfFunded: 1, clientOwners: 1, topOwnerSettled: 1}));
    expect(v.verdict).toBe('self-funded');
    expect(actionOf(v.verdict)).toBe('block');
    expect(verdictOf(m({settled: 10, selfFunded: 1, clientOwners: 10, topOwnerSettled: 1})).verdict).not.toBe('self-funded');
  });

  it('blocks a record that mostly fails', () => {
    expect(verdictOf(m({settled: 2, failed: 2, clientOwners: 3, topOwnerSettled: 1})).verdict).toBe('failing');
    expect(actionOf('failing')).toBe('block');
  });

  it('warns on a record few owners wrote', () => {
    const v = verdictOf(m({settled: 5, clientOwners: 2, topOwnerSettled: 4}));
    expect(v.verdict).toBe('concentrated');
    expect(v.reasons).toHaveLength(2);
    expect(actionOf('concentrated')).toBe('warn');
  });

  it('allows a record many owners paid for', () => {
    const v = verdictOf(m({settled: 6, clientOwners: 4, topOwnerSettled: 2}));
    expect(v.verdict).toBe('trusted');
    expect(actionOf(v.verdict)).toBe('allow');
  });
});

describe('readEvents: a partial read is reported, never silently trusted', () => {
  const sig = (i: number, slot: number) => ({signature: `s${i}`, slot, err: null});
  const clusterWith = (pages: {signature: string; slot: number; err: null}[][]) => {
    let call = 0;
    return {
      deployment: {startSlot: 100},
      connection: {
        getSignaturesForAddress: async () => pages[call++] ?? [],
        getTransactions: async (s: string[]) => s.map(() => ({meta: {logMessages: []}})),
      },
    } as never;
  };

  it('is complete when the history reaches back past the deployment', async () => {
    const r = await readEvents(clusterWith([[sig(1, 120), sig(2, 110)]]));
    expect(r.complete).toBe(true);
  });

  it('is complete when a full page ends below the start slot', async () => {
    const page = Array.from({length: 1_000}, (_, i) => sig(i, 1_050 - i)); // ends at slot 51, below 100
    const more = Array.from({length: 1_000}, (_, i) => sig(5_000 + i, 50_000)); // read only if the start-slot stop were missing
    expect((await readEvents(clusterWith([page, more]), 1_000)).complete).toBe(true);
  });

  // Anyone can push old evidence out of a bounded window by flooding cheap
  // program transactions. A self-funding record must not turn into "new".
  it('is incomplete when the bound is reached before the deployment start', async () => {
    const full = (base: number) => Array.from({length: 1_000}, (_, i) => sig(base + i, 100_000 - base - i));
    const r = await readEvents(clusterWith([full(0), full(1_000), full(2_000)]), 2_000);
    expect(r.complete).toBe(false);
  });
});

describe('incompleteReading: no agent is cleared on partial evidence', () => {
  it('blocks every verdict, and says why', () => {
    const base = {agentId: '3', ...verdictOf(m({settled: 6, clientOwners: 4, topOwnerSettled: 2})), action: 'allow' as const, metrics: m()};
    const r = incompleteReading(base, 2_000);
    expect(r.action).toBe('block');
    expect(r.verdict).toBe('trusted');
    expect(r.reasons[0]).toMatch(/only the newest 2000 program transactions/);
  });
});
