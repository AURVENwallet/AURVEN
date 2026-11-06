import {VaultError,fail,hex,createEnvelope,validateEnvelope,parseBackup,deriveVaultKey,decryptPayload,
  encryptPayload,validateReservation,reservationId,validateTestnetOffer,MAX_RESERVATIONS} from './vault-crypto.js';
import {ProofWorkerClient} from './proof-worker-client.js';
import {LOCAL_PROOF_FORMAT,PROOF_ACCOUNT,validateProofMessage,proofDigest,verifyLocalProof,proofTreeState} from './local-proof.js';
import {readAccount} from './account-state.js';
import {validateReviewDraft,compareDraftAccount,compareDraftState,nextTransferLeaf} from './draft-preflight.js';
import {localSimulationEndpoint,reservedRow,simulateLocalProof} from './local-transfer.js';
import {validateKeySnapshot,validateDerivedRoot,keyStateEqual} from './account-key-check.js';
import {encodeNetworkAction,setup,spendingLeaf,validateIntent,validateNetworkPlan,matchOffer} from './vault-network-proof.js';
import {verifyNetworkPlanState} from './signing-preflight.js';
import {compareBackupJournal, readRecoveryAccount, recoveryJournalReview} from './backup-recovery.js';
import {checkSource,confirmLocalHandover,offerFingerprint,readHandoverState,rotationMessage,sendLocalRotation} from './local-handover.js';
import {recoverTestnetRotation,validateRotationRecord} from './testnet-rotation.js';
import {EXEC_LIMIT} from './lib/evmwots.js';

