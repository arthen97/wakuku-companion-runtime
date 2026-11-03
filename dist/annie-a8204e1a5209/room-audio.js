// The single-thread Web export's engine audio clock did not advance in the IAB.
// Use the same browser AudioContext route that already plays Qwen successfully.
const gainFromDb=db=>Math.pow(10,db/20);
const asset=name=>new URL('../room-audio/'+name,import.meta.url);
export class RoomAudio {
  constructor(){
    this.state='idle';this.muted=false;this.musicMuted=false;this.buffers=new Map();this.effects=[];
    this.unlock=this.unlock.bind(this);
    document.addEventListener('pointerdown',this.unlock,{capture:true});
    document.addEventListener('keydown',this.unlock,{capture:true});
  }
  async unlock(){
    if(this.closed)return;
    if(!this.ctx){
      this.ctx=new AudioContext();
      this.musicGain=this.ctx.createGain();this.airGain=this.ctx.createGain();
      this.musicGain.gain.value=0;this.airGain.gain.value=0;
      this.analyser=this.ctx.createAnalyser();this.analyser.fftSize=1024;
      this.musicGain.connect(this.analyser);this.analyser.connect(this.ctx.destination);
      this.airGain.connect(this.ctx.destination);this.meter=new Float32Array(1024);
      this.applyGain();
    }
    try{
      await this.ctx.resume();
      if(!this.loading)this.loading=Promise.all(['cozy-home-loop.ogg','air.wav'].map(n=>this.load(n)));
      await this.loading;if(!this.closed)this.start();
    }catch{console.warn('wakuku_room_audio_unavailable','Local room audio could not start; dialogue remains available.');}
  }
  async load(name){
    if(!this.buffers.has(name))this.buffers.set(name,fetch(asset(name)).then(r=>{if(!r.ok)throw new Error('room_audio_asset');return r.arrayBuffer();}).then(b=>this.ctx.decodeAudioData(b)));
    return this.buffers.get(name);
  }
  start(){
    if(this.muted||this.music||this.ctx.state!=='running')return;
    const music=this.ctx.createBufferSource(),air=this.ctx.createBufferSource();
    Promise.all([this.load('cozy-home-loop.ogg'),this.load('air.wav')]).then(([m,a])=>{
      if(this.closed||this.muted||this.music||this.ctx.state!=='running')return;
      music.buffer=m;air.buffer=a;music.loop=air.loop=true;
      music.connect(this.musicGain);air.connect(this.airGain);
      this.music=music;this.air=air;this.started=this.ctx.currentTime;this.loopCount=0;
      music.start();air.start();this.applyGain();this.reportAt=performance.now()+1000;
    });
  }
  setMix(state,muted,musicMuted=false){this.state=state;this.musicMuted=!!musicMuted;this.setMuted(muted);this.applyGain();this.reportAt=performance.now()+1000;}
  setMuted(value){
    this.muted=!!value;
    if(value){
      this.music?.stop();this.air?.stop();this.music=this.air=null;
      for(const source of this.effects)try{source.stop();}catch{}
      this.effects=[];
    }else if(this.ctx?.state==='running')this.start();
    this.applyGain();this.reportAt=performance.now()+1000;
  }
  applyGain(){
    if(!this.ctx)return;
    const musicDb=this.state==='recording'?-55:this.state==='speaking'?-29:-16;
    const airDb=this.state==='recording'?-55:this.state==='speaking'?-42:-32;
    this.musicGain.gain.setTargetAtTime(this.muted||this.musicMuted?0:gainFromDb(musicDb),this.ctx.currentTime,.12);
    this.airGain.gain.setTargetAtTime(this.muted?0:gainFromDb(airDb),this.ctx.currentTime,.12);
  }
  async effect(name){
    if(this.muted||!['tap','eat','brush','ball'].includes(name))return;
    await this.unlock();const requested=performance.now();
    const buffer=await this.load(name+'.wav');
    if(this.closed||this.muted||performance.now()-requested>500)return;
    if(this.effects.length>=3)try{this.effects.shift().stop();}catch{}
    const source=this.ctx.createBufferSource(),gain=this.ctx.createGain();source.buffer=buffer;
    gain.gain.value=gainFromDb(-14);source.connect(gain);gain.connect(this.ctx.destination);
    this.effects.push(source);source.onended=()=>{this.effects=this.effects.filter(s=>s!==source);source.disconnect();gain.disconnect();};source.start();
  }
  tick(){
    if(!this.ctx)return;
    const elapsed=this.music?this.ctx.currentTime-this.started:0;
    const loops=this.music?Math.floor(elapsed/this.music.buffer.duration):0;
    if(loops>this.loopCount){this.loopCount=loops;this.report('loop_crossed');}
    if(this.reportAt&&performance.now()>=this.reportAt){this.reportAt=0;this.report('mix_settled');}
  }
  report(event){
    this.analyser.getFloatTimeDomainData(this.meter);
    const rms=Math.sqrt(this.meter.reduce((sum,x)=>sum+x*x,0)/this.meter.length);
    console.info('wakuku_room_audio',JSON.stringify({event,state:this.muted?'muted':this.state,source:'merouter_eleven_music_cozy_home_loop',context:this.ctx.state,playing:!!this.music,clockSeconds:this.ctx.currentTime,playbackSeconds:this.music?(this.ctx.currentTime-this.started)%this.music.buffer.duration:0,loopCount:this.loopCount||0,durationSeconds:this.music?.buffer.duration,musicGainDb:20*Math.log10(Math.max(1e-10,this.musicGain.gain.value)),rms,muted:this.muted,musicMuted:this.musicMuted}));
  }
  close(){this.closed=true;this.setMuted(true);this.ctx?.close();document.removeEventListener('pointerdown',this.unlock,{capture:true});document.removeEventListener('keydown',this.unlock,{capture:true});}
}
