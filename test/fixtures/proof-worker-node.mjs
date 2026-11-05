// Node test adapter for the unchanged browser worker message protocol.
import {parentPort} from 'node:worker_threads';
globalThis.self={postMessage:value=>parentPort.postMessage(value)};
await import('../../ui/proof-worker.js');
parentPort.on('message',data=>self.onmessage({data}));
