import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
let cli;
try { cli = await import('../garuda.mjs'); } catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
const entry = resolve('garuda.mjs');
const temp = async (t) => { const p = await mkdtemp(join(tmpdir(),'garuda-cli-')); t.after(()=>rm(p,{recursive:true,force:true})); return p; };
const need = () => assert.ok(cli, 'GARUDA implementation has not been created yet');
const run = (args, env={}) => spawnSync(process.execPath,[entry,...args],{encoding:'utf8',env:{...process.env,...env}});

test('module exists',()=>need());
for (const version of ['v24.14.0','24.14.1','v24.99.0','v26.0.0','26.4.2']) test(`supported app Node ${version}`,()=>{need();assert.equal(cli.appNodeSupported(version),true);});
for (const version of ['v22.22.1','v24.13.9','v25.0.0','v27.0.0','v24.14.0-rc.1','bad']) test(`reject unsupported app Node ${version}`,()=>{need();assert.equal(cli.appNodeSupported(version),false);});
for (const url of ['http://localhost:8765','http://127.0.0.1:8765/']) test(`accept loopback ${url}`,()=>{need();assert.ok(cli.loopbackUrl(url));});
for (const url of ['https://127.0.0.1:8765','http://example.com','http://127.0.0.1:8765/mcp','http://x:y@localhost:8765','http://localhost:8765?token=abc','http://localhost:8765/#foo','http://0.0.0.0:8765','http://127.1:8765','http://localhost:0']) test(`reject unsafe endpoint ${url}`,()=>{need();assert.throws(()=>cli.loopbackUrl(url));});
test('numeric and boolean filters are typed',()=>{need();assert.deepEqual(cli.parseFilter('altitudeM:gt:10000'),{field:'altitudeM',op:'gt',value:10000});assert.equal(cli.parseFilter('onGround:eq:false').value,false);});
test('numeric-looking identities stay text',()=>{need();assert.equal(cli.parseFilter('callsign:eq:00123').value,'00123');assert.equal(cli.parseFilter('mmsi:eq:123456789').value,'123456789');});
test('colon in filter value preserved',()=>{need();assert.equal(cli.parseFilter('name:contains:A:B').value,'A:B');});
for (const f of ['altitudeM:gt:NaN','speedKts:lt:Infinity','unknown:eq:1','callsign:gt:2','onGround:eq:yes','altitudeM:contains:1','id:eq:A','altitudeM:regex:.*']) test(`bad filter ${f}`,()=>{need();assert.throws(()=>cli.parseFilter(f));});
test('query maps aliases, bounds and filters',()=>{need();assert.deepEqual(cli.queryArgs('vessels',{'scope':'all','limit':'5','bounds':'170,-20,-170,20','filter':['speedKts:lt:5']}),{layer_id:'ais-live-vessels',scope:'all',limit:5,bounds:{west:170,south:-20,east:-170,north:20},filters:[{field:'speedKts',op:'lt',value:5}]});});
test('bad bounds / limits rejected before connecting',()=>{need();for(const options of [{limit:'0'},{limit:'101'},{offset:'-1'},{scope:'view',bounds:'1,2,3,4'},{bounds:'0,90,1,-90'},{bounds:'0,0,999,10'},{limit:'1x'}])assert.throws(()=>cli.queryArgs('flights',options));});
test('unknown command fails rather than pretending success',()=>{const r=run(['nonsense']);assert.equal(r.status,2);assert.match(r.stderr,/Unknown command/);});
test('help and version work with Node22 and no config',()=>{for(const args of [['--help'],['--version']]) {const r=run(args);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/GARUDA/);}});
test('init is config-only and owner-private',async t=>{const p=await temp(t);const repo=join(p,'repo with spaces');await mkdir(join(repo,'src'),{recursive:true});await writeFile(join(repo,'src','main.js'),'export const application = {};');await writeFile(join(repo,'package.json'),JSON.stringify({scripts:{dev:'vite',doctor:'node doctor.mjs'},engines:{node:'>=24.14.0 <25 || >=26 <27'}}));const config=join(p,'config','cli.json');const r=run(['--config',config,'init',repo]);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(await readFile(config,'utf8')).repo,repo);assert.equal((await stat(config)).mode&0o777,0o600);assert.equal(await readFile(join(repo,'src','main.js'),'utf8'),'export const application = {};');assert.doesNotMatch(r.stdout,/reader_token|publisher_token/);});
test('non-repository init fails before creating config',async t=>{const p=await temp(t),c=join(p,'not-written.json');const r=run(['--config',c,'init',p]);assert.equal(r.status,2);await assert.rejects(stat(c));});
test('query requires layer and summary requires field',()=>{for(const args of [['query'],['summary','flights'],['get','flights']]) {const r=run(args);assert.equal(r.status,2,r.stderr);}});
test('doctor sees runtime Node22 as blocker for app, not for CLI',async t=>{need();const p=await temp(t);await mkdir(join(p,'src'));await writeFile(join(p,'src','main.js'),'');await writeFile(join(p,'package.json'),JSON.stringify({scripts:{dev:'vite'},engines:{node:cli.APP_NODE_RANGE}}));const r=run(['--config',join(p,'cli.json'),'--repo',p,'doctor','--json']);assert.ok([0,1].includes(r.status),r.stderr);const j=JSON.parse(r.stdout);assert.equal(j.cli.name,'GARUDA');assert.equal(j.app.node_supported,cli.appNodeSupported(process.version));});
test('MCP request sends correct token/header and returns structured result',async t=>{need();let seen;const server=createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;seen={url:req.url,auth:req.headers.authorization,accept:req.headers.accept,body:JSON.parse(raw)};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:seen.body.id,result:{isError:false,structuredContent:{status:'no_snapshot'},content:[]}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const r=await cli.mcpRequest(`http://127.0.0.1:${server.address().port}`,'r'.repeat(40),'gev_status',{});assert.equal(r.status,'no_snapshot');assert.equal(seen.auth,`Bearer ${'r'.repeat(40)}`);assert.match(seen.accept,/text\/event-stream/);assert.equal(seen.body.params.name,'gev_status');});
test('HTTP redirect is rejected rather than forwarding credentials',async t=>{need();const server=createServer((req,res)=>{res.writeHead(302,{Location:'http://example.com/'});res.end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));await assert.rejects(cli.mcpRequest(`http://127.0.0.1:${server.address().port}`,'r'.repeat(40),'gev_status',{}));});

