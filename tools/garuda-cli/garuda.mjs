#!/usr/bin/env node
/** GARUDA CLI 0.1.0 — local development only. No external packages or API keys. */
import * as fs from 'node:fs';
import { resolve, dirname, join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const VERSION = '0.1.0';
export const APP_NODE_RANGE = '>=24.14.0 <25 || >=26 <27';
const SELF = fileURLToPath(import.meta.url);
const NUMERIC = new Set(['lat','lon','altitudeM','speedMps','verticalRateMps','speedKts','courseDeg','frp','magnitude','depthKm']);
const TEXT = new Set(['callsign','icao24','originCountry','operator','routeOrigin','routeDestination','aircraftClass','name','mmsi','shipType','destination','navStatus','confidence','satellite','place','observed_at']);
const FLAGS = new Set(['onGround','military']);
const ALIASES = { vessels: 'ais-live-vessels', ships: 'ais-live-vessels', fires: 'local-firms' };
const endpointDefault = 'http://127.0.0.1:8765';
const clean = value => String(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,'');
const absolute = value => resolve(String(value).replace(/^~(?=\/|$)/,homedir()));
class UsageError extends Error {}
function requireThat(condition,message) { if (!condition) throw new UsageError(message); }
function exists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function jsonFile(p) { return JSON.parse(fs.readFileSync(p,'utf8')); }
function privateJson(p,data) {
  fs.mkdirSync(dirname(p),{recursive:true,mode:0o700});
  requireThat(!fs.existsSync(p) || !fs.lstatSync(p).isSymbolicLink(),'Refusing a symlinked config file');
  const temp = `${p}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'}); fs.renameSync(temp,p); }
  finally { if(fs.existsSync(temp))fs.unlinkSync(temp); }
}
export function appNodeSupported(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if(!m)return false;
  const [major,minor] = m.slice(1).map(Number);
  return major === 26 || (major === 24 && minor >= 14);
}
export function loopbackUrl(value) {
  // Check original hostname too: URL normalizes dangerous shorthand such as 127.1.
  requireThat(/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(value),'MCP URL must be a plain HTTP localhost/127.0.0.1 origin, without path or credentials');
  const u = new URL(value);
  requireThat(!u.port || (Number(u.port)>=1 && Number(u.port)<=65535),'Invalid MCP port');
  return u.origin;
}
export function parseFilter(value) {
  const m = /^([^:]+):([^:]+):(.+)$/.exec(value);
  requireThat(m,'Filter syntax: field:operator:value, e.g. altitudeM:gt:10000');
  const [,field,op,raw] = m;
  requireThat(NUMERIC.has(field)||TEXT.has(field)||FLAGS.has(field),`Unsupported filter field: ${field}`);
  requireThat(['eq','neq','contains','gt','gte','lt','lte'].includes(op),'Unsupported filter operator');
  let parsed=raw;
  if(NUMERIC.has(field)) { requireThat(op!=='contains' && raw.trim()!=='' && Number.isFinite(Number(raw)),'Numeric filter requires a finite number'); parsed=Number(raw); }
  else if(FLAGS.has(field)) { requireThat(['eq','neq'].includes(op)&&['true','false'].includes(raw),'Boolean filter requires eq/neq:true/false'); parsed=raw==='true'; }
  else requireThat(['eq','neq','contains'].includes(op),'Text filter requires eq, neq or contains');
  return {field,op,value:parsed};
}
function integer(value,name,min,max) {
  requireThat(/^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value)>=min && Number(value)<=max,`${name} must be ${min}..${max}`);
  return Number(value);
}
export function queryArgs(layer,v={},summary=false) {
  requireThat(layer,'A layer is required, e.g. garuda query flights');
  const args={layer_id:ALIASES[layer]||layer,scope:v.scope||'all'};
  requireThat(['all','view'].includes(args.scope),'scope must be all or view');
  if(v.bounds) {
    requireThat(args.scope!=='view','Use --scope view OR --bounds, not both');
    const pieces=v.bounds.split(','); const [west,south,east,north]=pieces.map(Number);
    requireThat(pieces.length===4 && pieces.every(x=>x.trim()!==''&&Number.isFinite(Number(x))) && Math.abs(west)<=180 && Math.abs(east)<=180 && Math.abs(south)<=90 && Math.abs(north)<=90 && south<=north,'bounds must be west,south,east,north with valid coordinates');
    args.bounds={west,south,east,north};
  }
  if(v.filter) {requireThat(v.filter.length<=8,'At most 8 filters');args.filters=v.filter.map(parseFilter);}
  if(v.snapshot)args.snapshot_id=v.snapshot;
  if(summary) {
    requireThat(NUMERIC.has(v.field),'summary requires --field with a numeric field, e.g. altitudeM');
    requireThat(!v.text&&!v.sort&&!v.desc&&!v.limit&&!v.offset,'summary does not accept text, sort or pagination options');
    args.field=v.field;
  } else {
    args.limit=integer(v.limit??'20','limit',1,100);
    if(v.offset!==undefined)args.offset=integer(v.offset,'offset',0,20000);
    if(v.text)args.text=v.text;
    if(v.sort) { requireThat(NUMERIC.has(v.sort),'sort must be a numeric field'); args.sort_by=v.sort; }
    if(v.desc) { requireThat(v.sort,'--desc requires --sort'); args.descending=true; }
  }
  return args;
}
export async function mcpRequest(endpoint,token,tool,args) {
  endpoint=loopbackUrl(endpoint);
  requireThat(typeof token==='string'&&token.length>=32,'Missing/invalid MCP reader token; run garuda mcp install');
  let response;
  try {
    response=await fetch(`${endpoint}/mcp`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json','Accept':'application/json, text/event-stream','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:args}})});
  } catch { throw new Error('MCP connection failed. Start garuda mcp serve (or garuda up); only local, non-redirected HTTP is allowed.'); }
  if(!response.ok) { await response.body?.cancel();throw new Error(`MCP HTTP ${response.status}; check that endpoint and state directory match your running server.`); }
  let text='',bytes=0;
  const decoder=new TextDecoder();
  for await(const part of response.body) {bytes+=part.length;if(bytes>4*1024*1024)throw new Error('MCP response exceeds 4 MiB');text+=decoder.decode(part,{stream:true});}
  text+=decoder.decode();
  const data=JSON.parse(text);
  if(data.error)throw new Error(clean(data.error.message||'MCP protocol error'));
  if(data.result?.isError)throw new Error(clean(data.result.content?.find(x=>x.type==='text')?.text||'MCP tool failed'));
  requireThat(data.result?.structuredContent,'MCP server did not return structured content');
  return data.result.structuredContent;
}
function probe(command,args) {
  const r=spawnSync(command,args,{encoding:'utf8',timeout:5000});
  return r.status===0?r.stdout.trim():null;
}
function repoInfo(repo) {
  requireThat(exists(join(repo,'package.json'))&&exists(join(repo,'src/main.js')),'Expected a GARUDA/GEV checkout with package.json and src/main.js');
  const p=jsonFile(join(repo,'package.json'));
  requireThat(typeof p.scripts?.dev==='string','Repository has no dev script');
  return p;
}
function findCompanion(v,c,repo) {
  const explicit=v['mcp-dir']||process.env.GARUDA_MCP_DIR||c.mcp_dir;
  if(explicit)return absolute(explicit);
  return [join(dirname(SELF),'gev-mcp'),join(repo,'tools/gev-mcp'),join(repo,'../gev-mcp'),join(homedir(),'Downloads/gev-mcp')].find(p=>exists(join(p,'gev_mcp.py')))||null;
}
function settings(v) {
  const config=absolute(v.config||process.env.GARUDA_CONFIG||join(homedir(),'.garuda','cli.json'));
  const c=exists(config)?jsonFile(config):{};
  const repo=absolute(v.repo||c.repo||process.cwd());
  return {config,repo,mcp_dir:findCompanion(v,c,repo),state_dir:absolute(v['state-dir']||c.state_dir||join(homedir(),'.gev-mcp')),endpoint:loopbackUrl(v.endpoint||c.endpoint||endpointDefault),python:v.python||c.python||'python3',app_port:integer(v['app-port']||c.app_port||4173,'app-port',1,65535)};
}
function pythonCheck(c) {
  const version=probe(c.python,['-c','import sys; print(".".join(map(str,sys.version_info[:3])))']);
  const parts=version?.split('.').map(Number);
  return {version,supported:Boolean(parts && (parts[0]>3||(parts[0]===3&&parts[1]>=10)))};
}
function pythonSpec(c,args) {
  requireThat(c.mcp_dir&&exists(join(c.mcp_dir,'gev_mcp.py')),'GEV MCP companion not found. Unzip gev-mcp-v0.1.0.zip, then: garuda init --mcp-dir /absolute/path/gev-mcp');
  requireThat(pythonCheck(c).supported,'MCP needs Python 3.10+. Use --python /path/to/python3');
  return {command:c.python,args:[join(c.mcp_dir,'gev_mcp.py'),'--state-dir',c.state_dir,...args],cwd:c.repo};
}
function appSpec(c,action) {
  const p=repoInfo(c.repo);
  requireThat(p.engines?.node===APP_NODE_RANGE,`Unrecognized Node requirement (${p.engines?.node??'missing'}); review upstream requirements before running.`);
  requireThat(appNodeSupported(process.version),`The CLI runs on ${process.version}, but the app needs Node ${APP_NODE_RANGE}. With nvm installed: nvm install 24 && nvm use 24. Re-run node -v.`);
  requireThat(probe('npm',['--version']),'npm is not available on PATH');
  if(action==='ci')requireThat(exists(join(c.repo,'package-lock.json')),'package-lock.json missing; refusing to change lockfiles');
  else requireThat(exists(join(c.repo,'node_modules/vite/package.json')),'Dependencies missing. Run garuda deps first.');
  return {command:'npm',args:action==='ci'?['ci']:['run','dev','--','--host','127.0.0.1','--port',String(c.app_port),'--strictPort'],cwd:c.repo};
}
/** Supervise only children spawned by this call; never kill unrelated port owners. */
export function runChildren(specs) {
  return new Promise(resolveDone=>{
    let remaining=specs.length,stopping=false,exitCode=0,timer;
    const children=[];
    const killAll=signal=>{for(const p of children) {try {if(p.pid)process.platform==='win32'?p.kill(signal):process.kill(-p.pid,signal);}catch{/* already exited */}}};
    const stop=code=>{if(stopping)return;stopping=true;exitCode=code;killAll('SIGTERM');timer=setTimeout(()=>killAll('SIGKILL'),3000);timer.unref();};
    const onInt=()=>stop(130),onTerm=()=>stop(143);
    const finish=()=>{if(--remaining!==0)return;clearTimeout(timer);process.off('SIGINT',onInt);process.off('SIGTERM',onTerm);resolveDone(exitCode);};
    process.on('SIGINT',onInt);process.on('SIGTERM',onTerm);
    for(const s of specs) {
      const p=spawn(s.command,s.args,{cwd:s.cwd,env:{...process.env,PATH:`${dirname(process.execPath)}${delimiter}${process.env.PATH||''}`},stdio:'inherit',shell:false,detached:process.platform!=='win32'});
      children.push(p);
      p.once('error',()=>{console.error('GARUDA: child process could not start');stop(1);});
      p.once('close',(code,signal)=>{if(!stopping)stop(code??(signal?1:0));finish();});
    }
  });
}
function output(data) { console.log(JSON.stringify(data,null,2)); }
function printHelp() {
  console.log(`GARUDA CLI ${VERSION} — local app + read-only MCP\n\nUsage: garuda [options] <command>\n\n  init [REPO]          Save checkout/companion paths; does not modify the app\n  doctor               Check Node, dependencies, Python and MCP readiness\n  deps                 Run npm ci after enforcing the app Node requirement\n  dev                  Start the app in the foreground; Ctrl+C stops it\n  up                   Start app + MCP together; Ctrl+C stops both\n  status | layers | context | sources\n  query LAYER          Read exported records\n  get LAYER ID         Read one record\n  summary LAYER --field altitudeM\n  mcp install          Install opt-in browser bridge, with a backup\n  mcp serve | stdio | config | token publisher | uninstall | clear\n  install-cli          Install the garuda command into ~/.local/bin\n\nOptions: --repo PATH --mcp-dir PATH --state-dir PATH --endpoint URL\n         --config FILE --python PATH --app-port 4173 --json\nQuery:   --scope all|view --text TEXT --filter 'speedKts:lt:5'\n         --bounds west,south,east,north --sort altitudeM --desc\n         --limit 20 --offset 0 --snapshot ID\n\nAll data output is JSON, including timestamps and coverage warnings.\nCLI: Node 22+. App: ${APP_NODE_RANGE}. MCP: Python 3.10+.\nNo cloud chat, history, control of hardware or automatic Node upgrade.`);
}
export function installCli(home=homedir()) {
  requireThat(process.platform!=='win32','install-cli targets macOS/Linux. On Windows, run node garuda.mjs directly.');
  const dir=join(home,'.local/share/garuda-cli'),bin=join(home,'.local/bin'),link=join(bin,'garuda'),target=join(dir,'garuda.mjs');
  for(const p of [dir,bin]) {requireThat(!fs.existsSync(p)||!fs.lstatSync(p).isSymbolicLink(),'Refusing a symlinked installation directory');fs.mkdirSync(p,{recursive:true,mode:0o700});}
  try {const s=fs.lstatSync(link);requireThat(s.isSymbolicLink()&&fs.readlinkSync(link)===target,'Another garuda command exists; refusing to overwrite it');}catch(e){if(e.code!=='ENOENT')throw e;}
  requireThat(!fs.existsSync(target)||!fs.lstatSync(target).isSymbolicLink(),'Refusing a symlinked CLI target');
  if(SELF!==target)fs.copyFileSync(SELF,target);
  fs.chmodSync(target,0o755);
  if(!fs.existsSync(link))fs.symlinkSync(target,link);
  // Companion remains in its separately configured path; never move tokens.
  return {installed:true,command:link,activate:'export PATH="$HOME/.local/bin:$PATH"',note:'Add that PATH line to your shell profile for future terminals. No shell profile was changed.'};
}
export async function main(argv=process.argv.slice(2)) {
  const {values:v,positionals:pos}=parseArgs({args:argv,allowPositionals:true,strict:true,options:{help:{type:'boolean',short:'h'},version:{type:'boolean'},json:{type:'boolean'},config:{type:'string'},repo:{type:'string'},'mcp-dir':{type:'string'},'state-dir':{type:'string'},endpoint:{type:'string'},python:{type:'string'},'app-port':{type:'string'},scope:{type:'string'},bounds:{type:'string'},filter:{type:'string',multiple:true},text:{type:'string'},limit:{type:'string'},offset:{type:'string'},sort:{type:'string'},desc:{type:'boolean'},snapshot:{type:'string'},field:{type:'string'}}});
  if(v.version){console.log(`GARUDA CLI ${VERSION}`);return 0;}
  if(v.help||!pos.length){printHelp();return 0;}
  const [command,...rest]=pos;
  requireThat(['init','doctor','deps','dev','up','status','layers','context','sources','query','get','summary','mcp','install-cli'].includes(command),`Unknown command: ${command}. Run garuda --help.`);
  const queryOptions=['scope','bounds','filter','text','limit','offset','sort','desc','snapshot','field'];
  const permitted=command==='query'?queryOptions.filter(k=>k!=='field'):command==='summary'?['scope','bounds','filter','snapshot','field']:command==='get'?['snapshot']:[];
  for(const key of queryOptions)requireThat(v[key]===undefined||permitted.includes(key),`--${key} not supported for ${command}`);
  if(!['init','query','summary','get','mcp'].includes(command))requireThat(rest.length===0,`${command} takes no positional arguments`);
  if(command==='install-cli'){output(installCli());return 0;}
  const c=settings(v);
  if(command==='init') {
    requireThat(rest.length<=1,'init takes one optional repository path');
    if(rest[0])c.repo=absolute(rest[0]);
    repoInfo(c.repo);
    if(v['mcp-dir'])requireThat(exists(join(c.mcp_dir,'gev_mcp.py')),'--mcp-dir does not contain gev_mcp.py');
    // Rediscover companion relative to the final positional repo as well.
    if(!c.mcp_dir)c.mcp_dir=findCompanion(v,{},c.repo);
    const {config,...saved}=c;privateJson(config,{version:1,...saved});
    output({configured:true,config,...saved,next:'garuda doctor; garuda deps; garuda mcp install; garuda up'});return 0;
  }
  if(command==='doctor') {
    let app;try{app=repoInfo(c.repo);}catch{/* report instead of throwing */}
    const py=pythonCheck(c),dep=exists(join(c.repo,'node_modules/vite/package.json'));
    const ready=Boolean(app&&app.engines?.node===APP_NODE_RANGE&&appNodeSupported(process.version)&&dep);
    output({cli:{name:'GARUDA',version:VERSION,node:process.version},repo:c.repo,app:{found:Boolean(app),required:app?.engines?.node||null,node_supported:appNodeSupported(process.version),known_requirement:app?.engines?.node===APP_NODE_RANGE,dependencies_installed:dep,ready},mcp:{directory:c.mcp_dir,companion_found:Boolean(c.mcp_dir&&exists(join(c.mcp_dir,'gev_mcp.py'))),python:py,initialized:exists(join(c.state_dir,'config.json')),endpoint:c.endpoint},guidance:!appNodeSupported(process.version)?'Use Node 24.14+ within 24.x or Node 26.x. With nvm: nvm install 24; nvm use 24. CLI does not upgrade Node.':!dep?'Run garuda deps.':'App requirements look ready; browser/WebGL and live feeds have not been tested.'});return ready?0:1;
  }
  if(command==='deps'||command==='dev')return runChildren([appSpec(c,command==='deps'?'ci':'dev')]);
  const serveArgs=['serve','--port',String(new URL(c.endpoint).port||80),'--gev-origin',`http://127.0.0.1:${c.app_port}`,'--gev-origin',`http://localhost:${c.app_port}`];
  if(command==='up') {
    const app=appSpec(c,'dev'),bridge=pythonSpec(c,serveArgs);
    requireThat(exists(join(c.state_dir,'config.json')),'Run garuda mcp install first');
    console.error(`GARUDA app: http://127.0.0.1:${c.app_port} | MCP: ${c.endpoint}. Ctrl+C stops both. Click MCP OFF in the app to opt in.`);
    return runChildren([bridge,app]);
  }
  if(command==='mcp') {
    const [action,role,...extra]=rest;
    requireThat(!extra.length&&(action==='token'||role===undefined),'Unexpected MCP arguments');
    if(action==='config') {
      output({mcpServers:{garuda:{command:process.execPath,args:[SELF,'--config',c.config,'--repo',c.repo,'--state-dir',c.state_dir,'--python',c.python,...(c.mcp_dir?['--mcp-dir',c.mcp_dir]:[]),'mcp','stdio']}}});return 0;
    }
    const args= action==='install'?['init','--gev',c.repo]:action==='serve'?serveArgs:action==='stdio'?['stdio']:action==='uninstall'?['uninstall',c.repo]:action==='clear'?['clear']:action==='token'&&['publisher','reader'].includes(role)?['token',role]:null;
    requireThat(args,'MCP commands: install, serve, stdio, config, token publisher|reader, uninstall, clear');
    const spec=pythonSpec(c,args);
    // stdio must contain only MCP protocol messages, never a CLI banner.
    return runChildren([spec]);
  }
  let tool,args={};
  if(command==='query'||command==='summary') {requireThat(rest.length===1,`${command} requires one layer`);args=queryArgs(rest[0],v,command==='summary');tool=command==='query'?'gev_query_records':'gev_summarize';}
  else if(command==='get') {requireThat(rest.length===2,'get requires LAYER ID');args={layer_id:ALIASES[rest[0]]||rest[0],record_id:rest[1],...(v.snapshot?{snapshot_id:v.snapshot}:{})};tool='gev_get_record';}
  else {requireThat(rest.length===0,'Unexpected positional arguments');tool={status:'gev_status',layers:'gev_list_layers',context:'gev_get_context',sources:'gev_get_sources'}[command];}
  const credentials=join(c.state_dir,'config.json');
  requireThat(exists(credentials),'MCP credentials missing. Run garuda mcp install, then garuda up.');
  const cfg=jsonFile(credentials); output(await mcpRequest(c.endpoint,cfg.reader_token,tool,args)); return 0;
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===SELF) {
  main().then(code=>{process.exitCode=code;}).catch(e=>{console.error(`GARUDA: ${clean(e.message)}`);process.exitCode=e instanceof UsageError||e.code?.startsWith('ERR_PARSE_ARGS')?2:1;});
}
