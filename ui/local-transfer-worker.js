import {signLocalTransfer} from './local-transfer.js';

self.onmessage = async ({data}) => {
  self.onmessage = null;
  const {id,type,payload} = data;
  try {
    if (type !== 'sign-local') throw new Error();
    const proof = await signLocalTransfer(payload);
    self.postMessage({id,result:proof},[proof.buffer]);
  } catch (error) {
    self.postMessage({id,error:error.code ?? 'WORKER'});
  } finally { self.close(); }
};
