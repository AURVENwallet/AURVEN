const clamp=(x,min,max)=>Math.max(min,Math.min(max,x));
const phases=['准备授权','验证证明','执行转账','确认结果'];
const travel=(p,start,end)=>clamp((p-start)/(end-start),0,1)*1.5;

// One deterministic projection drives both the scene and all displayed balances.
// These amounts are simulation units; this module does not construct transactions.
export function projectFlow({progress=0,mode='success',amount=.12}={}) {
  const invalid=mode==='reject';
  const p=clamp(Number.isFinite(progress)?progress:0,0,invalid?.5:1);
  const cents=Math.round(clamp(Number.isFinite(amount)?amount:.12,.01,.5)*100);
  const rejected=invalid&&p>=.48;
  const transferPhase=invalid?0:clamp((p-.55)/.31,0,1);
  const transferred=transferPhase===1;
  const feePaid=p>=.48;
  const stage=rejected?1:p<.2?0:p<.52?1:p<.9?2:3;
  const receiptReady=invalid?p>=.5:p>=1;
  return {
    progress:p,stage,stageName:phases[stage],rejected,transferred,feePaid,
    gateOpen:!invalid&&p>=.52,transferPhase,
    authorizationPhase:travel(p,.02,.16),submissionPhase:travel(p,.16,.28),
    invokePhase:travel(p,.28,.40),gasPhase:clamp((p-.16)/.32,0,1),
    receiptPhase:invalid?travel(p,.48,.5):travel(p,.9,1),receiptReady,
    network:p<.16?'等待提交':p<.28?'交易送达网络':p<.48?'运行账户验证':rejected?(receiptReady?'失败回执已返回':'执行回滚'):
      p<.86?'运行账户转账':receiptReady?'成功回执已返回':p>=.9?'返回成功回执':'转账执行完成',
    accountCents:100-(transferred?cents:0),recipientCents:transferred?cents:0,
    payerUnits:100-(feePaid?1:0),amountCents:cents,
    proof:rejected?'验证拒绝':p>=.48?'验证通过':p>=.2?'正在核对':'待生成',
    assets:rejected?'本金留在账户':transferred?'已到账':p>=.55?'执行转账':'尚未转移'
  };
}
