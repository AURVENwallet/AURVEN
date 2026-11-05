import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {keccak256} from '../ui/lib/keccak.js';
import {accountCodeHash} from '../ui/contract-pin.js';
const artifact=JSON.parse(readFileSync(new URL('../out/BscTestAccount.sol/BscTestAccount.json',import.meta.url)));
const bytes=Uint8Array.from(Buffer.from(artifact.deployedBytecode.object.slice(2),'hex'));
const actual='0x'+Buffer.from(keccak256(bytes)).toString('hex');
assert.equal(actual,accountCodeHash,'Compiled account runtime differs from the client pin. Review compiler and source-byte changes.');
console.log('PASS: compiled BscTestAccount runtime matches the client pin.');
