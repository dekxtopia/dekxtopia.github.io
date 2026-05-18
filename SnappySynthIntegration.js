/**
 * SnappySynthIntegration.js — Embedded Synth tab for MPWGL2
 *
 * Hooks into _enqueueMidi and routes MIDI DWORDs to a single
 * AudioWorkletProcessor (snappy-synth) that renders SF2 audio directly.
 *
 * Flow:
 *   MPWGL2 scheduler → _enqueueMidi(data) → ssBridge.sendDword(dword)
 *   → worklet port → process() → outputs[0] → AudioContext destination → speakers
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

  // ── 4. Tab activation / deactivation ──────────────────────────────────────
  function _ssIsActive() {
    return !!document.getElementById('tabSnappy')?.classList.contains('active');
  }

  function _ssActivateTab() {
    // Disable other tabs visually
    ['tabWmidi', 'tabMidiIn', 'tabNone'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.classList.remove('active'); el.classList.add('ss-tab-disabled'); }
    });
    ['panelWmidi', 'panelMidiIn', 'panelNone'].forEach(id => {
      const el = document.getElementById(id); if (el) el.classList.remove('on');
    });
    document.getElementById('tabSnappy')?.classList.add('active');
    document.getElementById('snappyPanel')?.classList.add('on');
    // Disable native MIDI output
    if (typeof window.midiEnabled !== 'undefined') window.midiEnabled = false;
    // Ensure AudioContext + worklet are ready
    ssBridge.init();
  }

  function _ssDeactivateTab() {
    ['tabWmidi', 'tabMidiIn', 'tabNone'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('ss-tab-disabled');
    });
    document.getElementById('tabSnappy')?.classList.remove('active');
    document.getElementById('snappyPanel')?.classList.remove('on');
    ssBridge.panic();
  }

  ['tabWmidi', 'tabMidiIn', 'tabNone'].forEach(id => {
    const btn = document.getElementById(id); if (!btn) return;
    btn.addEventListener('click', () => {
      _ssDeactivateTab();
      if (id !== 'tabNone' && typeof window.midiEnabled !== 'undefined')
        window.midiEnabled = true;
    }, true);
  });

  // ── 5. Intercept _enqueueMidi ─────────────────────────────────────────────
  // We defer with Promise.resolve() so the page's own _enqueueMidi is already
  // defined when we capture it.
  Promise.resolve().then(() => {
    const _orig = window._enqueueMidi;
    window._enqueueMidi = function (data, timestampMs) {
      if (_ssIsActive()) {
        // Build MIDI DWORD: status | (b1<<8) | (b2<<16)
        const dword = (data[0] & 0xFF)
                    | (((data[1] || 0) & 0xFF) << 8)
                    | (((data[2] || 0) & 0xFF) << 16);
        ssBridge.sendDword(dword);
        return;
      }
      if (typeof _orig === 'function') _orig(data, timestampMs);
    };
  });

  // Also intercept stopPlayback/stopScheduler to flush voices on stop
  Promise.resolve().then(() => {
    const _origStop = window.stopPlayback || window.stopScheduler;
    const patchFn = function () {
      if (_ssIsActive()) ssBridge.panic();
      if (typeof _origStop === 'function') _origStop.apply(this, arguments);
    };
    if (window.stopPlayback)  window.stopPlayback  = patchFn;
    if (window.stopScheduler) window.stopScheduler = patchFn;
  });

  // ── 6. SF loading UI helpers ───────────────────────────────────────────────
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

})();


// ═════════════════════════════════════════════════════════════════════════════
//  ssBridge — owns the AudioContext + single AudioWorkletNode
// ═════════════════════════════════════════════════════════════════════════════
const ssBridge = (function () {
  let ctx       = null;
  let node      = null;
  let _initP    = null;
  let _modP     = null;
  const DRIVER  = new URL('SnappySynthDriver.js', document.baseURI).href;

  const _cfg = {
    numVoices:512, numLayers:4, velThresh:0, masterVol:1.0,
    limiterEnabled:true, limiterThreshold:0.95,
    limiterAttack:0.003, limiterRelease:0.25,
  };

  // Pre-load worklet module on first user gesture so it's ready instantly
  function _preload() {
    if (_modP) return _modP;
    if (!window.AudioWorklet) { _modP = Promise.resolve(); return _modP; }
    try {
      ctx  = new (window.AudioContext || window.webkitAudioContext)();
      _modP = ctx.audioWorklet.addModule(DRIVER);
      _modP.catch(() => { _modP = null; ctx = null; });
    } catch (e) { _modP = null; ctx = null; }
    return _modP || Promise.resolve();
  }
  ['click','keydown','touchstart'].forEach(ev =>
    document.addEventListener(ev, function h() {
      document.removeEventListener(ev, h);
      _preload();
    }, { once: true, passive: true })
  );

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
      if (_modP) {
        await _modP;
      } else {
        ctx  = new (window.AudioContext || window.webkitAudioContext)();
        await ctx.audioWorklet.addModule(DRIVER);
      }
      if (ctx.state === 'suspended') await ctx.resume();

      node = new AudioWorkletNode(ctx, 'snappy-synth', {
        numberOfInputs:  0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });

      // Handle messages from worklet
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

      // Connect directly to speakers
      node.connect(ctx.destination);

      // Send initial settings
      node.port.postMessage({ type: 'init', settings: { ..._cfg } });

    } catch (err) {
      console.error('[SnappySynth] init error:', err);
      _sfStatus('Init failed: ' + err.message, 'err');
      _initP = null;
      throw err;
    }
  }

  function sendDword(dword) {
    if (!node) { init(); return; }   // lazy-init on first MIDI event
    if (ctx?.state === 'suspended') ctx.resume();
    node.port.postMessage({ type: 'midi', dword });
  }

  function loadSFBuffer(arrayBuffer, name) {
    if (!node) return;
    node.port.postMessage({ type: 'load_sf_buffer', buffer: arrayBuffer, name }, [arrayBuffer]);
  }

  function loadSFUrl(url) {
    if (!node) return;
    node.port.postMessage({ type: 'reload_sf', url });
  }

  function panic() {
    node?.port.postMessage({ type: 'reset' });
  }

  function updateSetting(key, value) {
    _cfg[key] = value;
    node?.port.postMessage({ type: 'settings', settings: { [key]: value } });
  }

  return { init, sendDword, loadSFBuffer, loadSFUrl, panic, updateSetting };
}());
