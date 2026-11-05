import {readFileSync, writeFileSync} from 'node:fs';

const artifact = name => JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url)));
const factory = artifact('KeyLabFactory');
const account = artifact('KeyLabAccount');
const codes = {
  FACTORY_INIT: factory.bytecode.object,
  FACTORY_RUNTIME: factory.deployedBytecode.object,
  ACCOUNT_INIT: account.bytecode.object,
  ACCOUNT_RUNTIME: account.deployedBytecode.object
};
const moduleText = Object.entries(codes).map(([key, code]) =>
  `export const ${key} = ${JSON.stringify(code.replace(/^0x/, ''))};`).join('\n');
writeFileSync(new URL('../ui/lib/evmcode.js', import.meta.url), moduleText + '\n');
console.log('Updated client bytecode from compiled Key Lab contracts');
