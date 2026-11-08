/**
 * The chain layer's two safety properties that a mock-free run would only
 * hit by bad luck: never talking to mainnet, and confirmation that always
 * ends (with the truth) instead of spinning.
 */
import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Connection, Keypair, SystemProgram, Transaction} from '@solana/web3.js';
import {type Cluster, PROGRAM_ID, ROOT, SOLANA_DEVNET, openCluster, patientFetch, programsRoot, sendAndConfirm} from '../src/chain/fidora.js';

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const TESTNET_GENESIS = '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY';

function programsRootWithDeployment(): string {
  const root = mkdtempSync(join(tmpdir(), 'fidora-chain-test-'));
  mkdirSync(join(root, 'deployments'));
  writeFileSync(
    join(root, 'deployments', 'localnet.json'),
    JSON.stringify({cluster: 'localnet', programId: PROGRAM_ID.toBase58(), startSlot: 0, accounts: {config: '', vault: '', paymentMint: '', arbiter: '', owner: ''}}),
  );
  return root;
}

describe('openCluster refuses public clusters it was not asked for', () => {
  afterEach(() => vi.restoreAllMocks());
  const env = () => ({FIDORA_PROGRAMS_ROOT: programsRootWithDeployment(), RPC_URL_LOCALNET: 'https://rpc.example-provider.io/abc'});

  it('refuses a "localnet" RPC that is really mainnet, though its URL does not say so', async () => {
    vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(MAINNET_GENESIS);
    await expect(openCluster('localnet', env())).rejects.toThrow(/mainnet/);
  });

  it('refuses a "localnet" RPC that is really Solana testnet', async () => {
    vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue(TESTNET_GENESIS);
    await expect(openCluster('localnet', env())).rejects.toThrow(/testnet/);
  });

  it('accepts a local validator, and names it by its own genesis', async () => {
    vi.spyOn(Connection.prototype, 'getGenesisHash').mockResolvedValue('7Kq3zgzWQd9mJ4yG8kM2r5pS1aB6cD8eF9gH2iJ3kL4m');
    const c = await openCluster('localnet', env());
    expect(c.network).toBe('solana:7Kq3zgzWQd9mJ4yG8kM2r5pS1aB6cD8e');
    expect(c.network).not.toBe(SOLANA_DEVNET);
  });
});

describe('sendAndConfirm always ends, with the truth', () => {
  const payer = Keypair.generate();
  const tx = () => {
    const t = new Transaction({feePayer: payer.publicKey, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1}).add(
      SystemProgram.transfer({fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1}),
    );
    t.sign(payer);
    return t;
  };
  /** The recent-status cache has dropped the signature; only the history has it. */
  function cluster(history: {confirmationStatus?: string; err: unknown} | null) {
    let calls = 0;
    const connection = {
      sendRawTransaction: async () => 'SIG',
      isBlockhashValid: async () => ({value: false}),
      getTransaction: async () => ({meta: {logMessages: ['Program log: Error Code: PerTaskCapExceeded']}}),
      getSignatureStatuses: async (_s: string[], o: {searchTransactionHistory: boolean}) => {
        // A tight loop shows up here as thousands of calls in no time.
        if (++calls > 2_000) throw new Error('tight loop: getSignatureStatuses called 2000 times');
        return {value: [o.searchTransactionHistory ? history : null]};
      },
    };
    return {name: 'localnet', connection} as unknown as Cluster;
  }

  it('returns when only the history shows the transaction confirmed', async () => {
    await expect(sendAndConfirm(cluster({confirmationStatus: 'confirmed', err: null}), tx(), 2_000)).resolves.toBe('SIG');
  });

  it('throws with the program error when only the history shows it failed', async () => {
    await expect(sendAndConfirm(cluster({confirmationStatus: 'confirmed', err: {InstructionError: [0, {Custom: 6000}]}}), tx(), 2_000)).rejects.toThrow(/failed.*PerTaskCapExceeded/);
  });

  it('gives up at the deadline, saying the state is unknown, when the history shows it still processing', async () => {
    await expect(sendAndConfirm(cluster({confirmationStatus: 'processed', err: null}), tx(), 1_500)).rejects.toThrow(/state unknown/);
  });

  it('declares expiry only when the blockhash is gone and nothing anywhere knows the signature', async () => {
    await expect(sendAndConfirm(cluster(null), tx(), 2_000)).rejects.toThrow(/expired/);
  });
});

describe('an empty line copied from .env.example is unset, not a value', () => {
  it('FIDORA_PROGRAMS_ROOT= (empty) still finds the programs repo beside this one', () => {
    expect(programsRoot({FIDORA_PROGRAMS_ROOT: ''})).toBe(programsRoot({}));
    expect(programsRoot({FIDORA_PROGRAMS_ROOT: ''})).not.toBe(join(ROOT));
  });
});

describe('patientFetch waits out a rate-limited public RPC', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const reply = (status: number) => new Response('{}', {status});

  it('retries 429s, then returns the first answer that is not 429', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce(reply(429)).mockResolvedValueOnce(reply(429)).mockResolvedValueOnce(reply(200));
    vi.stubGlobal('fetch', fetch);
    const res = patientFetch('https://api.devnet.solana.com', {method: 'POST'});
    await vi.runAllTimersAsync();
    expect((await res).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retries a batch whose HTTP 200 carries a JSON-RPC 429 inside', async () => {
    vi.useFakeTimers();
    const limited = new Response(JSON.stringify([{jsonrpc: '2.0', id: 1, result: null}, {jsonrpc: '2.0', id: 2, error: {code: 429, message: 'Too many requests for a specific RPC call'}}]), {status: 200});
    const good = new Response(JSON.stringify([{jsonrpc: '2.0', id: 1, result: null}, {jsonrpc: '2.0', id: 2, result: null}]), {status: 200});
    const fetch = vi.fn().mockResolvedValueOnce(limited).mockResolvedValueOnce(good);
    vi.stubGlobal('fetch', fetch);
    const res = patientFetch('https://api.devnet.solana.com', {method: 'POST'});
    await vi.runAllTimersAsync();
    expect(await (await res).json()).toEqual([{jsonrpc: '2.0', id: 1, result: null}, {jsonrpc: '2.0', id: 2, result: null}]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('returns a 200 whose body only mentions 429 in data, not as an error code, at once', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({jsonrpc: '2.0', id: 1, result: {value: 429}}), {status: 200}));
    vi.stubGlobal('fetch', fetch);
    expect((await patientFetch('https://api.devnet.solana.com')).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a dropped connection, but rethrows any other error at once', async () => {
    vi.useFakeTimers();
    const f = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(new Response('{}', {status: 200}));
    vi.stubGlobal('fetch', f);
    const res = patientFetch('https://api.devnet.solana.com');
    await vi.runAllTimersAsync();
    expect((await res).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new RangeError('not a network error')));
    await expect(patientFetch('https://api.devnet.solana.com')).rejects.toThrow(RangeError);
  });

  it('returns any other status at once, without retrying', async () => {
    const fetch = vi.fn().mockResolvedValue(reply(500));
    vi.stubGlobal('fetch', fetch);
    expect((await patientFetch('https://api.devnet.solana.com')).status).toBe(500);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('stops after 13 attempts and hands the 429 back, never looping forever', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockImplementation(async () => reply(429));
    vi.stubGlobal('fetch', fetch);
    const res = patientFetch('https://api.devnet.solana.com');
    await vi.runAllTimersAsync();
    expect((await res).status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(13);
  });
});
