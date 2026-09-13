/**
 * Headless Super Series queue sweep — the GitHub-only replacement for the
 * removed Telegram bot's per-minute cron (runSuperQueueSweep/superQueueTick).
 * Drives the SAME pure superQueueAdvance as the bot and the Dashboard; the
 * durable repo record jobs/<anchor>/super-plan.json is the only cursor, so
 * double-dispatch is impossible (spawn is marked BEFORE dispatch).
 * No Worker, no D1, no KV — pure GitHub REST.
 */
import { superQueueAdvance, superPartRequestBody, isSuperSeriesAnchor } from './super.js';

const API='https://api.github.com';
const TOK=process.env.GITHUB_TOKEN, REPO=process.env.SWEEP_REPO||process.env.GITHUB_REPOSITORY, BR='main';
const [OWNER,NAME]=REPO.split('/');
const b64=s=>Buffer.from(s,'utf8').toString('base64');
const unb64=s=>Buffer.from(s,'base64').toString('utf8');
const ep=p=>`/repos/${OWNER}/${NAME}${p}`;
async function req(path,o={}){
  const r=await fetch(API+path,{method:o.method||'GET',headers:{Authorization:'Bearer '+TOK,Accept:'application/vnd.github+json','Content-Type':'application/json','User-Agent':'cf-super-sweep'},...(o.body?{body:JSON.stringify(o.body)}:{})});
  if(r.status===204)return null;
  const t=await r.text(); let b=null; try{b=t?JSON.parse(t):null;}catch{b=null;}
  if(!r.ok){const e=new Error(`HTTP ${r.status} ${path}: ${t.slice(0,200)}`); e.status=r.status; throw e;}
  return b;
}
async function getFile(path){ try{const f=await req(ep(`/contents/${encodeURIComponent(path).replace(/%2F/g,'/')}?ref=${BR}`)); return {sha:f.sha, text:unb64(f.content)};}catch(e){ if(e.status===404)return null; throw e; } }
async function getJson(path){ const f=await getFile(path); if(!f)return null; try{return JSON.parse(f.text);}catch{return null;} }
async function putJson(path,obj,msg){ const cur=await getFile(path); await req(ep(`/contents/${encodeURIComponent(path).replace(/%2F/g,'/')}`),{method:'PUT',body:{message:msg,content:b64(JSON.stringify(obj,null,2)+'\n'),branch:BR,...(cur?{sha:cur.sha}:{})}}); }
const STATUS=j=>`jobs/${j}/status.json`, REQ=j=>`jobs/${j}/stage-a-request.json`, PROD=j=>`jobs/${j}/production.json`, PLAN=j=>`jobs/${j}/super-plan.json`;
const nowEpoch=()=>Math.floor(Date.now()/1000);
function newStatus(o){return {version:1,job_id:String(o.jobId),mode:o.mode||'manual',state:o.state||'queued',message:String(o.message||''),updated_at_epoch:nowEpoch(),...(o.series?{series:o.series}:{})};}
function mergeStatus(s,p){return {...s,...p,updated_at_epoch:nowEpoch()};}
async function resolveMusicRef(request){
  const m=(request&&request.music)||{}; const src=String(m.source||'none');
  if(src==='none')return '';
  if(src==='explicit_library'||src==='job_upload')return m.ref?`path:${m.ref}`:'';
  if(src==='default'){const d=await getJson('branding/music_default.json'); const p=d&&d.library_track_path; return p?`path:${p}`:'';}
  return '';
}
async function currentBranchSha(){ const r=await req(ep(`/git/ref/heads/${BR}`)); return r.object.sha; }
async function dispatchWorkflow(file,inputs){ await req(ep(`/actions/workflows/${encodeURIComponent(file)}/dispatches`),{method:'POST',body:{ref:BR,inputs:inputs||{}}}); }

