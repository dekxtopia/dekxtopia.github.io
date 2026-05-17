/**
 * SnappySynthIntegration.js
 * Drop this as a <script src="SnappySynthIntegration.js"></script>
 * at the END of MPWGL2.html body, AFTER the existing <script> block.
 *
 * What it does automatically:
 *  1. Injects CSS for the Embedded Synth panel
 *  2. Injects the "Embedded Synth (New)" tab button into .midi-out-tabs
 *  3. Injects the full settings panel HTML into .midi-out-section
 *  4. Patches switchTab() and sendMIDIEvent() / sendMIDIBatch() to route
 *     MIDI as packed DWORDs (SendDirectData format) to SnappySynthDriver.js
 *
 * MIDI DWORD format (mirrors snappysynth.c SendDirectData):
 *   dword = (status & 0xFF) | ((data1 & 0xFF) << 8) | ((data2 & 0xFF) << 16)
 */

(function () {
  'use strict';

  // ── 1. Inject CSS ───────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
    .ss-badge{display:inline-block;font-size:.55rem;font-weight:700;letter-spacing:.05em;
      padding:.1rem .38rem;border-radius:999px;border:1px solid rgba(52,211,153,.35);
      background:rgba(52,211,153,.12);color:#34d399;margin-left:.3rem;vertical-align:middle;}
    #snappyPanel .ss-section-label{font-size:.55rem;font-weight:700;letter-spacing:.08em;
      text-transform:uppercase;color:rgba(196,181,253,.35);margin:.35rem 0 .18rem;}
    .ss-row{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap;margin-bottom:.25rem;}
    .ss-label{font-size:.62rem;color:rgba(196,181,253,.5);white-space:nowrap;min-width:90px;}
    .ss-ctrl{font-size:.64rem;padding:.22rem .42rem;border-radius:6px;
      border:1px solid rgba(167,139,250,.2);background:rgba(10,8,30,.7);color:#c4b5fd;flex:1;min-width:0;}
    .ss-ctrl-sm{width:72px;flex:none;}
    .ss-slider{-webkit-appearance:none;appearance:none;flex:1;height:3px;border-radius:999px;
      background:rgba(167,139,250,.18);outline:none;cursor:pointer;min-width:60px;}
    .ss-slider::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;border-radius:50%;background:#a78bfa;}
    .ss-val{font-size:.62rem;color:#a78bfa;font-variant-numeric:tabular-nums;white-space:nowrap;min-width:3.5ch;}
    .ss-status{font-size:.62rem;font-weight:600;padding:.15rem .45rem;border-radius:5px;border:1px solid;white-space:nowrap;}
    .ss-status.idle{background:rgba(167,139,250,.07);border-color:rgba(167,139,250,.18);color:rgba(196,181,253,.4);}
    .ss-status.loading{background:rgba(251,191,36,.07);border-color:rgba(251,191,36,.25);color:#fbbf24;}
    .ss-status.ok{background:rgba(52,211,153,.07);border-color:rgba(52,211,153,.25);color:#34d399;}
    .ss-status.err{background:rgba(251,113,133,.07);border-color:rgba(251,113,133,.22);color:#fb7185;}
    .ss-toggle{display:inline-flex;align-items:center;gap:.4rem;cursor:pointer;
      font-size:.62rem;color:rgba(196,181,253,.6);}
    .ss-toggle input[type=checkbox]{accent-color:#a78bfa;width:13px;height:13px;cursor:pointer;}
    #ssVoiceCount{font-size:.62rem;color:#34d399;font-variant-numeric:tabular-nums;}
  `;
  document.head.appendChild(style);

  // ── 2. Inject Tab Button ────────────────────────────────────────────────────
  const tabsContainer = document.querySelector('.midi-out-tabs');
  if (tabsContainer) {
    const btn = document.createElement('button');
    btn.className = 'midi-tab';
    btn.id = 'tabSnappy';
    btn.innerHTML = 'Embedded Synth<span class="ss-badge">New</span>';
    btn.addEventListener('click', () => window.switchTab && window.switchTab('snappy'));
    tabsContainer.appendChild(btn);
  }

  // ── 3. Inject Panel HTML ───────────────────────────────────────────────────
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
      <div class="ss-row">
        <input class="ss-ctrl" id="ssSFUrl" type="url"
          placeholder="https://example.com/soundfont.sf2" spellcheck="false">
        <button class="btn-md" onclick="ssLoadSF()">Load</button>
      </div>
      <div class="ss-row">
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
        <span class="ss-label">Active Voices</span>
        <span id="ssVoiceCount">—</span>
      </div>

      <div class="ss-section-label">Buffer</div>
      <div class="ss-row">
        <span class="ss-label">Buffer Frames</span>
        <select class="ss-ctrl ss-ctrl-sm" onchange="ssUpdateSetting('bufferFrames',+this.value)">
          <option value="128">128</option>
          <option value="256" selected>256</option>
          <option value="512">512</option>
          <option value="1024">1024</option>
        </select>
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

  // ── 4. Patch switchTab to show/hide snappyPanel ──────────────────────────
  // We wrap the existing switchTab from MPWGL2 to include our panel
  const _origSwitch = window.switchTab;
  window.switchTab = function (tab) {
    // Let original handler run first (it shows/hides other panels)
    if (typeof _origSwitch === 'function') _origSwitch(tab);

    // Show/hide snappy panel
    const panel = document.getElementById('snappyPanel');
    const tabBtn = document.getElementById('tabSnappy');
    if (panel) panel.classList.toggle('on', tab === 'snappy');
    if (tabBtn) tabBtn.classList.toggle('active', tab === 'snappy');

    if (tab === 'snappy' && !ssBridge.isActive()) {
      ssBridge.init();
    }
    if (tab !== 'snappy') {
      ssBridge.panic();
    }
  };

  // ── 5. Patch MIDI output routing ─────────────────────────────────────────────
  // Intercept sendMIDIEvent(status, data1, data2) when embedded tab active.
  // DWORD packing mirrors snappysynth.c SendDirectData:
  //   dword = status | (data1 << 8) | (data2 << 16)
  const _origSend = window.sendMIDIEvent;
  window.sendMIDIEvent = function (status, data1, data2) {
    if (document.getElementById('tabSnappy')?.classList.contains('active')) {
      ssBridge.sendDword((status & 0xFF) | ((data1 & 0xFF) << 8) | ((data2 & 0xFF) << 16));
      return;
    }
    if (typeof _origSend === 'function') _origSend(status, data1, data2);
  };

  const _origBatch = window.sendMIDIBatch;
  window.sendMIDIBatch = function (messages) {
    if (document.getElementById('tabSnappy')?.classList.contains('active')) {
      ssBridge.sendBatch(messages.map(m =>
        (m[0] & 0xFF) | ((m[1] & 0xFF) << 8) | ((m[2] & 0xFF) << 16)
      ));
      return;
    }
    if (typeof _origBatch === 'function') _origBatch(messages);
  };

  // ── 6. Global UI helpers (called from injected HTML onclick) ─────────────
  window.ssLoadSF = function () {
    const url = document.getElementById('ssSFUrl')?.value.trim();
    if (!url) { typeof showToast === 'function' && showToast('Enter a .sf2 URL first'); return; }
    const st = document.getElementById('ssSFStatus');
    if (st) { st.textContent = 'Connecting…'; st.className = 'ss-status loading'; }
    ssBridge.loadSF(url);
  };

  window.ssUpdateSetting = function (key, value) {
    ssBridge.updateSetting(key, value);
  };

})();

// ═══════════════════════════════════════════════════════════════════════════════
// SnappySynth Bridge
// Mirrors the C API surface from snappysynth.c:
//   InitializeKDMAPIStream  → ssBridge.init()
//   SendDirectData(DWORD)   → ssBridge.sendDword(dword)
//   SendMIDIDataBatch       → ssBridge.sendBatch(dwords[])
//   TerminateKDMAPIStream   → ssBridge.dispose()
//   ResetKDMAPIStream       → ssBridge.panic()
// ═══════════════════════════════════════════════════════════════════════════════
const ssBridge = (function () {
  let audioCtx = null;
  let worklet  = null;
  let gainNode = null;

  const _settings = {
    soundfontUrl:     '',
    numVoices:        512,
    numLayers:        4,
    velThresh:        0,
    bufferFrames:     256,
    limiterEnabled:   true,
    limiterThreshold: 0.95,
    limiterAttack:    0.003,
    limiterRelease:   0.25,
    masterVol:        1.0,
  };

  function _setStatus(text, cls) {
    const el = document.getElementById('ssSFStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'ss-status ' + (cls || 'idle');
  }

  async function init() {
    if (worklet) return;
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      await audioCtx.audioWorklet.addModule('SnappySynthDriver.js');
      worklet  = new AudioWorkletNode(audioCtx, 'snappy-synth', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      gainNode = audioCtx.createGain();
      gainNode.gain.value = 1.0;
      worklet.connect(gainNode);
      gainNode.connect(audioCtx.destination);

      worklet.port.onmessage = ({ data: d }) => {
        if (d.type === 'sf_loading') {
          _setStatus('Loading…', 'loading');
        } else if (d.type === 'sf_loaded') {
          _setStatus('Loaded \u2714', 'ok');
          const r = document.getElementById('ssSFRegions');
          if (r) r.textContent = d.regionCount + ' regions';
        } else if (d.type === 'sf_error') {
          _setStatus('Error: ' + d.message, 'err');
        } else if (d.type === 'stats') {
          const el = document.getElementById('ssVoiceCount');
          if (el) el.textContent = d.activeVoices;
        }
      };

      worklet.port.postMessage({ type: 'init', settings: { ..._settings } });
    } catch (err) {
      console.error('[SnappySynth] AudioWorklet init error:', err);
      _setStatus('Init failed: ' + err.message, 'err');
    }
  }

  function dispose() {
    if (worklet)  { worklet.disconnect();  worklet  = null; }
    if (gainNode) { gainNode.disconnect(); gainNode = null; }
    if (audioCtx) { audioCtx.close();      audioCtx = null; }
    _setStatus('Not loaded', 'idle');
  }

  function loadSF(url) {
    _settings.soundfontUrl = url;
    if (!worklet) { init().then(() => worklet?.port.postMessage({ type: 'reload_sf', url })); return; }
    worklet.port.postMessage({ type: 'reload_sf', url });
  }

  function updateSetting(key, value) {
    _settings[key] = value;
    if (worklet) worklet.port.postMessage({ type: 'settings', settings: { [key]: value } });
  }

  // sendDword — SendDirectData-compatible packed DWORD
  function sendDword(dword) {
    if (!worklet) return;
    if (audioCtx?.state === 'suspended') audioCtx.resume();
    worklet.port.postMessage({ type: 'midi', dword });
  }

  function sendBatch(dwords) {
    if (!worklet || !dwords.length) return;
    if (audioCtx?.state === 'suspended') audioCtx.resume();
    worklet.port.postMessage({ type: 'midi_batch', dwords });
  }

  function panic() {
    if (worklet) worklet.port.postMessage({ type: 'reset' });
  }

  function isActive() { return !!worklet; }

  return { init, dispose, loadSF, updateSetting, sendDword, sendBatch, panic, isActive };
}());
