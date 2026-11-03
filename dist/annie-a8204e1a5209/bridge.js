import {Bus,realClock} from './core/bus.js';
import {Annie} from './core/annie.js';
import {BrokerDecider} from './core/decide.js';
import {TaitaiFloor} from './floor-zh.js';
import {CLIPS} from './clips-2d.js';
import {CONFIG} from './config.js';
import {TypedAgent} from './typed-agent.js?revision=local-codex-child-A-20261103';
import {MicrophoneInput} from './microphone.js';
import {RoomAudio} from './room-audio.js';

const bus = new Bus();
const floor = new TaitaiFloor();
const roomAudio = new RoomAudio();
let callback, generation = 0, replyTimer, voice, live = false, closed = false, hud;
let lastTurn = {kind:'idle',source:'floor'}, decisionCount = 0;
let suppressed = false, previewing = false, outputPaused = false;
let typedHistory=[], mouthFrame=0, audioMuted=false, microphone;
const deliver = (kind, data={}) => {
  hud?.packet(kind,data);
  callback?.(JSON.stringify({...data,...(kind==='state'?{outputPaused}:{}),kind}));
};
const character = {
  listening:false,speaking:false,energy:'moderate',
  playClip(name) {
    if (!CLIPS[name] || suppressed) return false;
    deliver('motion',{name,duration:CLIPS[name].duration,energy:this.energy});
    return true;
  },
  gesture(name) {return this.playClip(({nod:'nod',shake:'headshake',tilt:'tilt',duck:'settle'})[name]);},
  setFace(name,intensity=.5) {
    deliver('expression',{name,intensity});return true;
  },
  transcript() {},
  bargeIn() {deliver('interrupt');},
};
const decider = {async decide(kind,ctx,questions) {
  try {
    const response=await fetch(CONFIG.brokerUrl+'/local/decide',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({state:kind==='listen'?ctx.userText:ctx.assistantText,questions}),
      signal:AbortSignal.timeout(2800),
    });
    const result=await response.json();
    if(result.available&&result.answers)return {...result,source:'local_laya'};
  } catch {}
  return floor.decide(kind,ctx,questions);
}};
const brokerDecider = new BrokerDecider({url:CONFIG.brokerUrl,getToken:()=>voice?.token,floor});
const annie = new Annie({bus,character,decider,clock:realClock});
const typed = new TypedAgent({url:CONFIG.brokerUrl,
  onPacket(packet) {
    if(packet.kind==='ready')deliver('state',{stage:'thinking',live});
    if(packet.kind==='audio_start') {
      bus.emit('assistant.audio.start');
      deliver('state',{stage:'responding',live});
    }
    if(packet.kind==='transcript') {
      bus.emit('assistant.partial',{text:packet.text});
      deliver('assistant.partial',{text:packet.text});
    }
    if(packet.kind==='tool')deliver('agent.tool',packet);
    if(packet.kind==='expression')character.setFace(packet.name);
    if(packet.kind==='notice')deliver('notice',{text:packet.text});
    if(packet.kind==='error') {
      deliver('agent.error',{text:packet.text});
      deliver('state',{stage:'unavailable',live});
      deliver('mouth',{amp:0});
    }
  },
  onComplete(text,source) {
    typedHistory.push({role:'assistant',text:text.slice(0,600)});
    typedHistory=typedHistory.slice(-16);
    bus.emit('assistant.final',{text});
    deliver('reply',{text,source:source||'merouter_deepseek_and_local_qwen'});
    deliver('state',{stage:'idle',live});
    deliver('mouth',{amp:0});
  },
});

microphone=new MicrophoneInput({url:CONFIG.brokerUrl,
  onState(stage){deliver('state',{stage,live:false});},
  onLevel(level){deliver('mic.level',{level});},
  onError(text){deliver('notice',{text});deliver('state',{stage:'idle',live:false});},
  onText(text,context){deliver('user.final',{text,source:'microphone'});submit(text,context,'microphone');},
});

