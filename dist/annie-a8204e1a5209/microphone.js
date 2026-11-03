// Real getUserMedia only. Cloud ASR needs explicit in-product consent first.
export class MicrophoneInput {
  constructor({url,onState,onLevel,onText,onError}){Object.assign(this,{url,onState,onLevel,onText,onError});this.epoch=0;this.recording=false;this.active=false;}
  async start(context){
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){this.onState('idle');this.onError('这个手机预览地址支持触摸和打字；麦克风需要 HTTPS 安全连接。');return;}
    this.cancel();const epoch=this.epoch;this.active=true;this.context=context;this.chunks=[];this.samples=0;this.voiced=0;this.lastVoice=0;this.peakRms=0;this.levelFrames=0;
    try{
      this.onState('microphone_permission');
      // The user initiated this call with the game's voice button.
      const ctx=new AudioContext();this.ctx=ctx;await ctx.resume();
      if(epoch!==this.epoch)return;
      const health=await fetch(this.url+'/local/asr/health',{signal:AbortSignal.timeout(2500)}).then(r=>r.json());
      if(epoch!==this.epoch)return;
      if(!health.available)throw new Error('asr_unavailable');
      this.remoteAsr=health.local===false||health.remote_from_browser===true;this.asrConsentCode=health.consent_code||'microphone_audio_to_merouter_asr';this.asrProvider=health.provider||health.model||'local_asr';
      const consentBinding=JSON.stringify([this.asrConsentCode,this.asrProvider,health.processing_location||'provider']);
      if(this.remoteAsr&&this.approvedConsentBinding!==consentBinding) {
        this.cloudConsent=window.confirm(health.consent_text||'语音会发送给 Merouter 做中文识别，用于和 WAKUKU 对话。是否启用云端语音？');
        if(!this.cloudConsent){this.approvedConsentBinding=null;this.cancel();this.onState('idle');return;}
        this.approvedConsentBinding=consentBinding;
      }
      this.recordingConsentBinding=consentBinding;
      const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(epoch!==this.epoch){stream.getTracks().forEach(t=>t.stop());console.info('wakuku_microphone_lifecycle',JSON.stringify({event:'late_stream_closed',tracksStopped:stream.getTracks().length}));return;}
      this.stream=stream;
      await ctx.audioWorklet.addModule(new URL('./mic-capture-worklet.js',import.meta.url));
      // cancel() already closed this attempt. Never release a newer attempt's stream.
      if(epoch!==this.epoch)return;
      this.source=this.ctx.createMediaStreamSource(stream);this.worklet=new AudioWorkletNode(this.ctx,'wakuku-mic-capture');
      this.gain=this.ctx.createGain();this.gain.gain.value=0;
      this.source.connect(this.worklet);this.worklet.connect(this.gain);this.gain.connect(this.ctx.destination);
      this.rate=this.ctx.sampleRate;this.recording=true;this.started=performance.now();this.onState('recording');
      console.info('wakuku_microphone_capture',JSON.stringify({source:'getUserMedia',audioTracks:stream.getAudioTracks().length,sampleRate:this.rate,context:this.ctx.state,asrTarget:this.asrProvider,cloudConsent:!!this.cloudConsent,cloudAudioUpload:false}));
      this.worklet.port.onmessage=({data})=>{
        if(epoch!==this.epoch||!this.recording)return;
        this.chunks.push(data);this.samples+=data.length;
        let sum=0;for(const x of data)sum+=x*x;const rms=Math.sqrt(sum/data.length);
        this.peakRms=Math.max(this.peakRms,rms);this.levelFrames++;
        this.onLevel(Math.min(1,rms*12));
        const now=performance.now(),seconds=data.length/this.rate;
        if(rms>.012){this.voiced+=seconds;this.lastVoice=now;}
        if(this.voiced>.30&&now-this.lastVoice>1000)this.finish();
        else if(now-this.started>12000)this.finish();
      };
      this.limit=setTimeout(()=>this.finish(),12500);
    }catch(error){if(epoch===this.epoch){this.cancel();this.onError(error.name==='NotAllowedError'?'麦克风权限未开启，请在浏览器允许后再试。':error.message==='asr_unavailable'?'中文识别暂时没连上，请稍后再试。':'麦克风暂时无法录音，请检查设备。');}}
  }
  release(){
    clearTimeout(this.limit);this.source?.disconnect();this.worklet?.disconnect();this.gain?.disconnect();
    const tracks=this.stream?.getTracks()||[];tracks.forEach(t=>t.stop());
    if(tracks.length)console.info('wakuku_microphone_levels',JSON.stringify({source:'getUserMedia',audioSeconds:this.samples/(this.rate||48000),voicedSeconds:this.voiced,peakRms:this.peakRms,levelFrames:this.levelFrames,tracksStopped:tracks.length,allTracksEnded:tracks.every(t=>t.readyState==='ended'),audioRetained:false,cloudAudioUpload:false}));
    this.stream=null;this.ctx?.close().catch(()=>{});this.ctx=null;this.recording=false;this.onLevel(0);
  }
  cancel(){const wasActive=this.active,tracks=this.stream?.getTracks().length||0;this.epoch++;this.abort?.abort();this.release();this.chunks=[];this.active=false;if(wasActive)console.info('wakuku_microphone_lifecycle',JSON.stringify({event:'cancel',tracksStopped:tracks}));}
  async finish(){
    if(!this.recording)return;const epoch=this.epoch;
    this.release();
    if(this.voiced<.30){this.active=false;this.onState('idle');this.onError('这次没有听清一句话，再点“说话”试试。');return;}
    const samples=new Float32Array(this.samples);let offset=0;for(const c of this.chunks){samples.set(c,offset);offset+=c.length;}this.chunks=[];
    const ratio=this.rate/16000,count=Math.floor(samples.length/ratio),pcm=new Int16Array(count);
    for(let i=0;i<count;i++){const t=i*ratio,j=Math.floor(t),v=samples[j]*(1-(t-j))+(samples[Math.min(j+1,samples.length-1)]||0)*(t-j);pcm[i]=Math.max(-1,Math.min(1,v))*32767;}
    let binary='';const bytes=new Uint8Array(pcm.buffer);for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    this.onState('transcribing');this.abort=new AbortController();
    try{
      console.info('wakuku_microphone_asr_request',JSON.stringify({source:'getUserMedia',provider:this.asrProvider,rate:16000,pcmBytes:bytes.length,cloudAudioUpload:!!this.remoteAsr,consent:!!this.cloudConsent}));
      const response=await fetch(this.url+'/local/asr/transcribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pcm:btoa(binary),rate:16000,source:'browser_microphone',...(this.remoteAsr&&this.approvedConsentBinding===this.recordingConsentBinding?{consent:this.asrConsentCode}:{})}),signal:this.abort.signal});
      if(!response.ok)throw new Error('asr_failed');const result=await response.json();
      if(epoch!==this.epoch)return;
      const text=String(result.text||'').trim();this.active=false;
      if(!text)throw new Error('empty');
      console.info('wakuku_microphone_transcription',JSON.stringify({source:'browser_microphone',provider:result.provider||this.asrProvider,chars:text.length,audioSeconds:count/16000,asrSeconds:result.processing_seconds,local:result.local!==false,cloudAudioUpload:result.local===false}));
      this.onText(text,this.context);
    }catch(error){if(epoch===this.epoch){this.active=false;this.onState('idle');this.onError('刚才没听清楚，可以再说一次；没有替你猜一句话。');}}
  }
}
