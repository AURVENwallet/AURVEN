// Copy both i18n-checks files into ignored ui/demo/ and serve ui/ on loopback.
const output=document.querySelector('#results'),message=document.querySelector('#message');
const assert=(condition,text)=>{if(!condition)throw new Error(text);};
const settle=()=>new Promise(resolve=>requestAnimationFrame(resolve));
document.querySelector('#run').onclick=async()=>{
  output.textContent='Running…\n';
  try{
    document.querySelector('[data-language="en"]').click();await settle();
    assert(message.placeholder==='Enter a test message without private information','Textarea placeholder was not translated');
    assert(message.title==='Test message'&&message.getAttribute('aria-label')==='Test message','Accessible textarea labels were not translated');
    output.textContent+='PASS English textarea placeholder and accessible labels\n';
    assert(message.value==='测试消息'&&message.defaultValue==='测试消息','Textarea message was changed');
    assert(document.querySelector('#input').value==='测试消息'&&document.querySelector('#signed').textContent==='测试消息','Input or signed message was translated');
    output.textContent+='PASS User input, default text and signed content remain unchanged\n';
    message.setAttribute('placeholder','测试消息');await settle();assert(message.placeholder==='Test message','Dynamic placeholder was not translated');
    document.querySelector('[data-language="zh-CN"]').click();await settle();assert(message.placeholder==='测试消息','Chinese source not restored');
    document.querySelector('[data-language="en"]').click();await settle();assert(message.placeholder==='Test message'&&message.value==='测试消息','Round-trip changed input');
    output.textContent+='PASS Dynamic hints and language round-trip\nALL 3 CHECKS PASSED\n';
  }catch(error){output.textContent+='FAIL '+error.message+'\n';}
};