bus.on('decision', d=>{
  if(annie.history.length>20)annie.history=annie.history.slice(-20);
  decisionCount++;
  lastTurn={kind:d.kind,source:d.source,stale:d.stale,veto:!!d.acted?.veto};
  console.debug('taitai-annie',JSON.stringify({...lastTurn,event:'decision',acted:d.acted,number:decisionCount}));
  deliver('decision',{...lastTurn,decisionKind:lastTurn.kind,number:decisionCount});
});
bus.on('user.partial',({text})=>{
  deliver('state',{stage:'listening',live});
  if (live) deliver('user.partial',{text});
});
bus.on('user.final',({text})=>{if(live) deliver('user.final',{text});});
bus.on('assistant.audio.start',()=>{if(!outputPaused)deliver('state',{stage:'responding',live,outputPaused});});
bus.on('assistant.partial',({text})=>{if(live && !outputPaused) deliver('assistant.partial',{text});});
bus.on('assistant.final',({text})=>{if(live && !outputPaused) deliver('reply',{text,source:'gptlive'});});
bus.on('assistant.audio.end',()=>deliver('state',{stage:'idle',live}));
bus.on('bargein',()=>deliver('state',{stage:'listening',live}));
bus.on('voice.error',()=>{stopLive();deliver('notice',{text:'语音连接中断，回到本地陪伴。'});});
bus.on('session.closed',()=>stopLive());

function interrupt() {
  generation++;
  typed.cancel();
  microphone?.cancel();
  clearTimeout(replyTimer);
  previewing=false;
  annie.pacer.resetTurn();
  bus.emit('bargein');
  character.speaking=false;
  deliver('mouth',{amp:0,vowels:{}});
  deliver('state',{stage:'idle',live});
}

function listenFirst(context='') {
  if(!live) {
    if(microphone?.recording){microphone.finish();return;}
    if(microphone?.active){microphone.cancel();deliver('state',{stage:'idle',live:false});deliver('notice',{text:'已取消本次录音。'});return;}
    interrupt();typed.unlock();microphone.start(context);return;
  }
  outputPaused = !outputPaused;
  if(voice?.el) voice.el.muted=outputPaused||audioMuted;
  interrupt();
  deliver('state',{stage:'listening',live,outputPaused});
  deliver('notice',{text:outputPaused?'已暂停播声，语音仍连接；我先听你说。':'已恢复播声。'});
}

function preview(text) {
  if(!text.trim()) {if(previewing)interrupt();return;}
  if(!previewing) {
    if(live)stopLive();
    interrupt();previewing=true;character.playClip('attend');
  }
  bus.emit('user.partial',{text:String(text).slice(0,100)});
}

function submit(userText, context, inputSource='typed') {
  if(live)stopLive();
  interrupt();
  userText=String(userText).slice(0,300);
  // Confirmed application input, separate from partial typing/recording. The
  // optional HUD keeps only this latest line in RAM; native history is unchanged.
  hud?.packet('user.accepted',{text:userText,source:inputSource});
  const history=typedHistory.slice(-16);
  typedHistory.push({role:'user',text:userText});
  bus.emit('user.final',{text:userText});
  deliver('state',{stage:'thinking',live:false});
  character.playClip('attend');
  typed.submit(userText,String(context).slice(0,1800),history,inputSource);
  return true;
}

