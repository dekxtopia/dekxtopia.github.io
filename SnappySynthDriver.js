/**
 * SnappySynthDriver.js — SnappySynth V2 JS Port
 *
 * Direct port of the C++ SnappySynth V2 voice engine to a single
 * AudioWorkletProcessor. Acts as a MIDI Out device: receives MIDI DWORDs
 * from the main thread, synthesizes audio from an SF2 soundfont, and
 * writes directly to outputs[0] on every process() callback.
 *
 * Architecture: ONE node, no ring buffer, no relay, no pre-render queue.
 *   main thread → port.postMessage({ type:'midi', dword }) → process() → outputs[0] → DAC
 *
 * Messages IN (main → worklet):
 *   { type:'init',            settings }        — apply initial settings
 *   { type:'settings',        settings }        — update settings live
 *   { type:'midi',            dword }           — single MIDI DWORD
 *   { type:'load_sf_buffer',  buffer, name }    — load SF2 from ArrayBuffer
 *   { type:'reload_sf',       url }             — load SF2 from URL
 *   { type:'reset' }                            — all-notes-off + channel reset
 *
 * Messages OUT (worklet → main):
 *   { type:'sf_loading' }
 *   { type:'sf_loaded',  regionCount, name }
 *   { type:'sf_error',   message }
 *   { type:'stats',      activeVoices }
 */
'use strict';

// ─── helpers ─────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const tc2s  = tc => tc <= -32768 ? 0.0001 : Math.pow(2, tc / 1200);

// ─── SF2 Parser ──────────────────────────────────────────────────────────────
// Ported from src/Parser/sf2_parser.c
class SF2Parser {
  constructor(buf) {
    this.dv  = new DataView(buf);
    this.buf = buf;
    this.pos = 0;
  }
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

    // ── sample data ──
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

