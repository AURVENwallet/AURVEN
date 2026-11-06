import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {pinnedRuntime,startLocalNode} from './local-wallet-chain.mjs';

const repo = fileURLToPath(new URL('../',import.meta.url));
const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css',
  '.png':'image/png','.svg':'image/svg+xml','.woff2':'font/woff2'};
const asset = /^\/(?:(?:assets|lib)\/|vendor\/three\/(?:addons\/[a-z]+\/)?)?[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(?:js|css|html|png|svg|woff2)$/;

export async function startLocalWallet() {
  const runtime = await pinnedRuntime();
  const ui = await realpath(path.join(repo,'ui'));
  const session = randomBytes(16).toString('hex');
  let origin,fixture,node;
  const server = createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cross-Origin-Resource-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"frame-ancestors 'none'; object-src 'none'; base-uri 'none'");
    if (!origin || req.headers.host !== new URL(origin).host) {res.writeHead(403).end();return;}
    if (!fixture) {res.writeHead(503).end();return;}
    try {
      const pathname = new URL(req.url,origin).pathname;
      if (pathname==='/local/pair' && req.method==='POST') {
        if (req.headers.origin!==origin || req.headers['x-aurven-session']!==session) {res.writeHead(403).end();return;}
        if (req.headers['content-type']!=='text/plain') {res.writeHead(415).end();return;}
        let bytes=0, text='';
        for await (const chunk of req) {
          bytes+=chunk.length;
          if (bytes>34) {res.writeHead(413).end();return;}
          text+=chunk.toString('utf8');
        }
        if (!/^0x[0-9a-f]{32}$/.test(text) || /^0x0+$/.test(text)) {res.writeHead(400).end();return;}
        try {await fixture.pair(text);} catch {res.writeHead(409).end();return;}
        res.writeHead(204).end();return;
      }
      if (req.method!=='GET') {res.writeHead(405).end();return;}
      if (pathname==='/') {res.writeHead(302,{Location:'/wallet.html'}).end();return;}
      if (pathname==='/local/session.json') {
        const {account,endpoint,recipient}=fixture;
        res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({account,endpoint,recipient}));return;
      }
      if (pathname==='/local/setup.js') {
        res.writeHead(200,{'Content-Type':types['.js']}).end(await readFile(new URL('./local-wallet-setup.js',import.meta.url)));return;
      }
      if (!asset.test(pathname) && pathname!=='/assets/testnet-rotation-record.json') {res.writeHead(404).end();return;}
      const requested=path.join(ui,pathname.slice(1));
      const file=await realpath(requested);
      if (file!==requested || !file.startsWith(ui+path.sep)) {res.writeHead(404).end();return;}
      let content=await readFile(file);
      if (pathname==='/wallet.html') {
        content=content.toString('utf8').replace('</head>',
          '<meta name="aurven-local-session" content="'+session+'"><script type="module" src="/local/setup.js"></script></head>');
      }
      res.writeHead(200,{'Content-Type':types[path.extname(file)]??'application/json'}).end(content);
    } catch {if (!res.headersSent) res.writeHead(404);res.end();}
  });
  server.requestTimeout=15000;
  async function close() {
    const closed = new Promise(resolve=>server.close(resolve));
    server.closeAllConnections();
    await Promise.all([closed,node?.close()]);
  }
  try {
    await new Promise((resolve,reject)=>server.once('error',reject).listen(0,'127.0.0.1',resolve));
    origin='http://127.0.0.1:'+server.address().port;
    node=await startLocalNode(origin,3);
    node.stopped.then(()=>{server.close();server.closeAllConnections();});
    fixture=await node.setupAccount(runtime);
    return {url:origin+'/wallet.html',close};
  } catch (error) {await close();throw error;}
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
  try {
    console.log('Building and checking the local account contract...');
    execFileSync('forge',['build','--skip-lint','src/BscTestAccount.sol'],{cwd:repo,windowsHide:true,stdio:'inherit'});
    const lab=await startLocalWallet();
    console.log('\nOpen the disposable AURVEN wallet on this computer:\n'+lab.url+'\nPress Ctrl+C to stop the preview and its local chain.');
  } catch (error) {
    console.error('Local wallet startup failed. Check Node.js 22+, Foundry and the compiled account runtime. '+error.message);
    process.exitCode=1;
  }
}