async function startLive(context) {
  if (!CONFIG.liveEnabled) {deliver('notice',{text:'当前使用 DeepSeek 对话和自动语音回应。'});return false;}
  if (voice) return false;
  interrupt();
  const epoch=++generation;
  let candidate;
  try {
    const health=await fetch(`${CONFIG.brokerUrl}/health`,{signal:AbortSignal.timeout(2500)}).then(r=>r.json());
    if(!health.providers?.voice) {deliver('notice',{text:'实时语音尚未配置；请先完成本机配置。'});return false;}
    if(epoch!==generation) return false;
    const {GptLiveVoice}=await import('./core/voice-gptlive.js');
    const instructions='你是WAKUKU，一个温和的 WAKUKU AI 陪伴角色。用简短自然的中文交流，先听再回应，不催促，不冒充真人或声称看到现实环境。你只会轻微点头、摇头、倾头，不会跳舞、走路、翻跟头或操作现实设备。生活情境由用户主动告知。当前只进行对话，不能声称已修改计时、偏好、房间或存档。'+String(context).slice(0,500);
    if(epoch!==generation) return false;
    candidate=new GptLiveVoice({bus,brokerUrl:CONFIG.brokerUrl,voice:CONFIG.voice,instructions,clock:realClock});
    voice=candidate;
    await candidate.connect();
    if(candidate.el)candidate.el.muted=audioMuted;
    if(epoch!==generation || voice!==candidate) {candidate.close();return false;}
    live=true;
    brokerDecider.disabled=false;
    deliver('state',{stage:'listening',live:true});
    return true;
  } catch {
    if(!candidate || voice===candidate)stopLive();
    else candidate.close();
    deliver('notice',{text:'语音暂时连不上，可以继续文字陪伴。'});
    return false;
  }
}

function stopLive() {
  live=false;
  outputPaused=false;
  voice?.close();
  voice=null;
  interrupt();
}

function frame() {
  if(closed)return;
  roomAudio.tick();
  const now=realClock.now();
  let features;
  if(live && voice) {
    features=voice.analyser?.sample();
    voice.tick(now,(features?.amp??0)>.04);
    if(Date.now()/1000>=voice.expiresAt) stopLive();
  } else if(typed.active)features=typed.sample();
  if(now-mouthFrame>1/30) {
    mouthFrame=now;
    deliver('mouth',{amp:outputPaused||audioMuted?0:(features?.amp??0),vowels:features?.vowels??{}});
  }
  annie.update(now);
  requestAnimationFrame(frame);
}

window.TaitaiAnnie=Object.freeze({
  bind(fn) {callback=fn;deliver('ready',{mode:'merouter_deepseek_laya',liveConfigured:false,voiceEntryEnabled:true,capabilities:Object.keys(CLIPS)});},
  submit,preview,interrupt,listenFirst,startLive,stopLive,
  speakEvent(event,variant=0) {
    if(microphone?.active)return false;
    deliver('state',{stage:'thinking',live:false});
    typed.submit('','',[],'interaction',{event:String(event),variant:Math.max(0,Number(variant)||0)});
    return true;
  },
  resolveTool(id,result) {typed.resolveTool(id,JSON.parse(result));},
  forgetDialogue() {typedHistory=[];annie.history=[];hud?.packet('dialogue.cleared');},
  setMuted(value) {audioMuted=!!value;typed.setMuted(value);roomAudio.setMuted(value);if(voice?.el)voice.el.muted=!!value||outputPaused;},
  setRoomMix(state,muted,musicMuted=false) {roomAudio.setMix(String(state),!!muted,!!musicMuted);},
  playRoomSound(name) {roomAudio.effect(String(name));},
  setBusy(value) {suppressed=!!value;},
  hudReady() {return hud?.ready()||false;},
  updateHUD(frame) {hud?.update(frame);},
  roomResult(encoded) {hud?.packet('room.result',JSON.parse(encoded));},
  status() {return JSON.stringify({mode:live?'gptlive':'merouter_deepseek_laya',stage:lastTurn.kind,decisions:decisionCount,liveConfigured:false,voiceEntryEnabled:true,capabilities:Object.keys(CLIPS)});},
});
// UI is an optional bounded shell. A failed UI chunk must not disable voice/world.
import('./ui/hud.js').then(({mountGameHUD})=>{
  hud=mountGameHUD({dispatch:data=>deliver('ui.action',data),preview});
}).catch(()=>console.warn('wakuku_hud_fallback','HUD unavailable; original game controls retained'));
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&(microphone?.active||typed.active)){interrupt();deliver('notice',{text:'这次回应已停止。'});}});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&microphone?.active){interrupt();deliver('notice',{text:'已取消收音，回来后可以再点“说话”。'});}});
window.addEventListener('pagehide',()=>{stopLive();roomAudio.close();closed=true;});
requestAnimationFrame(frame);
