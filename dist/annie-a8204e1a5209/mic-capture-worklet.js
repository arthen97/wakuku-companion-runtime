class WakukuMicCapture extends AudioWorkletProcessor {
  constructor(){super();this.buffer=new Float32Array(2048);this.offset=0;}
  process(inputs){
    const channels=inputs[0];if(!channels?.length)return true;
    for(let i=0;i<channels[0].length;i++){
      let value=0;for(const c of channels)value+=c[i]/channels.length;
      this.buffer[this.offset++]=value;
      if(this.offset===this.buffer.length){this.port.postMessage(this.buffer.slice());this.offset=0;}
    }
    return true;
  }
}
registerProcessor('wakuku-mic-capture',WakukuMicCapture);
