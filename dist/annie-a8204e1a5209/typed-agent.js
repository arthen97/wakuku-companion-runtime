// One typed turn generates audio and its transcript together. No canned fallback.
import {LiveAnalyser} from './core/lipsync.js';

// One POST per turn. Reading SSE never reconnects or repeats inference.
export class HttpSseTurn {
  constructor(url,resultUrl) {
    Object.assign(this,{url,resultUrl,readyState:0,started:false});
    this.abort=new AbortController();
    queueMicrotask(()=>{if(this.readyState===0){this.readyState=1;this.onopen?.();}});
  }
  send(data) {
    if(this.readyState!==1)return;
    const packet=JSON.parse(data);
    if(packet.kind==='cancel'){this.close();return;}
    if(packet.kind==='tool_result') {
      if(!this.turnId)return this.error();
      fetch(this.resultUrl,{method:'POST',mode:'same-origin',credentials:'same-origin',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...packet,turn_id:this.turnId}),signal:this.abort.signal})
        .then(r=>{if(!r.ok)throw Error('tool_result_rejected');}).catch(()=>{if(!this.abort.signal.aborted)this.error();});
      return;
    }
    if(this.started)return;
    this.started=true;this.read(data).catch(()=>{if(!this.abort.signal.aborted)this.error();});
  }
  async read(body) {
    const response=await fetch(this.url,{method:'POST',mode:'same-origin',credentials:'same-origin',
      headers:{'Content-Type':'application/json','Accept':'text/event-stream'},body,signal:this.abort.signal});
    if(!response.ok||!response.headers.get('content-type')?.startsWith('text/event-stream')||!response.body)throw Error('turn_unavailable');
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
    const dispatch=event=>{
      const data=event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
      if(!data)return;
      const packet=JSON.parse(data);
      if(packet.kind==='transport') {
        if(packet.transport!=='http_sse'||typeof packet.turn_id!=='string'||!/^[a-f0-9-]{36}$/i.test(packet.turn_id))throw Error('invalid_turn_id');
        this.turnId=packet.turn_id;return;
      }
      if(!this.turnId)throw Error('missing_turn_id');
      this.onmessage?.({data});
    };
    try {
      while(this.readyState===1) {
        const {value,done}=await reader.read();
        pending+=decoder.decode(value,{stream:!done});
        let match;
        while((match=/\r?\n\r?\n/.exec(pending))) {
          const event=pending.slice(0,match.index);pending=pending.slice(match.index+match[0].length);
          if(this.readyState!==1)break;
          dispatch(event);
        }
        if(pending.length>4500000)throw Error('event_too_large');
        if(done)break;
      }
      if(pending.trim()&&this.readyState===1)dispatch(pending);
    } finally {reader.releaseLock();}
    if(this.readyState===1){this.readyState=3;this.onclose?.();}
  }
  error(){if(this.readyState!==1)return;this.onerror?.();this.close();}
  close(){if(this.readyState===3)return;this.readyState=3;this.abort.abort();this.onclose?.();}
}

