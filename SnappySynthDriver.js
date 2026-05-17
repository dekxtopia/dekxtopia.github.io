/**
 * SnappySynthDriver.js
 * Embedded Synth driver for MPWGL2 — Ported from SnappySynth V2 by GamingMIDI
 * Port by Dekx | Architecture mirrors snappysynth.c / voice.c render pipeline
 *
 * Runs as an AudioWorkletProcessor. The main thread sends MIDI DWORDs
 * (same packed format as SendDirectData / SendMIDIData) via postMessage.
 *
 * Soundfont loading:
 *   - 'load_sf_buffer' message: receives a transferred ArrayBuffer directly
 *     from FileReader (local file upload). No fetch(), no CORS.
 *   - 'reload_sf' message: fetches by URL (requires CORS / same-origin).
 *
 * Settings (passed via port message on init / settings):
 *   numVoices        – polyphony cap  (default 512)
 *   numLayers        – max stacked layers per note (default 4)
 *   velThresh        – 0-127 minimum velocity (default 0)
 *   bufferFrames     – block size hint (default 256, informational)
 *   limiterEnabled   – boolean (default true)
 *   limiterThreshold – linear 0.0-1.0 (default 0.95)
 *   limiterAttack    – seconds (default 0.003)
 *   limiterRelease   – seconds (default 0.25)
 */

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// ── SF2 Mini-Parser ────────────────────────────────────────────────────────────

class SF2Parser {
  constructor(buffer) {
    this.dv  = new DataView(buffer);
    this.buf = buffer;
    this.pos = 0;
  }
  readUint8()  { return this.dv.getUint8(this.pos++); }
  readInt8()   { return this.dv.getInt8(this.pos++); }
  readUint16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  readInt16()  { const v = this.dv.getInt16(this.pos, true);  this.pos += 2; return v; }
  readUint32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  readFourCC() { let s=''; for(let i=0;i<4;i++) s+=String.fromCharCode(this.dv.getUint8(this.pos++)); return s; }
  readString(len) { let s=''; for(let i=0;i<len;i++){const c=this.dv.getUint8(this.pos++);if(c!==0)s+=String.fromCharCode(c);} return s; }
  seek(pos) { this.pos = pos; }

  parse() {
    const riff = this.readFourCC();
    const size = this.readUint32();
    const sfbk = this.readFourCC();
    if (riff !== 'RIFF' || sfbk !== 'sfbk') throw new Error('Not a valid SF2 file');
    const chunks = {};
    while (this.pos < 8 + size) {
      const id = this.readFourCC(), cSz = this.readUint32(), start = this.pos;
      if (id === 'LIST') { const t = this.readFourCC(); chunks[t] = { start: this.pos, size: cSz - 4 }; }
      this.pos = start + cSz;
    }
    let smplData = null;
    if (chunks['sdta']) {
      let p = chunks['sdta'].start, e = p + chunks['sdta'].size;
      while (p < e) {
        this.seek(p);
        const sid = this.readFourCC(), ssz = this.readUint32();
        if (sid === 'smpl') smplData = new Int16Array(this.buf, this.pos, ssz / 2);
        p += 8 + ssz;
      }
    }
    const sc = {};
    if (chunks['pdta']) {
      let p = chunks['pdta'].start, end = p + chunks['pdta'].size;
      while (p < end) {
        this.seek(p);
        const sid = this.readFourCC(), ssz = this.readUint32();
        sc[sid] = { offset: this.pos, size: ssz };
        p += 8 + ssz;
      }
    }
    return this._build(
      this._parsePhdr(sc['phdr']), this._parseBag(sc['pbag']), this._parseGen(sc['pgen']),
      this._parseInst(sc['inst']), this._parseBag(sc['ibag']), this._parseGen(sc['igen']),
      this._parseShdr(sc['shdr']), smplData
    );
  }

