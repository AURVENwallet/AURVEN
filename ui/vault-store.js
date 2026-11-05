import {VaultError,fail} from './vault-crypto.js';
export const VAULT_DB='aurven-test-vault-v1';
export async function openVaultStore(name=VAULT_DB){
  if(!globalThis.indexedDB||!/^[a-z0-9-]{1,100}$/.test(name))fail('UNSUPPORTED');
  const db=await new Promise((resolve,reject)=>{
    const request=indexedDB.open(name,1);
    let failed=false;
    request.onupgradeneeded=()=>request.result.createObjectStore('records');
    request.onerror=()=>reject(new VaultError('STORAGE'));
    request.onblocked=()=>{failed=true;reject(new VaultError('STORAGE'));};
    request.onsuccess=()=>{if(failed){request.result.close();return;}resolve(request.result);};
  });
  db.onversionchange=()=>db.close();
  function transaction(mode,operation){
    return new Promise((resolve,reject)=>{
      let tx,result,problem;
      try{
        tx=db.transaction('records',mode,mode==='readwrite'?{durability:'strict'}:undefined);
        tx.oncomplete=()=>resolve(result);
        tx.onabort=()=>reject(problem??new VaultError('STORAGE'));
        tx.onerror=()=>{}; // The abort event is the only failure completion path.
        if(mode==='readwrite'&&tx.durability!=='strict'){
          problem=new VaultError('UNSUPPORTED');tx.abort();return;
        }
        operation(tx.objectStore('records'),value=>{result=value;},code=>{
          problem=new VaultError(code);tx.abort();
        });
      }catch{if(tx){problem=new VaultError('STORAGE');try{tx.abort();}catch{reject(problem);}}else reject(new VaultError('STORAGE'));}
    });
  }
  return {
    name,
    read:()=>transaction('readonly',(store,done)=>{
      const request=store.get('primary');request.onsuccess=()=>done(request.result??null);
    }),
    create:record=>transaction('readwrite',(store,done,abort)=>{
      const request=store.get('primary');request.onsuccess=()=>{
        if(request.result){abort('EXISTS');return;}
        store.add(record,'primary');done(record);
      };
    }),
    compareAndSwap:(expected,updated)=>transaction('readwrite',(store,done,abort)=>{
      const request=store.get('primary');request.onsuccess=()=>{
        if(JSON.stringify(request.result)!==JSON.stringify(expected)){abort('CONFLICT');return;}
        store.put(updated,'primary');done(updated);
      };
    }),
    close:()=>db.close()
  };
}