async function tick(anchor){
  const state=await getJson(PLAN(anchor));
  if(!state||!state.plan||!Array.isArray(state.plan.parts)) return {action:'none'};
  const spawned=Array.isArray(state.spawned)?state.spawned:[];
  const statuses={};
  for(const e of spawned){ statuses[e.job_id]=await getJson(STATUS(e.job_id)).catch(()=>null); }
  const outcome=superQueueAdvance(state,j=>statuses[j]);
  if(outcome.action!=='queue') return outcome;
  if((await getJson(STATUS(outcome.jobId)))||(await getJson(REQ(outcome.jobId)))) return {action:'exists',jobId:outcome.jobId,part:outcome.part};
  const anchorRequest=await getJson(REQ(anchor)); if(!anchorRequest) return {action:'none'};
  const summaries=[];
  for(const e of spawned){
    if(String(statuses[e.job_id]&&statuses[e.job_id].state)!=='complete')continue;
    const p=await getJson(PROD(e.job_id)).catch(()=>null); const s=p&&p.series?p.series:{};
    const partNo=Number(s.part), summary=String(s.summary||'').trim();
    if(Number.isInteger(partNo)&&summary)summaries.push({part:partNo,summary});
  }
  const requestBody=superPartRequestBody(anchorRequest,state,outcome.part,summaries);
  await putJson(REQ(outcome.jobId),{version:1,job_id:outcome.jobId,saved_at_epoch:nowEpoch(),...requestBody},`clipforge: stage-a request for super part ${outcome.part} (${outcome.jobId})`);
  await putJson(PROD(outcome.jobId),outcome.plan,`clipforge: production plan for super part ${outcome.part} (${outcome.jobId})`);
  const ns=newStatus({jobId:outcome.jobId,mode:'manual',state:'stage_b_queued',message:`Super Series part ${outcome.part} of ${state.total_parts} — Stage B dispatched.`,
    series:{enabled:true,series_id:state.series_id,part:outcome.part,start_seconds:Number((outcome.plan.series&&outcome.plan.series.start_seconds)||0),is_final:Boolean(outcome.plan.series&&outcome.plan.series.is_final===true)}});
  ns.release_tag=`clipforge-${outcome.jobId}`; ns.release_url=`https://github.com/${REPO}/releases/tag/clipforge-${outcome.jobId}`;
  await putJson(STATUS(outcome.jobId),ns,`clipforge: queue super series part ${outcome.part} (${outcome.jobId})`);
  state.spawned=[...spawned,{part:Number(outcome.part),job_id:String(outcome.jobId)}];
  await putJson(PLAN(anchor),state,`clipforge: super series part ${outcome.part} spawned (${outcome.jobId})`);
  const musicRef=await resolveMusicRef(requestBody); const codeRef=await currentBranchSha();
  await dispatchWorkflow('stage-b.yml',{job_id:outcome.jobId,production_ref:`path:jobs/${outcome.jobId}/production.json`,music_ref:musicRef,code_ref:codeRef});
  return {action:'dispatched',jobId:outcome.jobId,part:outcome.part,totalParts:state.total_parts};
}

(async()=>{
  const list=await req(ep('/contents/jobs')).catch(()=>[]);
  const dirs=(Array.isArray(list)?list:[]).filter(e=>e&&e.type==='dir').map(e=>e.name);
  const results=[];
  for(const d of dirs){
    const doc=await getJson(PLAN(d)).catch(()=>null);
    if(!isSuperSeriesAnchor(doc))continue;
    try{ results.push({jobId:d,outcome:await tick(d)}); }
    catch(e){ results.push({jobId:d,outcome:{action:'error',message:String(e.message||e)}}); }
  }
  for(const r of results) console.log(`[sweep] ${r.jobId} -> ${JSON.stringify(r.outcome)}`);
  console.log(`[sweep] done. ${results.length} active anchor(s) processed.`);
})().catch(e=>{console.error('sweep fatal:',e);process.exit(1);});