  _parsePhdr(c) {
    if (!c) return [];
    this.seek(c.offset);
    const n = c.size / 38, list = [];
    for (let i=0;i<n;i++) {
      const name=this.readString(20),preset=this.readUint16(),bank=this.readUint16(),bagIdx=this.readUint16();
      this.pos+=12; list.push({name,preset,bank,bagIdx});
    }
    return list;
  }
  _parseBag(c) {
    if (!c) return [];
    this.seek(c.offset);
    const n=c.size/4,list=[];
    for(let i=0;i<n;i++){const genIdx=this.readUint16(),modIdx=this.readUint16();list.push({genIdx,modIdx});}
    return list;
  }
  _parseGen(c) {
    if (!c) return [];
    this.seek(c.offset);
    const n=c.size/4,list=[];
    for(let i=0;i<n;i++){const oper=this.readUint16(),amount=this.readInt16();list.push({oper,amount});}
    return list;
  }
  _parseInst(c) {
    if (!c) return [];
    this.seek(c.offset);
    const n=c.size/22,list=[];
    for(let i=0;i<n;i++){const name=this.readString(20),bagIdx=this.readUint16();list.push({name,bagIdx});}
    return list;
  }
  _parseShdr(c) {
    if (!c) return [];
    this.seek(c.offset);
    const n=c.size/46,list=[];
    for(let i=0;i<n;i++){
      const name=this.readString(20),start=this.readUint32(),end=this.readUint32(),
            loopStart=this.readUint32(),loopEnd=this.readUint32(),
            sampleRate=this.readUint32(),originalKey=this.readUint8(),correction=this.readInt8(),
            sampleLink=this.readUint16(),sampleType=this.readUint16();
      list.push({name,start,end,loopStart,loopEnd,sampleRate,originalKey,correction,sampleLink,sampleType});
    }
    return list;
  }