test('installed garuda symlink actually runs the command',async t=>{
  const home=await temp(t);const result=run(['install-cli'],{HOME:home});assert.equal(result.status,0,result.stderr);
  const installed=join(home,'.local/bin/garuda');
  const r=spawnSync(installed,['--version'],{encoding:'utf8',env:{...process.env,HOME:home}});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/GARUDA CLI 0.1.0/);
});
test('install-cli refuses to replace another command',async t=>{
  const home=await temp(t);await mkdir(join(home,'.local/bin'),{recursive:true});const other=join(home,'.local/bin/garuda');await writeFile(other,'another product');
  const r=run(['install-cli'],{HOME:home});assert.equal(r.status,2);assert.equal(await readFile(other,'utf8'),'another product');
});
test('irrelevant filters and unexpected positional args fail closed',()=>{
  for(const args of [['status','--filter','speedKts:lt:5'],['dev','unexpected'],['mcp','install','unexpected'],['context','--scope','view']]) {const r=run(args);assert.equal(r.status,2,r.stderr);assert.match(r.stderr,/not supported|Unexpected|takes no/);}
});
test('no application commands are executed via a shell',async()=>{
  const source=await readFile(entry,'utf8');assert.match(source,/shell:false/);assert.doesNotMatch(source,/execSync\(|shell:true/);
});
test('config containing credentials is never printed by doctor',async t=>{
  const p=await temp(t);await writeFile(join(p,'cli.json'),JSON.stringify({repo:p,reader_token:'PRIVATE_READER_SECRET',publisher_token:'PRIVATE_PUBLISHER_SECRET'}));
  const r=run(['--config',join(p,'cli.json'),'doctor']);assert.doesNotMatch(r.stdout+r.stderr,/PRIVATE_READER_SECRET|PRIVATE_PUBLISHER_SECRET/);
});
