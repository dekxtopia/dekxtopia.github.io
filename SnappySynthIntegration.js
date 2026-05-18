/**
 * SnappySynthIntegration.js + SnappySynthDriver (inlined)
 *
 * The AudioWorklet processor code is embedded as a string literal and
 * registered via Blob URL — zero network requests, works from file://,
 * http:// and https:// without any CORS configuration.
 *
 * Flow:
 *   MPWGL2 → midiOutput.send(data) → ssBridge.sendDword(dword)
 *   → worklet port → process() → outputs[0] → AudioContext.destination → speakers
 *
 * Fix: instead of patching the local _enqueueMidi function (not on window),
 * we inject a fake midiOutput object. MPWGL2 checks `midiEnabled && midiOutput`
 * before sending — so when SnappySynth tab is active we set window.midiEnabled=true
 * and window.midiOutput = fakeOutput, which calls ssBridge.sendDword().
 */

// ═════════════════════════════════════════════════════════════════════════════
// INLINED DRIVER SOURCE — SnappySynthDriver.js embedded as a template literal.
// ═════════════════════════════════════════════════════════════════════════════
const _SS_DRIVER_SRC = `
'use strict';
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const tc2s  = tc => tc <= -32768 ? 0.0001 : Math.pow(2, tc / 1200);

class SF2Parser {
  constructor(buf) { this.dv = new DataView(buf); this.buf = buf; this.pos = 0; }
  u8()  { return this.dv.getUint8(this.pos++); }
  i8()  { return this.dv.getInt8(this.pos++); }
  u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { const v = this.dv.getInt16(this.pos,  true); this.pos += 2; return v; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  cc()  { let s = ''; for (let i = 0; i < 4; i++) s += String.fromCharCode(this.dv.getUint8(this.pos++)); return s; }
  str(n){ let s = ''; for (let i = 0; i < n; i++) { const c = this.dv.getUint8(this.pos++); if (c) s += String.fromCharCode(c); } return s; }
  seek(p){ this.pos = p; }
  parse() {
    if (this.cc() !== 'RIFF') throw new Error('Not a valid SF2 (no RIFF)');
    const riffSize = this.u32();
    if (this.cc() !== 'sfbk') throw new Error('Not a valid SF2 (no sfbk)');
    const chunks = {};
    while (this.pos < 8 + riffSize) {
      const id = this.cc(), sz = this.u32(), start = this.pos;
      if (id === 'LIST') { const t = this.cc(); chunks[t] = { start: this.pos, size: sz - 4 }; }
      this.pos = start + sz;
    }
    let smpl = null;
    if (chunks['sdta']) {
      let p = chunks['sdta'].start, e = p + chunks['sdta'].size;
      while (p < e) {
        this.seek(p);
        const sid = this.cc(), ssz = this.u32();
        if (sid === 'smpl') smpl = new Int16Array(this.buf, this.pos, ssz >> 1);
        p += 8 + ssz;
      }
    }
    if (!smpl) throw new Error('SF2 has no smpl chunk');
    const sc = {};
    if (chunks['pdta']) {
      let p = chunks['pdta'].start, end = p + chunks['pdta'].size;
      while (p < end) {
        this.seek(p);
        const sid = this.cc(), ssz = this.u32();
        sc[sid] = { offset: this.pos, size: ssz };
        p += 8 + ssz;
      }
    }
    const phdr = this._phdr(sc['phdr']);
    const pbag = this._bag(sc['pbag']);
    const pgen = this._gen(sc['pgen']);
    const inst = this._inst(sc['inst']);
    const ibag = this._bag(sc['ibag']);
    const igen = this._gen(sc['igen']);
    const shdr = this._shdr(sc['shdr']);
    return this._build(phdr, pbag, pgen, inst, ibag, igen, shdr, smpl);
  }
  _phdr(c) {
    if (!c) return [];
    this.seek(c.offset);
    const n = (c.size / 38) | 0, list = [];
    for (let i = 0; i < n; i++) {
      const name = this.str(20), preset = this.u16(), bank = this.u16(), bagIdx = this.u16();
      this.pos += 12;
      list.push({ name, preset, bank, bagIdx });
    }
    return list;
  }
  _bag(c) {
    if (!c) return [];
    this.seek(c.offset);
    const n = (c.size / 4) | 0, list = [];
    for (let i = 0; i < n; i++) { const genIdx = this.u16(), modIdx = this.u16(); list.push({ genIdx, modIdx }); }
    return list;
  }
  _gen(c) {
    if (!c) return [];
    this.seek(c.offset);
    const n = (c.size / 4) | 0, list = [];
    for (let i = 0; i < n; i++) { const oper = this.u16(), amount = this.i16(); list.push({ oper, amount }); }
    return list;
  }
  _inst(c) {
    if (!c) return [];
    this.seek(c.offset);
    const n = (c.size / 22) | 0, list = [];
    for (let i = 0; i < n; i++) { const name = this.str(20), bagIdx = this.u16(); list.push({ name, bagIdx }); }
    return list;
  }
  _shdr(c) {
    if (!c) return [];
    this.seek(c.offset);
    const n = (c.size / 46) | 0, list = [];
    for (let i = 0; i < n; i++) {
      const name = this.str(20), start = this.u32(), end = this.u32(),
            loopStart = this.u32(), loopEnd = this.u32(),
            sampleRate = this.u32(), originalKey = this.u8(), correction = this.i8(),
            sampleLink = this.u16(), sampleType = this.u16();
      list.push({ name, start, end, loopStart, loopEnd, sampleRate, originalKey, correction, sampleLink, sampleType });
    }
    return list;
  }
  _build(phdr, pbag, pgen, inst, ibag, igen, shdr, smpl) {
    const G = {
      START_OFF:0,END_OFF:1,LSTART_OFF:2,LEND_OFF:3,START_COARSE:4,END_COARSE:12,
      PAN:17,VENV_DELAY:33,VENV_ATTACK:34,VENV_HOLD:35,VENV_DECAY:36,VENV_SUSTAIN:37,
      VENV_RELEASE:38,INSTRUMENT:41,KEY_RANGE:43,VEL_RANGE:44,LSTART_COARSE:45,
      ATTENUATION:48,LEND_COARSE:50,COARSE_TUNE:51,FINE_TUNE:52,SAMPLE_ID:53,
      SAMPLE_MODES:54,SCALE_TUNING:56,EXCLUSIVE_CLASS:57,ROOT_KEY:58,
    };
    const regions = [];
    for (let pi = 0; pi < phdr.length - 1; pi++) {
      const p = phdr[pi], pBagEnd = phdr[pi + 1].bagIdx;
      for (let bi = p.bagIdx; bi < pBagEnd; bi++) {
        const pgEnd = bi + 1 < pbag.length ? pbag[bi + 1].genIdx : pgen.length;
        const pG = {};
        for (let gi = pbag[bi].genIdx; gi < pgEnd; gi++) pG[pgen[gi].oper] = pgen[gi].amount;
        const instIdx = pG[G.INSTRUMENT];
        if (instIdx === undefined || instIdx >= inst.length - 1) continue;
        const iBagEnd = inst[instIdx + 1].bagIdx;
        for (let ibi = inst[instIdx].bagIdx; ibi < iBagEnd; ibi++) {
          const igEnd = ibi + 1 < ibag.length ? ibag[ibi + 1].genIdx : igen.length;
          const iG = {};
          for (let gi = ibag[ibi].genIdx; gi < igEnd; gi++) iG[igen[gi].oper] = igen[gi].amount;
          const sIdx = iG[G.SAMPLE_ID];
          if (sIdx === undefined) continue;
          const smp = shdr[sIdx];
          if (!smp || smp.sampleType === 0) continue;
          const krR = iG[G.KEY_RANGE], vrR = iG[G.VEL_RANGE];
          const keyLo = krR !== undefined ? (krR & 0xFF) : 0;
          const keyHi = krR !== undefined ? ((krR >> 8) & 0xFF) : 127;
          const velLo = vrR !== undefined ? (vrR & 0xFF) : 0;
          const velHi = vrR !== undefined ? ((vrR >> 8) & 0xFF) : 127;
          const rootKey    = iG[G.ROOT_KEY] !== undefined ? iG[G.ROOT_KEY] : smp.originalKey;
          const coarseTune = (iG[G.COARSE_TUNE] || 0) + (pG[G.COARSE_TUNE] || 0);
          const fineTune   = (iG[G.FINE_TUNE]   || 0) + (pG[G.FINE_TUNE]   || 0) + smp.correction;
          const scaleTune  = iG[G.SCALE_TUNING] !== undefined ? iG[G.SCALE_TUNING] : 100;
          const atten      = (iG[G.ATTENUATION] || 0) + (pG[G.ATTENUATION] || 0);
          const gain       = Math.pow(10, -atten / 200);
          const pan        = clamp(((iG[G.PAN] || 0) + (pG[G.PAN] || 0)) / 500, -1, 1);
          const loopMode   = (iG[G.SAMPLE_MODES] || 0) & 0x03;
          const exClass    = iG[G.EXCLUSIVE_CLASS] || 0;
          const startOff   = (iG[G.START_OFF]    || 0) + (iG[G.START_COARSE]  || 0) * 32768;
          const endOff     = (iG[G.END_OFF]      || 0) + (iG[G.END_COARSE]    || 0) * 32768;
          const lsOff      = (iG[G.LSTART_OFF]   || 0) + (iG[G.LSTART_COARSE] || 0) * 32768;
          const leOff      = (iG[G.LEND_OFF]     || 0) + (iG[G.LEND_COARSE]   || 0) * 32768;
          regions.push({
            bank: p.bank, preset: p.preset, keyLo, keyHi, velLo, velHi,
            rootKey, coarseTune, fineTune, scaleTune, gain, pan, loopMode, exClass,
            volDelay:   tc2s(iG[G.VENV_DELAY]   !== undefined ? iG[G.VENV_DELAY]   : -12000),
            volAttack:  tc2s(iG[G.VENV_ATTACK]  !== undefined ? iG[G.VENV_ATTACK]  : -12000),
            volHold:    tc2s(iG[G.VENV_HOLD]    !== undefined ? iG[G.VENV_HOLD]    : -12000),
            volDecay:   tc2s(iG[G.VENV_DECAY]   !== undefined ? iG[G.VENV_DECAY]   : -12000),
            volSustain: clamp(1 - (iG[G.VENV_SUSTAIN] || 0) / 1000, 0, 1),
            volRelease: tc2s(iG[G.VENV_RELEASE] !== undefined ? iG[G.VENV_RELEASE] : -12000),
            sample: {
              data: smpl,
              start:     smp.start     + startOff,
              end:       smp.end       + endOff,
              loopStart: smp.loopStart + lsOff,
              loopEnd:   smp.loopEnd   + leOff,
              sampleRate: smp.sampleRate,
            },
          });
        }
      }
    }
    return regions;
  }
}

const V_IDLE=0,V_DELAY=1,V_ATTACK=2,V_HOLD=3,V_DECAY=4,V_SUSTAIN=5,V_RELEASE=6;

class Voice {
  constructor() { this.state = V_IDLE; this.region = null; this._sustainHeld = false; }
  noteOn(region, ch, note, vel, sr, gainVol, panL, panR) {
    this.region = region; this.channel = ch; this.note = note;
    this.gainVol = gainVol; this.panL = panL; this.panR = panR;
    this.exClass = region.exClass; this._sustainHeld = false;
    const semis = (note - region.rootKey) * (region.scaleTune / 100) + region.coarseTune;
    this.phaseInc = (region.sample.sampleRate / sr)
                  * Math.pow(2, semis / 12)
                  * Math.pow(2, region.fineTune / 1200);
    this.phase = region.sample.start;
    this.envLevel = 0;
    this.delayLeft  = Math.round(region.volDelay   * sr);
    this.attackLeft = Math.max(1, Math.round(region.volAttack * sr));
    this.holdLeft   = Math.round(region.volHold    * sr);
    this.decayCoeff = region.volDecay > 0.0001 ? Math.exp(-Math.log(1000) / (region.volDecay * sr)) : 0;
    this.sustainLvl = region.volSustain;
    this.relCoeff   = region.volRelease > 0.0001 ? Math.exp(-Math.log(1000) / (region.volRelease * sr)) : 0;
    this.state = this.delayLeft > 0 ? V_DELAY : V_ATTACK;
  }
  noteOff() { if (this.state !== V_IDLE && this.state !== V_RELEASE) this.state = V_RELEASE; }
  renderSample(outL, outR, i) {
    if (this.state === V_IDLE) return;
    const smp = this.region.sample;
    let env = this.envLevel;
    if (this.state === V_DELAY) {
      if (--this.delayLeft <= 0) this.state = V_ATTACK;
      env = 0;
    } else if (this.state === V_ATTACK) {
      env += 1 / this.attackLeft;
      if (--this.attackLeft <= 0 || env >= 1) { env = 1; this.state = this.holdLeft > 0 ? V_HOLD : V_DECAY; }
    } else if (this.state === V_HOLD) {
      env = 1;
      if (--this.holdLeft <= 0) this.state = V_DECAY;
    } else if (this.state === V_DECAY) {
      env = this.decayCoeff > 0 ? env * this.decayCoeff : this.sustainLvl;
      if (env <= this.sustainLvl + 0.001) { env = this.sustainLvl; this.state = V_SUSTAIN; }
    } else if (this.state === V_SUSTAIN) {
      env = this.sustainLvl;
    } else if (this.state === V_RELEASE) {
      env = this.relCoeff > 0 ? env * this.relCoeff : 0;
      if (env < 0.0001) { this.state = V_IDLE; this.envLevel = 0; return; }
    }
    this.envLevel = env;
    const p = this.phase, pi = p | 0, pf = p - pi;
    const data = smp.data;
    if (pi >= smp.end - 1) {
      if (this.region.loopMode >= 1) { this.phase = smp.loopStart + (p - smp.loopEnd); }
      else { this.state = V_IDLE; return; }
    }
    const s = (data[pi] + (data[pi + 1] - data[pi]) * pf) / 32768.0;
    this.phase += this.phaseInc;
    if (this.region.loopMode >= 1 && this.phase >= smp.loopEnd)
      this.phase = smp.loopStart + (this.phase - smp.loopEnd);
    const out = s * env * this.gainVol;
    outL[i] += out * this.panL;
    outR[i] += out * this.panR;
  }
}

class ChannelState {
  constructor() { this.reset(); this.isDrum = false; }
  reset() {
    this.program = 0; this.bank = 0;
    this.volume = 100 / 127; this.expression = 1;
    this.pan = 0; this.sustain = false; this.pitchBend = 0;
  }
}

class Limiter {
  constructor(sr) {
    this.enabled = true; this.threshold = 0.95; this.gain = 1.0;
    this.atkCoeff = Math.exp(-1 / (sr * 0.003));
    this.relCoeff = Math.exp(-1 / (sr * 0.25));
  }
  process(L, R, i) {
    if (!this.enabled) return;
    const peak = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (peak * this.gain > this.threshold) {
      this.gain = (this.threshold / peak) * this.atkCoeff + this.gain * (1 - this.atkCoeff);
      if (this.gain < 0) this.gain = 0;
    } else {
      this.gain = Math.min(1, this.gain + (1 - this.gain) * (1 - this.relCoeff));
    }
    L[i] *= this.gain; R[i] *= this.gain;
  }
  updateAttack(sr, sec)  { this.atkCoeff = Math.exp(-1 / (sr * sec)); }
  updateRelease(sr, sec) { this.relCoeff = Math.exp(-1 / (sr * sec)); }
}

class SnappySynthProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.sr = sampleRate; this.ready = false; this.regions = null;
    this.numVoices = 512; this.numLayers = 4; this.velThresh = 0; this.masterVol = 1.0;
    this.voices   = Array.from({ length: 512 }, () => new Voice());
    this.channels = Array.from({ length: 16  }, () => new ChannelState());
    this.channels[9].isDrum = true;
    this.limiter  = new Limiter(sampleRate);
    this.midiQueue = []; this._statCount = 0;
    this.port.onmessage = e => this._onMsg(e.data);
  }
  _onMsg(d) {
    switch (d.type) {
      case 'init':           if (d.settings) this._applySettings(d.settings); break;
      case 'settings':       this._applySettings(d.settings); break;
      case 'midi':           this.midiQueue.push(d.dword); break;
      case 'load_sf_buffer': this._loadBuffer(d.buffer, d.name); break;
      case 'reload_sf':      this._loadUrl(d.url); break;
      case 'reset':          this._panic(); break;
    }
  }
  _applySettings(s) {
    if (s.numVoices !== undefined) {
      this.numVoices = s.numVoices;
      while (this.voices.length < this.numVoices) this.voices.push(new Voice());
    }
    if (s.numLayers  !== undefined) this.numLayers  = s.numLayers;
    if (s.velThresh  !== undefined) this.velThresh  = s.velThresh;
    if (s.masterVol  !== undefined) this.masterVol  = s.masterVol;
    if (s.limiterEnabled   !== undefined) this.limiter.enabled   = s.limiterEnabled;
    if (s.limiterThreshold !== undefined) this.limiter.threshold = s.limiterThreshold;
    if (s.limiterAttack    !== undefined) this.limiter.updateAttack(this.sr,  s.limiterAttack);
    if (s.limiterRelease   !== undefined) this.limiter.updateRelease(this.sr, s.limiterRelease);
  }
  _loadBuffer(buffer, name) {
    this.ready = false;
    this.port.postMessage({ type: 'sf_loading' });
    try {
      this.regions = new SF2Parser(buffer).parse();
      this.ready = true;
      this.port.postMessage({ type: 'sf_loaded', regionCount: this.regions.length, name });
    } catch (err) {
      this.port.postMessage({ type: 'sf_error', message: err.message });
    }
  }
  async _loadUrl(url) {
    if (!url) return;
    this.ready = false;
    this.port.postMessage({ type: 'sf_loading' });
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      this._loadBuffer(await resp.arrayBuffer(), url.split('/').pop());
    } catch (err) {
      this.port.postMessage({ type: 'sf_error', message: err.message });
    }
  }
  _dispatch(dword) {
    const status = dword & 0xFF, cmd = status & 0xF0, ch = status & 0x0F;
    const b1 = (dword >> 8) & 0xFF, b2 = (dword >> 16) & 0xFF;
    switch (cmd) {
      case 0x90: b2 > 0 ? this._noteOn(ch, b1, b2) : this._noteOff(ch, b1); break;
      case 0x80: this._noteOff(ch, b1); break;
      case 0xB0: this._cc(ch, b1, b2); break;
      case 0xC0: this.channels[ch].program = b1; break;
      case 0xE0: this.channels[ch].pitchBend = ((b2 << 7 | b1) - 8192) / 8192; break;
    }
  }
  _noteOn(ch, note, vel) {
    if (!this.regions || vel < this.velThresh) return;
    const chan = this.channels[ch];
    const bank = chan.isDrum ? 128 : chan.bank;
    const prog = chan.program;
    let layers = 0;
    for (const r of this.regions) {
      if (layers >= this.numLayers) break;
      if (r.bank !== bank || r.preset !== prog) continue;
      if (note < r.keyLo || note > r.keyHi) continue;
      if (vel  < r.velLo || vel  > r.velHi) continue;
      if (r.exClass > 0)
        for (const v of this.voices)
          if (v.state !== V_IDLE && v.channel === ch && v.exClass === r.exClass) v.state = V_IDLE;
      const voice = this._steal();
      if (!voice) continue;
      const vol = chan.volume * chan.expression * (vel / 127) * r.gain * this.masterVol;
      const pan = clamp(chan.pan + r.pan, -1, 1);
      const angle = (pan + 1) * Math.PI / 4;
      voice.noteOn(r, ch, note, vel, this.sr, vol, Math.cos(angle), Math.sin(angle));
      layers++;
    }
  }
  _noteOff(ch, note) {
    for (const v of this.voices) {
      if (v.state !== V_IDLE && v.channel === ch && v.note === note) {
        if (this.channels[ch].sustain) v._sustainHeld = true;
        else v.noteOff();
      }
    }
  }
  _cc(ch, cc, val) {
    const c = this.channels[ch];
    if      (cc === 7)  c.volume     = val / 127;
    else if (cc === 11) c.expression = val / 127;
    else if (cc === 10) c.pan        = (val - 64) / 63;
    else if (cc === 0)  c.bank       = val;
    else if (cc === 64) {
      c.sustain = val >= 64;
      if (!c.sustain)
        for (const v of this.voices)
          if (v.channel === ch && v._sustainHeld) { v._sustainHeld = false; v.noteOff(); }
    }
    else if (cc === 120 || cc === 123)
      for (const v of this.voices)
        if (v.channel === ch && v.state !== V_IDLE) v.noteOff();
    else if (cc === 121) c.reset();
  }
  _panic() {
    for (const v of this.voices) v.state = V_IDLE;
    for (const c of this.channels) c.reset();
    this.midiQueue.length = 0;
  }
  _steal() {
    for (const v of this.voices) if (v.state === V_IDLE) return v;
    let best = null, bestE = Infinity;
    for (const v of this.voices)
      if (v.state === V_RELEASE && v.envLevel < bestE) { best = v; bestE = v.envLevel; }
    return best || this.voices[0];
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const outL = out[0], outR = out.length > 1 ? out[1] : out[0], len = outL.length;
    if (this.midiQueue.length > 0) {
      const batch = this.midiQueue.splice(0);
      for (const dw of batch) this._dispatch(dw);
    }
    outL.fill(0); outR.fill(0);
    if (this.ready) {
      for (const v of this.voices) {
        if (v.state === V_IDLE) continue;
        for (let i = 0; i < len; i++) v.renderSample(outL, outR, i);
      }
      for (let i = 0; i < len; i++) this.limiter.process(outL, outR, i);
    }
    if ((++this._statCount & 255) === 0) {
      const active = this.voices.filter(v => v.state !== V_IDLE).length;
      this.port.postMessage({ type: 'stats', activeVoices: active });
    }
    return true;
  }
}
registerProcessor('snappy-synth', SnappySynthProcessor);
`;
// end of inlined driver