  _build(phdr,pbag,pgen,inst,ibag,igen,shdr,smplData) {
    const G={
      START_OFF:0,END_OFF:1,LSTART_OFF:2,LEND_OFF:3,START_COARSE:4,END_COARSE:12,PAN:17,
      VENV_DELAY:33,VENV_ATTACK:34,VENV_HOLD:35,VENV_DECAY:36,VENV_SUSTAIN:37,VENV_RELEASE:38,
      INSTRUMENT:41,KEY_RANGE:43,VEL_RANGE:44,LSTART_COARSE:45,ATTENUATION:48,LEND_COARSE:50,
      COARSE_TUNE:51,FINE_TUNE:52,SAMPLE_ID:53,SAMPLE_MODES:54,SCALE_TUNING:56,
      EXCLUSIVE_CLASS:57,ROOT_KEY:58,
    };
    const tc2s = tc => tc <= -32768 ? 0.0001 : Math.pow(2, tc / 1200);
    const regions = [];
    for (let pi=0;pi<phdr.length-1;pi++) {
      const p=phdr[pi], pBagEnd=phdr[pi+1].bagIdx;
      for (let bi=p.bagIdx;bi<pBagEnd;bi++) {
        const pgEnd=bi+1<pbag.length?pbag[bi+1].genIdx:pgen.length;
        const pG={};
        for(let gi=pbag[bi].genIdx;gi<pgEnd;gi++) pG[pgen[gi].oper]=pgen[gi].amount;
        const instIdx=pG[G.INSTRUMENT];
        if(instIdx===undefined||instIdx>=inst.length-1) continue;
        const iBagEnd=inst[instIdx+1].bagIdx;
        for(let ibi=inst[instIdx].bagIdx;ibi<iBagEnd;ibi++) {
          const igEnd=ibi+1<ibag.length?ibag[ibi+1].genIdx:igen.length;
          const iG={};
          for(let gi=ibag[ibi].genIdx;gi<igEnd;gi++) iG[igen[gi].oper]=igen[gi].amount;
          const sIdx=iG[G.SAMPLE_ID]; if(sIdx===undefined) continue;
          const smp=shdr[sIdx]; if(!smp) continue;
          const krR=iG[G.KEY_RANGE],vrR=iG[G.VEL_RANGE];
          const keyLo=krR!==undefined?(krR&0xFF):0,keyHi=krR!==undefined?((krR>>8)&0xFF):127;
          const velLo=vrR!==undefined?(vrR&0xFF):0,velHi=vrR!==undefined?((vrR>>8)&0xFF):127;
          const rootKey=iG[G.ROOT_KEY]!==undefined?iG[G.ROOT_KEY]:smp.originalKey;
          const coarseTune=(iG[G.COARSE_TUNE]||0)+(pG[G.COARSE_TUNE]||0);
          const fineTune=(iG[G.FINE_TUNE]||0)+(pG[G.FINE_TUNE]||0)+smp.correction;
          const scaleTune=iG[G.SCALE_TUNING]!==undefined?iG[G.SCALE_TUNING]:100;
          const atten=(iG[G.ATTENUATION]||0)+(pG[G.ATTENUATION]||0);
          const gain=Math.pow(10,-atten/200);
          const pan=clamp(((iG[G.PAN]||0)+(pG[G.PAN]||0))/500,-1,1);
          const loopMode=(iG[G.SAMPLE_MODES]||0)&0x03;
          const exClass=iG[G.EXCLUSIVE_CLASS]||0;
          const startOff=(iG[G.START_OFF]||0)+(iG[G.START_COARSE]||0)*32768;
          const endOff=(iG[G.END_OFF]||0)+(iG[G.END_COARSE]||0)*32768;
          const lsOff=(iG[G.LSTART_OFF]||0)+(iG[G.LSTART_COARSE]||0)*32768;
          const leOff=(iG[G.LEND_OFF]||0)+(iG[G.LEND_COARSE]||0)*32768;
          regions.push({
            bank:p.bank,preset:p.preset,keyLo,keyHi,velLo,velHi,
            rootKey,coarseTune,fineTune,scaleTune,gain,pan,loopMode,exClass,
            volDelay:  tc2s(iG[G.VENV_DELAY]  !==undefined?iG[G.VENV_DELAY]  :-12000),
            volAttack: tc2s(iG[G.VENV_ATTACK] !==undefined?iG[G.VENV_ATTACK] :-12000),
            volHold:   tc2s(iG[G.VENV_HOLD]   !==undefined?iG[G.VENV_HOLD]   :-12000),
            volDecay:  tc2s(iG[G.VENV_DECAY]  !==undefined?iG[G.VENV_DECAY]  :-12000),
            volSustain:clamp(1-(iG[G.VENV_SUSTAIN]||0)/1000,0,1),
            volRelease:tc2s(iG[G.VENV_RELEASE]!==undefined?iG[G.VENV_RELEASE]:-12000),
            sample:{
              data:smplData,
              start:smp.start+startOff,end:smp.end+endOff,
              loopStart:smp.loopStart+lsOff,loopEnd:smp.loopEnd+leOff,
              sampleRate:smp.sampleRate,name:smp.name,
            }
          });
        }
      }
    }
    return regions;
  }
}

// ── Voice States (mirrors voice.c) ───────────────────────────────────────────────
const V_IDLE=0,V_DELAY=1,V_ATTACK=2,V_HOLD=3,V_DECAY=4,V_SUSTAIN=5,V_RELEASE=6;

