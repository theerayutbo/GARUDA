import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { runChildren } from '../garuda.mjs';
const cli=resolve('garuda.mjs');
const companion=process.env.GARUDA_TEST_MCP||resolve('gev-mcp');
const hasMcp=fs.existsSync(join(companion,'gev_mcp.py'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function invoke(args,config) {const r=spawnSync(process.execPath,[cli,'--config',config,...args],{encoding:'utf8',timeout:10000});return {...r,data:r.stdout.trim()?JSON.parse(r.stdout):null};}

test('Node CLI to real Python MCP HTTP bridge', {skip:!hasMcp},async t=>{
  const tmp=await mkdtemp(join(tmpdir(),'garuda-mcp-int-')),state=join(tmp,'state'),repo=join(tmp,'repo'),config=join(tmp,'config.json');
  fs.mkdirSync(join(repo,'src'),{recursive:true});fs.writeFileSync(join(repo,'src/main.js'),'import { createStandaloneApplication } from "./standalone/application.js";\nconst application = createStandaloneApplication({});\nexport { application };\n');
  fs.writeFileSync(join(repo,'package.json'),JSON.stringify({scripts:{dev:'vite'},engines:{node:'>=24.14.0 <25 || >=26 <27'}}));
  const p=await port(),endpoint=`http://127.0.0.1:${p}`;
  fs.writeFileSync(config,JSON.stringify({repo,mcp_dir:companion,state_dir:state,endpoint,python:'python3'}));
  const init=invoke(['mcp','install'],config);assert.equal(init.status,0,init.stderr);
  const cfg=JSON.parse(fs.readFileSync(join(state,'config.json'),'utf8'));
  const server=spawn(process.execPath,[cli,'--config',config,'mcp','serve'],{stdio:['ignore','pipe','pipe']});
  let logs='';server.stderr.on('data',x=>logs+=x);
  t.after(async()=>{server.kill('SIGTERM');await Promise.race([new Promise(r=>server.once('close',r)),delay(4000)]);if(server.exitCode===null)server.kill('SIGKILL');await rm(tmp,{recursive:true,force:true});});
  let ready=false;
  for(let i=0;i<80;i++){try{const r=await fetch(endpoint+'/health');if(r.ok){ready=true;break;}}catch{}await delay(50);}
  assert.ok(ready,logs);
  await t.test('empty state remains no_snapshot',()=>{const r=invoke(['status'],config);assert.equal(r.status,0,r.stderr);assert.equal(r.data.status,'no_snapshot');});
  await t.test('empty query is an explicit error, not fabricated records',()=>{const r=invoke(['query','flights'],config);assert.equal(r.status,1,r.stderr);assert.match(r.stderr,/no browser snapshot/);});
  const snapshot={schema_version:1,publisher_id:'garuda-test-fixture',captured_at:new Date().toISOString(),context:{bounds:{west:170,east:-170,south:-20,north:20}},layers:[{id:'flights',name:'Synthetic test flights',enabled:true,source:'SYNTHETIC TEST ONLY',data_class:'simulated',export_truncated:true,total_known:100,records:[{id:'A',callsign:'00123',lat:0,lon:179,altitudeM:1000,observed_at:null},{id:'B',callsign:'DEMO-B',lat:0,lon:-179,altitudeM:null,observed_at:null},{id:'C',callsign:'DEMO-C',lat:0,lon:0,altitudeM:2000,observed_at:null}]}]};
  const publish=await fetch(endpoint+'/bridge/snapshot',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${cfg.publisher_token}`,Origin:'http://localhost:4173'},body:JSON.stringify(snapshot)});assert.equal(publish.status,200,await publish.text());
  await t.test('layers retain truncation and provenance',()=>{const r=invoke(['layers'],config);assert.equal(r.status,0,r.stderr);assert.equal(r.data.layers[0].export_truncated,true);assert.equal(r.data.layers[0].exported_count,3);assert.equal(r.data.layers[0].data_class,'simulated');});
  await t.test('spatial query handles crossing dateline',()=>{const r=invoke(['query','flights','--scope','view'],config);assert.equal(r.status,0,r.stderr);assert.deepEqual(r.data.records.map(r=>r.id),['A','B']);assert.ok(r.data.snapshot_id);});
  await t.test('numeric filter does not coerce missing to zero',()=>{const r=invoke(['query','flights','--filter','altitudeM:lt:1500'],config);assert.equal(r.status,0,r.stderr);assert.deepEqual(r.data.records.map(r=>r.id),['A']);});
  await t.test('leading-zero callsign stays text through full pipeline',()=>{const r=invoke(['query','flights','--filter','callsign:eq:00123'],config);assert.equal(r.status,0,r.stderr);assert.equal(r.data.matched_count,1);});
  await t.test('summary counts missing values separately',()=>{const r=invoke(['summary','flights','--field','altitudeM'],config);assert.equal(r.status,0,r.stderr);assert.equal(r.data.statistics.mean,1500);assert.equal(r.data.statistics.missing,1);});
  await t.test('get returns unknown observation time honestly',()=>{const r=invoke(['get','flights','A'],config);assert.equal(r.status,0,r.stderr);assert.equal(r.data.record.observed_at,null);assert.match(r.data.coverage,/browser_snapshot/);});
  await t.test('bad snapshot pin is rejected',()=>{const r=invoke(['query','flights','--snapshot','not-current'],config);assert.equal(r.status,1);assert.match(r.stderr,/snapshot changed/);});
  await t.test('MCP stdio contains protocol only, not banners',()=>{const input=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'garuda-test',version:'1'}}},{jsonrpc:'2.0',id:2,method:'tools/list',params:{}}].map(JSON.stringify).join('\n')+'\n';const r=spawnSync(process.execPath,[cli,'--config',config,'mcp','stdio'],{input,encoding:'utf8',timeout:10000});assert.equal(r.status,0,r.stderr);const results=r.stdout.trim().split('\n').map(JSON.parse);assert.equal(results.length,2);assert.ok(results[1].result.tools.some(t=>t.name==='gev_query_records'));});
  await t.test('MCP client config contains no credentials',()=>{const r=invoke(['mcp','config'],config);assert.equal(r.status,0,r.stderr);assert.ok(r.data.mcpServers.garuda);assert.doesNotMatch(r.stdout,new RegExp(cfg.reader_token+'|'+cfg.publisher_token));});
  await t.test('MCP install is idempotent and uninstall restores entry',()=>{const again=invoke(['mcp','install'],config);assert.equal(again.status,0,again.stderr);const r=invoke(['mcp','uninstall'],config);assert.equal(r.status,0,r.stderr);assert.doesNotMatch(fs.readFileSync(join(repo,'src/main.js'),'utf8'),/BEGIN GEV MCP/);});
});

test('child supervisor terminates its other child when one exits',async t=>{
  const tmp=await mkdtemp(join(tmpdir(),'garuda-process-'));t.after(()=>rm(tmp,{recursive:true,force:true}));
  const pidfile=join(tmp,'pid');
  const second=`require('fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));setInterval(()=>{},1000)`;
  const result=await runChildren([{command:process.execPath,args:['-e','setTimeout(()=>process.exit(7),500)'],cwd:tmp},{command:process.execPath,args:['-e',second],cwd:tmp}]);
  assert.equal(result,7);assert.ok(fs.existsSync(pidfile));const pid=Number(fs.readFileSync(pidfile,'utf8'));assert.throws(()=>process.kill(pid,0));
});

test('SIGINT stops supervised process group and returns exit 130',async t=>{
  const tmp=await mkdtemp(join(tmpdir(),'garuda-signal-')),pidfile=join(tmp,'child-pid');t.after(()=>rm(tmp,{recursive:true,force:true}));
  const code=`import {runChildren} from ${JSON.stringify('file://'+cli)}; const status=await runChildren([{command:process.execPath,args:['-e',${JSON.stringify("require('fs').writeFileSync("+JSON.stringify(pidfile)+",String(process.pid));setInterval(()=>{},1000)")}],cwd:${JSON.stringify(tmp)}}]);process.exitCode=status;`;
  const parent=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'ignore'});
  t.after(()=>{if(parent.exitCode===null)parent.kill('SIGKILL');});
  for(let i=0;i<80&&!fs.existsSync(pidfile);i++)await delay(25);
  assert.ok(fs.existsSync(pidfile));const done=new Promise(r=>parent.once('close',(code,signal)=>r({code,signal})));parent.kill('SIGINT');
  const status=await done;assert.equal(status.code,130);assert.throws(()=>process.kill(Number(fs.readFileSync(pidfile,'utf8')),0));
});
