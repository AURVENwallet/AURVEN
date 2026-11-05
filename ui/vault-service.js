import {VaultError,fail,createEnvelope,validateEnvelope,parseBackup,deriveVaultKey,decryptPayload,
  encryptPayload,validateReservation,reservationId,MAX_RESERVATIONS} from './vault-crypto.js';
import {hex} from './vault-crypto.js';
import {ProofWorkerClient} from './proof-worker-client.js';
import {LOCAL_PROOF_FORMAT,PROOF_ACCOUNT,validateProofMessage,proofDigest,verifyLocalProof,proofTreeState} from './local-proof.js';
import {readAccount} from './account-state.js';
import {validateKeySnapshot,validateDerivedRoot,keyStateEqual} from './account-key-check.js';

export class TestVault {
  #key;#walletId;#revision=0;#generation=0;#timer;#deadline=0;#details=null;#observed=new Map();
  #proofWorker;#proofTree;#proofGeneration=0;
  #bindingWorker;#bindingAbort;#bindingGeneration=0;#bindingResult;
  constructor(store,{locks=globalThis.navigator?.locks,now=()=>performance.now(),idleMs=120000,onLock=()=>{},workerFactory=()=>new ProofWorkerClient(),
    bindingWorkerFactory=()=>new ProofWorkerClient(new URL('./account-key-worker.js',import.meta.url)),accountReader=readAccount}={}){
    if(!locks?.request||!Number.isFinite(idleMs)||idleMs<=0)fail('UNSUPPORTED');
    this.store=store;this.locks=locks;this.now=now;this.idleMs=idleMs;this.onLock=onLock;this.workerFactory=workerFactory;
    this.bindingWorkerFactory=bindingWorkerFactory;this.accountReader=accountReader;
  }
  get unlocked(){if(this.#key&&this.now()>=this.#deadline)this.lock('idle');return !!this.#key;}
  get details(){return this.#details?{...this.#details,unlocked:this.unlocked}:null;}
  touch(){
    if(!this.#key)return;
    if(this.now()>=this.#deadline){this.lock('idle');return;}
    this.#arm();
  }
  #arm(){clearTimeout(this.#timer);this.#deadline=this.now()+this.idleMs;this.#timer=setTimeout(()=>this.lock('idle'),this.idleMs);this.#timer.unref?.();}
  lock(reason='manual'){
    const hadKey=!!this.#key;this.#generation++;this.#key=undefined;this.#walletId=undefined;
    this.cancelProof();
    this.cancelAccountCheck();
    clearTimeout(this.#timer);if(hadKey)this.onLock(reason);
  }
  #capture(){if(!this.unlocked)fail('LOCKED');return {key:this.#key,generation:this.#generation,id:this.#walletId};}
  #check(context){if(!this.unlocked||context.generation!==this.#generation||context.id!==this.#walletId)fail('LOCKED');}
  #setDetails(record,payload){
    this.#details={walletId:record.walletId,chainId:record.chainId,createdAt:record.createdAt,mode:record.mode,
      revision:record.revision,reservations:payload?.journal.length??null};
  }
  async inspect(){
    const record=await this.store.read();
    if(!record){this.lock('missing');this.#details=null;return null;}
    validateEnvelope(record);
    if(this.unlocked)await this.#load(this.#capture());
    else this.#setDetails(record);
    return this.details;
  }
  #exclusive(action){
    return this.locks.request(this.store.name+':writer',{mode:'exclusive',ifAvailable:true},lock=>{
      if(!lock)fail('BUSY');return action();
    });
  }
  #activate(record,key,payload,generation){
    if(generation!==this.#generation)fail('LOCKED');
    this.#remember(record);
    this.#key=key;this.#walletId=record.walletId;this.#revision=record.revision;
    this.#setDetails(record,payload);this.#arm();return this.details;
  }
  #remember(record){
    if(record.revision<(this.#observed.get(record.walletId)??0)){this.lock('rollback');fail('ROLLBACK');}
    this.#observed.set(record.walletId,record.revision);
  }
  async create(password,chainId){
    this.lock();const generation=this.#generation;
    return this.#exclusive(async()=>{
      if(await this.store.read())fail('EXISTS');
      const {record,key}=await createEnvelope(password,chainId);
      if(generation!==this.#generation)fail('LOCKED');
      await this.store.create(record);
      return this.#activate(record,key,{journal:[]},generation);
    });
  }
  async unlock(password){
    this.lock();const generation=this.#generation;
    const record=await this.store.read();if(!record)fail('MISSING');
    validateEnvelope(record);
    const key=await deriveVaultKey(password,record.kdf.salt),payload=await decryptPayload(record,key);
    return this.#activate(record,key,payload,generation);
  }
  async #load(context){
    this.#check(context);
    const record=await this.store.read();if(!record)fail('MISSING');
    validateEnvelope(record);
    if(record.walletId!==context.id||record.revision<this.#revision){this.lock('rollback');fail('ROLLBACK');}
    const payload=await decryptPayload(record,context.key);
    this.#check(context);this.#remember(record);this.#revision=record.revision;this.#setDetails(record,payload);
    return {record,payload};
  }
  async exportBackup(){
    const context=this.#capture();
    return this.#exclusive(async()=>{
      try{
        const {record}=await this.#load(context);this.#check(context);
        return JSON.stringify(record,null,2)+'\n';
      }catch(error){this.lock('storage');throw error;}
    });
  }
  async restoreBackup(text,password){
    const backup=parseBackup(text);this.lock();const generation=this.#generation;
    return this.#exclusive(async()=>{
      if(await this.store.read())fail('EXISTS');
      const key=await deriveVaultKey(password,backup.kdf.salt),payload=await decryptPayload(backup,key);
      // Every import is permanently blocked from reservations in this version.
      // A backup cannot prove that later signatures were never produced.
      const record=await encryptPayload(payload,key,{...backup,mode:'recovery-readonly',revision:backup.revision+1});
      if(generation!==this.#generation)fail('LOCKED');
      await this.store.create(record);
      return this.#activate(record,key,payload,generation);
    });
  }
  get proofTree(){return this.unlocked&&this.#proofTree?{...this.#proofTree}:null;}
  cancelProof(){this.#proofGeneration++;this.#proofWorker?.dispose();this.#proofWorker=undefined;this.#proofTree=undefined;}
  async buildProofTree(progress){
    const context=this.#capture(),generation=this.#proofGeneration;
    if(this.#proofWorker)fail('BUSY');
    const {record,payload}=await this.#load(context);
    if(generation!==this.#proofGeneration)fail('CANCELED');
    if(record.mode!=='active')fail('RECOVERY');
    // Two requests may have overlapped while storage was being read.
    if(this.#proofWorker)fail('BUSY');
    const worker=this.workerFactory();this.#proofWorker=worker;
    try{
      const tree=await worker.request('build',{record,key:context.key},progress);
      this.#check(context);if(worker!==this.#proofWorker)fail('CANCELED');
      if(tree.walletId!==record.walletId||tree.chainId!==record.chainId||
        !/^[0-9a-f]{32}$/.test(tree.pubSeed)||!/^[0-9a-f]{32}$/.test(tree.root))fail('PROOF_CONTEXT');
      this.#proofTree={...tree,...proofTreeState(payload.journal,tree)};
      return this.proofTree;
    }catch(error){if(worker===this.#proofWorker)this.cancelProof();throw error;}
  }
  async signProofMessage(message){
    validateProofMessage(message);
    const context=this.#capture(),worker=this.#proofWorker,tree=this.#proofTree;
    if(!worker||!tree)fail('TREE_REQUIRED');
    return this.#exclusive(async()=>{
      try{
        const {record,payload}=await this.#load(context);
        if(record.mode!=='active')fail('RECOVERY');
        if(worker!==this.#proofWorker)fail('CANCELED');
        if(tree.walletId!==record.walletId||tree.chainId!==record.chainId)fail('PROOF_CONTEXT');
        const {nextLeaf}=proofTreeState(payload.journal,tree);
        if(nextLeaf>=1024||payload.journal.length>=MAX_RESERVATIONS)fail('FULL');
        const request={format:LOCAL_PROOF_FORMAT,purpose:'verification-only',walletId:tree.walletId,
          chainId:tree.chainId,pubSeed:tree.pubSeed,root:tree.root,leaf:nextLeaf,message,
          challenge:hex(crypto.getRandomValues(new Uint8Array(16)))};
        const digest=hex(proofDigest(request));
        payload.journal.push(validateReservation({chainId:record.chainId,account:PROOF_ACCOUNT,epoch:0,
          pubSeed:tree.pubSeed,root:tree.root,leaf:nextLeaf,digest}));
        const updated=await encryptPayload(payload,context.key,{...record,revision:record.revision+1});
        this.#check(context);if(worker!==this.#proofWorker)fail('CANCELED');
        await this.store.compareAndSwap(record,updated);
        this.#check(context);this.#remember(updated);this.#revision=updated.revision;this.#setDetails(updated,payload);
        if(worker!==this.#proofWorker)fail('CANCELED');
        this.#proofTree={...tree,...proofTreeState(payload.journal,tree)};
        const result=await worker.request('sign',request);
        this.#check(context);if(worker!==this.#proofWorker)fail('CANCELED');
        for(const field of Object.keys(request))if(result[field]!==request[field])fail('PROOF_CONTEXT');
        if(result.digest!==digest||!verifyLocalProof(result))fail('PROOF_VERIFY');
        return result;
      }catch(error){
        if(!(error instanceof VaultError)||!['FULL','RECOVERY','LOCKED','CANCELED'].includes(error.code))this.lock('storage');
        throw error;
      }
    });
  }
  async reserveLeaf(input){
    const row=validateReservation({...input}),context=this.#capture();
    return this.#exclusive(async()=>{
      try{
        const {record,payload}=await this.#load(context);
        if(record.mode!=='active')fail('RECOVERY');
        if(row.chainId!==record.chainId)fail('NETWORK');
        if(payload.journal.some(previous=>reservationId(previous)===reservationId(row)))fail('USED');
        if(payload.journal.length>=MAX_RESERVATIONS)fail('FULL');
        payload.journal.push(row);
        const updated=await encryptPayload(payload,context.key,{...record,revision:record.revision+1});
        this.#check(context);
        // No proof may be released before this strict transaction completes.
        await this.store.compareAndSwap(record,updated);
        this.#check(context);this.#remember(updated);this.#revision=updated.revision;this.#setDetails(updated,payload);
        return {revision:updated.revision,leaf:row.leaf};
      }catch(error){
        if(!(error instanceof VaultError)||!['USED','RECOVERY','NETWORK','FULL','LOCKED'].includes(error.code))this.lock('storage');
        throw error;
      }
    });
  }
  get accountCheck(){return this.unlocked&&this.#bindingResult?structuredClone(this.#bindingResult):null;}
  cancelAccountCheck(){
    this.#bindingGeneration++;this.#bindingAbort?.abort();this.#bindingAbort=undefined;
    this.#bindingWorker?.dispose();this.#bindingWorker=undefined;this.#bindingResult=undefined;
  }
  async checkAccountKeys({endpoint,account},progress){
    const context=this.#capture();
    if(this.#bindingAbort)fail('BUSY');
    this.#bindingResult=undefined;
    account=typeof account==='string'?account.trim().toLowerCase():'';
    if(!/^0x[0-9a-f]{40}$/.test(account))fail('KEY_CONTEXT');
    const generation=this.#bindingGeneration,controller=new AbortController();this.#bindingAbort=controller;
    const stillCurrent=()=>{this.#check(context);if(generation!==this.#bindingGeneration)fail('CANCELED');};
    let worker;
    try{
      const {record}=await this.#load(context);stillCurrent();
      const read=async()=>validateKeySnapshot(await this.accountReader({endpoint,account,chainId:record.chainId,signal:controller.signal}),record.chainId,account);
      const before=await read();stillCurrent();
      worker=this.bindingWorkerFactory();this.#bindingWorker=worker;
      const derived=validateDerivedRoot(await worker.request('check',{record,key:context.key,snapshot:before},progress),record,before);
      stillCurrent();
      const after=await read();stillCurrent();
      if(!keyStateEqual(before,after))fail('ACCOUNT_CHANGED');
      const latest=await this.#load(context);stillCurrent();
      if(latest.record.chainId!==record.chainId||latest.record.mode!==record.mode)fail('KEY_CONTEXT');
      this.#bindingResult={format:'aurven-account-root-check-v1',walletId:record.walletId,chainId:record.chainId,
        account,mode:record.mode,matched:derived.pubSeed===after.pubSeed&&derived.root===after.root,
        purpose:'local-root-comparison-only',derivedPubSeed:derived.pubSeed,derivedRoot:derived.root,
        snapshot:after,checkedAt:Date.now()};
      return this.accountCheck;
    }catch(error){
      if(generation!==this.#bindingGeneration)fail(this.unlocked?'CANCELED':'LOCKED');
      if(['AUTH_FAILED','FORMAT','MISSING','ROLLBACK','STORAGE'].includes(error.code))this.lock('storage');
      throw error;
    }finally{
      worker?.dispose();
      if(generation===this.#bindingGeneration){this.#bindingWorker=undefined;this.#bindingAbort=undefined;}
    }
  }
}