class Voice {
  constructor(){this.state=V_IDLE;this.region=null;this._sustainHeld=false;}
  noteOn(region,ch,note,vel,sr,gain,panL,panR){
    this.region=region;this.channel=ch;this.note=note;this.velocity=vel;
    this.gain=gain;this.panL=panL;this.panR=panR;this.exClass=region.exClass;
    this._sustainHeld=false;
    const semis=(note-region.rootKey)*(region.scaleTune/100.0)+region.coarseTune;
    this.phaseInc=(region.sample.sampleRate/sr)*Math.pow(2,semis/12)*Math.pow(2,region.fineTune/1200);
    this.phase=region.sample.start;this.envLevel=0;
    this.delayLeft=Math.round(region.volDelay*sr);
    this.attackLeft=Math.max(1,Math.round(region.volAttack*sr));
    this.holdLeft=Math.round(region.volHold*sr);
    this.decayCoeff=region.volDecay>0.0001?Math.exp(-Math.log(1000)/(region.volDecay*sr)):0;
    this.sustainLevel=region.volSustain;
    this.releaseCoeff=region.volRelease>0.0001?Math.exp(-Math.log(1000)/(region.volRelease*sr)):0;
    this.state=this.delayLeft>0?V_DELAY:V_ATTACK;
  }
  noteOff(){if(this.state!==V_IDLE&&this.state!==V_RELEASE)this.state=V_RELEASE;}
  render(outL,outR,i){
    if(this.state===V_IDLE)return;
    const smp=this.region.sample;
    let env=this.envLevel;
    if(this.state===V_DELAY){
      if(--this.delayLeft<=0)this.state=V_ATTACK;
      env=0;
    }else if(this.state===V_ATTACK){
      env+=1/this.attackLeft;
      if(--this.attackLeft<=0||env>=1){env=1;this.state=this.holdLeft>0?V_HOLD:V_DECAY;}
    }else if(this.state===V_HOLD){
      env=1;if(--this.holdLeft<=0)this.state=V_DECAY;
    }else if(this.state===V_DECAY){
      env=this.decayCoeff>0?env*this.decayCoeff:this.sustainLevel;
      if(env<=this.sustainLevel+0.001){env=this.sustainLevel;this.state=V_SUSTAIN;}
    }else if(this.state===V_SUSTAIN){
      env=this.sustainLevel;
    }else if(this.state===V_RELEASE){
      env=this.releaseCoeff>0?env*this.releaseCoeff:0;
      if(env<0.0001){this.state=V_IDLE;this.envLevel=0;return;}
    }
    this.envLevel=env;
    const p=this.phase,pi=p|0,pf=p-pi,data=smp.data;
    if(pi>=smp.end-1){
      if(this.region.loopMode>=1){this.phase=smp.loopStart+(p-smp.loopEnd);}
      else{this.state=V_IDLE;return;}
    }
    const s=(data[pi]+(data[pi+1]-data[pi])*pf)/32768.0;
    this.phase+=this.phaseInc;
    if(this.region.loopMode>=1&&this.phase>=smp.loopEnd)
      this.phase=smp.loopStart+(this.phase-smp.loopEnd);
    const out=s*env*this.gain;
    outL[i]+=out*this.panL;
    outR[i]+=out*this.panR;
  }
}

// ── Limiter (mirrors SnappySynth output stage) ────────────────────────────────
class Limiter {
  constructor(sr,threshold=0.95,attack=0.003,release=0.25){
    this.enabled=true;this.threshold=threshold;this.gain=1.0;
    this.attackCoeff=Math.exp(-1/(sr*attack));
    this.releaseCoeff=Math.exp(-1/(sr*release));
  }
  process(L,R,i){
    if(!this.enabled)return;
    const peak=Math.max(Math.abs(L[i]),Math.abs(R[i]));
    if(peak*this.gain>this.threshold){
      this.gain=(this.threshold/peak)*this.attackCoeff+this.gain*(1-this.attackCoeff);
      if(this.gain<0)this.gain=0;
    }else{
      this.gain=Math.min(1,this.gain+(1-this.gain)*(1-this.releaseCoeff));
    }
    L[i]*=this.gain;R[i]*=this.gain;
  }
}