export class TestVault {
  #key;#walletId;#revision=0;#generation=0;#timer;#deadline=0;#details=null;#observed=new Map();
  #proofWorker;#proofTree;#proofGeneration=0;
  #bindingWorker;#bindingAbort;#bindingGeneration=0;#bindingResult;#reviewTicket;
  #reserved;#simulationAbort;
  #networkWorker;
  #handoverWorker;#handoverOffer;#localSandbox;
  #recoveredAccounts=[];#inbound;
  constructor(store,{locks=globalThis.navigator?.locks,now=()=>performance.now(),idleMs=120000,onLock=()=>{},workerFactory=()=>new ProofWorkerClient(),
    bindingWorkerFactory=()=>new ProofWorkerClient(new URL('./account-key-worker.js',import.meta.url)),accountReader=readAccount,recoveryReader=readRecoveryAccount,networkPreflight=verifyNetworkPlanState,
    transferWorkerFactory=()=>new ProofWorkerClient(new URL('./local-transfer-worker.js',import.meta.url)),
    networkWorkerFactory=()=>new ProofWorkerClient(new URL('./vault-network-worker.js',import.meta.url))}={}){
    if(!locks?.request||!Number.isFinite(idleMs)||idleMs<=0)fail('UNSUPPORTED');
    this.store=store;this.locks=locks;this.now=now;this.idleMs=idleMs;this.onLock=onLock;this.workerFactory=workerFactory;
    this.bindingWorkerFactory=bindingWorkerFactory;this.accountReader=accountReader;this.transferWorkerFactory=transferWorkerFactory;
    this.networkWorkerFactory=networkWorkerFactory;this.networkPreflight=networkPreflight;
    this.recoveryReader=recoveryReader;
    this.#localSandbox=/^aurven-sandbox-[0-9a-f]{32}$/.test(store.name);
  }
  get unlocked(){if(this.#key&&this.now()>=this.#deadline)this.lock('idle');return !!this.#key;}
  get details(){return this.#details?{...this.#details,unlocked:this.unlocked}:null;}
  get recoveredAccounts(){return this.unlocked ? [...this.#recoveredAccounts] : [];}
  get receivedAccount(){return this.unlocked && this.#inbound?.hash ? this.#inbound.offer.account : null;}
  get receivingOffer(){return this.unlocked&&this.#handoverOffer?{...this.#handoverOffer}:null;}
  touch(){
    if(!this.#key)return;
    if(this.now()>=this.#deadline){this.lock('idle');return;}
    this.#arm();
  }
  #arm(){clearTimeout(this.#timer);this.#deadline=this.now()+this.idleMs;this.#timer=setTimeout(()=>this.lock('idle'),this.idleMs);this.#timer.unref?.();}
  lock(reason='manual'){
    this.#inbound=undefined;this.#handoverOffer=undefined;
    this.#handoverWorker?.dispose();this.#handoverWorker=undefined;
    this.#recoveredAccounts=[];
    this.#networkWorker?.dispose();this.#networkWorker=undefined;
    const hadKey=!!this.#key;this.#generation++;this.#key=undefined;this.#walletId=undefined;
    this.cancelProof();
    this.cancelAccountCheck();
    clearTimeout(this.#timer);if(hadKey)this.onLock(reason);
  }
  #capture(){if(!this.unlocked)fail('LOCKED');return {key:this.#key,generation:this.#generation,id:this.#walletId};}
  #check(context){if(!this.unlocked||context.generation!==this.#generation||context.id!==this.#walletId)fail('LOCKED');}
  #setDetails(record,payload){
    this.#inbound=record.mode==='active' && payload?.inboundOffer?{offer:payload.inboundOffer,hash:payload.inboundHash}:undefined;
    this.#handoverOffer=this.#localSandbox&&record.mode==='active'?payload?.handoverOffer:undefined;
    this.#recoveredAccounts=record.mode==='recovery-readonly' && record.chainId===97 && payload ?
      [...new Set([...payload.journal.map(row=>row.account).filter(account=>account!==PROOF_ACCOUNT),
        ...(payload.inboundHash?[payload.inboundOffer.account]:[])])] : [];
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
  async checkBackupFile(text){
    const context=this.#capture(), backup=parseBackup(text);
    return this.#exclusive(async()=>{
      let current;
      try{current=await this.#load(context);}catch(error){
        if(this.#generation===context.generation)this.lock('storage');
        throw error;
      }
      const {record,payload}=current;
      if(record.mode!=='active')fail('RECOVERY');
      if(record.walletId!==backup.walletId || record.chainId!==backup.chainId ||
        record.kdf.salt!==backup.kdf.salt || record.createdAt!==backup.createdAt)fail('BACKUP_SOURCE');
      let saved;
      try{saved=await decryptPayload(backup,context.key);}catch{fail('BACKUP_INVALID');}
      this.#check(context);
      if(saved.seed!==payload.seed)fail('BACKUP_SOURCE');
      let status=compareBackupJournal(saved.journal,payload.journal);
      if(saved.inboundOffer && (!payload.inboundOffer || Object.keys(saved.inboundOffer).some(k=>saved.inboundOffer[k]!==payload.inboundOffer[k])) ||
         saved.inboundHash && saved.inboundHash!==payload.inboundHash)status='different';
      else if(status==='matches' && ((!saved.inboundOffer && payload.inboundOffer) || (!saved.inboundHash && payload.inboundHash)))status='older';
      return {status,savedCount:saved.journal.length,
        currentCount:payload.journal.length,checkedRevision:record.revision};
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
  // These operations are limited to the random database of a running loopback launcher.
  async localHandover({endpoint,account,offer,fingerprint}) {
    const context=this.#capture();
    if(!this.#localSandbox ||
        !/^0x[0-9a-f]{40}$/.test(account))fail('SIGN_LOCAL');
    if(offer){
      offer=structuredClone(offer);
      if(offer.account!==account || !fingerprint || offerFingerprint(offer)!==fingerprint)fail('HANDOVER_FINGERPRINT');
    }
    return this.#exclusive(async()=>{
      const {record,payload}=await this.#load(context);
      if(record.chainId!==31337||record.mode!=='active')fail('RECOVERY');
      const observe=async()=>{
        const state=await readHandoverState(endpoint,account);this.#check(context);
        if(offer)checkSource(offer,state);
        return state;
      };
      const state=await observe();
      if(state.epoch!==1||/^0x0+$/.test(state.root))fail('HANDOVER_STALE');
      const worker=new ProofWorkerClient(new URL('./local-handover-worker.js',import.meta.url));
      this.#handoverWorker=worker;
      let committed=false;
      try{
        if(!offer){
          const previous=payload.handoverOffer;
          if(previous && previous.deadline>=state.timestamp){
            checkSource(previous,state);return {...previous};
          }
          const result=await worker.request('offer',{record,key:context.key,state});
          checkSource(result,await observe());
          payload.handoverOffer=result;
          const updated=await encryptPayload(payload,context.key,{...record,revision:record.revision+1});
          this.#check(context);await this.store.compareAndSwap(record,updated);this.#check(context);
          this.#remember(updated);this.#revision=updated.revision;this.#setDetails(updated,payload);
          return {...result};
        }
        const binding=this.accountCheck;
        if(!binding?.matched||binding.account!==account||!keyStateEqual(binding.snapshot,state))fail('NET_KEYS');
        if(payload.journal.some(r=>r.root===offer.newRoot.slice(2) ||
          (r.root===offer.oldRoot.slice(2)&&r.pubSeed===offer.oldSeed.slice(2)&&r.leaf>=EXEC_LIMIT)))fail('HANDOVER_SPENT');
        if(payload.journal.length>=MAX_RESERVATIONS)fail('FULL');
        const message=rotationMessage(offer);
        const row=validateReservation({chainId:31337,account,epoch:1,pubSeed:offer.oldSeed.slice(2),
          root:offer.oldRoot.slice(2),leaf:EXEC_LIMIT,digest:message.digest});
        payload.journal.push(row);
        const updated=await encryptPayload(payload,context.key,{...record,revision:record.revision+1});
        await observe();await this.store.compareAndSwap(record,updated);committed=true;this.#check(context);
        this.#remember(updated);this.#revision=updated.revision;this.#setDetails(updated,payload);
        const data=await worker.request('rotate',{record:updated,key:context.key,offer,message});
        this.#check(context);
        return await sendLocalRotation(endpoint,offer,data,()=>this.#check(context));
      }catch(error){
        if(committed)fail('HANDOVER_CHECK_RECEIPT');
        throw error;
      }finally{worker.dispose();if(this.#handoverWorker===worker)this.#handoverWorker=undefined;}
    });
  }
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
  async #saveInbound(context,record,payload){
    const updated=await encryptPayload(payload,context.key,{...record,revision:record.revision+1});
    this.#check(context);await this.store.compareAndSwap(record,updated);this.#check(context);
    this.#remember(updated);this.#revision=updated.revision;this.#setDetails(updated,payload);
  }
  async prepareTestnetHandover(account){
    const context=this.#capture();
    if(typeof account!=='string'||!/^0x[0-9a-f]{40}$/.test(account))fail('NET_ACCOUNT');
    return this.#exclusive(async()=>{
      const {record,payload}=await this.#load(context);
      if(record.chainId!==97 || record.mode!=='active')fail('RECOVERY');
      if(payload.inboundOffer){
        if(payload.inboundOffer.account!==account)fail('HANDOVER_FRESH');
        return {...payload.inboundOffer};
      }
      if(payload.journal.length)fail('HANDOVER_FRESH');
      const state=await this.recoveryReader({account,tag:'finalized'});this.#check(context);
      if(state.epoch<1 || state.epoch>=0xffffffff)fail('HANDOVER_OFFER');
      const worker=this.bindingWorkerFactory();this.#handoverWorker=worker;
      try{
        const derive=snapshot=>worker.request('check',{record,key:context.key,snapshot});
        const old=await derive(state);this.#check(context);
        if(validateDerivedRoot(old,record,state).root===state.root)fail('HANDOVER_FRESH');
        const next={...state,epoch:state.epoch+1,pubSeed:'0x'+hex(crypto.getRandomValues(new Uint8Array(16)))};
        const derived=await derive(next);this.#check(context);
        validateDerivedRoot(derived,record,next);
        const offer=validateTestnetOffer({format:'aurven-testnet-handover-v1',chainId:97,account,epoch:state.epoch,
          oldSeed:state.pubSeed,oldRoot:state.root,newSeed:next.pubSeed,newRoot:derived.root,deadline:state.timestamp+1800});
        payload.inboundOffer=offer;
        await this.#saveInbound(context,record,payload);
        return {...offer};
      }finally{worker.dispose();if(this.#handoverWorker===worker)this.#handoverWorker=undefined;}
    });
  }
  async acceptTestnetHandover(publicRecord,hash){
    const context=this.#capture(),receipt=validateRotationRecord(structuredClone(publicRecord));
    return this.#exclusive(async()=>{
      const {record,payload}=await this.#load(context);
      if(record.chainId!==97 || record.mode!=='active')fail('RECOVERY');
      matchOffer(payload.inboundOffer,receipt);
      const result=await recoverTestnetRotation(receipt,{txHash:hash});
      this.#check(context);
      if(['continue','not-found'].includes(result.status))fail('HANDOVER_SEARCH');
      if(result.status!=='current' || result.root!==payload.inboundOffer.newRoot ||
         result.epoch!==payload.inboundOffer.epoch+1)fail('HANDOVER_PENDING');
      if(payload.inboundHash && payload.inboundHash!==result.hash)fail('HANDOVER_RECEIPT');
      if(!payload.inboundHash){
        payload.inboundHash=result.hash;
        await this.#saveInbound(context,record,payload);
      }
      return result;
    });
  }
  async authorizeNetworkAction(input,progress) {
    const context=this.#capture(),plan=structuredClone(input);
    validateNetworkPlan(plan);
    if (context.id!==plan.walletId) fail('NET_KEYS');
    const fresh=async()=>{
      this.#check(context);validateNetworkPlan(plan);
      await this.networkPreflight(plan);
      this.#check(context);
    };
    return this.#exclusive(async()=>{
      const {record,payload}=await this.#load(context);
      if (record.mode!=='active' || record.chainId!==97) fail('RECOVERY');
      if (payload.journal.length>=MAX_RESERVATIONS) fail('FULL');
      await fresh();
      if(plan.offer && payload.journal.some(row=>row.root===plan.offer.oldRoot.slice(2) && row.leaf>=EXEC_LIMIT))fail('HANDOVER_RETIRED');
      const inbound=payload.inboundOffer;
      const checkInbound=async()=>{
        if(!inbound || inbound.account!==plan.account)return;
        if(!payload.inboundHash || !plan.snapshot || plan.snapshot.epoch<=inbound.epoch)fail('HANDOVER_PENDING');
        const state=await this.recoveryReader({account:plan.account,tag:'finalized'});this.#check(context);
        if(!keyStateEqual(state,plan.snapshot) || (state.epoch===inbound.epoch+1 &&
          (state.root!==inbound.newRoot || state.pubSeed!==inbound.newSeed)))fail('HANDOVER_PENDING');
      };
      await checkInbound();
      const leaf=spendingLeaf(plan,payload.journal),worker=this.networkWorkerFactory();
      this.#networkWorker=worker;
      let reserved=false;
      try {
        const intent=await worker.request('prepare',{record,key:context.key,plan,leaf},progress);
        this.#check(context);validateIntent(plan,intent,leaf);
        const row=validateReservation({chainId:97,account:plan.account,epoch:plan.snapshot?.epoch??0,
          pubSeed:intent.seed,root:intent.root,leaf,digest:intent.digest,...(plan.offer?{handoverOut:true}:{})});
        if (payload.journal.some(entry=>reservationId(entry)===reservationId(row))) fail('USED');
        if (intent.newRoot && payload.journal.some(entry=>entry.root===intent.newRoot)) fail('NET_KEYS');
        await fresh();await checkInbound();
        payload.journal.push(row);
        const updated=await encryptPayload(payload,context.key,{...record,revision:record.revision+1});
        this.#check(context);await this.store.compareAndSwap(record,updated);reserved=true;this.#check(context);
        this.#remember(updated);this.#revision=updated.revision;this.#setDetails(updated,payload);
        const proof=await worker.request('sign',{digest:row.digest});
        try {
          let init;
          if (setup(plan.kind)) {
            const response=await fetch(new URL('./assets/vault-setup-init.json',import.meta.url),{redirect:'error'});
            if (!response.ok) fail('NET_PROOF');
            init=await response.json();
          }
          await fresh();await checkInbound();
          return {data:encodeNetworkAction(plan,intent,proof,init),intent};
        } finally {proof.fill(0);}
      } catch (error) {
        if (reserved) error.leafReserved=true;
        throw error;
      } finally {worker.dispose();if (this.#networkWorker===worker) this.#networkWorker=undefined;}
    });
  }
  async suggestedTransferLeaf(snapshot) {
    const binding = this.accountCheck;
    if (!binding?.matched || this.#details.mode !== 'active' || binding.chainId !== snapshot.chainId ||
        binding.account !== snapshot.account.toLowerCase() || binding.snapshot.epoch !== snapshot.epoch ||
        binding.derivedRoot !== snapshot.root || binding.derivedPubSeed !== snapshot.pubSeed) return snapshot.next;
    const state = validateKeySnapshot(snapshot,binding.chainId,binding.account);
    const context = this.#capture();
    return this.#exclusive(async () => {
      const {payload} = await this.#load(context);
      return nextTransferLeaf(state,payload.journal);
    });
  }
  async #checkHandoverReceipt(state,endpoint,offer) {
    if(!this.#localSandbox || state.epoch<2)return;
    if(!offer)fail('HANDOVER_RECEIPT');
    if(offer.account!==state.account || state.chainId!==31337 || state.epoch!==2 ||
      offer.newSeed!==state.pubSeed || offer.newRoot!==state.root)fail('HANDOVER_RECEIPT');
    await confirmLocalHandover(endpoint,offer);
  }
  async reviewTransferDraft(input, endpoint, signal) {
    this.#reviewTicket = undefined;
    return this.#checkTransferDraft(input,endpoint,signal);
  }
  async reserveTransferDraft(input, endpoint, reviewed, signal) {
    if (!reviewed || reviewed !== this.#reviewTicket || reviewed.digest !== input?.digest) fail('DRAFT_REVIEW');
    this.#reviewTicket = undefined;
    return this.#checkTransferDraft(input,endpoint,signal,reviewed);
  }
  async #checkTransferDraft(input, endpoint, signal, reviewed) {
    const context = this.#capture();
    const draft = structuredClone(input);
    validateReviewDraft(draft);
    if (this.#details.mode !== 'active') fail('RECOVERY');
    const binding = this.#bindingResult;
    const account = draft.account.toLowerCase();
    if (!binding?.matched || binding.account !== account || binding.chainId !== draft.chainId ||
        binding.walletId !== context.id || this.#details.chainId !== draft.chainId) fail('DRAFT_KEYS');
    const current = () => {
      this.#check(context);
      if (signal?.aborted || binding !== this.#bindingResult) fail('CANCELED');
    };
    current();
    const raw = await this.accountReader({endpoint, account, chainId: draft.chainId, signal});
    current();
    return this.#exclusive(async () => {
      try {
        const {record,payload} = await this.#load(context);
        current();
        if (record.mode !== 'active') fail('RECOVERY');
        if (payload.journal.length >= MAX_RESERVATIONS) fail('FULL');
        const state = validateKeySnapshot(raw,draft.chainId,account);
        compareDraftState(draft,{...state,balanceWei:raw.balanceWei},binding,payload.journal,reviewed);
        await this.#checkHandoverReceipt(state,endpoint,payload.handoverOffer);current();
        const report = Object.freeze({digest:draft.digest, leaf:draft.leaf, blockNumber:state.blockNumber, blockHash:state.blockHash});
        if (!reviewed) {
          this.#reviewTicket = report;
          return report;
        }
        payload.journal.push(validateReservation({chainId:draft.chainId, account, epoch:state.epoch,
          pubSeed:state.pubSeed.slice(2), root:state.root.slice(2), leaf:draft.leaf, digest:draft.digest}));
        const updated = await encryptPayload(payload,context.key,{...record,revision:record.revision+1});
        current();
        await this.store.compareAndSwap(record,updated);
        // A completed write stays consumed even if the caller canceled during the transaction.
        this.#check(context);
        this.#remember(updated);
        this.#revision = updated.revision;
        this.#setDetails(updated,payload);
        current();
        const receipt = Object.freeze({...report,revision:updated.revision});
        const local = localSimulationEndpoint(endpoint,draft.chainId);
        this.#reserved = local ? {receipt,draft,binding,endpoint:local} : undefined;
        return receipt;
      } catch (error) {
        if (!(error instanceof VaultError) || ['AUTH_FAILED','FORMAT','MISSING','ROLLBACK','STORAGE','CONFLICT','UNSUPPORTED'].includes(error.code)) this.lock('storage');
        throw error;
      }
    });
  }
  async simulateReservedTransfer(receipt, signal) {
    const context = this.#capture();
    const reserved = this.#reserved;
    if (!reserved || receipt !== reserved.receipt) fail('SIGN_RESERVATION');
    if (this.#simulationAbort) fail('BUSY');
    this.#reserved = undefined;
    const {draft,binding,endpoint} = reserved;
    const controller = new AbortController();
    this.#simulationAbort = controller;
    const cancel = signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
    const current = () => {
      this.#check(context);
      if (cancel.aborted || binding !== this.#bindingResult) fail('CANCELED');
    };
    const readState = async observation => {
      current();
      const raw = await this.accountReader({endpoint,account:binding.account,chainId:31337,signal:cancel});
      current();
      const state = validateKeySnapshot(raw,31337,binding.account);
      compareDraftAccount(draft,{...state,balanceWei:raw.balanceWei},binding,observation);
      return state;
    };
    let worker, proof;
    const stopWorker = () => worker?.dispose();
    try {
      validateReviewDraft(draft);
      const before = await readState(receipt);
      return await this.#exclusive(async () => {
        const {record,payload} = await this.#load(context);
        current();
        if (record.mode !== 'active' || record.chainId !== 31337) fail('SIGN_LOCAL');
        const row = reservedRow(payload.journal,draft);
        if (row.simulationAttempt) fail('SIGN_RESERVATION');
        await this.#checkHandoverReceipt(before,endpoint,payload.handoverOffer);current();
        row.simulationAttempt = true;
        const updated = await encryptPayload(payload,context.key,{...record,revision:record.revision+1});
        current();
        await this.store.compareAndSwap(record,updated);
        this.#remember(updated);
        this.#check(context);
        this.#revision=updated.revision;
        this.#setDetails(updated,payload);
        current();
        worker = this.transferWorkerFactory();
        cancel.addEventListener('abort',stopWorker,{once:true});
        proof = await worker.request('sign-local',{record:updated,key:context.key,draft});
        current();
        const after = await readState(before);
        await this.#checkHandoverReceipt(after,endpoint,payload.handoverOffer);
        current();
        const result = await simulateLocalProof(endpoint,draft,after,proof,cancel);
        current();
        return result;
      });
    } catch (error) {
      if (['AUTH_FAILED','FORMAT','MISSING','ROLLBACK','STORAGE','CONFLICT'].includes(error.code)) this.lock('storage');
      throw error;
    } finally {
      cancel.removeEventListener('abort',stopWorker);
      worker?.dispose();
      if (proof instanceof Uint8Array) proof.fill(0);
      if (this.#simulationAbort === controller) this.#simulationAbort = undefined;
    }
  }
  cancelAccountCheck(){
    this.#reserved=undefined;
    this.#simulationAbort?.abort();
    this.#reviewTicket=undefined;
    this.#bindingGeneration++;this.#bindingAbort?.abort();this.#bindingAbort=undefined;
    this.#bindingWorker?.dispose();this.#bindingWorker=undefined;this.#bindingResult=undefined;
  }
  async checkAccountKeys({endpoint,account,fromBackup=false},progress){
    const context=this.#capture();
    if(this.#bindingAbort)fail('BUSY');
    this.#reserved=undefined;
    this.#simulationAbort?.abort();
    this.#reviewTicket=undefined;
    this.#bindingResult=undefined;
    account=typeof account==='string'?account.trim().toLowerCase():'';
    if(!/^0x[0-9a-f]{40}$/.test(account))fail('KEY_CONTEXT');
    const generation=this.#bindingGeneration,controller=new AbortController();this.#bindingAbort=controller;
    const stillCurrent=()=>{this.#check(context);if(generation!==this.#bindingGeneration)fail('CANCELED');};
    let worker;
    try{
      const {record}=await this.#load(context);stillCurrent();
      if(fromBackup && (record.mode!=='recovery-readonly'||record.chainId!==97))fail('KEY_CONTEXT');
      const read=async()=>{
        const reader=fromBackup ? this.recoveryReader : this.accountReader;
        const raw=await reader({endpoint,account,chainId:record.chainId,signal:controller.signal});
        const snapshot=validateKeySnapshot(raw,record.chainId,account);
        if(fromBackup){
          if(typeof raw.balanceWei!=='string'||!/^(0|[1-9][0-9]{0,77})$/.test(raw.balanceWei))fail('KEY_CONTEXT');
          snapshot.balanceWei=raw.balanceWei;
        }
        return snapshot;
      };
      const before=await read();stillCurrent();
      worker=this.bindingWorkerFactory();this.#bindingWorker=worker;
      const derived=validateDerivedRoot(await worker.request('check',{record,key:context.key,snapshot:before},progress),record,before);
      stillCurrent();
      const after=await read();stillCurrent();
      if(!keyStateEqual(before,after))fail('ACCOUNT_CHANGED');
      if(fromBackup && (BigInt(after.blockNumber)<BigInt(before.blockNumber) ||
        (after.blockNumber===before.blockNumber && (after.blockHash!==before.blockHash ||
          after.balanceWei!==before.balanceWei))))fail('ACCOUNT_CHANGED');
      const latest=await this.#load(context);stillCurrent();
      if(latest.record.chainId!==record.chainId||latest.record.mode!==record.mode)fail('KEY_CONTEXT');
      this.#bindingResult={format:'aurven-account-root-check-v1',walletId:record.walletId,chainId:record.chainId,
        account,mode:record.mode,matched:derived.pubSeed===after.pubSeed&&derived.root===after.root,
        purpose:'local-root-comparison-only',derivedPubSeed:derived.pubSeed,derivedRoot:derived.root,
        snapshot:after,checkedAt:Date.now()};
      if(fromBackup)this.#bindingResult.backupReview=recoveryJournalReview(latest.payload.journal,after);
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
