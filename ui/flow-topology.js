// Logical roles in this prototype. "network" depicts on-chain execution,
// not a second custodian or a recipient of the transfer principal.
export const FLOW_NODES={
  signer:{label:'签名端',detail:'生成绑定网络、账户、收款人与金额的授权证明，交给 Gas 付款账户提交。签名本身不移动资金。'},
  payer:{label:'Gas 付款账户',detail:'接收已签名的授权，提交交易并支付 Gas，随后接收网络回执。手续费来自这个账户，与转账本金分开。'},
  network:{label:'网络执行',detail:'BSC 在同一笔交易中运行智能账户合约：先验证授权，再执行转账，最后返回回执。这里表示执行过程，不是另一个收款地址。'},
  account:{label:'智能账户',detail:'由网络运行它的合约代码，核对证明、有效期和叶号。验证通过后，从账户余额向收款端转出本金。'},
  recipient:{label:'收款端',detail:'接收智能账户转出的本金。收款端不接收授权证明，也不接收本次 Gas 费用。'}
};
export const FLOW_LINKS=[
  {id:'authorization',from:'signer',to:'payer',kind:'proof',label:'交付授权证明'},
  {id:'submission',from:'payer',to:'network',kind:'proof',label:'提交交易'},
  {id:'gas',from:'payer',to:'network',kind:'gas',label:'支付 Gas'},
  {id:'invoke',from:'network',to:'account',kind:'proof',label:'运行账户合约'},
  {id:'asset',from:'account',to:'recipient',kind:'asset',label:'转移本金'},
  {id:'receipt',from:'network',to:'payer',kind:'receipt',label:'返回执行回执'}
];
export const connectionsFor=id=>FLOW_LINKS.filter(link=>link.from===id||link.to===id);