export class TypedAgent {
  constructor({url,onPacket,onComplete}) {
    Object.assign(this,{url,onPacket,onComplete});
    this.sources=new Set(); this.epoch=0; this.muted=false; this.active=false;
    // Wake the same-origin app while the room loads; this never gates send.
    this.warmup();
    if(typeof document!=='undefined'){
      this.onVisibility=()=>{if(document.visibilityState==='visible')this.warmup();};
      document.addEventListener('visibilitychange',this.onVisibility);
      // Establish the read-only connection while the user focuses or types,
      // without sending input content and without gating the actual turn.
      this.onIntent=()=>this.warmup();
      document.addEventListener('focusin',this.onIntent,{passive:true});
      document.addEventListener('input',this.onIntent,{passive:true});
      // An open, visible room keeps the existing small service ready. Hidden
      // pages do no periodic work and no warmup ever submits model input.
      this.warmTimer=setInterval(()=>{if(document.visibilityState==='visible')this.warmup();},20000);
      globalThis.addEventListener?.('pagehide',()=>{clearInterval(this.warmTimer);document.removeEventListener('visibilitychange',this.onVisibility);document.removeEventListener('focusin',this.onIntent);document.removeEventListener('input',this.onIntent);this.warmupAbort?.abort();},{once:true});
    }
  }
  warmup() {
    if(this.warmupPending||performance.now()-(this.lastWarmupAt??-Infinity)<20000)return;
    this.lastWarmupAt=performance.now();this.warmupAbort=new AbortController();
    this.warmupPending=fetch(this.url+'/local/chat/health',{cache:'no-store',signal:AbortSignal.any([this.warmupAbort.signal,AbortSignal.timeout(8000)])})
      .then(response=>{if(!response.ok)throw Error('warmup_unavailable');return response.json();})
      .then(health=>{this.backgroundAvailable=health.available===true;})
      .catch(()=>{this.backgroundAvailable=false;})
      .finally(()=>{this.warmupPending=null;});
  }
  unlock() {
    this.ctx ??= new AudioContext();
    if(!this.gain) {
      this.gain=this.ctx.createGain(); this.gain.connect(this.ctx.destination);
      this.analyser=new LiveAnalyser(this.ctx,this.gain);
    }
    // Called synchronously from the user's send/typing gesture.
    return this.ctx.resume();
  }
  setMuted(value) {this.muted=!!value;if(this.gain)this.gain.gain.value=value?0:1;if(this.muted){this.speechOnsetClock=null;this.speechScanTail=null;}}
  sample() {
    const features=this.active&&!this.muted?this.analyser?.sample():null;
    if(features&&this.receivedAudio){this.mouthSamples++;this.mouthPeak=Math.max(this.mouthPeak,features.amp||0);}
    return features;
  }
  reportMouth(reason) {
    if(!this.receivedAudio||!this.mouthSamples)return;
    console.info('wakuku_mouth_playback',JSON.stringify({inputSource:this.inputSource,reason,clock:'AudioContext.currentTime',clockSeconds:this.ctx?.currentTime,sampleFrames:this.mouthSamples,peakAmplitude:this.mouthPeak,scheduledAudioSeconds:this.audioSeconds,outputMuted:this.muted}));
    this.mouthSamples=0;
  }
  cancel(reason='user_interrupt') {
    const wasActive=this.active,scheduledSources=this.sources.size;let stoppedSources=0;
    if(wasActive)this.logTiming('cancelled');
    this.epoch++; this.active=false;
    clearTimeout(this.finishTimer);this.finishTimer=null;clearTimeout(this.deadline);
    if(this.ws) {
      if(this.ws.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify({kind:'cancel'}));
      this.ws.close(); this.ws=null;
    }
    for(const source of this.sources) {try{source.stop();stoppedSources++;}catch{}}
    this.sources.clear();this.nextTime=0;this.networkDone=null;
    this.speechOnsetClock=null;this.speechOnsetAt=null;this.speechScanTail=null;
    if(wasActive)this.reportMouth(reason==='user_interrupt'?'interrupted':reason);
    if(wasActive&&scheduledSources)console.info('wakuku_audio_interrupted',JSON.stringify({scheduledSources,stoppedSources,audioContext:this.ctx?.state,source:reason}));
  }
  resolveTool(call_id,result) {
    if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify({kind:'tool_result',call_id,result}));
  }
  async submit(text,context,history,inputSource='typed',interaction=null) {
    this.cancel();
    const epoch=this.epoch;
    this.active=true;this.finalText='';this.receivedAudio=false;
    this.turnStartedAt=performance.now();this.transcriptAt=null;this.firstAudioAt=null;
    this.speechOnsetClock=null;this.speechOnsetAt=null;this.speechScanTail=null;
    this.inputSource=inputSource;this.mouthSamples=0;this.mouthPeak=0;this.audioSeconds=0;
    this.clockBase=null;this.clockSeen=0;this.clockAdvancedAt=0;
    this.queuedSources=0;this.endedSources=0;this.decoding=0;
    this.logTiming('submit');
    try {
      await this.unlock();
      if(epoch!==this.epoch)return;
      this.gain.gain.value=this.muted?0:1;
      if(this.ctx.state!=='running')throw new Error('audio_blocked');
      // This mEnv release has one known same-origin SSE transport. Readiness
      // is determined by this single POST; uncertain inference is never retried.
      const turnPath=interaction?'/local/interaction/turn':'/local/chat/turn';
      const ws=new HttpSseTurn(this.url+turnPath,this.url+'/local/turn/result');
      this.ws=ws;
      ws.onopen=()=>{
        if(epoch!==this.epoch)return ws.close();
        ws.send(JSON.stringify(interaction||{text,context,history:history.slice(-6).map(m=>({...m,text:m.text.slice(0,240)}))}));
      };
      ws.onmessage=({data})=>{
        if(epoch!==this.epoch||!this.active)return;
        let packet;try{packet=JSON.parse(data);}catch{return this.fail('invalid_packet',epoch);}
        if(packet.kind==='transcript'&&this.transcriptAt===null){this.transcriptAt=performance.now();this.logTiming('transcript');}
        if(packet.kind==='audio') {
          if(!this.receivedAudio){this.firstAudioAt=performance.now();this.logTiming('first_audio');this.onPacket({kind:'audio_start'});}
          this.receivedAudio=true;this.queue(packet.pcm,packet.rate);
        } else if(packet.kind==='audio_encoded') {
          this.decoding++;
          this.queueEncoded(packet.audio,packet.mime,epoch)
            .catch(()=>this.fail('audio_decode',epoch,'这次声音没能播放，请稍后再试。'))
            .finally(()=>{if(epoch===this.epoch)this.decoding--;});
        } else if(packet.kind==='done') {
          if(packet.gateway_timings){const timings=Object.fromEntries(['local_headers_seconds','transcript_seconds','first_pcm_seconds','total_seconds'].filter(k=>Number.isFinite(packet.gateway_timings[k])).map(k=>[k,packet.gateway_timings[k]]));console.info('wakuku_gateway_timing',JSON.stringify(timings));}
          this.finalText=packet.text;
          this.networkDone=packet;
          if(!this.receivedAudio&&!this.decoding)return this.fail('no_audio',epoch,'这次没有生成声音，可以重新说一句或发送文字。');
          this.watchPlayback(epoch);
        } else if(packet.kind==='error') {
          this.fail(packet.code,epoch,packet.text);
        } else this.onPacket({...packet,inputSource});
      };
      ws.onerror=()=>this.fail('connection',epoch);
      ws.onclose=()=>{if(epoch===this.epoch&&!this.finalText)this.fail('disconnected',epoch);};
      this.deadline=setTimeout(()=>this.fail('timeout',epoch),90000);
    } catch(error) {this.fail(error.message,epoch);}
  }
  watchPlayback(epoch) {
    if(this.finishTimer!=null||epoch!==this.epoch||!this.active)return;
    this.finishTimer=setTimeout(()=>{
      this.finishTimer=null;
      if(epoch!==this.epoch||!this.active)return;
      const clock=this.ctx.currentTime,now=performance.now();
      if(clock>this.clockSeen+.001){this.clockSeen=clock;this.clockAdvancedAt=now;}
      if(this.speechOnsetClock!==null&&this.speechOnsetAt===null&&!this.muted&&this.gain.gain.value>0&&this.ctx.state==='running'&&clock>=this.speechOnsetClock+.015){
        // The output clock has passed at least 15ms of qualifying signal.
        // Subtract polling delay rather than treating packet arrival as speech.
        this.speechOnsetAt=now-Math.max(0,clock-this.speechOnsetClock)*1000;
        this.logTiming('speech_onset');
      }
      // Wall time only detects a stall. It never establishes playback completion.
      if(this.networkDone&&!this.decoding&&this.sources.size===0&&clock>=this.nextTime) {
        const packet=this.networkDone;this.networkDone=null;
        this.active=false;clearTimeout(this.deadline);
        this.reportMouth('playout_complete');
        console.info('wakuku_audio_playout',JSON.stringify({source:packet.source,
          inputSource:this.inputSource,audioContext:this.ctx.state,receivedAudio:this.receivedAudio,muted:this.muted,
          clockSeconds:clock,scheduledEndSeconds:this.nextTime,clockAdvancedSeconds:clock-this.clockBase,
          queuedSources:this.queuedSources,endedSources:this.endedSources,completion:'output_clock_and_sources_ended'}));
        this.logTiming('playout_complete');
        this.onComplete?.(packet.text,packet.source);
        return;
      }
      if(this.sources.size&&now-this.clockAdvancedAt>=4000) {
        console.info('wakuku_audio_playout_blocked',JSON.stringify({reason:'audio_clock_stalled',inputSource:this.inputSource,
          audioContext:this.ctx.state,clockSeconds:clock,scheduledEndSeconds:this.nextTime,
          clockAdvancedSeconds:clock-this.clockBase,stalledMilliseconds:now-this.clockAdvancedAt,
          queuedSources:this.queuedSources,endedSources:this.endedSources,remainingSources:this.sources.size,completion:false}));
        this.fail('audio_clock_stalled',epoch,'声音没有播出来，已暂停这次回应。可以重新说一句或发送文字。');
        return;
      }
      this.watchPlayback(epoch);
    },100);
  }
  queue(encoded,rate=24000) {
    const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
    const view=new DataView(bytes.buffer);
    const buffer=this.ctx.createBuffer(1,Math.floor(bytes.length/2),rate);
    const samples=buffer.getChannelData(0);
    for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;
    this.queueBuffer(buffer);
  }
  async queueEncoded(encoded,mime,epoch) {
    if(typeof encoded!=='string'||encoded.length>4000000||!/^audio\/(mpeg|mp3|wav|wave|x-wav|ogg|mp4)(;|$)/i.test(mime||''))throw Error('invalid_audio');
    const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
    const buffer=await this.ctx.decodeAudioData(bytes.buffer);
    if(epoch!==this.epoch||!this.active)return;
    if(!Number.isFinite(buffer.duration)||buffer.duration<=0||buffer.duration>35)throw Error('invalid_duration');
    if(!this.receivedAudio){this.firstAudioAt=performance.now();this.logTiming('first_audio');this.onPacket({kind:'audio_start'});}
    this.receivedAudio=true;this.queueBuffer(buffer);
  }
  queueBuffer(buffer) {
    const source=this.ctx.createBufferSource();source.buffer=buffer;source.connect(this.gain);
    this.audioSeconds+=buffer.duration;
    this.nextTime=Math.max(this.nextTime||0,this.ctx.currentTime+.045);
    const epoch=this.epoch;
    if(this.clockBase===null){this.clockBase=this.ctx.currentTime;this.clockSeen=this.clockBase;this.clockAdvancedAt=performance.now();}
    this.sources.add(source);this.queuedSources++;
    source.onended=()=>{this.sources.delete(source);source.disconnect();if(epoch===this.epoch)this.endedSources++;};
    this.findSpeechOnset(buffer,this.nextTime);
    source.start(this.nextTime);this.nextTime+=buffer.duration;
    this.watchPlayback(epoch);
  }
  findSpeechOnset(buffer,startClock) {
    if(this.muted||this.speechOnsetAt!==null||this.speechOnsetClock!==null)return;
    const rate=buffer.sampleRate,samples=buffer.getChannelData(0),window=Math.max(1,Math.ceil(rate*.015));
    const tail=this.speechScanTail;
    const contiguous=tail&&tail.rate===rate&&Math.abs(tail.endClock-startClock)<=1/rate;
    const prefix=contiguous?tail.samples:null;
    const joined=new Float32Array((prefix?.length||0)+samples.length);
    if(prefix)joined.set(prefix);joined.set(samples,prefix?.length||0);
    const joinedClock=startClock-(prefix?.length||0)/rate;
    // A 15ms RMS window tolerates natural zero crossings. Requiring its first
    // sample above .01 excludes leading silence from the reported onset.
    let energy=0;for(let i=0;i<Math.min(window,joined.length);i++)energy+=joined[i]*joined[i];
    for(let i=0;i+window<=joined.length;i++){
      if(Math.abs(joined[i])>=.01&&energy/window>=.0001){this.speechOnsetClock=joinedClock+i/rate;this.speechScanTail=null;return;}
      energy-=joined[i]*joined[i];if(i+window<joined.length)energy+=joined[i+window]*joined[i+window];
    }
    this.speechScanTail={samples:joined.slice(-Math.min(window-1,joined.length)),rate,endClock:startClock+buffer.duration};
  }
  logTiming(stage) {
    const elapsed=value=>value===null?null:Math.round(value-this.turnStartedAt);
    console.info('wakuku_turn_timing',JSON.stringify({stage,inputSource:this.inputSource,elapsedMilliseconds:Math.round(performance.now()-this.turnStartedAt),transcriptMilliseconds:elapsed(this.transcriptAt),firstAudioMilliseconds:elapsed(this.firstAudioAt),speechOnsetMilliseconds:elapsed(this.speechOnsetAt)}));
  }
  fail(code,epoch,text) {
    if(epoch!==this.epoch||!this.active)return;
    this.cancel(code);
    this.onPacket({kind:'error',text:text||(code==='not_configured'?
      'Agent 语音尚未配置；请完成本机配置并启动陪伴服务。':
      '语音 Agent 暂未接通。请检查本机服务、模型权限和额度。')});
  }
}
