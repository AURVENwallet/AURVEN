import {pinnedRuntime} from './local-wallet-chain.mjs';
await pinnedRuntime();
console.log('PASS: compiled BscTestAccount runtime matches the client pin.');
