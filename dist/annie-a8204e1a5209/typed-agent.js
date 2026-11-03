// One typed turn generates audio and its transcript together. No canned fallback.
import {LiveAnalyser} from './core/lipsync.js';

export class TypedAgent {
  constructor({url,onPacket,onComplete}) {
    Object.assign(this,{url,onPacket,onComplete});
    this.sources=new Set(); this.epoch=0; this.muted=false; this.active=false;
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
  setMuted(value) {this.muted=!!value;if(this.gain)this.gain.gain.value=value?0:1;}
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
    this.epoch++; this.active=false;
    clearTimeout(this.finishTimer);this.finishTimer=null;clearTimeout(this.deadline);
    if(this.ws) {
      if(this.ws.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify({kind:'cancel'}));
      this.ws.close(); this.ws=null;
    }
    for(const source of this.sources) {try{source.stop();stoppedSources++;}catch{}}
    this.sources.clear();this.nextTime=0;this.networkDone=null;
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
    this.inputSource=inputSource;this.mouthSamples=0;this.mouthPeak=0;this.audioSeconds=0;
    this.clockBase=null;this.clockSeen=0;this.clockAdvancedAt=0;
    this.queuedSources=0;this.endedSources=0;this.decoding=0;
    try {
      await this.unlock();
      if(epoch!==this.epoch)return;
      this.gain.gain.value=this.muted?0:1;
      if(this.ctx.state!=='running')throw new Error('audio_blocked');
      const endpoint='/local/chat';
      let health;
      // mEnv can sleep between visits. Only the free, read-only health request
      // may be retried; never repeat an inference/speech POST after uncertainty.
      for(const timeout of [2500,5000,10000]) {
        if(epoch!==this.epoch)return;
        try {
          const response=await fetch(this.url+endpoint+'/health',{signal:AbortSignal.timeout(timeout)});
          if(!response.ok)throw Error('health_unavailable');
          health=await response.json();break;
        } catch(error) {if(timeout===10000)throw error;}
      }
      if(epoch!==this.epoch)return;
      if(!health.available)throw new Error('not_configured');
      const ws=new WebSocket(this.url.replace(/^http/,'ws')+(interaction?'/local/interaction/turn':endpoint+'/turn'));
      this.ws=ws;
      ws.onopen=()=>{
        if(epoch!==this.epoch)return ws.close();
        ws.send(JSON.stringify(interaction||{text,context,history:history.slice(-6).map(m=>({...m,text:m.text.slice(0,240)}))}));
      };
      ws.onmessage=({data})=>{
        if(epoch!==this.epoch||!this.active)return;
        let packet;try{packet=JSON.parse(data);}catch{return this.fail('invalid_packet',epoch);}
        if(packet.kind==='audio') {
          if(!this.receivedAudio)this.onPacket({kind:'audio_start'});
          this.receivedAudio=true;this.queue(packet.pcm,packet.rate);
        } else if(packet.kind==='audio_encoded') {
          this.decoding++;
          this.queueEncoded(packet.audio,packet.mime,epoch)
            .catch(()=>this.fail('audio_decode',epoch,'这次声音没能播放，请稍后再试。'))
            .finally(()=>{if(epoch===this.epoch)this.decoding--;});
        } else if(packet.kind==='done') {
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
      // Wall time only detects a stall. It never establishes playback completion.
      if(this.networkDone&&!this.decoding&&this.sources.size===0&&clock>=this.nextTime) {
        const packet=this.networkDone;this.networkDone=null;
        this.active=false;clearTimeout(this.deadline);
        this.reportMouth('playout_complete');
        console.info('wakuku_audio_playout',JSON.stringify({source:packet.source,
          inputSource:this.inputSource,audioContext:this.ctx.state,receivedAudio:this.receivedAudio,muted:this.muted,
          clockSeconds:clock,scheduledEndSeconds:this.nextTime,clockAdvancedSeconds:clock-this.clockBase,
          queuedSources:this.queuedSources,endedSources:this.endedSources,completion:'output_clock_and_sources_ended'}));
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
    if(!this.receivedAudio)this.onPacket({kind:'audio_start'});
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
    source.start(this.nextTime);this.nextTime+=buffer.duration;
    this.watchPlayback(epoch);
  }
  fail(code,epoch,text) {
    if(epoch!==this.epoch||!this.active)return;
    this.cancel(code);
    this.onPacket({kind:'error',text:text||(code==='not_configured'?
      'Agent 语音尚未配置；请完成本机配置并启动陪伴服务。':
      '语音 Agent 暂未接通。请检查本机服务、模型权限和额度。')});
  }
}