// ─────────────────────────────────────────────────────────────────────────────
// UI + MIDI hook
// ─────────────────────────────────────────────────────────────────────────────
(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
    .ss-badge{display:inline-block;font-size:.55rem;font-weight:700;letter-spacing:.05em;
      padding:.1rem .38rem;border-radius:999px;border:1px solid rgba(52,211,153,.35);
      background:rgba(52,211,153,.12);color:#34d399;margin-left:.3rem;vertical-align:middle;}
    #snappyPanel .ss-section-label{font-size:.55rem;font-weight:700;letter-spacing:.08em;
      text-transform:uppercase;color:rgba(196,181,253,.35);margin:.45rem 0 .2rem;}
    .ss-row{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap;margin-bottom:.28rem;}
    .ss-label{font-size:.62rem;color:rgba(196,181,253,.5);white-space:nowrap;min-width:90px;}
    .ss-ctrl{font-size:.64rem;padding:.22rem .42rem;border-radius:6px;
      border:1px solid rgba(167,139,250,.2);background:rgba(10,8,30,.7);color:#c4b5fd;flex:1;min-width:0;}
    .ss-slider{-webkit-appearance:none;appearance:none;flex:1;height:3px;border-radius:999px;
      background:rgba(167,139,250,.18);outline:none;cursor:pointer;min-width:60px;}
    .ss-slider::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;
      border-radius:50%;background:#a78bfa;}
    .ss-val{font-size:.62rem;color:#a78bfa;font-variant-numeric:tabular-nums;white-space:nowrap;min-width:3.5ch;}
    .ss-status{font-size:.62rem;font-weight:600;padding:.15rem .45rem;border-radius:5px;
      border:1px solid;white-space:nowrap;}
    .ss-status.idle   {background:rgba(167,139,250,.07);border-color:rgba(167,139,250,.18);color:rgba(196,181,253,.4);}
    .ss-status.loading{background:rgba(251,191,36,.07); border-color:rgba(251,191,36,.25); color:#fbbf24;}
    .ss-status.ok     {background:rgba(52,211,153,.07); border-color:rgba(52,211,153,.25); color:#34d399;}
    .ss-status.err    {background:rgba(251,113,133,.07);border-color:rgba(251,113,133,.22);color:#fb7185;}
    .ss-toggle{display:inline-flex;align-items:center;gap:.4rem;cursor:pointer;
      font-size:.62rem;color:rgba(196,181,253,.6);}
    .ss-toggle input[type=checkbox]{accent-color:#a78bfa;width:13px;height:13px;cursor:pointer;}
    #ssVoiceCount{font-size:.62rem;color:#34d399;font-variant-numeric:tabular-nums;}
    .ss-tab-disabled{opacity:.35!important;pointer-events:none!important;}
    #ssSFDropZone{border:1.5px dashed rgba(167,139,250,.3);border-radius:8px;
      padding:.55rem .7rem;cursor:pointer;transition:border-color .15s,background .15s;
      display:flex;align-items:center;gap:.55rem;min-height:38px;}
    #ssSFDropZone:hover,#ssSFDropZone.dragover{border-color:#a78bfa;background:rgba(167,139,250,.07);}
    #ssSFDropZone .dz-icon{font-size:1.1rem;line-height:1;flex-shrink:0;}
    #ssSFDropZone .dz-label{font-size:.62rem;color:rgba(196,181,253,.55);line-height:1.45;}
    #ssSFDropZone .dz-label strong{color:#c4b5fd;}
    #ssSFDropZone.has-file .dz-label{color:#34d399;}
    #ssSFDropZone.has-file{border-color:rgba(52,211,153,.35);}
    #ssSFUrlRow{display:none;margin-top:.2rem;}
    #ssSFUrlRow.visible{display:flex;}
    #ssUrlToggle{font-size:.58rem;color:rgba(167,139,250,.45);cursor:pointer;
      text-decoration:underline;text-underline-offset:2px;margin-top:.1rem;
      display:inline-block;user-select:none;}
    #ssUrlToggle:hover{color:#a78bfa;}
  `;
  document.head.appendChild(style);

  const tabsContainer = document.querySelector('.midi-out-tabs');
  if (tabsContainer) {
    const btn = document.createElement('button');
    btn.className = 'midi-tab';
    btn.id = 'tabSnappy';
    btn.innerHTML = 'Embedded Synth<span class="ss-badge">New</span>';
    btn.addEventListener('click', () => _ssActivateTab());
    tabsContainer.appendChild(btn);
  }

  const outSection = document.querySelector('.midi-out-section');
  if (outSection) {
    const panel = document.createElement('div');
    panel.className = 'midi-panel';
    panel.id = 'snappyPanel';
    panel.innerHTML = `
      <div class="midi-note" style="line-height:1.6">
        <strong style="color:#34d399">Embedded Synth</strong> &mdash;
        Powered by <strong>SnappySynth V2</strong><br>
        <span style="color:rgba(196,181,253,.45);font-size:.6rem">
          SF2 Voice Engine &bull; Direct AudioWorklet output
        </span>
      </div>
      <div class="ss-section-label">Soundfont (.sf2)</div>
      <input type="file" id="ssSFFileInput" accept=".sf2,audio/x-sf2"
        style="display:none" onchange="ssSFFileChosen(this)">
      <div id="ssSFDropZone"
        onclick="document.getElementById('ssSFFileInput').click()"
        ondragover="event.preventDefault();this.classList.add('dragover')"
        ondragleave="this.classList.remove('dragover')"
        ondrop="ssSFDropped(event)">
        <span class="dz-icon">&#127925;</span>
        <span class="dz-label" id="ssSFDropLabel">
          <strong>Click to browse</strong> or drag &amp; drop an .sf2 file here
        </span>
      </div>
      <span id="ssUrlToggle" onclick="ssToggleUrlRow()">or load from URL instead</span>
      <div class="ss-row" id="ssSFUrlRow">
        <input class="ss-ctrl" id="ssSFUrl" type="url"
          placeholder="https://example.com/soundfont.sf2" spellcheck="false">
        <button class="btn-md" onclick="ssLoadSFUrl()">Load</button>
      </div>
      <div class="ss-row" style="margin-top:.3rem">
        <span class="ss-status idle" id="ssSFStatus">Not loaded</span>
        <span id="ssSFRegions" style="font-size:.58rem;color:rgba(196,181,253,.3)"></span>
      </div>
      <div class="ss-section-label">Voice Engine</div>
      <div class="ss-row">
        <span class="ss-label">Voices</span>
        <input class="ss-slider" type="range" min="64" max="4096" step="64" value="512"
          oninput="ssUpdateSetting('numVoices',+this.value);document.getElementById('ssVoicesVal').textContent=this.value">
        <span class="ss-val" id="ssVoicesVal">512</span>
      </div>
      <div class="ss-row">
        <span class="ss-label">Layers</span>
        <input class="ss-slider" type="range" min="1" max="16" step="1" value="4"
          oninput="ssUpdateSetting('numLayers',+this.value);document.getElementById('ssLayersVal').textContent=this.value">
        <span class="ss-val" id="ssLayersVal">4</span>
      </div>
      <div class="ss-row">
        <span class="ss-label">Vel. Threshold</span>
        <input class="ss-slider" type="range" min="0" max="127" step="1" value="0"
          oninput="ssUpdateSetting('velThresh',+this.value);document.getElementById('ssVelVal').textContent=this.value">
        <span class="ss-val" id="ssVelVal">0</span>
      </div>
      <div class="ss-row">
        <span class="ss-label">Master Vol</span>
        <input class="ss-slider" type="range" min="0" max="2" step="0.01" value="1"
          oninput="ssUpdateSetting('masterVol',+this.value);document.getElementById('ssMVolVal').textContent=(+this.value).toFixed(2)">
        <span class="ss-val" id="ssMVolVal">1.00</span>
      </div>
      <div class="ss-row">
        <span class="ss-label">Active Voices</span>
        <span id="ssVoiceCount">&mdash;</span>
      </div>
      <div class="ss-section-label">Limiter</div>
      <div class="ss-row">
        <label class="ss-toggle">
          <input type="checkbox" id="ssLimEnabled" checked
            onchange="ssUpdateSetting('limiterEnabled',this.checked)">
          Enabled
        </label>
      </div>
      <div class="ss-row">
        <span class="ss-label">Threshold</span>
        <input class="ss-slider" type="range" min="0.5" max="1" step="0.01" value="0.95"
          oninput="ssUpdateSetting('limiterThreshold',+this.value);document.getElementById('ssLimThV').textContent=(+this.value).toFixed(2)">
        <span class="ss-val" id="ssLimThV">0.95</span>
      </div>
      <div class="ss-row">
        <span class="ss-label">Attack (ms)</span>
        <input class="ss-slider" type="range" min="0.001" max="0.05" step="0.001" value="0.003"
          oninput="ssUpdateSetting('limiterAttack',+this.value);document.getElementById('ssLimAtV').textContent=(+this.value*1000).toFixed(1)">
        <span class="ss-val" id="ssLimAtV">3.0</span>
      </div>
      <div class="ss-row">
        <span class="ss-label">Release (ms)</span>
        <input class="ss-slider" type="range" min="0.05" max="2" step="0.05" value="0.25"
          oninput="ssUpdateSetting('limiterRelease',+this.value);document.getElementById('ssLimRlV').textContent=(+this.value*1000).toFixed(0)">
        <span class="ss-val" id="ssLimRlV">250</span>
      </div>
    `;
    outSection.appendChild(panel);
  }

  // ── Fake midiOutput object ──────────────────────────────────────────────────
  // MPWGL2 calls: if (midiEnabled && midiOutput) midiOutput.send(data, timestamp)
  // We inject this object as window.midiOutput when SnappySynth tab is active.
  // data is a Uint8Array or Array like [status, b1, b2].
  const _fakeOutput = {
    name: 'SnappySynth (Embedded)',
    send(data /*, timestamp — ignored, synth handles timing internally */) {
      if (!data || data.length === 0) return;
      const dword = (data[0] & 0xFF)
                  | (((data[1] || 0) & 0xFF) << 8)
                  | (((data[2] || 0) & 0xFF) << 16);
      ssBridge.sendDword(dword);
    },
  };

  // Save reference to the real midiOutput before we touch anything
  let _realMidiOutput = null;

  function _ssIsActive() {
    return !!document.getElementById('tabSnappy')?.classList.contains('active');
  }

  function _ssActivateTab() {
    // Disable other tabs visually
    ['tabWmidi','tabMidiIn','tabNone'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.classList.remove('active'); el.classList.add('ss-tab-disabled'); }
    });
    ['panelWmidi','panelMidiIn','panelNone'].forEach(id => {
      const el = document.getElementById(id); if (el) el.classList.remove('on');
    });
    document.getElementById('tabSnappy')?.classList.add('active');
    document.getElementById('snappyPanel')?.classList.add('on');

    // Inject fake output — MPWGL2 checks midiEnabled && midiOutput before sending
    _realMidiOutput = window.midiOutput;
    window.midiOutput = _fakeOutput;
    window.midiEnabled = true;

    // FIX: ensure AudioContext is resumed on next user interaction
    document.addEventListener('click', () => ssBridge.resumeCtx(), { once: true });

    ssBridge.init();
  }

  function _ssDeactivateTab() {
    ['tabWmidi','tabMidiIn','tabNone'].forEach(id => {
      const el = document.getElementById(id); if (el) el.classList.remove('ss-tab-disabled');
    });
    document.getElementById('tabSnappy')?.classList.remove('active');
    document.getElementById('snappyPanel')?.classList.remove('on');

    // Restore real output
    window.midiOutput = _realMidiOutput;
    _realMidiOutput = null;

    ssBridge.panic();
  }

  ['tabWmidi','tabMidiIn','tabNone'].forEach(id => {
    const btn = document.getElementById(id); if (!btn) return;
    btn.addEventListener('click', () => {
      _ssDeactivateTab();
      if (id !== 'tabNone' && typeof window.midiEnabled !== 'undefined') window.midiEnabled = true;
    }, true);
  });

  window.ssSFFileChosen = function (input) {
    const file = input.files && input.files[0]; if (file) _readAndLoadFile(file);
  };
  window.ssSFDropped = function (event) {
    event.preventDefault();
    document.getElementById('ssSFDropZone')?.classList.remove('dragover');
    const file = event.dataTransfer?.files?.[0]; if (!file) return;
    if (!file.name.toLowerCase().endsWith('.sf2')) { _sfStatus('Not an .sf2 file', 'err'); return; }
    _readAndLoadFile(file);
  };
  function _readAndLoadFile(file) {
    _sfStatus('Reading ' + file.name + '\u2026', 'loading');
    const lbl = document.getElementById('ssSFDropLabel');
    if (lbl) lbl.innerHTML = '<strong>' + _esc(file.name) + '</strong> (' + _sz(file.size) + ')';
    document.getElementById('ssSFDropZone')?.classList.add('has-file');
    const reader = new FileReader();
    reader.onload  = e => ssBridge.init().then(() => ssBridge.loadSFBuffer(e.target.result, file.name));
    reader.onerror = () => _sfStatus('File read error', 'err');
    reader.readAsArrayBuffer(file);
  }
  window.ssLoadSFUrl = function () {
    const url = document.getElementById('ssSFUrl')?.value.trim();
    if (!url) { typeof showToast === 'function' && showToast('Enter a .sf2 URL first'); return; }
    _sfStatus('Connecting\u2026', 'loading');
    ssBridge.init().then(() => ssBridge.loadSFUrl(url));
  };
  window.ssToggleUrlRow = function () {
    const row = document.getElementById('ssSFUrlRow'), t = document.getElementById('ssUrlToggle');
    if (!row) return;
    const v = row.classList.toggle('visible');
    if (t) t.textContent = v ? 'hide URL input' : 'or load from URL instead';
  };
  window.ssUpdateSetting = function (key, value) { ssBridge.updateSetting(key, value); };

  function _sfStatus(text, cls) {
    const el = document.getElementById('ssSFStatus'); if (!el) return;
    el.textContent = text; el.className = 'ss-status ' + (cls || 'idle');
  }
  function _esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function _sz(b)  { return b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB'; }

}());


// ═════════════════════════════════════════════════════════════════════════════
//  ssBridge — AudioContext + AudioWorkletNode
// ═════════════════════════════════════════════════════════════════════════════
const ssBridge = (function () {
  let ctx    = null;
  let node   = null;
  let _initP = null;

  const _cfg = {
    numVoices:512, numLayers:4, velThresh:0, masterVol:1.0,
    limiterEnabled:true, limiterThreshold:0.95,
    limiterAttack:0.003, limiterRelease:0.25,
  };

  function _sfStatus(text, cls) {
    const el = document.getElementById('ssSFStatus'); if (!el) return;
    el.textContent = text; el.className = 'ss-status ' + (cls || 'idle');
  }

  async function init() {
    if (_initP) return _initP;
    _initP = _doInit();
    return _initP;
  }

  async function _doInit() {
    try {
      if (!window.AudioWorklet) throw new Error('AudioWorklet not supported');

      ctx = new (window.AudioContext || window.webkitAudioContext)();
      if (ctx.state === 'suspended') await ctx.resume();

      const blob    = new Blob([_SS_DRIVER_SRC], { type: 'application/javascript' });
      const blobURL = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(blobURL);
      URL.revokeObjectURL(blobURL);

      node = new AudioWorkletNode(ctx, 'snappy-synth', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      });

      node.port.onmessage = ({ data: d }) => {
        if (d.type === 'sf_loading') {
          _sfStatus('Parsing\u2026', 'loading');
        } else if (d.type === 'sf_loaded') {
          _sfStatus('Loaded \u2714', 'ok');
          const r = document.getElementById('ssSFRegions');
          if (r) r.textContent = d.regionCount + ' regions';
        } else if (d.type === 'sf_error') {
          _sfStatus('Error: ' + d.message, 'err');
        } else if (d.type === 'stats') {
          const el = document.getElementById('ssVoiceCount');
          if (el) el.textContent = d.activeVoices;
        }
      };

      node.connect(ctx.destination);
      node.port.postMessage({ type: 'init', settings: { ..._cfg } });

    } catch (err) {
      console.error('[SnappySynth] init error:', err);
      _sfStatus('Init failed: ' + err.message, 'err');
      _initP = null;
      throw err;
    }
  }

  // FIX: await ctx.resume() before posting MIDI to prevent silent audio
  // when the AudioContext is in suspended state.
  async function sendDword(dword) {
    if (!node) { await init(); }
    if (ctx && ctx.state === 'suspended') await ctx.resume();
    if (node) node.port.postMessage({ type: 'midi', dword });
  }

  // Expose for explicit resume on user interaction
  async function resumeCtx() {
    if (ctx && ctx.state === 'suspended') await ctx.resume();
  }

  function loadSFBuffer(arrayBuffer, name) {
    if (!node) return;
    node.port.postMessage({ type: 'load_sf_buffer', buffer: arrayBuffer, name }, [arrayBuffer]);
  }
  function loadSFUrl(url) {
    if (!node) return;
    node.port.postMessage({ type: 'reload_sf', url });
  }
  function panic()  { node?.port.postMessage({ type: 'reset' }); }
  function updateSetting(key, value) {
    _cfg[key] = value;
    node?.port.postMessage({ type: 'settings', settings: { [key]: value } });
  }

  return { init, sendDword, resumeCtx, loadSFBuffer, loadSFUrl, panic, updateSetting };
}());
