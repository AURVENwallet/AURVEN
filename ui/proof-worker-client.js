import {VaultError,fail} from './vault-crypto.js';
export class ProofWorkerClient {
  #worker;#next=0;#pending=new Map();
  constructor(url=new URL('./proof-worker.js',import.meta.url)){
    if(typeof Worker!=='function')fail('UNSUPPORTED');
    try{this.#worker=new Worker(url,{type:'module'});}catch{fail('WORKER');}
    this.#worker.onmessage=({data})=>{
      const pending=this.#pending.get(data?.id);if(!pending)return;
      if(typeof data.progress==='number'){
        if(Number.isFinite(data.progress)&&data.progress>=0&&data.progress<=1)pending.progress?.(data.progress);
        return;
      }
      clearTimeout(pending.timer);this.#pending.delete(data.id);
      if(data.error)pending.reject(new VaultError(data.error));else pending.resolve(data.result);
    };
    this.#worker.onerror=event=>{event.preventDefault();this.dispose('WORKER');};
    this.#worker.onmessageerror=()=>this.dispose('WORKER');
  }
  request(type,payload,progress){
    if(!this.#worker)return Promise.reject(new VaultError('CANCELED'));
    const id=++this.#next;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.dispose('WORKER_TIMEOUT'),180000);
      this.#pending.set(id,{resolve,reject,progress,timer});
      try{this.#worker.postMessage({id,type,payload});}catch{this.dispose('WORKER');}
    });
  }
  dispose(code='CANCELED'){
    this.#worker?.terminate();this.#worker=undefined;
    for(const {reject,timer} of this.#pending.values()){clearTimeout(timer);reject(new VaultError(code));}
    this.#pending.clear();
  }
}
