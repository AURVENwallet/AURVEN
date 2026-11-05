import {ProofEngine} from './proof-engine.js';
const engine=new ProofEngine();
let busy=false;
self.onmessage=async({data})=>{
  const {id,type,payload}=data??{};
  if(!Number.isSafeInteger(id)||id<1)return;
  if(busy){self.postMessage({id,error:'BUSY'});return;}
  busy=true;
  try{
    let result;
    if(type==='build')result=await engine.build(payload.record,payload.key,progress=>self.postMessage({id,progress}));
    else if(type==='sign')result=engine.sign(payload);
    else throw {code:'PROOF_FORMAT'};
    self.postMessage({id,result});
  }catch(error){self.postMessage({id,error:error.code??'WORKER'});}
  finally{busy=false;}
};
