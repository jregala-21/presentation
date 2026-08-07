/* ONLYOFFICE real-time PPTX integration.
 * Configure ONLYOFFICE_BRIDGE_URL below or set window.ONLYOFFICE_BRIDGE_URL before this script loads.
 */
(() => {
  'use strict';

  const BRIDGE_URL = String(window.ONLYOFFICE_BRIDGE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const state = {
    busy: false,
    editor: null,
    sessionId: '',
    sessionToken: '',
    sourceFileId: '',
    sourceFileName: '',
    sourceFileSize: 0,
    lastSavedRevision: 0,
    apiScriptLoaded: false,
    editorReady: false,
    documentDirty: false,
    changesSynchronized: true,
    lastChangeAt: 0
  };
  window.onlyOfficePptxState = state;

  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function setStatus(message, type = '') {
    const el = $('onlyoffice-editor-status');
    if (!el) return;
    el.textContent = message || '';
    el.classList.toggle('show', Boolean(message));
    el.classList.toggle('error', type === 'error');
  }

  function setProgress(percent, label = '') {
    const value = Math.max(0, Math.min(100, Number(percent) || 0));
    const bar = $('onlyoffice-editor-progress-bar');
    const text = $('onlyoffice-editor-progress-label');
    if (bar) bar.style.width = value + '%';
    if (text) text.textContent = label ? `${Math.round(value)}% · ${label}` : `${Math.round(value)}%`;
  }

  function setBusy(busy) {
  state.busy = Boolean(busy);

  [
    'onlyoffice-save-asset-btn',
    'onlyoffice-pdf-btn'
  ].forEach(id => {
    const element = document.getElementById(id);
    if (element) element.disabled = state.busy;
  });

  const closeButton = document.getElementById('onlyoffice-close-btn');
  if (closeButton) closeButton.disabled = false;
}

  async function jsonFetch(url, options = {}) {
    const response = await fetch(url, options);
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
    if (!response.ok || !data || data.success === false) {
      throw new Error((data && data.error) || raw || `Request failed (${response.status})`);
    }
    return data;
  }

  async function postBridge(path, body) {
    return jsonFetch(BRIDGE_URL + path, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body || {})
    });
  }

  let selectedMonitorPresentationWindow = null;
  let presenterControlWindow = null;
  const PRESENTER_SYNC_CHANNEL = 'jil_onlyoffice_presenter_sync_v2';
  const presenterSyncChannel = ('BroadcastChannel' in window) ? new BroadcastChannel(PRESENTER_SYNC_CHANNEL) : null;

  function readSelectedMonitor() {
    try {
      return JSON.parse(localStorage.getItem('mps_selected_monitor_v1') || 'null');
    } catch (_) {
      return null;
    }
  }

  function safeTitle(value) {
    return String(value || 'Presentation').replace(/[<>&"]/g, '');
  }

  function writeAudienceShell(popup, title) {
    popup.document.open();
    popup.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>${safeTitle(title)}</title>
<style>
html,body,#onlyoffice-audience-host{width:100%;height:100%;margin:0;overflow:hidden;background:#000}
body{font-family:Arial,sans-serif}.loading{position:fixed;inset:0;display:grid;place-items:center;color:#fff;background:#000;font-size:20px;z-index:10}
</style>
</head><body><div id="onlyoffice-audience-loading" class="loading">Loading presentation…</div><div id="onlyoffice-audience-host"></div></body></html>`);
    popup.document.close();
  }

  function writePresenterShell(popup, title) {
    popup.document.open();
    popup.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>Presenter View - ${safeTitle(title)}</title>
<style>
:root{color-scheme:dark;font-family:Inter,Arial,sans-serif}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;background:#202020;color:#fff;overflow:hidden}
#presenter-root{height:100vh;display:grid;grid-template-rows:minmax(0,1fr) auto auto;background:#202020}
#presenter-viewer{min-height:0;background:#272727;position:relative}
#presenter-loading{position:absolute;inset:0;display:grid;place-items:center;background:#202020;color:#ddd;z-index:3;font-size:18px}
#presenter-controls{display:flex;align-items:center;gap:10px;padding:10px 16px;background:#3a3a3a;border-top:1px solid #555;min-height:62px}
#presenter-controls button{height:38px;border:1px solid #666;background:#494949;color:#fff;border-radius:4px;padding:0 14px;font-size:16px;cursor:pointer}
#presenter-controls button:hover{background:#5a5a5a}#presenter-controls button.end{margin-left:auto;background:#444}#presenter-controls button.end:hover{background:#6b3030}
#presenter-timer{font-variant-numeric:tabular-nums;font-size:17px;min-width:86px}#presenter-slide-number{font-size:16px;min-width:110px;text-align:center}
#presenter-notes{min-height:92px;max-height:24vh;overflow:auto;padding:12px 18px;background:#242424;border-top:1px solid #424242;color:#ddd;font-size:16px;line-height:1.45}
#presenter-notes.empty{color:#888;font-style:italic}
@media(max-width:850px){#presenter-controls{gap:6px;padding:8px}#presenter-controls button{padding:0 9px;font-size:14px}#presenter-notes{min-height:70px}}
</style></head><body>
<div id="presenter-root">
  <div id="presenter-viewer"><div id="presenter-loading">Loading Presenter View…</div><div id="onlyoffice-presenter-host" style="width:100%;height:100%"></div></div>
  <div id="presenter-controls">
    <span id="presenter-timer">00:00:00</span>
    <button id="presenter-pause">⏸ Pause</button>
    <button id="presenter-reset">Reset</button>
    <button id="presenter-prev">◀</button>
    <span id="presenter-slide-number">Slide 1</span>
    <button id="presenter-next">▶</button>
    <button id="presenter-end" class="end">End slideshow</button>
  </div>
  <div id="presenter-notes" class="empty">Speaker notes will appear here when available.</div>
</div>
</body></html>`);
    popup.document.close();
  }

  async function loadOnlyOfficeApiInWindow(targetWindow, apiUrl) {
    if (targetWindow.DocsAPI) return;
    await new Promise((resolve, reject) => {
      const script = targetWindow.document.createElement('script');
      script.src = apiUrl;
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Unable to load ONLYOFFICE presentation player.'));
      targetWindow.document.head.appendChild(script);
    });
    if (!targetWindow.DocsAPI) throw new Error('ONLYOFFICE presentation player is unavailable.');
  }

  function sendPresenterCommand(type, payload = {}) {
    if (!presenterSyncChannel) return;
    presenterSyncChannel.postMessage(Object.assign({ source: 'presenter-host', type, at: Date.now() }, payload));
  }

  function setupPresenterControls(popup) {
    if (!popup || popup.closed) return;
    const d = popup.document;
    const timerEl = d.getElementById('presenter-timer');
    const slideEl = d.getElementById('presenter-slide-number');
    const notesEl = d.getElementById('presenter-notes');
    const pauseBtn = d.getElementById('presenter-pause');
    let currentIndex = 0;
    let slideCount = 0;
    let paused = false;
    let startedAt = Date.now();
    let pausedAt = 0;
    let pausedTotal = 0;

    function renderSlideNumber() {
      if (slideEl) slideEl.textContent = slideCount ? `Slide ${currentIndex + 1} of ${slideCount}` : `Slide ${currentIndex + 1}`;
    }

    function renderNotes(notes) {
      if (!notesEl) return;
      const value = String(notes || '').trim();
      notesEl.textContent = value || 'Speaker notes will appear here when available.';
      notesEl.classList.toggle('empty', !value);
    }

    const timer = popup.setInterval(() => {
      const now = paused ? pausedAt : Date.now();
      const elapsed = Math.max(0, now - startedAt - pausedTotal);
      const total = Math.floor(elapsed / 1000);
      const hh = String(Math.floor(total / 3600)).padStart(2, '0');
      const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
      const ss = String(total % 60).padStart(2, '0');
      if (timerEl) timerEl.textContent = `${hh}:${mm}:${ss}`;
    }, 250);

    const onMessage = event => {
      const msg = event && event.data || {};
      if (!msg || msg.source !== 'onlyoffice-plugin') return;
      if (msg.type === 'slidechange') {
        currentIndex = Math.max(0, Number(msg.index) || 0);
        renderSlideNumber();
        sendPresenterCommand('goto', { index: currentIndex });
      } else if (msg.type === 'meta') {
        currentIndex = Math.max(0, Number(msg.index) || currentIndex);
        slideCount = Math.max(0, Number(msg.count) || slideCount);
        renderSlideNumber();
        renderNotes(msg.notes);
      }
    };
    presenterSyncChannel?.addEventListener('message', onMessage);

    d.getElementById('presenter-prev')?.addEventListener('click', () => {
      currentIndex = Math.max(0, currentIndex - 1);
      renderSlideNumber();
      sendPresenterCommand('goto', { index: currentIndex });
    });
    d.getElementById('presenter-next')?.addEventListener('click', () => {
      currentIndex = slideCount ? Math.min(slideCount - 1, currentIndex + 1) : currentIndex + 1;
      renderSlideNumber();
      sendPresenterCommand('goto', { index: currentIndex });
    });
    pauseBtn?.addEventListener('click', () => {
      paused = !paused;
      if (paused) {
        pausedAt = Date.now();
        pauseBtn.textContent = '▶ Resume';
        sendPresenterCommand('pause');
      } else {
        pausedTotal += Date.now() - pausedAt;
        pauseBtn.textContent = '⏸ Pause';
        sendPresenterCommand('resume');
      }
    });
    d.getElementById('presenter-reset')?.addEventListener('click', () => {
      startedAt = Date.now(); pausedAt = 0; pausedTotal = 0; paused = false;
      if (pauseBtn) pauseBtn.textContent = '⏸ Pause';
      sendPresenterCommand('resume');
    });
    d.getElementById('presenter-end')?.addEventListener('click', () => {
      sendPresenterCommand('end');
      try { if (selectedMonitorPresentationWindow && !selectedMonitorPresentationWindow.closed) selectedMonitorPresentationWindow.close(); } catch (_) {}
      try { popup.close(); } catch (_) {}
    });
    popup.addEventListener('beforeunload', () => {
      popup.clearInterval(timer);
      try { presenterSyncChannel?.removeEventListener('message', onMessage); } catch (_) {}
    });
    popup.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault(); d.getElementById('presenter-next')?.click();
      } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault(); d.getElementById('presenter-prev')?.click();
      } else if (event.key === 'Escape') {
        d.getElementById('presenter-end')?.click();
      }
    });
    renderSlideNumber();
    setTimeout(() => sendPresenterCommand('request-meta', { index: currentIndex }), 1200);
  }

  async function requestFullscreenForWindow(targetWindow) {
    if (!targetWindow || targetWindow.closed) return;
    try {
      const root = targetWindow.document.documentElement;
      if (root && root.requestFullscreen) await root.requestFullscreen();
    } catch (_) {
      // Browser may require the fullscreen call to originate from the newly opened window.
    }
  }

  window.presentOnlyOfficeOnSelectedMonitor = async function() {
    if (!state.sessionId || !state.sessionToken) {
      setStatus('Open a PowerPoint file in ONLYOFFICE first.', 'error');
      return;
    }

    const monitor = readSelectedMonitor();
    if (!monitor) {
      setStatus('Select a display first using Detect Monitor in the main presenter window.', 'error');
      return;
    }

    const width = Math.max(640, Number(monitor.width) || 1280);
    const height = Math.max(480, Number(monitor.height) || 720);
    const left = Number.isFinite(Number(monitor.left)) ? Number(monitor.left) : window.screenX + window.outerWidth;
    const top = Number.isFinite(Number(monitor.top)) ? Number(monitor.top) : 0;
    const features = `popup=yes,width=${width},height=${height},left=${left},top=${top}`;

    selectedMonitorPresentationWindow = window.open('', 'OnlyOfficeSelectedMonitorPresentation', features);
    if (!selectedMonitorPresentationWindow) {
      setStatus('The presentation window was blocked. Allow pop-ups for this site and try again.', 'error');
      return;
    }

    presenterControlWindow = window.open('', 'OnlyOfficePresenterControl', 'popup=yes,width=1320,height=900,left=40,top=40');
    if (!presenterControlWindow) {
      try { selectedMonitorPresentationWindow.close(); } catch (_) {}
      setStatus('The Presenter View window was blocked. Allow pop-ups for this site and try again.', 'error');
      return;
    }

    writeAudienceShell(selectedMonitorPresentationWindow, state.sourceFileName || 'Presentation');
    // Attempt true browser fullscreen while this function still has the user's click activation.
    // If Chromium/macOS refuses it, the popup is still positioned and resized to the selected monitor.
    requestFullscreenForWindow(selectedMonitorPresentationWindow);
    writePresenterShell(presenterControlWindow, state.sourceFileName || 'Presentation');
    setupPresenterControls(presenterControlWindow);

    try {
      selectedMonitorPresentationWindow.moveTo(left, top);
      selectedMonitorPresentationWindow.resizeTo(width, height);
      selectedMonitorPresentationWindow.focus();
      presenterControlWindow.focus();
    } catch (_) {}

    try {
      setStatus(`Opening full-screen audience presentation on ${monitor.label || 'the selected monitor'} and Presenter View on this screen…`);
      const [audienceResult, presenterResult] = await Promise.all([
        postBridge(`/api/sessions/${encodeURIComponent(state.sessionId)}/view-config`, { sessionToken: state.sessionToken, mode: 'live' }),
        postBridge(`/api/sessions/${encodeURIComponent(state.sessionId)}/view-config`, { sessionToken: state.sessionToken, mode: 'presenter' })
      ]);

      await Promise.all([
        loadOnlyOfficeApiInWindow(selectedMonitorPresentationWindow, audienceResult.apiUrl),
        loadOnlyOfficeApiInWindow(presenterControlWindow, presenterResult.apiUrl)
      ]);

      const audienceLoading = selectedMonitorPresentationWindow.document.getElementById('onlyoffice-audience-loading');
      const audienceConfig = Object.assign({}, audienceResult.config, { width: '100%', height: '100%' });
      audienceConfig.events = Object.assign({}, audienceConfig.events || {}, {
        onDocumentReady() {
          if (audienceLoading) audienceLoading.remove();
          requestFullscreenForWindow(selectedMonitorPresentationWindow);
        },
        onError(event) {
          const detail = event?.data?.errorDescription || event?.data?.errorCode || 'Presentation player error';
          if (audienceLoading) audienceLoading.textContent = String(detail);
        }
      });
      selectedMonitorPresentationWindow.__onlyOfficeAudienceEditor = new selectedMonitorPresentationWindow.DocsAPI.DocEditor('onlyoffice-audience-host', audienceConfig);

      const presenterLoading = presenterControlWindow.document.getElementById('presenter-loading');
      const presenterConfig = Object.assign({}, presenterResult.config, { width: '100%', height: '100%' });
      presenterConfig.events = Object.assign({}, presenterConfig.events || {}, {
        onDocumentReady() {
          if (presenterLoading) presenterLoading.remove();
          sendPresenterCommand('goto', { index: 0 });
          sendPresenterCommand('request-meta', { index: 0 });
        },
        onError(event) {
          const detail = event?.data?.errorDescription || event?.data?.errorCode || 'Presenter View error';
          if (presenterLoading) presenterLoading.textContent = String(detail);
        }
      });
      presenterControlWindow.__onlyOfficePresenterEditor = new presenterControlWindow.DocsAPI.DocEditor('onlyoffice-presenter-host', presenterConfig);
      presenterControlWindow.focus();
      setStatus(`Presentation started on ${monitor.label || 'the selected monitor'}. Presenter View is open on this screen.`, 'success');
    } catch (error) {
      try {
        const loading = selectedMonitorPresentationWindow.document.getElementById('onlyoffice-audience-loading');
        if (loading) loading.textContent = error.message || String(error);
      } catch (_) {}
      try {
        const loading = presenterControlWindow.document.getElementById('presenter-loading');
        if (loading) loading.textContent = error.message || String(error);
      } catch (_) {}
      setStatus('Unable to start Presenter View: ' + (error.message || error), 'error');
    }
  };


  async function createLocalEditorSession(file) {
    setProgress(12, 'Sending PowerPoint to local bridge');
    const response = await fetch(`${BRIDGE_URL}/api/sessions/upload?fileName=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: {'Content-Type': PPTX_MIME, 'X-File-Name': file.name},
      body: file
    });
    const raw = await response.text();
    let result = null;
    try { result = raw ? JSON.parse(raw) : {}; } catch (_) {}
    if (!response.ok || !result || result.success === false) {
      throw new Error((result && result.error) || raw || `Local bridge upload failed (${response.status}).`);
    }
    await loadOnlyOfficeApi(result.apiUrl);
    state.sessionId = result.sessionId;
    state.sessionToken = result.sessionToken;
    state.sourceFileId = `local-${result.sessionId}`;
    state.sourceFileName = file.name;
    state.sourceFileSize = file.size;
    state.lastSavedRevision = Number(result.revision || 0);
    state.editorReady = false;
    state.documentDirty = false;
    state.changesSynchronized = true;
    state.lastChangeAt = 0;
    if (state.editor && typeof state.editor.destroyEditor === 'function') state.editor.destroyEditor();
    $('onlyoffice-editor-host').innerHTML = '';
    result.config.events = Object.assign({}, result.config.events || {}, {
      onDocumentReady() {
        state.editorReady = true;
        setStatus('Editor ready. You can edit the PPTX in ONLYOFFICE.', 'success');
      },
      onDocumentStateChange(event) {
        const editing = Boolean(event && event.data);
        if (editing) {
          state.documentDirty = true;
          state.changesSynchronized = false;
          state.lastChangeAt = Date.now();
          setStatus('Editing… waiting for ONLYOFFICE to synchronize changes.');
        } else {
          state.changesSynchronized = true;
          setStatus('Changes synchronized. You can now update the presentation asset.', 'success');
        }
      },
      onError(event) {
        const description = event && event.data && (event.data.errorDescription || event.data.errorCode);
        if (description) setStatus('ONLYOFFICE error: ' + description, 'error');
      }
    });
    state.editor = new DocsAPI.DocEditor('onlyoffice-editor-host', result.config);
    $('pptx-editor-file-name').textContent = file.name;
    $('pptx-editor-modal').classList.add('open');
    setProgress(100, 'Editor ready');
    setTimeout(() => setProgress(0, ''), 900);
  }

  async function loadOnlyOfficeApi(apiUrl) {
    if (window.DocsAPI) return;
    const existing = document.querySelector('script[data-onlyoffice-api]');
    if (existing) {
      await new Promise((resolve, reject) => {
        existing.addEventListener('load', resolve, {once:true});
        existing.addEventListener('error', () => reject(new Error('ONLYOFFICE API script failed to load.')), {once:true});
      });
      return;
    }
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = apiUrl;
      script.async = true;
      script.dataset.onlyofficeApi = '1';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Unable to load ONLYOFFICE Docs API from ' + apiUrl));
      document.head.appendChild(script);
    });
    if (!window.DocsAPI) throw new Error('ONLYOFFICE Docs API is unavailable.');
  }

  async function uploadFileToDrive(file, label = 'Uploading PowerPoint') {
    const init = await postGoogleScriptJson({
      action: 'initResumableFileUpload',
      fileName: file.name,
      mimeType: file.type || PPTX_MIME,
      fileSize: file.size
    });
    if (!init.uploadUrl) throw new Error('Apps Script did not return an upload URL.');
    const chunkSize = 4 * 1024 * 1024;
    let offset = 0, finalResult = null;
    while (offset < file.size) {
      const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size), file.type || PPTX_MIME);
      const start = offset;
      finalResult = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', init.uploadUrl, true);
        xhr.setRequestHeader('Content-Type', file.type || PPTX_MIME);
        xhr.setRequestHeader('Content-Range', `bytes ${start}-${start + chunk.size - 1}/${file.size}`);
        xhr.upload.onprogress = event => {
          if (event.lengthComputable) setProgress(((start + event.loaded) / file.size) * 55, label);
        };
        xhr.onerror = () => reject(new Error('Network error while uploading the PowerPoint file.'));
        xhr.onload = () => {
          if ([200, 201, 308].includes(xhr.status)) {
            let parsed = {}; try { parsed = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
            resolve(parsed);
          } else reject(new Error(`Drive rejected the upload (${xhr.status}).`));
        };
        xhr.send(chunk);
      });
      offset += chunk.size;
    }
    if (finalResult && (finalResult.id || finalResult.fileId)) return finalResult;
    const separator = GOOGLE_SCRIPT_PDF_UPLOAD_URL.includes('?') ? '&' : '?';
    for (let attempt = 0; attempt < 5; attempt++) {
      const url = GOOGLE_SCRIPT_PDF_UPLOAD_URL + separator + new URLSearchParams({
        action:'findUploadedFile', fileName:file.name, fileSize:String(file.size), modifiedAfter:'0', _:String(Date.now())
      });
      const found = await jsonFetch(url, {cache:'no-store'});
      if (found.found && found.file) return found.file;
      await sleep(500 + attempt * 500);
    }
    throw new Error('The uploaded file could not be verified in Google Drive.');
  }

  function blobToFile(blob, fileName) {
    return new File([blob], fileName, {type: PPTX_MIME, lastModified: Date.now()});
  }

  async function createEditorSession(fileRecord) {
    const fileId = String(fileRecord.id || fileRecord.fileId || '');
    const fileName = String(fileRecord.name || fileRecord.fileName || 'Presentation.pptx');
    if (!fileId) throw new Error('Missing Drive file ID.');
    setProgress(58, 'Preparing ONLYOFFICE editor');
    const result = await postBridge('/api/sessions', {
      fileId,
      fileName,
      fileSize: Number(fileRecord.size || 0),
      appsScriptUrl: GOOGLE_SCRIPT_PDF_UPLOAD_URL
    });
    await loadOnlyOfficeApi(result.apiUrl);
    state.sessionId = result.sessionId;
    state.sessionToken = result.sessionToken;
    state.sourceFileId = fileId;
    state.sourceFileName = fileName;
    state.sourceFileSize = Number(fileRecord.size || 0);
    state.lastSavedRevision = Number(result.revision || 0);
    state.editorReady = false;
    state.documentDirty = false;
    state.changesSynchronized = true;
    state.lastChangeAt = 0;
    if (state.editor && typeof state.editor.destroyEditor === 'function') state.editor.destroyEditor();
    $('onlyoffice-editor-host').innerHTML = '';
    result.config.events = Object.assign({}, result.config.events || {}, {
      onDocumentReady() {
        state.editorReady = true;
        setStatus('Editor ready. You can edit the PPTX in ONLYOFFICE.', 'success');
      },
      onDocumentStateChange(event) {
        const editing = Boolean(event && event.data);
        if (editing) {
          state.documentDirty = true;
          state.changesSynchronized = false;
          state.lastChangeAt = Date.now();
          setStatus('Editing… waiting for ONLYOFFICE to synchronize changes.');
        } else {
          state.changesSynchronized = true;
          setStatus('Changes synchronized. You can now update the presentation asset.', 'success');
        }
      },
      onError(event) {
        const description = event && event.data && (event.data.errorDescription || event.data.errorCode);
        if (description) setStatus('ONLYOFFICE error: ' + description, 'error');
      }
    });
    state.editor = new DocsAPI.DocEditor('onlyoffice-editor-host', result.config);
    $('pptx-editor-file-name').textContent = fileName;
    $('pptx-editor-modal').classList.add('open');
    setProgress(100, 'Editor ready');
    setStatus('Edit the PowerPoint in ONLYOFFICE. Close the editor when finished.', 'success');
    setTimeout(() => setProgress(0, ''), 900);
  }

  window.startPptxEditing = async function(event) {
    const input = event && event.target;
    const file = input && input.files && input.files[0];
    if (!file || state.busy) return;
    if (!/\.pptx$/i.test(file.name)) {
      setEditStatus?.('Choose a .pptx PowerPoint file.', 'error');
      if (input) input.value = '';
      return;
    }
    setBusy(true); setStatus('Opening the local PowerPoint in ONLYOFFICE...'); setProgress(2, 'Preparing file');
    try {
      await createLocalEditorSession(file);
    } catch (error) {
      console.error(error); setStatus('Editor failed: ' + (error.message || error), 'error'); setProgress(0, '');
    } finally {
      setBusy(false); if (input) input.value = '';
    }
  };

  window.prepareExistingDrivePptx = async function(fileRecord) {
    if (state.busy) return;
    setBusy(true); setStatus('Opening existing cloud PowerPoint...');
    try { await createEditorSession(fileRecord); closeDrivePdfModal?.(); }
    catch (error) { setStatus('Editor failed: ' + (error.message || error), 'error'); throw error; }
    finally { setBusy(false); }
  };

  async function downloadCurrentSessionFile() {
    const response = await fetch(`${BRIDGE_URL}/api/sessions/${encodeURIComponent(state.sessionId)}/current?token=${encodeURIComponent(state.sessionToken)}`, {cache:'no-store'});
    if (!response.ok) throw new Error(await response.text() || 'Unable to download the current PowerPoint.');
    return response.blob();
  }

  async function waitForOnlyOfficeSynchronization(timeoutMs = 15000) {
    if (!state.documentDirty) return;
    const started = Date.now();
    setProgress(5, 'Synchronizing editor changes');
    while (Date.now() - started < timeoutMs) {
      const quietLongEnough = Date.now() - state.lastChangeAt >= 900;
      if (state.changesSynchronized && quietLongEnough) return;
      await sleep(250);
    }
    throw new Error('ONLYOFFICE is still synchronizing your latest edit. Wait a moment and try again.');
  }

  async function forceSaveAndDownload() {
    if (!state.sessionId) throw new Error('No ONLYOFFICE editing session is open.');
    await waitForOnlyOfficeSynchronization();
    let start = await postBridge(`/api/sessions/${encodeURIComponent(state.sessionId)}/forcesave`, {sessionToken:state.sessionToken});
    if (start.noChanges && state.documentDirty) {
      await sleep(1500);
      start = await postBridge(`/api/sessions/${encodeURIComponent(state.sessionId)}/forcesave`, {sessionToken:state.sessionToken});
    }
    if (start.noChanges) {
      setStatus('No new synchronized changes were found. Using the current PowerPoint file.', 'success');
      return downloadCurrentSessionFile();
    }
    const expected = Number(start.expectedRevision || state.lastSavedRevision + 1);
    setProgress(10, 'Saving from ONLYOFFICE');
    for (let attempt = 0; attempt < 60; attempt++) {
      await sleep(1000);
      const status = await jsonFetch(`${BRIDGE_URL}/api/sessions/${encodeURIComponent(state.sessionId)}/status?token=${encodeURIComponent(state.sessionToken)}`, {cache:'no-store'});
      setProgress(Math.min(65, 10 + attempt), status.message || 'Waiting for saved file');
      if (status.error) throw new Error(status.error);
      if (Number(status.revision || 0) >= expected && status.fileReady) {
        state.lastSavedRevision = Number(status.revision);
        state.documentDirty = false;
        state.changesSynchronized = true;
        const response = await fetch(`${BRIDGE_URL}/api/sessions/${encodeURIComponent(state.sessionId)}/file?token=${encodeURIComponent(state.sessionToken)}&revision=${state.lastSavedRevision}`, {cache:'no-store'});
        if (!response.ok) throw new Error(await response.text() || 'Unable to download the edited PowerPoint.');
        return response.blob();
      }
    }
    throw new Error('ONLYOFFICE did not finish saving within one minute. Press Save in the editor and try again.');
  }

  window.saveOnlyOfficePresentationAsset = async function() {
    if (state.busy || !state.sessionId) return;
    setBusy(true); setStatus('Saving the real PowerPoint and updating the presentation asset...');
    try {
      const blob = await forceSaveAndDownload();
      const editedName = state.sourceFileName || 'Presentation.pptx';
      const record = await uploadFileToDrive(blobToFile(blob, editedName), 'Uploading edited PowerPoint');
      setProgress(72, 'Creating Google Slides presentation view');
      const prepared = await postGoogleScriptJson({
        action:'prepareGoogleSlidesEditor',
        sourceFileId:String(record.id || record.fileId),
        fileName:editedName
      });
      const editorState = window.pptxEditorState;
      if (!editorState) throw new Error('Presenter PowerPoint asset state is unavailable.');
      Object.assign(editorState, {
        sourceFileId:String(record.id || record.fileId), sourceFileName:editedName,
        presentationId:String(prepared.presentationId || ''), slides:prepared.slides || [],
        originalSnapshotId:String(prepared.originalSnapshotId || ''),
        temporaryFileIds:Array.from(new Set([record.id || record.fileId, ...(prepared.temporaryFileIds || [])].filter(Boolean))),
        selectedSlideIndex:0, selectedObjectId:''
      });
      if (!editorState.presentationId) throw new Error('Google Slides did not return a presentation ID.');
      await window.addCurrentPptxPresentationToScene();
      if (state.sourceFileId && state.sourceFileId !== editorState.sourceFileId) {
        try { await postGoogleScriptJson({action:'deleteDriveFile', fileId:state.sourceFileId}); } catch (error) { console.warn('Old PPTX cleanup warning:', error); }
      }
      state.sourceFileId = editorState.sourceFileId;
      state.sourceFileSize = blob.size;
      setProgress(100, 'Presentation asset updated');
      setStatus('✅ The edited PowerPoint was saved and the presentation asset was added/updated.', 'success');
      setTimeout(() => setProgress(0, ''), 1000);
    } catch (error) {
      console.error(error); setStatus('Save failed: ' + (error.message || error), 'error'); setProgress(0, '');
    } finally { setBusy(false); }
  };

  window.convertOnlyOfficePresentationToPdf = async function() {
    if (state.busy || !state.sessionId) return;
    setBusy(true); setStatus('Saving the edited PowerPoint before PDF conversion...');
    try {
      const blob = await forceSaveAndDownload();
      const file = blobToFile(blob, state.sourceFileName || 'Presentation.pptx');
      // Reuse the presenter's existing CloudConvert conversion workflow.
      if (typeof window.convertRootPptxToPdf === 'function') {
        await window.convertRootPptxToPdf(file);
      } else {
        const input = document.getElementById('pptx-editor-input');
        throw new Error('The existing PPTX-to-PDF workflow is not exposed by this presenter build. Save the presentation asset first, then choose Convert to PDF from the root-folder modal.');
      }
      setStatus('✅ PDF conversion started/completed using the existing presenter workflow.', 'success');
    } catch (error) { setStatus('PDF conversion failed: ' + (error.message || error), 'error'); }
    finally { setBusy(false); }
  };

  window.closeOnlyOfficeEditor = async function(force = false) {
  state.busy = false;

  if (state.editor && typeof state.editor.destroyEditor === 'function') {
    try {
      state.editor.destroyEditor();
    } catch (_) {}
  }

  state.editor = null;

  const modal = document.getElementById('pptx-editor-modal');
  if (modal) modal.classList.remove('open');

  const host = document.getElementById('onlyoffice-editor-host');
  if (host) host.innerHTML = '';
};
  window.closePptxEditor = window.closeOnlyOfficeEditor;
})();

/* JIL Presenter: use ONLYOFFICE itself for scene Preview, Live View, and Display Screen. */
(() => {
  'use strict';

  const BRIDGE_URL = String(window.ONLYOFFICE_BRIDGE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const TYPE = 'onlyoffice-pptx';
  const viewerSessions = new Map();
  const activeEditors = new WeakMap();
  let audienceEditor = null;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clone = value => {
    try { return structuredClone(value); } catch (_) {}
    return JSON.parse(JSON.stringify(value));
  };

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : {}; } catch (_) {}
    if (!response.ok || !data || data.success === false) {
      throw new Error((data && data.error) || text || `Request failed (${response.status})`);
    }
    return data;
  }

  function postBridge(path, body) {
    return fetchJson(BRIDGE_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  async function loadApi(apiUrl) {
    if (window.DocsAPI) return;
    const existing = document.querySelector('script[data-onlyoffice-api]');
    if (existing) {
      await new Promise((resolve, reject) => {
        existing.addEventListener('load', resolve, { once: true });
        existing.addEventListener('error', reject, { once: true });
      });
      return;
    }
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = apiUrl;
      script.async = true;
      script.dataset.onlyofficeApi = '1';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Unable to load ONLYOFFICE Docs API from ' + apiUrl));
      document.head.appendChild(script);
    });
  }

  async function uploadPptx(file, label = 'Uploading edited PowerPoint') {
    const init = await postGoogleScriptJson({
      action: 'initResumableFileUpload',
      fileName: file.name,
      mimeType: file.type || PPTX_MIME,
      fileSize: file.size
    });
    if (!init.uploadUrl) throw new Error('Apps Script did not return an upload URL.');

    const chunkSize = 4 * 1024 * 1024;
    let offset = 0;
    let finalResult = {};
    while (offset < file.size) {
      const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size), file.type || PPTX_MIME);
      const start = offset;
      const result = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', init.uploadUrl, true);
        xhr.setRequestHeader('Content-Type', file.type || PPTX_MIME);
        xhr.setRequestHeader('Content-Range', `bytes ${start}-${start + chunk.size - 1}/${file.size}`);
        xhr.upload.onprogress = event => {
          if (!event.lengthComputable) return;
          const percent = 68 + ((start + event.loaded) / file.size) * 25;
          const bar = document.getElementById('onlyoffice-editor-progress-bar');
          const text = document.getElementById('onlyoffice-editor-progress-label');
          if (bar) bar.style.width = Math.min(93, percent) + '%';
          if (text) text.textContent = `${Math.round(Math.min(93, percent))}% · ${label}`;
        };
        xhr.onerror = () => reject(new Error('Network error while uploading the edited PowerPoint.'));
        xhr.onload = () => {
          if ([200, 201, 308].includes(xhr.status)) {
            let parsed = {};
            try { parsed = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
            resolve(parsed);
          } else reject(new Error(`Drive rejected the PowerPoint upload (${xhr.status}).`));
        };
        xhr.send(chunk);
      });
      offset += chunk.size;
      if (result && Object.keys(result).length) finalResult = result;
    }

    if (finalResult.id || finalResult.fileId) return finalResult;
    const separator = GOOGLE_SCRIPT_PDF_UPLOAD_URL.includes('?') ? '&' : '?';
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const url = GOOGLE_SCRIPT_PDF_UPLOAD_URL + separator + new URLSearchParams({
        action: 'findUploadedFile',
        fileName: file.name,
        fileSize: String(file.size),
        modifiedAfter: '0',
        _: String(Date.now())
      });
      const found = await fetchJson(url, { cache: 'no-store' });
      if (found.found && found.file) return found.file;
      await sleep(500 + attempt * 350);
    }
    throw new Error('The edited PowerPoint was uploaded but could not be verified in Google Drive.');
  }

  async function forceSaveBlob() {
    const state = window.onlyOfficePptxState;
    if (!state || !state.sessionId) throw new Error('No ONLYOFFICE editing session is open.');

    if (state.documentDirty) {
      const started = Date.now();
      while ((!state.changesSynchronized || Date.now() - Number(state.lastChangeAt || 0) < 900) && Date.now() - started < 15000) {
        await sleep(250);
      }
    }

    let command = await postBridge(`/api/sessions/${encodeURIComponent(state.sessionId)}/forcesave`, {
      sessionToken: state.sessionToken
    });
    if (command.noChanges && state.documentDirty) {
      await sleep(1200);
      command = await postBridge(`/api/sessions/${encodeURIComponent(state.sessionId)}/forcesave`, {
        sessionToken: state.sessionToken
      });
    }

    if (!command.noChanges) {
      const expected = Number(command.expectedRevision || Number(state.lastSavedRevision || 0) + 1);
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await sleep(1000);
        const status = await fetchJson(`${BRIDGE_URL}/api/sessions/${encodeURIComponent(state.sessionId)}/status?token=${encodeURIComponent(state.sessionToken)}`, { cache: 'no-store' });
        if (status.error) throw new Error(status.error);
        if (Number(status.revision || 0) >= expected && status.fileReady) {
          state.lastSavedRevision = Number(status.revision || expected);
          state.documentDirty = false;
          state.changesSynchronized = true;
          break;
        }
        if (attempt === 59) throw new Error('ONLYOFFICE did not finish saving within one minute.');
      }
    }

    const response = await fetch(`${BRIDGE_URL}/api/sessions/${encodeURIComponent(state.sessionId)}/current?token=${encodeURIComponent(state.sessionToken)}&_=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(await response.text() || 'Unable to download the current PowerPoint.');
    return response.blob();
  }

  function driveMeta(record, fileName, size) {
    const fileId = String(record.id || record.fileId || '');
    return {
      fileId,
      driveUrl: record.webViewLink || (fileId ? `https://drive.google.com/file/d/${fileId}/view` : ''),
      previewUrl: record.previewUrl || '',
      downloadUrl: record.webContentLink || record.downloadUrl || (fileId ? `https://drive.google.com/uc?export=download&id=${fileId}` : ''),
      mimeType: record.mimeType || PPTX_MIME,
      size: Number(record.size || size || 0),
      uploadedAt: record.createdTime || new Date().toISOString(),
      source: 'onlyoffice'
    };
  }

  function upsertAsset(record, fileName, fileSize) {
    const scene = getActiveScene();
    if (!scene) throw new Error('No active scene is available.');
    const fileId = String(record.id || record.fileId || '');
    let index = (scene.items || []).findIndex(item => item.type === TYPE && item.onlyOffice && String(item.onlyOffice.fileId) === fileId);
    if (index < 0 && staged && staged.type === TYPE && Number.isInteger(staged.sceneItemIndex)) index = staged.sceneItemIndex;

    const item = {
      id: index >= 0 && scene.items[index] ? scene.items[index].id : uid(),
      type: TYPE,
      name: fileName,
      value: '',
      page: 1,
      googleDrive: driveMeta(record, fileName, fileSize),
      onlyOffice: {
        fileId,
        fileName,
        fileSize: Number(record.size || fileSize || 0),
        revision: Date.now()
      }
    };

    if (index >= 0 && scene.items[index]) scene.items[index] = item;
    else { scene.items.push(item); index = scene.items.length - 1; }

    persistScenes();
    renderSceneDeckUI();
    setStagedFromSceneIndex(index);
    populateSlidePreviewGrid?.();
    return item;
  }

  window.saveOnlyOfficePresentationAsset = async function() {
    const state = window.onlyOfficePptxState;
    if (!state || state.busy || !state.sessionId) return;
    state.busy = true;
    const button = document.getElementById('onlyoffice-save-asset-btn');
    if (button) button.disabled = true;
    const status = document.getElementById('onlyoffice-editor-status');
    try {
      if (status) { status.textContent = 'Saving the edited PPTX for ONLYOFFICE Preview and Live View…'; status.classList.add('show'); status.classList.remove('error'); }
      const blob = await forceSaveBlob();
      const fileName = state.sourceFileName || 'Presentation.pptx';
      const file = new File([blob], fileName, { type: PPTX_MIME, lastModified: Date.now() });
      const record = await uploadPptx(file);
      upsertAsset(record, fileName, blob.size);

      if (state.sourceFileId && String(state.sourceFileId) !== String(record.id || record.fileId)) {
        try { await postGoogleScriptJson({ action: 'deleteDriveFile', fileId: state.sourceFileId }); } catch (error) { console.warn('Previous PPTX cleanup warning:', error); }
      }
      state.sourceFileId = String(record.id || record.fileId || '');
      state.sourceFileSize = blob.size;
      if (status) status.textContent = '✅ Edited PPTX saved. Preview and Live View now use ONLYOFFICE directly.';
      document.getElementById('pptx-editor-modal')?.classList.remove('open');
    } catch (error) {
      console.error(error);
      if (status) { status.textContent = 'Save failed: ' + (error.message || error); status.classList.add('show', 'error'); }
    } finally {
      state.busy = false;
      if (button) button.disabled = false;
    }
  };

  async function createViewerSession(asset) {
    const meta = asset.onlyOffice || {};
    const fileId = String(meta.fileId || asset.googleDrive?.fileId || '');
    if (!fileId) throw new Error('The ONLYOFFICE asset has no Google Drive file ID.');
    const cached = viewerSessions.get(fileId);
    if (cached) return cached;

    const created = await postBridge('/api/sessions', {
      fileId,
      fileName: meta.fileName || asset.name || 'Presentation.pptx',
      fileSize: Number(meta.fileSize || asset.googleDrive?.size || 0),
      appsScriptUrl: GOOGLE_SCRIPT_PDF_UPLOAD_URL
    });
    const session = {
      sessionId: created.sessionId,
      sessionToken: created.sessionToken,
      apiUrl: created.apiUrl,
      revision: Number(created.revision || 0)
    };
    viewerSessions.set(fileId, session);
    return session;
  }

  async function getViewConfig(asset, mode) {
    const session = await createViewerSession(asset);
    const result = await postBridge(`/api/sessions/${encodeURIComponent(session.sessionId)}/view-config`, {
      sessionToken: session.sessionToken,
      mode
    });
    await loadApi(result.apiUrl || session.apiUrl);
    return { session, config: result.config };
  }

  function destroyViewportEditor(target) {
    const editor = activeEditors.get(target);
    if (editor && typeof editor.destroyEditor === 'function') {
      try { editor.destroyEditor(); } catch (_) {}
    }
    activeEditors.delete(target);
  }

  async function renderOnlyOffice(target, payload, mode = 'preview') {
    if (!target) return;
    destroyViewportEditor(target);
    const label = target.querySelector('.viewport-label');
    target.innerHTML = '';
    if (label) target.appendChild(label);

    const host = document.createElement('div');
    host.id = `onlyoffice-${mode}-${Math.random().toString(36).slice(2)}`;
    host.className = 'onlyoffice-presentation-host';
    host.innerHTML = '<div class="status-text">Loading PowerPoint viewer…</div>';
    target.appendChild(host);

    try {
      const { config } = await getViewConfig(payload, mode === 'preview' ? 'preview' : 'live');
      config.events = Object.assign({}, config.events || {}, {
        onError(event) {
          const message = event?.data?.errorDescription || event?.data?.errorCode || 'Viewer error';
          console.error('ONLYOFFICE viewer:', message);
        }
      });
      host.innerHTML = '';
      const editor = new DocsAPI.DocEditor(host.id, config);
      activeEditors.set(target, editor);
    } catch (error) {
      host.innerHTML = `<div class="status-text" style="color:var(--accent-red);padding:18px;text-align:center;">${escapeHtml(error.message || error)}</div>`;
    }
  }

  const previousPersist = window.persistScenes;
  window.persistScenes = function() {
    try {
      const cleanScenes = scenes.map(scene => ({
        id: scene.id,
        name: scene.name,
        items: (scene.items || []).map(item => ({
          id: item.id,
          type: item.type,
          value: (item.type === 'url' || item.type === 'bible' || item.type === 'google-slides' || item.type === TYPE || item.googleDrive?.fileId) ? item.value : '',
          name: item.name || '',
          category: item.category || '',
          page: Number(item.page || 1),
          videoTime: Number(item.videoTime || 0),
          videoPlaying: Boolean(item.videoPlaying),
          googleDrive: item.googleDrive || null,
          googleSlides: item.googleSlides || null,
          onlyOffice: item.onlyOffice || null,
          rootFolderFile: Boolean(item.rootFolderFile),
          rootRelativePath: item.rootRelativePath || '',
          mimeType: item.mimeType || ''
        }))
      }));
      localStorage.setItem(LS_KEY, JSON.stringify(cleanScenes));
      localStorage.setItem(LS_ACTIVE_SCENE, activeSceneId || '');
    } catch (error) {
      if (typeof previousPersist === 'function') previousPersist();
    }
  };

  const previousStage = window.setStagedFromSceneIndex;
  window.setStagedFromSceneIndex = function(index) {
    previousStage(index);
    const item = getActiveDeck()?.[index];
    if (!item || item.type !== TYPE) return;
    staged = {
      id: item.id,
      itemId: item.id,
      sceneItemIndex: index,
      type: TYPE,
      value: '',
      name: item.name || 'Presentation.pptx',
      page: Number(item.page || 1),
      googleDrive: clone(item.googleDrive || {}),
      onlyOffice: clone(item.onlyOffice || {})
    };
    renderSceneDeckUI();
    renderPreview();
    setSlideStatus();
    populateSlidePreviewGrid?.();
  };

  const previousRender = window.renderMediaIntoViewport;
  window.renderMediaIntoViewport = async function(target, payload, options = {}) {
    if (!(payload && payload.type === TYPE)) return previousRender(target, payload, options);
    await renderOnlyOffice(target, payload, target.id === 'preview-viewport' ? 'preview' : 'live');
    if (target.id === 'live-viewport' && typeof updateLiveMonitorOverlays === 'function') updateLiveMonitorOverlays();
    return true;
  };

  const previousAudienceLayer = window.buildAudienceMediaLayer;
  window.buildAudienceMediaLayer = async function(payload) {
    if (!(payload && payload.type === TYPE)) return previousAudienceLayer(payload);
    const layer = document.createElement('div');
    layer.className = 'audience-media-layer onlyoffice-audience-layer';
    const host = document.createElement('div');
    host.id = `onlyoffice-audience-${Math.random().toString(36).slice(2)}`;
    host.className = 'onlyoffice-presentation-host';
    layer.appendChild(host);
    const { config } = await getViewConfig(payload, 'live');
    setTimeout(() => {
      if (audienceEditor && typeof audienceEditor.destroyEditor === 'function') {
        try { audienceEditor.destroyEditor(); } catch (_) {}
      }
      audienceEditor = new DocsAPI.DocEditor(host.id, config);
    }, 0);
    return layer;
  };

  const previousGrid = window.populateSlidePreviewGrid;
  window.populateSlidePreviewGrid = async function() {
    if (!(staged && staged.type === TYPE)) return previousGrid();
    const grid = document.getElementById('slide-preview-grid');
    if (!grid) return;
    grid.innerHTML = `
      <button type="button" class="preview-slide-card active" onclick="renderPreview()">
        <div class="preview-slide-thumb"><div>📊 ONLYOFFICE PPTX</div></div>
        <div class="preview-slide-meta">
          <strong>${escapeHtml(staged.name || 'Presentation.pptx')}</strong>
          <span>Real PowerPoint viewer · navigation is inside the player</span>
        </div>
      </button>`;
  };

  const previousStatus = window.setSlideStatus;
  window.setSlideStatus = function() {
    if (staged && staged.type === TYPE) {
      const el = document.getElementById('slide-status');
      if (el) el.textContent = `ONLYOFFICE PPTX: ${staged.name || 'Presentation.pptx'}`;
      return;
    }
    return previousStatus();
  };

  const previousDeck = window.renderSceneDeckUI;
  window.renderSceneDeckUI = function() {
    previousDeck();
    const deck = getActiveDeck();
    deck.forEach((item, index) => {
      if (item.type !== TYPE) return;
      const thumb = document.getElementById(`slide-thumb-${index}`);
      if (!thumb) return;
      const deleteButton = thumb.querySelector(':scope > div[style*="position: absolute"]');
      thumb.innerHTML = `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#ddd;font-weight:800;font-size:12px;text-align:center;padding:8px;"><div style="font-size:30px;margin-bottom:6px;">📊</div><div>ONLYOFFICE PPTX</div><div class="file-meta-tag">${escapeHtml(item.name || 'Presentation.pptx')}</div></div>`;
      if (deleteButton) thumb.appendChild(deleteButton);
      thumb.classList.toggle('active', index === staged.sceneItemIndex && staged.type !== 'none');
      thumb.onclick = () => window.setStagedFromSceneIndex(index);
    });
  };

  window.openOnlyOfficeAssetEditor = async function() {
    if (!(staged && staged.type === TYPE && staged.googleDrive?.fileId)) return;
    await window.prepareExistingDrivePptx({
      id: staged.googleDrive.fileId,
      fileId: staged.googleDrive.fileId,
      name: staged.name,
      fileName: staged.name,
      size: staged.googleDrive.size || staged.onlyOffice?.fileSize || 0
    });
  };
})();
