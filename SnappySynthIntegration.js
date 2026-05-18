/**
 * SnappySynthIntegration.js  —  Pre-render buffer edition (no SharedArrayBuffer)
 *
 * The render node sends pre-rendered audio chunks to the main thread which
 * relays them immediately to the player node.  Play/pause/seek are signalled
 * via postMessage to both nodes.
 *
 * FIX CRITICAL 1: Intercept the actual play/pause flow from MPWGL2.
 *   The HTML player never calls window._setPlaying() — it sets isPlaying
 *   directly and calls startScheduler()/stopScheduler().  We monkey-patch
 *   those two functions instead so the bridge always knows the play state.
 *
 * FIX CRITICAL 2: _enqueueMidi override now also handles the case where
 *   the Embedded Synth tab is active but midiEnabled was set to false by
 *   the tab switch — we bypass the midiEnabled gate entirely for the synth.
 *
 * FIX CRITICAL 3: ssBridge.play() is called from our patched
 *   startScheduler() every time the player starts, not just on tab activate.
 *
 * FIX CRITICAL 4: After SF2 finishes loading, re-sync the play state so
 *   voices become active immediately if playback was already running.
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
    btn.className = 'midi-tab'; btn.id = 'tabSnappy';
    btn.innerHTML = 'Embedded Synth<span class="ss-badge">New</span>';
    btn.addEventListener('click', () => _ssActivateTab());
    tabsContainer.appendChild(btn);
  }

  // ── 3. Panel HTML ─────────────────────────────────────────────────────────
  const outSection = document.querySelector('.midi-out-section');
  if (outSection) {
    const panel = document.createElement('div');
    panel.className = 'midi-panel'; panel.id = 'snappyPanel';
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

      <div class="ss-section-label">Pre-render Buffer</div>
      <div class="ss-row">
        <span class="ss-label">Size (s)</span>
        <input class="ss-slider" type="range" min="1" max="30" step="1" value="8"
          oninput="ssUpdateSetting('bufferSec',+this.value);document.getElementById('ssBufSecVal').textContent=this.value">
        <span class="ss-val" id="ssBufSecVal">8</span>
      </div>
      <div class="ss-row" style="flex-direction:column;align-items:flex-start;gap:.18rem">
        <div style="display:flex;justify-content:space-between;width:100%;font-size:.58rem;color:rgba(196,181,253,.3)">
          <span>Buffered</span><span id="ssBufSecCur">0.0 s</span>
        </div>
        <div id="ssBufBar"><div id="ssBufFill" style="width:0%"></div></div>
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

  // ── 4. Helpers ────────────────────────────────────────────────────────────
  function _ssIsActive() {
    return !!document.getElementById('tabSnappy')?.classList.contains('active');
  }

  // ── 5. Tab activation ─────────────────────────────────────────────────────
  function _ssActivateTab() {
    ['tabWmidi','tabMidiIn','tabNone'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.classList.remove('active'); el.classList.add('ss-tab-disabled'); }
    });
    ['panelWmidi','panelMidiIn','panelNone'].forEach(id => {
      const el = document.getElementById(id); if (el) el.classList.remove('on');
    });
    document.getElementById('tabSnappy')?.classList.add('active');
    document.getElementById('snappyPanel')?.classList.add('on');
    // Disable native MIDI output — we take over _enqueueMidi
    if (typeof window.midiEnabled !== 'undefined') window.midiEnabled = false;

    // FIX CRITICAL 1+3: init bridge, then immediately signal play if the
    // player is currently running.  We read the real isPlaying var from the
    // MPWGL2 scope via the global reference we set up in startScheduler hook.
    ssBridge.init().then(() => {
      if (window._ssIsPlaying) ssBridge.play();
    });
  }

  function _ssDeactivateTab() {
    ['tabWmidi','tabMidiIn','tabNone'].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.classList.remove('ss-tab-disabled'); }
    });
    document.getElementById('tabSnappy')?.classList.remove('active');
    document.getElementById('snappyPanel')?.classList.remove('on');
    ssBridge.pause(); ssBridge.panic();
  }

  ['tabWmidi','tabMidiIn','tabNone'].forEach(id => {
    const btn = document.getElementById(id); if (!btn) return;
    btn.addEventListener('click', () => {
      _ssDeactivateTab();
      if (id !== 'tabNone' && typeof window.midiEnabled !== 'undefined')
        window.midiEnabled = true;
    }, true);
  });

  // ── 6. FIX CRITICAL 1+3: Patch startScheduler / stopScheduler ────────────
  // MPWGL2 never calls _setPlaying(). It calls startScheduler() to begin
  // playback and stopScheduler() / _midiAllOff() to stop.  We wrap those
  // functions so the bridge always receives play/pause signals.
  //
  // We defer the patch to the next microtask so that MPWGL2's own
  // startScheduler definition has already been evaluated.
  Promise.resolve().then(() => {
    const _origStart = window.startScheduler;
    const _origStop  = window.stopScheduler;

    window.startScheduler = function () {
      window._ssIsPlaying = true;
      if (_ssIsActive()) ssBridge.play();
      if (typeof _origStart === 'function') _origStart.apply(this, arguments);
    };

    window.stopScheduler = function () {
      window._ssIsPlaying = false;
      if (_ssIsActive()) ssBridge.pause();
      if (typeof _origStop === 'function') _origStop.apply(this, arguments);
    };
  });

  // ── 7. FIX CRITICAL 2: Intercept _enqueueMidi ────────────────────────────
  // We override _enqueueMidi AFTER the page script has defined it so
  // _origEnqueue is always the real implementation.
  // When the Embedded Synth tab is active we route every MIDI event directly
  // to the render worklet as a DWORD, bypassing the midiEnabled gate.
  Promise.resolve().then(() => {
    const _origEnqueue = window._enqueueMidi;
    window._enqueueMidi = function (data, timestampMs) {
      if (_ssIsActive()) {
        // Build a 3-byte MIDI DWORD: status | (data1<<8) | (data2<<16)
        const dword = (data[0] & 0xFF) |
                      (((data[1] || 0) & 0xFF) << 8) |
                      (((data[2] || 0) & 0xFF) << 16);
        ssBridge.sendDword(dword);
        return;
      }
      if (typeof _origEnqueue === 'function') _origEnqueue(data, timestampMs);
    };
  });

  // ── 8. FIX CRITICAL 4: expose _ssIsPlaying via stopPlayback patch ─────────
  // stopPlayback() in MPWGL2 sets isPlaying=false and calls stopScheduler().
  // Our stopScheduler hook covers the pause case already, but we also patch
  // stopPlayback to make sure _ssIsPlaying stays in sync on hard stop.
  Promise.resolve().then(() => {
    const _origStop = window.stopPlayback;
    window.stopPlayback = function () {
      window._ssIsPlaying = false;
      if (_ssIsActive()) { ssBridge.pause(); ssBridge.panic(); }
      if (typeof _origStop === 'function') _origStop.apply(this, arguments);
    };
  });

  // ── 9. SF loading UI helpers ──────────────────────────────────────────────
  window.ssSFFileChosen = function (input) {
    const file = input.files && input.files[0]; if (file) _readAndLoadFile(file);
  };
  window.ssSFDropped = function (event) {
    event.preventDefault();
    document.getElementById('ssSFDropZone')?.classList.remove('dragover');
    const file = event.dataTransfer?.files?.[0]; if (!file) return;
    if (!file.name.toLowerCase().endsWith('.sf2')) { _sfSetStatus('Not an .sf2 file','err'); return; }
    _readAndLoadFile(file);
  };
  function _readAndLoadFile(file) {
    _sfSetStatus('Reading ' + file.name + '…', 'loading');
    const label = document.getElementById('ssSFDropLabel');
    if (label) label.innerHTML = '<strong>' + _esc(file.name) + '</strong> (' + _sz(file.size) + ')';
    document.getElementById('ssSFDropZone')?.classList.add('has-file');
    const reader = new FileReader();
    // FIX CRITICAL 4: after the SF2 is loaded and parsed inside the worklet
    // the sf_loaded message handler in the bridge will call play() if we are
    // currently playing — see ssBridge._doInit() renderNode.port.onmessage.
    reader.onload  = e => ssBridge.init().then(() => {
      ssBridge.loadSFBuffer(e.target.result, file.name);
      // Do NOT call play() here — wait for sf_loaded from the worklet so we
      // know voices are actually ready before draining the ring.
    });
    reader.onerror = () => _sfSetStatus('File read error', 'err');
    reader.readAsArrayBuffer(file);
  }
  window.ssLoadSFUrl = function () {
    const url = document.getElementById('ssSFUrl')?.value.trim();
    if (!url) { typeof showToast==='function' && showToast('Enter a .sf2 URL first'); return; }
    _sfSetStatus('Connecting…', 'loading');
    ssBridge.init().then(() => ssBridge.loadSF(url));
  };
  window.ssToggleUrlRow = function () {
    const row=document.getElementById('ssSFUrlRow'), t=document.getElementById('ssUrlToggle');
    if (!row) return;
    const v=row.classList.toggle('visible');
    if (t) t.textContent=v?'hide URL input':'or load from URL instead';
  };
  window.ssUpdateSetting = function (key, value) { ssBridge.updateSetting(key, value); };

  function _sfSetStatus(text, cls) {
    const el=document.getElementById('ssSFStatus'); if (!el) return;
    el.textContent=text; el.className='ss-status '+(cls||'idle');
  }
  function _esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function _sz(b) { return b<1048576?(b/1024).toFixed(1)+' KB':(b/1048576).toFixed(1)+' MB'; }

})();


// ═════════════════════════════════════════════════════════════════════════════
//  SnappySynth Bridge  —  owns both worklet nodes, relays chunks, signals play
// ═════════════════════════════════════════════════════════════════════════════
const ssBridge = (function () {
  let audioCtx     = null;
  let renderNode   = null;
  let playerNode   = null;
  let _initPromise = null;
  let _modulePromise = null;
  let _bufferSec   = 8;
  let _playing     = false;

  const _driverURL = new URL('SnappySynthDriver.js', document.baseURI).href;

  const _settings = {
    numVoices:512, numLayers:4, velThresh:0,
    limiterEnabled:true, limiterThreshold:0.95,
    limiterAttack:0.003, limiterRelease:0.25,
    masterVol:1.0,
  };

  let _statBufSec = 0;
  let _statSkip   = 0;
  let _statsRaf   = null;

  // ── Pre-load module on first user gesture ─────────────────────────────────
  function _preloadModule() {
    if (_modulePromise) return _modulePromise;
    if (!window.AudioWorklet) { _modulePromise = Promise.resolve(); return _modulePromise; }
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      _modulePromise = audioCtx.audioWorklet.addModule(_driverURL);
      _modulePromise.catch(() => { _modulePromise = null; audioCtx = null; });
    } catch(e) { _modulePromise = null; audioCtx = null; }
    return _modulePromise || Promise.resolve();
  }

  ['click','keydown','touchstart'].forEach(ev =>
    document.addEventListener(ev, function _once() {
      document.removeEventListener(ev, _once);
      _preloadModule();
    }, { once: true, passive: true })
  );

  function _sfSetStatus(text, cls) {
    const el = document.getElementById('ssSFStatus'); if (!el) return;
    el.textContent = text; el.className = 'ss-status ' + (cls || 'idle');
  }

  function _startStatsLoop() {
    if (_statsRaf) return;
    function tick() {
      if (!renderNode) { _statsRaf = null; return; }
      const fill  = document.getElementById('ssBufFill');
      const cur   = document.getElementById('ssBufSecCur');
      const badge = document.getElementById('ssSkipBadge');
      const pct   = Math.min(100, (_statBufSec / _bufferSec) * 100);
      if (fill)  fill.style.width = pct.toFixed(1) + '%';
      if (cur)   cur.textContent  = _statBufSec.toFixed(1) + ' s';
      if (badge) { badge.textContent = 'skip >' + _statSkip; badge.classList.toggle('on', _statSkip > 0); }
      window._ssSkipVel = _statSkip;
      _statsRaf = requestAnimationFrame(tick);
    }
    _statsRaf = requestAnimationFrame(tick);
  }

  async function init() {
    if (_initPromise) return _initPromise;
    _initPromise = _doInit();
    return _initPromise;
  }

  async function _doInit() {
    try {
      if (_modulePromise) {
        await _modulePromise;
      } else {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        await audioCtx.audioWorklet.addModule(_driverURL);
      }

      if (audioCtx.state === 'suspended') await audioCtx.resume();

      // Render node — output muted, keeps worklet alive
      renderNode = new AudioWorkletNode(audioCtx, 'snappy-render', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      });
      renderNode.port.onmessage = ({ data: d }) => {
        if (d.type === 'sf_loading') {
          _sfSetStatus('Parsing…', 'loading');
        } else if (d.type === 'sf_loaded') {
          _sfSetStatus('Loaded ✔', 'ok');
          const r = document.getElementById('ssSFRegions');
          if (r) r.textContent = d.regionCount + ' regions';
          // FIX CRITICAL 4: voices are now ready — if we were playing before
          // the SF2 finished loading, resume the render + player nodes.
          if (_playing) {
            renderNode.port.postMessage({ type: 'playing', value: true });
            playerNode?.port.postMessage({ type: 'playing', value: true });
          }
        } else if (d.type === 'sf_error') {
          _sfSetStatus('Error: ' + d.message, 'err');
        } else if (d.type === 'stats') {
          _statBufSec = d.bufferSec;
          _statSkip   = d.skipping;
          const el = document.getElementById('ssVoiceCount');
          if (el) el.textContent = d.activeVoices;
        } else if (d.type === 'chunk') {
          playerNode.port.postMessage({ type: 'chunk', bufL: d.bufL, bufR: d.bufR }, [d.bufL, d.bufR]);
        } else if (d.type === 'flush') {
          playerNode.port.postMessage({ type: 'flush' });
        }
      };
      const mute = audioCtx.createGain(); mute.gain.value = 0;
      renderNode.connect(mute); mute.connect(audioCtx.destination);
      renderNode.port.postMessage({ type: 'init', settings: { ..._settings } });

      // Player node — connected to destination
      playerNode = new AudioWorkletNode(audioCtx, 'snappy-player', {
        numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      });
      playerNode.connect(audioCtx.destination);

      // FIX CRITICAL 3: if play() was called before init finished propagate now
      if (_playing) {
        renderNode.port.postMessage({ type: 'playing', value: true });
        playerNode.port.postMessage({ type: 'playing', value: true });
      }

      _startStatsLoop();
    } catch (err) {
      console.error('[SnappySynth] init error:', err);
      _sfSetStatus('Init failed: ' + err.message, 'err');
      _initPromise = null; throw err;
    }
  }

  function play() {
    _playing = true;
    if (audioCtx?.state === 'suspended') audioCtx.resume();
    renderNode?.port.postMessage({ type: 'playing', value: true });
    playerNode?.port.postMessage({ type: 'playing', value: true });
  }

  function pause() {
    _playing = false;
    renderNode?.port.postMessage({ type: 'playing', value: false });
    playerNode?.port.postMessage({ type: 'playing', value: false });
  }

  function seek() {
    _playing = false;
    renderNode?.port.postMessage({ type: 'seek' });
  }

  function panic() {
    renderNode?.port.postMessage({ type: 'reset' });
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
    if (key === 'bufferSec') { _bufferSec = value; return; }
    renderNode?.port.postMessage({ type: 'settings', settings: { [key]: value } });
  }

  function isActive() { return !!renderNode; }

  return { init, play, pause, seek, panic, sendDword, loadSFBuffer, loadSF, updateSetting, isActive };
}());
