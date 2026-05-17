/**
 * SnappySynthIntegration.js  —  Pre-render buffer edition
 *
 * Architecture:
 *  - snappy-render  AudioWorkletNode: SF2 voice engine, fills SharedArrayBuffer
 *  - snappy-player  AudioWorkletNode: drains SAB to DAC, connected to destination
 *  - Main thread owns: SAB, MIDI scheduling, play/pause/seek signalling
 *
 * SAB control layout (Int32, at end of buffer):
 *   [0] writePos   (frames, set by render node)
 *   [1] readPos    (frames, set by player node)
 *   [2] playing    (0=paused, 1=playing)
 *   [3] skipping   (current velocity skip threshold, set by render node)
 *
 * Buffer size is configurable (default 6 s).  The render node fills up to
 * bufferSec ahead even while paused.  The player node outputs silence when
 * paused or when the buffer is starved.
 *
 * When the buffer runs low the render node raises the velocity skip threshold
 * exactly as Kiva does:  skip = clamp(127 + 10 - bufferedSamples/100, 0, 127)
 * Low-velocity notes (≤ skip) are dropped by the render node until recovery.
 */

(function () {
  'use strict';

  // ── 1. CSS ────────────────────────────────────────────────────────────────
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
    .ss-ctrl-sm{width:72px;flex:none;}
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
    #ssBufBar{width:100%;height:4px;background:rgba(167,139,250,.1);border-radius:999px;overflow:hidden;margin-top:.15rem;}
    #ssBufFill{height:100%;background:linear-gradient(90deg,#fb7185,#fbbf24,#34d399);border-radius:999px;transition:width 200ms linear;}
    #ssSkipBadge{font-size:.58rem;padding:.1rem .35rem;border-radius:4px;
      background:rgba(251,113,133,.1);border:1px solid rgba(251,113,133,.25);color:#fb7185;
      display:none;margin-left:.35rem;}
    #ssSkipBadge.on{display:inline-block;}
    /* greyed-out tabs when embedded synth is active */
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

  // ── 2. Tab button ─────────────────────────────────────────────────────────
  const tabsContainer = document.querySelector('.midi-out-tabs');
  if (tabsContainer) {
    const btn = document.createElement('button');
    btn.className = 'midi-tab';
    btn.id = 'tabSnappy';
    btn.innerHTML = 'Embedded Synth<span class="ss-badge">New</span>';
    btn.addEventListener('click', () => _ssActivateTab());
    tabsContainer.appendChild(btn);
  }

  // ── 3. Panel HTML ─────────────────────────────────────────────────────────
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
          MIDI Driver made by GamingMIDI &bull; Ported by Dekx
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
        <span id="ssSkipBadge">skip</span>
      </div>

      <!-- Buffer meter -->
      <div class="ss-section-label">Pre-render Buffer</div>
      <div class="ss-row">
        <span class="ss-label">Size (s)</span>
        <input class="ss-slider" type="range" min="1" max="30" step="1" value="6"
          oninput="ssUpdateSetting('bufferSec',+this.value);document.getElementById('ssBufSecVal').textContent=this.value">
        <span class="ss-val" id="ssBufSecVal">6</span>
      </div>
      <div class="ss-row" style="flex-direction:column;align-items:flex-start;gap:.18rem">
        <div style="display:flex;justify-content:space-between;width:100%;font-size:.58rem;color:rgba(196,181,253,.3)">
          <span>Buffered</span><span id="ssBufSecCur">0.0 s</span>
        </div>
        <div id="ssBufBar"><div id="ssBufFill" style="width:0%"></div></div>
      </div>

      <!-- Voice engine -->
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
        <span class="ss-label">Active Voices</span>
        <span id="ssVoiceCount">—</span>
      </div>

      <!-- Limiter -->
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

  // ── 4. Tab activation / deactivation ─────────────────────────────────────

  function _ssActivateTab() {
    // Deactivate original tabs + panels
    ['tabWmidi','tabMidiIn','tabNone'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.classList.remove('active'); el.classList.add('ss-tab-disabled'); }
    });
    ['panelWmidi','panelMidiIn','panelNone'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('on');
    });
    document.getElementById('tabSnappy')?.classList.add('active');
    document.getElementById('snappyPanel')?.classList.add('on');
    // Disable hardware MIDI output
    if (typeof midiEnabled !== 'undefined') window.midiEnabled = false;
    // Boot the worklets if not yet running
    ssBridge.init();
  }

  function _ssDeactivateTab() {
    ['tabWmidi','tabMidiIn','tabNone'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.classList.remove('ss-tab-disabled'); }
    });
    document.getElementById('tabSnappy')?.classList.remove('active');
    document.getElementById('snappyPanel')?.classList.remove('on');
    ssBridge.pause();
    ssBridge.panic();
  }

  // Hook original tab buttons (capture phase so we run before their listener)
  ['tabWmidi','tabMidiIn','tabNone'].forEach(id => {
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.addEventListener('click', () => {
      _ssDeactivateTab();
      if (id !== 'tabNone' && typeof midiEnabled !== 'undefined') window.midiEnabled = true;
    }, true);
  });

  // ── 5. Intercept _enqueueMidi (real MIDI dispatch in MPWGL2.html) ─────────
  const _origEnqueue = window._enqueueMidi;
  window._enqueueMidi = function (data, timestampMs) {
    const snappyActive = document.getElementById('tabSnappy')?.classList.contains('active');
    if (snappyActive) {
      const status = data[0] & 0xFF;
      const d1     = (data[1] || 0) & 0xFF;
      const d2     = (data[2] || 0) & 0xFF;
      ssBridge.sendDword(status | (d1 << 8) | (d2 << 16));
      return;
    }
    if (typeof _origEnqueue === 'function') _origEnqueue(data, timestampMs);
  };

  // Intercept play / pause from the page transport so we can signal the player
  // MPWGL2.html calls _setPlaying(bool) — wrap it.
  const _origSetPlaying = window._setPlaying;
  window._setPlaying = function (playing) {
    const snappyActive = document.getElementById('tabSnappy')?.classList.contains('active');
    if (snappyActive) {
      if (playing) ssBridge.play(); else ssBridge.pause();
    }
    if (typeof _origSetPlaying === 'function') _origSetPlaying(playing);
  };

  // ── 6. SF loading UI helpers ──────────────────────────────────────────────

  window.ssSFFileChosen = function (input) {
    const file = input.files && input.files[0];
    if (file) _readAndLoadFile(file);
  };

  window.ssSFDropped = function (event) {
    event.preventDefault();
    document.getElementById('ssSFDropZone')?.classList.remove('dragover');
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.sf2')) { _sfSetStatus('Not an .sf2 file', 'err'); return; }
    _readAndLoadFile(file);
  };

  function _readAndLoadFile(file) {
    _sfSetStatus('Reading ' + file.name + '\u2026', 'loading');
    const label = document.getElementById('ssSFDropLabel');
    if (label) label.innerHTML = '<strong>' + _esc(file.name) + '</strong> (' + _sz(file.size) + ')';
    document.getElementById('ssSFDropZone')?.classList.add('has-file');
    const reader = new FileReader();
    reader.onload = e => {
      ssBridge.init().then(() => ssBridge.loadSFBuffer(e.target.result, file.name));
    };
    reader.onerror = () => _sfSetStatus('File read error', 'err');
    reader.readAsArrayBuffer(file);
  }

  window.ssLoadSFUrl = function () {
    const url = document.getElementById('ssSFUrl')?.value.trim();
    if (!url) { typeof showToast === 'function' && showToast('Enter a .sf2 URL first'); return; }
    _sfSetStatus('Connecting\u2026', 'loading');
    ssBridge.init().then(() => ssBridge.loadSF(url));
  };

  window.ssToggleUrlRow = function () {
    const row = document.getElementById('ssSFUrlRow'), t = document.getElementById('ssUrlToggle');
    if (!row) return;
    const v = row.classList.toggle('visible');
    if (t) t.textContent = v ? 'hide URL input' : 'or load from URL instead';
  };

  window.ssUpdateSetting = function (key, value) {
    if (key === 'bufferSec') { ssBridge.resizeBuffer(value); return; }
    ssBridge.updateSetting(key, value);
  };

  function _sfSetStatus(text, cls) {
    const el = document.getElementById('ssSFStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'ss-status ' + (cls || 'idle');
  }
  function _esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function _sz(b)  { return b < 1048576 ? (b/1024).toFixed(1)+' KB' : (b/1048576).toFixed(1)+' MB'; }

})();