// ── Channel State ─────────────────────────────────────────────────────────────
class ChannelState {
  constructor(){this.program=0;this.bank=0;this.pitchBend=0;
    this.volume=100/127;this.expression=1;this.pan=0;
    this.sustain=false;this.isDrum=false;}
  reset(){this.volume=100/127;this.expression=1;this.pan=0;this.sustain=false;this.pitchBend=0;}
}

// ── AudioWorkletProcessor ─────────────────────────────────────────────────────────
class SnappySynthProcessor extends AudioWorkletProcessor {
  constructor(options){
    super(options);
    this.sr=sampleRate;
    this.numVoices=512;this.numLayers=4;this.velThresh=0;
    this.regions=null;
    this.voices=Array.from({length:512},()=>new Voice());
    this.channels=Array.from({length:16},()=>new ChannelState());
    this.channels[9].isDrum=true;
    this.masterVol=1.0;
    this.limiter=new Limiter(sampleRate);
    this.ready=false;
    this.midiQueue=[];
    this._frameCount=0;
    this.port.onmessage=e=>this._onMessage(e.data);
  }

  _onMessage(d){
    switch(d.type){
      case 'init':
        this._applySettings(d.settings);
        if(d.settings.soundfontUrl) this._loadSFUrl(d.settings.soundfontUrl);
        break;
      case 'settings':      this._applySettings(d.settings); break;
      case 'midi':          this.midiQueue.push(d.dword); break;
      case 'midi_batch':    for(const w of d.dwords) this.midiQueue.push(w); break;
      case 'reset':         this._panic(); break;
      case 'reload_sf':     this._loadSFUrl(d.url); break;
      // ─ Local file: ArrayBuffer transferred from FileReader — no fetch/CORS ─
      case 'load_sf_buffer': this._loadSFBuffer(d.buffer, d.filename); break;
    }
  }

  _applySettings(s){
    if(s.numVoices!==undefined){
      this.numVoices=s.numVoices;
      while(this.voices.length<this.numVoices) this.voices.push(new Voice());
    }
    if(s.numLayers!==undefined)   this.numLayers=s.numLayers;
    if(s.velThresh!==undefined)   this.velThresh=s.velThresh;
    if(s.masterVol!==undefined)   this.masterVol=s.masterVol;
    if(s.limiterEnabled!==undefined)   this.limiter.enabled=s.limiterEnabled;
    if(s.limiterThreshold!==undefined) this.limiter.threshold=s.limiterThreshold;
    if(s.limiterAttack!==undefined)    this.limiter.attackCoeff=Math.exp(-1/(this.sr*s.limiterAttack));
    if(s.limiterRelease!==undefined)   this.limiter.releaseCoeff=Math.exp(-1/(this.sr*s.limiterRelease));
  }

  // Parse an ArrayBuffer that was transferred from the main thread (FileReader result).
  // This is the primary path for local file uploads — synchronous, zero CORS overhead.
  _loadSFBuffer(buffer, filename){
    this.ready=false;
    this.port.postMessage({type:'sf_loading'});
    try{
      const parser=new SF2Parser(buffer);
      this.regions=parser.parse();
      this.ready=true;
      this.port.postMessage({type:'sf_loaded',regionCount:this.regions.length,filename});
    }catch(err){
      this.port.postMessage({type:'sf_error',message:err.message});
    }
  }

  // Fetch by URL (fallback, needs CORS / same-origin)
  async _loadSFUrl(url){
    if(!url) return;
    this.ready=false;
    this.port.postMessage({type:'sf_loading'});
    try{
      const resp=await fetch(url);
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      const buf=await resp.arrayBuffer();
      this.regions=new SF2Parser(buf).parse();
      this.ready=true;
      this.port.postMessage({type:'sf_loaded',regionCount:this.regions.length});
    }catch(err){
      this.port.postMessage({type:'sf_error',message:err.message});
    }
  }