    // ── pdta sub-chunks ──
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
    // SF2 generator IDs (spec 8.1.3)
    const G = {
      START_OFF:0, END_OFF:1, LSTART_OFF:2, LEND_OFF:3,
      START_COARSE:4, END_COARSE:12,
      PAN:17,
      VENV_DELAY:33, VENV_ATTACK:34, VENV_HOLD:35,
      VENV_DECAY:36, VENV_SUSTAIN:37, VENV_RELEASE:38,
      INSTRUMENT:41, KEY_RANGE:43, VEL_RANGE:44,
      LSTART_COARSE:45, ATTENUATION:48, LEND_COARSE:50,
      COARSE_TUNE:51, FINE_TUNE:52, SAMPLE_ID:53,
      SAMPLE_MODES:54, SCALE_TUNING:56, EXCLUSIVE_CLASS:57, ROOT_KEY:58,
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
          const keyLo = krR !== undefined ? (krR & 0xFF)       : 0;
          const keyHi = krR !== undefined ? ((krR >> 8) & 0xFF): 127;
          const velLo = vrR !== undefined ? (vrR & 0xFF)       : 0;
          const velHi = vrR !== undefined ? ((vrR >> 8) & 0xFF): 127;

          const rootKey    = iG[G.ROOT_KEY]     !== undefined ? iG[G.ROOT_KEY]     : smp.originalKey;
          const coarseTune = (iG[G.COARSE_TUNE] || 0) + (pG[G.COARSE_TUNE] || 0);
          const fineTune   = (iG[G.FINE_TUNE]   || 0) + (pG[G.FINE_TUNE]   || 0) + smp.correction;
          const scaleTune  = iG[G.SCALE_TUNING] !== undefined ? iG[G.SCALE_TUNING] : 100;
          const atten      = (iG[G.ATTENUATION] || 0) + (pG[G.ATTENUATION] || 0);
          const gain       = Math.pow(10, -atten / 200);
          const pan        = clamp(((iG[G.PAN] || 0) + (pG[G.PAN] || 0)) / 500, -1, 1);
          const loopMode   = (iG[G.SAMPLE_MODES] || 0) & 0x03;
          const exClass    = iG[G.EXCLUSIVE_CLASS] || 0;

          const startOff = (iG[G.START_OFF]    || 0) + (iG[G.START_COARSE]  || 0) * 32768;
          const endOff   = (iG[G.END_OFF]      || 0) + (iG[G.END_COARSE]    || 0) * 32768;
          const lsOff    = (iG[G.LSTART_OFF]   || 0) + (iG[G.LSTART_COARSE] || 0) * 32768;
          const leOff    = (iG[G.LEND_OFF]     || 0) + (iG[G.LEND_COARSE]   || 0) * 32768;

          regions.push({
            bank: p.bank, preset: p.preset,
            keyLo, keyHi, velLo, velHi,
            rootKey, coarseTune, fineTune, scaleTune,
            gain, pan, loopMode, exClass,
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

// ─── Voice states (mirrors V_IDLE … V_RELEASE in voice.h) ────────────────────
const V_IDLE = 0, V_DELAY = 1, V_ATTACK = 2, V_HOLD = 3,
      V_DECAY = 4, V_SUSTAIN = 5, V_RELEASE = 6;

class Voice {
  constructor() { this.state = V_IDLE; this.region = null; this._sustainHeld = false; }

  noteOn(region, ch, note, vel, sr, gainVol, panL, panR) {
    this.region  = region;
    this.channel = ch;
    this.note    = note;
    this.gainVol = gainVol;
    this.panL    = panL;
    this.panR    = panR;
    this.exClass = region.exClass;
    this._sustainHeld = false;

    // Pitch: semitones offset from root, scaled by scaleTune (cents per semitone)
    const semis = (note - region.rootKey) * (region.scaleTune / 100) + region.coarseTune;
    this.phaseInc = (region.sample.sampleRate / sr)
                  * Math.pow(2, semis / 12)
                  * Math.pow(2, region.fineTune / 1200);
    this.phase = region.sample.start;

    // ADSR
    this.envLevel   = 0;
    this.delayLeft  = Math.round(region.volDelay   * sr);
    this.attackLeft = Math.max(1, Math.round(region.volAttack * sr));
    this.holdLeft   = Math.round(region.volHold    * sr);
    this.decayCoeff = region.volDecay > 0.0001
      ? Math.exp(-Math.log(1000) / (region.volDecay  * sr)) : 0;
    this.sustainLvl = region.volSustain;
    this.relCoeff   = region.volRelease > 0.0001
      ? Math.exp(-Math.log(1000) / (region.volRelease * sr)) : 0;

    this.state = this.delayLeft > 0 ? V_DELAY : V_ATTACK;
  }

  noteOff() {
    if (this.state !== V_IDLE && this.state !== V_RELEASE) this.state = V_RELEASE;
  }

  // Render one sample into outL/outR at index i
  renderSample(outL, outR, i) {
    if (this.state === V_IDLE) return;
    const smp = this.region.sample;
    let env = this.envLevel;

    // Envelope
    if (this.state === V_DELAY) {
      if (--this.delayLeft <= 0) this.state = V_ATTACK;
      env = 0;
    } else if (this.state === V_ATTACK) {
      env += 1 / this.attackLeft;
      if (--this.attackLeft <= 0 || env >= 1) {
        env = 1;
        this.state = this.holdLeft > 0 ? V_HOLD : V_DECAY;
      }
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

    // Sample read with linear interpolation
    const p  = this.phase;
    const pi = p | 0;
    const pf = p - pi;
    const data = smp.data;

    // Loop / end check
    if (pi >= smp.end - 1) {
      if (this.region.loopMode >= 1) {
        this.phase = smp.loopStart + (p - smp.loopEnd);
      } else {
        this.state = V_IDLE;
        return;
      }
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

// ─── Channel state (mirrors channel.h) ───────────────────────────────────────
class ChannelState {
  constructor() { this.reset(); this.isDrum = false; }
  reset() {
    this.program   = 0;
    this.bank      = 0;
    this.volume    = 100 / 127;
    this.expression = 1;
    this.pan       = 0;
    this.sustain   = false;
    this.pitchBend = 0;
  }
}

// ─── Simple peak limiter ──────────────────────────────────────────────────────
class Limiter {
  constructor(sr) {
    this.enabled   = true;
    this.threshold = 0.95;
    this.gain      = 1.0;
    this.atkCoeff  = Math.exp(-1 / (sr * 0.003));
    this.relCoeff  = Math.exp(-1 / (sr * 0.25));
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
    L[i] *= this.gain;
    R[i] *= this.gain;
  }
  updateAttack(sr, sec)  { this.atkCoeff = Math.exp(-1 / (sr * sec)); }
  updateRelease(sr, sec) { this.relCoeff = Math.exp(-1 / (sr * sec)); }
}

// ═════════════════════════════════════════════════════════════════════════════
//  SnappySynthProcessor — single AudioWorkletProcessor
//  Equivalent to InitializeKDMAPIStream + voice_render_float + SendMIDIData
// ═════════════════════════════════════════════════════════════════════════════
class SnappySynthProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.sr         = sampleRate;
    this.ready      = false;
    this.regions    = null;
    this.numVoices  = 512;
    this.numLayers  = 4;
    this.velThresh  = 0;
    this.masterVol  = 1.0;
    this.voices     = Array.from({ length: 512 }, () => new Voice());
    this.channels   = Array.from({ length: 16  }, () => new ChannelState());
    this.channels[9].isDrum = true;
    this.limiter    = new Limiter(sampleRate);
    this.midiQueue  = [];
    this._statCount = 0;
    this.port.onmessage = e => this._onMsg(e.data);
  }

  // ── message handler ────────────────────────────────────────────────────────
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

  // ── SF2 loading ─────────────────────────────────────────────────────────────
  _loadBuffer(buffer, name) {
    this.ready = false;
    this.port.postMessage({ type: 'sf_loading' });
    try {
      this.regions = new SF2Parser(buffer).parse();
      this.ready   = true;
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

  // ── MIDI dispatch (mirrors dispatch_midi_data_at_qpc) ──────────────────────
  _dispatch(dword) {
    const status = dword & 0xFF;
    const cmd    = status & 0xF0;
    const ch     = status & 0x0F;
    const b1     = (dword >> 8)  & 0xFF;
    const b2     = (dword >> 16) & 0xFF;
    switch (cmd) {
      case 0x90: b2 > 0 ? this._noteOn(ch, b1, b2) : this._noteOff(ch, b1); break;
      case 0x80: this._noteOff(ch, b1); break;
      case 0xB0: this._cc(ch, b1, b2);  break;
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
      if (r.bank !== bank) continue;
      if (r.preset !== prog) continue;
      if (note < r.keyLo || note > r.keyHi) continue;
      if (vel  < r.velLo || vel  > r.velHi) continue;
      // exclusive class: kill same-class voices on same channel
      if (r.exClass > 0) {
        for (const v of this.voices)
          if (v.state !== V_IDLE && v.channel === ch && v.exClass === r.exClass)
            v.state = V_IDLE;
      }
      const voice = this._steal();
      if (!voice) continue;
      const vol   = chan.volume * chan.expression * (vel / 127) * r.gain * this.masterVol;
      const pan   = clamp(chan.pan + r.pan, -1, 1);
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
    else if (cc === 32) { /* bank LSB — ignore for GM */ }
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
    // 1. Find a truly idle voice
    for (const v of this.voices) if (v.state === V_IDLE) return v;
    // 2. Steal the quietest releasing voice
    let best = null, bestE = Infinity;
    for (const v of this.voices)
      if (v.state === V_RELEASE && v.envLevel < bestE) { best = v; bestE = v.envLevel; }
    // 3. Last resort: steal first voice
    return best || this.voices[0];
  }

  // ── process() — called by the audio engine every ~2.67 ms @ 48 kHz ─────────
  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;

    const outL = out[0];
    const outR = out.length > 1 ? out[1] : out[0];
    const len  = outL.length;

    // Drain MIDI queue
    if (this.midiQueue.length > 0) {
      const batch = this.midiQueue.splice(0);
      for (const dw of batch) this._dispatch(dw);
    }

    // Render
    outL.fill(0);
    outR.fill(0);
    if (this.ready) {
      for (const v of this.voices) {
        if (v.state === V_IDLE) continue;
        for (let i = 0; i < len; i++) v.renderSample(outL, outR, i);
      }
      for (let i = 0; i < len; i++) this.limiter.process(outL, outR, i);
    }

    // Stats every 256 callbacks (~680 ms)
    if ((++this._statCount & 255) === 0) {
      const active = this.voices.filter(v => v.state !== V_IDLE).length;
      this.port.postMessage({ type: 'stats', activeVoices: active });
    }

    return true;
  }
}

registerProcessor('snappy-synth', SnappySynthProcessor);
