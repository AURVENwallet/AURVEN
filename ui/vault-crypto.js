// Experimental test-only storage. Web Crypto supplies the encryption primitives.
export const FORMAT='aurven-test-vault-v1';
export const ITERATIONS=600000;
export const MAX_BACKUP_BYTES=1024*1024;
export const MAX_RESERVATIONS=1024;
const enc=new TextEncoder(),dec=new TextDecoder('utf-8',{fatal:true});
export class VaultError extends Error {
  constructor(code){super(code);this.name='VaultError';this.code=code;}
}
export const fail=code=>{throw new VaultError(code);};
export const hex=bytes=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
const isHex=(value,length)=>typeof value==='string'&&value.length===length&&/^[0-9a-f]+$/.test(value);
const unhex=value=>Uint8Array.from(value.match(/../g),v=>parseInt(v,16));
const keys=(value,names)=>value&&typeof value==='object'&&!Array.isArray(value)&&
  Object.keys(value).sort().join('|')===[...names].sort().join('|');
const random=length=>crypto.getRandomValues(new Uint8Array(length));
export function validatePassword(value,{creating=false}={}){
  if(typeof value!=='string'||!value.length||enc.encode(value).length>1024)fail('PASSWORD');
  if(creating&&([...value].length<12||!value.trim()))fail('PASSWORD');
}
export function validateEnvelope(record){
  if(!keys(record,['format','testOnly','walletId','chainId','createdAt','revision','mode','kdf','cipher']))fail('FORMAT');
  if(record.format!==FORMAT||record.testOnly!==true||!isHex(record.walletId,32)||
    ![97,31337].includes(record.chainId)||!Number.isSafeInteger(record.createdAt)||record.createdAt<=0||
    !Number.isSafeInteger(record.revision)||record.revision<0||record.revision>2147483647||
    !['active','recovery-readonly'].includes(record.mode))fail('FORMAT');
  if(!keys(record.kdf,['name','hash','iterations','salt'])||record.kdf.name!=='PBKDF2'||
    record.kdf.hash!=='SHA-256'||record.kdf.iterations!==ITERATIONS||!isHex(record.kdf.salt,32))fail('FORMAT');
  if(!keys(record.cipher,['name','iv','data'])||record.cipher.name!=='AES-256-GCM'||!isHex(record.cipher.iv,24)||
    typeof record.cipher.data!=='string'||record.cipher.data.length<32||record.cipher.data.length>MAX_BACKUP_BYTES-2048||
    record.cipher.data.length%2||!/^[0-9a-f]+$/.test(record.cipher.data))fail('FORMAT');
  return record;
}
export function parseBackup(text){
  if(typeof text!=='string'||text.length>MAX_BACKUP_BYTES||enc.encode(text).length>MAX_BACKUP_BYTES)fail('FORMAT');
  try{return validateEnvelope(JSON.parse(text));}catch{fail('FORMAT');}
}
export function validateReservation(row){
  const fields=['chainId','account','epoch','pubSeed','root','leaf','digest'];
  if(row && Object.hasOwn(row,'handoverOut')){
    fields.push('handoverOut');
    if(row.handoverOut!==true || row.chainId!==97 || row.epoch<1 || row.leaf<960)fail('RESERVATION');
  }
  if(row && Object.hasOwn(row,'commitment')){
    fields.push('commitment');
    const c=row.commitment;
    if(!row.handoverOut || !keys(c,['binding','salt','rnd']) || typeof c.binding!=='string' ||
      !/^0x[0-9a-f]{64}$/.test(c.binding) || !isHex(c.rnd,32) ||
      !Number.isInteger(c.salt) || c.salt<0 || c.salt>0xffffffff)fail('RESERVATION');
  }
  if(row && Object.hasOwn(row,'simulationAttempt')){
    fields.push('simulationAttempt');
    if(row.simulationAttempt!==true || row.chainId!==31337 || row.epoch<1 || row.leaf>=960)fail('RESERVATION');
  }
  if(!keys(row,fields)||
    ![97,31337].includes(row.chainId)||typeof row.account!=='string'||!/^0x[0-9a-f]{40}$/.test(row.account)||
    !Number.isInteger(row.epoch)||row.epoch<0||row.epoch>4294967295||
    !Number.isInteger(row.leaf)||row.leaf<0||row.leaf>=1024||
    !isHex(row.pubSeed,32)||!isHex(row.root,32)||!isHex(row.digest,32))fail('RESERVATION');
  return row;
}
// Deliberately exclude account/epoch from uniqueness: moving the same key to a
// different context must never make that one-time key reusable.
export const reservationId=row=>row.pubSeed+':'+row.root+':'+row.leaf;
export const handoverFields=Object.freeze(['format','chainId','account','epoch','oldSeed','oldRoot','newSeed','newRoot','deadline']);
export function validateOffer(offer) {
  if(offer?.format!=='aurven-local-handover-v1' || offer.chainId!==31337 || offer.epoch!==1)fail('HANDOVER_OFFER');
  return validateOfferFields(offer);
}
export function validateTestnetOffer(offer){
  if(offer?.format!=='aurven-testnet-handover-v1' || offer.chainId!==97 || !Number.isInteger(offer.epoch) ||
    offer.epoch<1 || offer.epoch>=0xffffffff)fail('HANDOVER_OFFER');
  return validateOfferFields(offer);
}
function validateOfferFields(offer){
  if(!keys(offer,handoverFields) ||
    typeof offer.account!=='string'||!/^0x[0-9a-f]{40}$/.test(offer.account) || !Number.isSafeInteger(offer.deadline) || offer.deadline<=0 ||
    !['oldSeed','oldRoot','newSeed','newRoot'].every(k=>typeof offer[k]==='string'&&/^0x[0-9a-f]{32}$/.test(offer[k])&&!/^0x0+$/.test(offer[k])) ||
    offer.oldSeed===offer.newSeed || offer.oldRoot===offer.newRoot)fail('HANDOVER_OFFER');
  return offer;
}
function validatePayload(value,record){
  const fields=['seed','journal'];
  if(value && Object.hasOwn(value,'handoverOffer')){
    fields.push('handoverOffer');
    if(record.chainId!==31337)fail('FORMAT');
    validateOffer(value.handoverOffer);
  }
  if(value && Object.hasOwn(value,'inboundOffer')){
    fields.push('inboundOffer');
    if(record.chainId!==97)fail('FORMAT');
    validateTestnetOffer(value.inboundOffer);
    if(Object.hasOwn(value,'inboundHash')){
      fields.push('inboundHash');
      if(typeof value.inboundHash!=='string'||!/^0x[0-9a-f]{64}$/.test(value.inboundHash))fail('FORMAT');
    }
  }
  if(!keys(value,fields)||!isHex(value.seed,64)||!Array.isArray(value.journal)||value.journal.length>MAX_RESERVATIONS)fail('FORMAT');
  const seen=new Set();
  for(const row of value.journal){
    validateReservation(row);
    if(row.chainId!==record.chainId||seen.has(reservationId(row)))fail('FORMAT');
    seen.add(reservationId(row));
  }
  return value;
}
function aad(record){
  return enc.encode(JSON.stringify([record.format,record.testOnly,record.walletId,record.chainId,
    record.createdAt,record.revision,record.mode,record.kdf.name,record.kdf.hash,record.kdf.iterations,
    record.kdf.salt,record.cipher.name,record.cipher.iv]));
}
export async function deriveVaultKey(password,salt){
  validatePassword(password);
  if(!isHex(salt,32))fail('FORMAT');
  const bytes=enc.encode(password);
  try{
    const material=await crypto.subtle.importKey('raw',bytes,'PBKDF2',false,['deriveKey']);
    return await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:unhex(salt),iterations:ITERATIONS},
      material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }finally{bytes.fill(0);}
}
export async function encryptPayload(payload,key,metadata){
  const record={...metadata,kdf:{...metadata.kdf},cipher:{name:'AES-256-GCM',iv:hex(random(12)),data:'00'.repeat(16)}};
  validateEnvelope(record);validatePayload(payload,record);
  const plain=enc.encode(JSON.stringify(payload));
  try{
    const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:unhex(record.cipher.iv),additionalData:aad(record),tagLength:128},key,plain);
    record.cipher.data=hex(new Uint8Array(encrypted));
    return validateEnvelope(record);
  }finally{plain.fill(0);}
}
export async function decryptPayload(record,key){
  validateEnvelope(record);
  let plain;
  try{
    plain=new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:unhex(record.cipher.iv),additionalData:aad(record),tagLength:128},key,unhex(record.cipher.data)));
    return validatePayload(JSON.parse(dec.decode(plain)),record);
  }catch{fail('AUTH_FAILED');}finally{plain?.fill(0);}
}
export async function createEnvelope(password,chainId){
  validatePassword(password,{creating:true});
  if(![97,31337].includes(chainId))fail('NETWORK');
  const metadata={format:FORMAT,testOnly:true,walletId:hex(random(16)),chainId,createdAt:Date.now(),revision:0,mode:'active',
    kdf:{name:'PBKDF2',hash:'SHA-256',iterations:ITERATIONS,salt:hex(random(16))}};
  const key=await deriveVaultKey(password,metadata.kdf.salt),seed=random(32);
  try{return {record:await encryptPayload({seed:hex(seed),journal:[]},key,metadata),key};}
  finally{seed.fill(0);}
}
