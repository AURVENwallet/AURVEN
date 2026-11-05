const contractAddress='0x8614876e509c18d7be305a39a4a8d9e69c5effff';
async function copyAddress(){
  try{
    await navigator.clipboard.writeText(contractAddress);
    return;
  }catch{
    const previousFocus=document.activeElement;
    const field=document.createElement('textarea');
    field.value=contractAddress;
    field.className='clipboard-helper';
    field.setAttribute('readonly','');
    document.body.append(field);
    field.select();
    try{
      if(!document.execCommand('copy'))throw new Error('Copy unavailable');
    }finally{
      field.remove();
      previousFocus?.focus({preventScroll:true});
    }
  }
}
document.querySelectorAll('[data-copy-ca]').forEach(button=>{
  button.addEventListener('click',async()=>{
    const status=button.closest('.token-section').querySelector('[data-copy-status]');
    try{
      await copyAddress();
      status.textContent='合约地址已复制';
    }catch{
      status.textContent='无法自动复制，请选中上方完整地址手动复制。';
    }
  });
});
