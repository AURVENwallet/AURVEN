import {execHasher, addressBytes} from "./lib/evmwots.js";

export function prepareTransfer({account, recipient, amount, chainId, epoch, leaf, deadline, randomizer}) {
  addressBytes(account);
  addressBytes(recipient);
  if (/^0x0{40}$/i.test(recipient)) throw new Error("收款地址不能为零地址");
  if (![97, 31337].includes(chainId)) throw new Error("仅支持测试网络");
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > 4294967295) throw new Error("换根代数须为 1 至 4294967295");
  if (!Number.isInteger(leaf) || leaf < 0 || leaf >= 960) throw new Error("交易叶号须为 0 至 959");
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/.test(amount)) throw new Error("金额须为最多 18 位小数的正数");
  const [whole, fraction=""] = amount.split(".");
  const value = BigInt(whole)*10n**18n+BigInt(fraction.padEnd(18,"0"));
  if (value <= 0n || value >= 2n**256n) throw new Error("金额超出范围");
  if (!Number.isSafeInteger(deadline) || deadline <= 0) throw new Error("无效截止时间");
  const digest=execHasher(randomizer,chainId,account,epoch,leaf,deadline,[{to:recipient,value,data:new Uint8Array()}])(0);
  return {chainId,account,recipient,valueWei:value.toString(),epoch,leaf,deadline,salt:0,randomizer:Array.from(randomizer,b=>b.toString(16).padStart(2,"0")).join(""),digest:Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("")};
}