  _dispatch(dword){
    const status=dword&0xFF,cmd=status&0xF0,ch=status&0x0F;
    const b1=(dword>>8)&0xFF,b2=(dword>>16)&0xFF;
    switch(cmd){
      case 0x90: b2>0?this._noteOn(ch,b1,b2):this._noteOff(ch,b1); break;
      case 0x80: this._noteOff(ch,b1); break;
      case 0xB0: this._cc(ch,b1,b2); break;
      case 0xC0: this.channels[ch].program=b1; break;
      case 0xE0: this.channels[ch].pitchBend=((b2<<7|b1)-8192)/8192; break;
    }
  }

  _noteOn(ch,note,vel){
    if(vel<this.velThresh||!this.regions) return;
    const chan=this.channels[ch],bank=chan.isDrum?128:chan.bank,prog=chan.program;
    let layers=0;
    for(const r of this.regions){
      if(layers>=this.numLayers) break;
      if(r.bank!==bank&&!(chan.isDrum&&r.bank===128)) continue;
      if(r.preset!==prog) continue;
      if(note<r.keyLo||note>r.keyHi) continue;
      if(vel<r.velLo||vel>r.velHi) continue;
      if(r.exClass>0){
        for(const v of this.voices)
          if(v.state!==V_IDLE&&v.channel===ch&&v.exClass===r.exClass) v.state=V_IDLE;
      }
      const voice=this._steal(); if(!voice) continue;
      const vol=chan.volume*chan.expression*(vel/127)*r.gain*this.masterVol;
      const pan=clamp(chan.pan+r.pan,-1,1),angle=(pan+1)*Math.PI/4;
      voice.noteOn(r,ch,note,vel,this.sr,vol,Math.cos(angle),Math.sin(angle));
      layers++;
    }
  }

  _noteOff(ch,note){
    for(const v of this.voices)
      if(v.state!==V_IDLE&&v.channel===ch&&v.note===note){
        if(this.channels[ch].sustain) v._sustainHeld=true;
        else v.noteOff();
      }
  }

  _cc(ch,cc,val){
    const c=this.channels[ch];
    if(cc===7)        c.volume=val/127;
    else if(cc===11)  c.expression=val/127;
    else if(cc===10)  c.pan=(val-64)/63;
    else if(cc===0)   c.bank=val;
    else if(cc===64){
      c.sustain=val>=64;
      if(!c.sustain)
        for(const v of this.voices)
          if(v.channel===ch&&v._sustainHeld){v._sustainHeld=false;v.noteOff();}
    }
    else if(cc===120||cc===123)
      for(const v of this.voices) if(v.channel===ch&&v.state!==V_IDLE) v.noteOff();
    else if(cc===121) c.reset();
  }

  _panic(){for(const v of this.voices) v.state=V_IDLE;}

  _steal(){
    for(const v of this.voices) if(v.state===V_IDLE) return v;
    let best=null,bestE=Infinity;
    for(const v of this.voices) if(v.state===V_RELEASE&&v.envLevel<bestE){best=v;bestE=v.envLevel;}
    return best||this.voices[0];
  }

  process(_inputs,outputs){
    const out=outputs[0];
    if(!out||!out[0]) return true;
    const outL=out[0],outR=out.length>1?out[1]:out[0],len=outL.length;
    const batch=this.midiQueue.splice(0,this.midiQueue.length);
    for(const dw of batch) this._dispatch(dw);
    outL.fill(0);
    if(outR!==outL) outR.fill(0);
    if(!this.ready) return true;
    for(const v of this.voices){
      if(v.state===V_IDLE) continue;
      for(let i=0;i<len;i++) v.render(outL,outR,i);
    }
    for(let i=0;i<len;i++) this.limiter.process(outL,outR,i);
    if((++this._frameCount&511)===0){
      const active=this.voices.filter(v=>v.state!==V_IDLE).length;
      this.port.postMessage({type:'stats',activeVoices:active});
    }
    return true;
  }
}

registerProcessor('snappy-synth',SnappySynthProcessor);
