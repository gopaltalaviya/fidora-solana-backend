/**
 * Return everything the saved devnet test keys hold to the deployer (your
 * wallet, FIDORA_DEPLOYER_KEYPAIR): token accounts closed for their rent,
 * then all SOL.
 *
 *   npm run sweep:devnet
 *
 * The devnet demo already sweeps at its start and end; this is for a run that
 * stopped half-way. A key whose sweep fails keeps its file in .keys/devnet/.
 */
import {openCluster} from '../src/chain/fidora.js';
import {deployerKey} from '../src/dev/accounts.js';
import {sweep} from '../src/dev/throwaway.js';

const c = await openCluster('devnet');
const to = deployerKey(c);
const back = await sweep(c, to);
console.log(`sweep-devnet: ${back / 1e9} SOL returned to ${to.publicKey.toBase58()}`);