// ═══════════════════════════════════════════════════════════════════════════
//  SnappySynth Bridge
//  Owns the SharedArrayBuffer, both worklet nodes, and all signalling.
// ═══════════════════════════════════════════════════════════════════════════
const ssBridge = (function () {
  let audioCtx    = null;
  let renderNode  = null;   // snappy-render
  let playerNode  = null;   // snappy-player
  let sab         = null;   // SharedArrayBuffer
  let ctrl        = null;   // Int32Array view of SAB control block
  let ringFrames  = 0;      // ring size in frames
  let bufferSec   = 6;      // configurable buffer duration
  let _initPromise = null;

  const _settings = {
    numVoices: 512, numLayers: 4, velThresh: 0,
    limiterEnabled: true, limiterThreshold: 0.95,
    limiterAttack: 0.003, limiterRelease: 0.25,
    masterVol: 1.0,
  };

  // ctrl indices
  const W = 0, R = 1, PLAY = 2, SKIP = 3;

  function _makeSAB(sec, sr) {
    // Layout: [ringL float32 × N] [ringR float32 × N] [ctrl int32 × 4]
    const frames     = sr * sec;
    const ringBytes  = frames * 4;         // float32
    const ctrlBytes  = 16;                 // 4 × int32
    const totalBytes = ringBytes * 2 + ctrlBytes;
    const buf   = new SharedArrayBuffer(totalBytes);
    const c     = new Int32Array(buf, ringBytes * 2, 4);
    Atomics.store(c, W,    0);
    Atomics.store(c, R,    0);
    Atomics.store(c, PLAY, 0);
    Atomics.store(c, SKIP, 0);
    return { buf, frames };
  }

  function _sfSetStatus(text, cls) {
    const el = document.getElementById('ssSFStatus');
    if (!el) return;
    el.textContent  = text;
    el.className    = 'ss-status ' + (cls || 'idle');
  }

  // Start the stats refresh loop (runs while bridge is active)
  let _statsRaf = null;
  function _startStatsLoop() {
    if (_statsRaf) return;
    function tick() {
      if (!ctrl) { _statsRaf = null; return; }
      const writePos  = Atomics.load(ctrl, W);
      const readPos   = Atomics.load(ctrl, R);
      const skip      = Atomics.load(ctrl, SKIP);
      const buffered  = Math.max(0, writePos - readPos);
      const sr        = audioCtx ? audioCtx.sampleRate : 48000;
      const bufSec    = buffered / sr;
      const pct       = Math.min(100, (bufSec / bufferSec) * 100);

      const fill = document.getElementById('ssBufFill');
      const cur  = document.getElementById('ssBufSecCur');
      const badge = document.getElementById('ssSkipBadge');
      if (fill)  fill.style.width  = pct.toFixed(1) + '%';
      if (cur)   cur.textContent   = bufSec.toFixed(1) + ' s';
      if (badge) { badge.textContent = 'skip >' + skip; badge.classList.toggle('on', skip > 0); }

      _statsRaf = requestAnimationFrame(tick);
    }
    _statsRaf = requestAnimationFrame(tick);
  }

  // ── init ──────────────────────────────────────────────────────────────────
  async function init() {
    if (_initPromise) return _initPromise;
    _initPromise = _doInit();
    return _initPromise;
  }

  async function _doInit() {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.audioWorklet.addModule('SnappySynthDriver.js');

      const sr = audioCtx.sampleRate;
      const { buf, frames } = _makeSAB(bufferSec, sr);
      sab        = buf;
      ringFrames = frames;
      const ringBytes = frames * 4;
      ctrl = new Int32Array(sab, ringBytes * 2, 4);

      // Render node — no audio output connected; runs in background
      renderNode = new AudioWorkletNode(audioCtx, 'snappy-render', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      });
      renderNode.port.onmessage = ({ data: d }) => {
        if      (d.type === 'sf_loading') _sfSetStatus('Parsing\u2026', 'loading');
        else if (d.type === 'sf_loaded')  {
          _sfSetStatus('Loaded \u2714', 'ok');
          const r = document.getElementById('ssSFRegions');
          if (r) r.textContent = d.regionCount + ' regions';
        }
        else if (d.type === 'sf_error')   _sfSetStatus('Error: ' + d.message, 'err');
        else if (d.type === 'stats') {
          const el = document.getElementById('ssVoiceCount');
          if (el) el.textContent = d.activeVoices;
        }
      };
      // Send SAB to render node
      renderNode.port.postMessage({ type: 'init', sab, settings: { ..._settings } });
      // Connect to a muted gain so the worklet stays alive but makes no sound
      const mute = audioCtx.createGain(); mute.gain.value = 0;
      renderNode.connect(mute); mute.connect(audioCtx.destination);

      // Player node — connected to destination; drains SAB
      playerNode = new AudioWorkletNode(audioCtx, 'snappy-player', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      });
      playerNode.port.postMessage({ type: 'init', sab });
      playerNode.connect(audioCtx.destination);

      _startStatsLoop();
    } catch (err) {
      console.error('[SnappySynth] init error:', err);
      _sfSetStatus('Init failed: ' + err.message, 'err');
      _initPromise = null;
      throw err;
    }
  }

  // ── public API ────────────────────────────────────────────────────────────

  function play() {
    if (!ctrl) return;
    if (audioCtx?.state === 'suspended') audioCtx.resume();
    Atomics.store(ctrl, PLAY, 1);
  }

  function pause() {
    if (!ctrl) return;
    Atomics.store(ctrl, PLAY, 0);
    // Render node keeps filling ahead — we do NOT reset writePos
  }

  function seek() {
    // Hard reset: flush buffer so stale audio is discarded
    if (ctrl) {
      Atomics.store(ctrl, PLAY, 0);
      Atomics.store(ctrl, W, 0);
      Atomics.store(ctrl, R, 0);
      Atomics.store(ctrl, SKIP, 0);
    }
    if (renderNode) renderNode.port.postMessage({ type: 'seek' });
  }

  function panic() {
    if (renderNode) renderNode.port.postMessage({ type: 'reset' });
  }

  function sendDword(dword) {
    if (!renderNode) return;
    if (audioCtx?.state === 'suspended') audioCtx.resume();
    renderNode.port.postMessage({ type: 'midi', dword });
  }

  function loadSFBuffer(arrayBuffer, filename) {
    if (!renderNode) return;
    renderNode.port.postMessage(
      { type: 'load_sf_buffer', buffer: arrayBuffer, filename },
      [arrayBuffer]
    );
  }

  function loadSF(url) {
    if (!renderNode) return;
    renderNode.port.postMessage({ type: 'reload_sf', url });
  }

  function updateSetting(key, value) {
    _settings[key] = value;
    if (renderNode) renderNode.port.postMessage({ type: 'settings', settings: { [key]: value } });
  }

  async function resizeBuffer(sec) {
    bufferSec = sec;
    if (!audioCtx || !renderNode || !playerNode) return;
    // Pause playback, rebuild SAB, re-init both nodes
    pause();
    const sr = audioCtx.sampleRate;
    const { buf, frames } = _makeSAB(sec, sr);
    sab        = buf;
    ringFrames = frames;
    const ringBytes = frames * 4;
    ctrl = new Int32Array(sab, ringBytes * 2, 4);
    renderNode.port.postMessage({ type: 'init', sab, settings: {} });
    playerNode.port.postMessage({ type: 'init', sab });
  }

  function isActive() { return !!renderNode; }

  return { init, play, pause, seek, panic, sendDword, loadSFBuffer, loadSF, updateSetting, resizeBuffer, isActive };
}());
