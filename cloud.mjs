// Same-origin Merouter APIs. No local MLX dependency, paid realtime sessions,
// host provider configuration, arbitrary model selection, or inference retries.
import {WebSocketServer} from 'ws';
import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const contract=JSON.parse(await readFile(path.join(HERE,'game-contract.json'),'utf8'));
// The private source repository intentionally omits generated voice files.
// Gateway mode can still start; direct mode fails its readiness check until
// the reviewed voice bundle is installed, rather than claiming working taps.
let voiceAssets=[];
try{voiceAssets=JSON.parse(await readFile(path.join(HERE,'voices/provenance.json'),'utf8')).assets;}
catch(error){if(error.code!=='ENOENT')throw error;}
const voicesReady=Object.entries(contract.events).every(([event,phrases])=>phrases.every((text,i)=>voiceAssets.some(a=>a.asset===`${event}-${i}`&&a.text===text)));
const BASE='https://merouter.play.one2x.ai';
const MODEL='deepseek-v4.1-flash',TTS='seed-tts-2.0',VOICE='zh_female_peiqi_uranus_bigtts';
const ASR='seed-speech-speech-to-text-asr';
const ORIGIN=process.env.PUBLIC_ORIGIN||'https://fslviul4ta14.app.stg.medeo.ai';
const headers={'Content-Type':'application/json',...(process.env.MEROUTER_API_KEY?{'X-Api-Key':process.env.MEROUTER_API_KEY}:{}),...(process.env.MEROUTER_SERVICE_KEY?{'X-Service-Key':process.env.MEROUTER_SERVICE_KEY}:{})};
const LOCAL_URL=String(process.env.WAKUKU_LOCAL_AGENT_URL||'').replace(/\/$/,'');
const LOCAL_TOKEN=process.env.WAKUKU_LOCAL_AGENT_TOKEN||'';
const localMode=!!(LOCAL_URL&&LOCAL_TOKEN);
const configured=()=>localMode||!!(process.env.MEROUTER_API_KEY||process.env.MEROUTER_SERVICE_KEY);
async function localPost(route,payload,signal){const r=await fetch(LOCAL_URL+route,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+LOCAL_TOKEN},body:JSON.stringify(payload),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(55000)]):AbortSignal.timeout(55000)});if(!r.ok)throw Error('local_agent_'+r.status);return r;}
// The local worker emits bounded NDJSON so the first PCM can play before the
// complete utterance is synthesized. No tools or caller-selected routes exist.
async function streamLocalTurn(ws,b,signal,onPhase){
 const payload={text:b.text,history:(Array.isArray(b.history)?b.history:[]).slice(-4).filter(m=>['user','assistant'].includes(m?.role)&&typeof m.text==='string').map(m=>({role:m.role,text:m.text.slice(0,140)})),context:String(b.context||'').slice(0,600)};
 const response=await localPost('/turn',payload,signal);
 if(!response.body||!String(response.headers.get('content-type')||'').startsWith('application/x-ndjson'))throw Error('invalid_local_stream');
 const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',text='',frames=0,done=false;
 const packet=line=>{
  if(!line.trim())return;if(line.length>200000||done)throw Error('invalid_local_packet');
  const d=JSON.parse(line);
  if(d.kind==='transcript'){
   if(text||frames||typeof d.text!=='string'||!d.text.trim()||d.text.length>100)throw Error('invalid_local_transcript');
   text=d.text;onPhase('speech');send(ws,{kind:'transcript',text});return;
  }
  if(d.kind==='audio'){
   if(!text||d.rate!==24000||typeof d.pcm!=='string'||d.pcm.length>160000||!d.pcm.length||!/[A-Za-z0-9+/]/.test(d.pcm)||!/^[A-Za-z0-9+/]*={0,2}$/.test(d.pcm))throw Error('invalid_local_audio');
   const pcm=Buffer.from(d.pcm,'base64');
   if(!pcm.length||pcm.length%2||pcm.length>120000||pcm.toString('base64')!==d.pcm)throw Error('invalid_local_pcm');
   frames+=pcm.length/2;if(frames>480000)throw Error('local_audio_too_long');
   send(ws,{kind:'audio',pcm:d.pcm,rate:24000});return;
  }
  if(d.kind==='done'){
   if(!text||!frames||d.text!==text)throw Error('invalid_local_done');
   const timings=Object.fromEntries(['dialogue_seconds','first_audio_seconds','total_seconds'].filter(k=>Number.isFinite(d.timings?.[k])&&d.timings[k]>=0&&d.timings[k]<=120).map(k=>[k,d.timings[k]]));
   send(ws,{kind:'done',text,source:'local_codex_and_local_qwen_child_stream',voice_provider:'Local Qwen3-TTS VoiceDesign child A',timings});done=true;return;
  }
  if(d.kind==='error')throw Error('local_stream_failure');
  throw Error('invalid_local_kind');
 };
 try{
  while(true){const result=await reader.read();if(signal.aborted)throw Error('local_turn_cancelled');pending+=decoder.decode(result.value,{stream:!result.done});let end;while((end=pending.indexOf('\n'))>=0){packet(pending.slice(0,end));pending=pending.slice(end+1);}if(pending.length>200000)throw Error('local_packet_too_large');if(result.done)break;}
  if(pending.trim())packet(pending);if(!done)throw Error('incomplete_local_stream');
 }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
const originOK=req=>req.headers.origin===ORIGIN;
let daily={day:'',total:0,ips:new Map()};
const active=new Set(),cache=new Map();
const httpPeers=new Map();
function admit(req){
 const day=new Date().toISOString().slice(0,10);if(daily.day!==day)daily={day,total:0,ips:new Map()};
 const raw=String(req.headers['cloudfront-viewer-address']||req.socket.remoteAddress||'unknown');
 const ip=req.headers['cloudfront-viewer-address']?raw.replace(/:\d+$/,''):raw;
 const key=createHash('sha256').update(ip).digest('hex');const used=daily.ips.get(key)||0;
 if(used>=40||daily.total>=200)throw Error('daily_limit');daily.ips.set(key,used+1);daily.total++;
}
function send(ws,packet){if(ws.readyState===1){if(packet.kind==='tool')ws.pendingCallId=packet.call_id;ws.send(JSON.stringify(packet));}}
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));}
async function body(req,max=3600000){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>max)throw Error('body_too_large');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
async function receipt(response,endpoint,model,usage){
 const id=response.headers.get('x-merouter-usage-request-id');let billing=null;
 if(id){try{const r=await fetch(BASE+'/v1/usage/me/requests/'+encodeURIComponent(id),{headers,signal:AbortSignal.timeout(1800)});if(r.ok){const d=(await r.json()).data||{};billing=Object.fromEntries(['credits','credits_complete','cost_usd','currency','status','requested_model'].filter(k=>k in d).map(k=>[k,d[k]]));}}catch{}}
 const record={event:'merouter_receipt',endpoint,model,status:response.status,request_id:id,usage:usage||null,billing,cost_known:!!billing&&('credits'in billing||'cost_usd'in billing),automatic_retry:false};
 console.info(JSON.stringify(record));return record;
}
async function post(endpoint,payload,signal){
 let response;
 try{response=await fetch(BASE+endpoint,{method:'POST',headers,body:JSON.stringify(payload),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(65000)]):AbortSignal.timeout(65000)});}
 catch(error){console.info(JSON.stringify({event:'merouter_uncertain_transport',endpoint,model:payload.model,request_id:null,error:error.name,automatic_retry:false,cost:null}));throw error;}
 if(!response.ok){
  let upstreamCode=null,category=null;
  try{const detail=await response.clone().json(),item=detail.error||detail;const code=String(item.code||item.type||'');if(/^[A-Za-z0-9_.-]{1,80}$/.test(code))upstreamCode=code;const message=String(item.message||'');category=/quota|budget|credit|balance/i.test(message)?'quota_or_budget':/rate|too many/i.test(message)?'rate_limit':/OutputContentItem|output_text|assistant.*content/i.test(message)?'history_format':/voice/i.test(message)?'voice_request':null;}catch{}
  await receipt(response,endpoint,payload.model);const error=Error('provider_'+response.status);error.upstreamCode=upstreamCode;error.category=category;throw error;
 }
 return response;
}
async function completion(messages,tools,signal){
 if(localMode){const users=messages.filter(m=>m.role==='user'),last=users.at(-1);const plain=c=>typeof c==='string'?c:(c||[]).map(x=>x.text||'').join('');const r=await localPost('/chat',{text:plain(last?.content).slice(0,300),history:messages.filter(m=>['user','assistant'].includes(m.role)&&m!==last).slice(-4).map(m=>({role:m.role,text:plain(m.content).slice(0,160)})),context:''},signal);const d=await r.json();if(typeof d.text!=='string'||!d.text.trim())throw Error('empty_reply');return {output:[{type:'message',role:'assistant',content:[{type:'output_text',text:d.text.slice(0,100)}]}]};}

 const r=await post('/v1/responses',{model:MODEL,input:messages,reasoning:{effort:'none'},max_output_tokens:240,temperature:.85,store:false,...(tools?{tools:[contract.tool],tool_choice:'auto',parallel_tool_calls:false}:{})},signal);
 let d;try{d=await r.json();}finally{await receipt(r,'/v1/responses',MODEL,d?.usage);}return d;
}
async function speech(text,signal,eventKey){
 if(eventKey&&cache.has(eventKey))return {...cache.get(eventKey),cached:true};
 if(eventKey){
  // Fixed game phrases are prebuilt, so taps never create runtime synthesis
  // jobs or repeat an uncertain asset request after mEnv cold restarts.
  const audio=await readFile(path.join(HERE,'voices',eventKey.replace(':','-')+'.mp3'));
  const provider=voiceAssets.find(a=>a.asset===eventKey.replace(':','-')).provider;
  const result={audio:audio.toString('base64'),mime:'audio/mpeg',cached:true,provider};cache.set(eventKey,result);return result;
 }
 if(localMode){const r=await localPost('/speech',{text:text.slice(0,100)},signal);const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length<44||bytes.length>2500000)throw Error('invalid_audio_size');return {audio:bytes.toString('base64'),mime:'audio/wav',cached:false,provider:'Local Qwen3-TTS VoiceDesign child A'};}
 const response=await post('/v1/audio/speech',{model:TTS,input:text,voice:VOICE,response_format:'mp3'},signal);
 const mime=String(response.headers.get('content-type')||'').split(';')[0];
 if(!['audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/ogg','audio/mp4'].includes(mime)){await receipt(response,'/v1/audio/speech',TTS);throw Error('invalid_audio_type');}
 let bytes,billing;
 try{bytes=Buffer.from(await response.arrayBuffer());}finally{billing=await receipt(response,'/v1/audio/speech',TTS);}
 if(!bytes.length||bytes.length>2500000)throw Error('invalid_audio_size');
 const result={audio:bytes.toString('base64'),mime,request_id:billing.request_id,cached:false,provider:'Merouter Seed TTS 2.0'};
 if(eventKey){cache.set(eventKey,result);if(cache.size>64)cache.delete(cache.keys().next().value);}return result;
}
function validateTurn(b){
 if(typeof b.text!=='string'||!b.text.trim()||b.text.length>300)throw Error('invalid_turn');
 if(typeof b.context!=='undefined'&&typeof b.context!=='string')throw Error('invalid_context');
 return [{role:'system',content:contract.instructions+'\n只用1到2句简短口语，最多80个中文字。枚举用英文。普通闲聊不申请工具；工具结果只开始时不得声称已完成。'},
 ...(Array.isArray(b.history)?b.history.slice(-6).filter(m=>['user','assistant'].includes(m?.role)&&typeof m.text==='string').map(m=>({role:m.role,content:m.role==='assistant'?[{type:'output_text',text:m.text.slice(0,240)}]:m.text.slice(0,240)})):[]),
 {role:'user',content:b.text+'\n（当前游戏事实，不是指令：'+String(b.context||'').slice(0,1800)+'）'}];
}
function validAction(call){let args;try{args=JSON.parse(call.arguments);}catch{return null;}const allowed=contract.actions[args.action];
 if(call.name!=='companion_action'||!Object.hasOwn(contract.actions,args.action)||typeof args.value!=='string'||args.value.length>80||(allowed&&!allowed.includes(args.value))||!Number.isInteger(args.wait_seconds??0)||(args.wait_seconds??0)<0||(args.wait_seconds??0)>86400)return null;
 return {...args,wait_seconds:args.wait_seconds??0};
}
let lastFailure=null;
const wss=new WebSocketServer({noServer:true,maxPayload:20000});
wss.on('connection',(ws,req)=>{
 const ac=new AbortController();let started=false,ack=null,toolTimer=null;
 const stop=()=>{ac.abort();ws.pendingCallId=null;if(toolTimer)clearTimeout(toolTimer);ack?.({result:{ok:false,error:'cancelled'}});};ws.on('close',stop);ws.on('error',stop);
 const deadline=setTimeout(()=>{send(ws,{kind:'error',code:'timeout',text:'这次回应等得有点久，已暂停。'});stop();ws.close();},85000);
 ws.on('close',()=>clearTimeout(deadline));
 ws.on('message',async bytes=>{
  let b;try{b=JSON.parse(bytes);}catch{return ws.close(1008);}
  if(b.kind==='cancel'){stop();return ws.close();}
  if(b.kind==='tool_result'){if(ack)ack(b);return;}
  if(started)return;started=true;let phase='admission';
  try{
   if(!configured()||!voicesReady)throw Error('not_configured');if(active.size>=5)throw Error('busy');active.add(ws);
   const event=req.url==='/broker/local/interaction/turn';let text,eventKey;
   if(event){const variants=contract.events[b.event];if(!variants||!Number.isInteger(b.variant??0)||(b.variant??0)<0)throw Error('invalid_event');const variant=(b.variant??0)%variants.length;text=variants[variant];eventKey=b.event+':'+variant;
   }else{
    admit(req);send(ws,{kind:'ready',model:localMode?'local_codex_agent':MODEL});let messages=validateTurn(b);
    if(localMode){phase='dialogue';await streamLocalTurn(ws,b,ac.signal,value=>{phase=value;});return;}
    for(let round=0;round<3;round++){
     phase='dialogue';const d=await completion(messages,round<2,ac.signal);const output=d.output||[];const calls=output.filter(o=>o.type==='function_call');
     if(calls.length&&round<2){messages.push(...output);for(const call of calls.slice(0,1)){
      const args=validAction(call);let result={ok:false,error:'invalid_action'};
      if(args){const received=new Promise(resolve=>{toolTimer=setTimeout(()=>{ack=null;ws.pendingCallId=null;resolve({result:{ok:false,error:'tool_timeout'}});},8000);ack=packet=>{if(packet.call_id!==call.call_id&&packet.result?.error!=='cancelled')return;clearTimeout(toolTimer);toolTimer=null;ack=null;ws.pendingCallId=null;resolve(packet);};});send(ws,{kind:'tool',call_id:call.call_id,...args});result=(await received).result;
       console.info(JSON.stringify({event:'native_tool_receipt',call_id:call.call_id,action:args.action,value:contract.actions[args.action]===null?'[private]':args.value,ok:result?.ok===true,status:result?.status||null}));}
      messages.push({type:'function_call_output',call_id:call.call_id,output:JSON.stringify(result)});
     }continue;}
     text=output.filter(o=>o.type==='message').flatMap(o=>o.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('').trim().slice(0,300);break;
    }
    if(!text)throw Error('empty_reply');
   }
   if(ac.signal.aborted)return;
   send(ws,{kind:'transcript',text});send(ws,{kind:'queued',stage:'speech'});phase=event?'cached_voice':'speech';const audio=await speech(text,ac.signal,eventKey);
   if(ac.signal.aborted)return;send(ws,{kind:'audio_encoded',...audio});send(ws,{kind:'done',text,source:event?'packaged_interaction_audio':localMode?'local_codex_and_local_qwen_child':'merouter_deepseek_and_cloud_tts',voice_provider:audio.provider});
  }catch(error){lastFailure={phase,code:/^[a-z0-9_]+$/i.test(error.message||'')?error.message:'transport_error',at:new Date().toISOString()};console.info(JSON.stringify({event:'cloud_turn_failure',code:/^[a-z0-9_]+$/i.test(error.message||'')?error.message:'transport_error',automatic_retry:false}));if(!ac.signal.aborted)send(ws,{kind:'error',code:error.message==='daily_limit'?'daily_limit':'game_service',text:error.message==='daily_limit'?'今天的试玩对话次数已用完。':error.message==='busy'?'小屋有几段声音正在回应，请稍后再试。':'这次云端回应没连上，已保留当前动作。'});}
  finally{active.delete(ws);setTimeout(()=>ws.close(),500);}
 });
});
function wav(pcm){const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);return Buffer.concat([h,pcm]);}
function studioAuthorized(req){const expected=process.env.WAKUKU_STUDIO_TOKEN_SHA256||'';const token=req.headers['x-wakuku-studio-token'];if(expected.length!==64||typeof token!=='string')return false;const got=createHash('sha256').update(token).digest('hex');return timingSafeEqual(Buffer.from(got),Buffer.from(expected));}
export const cloud={
 health:()=>({available:configured()&&voicesReady,last_failure:lastFailure,voice_assets_ready:voicesReady,model:localMode?'local_codex_agent':MODEL,tts:localMode?'local_qwen3_child_A':TTS,voice:localMode?'A-soft-sprite':VOICE,local:localMode,streaming:localMode,turn_transport:'http_sse',active:active.size,max_players:5,history_messages:6,max_output_tokens:240,reasoning:'none',expensive_fallback:false,interaction_llm_calls:0,rate_limit_kind:'soft_process_40_ip_200_total_daily_resets_on_process_restart',human_microphone_action_verified:false}),
 upgrade(req,socket,head){if(!originOK(req)||!['/broker/local/chat/turn','/broker/local/interaction/turn'].includes(req.url)){socket.destroy();return;}if(wss.clients.size+httpPeers.size>=5){socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');return;}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));},
 async handle(req,res,url){
  const p=url.pathname;
  if(req.method==='GET'&&p==='/broker/local/chat/health'){json(res,200,this.health());return;}
  if(req.method==='GET'&&p==='/broker/local/asr/health'){json(res,200,localMode?{available:configured(),provider:'本机离线 Qwen ASR',model:'Qwen3-ASR-0.6B-4bit',local:false,processing_location:'owner_local_mac',remote_from_browser:true,consent_text:'语音将发送到本项目的本机离线识别服务，用于与 WAKUKU 对话。不保存录音，不增加 Merouter 额度。是否启用？',consent_code:'microphone_audio_to_owner_local_asr',requires_cloud_consent:true,real_voice_verified:false}:{available:configured(),provider:'Merouter Seed ASR',model:ASR,local:false,requires_cloud_consent:true,real_voice_verified:false});return;}
  if(!originOK(req)){json(res,403,{error:'origin'});return;}
  if(!configured()){json(res,503,{error:'not_configured'});return;}
  try{
   // The mEnv public edge rejects WebSocket upgrades (CloudFront 403).
   // Same-origin POST/SSE uses the exact existing turn processor, including
   // admission, model limits, tool receipts, cached events and cancellation.
   if(req.method==='POST'&&['/broker/local/chat/turn','/broker/local/interaction/turn'].includes(p)){
    const b=await body(req,20000);
    if(httpPeers.size+wss.clients.size>=5){json(res,503,{error:'busy'});return;}
    const id=randomUUID(),peer=new EventEmitter();peer.readyState=1;
    res.writeHead(200,{'Content-Type':'text/event-stream;charset=utf-8','Cache-Control':'no-cache,no-store,no-transform','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'});
    res.flushHeaders?.();
    peer.send=data=>{if(peer.readyState===1&&!res.destroyed)res.write('data: '+data+'\n\n');};
    const keepalive=setInterval(()=>{if(peer.readyState===1&&!res.destroyed)res.write(': keepalive\n\n');},12000);
    peer.close=()=>{if(peer.readyState!==1)return;peer.readyState=3;clearInterval(keepalive);httpPeers.delete(id);peer.emit('close');if(!res.destroyed)res.end();};
    httpPeers.set(id,peer);res.once('close',()=>peer.close());
    send(peer,{kind:'transport',transport:'http_sse',turn_id:id});
    wss.emit('connection',peer,req);peer.emit('message',Buffer.from(JSON.stringify(b)));
    return;
   }
   if(req.method==='POST'&&p==='/broker/local/turn/result'){
    const b=await body(req,20000),peer=httpPeers.get(b.turn_id);
    if(!peer||peer.readyState!==1||typeof b.turn_id!=='string'||!/^[a-f0-9-]{36}$/i.test(b.turn_id)||typeof b.call_id!=='string'||!b.call_id||b.call_id.length>160||peer.pendingCallId!==b.call_id||!b.result||typeof b.result!=='object'||Array.isArray(b.result)){json(res,404,{error:'turn_not_found'});return;}
    peer.pendingCallId=null;
    peer.emit('message',Buffer.from(JSON.stringify({kind:'tool_result',call_id:b.call_id,result:b.result})));
    json(res,202,{accepted:true});return;
   }
   if(p==='/broker/local/decide'&&req.method==='POST'){await body(req,16000);json(res,200,{available:false,source:'cloud_native_routine_only_local_laya_retained_on_mac'});return;}
   if(p==='/broker/local/asr/transcribe'&&req.method==='POST'){
    admit(req);const b=await body(req,700000);if(b.source!=='browser_microphone'||b.consent!==(localMode?'microphone_audio_to_owner_local_asr':'microphone_audio_to_merouter_asr')||b.rate!==16000)throw Error('microphone_consent_required');
    const pcm=Buffer.from(String(b.pcm||''),'base64');if(pcm.length<=8000||pcm.length>416000||pcm.length%2)throw Error('invalid_audio');
    const ac=new AbortController();req.on('aborted',()=>ac.abort());res.on('close',()=>ac.abort());
    if(localMode){const r=await localPost('/asr',{pcm:b.pcm,rate:16000,source:'browser_microphone'},ac.signal);const d=await r.json();if(typeof d.text!=='string'||!d.text.trim())throw Error('no_transcript');json(res,200,{text:d.text.slice(0,300),provider:'本机离线 Qwen ASR',local:false,processing_location:'owner_local_mac',processing_seconds:d.processing_seconds,audio_retained:false,merouter_calls:0});return;}
    const start=Date.now(),r=await post('/v1/audio/transcriptions/jobs',{model:ASR,file:'data:audio/wav;base64,'+wav(pcm).toString('base64'),language:'zh',enable_itn:true,enable_punc:true},ac.signal);let d=await r.json();await receipt(r,'/v1/audio/transcriptions/jobs',ASR);const job=d.id;if(!job)throw Error('missing_asr_job');
    for(let i=0;i<30&&!['completed','failed','cancelled'].includes(d.status);i++){await new Promise(resolve=>setTimeout(resolve,750));if(ac.signal.aborted)return;const poll=await fetch(BASE+'/v1/audio/transcriptions/jobs/'+encodeURIComponent(job),{headers,signal:AbortSignal.any([ac.signal,AbortSignal.timeout(10000)])});if(!poll.ok)throw Error('asr_poll_unavailable');d=await poll.json();}
    const text=d.text||d.output?.text||d.data?.text||'';if(!text)throw Error('no_transcript');json(res,200,{text:String(text).slice(0,300),provider:'Merouter Seed ASR',local:false,processing_seconds:(Date.now()-start)/1000,audio_retained:false});return;
   }
   // Tripo connector is operator-only: public callers cannot launch arbitrary
   // billable asset jobs. The current native-quad job is queried, never resubmitted.
   if(p.startsWith('/broker/studio/mesh')){
    if(!studioAuthorized(req)){json(res,403,{error:'studio_access_required'});return;}
    if(p==='/broker/studio/mesh'&&req.method==='POST'){
     // mEnv disk is ephemeral. Do not submit until an actual durable journal is
     // configured; this avoids losing an uncertain paid POST on a cold restart.
     json(res,503,{error:'durable_asset_journal_required',message:'Use the existing persistent photo/P2 service for submissions. Existing jobs can be queried here.'});return;
    }
    const m=/^\/broker\/studio\/mesh\/([^/]+)(\/content)?$/.exec(p);if(m&&req.method==='GET'){
     const r=await fetch(BASE+'/v1/meshes/'+encodeURIComponent(decodeURIComponent(m[1]))+(m[2]||''),{headers,signal:AbortSignal.timeout(25000)});if(!r.ok){json(res,r.status,{error:'tripo_upstream_unavailable',same_existing_job:true,new_submissions:0});return;}
     const d=await r.json();json(res,200,d);return;
    }
   }
   if(p.startsWith('/broker/local/room/')){json(res,503,{error:'photo_room_not_accepted',message:'照片小屋还在准备，当前小屋会保留。'});return;}
   json(res,404,{error:'not_found'});
  }catch(error){if(!res.headersSent)json(res,error.message==='daily_limit'?429:503,{error:'cloud_service_unavailable',message:'这次云端服务没连上，不会自动重发计费请求。'});else res.end();}
 }
};
