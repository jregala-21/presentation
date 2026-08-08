    try {
      if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
      }
    } catch (e) {}
  

/* ===== Extracted inline script block ===== */

    const channel = new BroadcastChannel('switcher_broadcast_stream');

    const LS_KEY = 'mps_scenes_v1';
    const LS_ACTIVE_SCENE = 'mps_active_scene_id_v1';
    const LS_BG_TARGET = 'mps_bg_target_filename_v1';
    const DB_NAME = 'MPS_Folder_DB';
    const STORE_NAME = 'handles';
    const KEY_HANDLE = 'root_dir_handle';

    let scenes = [];
    let activeSceneId = null;
    let folderHandle = null; 
    let staged = { type: 'none', value: null, sceneItemIndex: -1, page: 1, videoTime: 0, videoPlaying: false };
    let liveState = { type: 'none', value: null, sceneItemIndex: -1, page: 1, videoTime: 0, videoPlaying: false };
    let displayWindow = null;
    let availableDisplayScreens = [];
    let pendingMonitorIndex = -1;
    let selectedMonitor = null;
    const LS_SELECTED_MONITOR = 'mps_selected_monitor_v1';
    let lensCaptureStream = null;
    let lensLoopInterval = null;
    let pdfDoc = null;
    let lastIncoming = null;
    let isFTBActive = false;
    let isFTGActive = false; 
    let modalResolve = null;
    let currentBackgroundSource = '';

    let discoveredWorkspaceImages = {};
    let bibleLibraries = {};
    let activeBibleKey = '';
    let currentBibleSearchResult = null;

    let bibleLibraryFlashTimer = null;

    function showBibleLibraryFlash(message, isError = false, autoHide = true) {
      const el = document.getElementById('bible-library-flash');
      if (!el) return;
      if (bibleLibraryFlashTimer) {
        clearTimeout(bibleLibraryFlashTimer);
        bibleLibraryFlashTimer = null;
      }
      const text = String(message || '').trim();
      if (!text) {
        el.textContent = '';
        el.classList.remove('show', 'error');
        return;
      }
      el.textContent = text;
      el.classList.toggle('error', Boolean(isError));
      el.classList.add('show');
      if (autoHide) {
        bibleLibraryFlashTimer = setTimeout(() => {
          el.classList.remove('show', 'error');
          el.textContent = '';
          bibleLibraryFlashTimer = null;
        }, isError ? 7000 : 4500);
      }
    }

    // Custom helper UI routine to handle local configuration preference storage
    function toggleThemeLayout(checkboxEl) {
      if (checkboxEl.checked) {
        document.body.classList.add('light-mode');
        localStorage.setItem('mps_theme_mode', 'light');
      } else {
        document.body.classList.remove('light-mode');
        localStorage.setItem('mps_theme_mode', 'dark');
      }
    }

    function parseBibleXmlContent(xmlText, label) {
      const entries = [];
      try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        
        // Scan all DOM elements linearly to identify books, chapters, and verses
        let nodes = xmlDoc.getElementsByTagName('*');
        let currentBook = '';
        let currentChapter = '1';

        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          const tag = node.tagName.toLowerCase();
          
          const getAttr = (names) => {
            for (let name of names) {
              let attr = node.getAttribute(name);
              if (attr) return attr;
            }
            return '';
          };

          if (['book', 'biblebook'].includes(tag)) {
            currentBook = getAttr(['bname', 'name', 'id']) || currentBook;
          }
          if (['chapter', 'chap'].includes(tag)) {
            currentChapter = getAttr(['cnumber', 'chapter', 'ch', 'number', 'n', 'value']) || currentChapter;
          }

          const isVerseNode = ['verse', 'v', 'seg', 'content', 'text'].includes(tag) || /verse/i.test(tag);
          const verseValue = getAttr(['vnumber', 'verse', 'v', 'number', 'n', 'id']);
          const textContent = (node.textContent || '').replace(/\s+/g, ' ').trim();

          if (isVerseNode && verseValue && textContent) {
            const cNum = parseInt(currentChapter.replace(/[^0-9]/g, ''), 10) || 1;
            const vNum = parseInt(verseValue.replace(/[^0-9]/g, ''), 10) || 1;
            const bName = currentBook || 'Bible';
            entries.push({
              book: bName.trim(),
              chapter: cNum,
              verse: vNum,
              text: textContent,
              reference: `${bName.trim()} ${cNum}:${vNum}`,
              sourceLabel: label
            });
          }
        }

        // Direct fallback loop if standard nested tag hierarchies aren't found
        if (entries.length === 0) {
          let flatVerses = xmlDoc.getElementsByTagName('verse');
          if (!flatVerses.length) flatVerses = xmlDoc.getElementsByTagName('v');
          for (let i = 0; i < flatVerses.length; i++) {
            const vNode = flatVerses[i];
            const b = vNode.getAttribute('book') || vNode.getAttribute('b') || 'Bible';
            const c = parseInt(vNode.getAttribute('chapter') || vNode.getAttribute('c') || 1, 10);
            const v = parseInt(vNode.getAttribute('verse') || vNode.getAttribute('v') || (i + 1), 10);
            entries.push({ book: b, chapter: c, verse: v, text: vNode.textContent.trim(), reference: `${b} ${c}:${v}`, sourceLabel: label });
          }
        }
      } catch (e) {
        console.error("XML Parse Error:", e);
      }
      return entries;
    }

    function parseBibleJsonContent(jsonText, label) {
      const entries = [];
      try {
        const obj = JSON.parse(jsonText);
        
        // Format 1: Direct Array of Objects [{"book":"Gen", "chapter":1, "verse":1, "text":"..."}]
        if (Array.isArray(obj)) {
          obj.forEach((item, idx) => {
            const b = item.book || item.b || "Bible";
            const c = parseInt(item.chapter || item.c || 1, 10);
            const v = parseInt(item.verse || item.v || (idx + 1), 10);
            const t = item.text || item.t || "";
            entries.push({ book: b, chapter: c, verse: v, text: t, reference: `${b} ${c}:${v}`, sourceLabel: label });
          });
        } 
        // Format 2: Tree layout structured by Book -> Chapter -> Verse
        else {
          for (const bookKey in obj) {
            if (typeof obj[bookKey] === 'object') {
              for (const chKey in obj[bookKey]) {
                const chObj = obj[bookKey][chKey];
                if (Array.isArray(chObj)) {
                  chObj.forEach((vText, vIdx) => {
                    entries.push({ book: bookKey, chapter: parseInt(chKey, 10), verse: vIdx + 1, text: vText, reference: `${bookKey} ${chKey}:${vIdx + 1}`, sourceLabel: label });
                  });
                } else if (typeof chObj === 'object') {
                  for (const vKey in chObj) {
                    entries.push({ book: bookKey, chapter: parseInt(chKey, 10), verse: parseInt(vKey, 10), text: chObj[vKey], reference: `${bookKey} ${chKey}:${vKey}`, sourceLabel: label });
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.error("JSON Parse Error:", e);
      }
      return entries;
    }

    function showModal(title, text, showInput = false, defaultInputValue = '') {
      return new Promise((resolve) => {
        modalResolve = resolve;
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').textContent = text;
        const inputContainer = document.getElementById('modal-input-container');
        inputContainer.innerHTML = '';
        
        if (showInput) {
          const input = document.createElement('input');
          input.type = 'text';
          input.id = 'modal-text-field';
          input.value = defaultInputValue;
          input.style.width = '100%';
          input.style.marginTop = '0px';
          inputContainer.appendChild(input);
          setTimeout(() => input.focus(), 50);
        }
        
        document.getElementById('studio-modal').classList.add('open');
      });
    }

    function parseXmlBible(xmlText, label) {
      const entries = [];
      try {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(xmlText, "text/xml");
        
        // Attempt standard book node lookups
        let books = xmlDoc.getElementsByTagName("biblebook");
        if (!books.length) books = xmlDoc.getElementsByTagName("book");
        if (!books.length) books = xmlDoc.getElementsByTagName("BIBLEBOOK");

        if (books.length > 0) {
          for (let b = 0; b < books.length; b++) {
            const bNode = books[b];
            const bName = bNode.getAttribute("bname") || bNode.getAttribute("name") || bNode.getAttribute("id") || "Unknown";
            
            let chapters = bNode.getElementsByTagName("chapter");
            for (let c = 0; c < chapters.length; c++) {
              const cNode = chapters[c];
              const cNum = parseInt(cNode.getAttribute("cnumber") || cNode.getAttribute("name") || (c + 1), 10);
              
              let verses = cNode.getElementsByTagName("verse");
              if (!verses.length) verses = cNode.getElementsByTagName("v");
              
              for (let v = 0; v < verses.length; v++) {
                const vNode = verses[v];
                const vNum = parseInt(vNode.getAttribute("vnumber") || vNode.getAttribute("n") || (v + 1), 10);
                const txt = vNode.textContent.trim();
                if (txt) {
                  entries.push({
                    book: bName,
                    chapter: cNum,
                    verse: vNum,
                    text: txt,
                    reference: `${bName} ${cNum}:${vNum}`,
                    sourceLabel: label
                  });
                }
              }
            }
          }
        } else {
          // Fallback flatten parse for direct <verse book="Gen" chapter="1" verse="1"> styles
          let verses = xmlDoc.getElementsByTagName("verse");
          if (!verses.length) verses = xmlDoc.getElementsByTagName("v");
          for (let i = 0; i < verses.length; i++) {
            const node = verses[i];
            const b = node.getAttribute("book") || "Bible";
            const c = parseInt(node.getAttribute("chapter") || 1, 10);
            const v = parseInt(node.getAttribute("verse") || (i + 1), 10);
            entries.push({ book: b, chapter: c, verse: v, text: node.textContent.trim(), reference: `${b} ${c}:${v}`, sourceLabel: label });
          }
        }
      } catch (e) {
        console.error("XML Parse Error:", e);
      }
      return entries;
    }

    function parseJsonBible(jsonText, label) {
      const entries = [];
      try {
        const obj = JSON.parse(jsonText);
        
        // Format 1: Plain Array of Objects [{"book":"Gen", "chapter":1, "verse":1, "text":"..."}]
        if (Array.isArray(obj)) {
          obj.forEach((item, idx) => {
            const b = item.book || item.b || "Bible";
            const c = parseInt(item.chapter || item.c || 1, 10);
            const v = parseInt(item.verse || item.v || (idx + 1), 10);
            const t = item.text || item.t || "";
            entries.push({ book: b, chapter: c, verse: v, text: t, reference: `${b} ${c}:${v}`, sourceLabel: label });
          });
        } 
        // Format 2: Tree Dictionary Layout {"Genesis": {"1": {"1": "Text"}}}
        else {
          for (const bookKey in obj) {
            if (typeof obj[bookKey] === 'object') {
              for (const chKey in obj[bookKey]) {
                const chObj = obj[bookKey][chKey];
                if (Array.isArray(chObj)) {
                  chObj.forEach((vText, vIdx) => {
                    entries.push({ book: bookKey, chapter: parseInt(chKey, 10), verse: vIdx + 1, text: vText, reference: `${bookKey} ${chKey}:${vIdx + 1}`, sourceLabel: label });
                  });
                } else if (typeof chObj === 'object') {
                  for (const vKey in chObj) {
                    entries.push({ book: bookKey, chapter: parseInt(chKey, 10), verse: parseInt(vKey, 10), text: chObj[vKey], reference: `${bookKey} ${chKey}:${vKey}`, sourceLabel: label });
                  }
                }
              }
            }
          }
        }
      } catch (e) {
        console.error("JSON Parse Error:", e);
      }
      return entries;
    }

    function closeModal(isConfirmed) {
      document.getElementById('studio-modal').classList.remove('open');
      if (!modalResolve) return;
      
      if (isConfirmed) {
        const inputField = document.getElementById('modal-text-field');
        if (inputField) {
          modalResolve({ confirmed: true, value: inputField.value });
        } else {
          modalResolve({ confirmed: true });
        }
      } else {
        modalResolve({ confirmed: false });
      }
      modalResolve = null;
    }

    function openDB() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE_NAME);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    async function saveFolderHandle(handle) {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(handle, KEY_HANDLE);
        tx.oncomplete = () => resolve();
      });
    }
    async function loadFolderHandle() {
      const db = await openDB();
      return new Promise((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(KEY_HANDLE);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    }

    function safeJsonParse(s, fallback) {
      try { return JSON.parse(s); } catch (e) {}
      return fallback;
    }

    const PDF_CACHE_DB_NAME = 'JIL_Presenter_PDF_Cache';
    const PDF_CACHE_STORE = 'pdfFiles';

    function openPdfCacheDB() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open(PDF_CACHE_DB_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(PDF_CACHE_STORE)) {
            request.result.createObjectStore(PDF_CACHE_STORE, { keyPath: 'itemId' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    async function savePdfToPersistentCache(itemId, fileName, pdfSource, googleDrive = {}) {
      const isBuffer = pdfSource instanceof ArrayBuffer && pdfSource.byteLength;
      const isBlob = pdfSource instanceof Blob && pdfSource.size;
      if (!itemId || (!isBuffer && !isBlob)) return false;
      const pdfBlob = isBlob ? pdfSource : new Blob([pdfSource], { type: 'application/pdf' });
      const db = await openPdfCacheDB();
      return new Promise((resolve) => {
        const tx = db.transaction(PDF_CACHE_STORE, 'readwrite');
        tx.objectStore(PDF_CACHE_STORE).put({
          itemId,
          fileName: fileName || 'presentation.pdf',
          pdfBlob,
          googleDrive: googleDrive || {},
          savedAt: new Date().toISOString()
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
    }

    async function loadPdfFromPersistentCache(itemId) {
      if (!itemId) return null;
      const db = await openPdfCacheDB();
      return new Promise((resolve) => {
        const tx = db.transaction(PDF_CACHE_STORE, 'readonly');
        const req = tx.objectStore(PDF_CACHE_STORE).get(itemId);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      });
    }

    async function removePdfFromPersistentCache(itemId) {
      if (!itemId) return;
      try {
        const db = await openPdfCacheDB();
        const tx = db.transaction(PDF_CACHE_STORE, 'readwrite');
        tx.objectStore(PDF_CACHE_STORE).delete(itemId);
      } catch (e) {}
    }

    async function restorePersistedScenePdfs() {
      let restored = 0;
      for (const scene of scenes) {
        for (const item of (scene.items || [])) {
          if (item.type !== 'pdf' || !item.id) continue;
          const cached = await loadPdfFromPersistentCache(item.id);
          if (!cached || !cached.pdfBlob) continue;
          try {
            // Avoid duplicating hundreds of MB in memory. Small PDFs keep binary data for
            // cross-window compatibility; large PDFs render from their persistent Blob URL.
            if (cached.pdfBlob.size <= 64 * 1024 * 1024) item.pdfData = await cached.pdfBlob.arrayBuffer();
            else delete item.pdfData;
            item.value = URL.createObjectURL(cached.pdfBlob);
            if (!item.name) item.name = cached.fileName || 'presentation.pdf';
            if ((!item.googleDrive || !Object.keys(item.googleDrive).length) && cached.googleDrive) {
              item.googleDrive = cached.googleDrive;
            }
            restored += 1;
          } catch (e) {}
        }
      }
      return restored;
    }


    function clonePresenterPayload(payload) {
      if (!payload) return payload;
      if (typeof structuredClone === 'function') {
        try { return structuredClone(payload); } catch (e) {}
      }
      const copy = Object.assign({}, payload);
      if (payload.value && typeof payload.value === 'object' && !(payload.value instanceof ArrayBuffer)) {
        copy.value = Object.assign({}, payload.value);
      }
      if (payload.pdfData instanceof ArrayBuffer) copy.pdfData = payload.pdfData.slice(0);
      return copy;
    }

    function getPdfJsSource(payload) {
      if (payload && payload.pdfData instanceof ArrayBuffer && payload.pdfData.byteLength) {
        return { data: payload.pdfData.slice(0) };
      }
      if (payload && payload.value) return payload.value;
      return null;
    }

    const uid = () => 's_' + Math.random().toString(16).slice(2) + '_' + Date.now().toString(16);

    // native Fullscreen Request Utility
    function enterFullscreen() {
      const element = document.documentElement;
      if (element.requestFullscreen) {
        element.requestFullscreen();
      } else if (element.webkitRequestFullscreen) { /* Safari */
        element.webkitRequestFullscreen();
      } else if (element.msRequestFullscreen) { /* IE11 */
        element.msRequestFullscreen();
      }
    }

    // Constructs Fullscreen hints overlay interface inside Projector Mode
    function setupDisplayWindowFeatures() {
      document.body.addEventListener('dblclick', () => {
        enterFullscreen();
      });

      const fsOverlay = document.createElement('div');
      fsOverlay.id = 'fs-hint-overlay';
      fsOverlay.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,0.9);
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        z-index: 999999; font-family: sans-serif; color: white; gap: 15px;
      `;
      fsOverlay.innerHTML = `
        <h3 style="margin:0; color:#fff; font-size: 1.5rem;">Display Window Ready</h3>
        <p style="margin:0; color:#aaa; font-size: 14px;">Move this window to your projection monitor screen.</p>
        <button id="fs-engage-btn" style="background:#007acc; font-size:16px; padding:12px 24px; border-radius:8px;">
          🖵 Maximize to Fullscreen
        </button>
        <small style="color:#666;">Or double click anytime / Press F11 to transition</small>
      `;
      document.body.appendChild(fsOverlay);

      document.getElementById('fs-engage-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        enterFullscreen();
        fsOverlay.remove();
      });
    }

    function normalizeUrl(url) {
      url = (url || '').trim();
      if (!url) return '';
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      if (url.includes('/watch?')) url = url.replace('/watch?', '/design?');
      if (url.includes('/watch/')) url = url.replace('/watch/', '/design/');
      if (url.includes('/design/') && !url.includes('?embed')) {
        const base = url.split('?')[0].replace(/\/edit.*$/, '');
        return base + '?embed';
      }
      return url;
    }

    function getActiveScene() {
      return scenes.find(s => s.id === activeSceneId) || null;
    }

    function getActiveDeck() {
      const s = getActiveScene();
      return s ? (s.items || []) : [];
    }

    async function requestFolderPermission() {
      try {
        folderHandle = await window.showDirectoryPicker();
        await saveFolderHandle(folderHandle);
        updateFolderUI(true);
        await scanAndRestoreLocalFiles();
      } catch (err) {
        console.warn("Folder picker declined or unsupported:", err);
      }
    }

    async function verifySavedFolderAccess() {
      folderHandle = await loadFolderHandle();
      if (!folderHandle) {
        updateFolderUI(false);
        return;
      }
      
      const options = { mode: 'read' };
      if ((await folderHandle.queryPermission(options)) === 'granted') {
        updateFolderUI(true);
        await scanAndRestoreLocalFiles();
      } else {
        const banner = document.getElementById('folder-sync-banner');
        const txt = document.getElementById('folder-status-txt');
        const btn = document.getElementById('folder-action-btn');
        banner.className = "sync-status-banner";
        txt.textContent = "🔒 Folder access locked by browser refresh.";
        btn.textContent = "🔓 Unlock Media Folder";
        btn.onclick = async () => {
          if ((await folderHandle.requestPermission(options)) === 'granted') {
            updateFolderUI(true);
            await scanAndRestoreLocalFiles();
          }
        };
      }
    }

    function updateFolderUI(isConnected) {
      const banner = document.getElementById('folder-sync-banner');
      const txt = document.getElementById('folder-status-txt');
      const btn = document.getElementById('folder-action-btn');

      if (isConnected) {
        banner.className = "sync-status-banner connected";
        txt.textContent = "✅ Workspace folder connected & synchronized.";
        btn.textContent = "Change Folder";
        btn.onclick = requestFolderPermission;
      } else {
        banner.className = "sync-status-banner";
        txt.textContent = "📁 No workspace folder connected yet.";
        btn.textContent = "Setup Media Folder";
        btn.onclick = requestFolderPermission;
      }
    }

    async function scanAndRestoreLocalFiles() {
      if (!folderHandle) return;
      let matchedAny = false;
      discoveredWorkspaceImages = {};

      const collectBibleFiles = async (handle, collected = []) => {
        for await (const entry of handle.values()) {
          if (entry.kind === 'file' && isSupportedBibleFile(entry.name)) {
            collected.push(entry);
          } else if (entry.kind === 'directory') {
            await collectBibleFiles(entry, collected);
          }
        }
        return collected;
      };

      try {
        for await (const entry of folderHandle.values()) {
          if (entry.kind === 'file') {
            const lowerName = entry.name.toLowerCase();
            if (lowerName.endsWith('.png') || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') || lowerName.endsWith('.webp') || lowerName.endsWith('.gif')) {
              const fileData = await entry.getFile();
              const objectUrl = URL.createObjectURL(fileData);
              discoveredWorkspaceImages[entry.name] = objectUrl;
            }
          }
        }
      } catch (err) {}

      try {
        const bibleFiles = await collectBibleFiles(folderHandle);
        for (const entry of bibleFiles) {
          const fileData = await entry.getFile();
          await importBibleFileObject(fileData);
        }
      } catch (err) {}

      populateBackgroundSelector();
      populateBibleLibrarySelector();

      for (let scene of scenes) {
        for (let item of scene.items) {
          if (item.type !== 'url' && item.type !== 'bible' && item.name) {
            try {
              const fileHandle = await folderHandle.getFileHandle(item.name);
              const fileData = await fileHandle.getFile();
              item.value = URL.createObjectURL(fileData);
              if (item.type === 'pdf') {
                try { item.pdfData = await fileData.arrayBuffer(); } catch (e) { item.pdfData = null; }
              }
              matchedAny = true;
            } catch (e) {
              item.value = ''; 
            }
          }
        }
      }

      if (matchedAny) {
        renderSceneDeckUI();
        if (staged.sceneItemIndex !== -1) {
          setStagedFromSceneIndex(staged.sceneItemIndex);
        }
      }

      renderBibleSearchResult();

      const savedBg = localStorage.getItem(LS_BG_TARGET);
      if (savedBg && discoveredWorkspaceImages[savedBg]) {
        channel.postMessage({ command: 'UPDATE_BACKGROUND_SOURCE', value: discoveredWorkspaceImages[savedBg] });
      }
    }

    function populateBackgroundSelector() {
      const select = document.getElementById('header-bg-selector');
      if (!select) return;
      
      const currentSelection = localStorage.getItem(LS_BG_TARGET) || "";
      select.innerHTML = '<option value="">-- Choose Background Image --</option>';

      Object.keys(discoveredWorkspaceImages).sort().forEach(filename => {
        const opt = document.createElement('option');
        opt.value = filename;
        opt.textContent = filename;
        if (filename === currentSelection) opt.selected = true;
        select.appendChild(opt);
      });
    }

    function changeBackgroundTarget(filename) {
      localStorage.setItem(LS_BG_TARGET, filename);
      const url = discoveredWorkspaceImages[filename] || "";
      currentBackgroundSource = url;
      updateLiveMonitorOverlays();
      channel.postMessage({ command: 'UPDATE_BACKGROUND_SOURCE', value: url });
    }

    function setStagedFromSceneIndex(idx) {
      const deck = getActiveDeck();
      if (!deck[idx]) {
        staged = { type: 'none', value: null, sceneItemIndex: -1, page: 1, videoTime: 0, videoPlaying: false };
        renderPreview();
        setSlideStatus();
        renderSceneDeckUI();
        return;
      }

      staged.sceneItemIndex = idx;
      staged.itemId = deck[idx].id || null;
      staged.type = deck[idx].type;
      staged.value = deck[idx].value;
      staged.pdfData = deck[idx].pdfData instanceof ArrayBuffer ? deck[idx].pdfData : null;
      staged.name = deck[idx].name || '';
      staged.category = deck[idx].category || '';
      staged.page = 1;
      staged.videoTime = 0;
      staged.videoPlaying = false;

      renderSceneDeckUI();
      renderPreview();
      setSlideStatus();
    }

    function persistScenes() {
      try {
        const cleanScenes = scenes.map(scene => ({
          id: scene.id,
          name: scene.name,
          items: (scene.items || []).map(item => ({
            id: item.id,
            type: item.type,
            value: (item.type === 'url' || item.type === 'bible' || (item.googleDrive && item.googleDrive.fileId)) ? item.value : '',
            name: item.name || '',
            category: item.category || '',
            googleDrive: item.googleDrive || null
          }))
        }));
        localStorage.setItem(LS_KEY, JSON.stringify(cleanScenes));
        localStorage.setItem(LS_ACTIVE_SCENE, activeSceneId || '');
      } catch (e) {}
    }

    async function loadScenes() {
      const raw = localStorage.getItem(LS_KEY);
      const parsed = safeJsonParse(raw, null);
      scenes = Array.isArray(parsed) ? parsed : [];
      activeSceneId = localStorage.getItem(LS_ACTIVE_SCENE) || (scenes[0] && scenes[0].id) || null;

      // Restore PDF bytes and object URLs from IndexedDB before rendering any scene.
      // This keeps PDFs attached to their original scenes after a browser refresh.
      await restorePersistedScenePdfs();

      if (scenes.length === 0) {
        const s = { id: uid(), name: 'Scene 1', items: [] };
        scenes = [s];
        activeSceneId = s.id;
        persistScenes();
      }
    }

    function renderSceneList() {
      const list = document.getElementById('scene-list');
      if (!list) return;
      list.innerHTML = '';

      scenes.forEach((s) => {
        const el = document.createElement('div');
        el.className = 'scene-item' + (s.id === activeSceneId ? ' active' : '');

        const name = document.createElement('div');
        name.className = 'name';
        name.textContent = s.name || 'Untitled';

        const right = document.createElement('div');
        right.className = 'row';

        const renameBtn = document.createElement('button');
        renameBtn.className = 'mini-btn';
        renameBtn.textContent = 'Rename';
        renameBtn.onclick = async (e) => {
          e.stopPropagation();
          const res = await showModal('Rename Scene', 'Enter the new name for this scene:', true, s.name || '');
          if (!res.confirmed || !res.value.trim()) return;
          s.name = res.value.trim();
          persistScenes();
          renderSceneList();
        };

        const delBtn = document.createElement('button');
        delBtn.className = 'mini-btn';
        delBtn.textContent = '🗑';
        delBtn.onclick = async (e) => {
          e.stopPropagation();
          const res = await showModal('Delete Scene', `Are you sure you want to permanently delete scene "${s.name || 'Untitled'}"?`, false);
          if (!res.confirmed) return;
          
          scenes = scenes.filter(x => x.id !== s.id);
          if (scenes.length === 0) {
            const ns = { id: uid(), name: 'Scene 1', items: [] };
            scenes = [ns];
            activeSceneId = ns.id;
          } else if (activeSceneId === s.id) {
            activeSceneId = scenes[0].id;
          }
          staged = { type: 'none', value: null, sceneItemIndex: -1, page: 1, videoTime: 0, videoPlaying: false };
          persistScenes();
          renderSceneList();
          renderSceneDeckUI();
          renderPreview();
          setSlideStatus();
        };

        right.appendChild(renameBtn);
        right.appendChild(delBtn);

        el.onclick = () => {
          activeSceneId = s.id;
          staged = { type: 'none', value: null, sceneItemIndex: -1, page: 1, videoTime: 0, videoPlaying: false };
          const deck = getActiveDeck();
          if (deck.length > 0) setStagedFromSceneIndex(0);
          else {
            renderPreview();
            setSlideStatus();
            renderSceneDeckUI();
          }
          persistScenes();
          renderSceneList();
        };

        el.appendChild(name);
        el.appendChild(right);
        list.appendChild(el);
      });
    }

    function createSceneFromInput() {
      const input = document.getElementById('new-scene-name');
      const name = (input && input.value ? input.value : '').trim();
      const nextName = name || `Scene ${scenes.length + 1}`;
      const s = { id: uid(), name: nextName, items: [] };
      scenes.push(s);
      activeSceneId = s.id;
      staged = { type: 'none', value: null, sceneItemIndex: -1, page: 1, videoTime: 0, videoPlaying: false };
      if (input) input.value = '';
      persistScenes();
      renderSceneList();
      renderSceneDeckUI();
      renderPreview();
      setSlideStatus();
    }

    async function handleUpload(event) {
      const files = event.target.files;
      if (!files || files.length === 0) return;
      const scene = getActiveScene();
      if (!scene) return;

      const startIndex = scene.items.length;
      for (const f of Array.from(files)) {
        let type = 'image';
        if (f.type.includes('video')) type = 'video';
        else if (f.type.includes('pdf') || /\.pdf$/i.test(f.name)) type = 'pdf';

        const item = {
          id: uid(),
          type,
          value: URL.createObjectURL(f),
          name: f.name
        };
        if (type === 'pdf') {
          try {
            item.pdfData = await f.arrayBuffer();
            await savePdfToPersistentCache(item.id, item.name, item.pdfData, item.googleDrive || {});
          } catch (e) { console.warn('Unable to read PDF bytes:', e); }
        }
        scene.items.push(item);
      }

      persistScenes();
      renderSceneDeckUI();
      populateSlidePreviewGrid();
      if (staged.type === 'none' && scene.items.length > 0) setStagedFromSceneIndex(startIndex);
      event.target.value = ''; 
    }

    function stageWebLinkToActiveScene() {
      const input = document.getElementById('web-url-input');
      const raw = input ? input.value : '';
      const clean = normalizeUrl(raw);
      if (!clean) return;

      const scene = getActiveScene();
      if (!scene) return;

      scene.items.push({
        id: uid(),
        type: 'url',
        value: clean,
        name: 'Embedded Link'
      });

      if (input) input.value = '';
      persistScenes();
      renderSceneDeckUI();
      setStagedFromSceneIndex(scene.items.length - 1);
    }


    const GOOGLE_SCRIPT_PDF_UPLOAD_URL = 'https://script.google.com/macros/s/AKfycbw3bVcUPlhd2LcRITYkv0GC-CghoXa64OJJuc7iu-6iUDNHrIVYWdF7xvlb7VoO8e89AQ/exec';

    function loadCanvaPdfStorageSettings() {}

    const LS_DRIVE_PDF_RECORDS = 'jil_drive_pdf_records_v1';

    function getStoredDrivePdfRecords() {
      try {
        const records = JSON.parse(localStorage.getItem(LS_DRIVE_PDF_RECORDS) || '[]');
        return Array.isArray(records) ? records : [];
      } catch (e) { return []; }
    }

    function saveDrivePdfRecord(record) {
      const records = getStoredDrivePdfRecords();
      const key = record.fileId || `${record.name}|${record.uploadedAt}`;
      const filtered = records.filter(item => (item.fileId || `${item.name}|${item.uploadedAt}`) !== key);
      filtered.unshift(record);
      localStorage.setItem(LS_DRIVE_PDF_RECORDS, JSON.stringify(filtered.slice(0, 100)));
    }

    function collectDrivePdfRecords() {
      const records = getStoredDrivePdfRecords();
      const seen = new Set(records.map(item => item.fileId || `${item.name}|${item.uploadedAt}`));
      scenes.forEach(scene => (scene.items || []).forEach(item => {
        if (item.type !== 'pdf') return;
        const drive = item.googleDrive || {};
        const record = { name:item.name || 'Presentation.pdf', fileId:drive.fileId || '', driveUrl:drive.driveUrl || '', previewUrl:drive.previewUrl || '', downloadUrl:drive.downloadUrl || '', uploadedAt:drive.uploadedAt || '', sceneId:scene.id, itemId:item.id };
        const key = record.fileId || `${record.name}|${record.uploadedAt}`;
        if (!seen.has(key)) { seen.add(key); records.push(record); }
      }));
      return records.sort((a,b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
    }

    function findPdfSceneItem(record) {
      for (const scene of scenes) {
        const index = (scene.items || []).findIndex(item => item.id === record.itemId || (record.fileId && item.googleDrive && item.googleDrive.fileId === record.fileId));
        if (index >= 0) return { scene, index, item:scene.items[index] };
      }
      return null;
    }

    function openDrivePdfRecord(recordIndex) {
      const record = collectDrivePdfRecords()[recordIndex];
      if (!record) return;
      const found = findPdfSceneItem(record);
      if (found) {
        activeSceneId = found.scene.id;
        persistScenes();
        renderSceneList();
        setStagedFromSceneIndex(found.index);
        closeDrivePdfModal();
        return;
      }
      const url = record.previewUrl || record.driveUrl || record.downloadUrl;
      if (url) window.open(url, '_blank', 'noopener');
    }

    function renderDrivePdfList() {
      const list = document.getElementById('drive-pdf-list');
      if (!list) return;
      const records = collectDrivePdfRecords();
      if (!records.length) { list.innerHTML = '<div style="grid-column:1/-1;color:var(--text-muted);padding:18px;text-align:center;">No uploaded PDFs are recorded yet.</div>'; return; }
      list.innerHTML = records.map((record,index) => {
        const when = record.uploadedAt ? new Date(record.uploadedAt).toLocaleString() : 'Upload date unavailable';
        const hasDrive = Boolean(record.previewUrl || record.driveUrl || record.downloadUrl);
        const found = findPdfSceneItem(record);
        const driveUrl = record.previewUrl || record.driveUrl || record.downloadUrl;
        return `<div class="drive-pdf-card"><div class="drive-pdf-card-name" title="${escapeHtml(record.name)}">📄 ${escapeHtml(record.name)}</div><div class="drive-pdf-card-meta">${escapeHtml(when)}${record.fileId ? '<br>Drive ID: '+escapeHtml(record.fileId) : '<br>Saved in Drive; link unavailable from backend response.'}</div><div class="drive-pdf-card-actions"><button onclick="openDrivePdfRecord(${index})">${found ? 'Preview' : 'Open'}</button>${hasDrive ? `<button style="background:var(--accent-purple);" onclick="window.open('${escapeHtml(driveUrl)}','_blank','noopener')">Drive</button>` : ''}</div></div>`;
      }).join('');
    }

    function openDrivePdfModal() { renderDrivePdfList(); const modal=document.getElementById('drive-pdf-modal'); if (modal) modal.classList.add('open'); }
    function closeDrivePdfModal() { const modal=document.getElementById('drive-pdf-modal'); if (modal) modal.classList.remove('open'); }

    function setCanvaPdfUploadStatus(message, state = '') {
      const el = document.getElementById('canva-pdf-status');
      if (!el) return;
      const text = String(message || '').trim();
      el.textContent = text;
      el.classList.remove('show', 'error', 'success');
      if (!text) return;
      el.classList.add('show');
      if (state === 'error') el.classList.add('error');
      if (state === 'success') el.classList.add('success');
    }

    function setCanvaPdfUploadProgress(percent, visible = true, detail = '') {
      const wrap = document.getElementById('canva-pdf-progress');
      const bar = document.getElementById('canva-pdf-progress-bar');
      const label = document.getElementById('canva-pdf-progress-label');
      const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
      if (wrap) wrap.classList.toggle('show', Boolean(visible));
      if (bar) bar.style.width = safePercent + '%';
      if (label) {
        label.classList.toggle('show', Boolean(visible));
        label.textContent = `${Math.round(safePercent)}%${detail ? ' · ' + detail : ''}`;
      }
    }

    function formatFileBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(2) + ' GB';
      if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + ' MB';
      if (value >= 1024) return (value / 1024).toFixed(1) + ' KB';
      return value + ' B';
    }

    function chooseCanvaPdfFile() {
      const input = document.getElementById('canva-pdf-uploader');
      if (input) input.click();
    }

    async function postGoogleScriptJson(payload) {
      const response = await fetch(GOOGLE_SCRIPT_PDF_UPLOAD_URL, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      });
      const responseText = await response.text();
      let result;
      try { result = JSON.parse(responseText); }
      catch (error) {
        const looksHtml = /^\s*</.test(responseText || '');
        throw new Error(looksHtml
          ? 'Apps Script returned an HTML error page. Update the Apps Script backend to the resumable-upload version supplied with this presenter.'
          : 'Apps Script returned an unreadable response.');
      }
      if (!response.ok || !result || result.success === false) {
        throw new Error((result && (result.error || result.message)) || `Apps Script request failed (${response.status}).`);
      }
      return result;
    }

    async function verifyGoogleScriptResumableBackend() {
      let response;
      try {
        response = await fetch(GOOGLE_SCRIPT_PDF_UPLOAD_URL + (GOOGLE_SCRIPT_PDF_UPLOAD_URL.includes('?') ? '&' : '?') + 'health=1&_=' + Date.now(), {
          method: 'GET',
          redirect: 'follow',
          cache: 'no-store'
        });
      } catch (error) {
        throw new Error('Cannot reach the Google Apps Script backend. Check the deployment access setting and internet connection.');
      }

      const text = await response.text();
      let result = null;
      try { result = JSON.parse(text); } catch (error) {}
      const version = Number(result && result.version || 0);
      if (!response.ok || !result || version < 2 || result.resumableUpload !== true) {
        throw new Error('The connected Apps Script is still the old Base64 backend. Replace Code.gs with the supplied resumable backend, then use Deploy > Manage deployments > Edit > New version > Deploy.');
      }
      return result;
    }

    async function initiateGoogleDriveResumableUpload(file) {
      await verifyGoogleScriptResumableBackend();
      try {
        return await postGoogleScriptJson({
          action: 'initResumablePdfUpload',
          fileName: file.name,
          mimeType: 'application/pdf',
          fileSize: file.size
        });
      } catch (error) {
        const message = String(error && error.message || error || '');
        if (/Missing fileName or base64Data/i.test(message)) {
          throw new Error('The Apps Script deployment is still running the old Base64 code. Redeploy the supplied resumable Code.gs as a new version of the same web app deployment.');
        }
        throw error;
      }
    }

    function uploadDriveChunk(uploadUrl, chunk, startByte, totalBytes, onChunkProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', uploadUrl, true);
        xhr.setRequestHeader('Content-Type', 'application/pdf');
        xhr.setRequestHeader('Content-Range', `bytes ${startByte}-${startByte + chunk.size - 1}/${totalBytes}`);
        xhr.upload.onprogress = event => {
          if (event.lengthComputable && onChunkProgress) onChunkProgress(event.loaded);
        };
        xhr.onerror = () => reject(new Error('Network error while uploading a PDF chunk.'));
        xhr.onabort = () => reject(new Error('PDF upload was cancelled.'));
        xhr.onload = () => {
          if (xhr.status === 308 || xhr.status === 200 || xhr.status === 201) {
            let result = null;
            if (xhr.responseText) {
              try { result = JSON.parse(xhr.responseText); } catch (e) {}
            }
            resolve({ status: xhr.status, result });
          } else {
            reject(new Error(`Google Drive rejected an upload chunk (${xhr.status}). ${xhr.responseText || ''}`.trim()));
          }
        };
        xhr.send(chunk);
      });
    }

    async function uploadLargePdfResumably(file, uploadUrl) {
      const chunkSize = 8 * 1024 * 1024; // Drive requires 256 KiB multiples.
      let offset = 0;
      let finalResult = null;
      while (offset < file.size) {
        const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size), 'application/pdf');
        const chunkStart = offset;
        const response = await uploadDriveChunk(uploadUrl, chunk, chunkStart, file.size, loadedInChunk => {
          const uploaded = chunkStart + loadedInChunk;
          const percent = 5 + (uploaded / file.size) * 88;
          setCanvaPdfUploadProgress(percent, true, `${formatFileBytes(uploaded)} / ${formatFileBytes(file.size)}`);
        });
        offset += chunk.size;
        if (response.result) finalResult = response.result;
      }
      return finalResult || {};
    }

    async function uploadCanvaPdfToGoogleDrive(event) {
      const input = event && event.target ? event.target : document.getElementById('canva-pdf-uploader');
      const file = input && input.files ? input.files[0] : null;
      if (!file) return;
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        setCanvaPdfUploadStatus('Only PDF files can be uploaded in Canva PDF Upload.', 'error');
        input.value = '';
        return;
      }

      const pickerBtn = document.getElementById('canva-pdf-picker-btn');
      if (pickerBtn) { pickerBtn.disabled = true; pickerBtn.textContent = 'Saving PDF...'; }
      setCanvaPdfUploadStatus(`Preparing ${file.name} (${formatFileBytes(file.size)})...`);
      setCanvaPdfUploadProgress(1, true, formatFileBytes(file.size));

      let item = null;
      let scene = null;
      try {
        scene = getActiveScene();
        if (!scene) throw new Error('No active scene is available.');

        const itemId = uid();
        const localObjectUrl = URL.createObjectURL(file);
        item = {
          id: itemId,
          type: 'pdf',
          value: localObjectUrl,
          name: file.name,
          googleDrive: {
            fileId: '', driveUrl: '', previewUrl: '', downloadUrl: '',
            uploadedAt: '', syncStatus: 'pending'
          }
        };

        // Save the selected PDF first so a Google Drive/backend problem never loses it.
        setCanvaPdfUploadProgress(3, true, 'Saving browser cache');
        const cached = await savePdfToPersistentCache(itemId, file.name, file, item.googleDrive);
        if (!cached) throw new Error('The browser could not save this PDF. Check available disk space and site-storage permission.');

        if (file.size <= 64 * 1024 * 1024) item.pdfData = await file.arrayBuffer();
        scene.items.push(item);
        persistScenes();
        renderSceneDeckUI();
        setStagedFromSceneIndex(scene.items.length - 1);
        populateSlidePreviewGrid();
        setCanvaPdfUploadProgress(8, true, 'Saved to this scene');

        let backend = null;
        try {
          backend = await verifyGoogleScriptResumableBackend();
        } catch (backendError) {
          item.googleDrive.syncStatus = 'pending-backend-update';
          persistScenes();
          await savePdfToPersistentCache(item.id, item.name, file, item.googleDrive);
          saveDrivePdfRecord({
            name: item.name, fileId: '', driveUrl: '', previewUrl: '', downloadUrl: '',
            uploadedAt: '', sceneId: scene.id, itemId: item.id,
            syncStatus: 'pending-backend-update'
          });
          setCanvaPdfUploadProgress(100, true, 'Saved locally');
          setCanvaPdfUploadStatus(
            `Saved in ${scene.name || 'the current scene'} and available after refresh. Google Drive sync is pending because the deployed Apps Script is still the old backend. Update the existing deployment to the resumable Code.gs, then upload/sync it to Drive.`,
            'warning'
          );
          setTimeout(() => setCanvaPdfUploadProgress(0, false), 2500);
          return;
        }

        if (pickerBtn) pickerBtn.textContent = 'Uploading to Google Drive...';
        setCanvaPdfUploadStatus(`Uploading ${file.name} to Google Drive in chunks. Keep this tab open.`);
        const init = await postGoogleScriptJson({
          action: 'initResumablePdfUpload',
          fileName: file.name,
          mimeType: 'application/pdf',
          fileSize: file.size
        });
        if (!init.uploadUrl) throw new Error('Apps Script did not return a Google Drive resumable upload URL.');

        const driveResult = await uploadLargePdfResumably(file, init.uploadUrl);
        setCanvaPdfUploadProgress(95, true, 'Finalizing file');
        const fileId = driveResult.id || init.fileId || '';
        const uploadedAt = new Date().toISOString();
        item.name = driveResult.name || file.name;
        item.googleDrive = {
          fileId,
          driveUrl: driveResult.webViewLink || (fileId ? `https://drive.google.com/file/d/${fileId}/view` : ''),
          previewUrl: fileId ? `https://drive.google.com/file/d/${fileId}/preview` : '',
          downloadUrl: driveResult.webContentLink || (fileId ? `https://drive.google.com/uc?export=download&id=${fileId}` : ''),
          uploadedAt,
          syncStatus: 'synced'
        };

        await savePdfToPersistentCache(item.id, item.name, file, item.googleDrive);
        saveDrivePdfRecord({
          name:item.name, fileId,
          driveUrl:item.googleDrive.driveUrl,
          previewUrl:item.googleDrive.previewUrl,
          downloadUrl:item.googleDrive.downloadUrl,
          uploadedAt, sceneId:scene.id, itemId:item.id, syncStatus:'synced'
        });
        persistScenes();
        renderSceneDeckUI();
        setStagedFromSceneIndex(scene.items.indexOf(item));
        populateSlidePreviewGrid();
        setCanvaPdfUploadProgress(100, true, 'Upload complete');
        setCanvaPdfUploadStatus(`Uploaded and saved: ${item.name} (${formatFileBytes(file.size)}). It will remain in this scene after refresh.`, 'success');
        setTimeout(() => setCanvaPdfUploadProgress(0, false), 1800);
      } catch (error) {
        console.error('Canva PDF processing failed:', error);
        // If the scene item was already saved, keep it instead of reporting total failure.
        if (item && scene && scene.items.includes(item)) {
          item.googleDrive = Object.assign({}, item.googleDrive || {}, { syncStatus: 'pending-error' });
          persistScenes();
          setCanvaPdfUploadProgress(100, true, 'Saved locally');
          setCanvaPdfUploadStatus(`PDF saved in the scene and will remain after refresh, but Google Drive sync failed: ${error && error.message ? error.message : 'unknown error'}`, 'warning');
          setTimeout(() => setCanvaPdfUploadProgress(0, false), 2500);
        } else {
          setCanvaPdfUploadProgress(0, false);
          setCanvaPdfUploadStatus(`Upload failed: ${error && error.message ? error.message : 'unknown error'}`, 'error');
        }
      } finally {
        if (pickerBtn) { pickerBtn.disabled = false; pickerBtn.textContent = '📄 Choose PDF and Upload'; }
        if (input) input.value = '';
      }
    }

    let slidePreviewRenderToken = 0;

    async function populateSlidePreviewGrid() {
      const grid = document.getElementById('slide-preview-grid');
      if (!grid) return;
      const renderToken = ++slidePreviewRenderToken;

      const deck = getActiveDeck();
      grid.innerHTML = '';

      if (!deck.length) {
        grid.innerHTML = '<div style="grid-column: 1 / -1; color: var(--text-muted);">No slides yet in this scene.</div>';
        return;
      }

      if (staged.type === 'pdf' && staged.value) {
        try {
          const doc = await pdfjsLib.getDocument(getPdfJsSource(staged)).promise;
          for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
            const card = document.createElement('button');
            card.type = 'button';
            card.className = 'preview-slide-card' + (pageNum === staged.page ? ' active' : '');

            const thumb = document.createElement('div');
            thumb.className = 'preview-slide-thumb';

            const page = await doc.getPage(pageNum);
            const viewport = page.getViewport({ scale: 0.8 });
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            await page.render({ canvasContext: ctx, viewport }).promise;
            if (renderToken !== slidePreviewRenderToken) return;
            thumb.appendChild(canvas);

            const meta = document.createElement('div');
            meta.className = 'preview-slide-meta';
            meta.innerHTML = `<strong>Slide ${pageNum}</strong><span>PDF page ${pageNum}/${doc.numPages}</span>`;

            card.appendChild(thumb);
            card.appendChild(meta);
            card.dataset.pdfPage = String(pageNum);
            card.onclick = () => {
              if (staged.page === pageNum) return;
              staged.page = pageNum;
              setSlideStatus();
              updateSlidePreviewActiveState();
              renderPreview();
            };
            grid.appendChild(card);
          }
          return;
        } catch (e) {
          grid.innerHTML = '<div style="grid-column: 1 / -1; color: var(--accent-red);">Unable to load PDF preview pages.</div>';
          return;
        }
      }

      for (const [index, item] of deck.entries()) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'preview-slide-card' + ((index === staged.sceneItemIndex && staged.type !== 'none') ? ' active' : '');

        const thumb = document.createElement('div');
        thumb.className = 'preview-slide-thumb';

        if (item.type === 'image' && item.value) {
          thumb.innerHTML = `<img src="${item.value}" alt="" />`;
        } else if (item.type === 'video' && item.value) {
          thumb.innerHTML = '<div>🎬 Video</div>';
        } else if (item.type === 'url' && item.value) {
          thumb.innerHTML = '<div>🖼️ Canva</div>';
        } else if (item.type === 'pdf' && item.value) {
          thumb.innerHTML = '<div>📄 PDF</div>';
        } else if (item.type === 'bible' && item.value) {
          thumb.innerHTML = '<div>📖 Bible Verse</div>';
        } else {
          thumb.innerHTML = '<div>🗂️ Asset</div>';
        }

        const meta = document.createElement('div');
        meta.className = 'preview-slide-meta';
        meta.innerHTML = `<strong>${(item.name || `Slide ${index + 1}`).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</strong><span>${item.type.toUpperCase()} • ${index + 1}/${deck.length}</span>`;

        card.dataset.sceneIndex = String(index);
        card.appendChild(thumb);
        card.appendChild(meta);
        card.onclick = () => {
          if (staged.sceneItemIndex === index && staged.type !== 'none') return;
          setStagedFromSceneIndex(index);
          updateSlidePreviewActiveState();
        };
        grid.appendChild(card);
      }
    }

    function updateSlidePreviewActiveState() {
      const grid = document.getElementById('slide-preview-grid');
      if (!grid) return;
      grid.querySelectorAll('.preview-slide-card').forEach((card) => {
        const active = staged.type === 'pdf' && card.dataset.pdfPage
          ? Number(card.dataset.pdfPage) === Number(staged.page)
          : card.dataset.sceneIndex && Number(card.dataset.sceneIndex) === Number(staged.sceneItemIndex) && staged.type !== 'none';
        card.classList.toggle('active', Boolean(active));
      });
    }

    function openSlidePreviewModal() { populateSlidePreviewGrid(); }
    function closeSlidePreviewModal() {}

    function renderSceneDeckUI() {
      const container = document.getElementById('deck-container');
      if (!container) return;
      container.innerHTML = '';

      const deck = getActiveDeck();
      deck.forEach((item, index) => {
        const thumb = document.createElement('div');
        thumb.className = 'thumb-item';
        thumb.id = `slide-thumb-${index}`;

        if (item.type === 'image' && item.value) {
          thumb.innerHTML = `<img src="${item.value}" alt="" />`;
        } else {
          thumb.style.background = '#050505';
          let labelText = item.type.toUpperCase();
          if (item.type === 'url') labelText = 'CANVA';
          if (item.type === 'bible') labelText = 'BIBLE';
          
          let brokenBadge = '';
          if (item.type !== 'url' && !item.value) {
            brokenBadge = `<div style="color:var(--accent-red); font-size:10px; margin-top:2px;">⚠️ Folder Unlinked</div>`;
          }

          thumb.innerHTML = `<div style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:#ddd; font-weight:800; font-size:12px; text-align:center; padding:4px;">
            <div>${labelText}</div>
            <div class="file-meta-tag">${item.name || 'No Name'}</div>
            ${brokenBadge}
          </div>`;
        }

        if (index === staged.sceneItemIndex && staged.type !== 'none') {
          thumb.classList.add('active');
        }

        const del = document.createElement('div');
        del.textContent = '✕';
        del.style.position = 'absolute';
        del.style.top = '6px';
        del.style.right = '6px';
        del.style.width = '24px';
        del.style.height = '24px';
        del.style.display = 'flex';
        del.style.alignItems = 'center';
        del.style.justifyContent = 'center';
        del.style.borderRadius = '999px';
        del.style.background = 'rgba(0,0,0,0.65)';
        del.style.color = '#fff';
        del.style.fontWeight = '900';
        del.style.zIndex = '5';
        del.onclick = async (e) => {
          e.stopPropagation();
          const res = await showModal('Delete Media Asset', `Are you sure you want to remove "${item.name || 'this item'}" from the scene queue?`, false);
          if (!res.confirmed) return;

          const scene = getActiveScene();
          if (!scene || !scene.items || !scene.items[index]) return;
          const removedItem = scene.items[index];
          scene.items.splice(index, 1);
          if (removedItem && removedItem.type === 'pdf') removePdfFromPersistentCache(removedItem.id);

          if (scene.items.length === 0) {
            staged = { type: 'none', value: null, sceneItemIndex: -1, page: 1, videoTime: 0, videoPlaying: false };
          } else if (staged.sceneItemIndex === index) {
            staged = { type: 'none', value: null, sceneItemIndex: -1, page: 1, videoTime: 0, videoPlaying: false };
            setStagedFromSceneIndex(Math.min(index, scene.items.length - 1));
          } else if (staged.sceneItemIndex > index) {
            staged.sceneItemIndex = staged.sceneItemIndex - 1;
          }

          persistScenes();
          renderSceneDeckUI();
          renderPreview();
          setSlideStatus();
        };
        thumb.appendChild(del);

        thumb.onclick = () => {
          setStagedFromSceneIndex(index);
        };
        container.appendChild(thumb);
      });
      populateSlidePreviewGrid();
    }

    function setSlideStatus() {
      const el = document.getElementById('slide-status');
      if (!el) return;

      if (staged.type === 'none') {
        el.textContent = 'No media queued';
        return;
      }

      const deck = getActiveDeck();
      if (staged.type === 'url') {
        el.textContent = `Canva Interface Capture Engine Ready`;
        return;
      }

      if (staged.type === 'bible') {
        const ref = staged.value && staged.value.reference ? staged.value.reference : 'Bible verse';
        el.textContent = `Bible: ${ref}`;
        return;
      }


      if (staged.type === 'pdf') {
        el.textContent = `PDF: ${staged.sceneItemIndex + 1}/${deck.length} (Page ${staged.page})`;
      } else if (staged.type === 'video') {
        el.textContent = `Video performance triggers attached`;
      } else {
        el.textContent = `Slide: ${staged.sceneItemIndex + 1}/${deck.length}`;
      }
    }

    async function initializePrecisionLens() {
      const btn = document.getElementById('lens-toggle-btn');
      if (lensCaptureStream) {
        stopPrecisionLens();
        return;
      }
      try {
        lensCaptureStream = await navigator.mediaDevices.getDisplayMedia({
          video: { preferCurrentTab: true, frameRate: 30 },
          audio: false
        });
        if (btn) {
          btn.textContent = "🛑 Stop Preview Frame Sync";
          btn.style.backgroundColor = "var(--accent-red)";
        }
        const hiddenVideo = document.createElement('video');
        hiddenVideo.srcObject = lensCaptureStream;
        hiddenVideo.play();

        const cropCanvas = document.createElement('canvas');
        const cropContext = cropCanvas.getContext('2d');

        lensLoopInterval = setInterval(() => {
          const previewElement = document.getElementById('preview-viewport');
          if (!previewElement || hiddenVideo.readyState < 2) return;

          const rect = previewElement.getBoundingClientRect();
          cropCanvas.width = rect.width;
          cropCanvas.height = rect.height;

          cropContext.drawImage(
            hiddenVideo,
            rect.left * (hiddenVideo.videoWidth / window.innerWidth),
            rect.top * (hiddenVideo.videoHeight / window.innerHeight),
            rect.width * (hiddenVideo.videoWidth / window.innerWidth),
            rect.height * (hiddenVideo.videoHeight / window.innerHeight),
            0, 0, rect.width, rect.height
          );

          const precisionFrame = cropCanvas.toDataURL('image/jpeg', 0.85);
          channel.postMessage({ command: 'UPDATE_MIRROR_LENS_FRAME', frame: precisionFrame });
        }, 33);

        lensCaptureStream.getVideoTracks()[0].onended = () => { stopPrecisionLens(); };
      } catch (err) {}
    }

    function stopPrecisionLens() {
      if (lensLoopInterval) { clearInterval(lensLoopInterval); lensLoopInterval = null; }
      if (lensCaptureStream) {
        lensCaptureStream.getTracks().forEach(t => t.stop());
        lensCaptureStream = null;
      }
      const btn = document.getElementById('lens-toggle-btn');
      if (btn) {
        btn.textContent = "⚡ Start Preview Target Sync";
        btn.style.backgroundColor = "var(--accent-purple)";
      }
      channel.postMessage({ command: 'CLEAR_MIRROR_LENS' });
    }

    function escapeHtml(value) {
      return String(value || '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
    }

    function normalizeBibleBookName(value) {
      return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    function normalizeBibleSearchQuery(input) {
      const trimmed = String(input || '').trim();
      if (!trimmed) return null;
      const match = trimmed.match(/^([a-z0-9 .'-]+)\s*:\s*([0-9]+)\s*:\s*([0-9]+)(?:\s*-\s*([0-9]+))?$/i);
      if (!match) return null;
      return {
        book: match[1].trim(),
        chapter: parseInt(match[2], 10),
        verse: parseInt(match[3], 10),
        endVerse: match[4] ? parseInt(match[4], 10) : null
      };
    }

    function buildBibleReference(book, chapter, verse) {
      return `${String(book || '').trim()} ${chapter}:${verse}`;
    }

    function isSupportedBibleFile(fileName) {
      const lowerName = String(fileName || '').toLowerCase();
      // Change this return statement to include .xml and .json extensions
      return lowerName.endsWith('.xml') || lowerName.endsWith('.json') || lowerName.endsWith('.sql') || lowerName.endsWith('.pdf');
    }

    function makeBibleLibraryKey(fileName) {
      const baseName = String(fileName || '')
        .replace(/\.(xml|json|sql|pdf)$/i, '')
        .trim()
        .replace(/[^a-z0-9]+/gi, '_')
        .replace(/^_+|_+$/g, '') || 'imported_bible';
      const key = baseName.toLowerCase();
      return bibleLibraries[key] ? null : key;
    }

    function parseBibleXml(xmlText, sourceLabel) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) return [];

      const entries = [];
      const seen = new Set();

      const walk = (node, currentBook = '', currentChapter = '') => {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return;

        const tag = (node.tagName || '').toLowerCase();
        const attrs = {};
        if (node.attributes) {
          Array.from(node.attributes).forEach((attr) => {
            attrs[attr.name.toLowerCase()] = attr.value;
          });
        }

        let book = currentBook;
        let chapter = currentChapter;

        if (['book', 'biblebook', 'osisbook', 'bookofbible'].includes(tag)) {
          const bookValue = attrs.book || attrs.name || attrs.osisid || attrs.id || attrs.bookname || attrs.bname;
          if (bookValue) book = String(bookValue).trim();
        }

        if (['chapter', 'chap'].includes(tag)) {
          const chapterValue = attrs.chapter || attrs.ch || attrs.number || attrs.n || attrs.chapternum || attrs.value;
          if (chapterValue) chapter = String(chapterValue).trim();
        }

        const isVerseNode = ['verse', 'v', 'seg', 'content', 'text'].includes(tag) || /verse/i.test(tag);
        const verseValue = attrs.verse || attrs.v || attrs.number || attrs.n || attrs.versenum || attrs.value;
        const textContent = (node.textContent || '').replace(/\s+/g, ' ').trim();

        if (isVerseNode && book && chapter && verseValue && textContent) {
          const verseNum = parseInt(String(verseValue).replace(/[^0-9]/g, ''), 10);
          if (Number.isFinite(verseNum)) {
            const normalizedKey = `${normalizeBibleBookName(book)}|${String(chapter).trim()}|${verseNum}`;
            if (!seen.has(normalizedKey)) {
              seen.add(normalizedKey);
              entries.push({
                book: String(book).trim(),
                chapter: parseInt(String(chapter).trim(), 10) || 1,
                verse: verseNum,
                text: textContent,
                reference: buildBibleReference(String(book).trim(), parseInt(String(chapter).trim(), 10) || 1, verseNum),
                sourceLabel
              });
            }
          }
        }

        Array.from(node.children).forEach((child) => walk(child, book, chapter));
      };

      walk(doc.documentElement, '', '');
      return entries;
    }

    function parseBibleJson(jsonText, sourceLabel) {
      const entries = [];
      const seen = new Set();

      const addEntry = (book, chapter, verse, text) => {
        const chapterNum = parseInt(String(chapter).replace(/[^0-9]/g, ''), 10);
        const verseNum = parseInt(String(verse).replace(/[^0-9]/g, ''), 10);
        if (!book || !Number.isFinite(chapterNum) || !Number.isFinite(verseNum)) return;
        const normalizedKey = `${normalizeBibleBookName(book)}|${chapterNum}|${verseNum}`;
        if (!seen.has(normalizedKey)) {
          seen.add(normalizedKey);
          entries.push({
            book: String(book).trim(),
            chapter: chapterNum,
            verse: verseNum,
            text: String(text || '').replace(/\s+/g, ' ').trim(),
            reference: buildBibleReference(String(book).trim(), chapterNum, verseNum),
            sourceLabel
          });
        }
      };

      const walk = (value) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
          value.forEach(walk);
          return;
        }

        const bookValue = value.book || value.bibleBook || value.bookName || value.bookname || value.name || value.title;
        const chapterValue = value.chapter || value.ch || value.chap || value.chapterNumber;
        const verseValue = value.verse || value.verseNumber || value.verseNum || value.number || value.versenum;
        const textValue = value.text || value.content || value.verseText || value.scripture || value.message || value.value;
        if (bookValue && chapterValue !== undefined && verseValue !== undefined && textValue) {
          addEntry(bookValue, chapterValue, verseValue, textValue);
        }

        Object.keys(value).forEach((key) => {
          const normalizedKey = String(key).toLowerCase();
          if (['book', 'biblebook', 'bookname', 'name', 'title', 'chapter', 'ch', 'chap', 'chapternumber', 'verse', 'versenumber', 'versenum', 'number', 'text', 'content', 'versetext', 'scripture', 'message', 'value'].includes(normalizedKey)) {
            return;
          }
          walk(value[key]);
        });
      };

      try {
        walk(JSON.parse(jsonText));
      } catch (e) {}
      return entries;
    }

    function parseBibleSql(sqlText, sourceLabel) {
      const entries = [];
      const seen = new Set();

      const addEntry = (book, chapter, verse, text) => {
        const chapterNum = parseInt(String(chapter).replace(/[^0-9]/g, ''), 10);
        const verseNum = parseInt(String(verse).replace(/[^0-9]/g, ''), 10);
        if (!book || !Number.isFinite(chapterNum) || !Number.isFinite(verseNum)) return;
        const normalizedKey = `${normalizeBibleBookName(book)}|${chapterNum}|${verseNum}`;
        if (!seen.has(normalizedKey)) {
          seen.add(normalizedKey);
          entries.push({
            book: String(book).trim(),
            chapter: chapterNum,
            verse: verseNum,
            text: String(text || '').replace(/\s+/g, ' ').trim(),
            reference: buildBibleReference(String(book).trim(), chapterNum, verseNum),
            sourceLabel
          });
        }
      };

      const sqlPattern = /(['"]?)([A-Za-z .,'-]+)\1\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*(['"])([\s\S]*?)\5/gi;
      let match;
      while ((match = sqlPattern.exec(sqlText))) {
        addEntry(match[2], match[3], match[4], match[6]);
      }
      return entries;
    }

    function parseBiblePdfText(text, sourceLabel) {
      const entries = [];
      const seen = new Set();
      const linePattern = /^([A-Za-z0-9 .,'-]+?)\s+([0-9]+):([0-9]+)\s*(.*)$/;

      String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          const match = line.match(linePattern);
          if (!match) return;
          const book = match[1].trim();
          const chapterNum = parseInt(match[2], 10);
          const verseNum = parseInt(match[3], 10);
          const verseText = match[4].replace(/\s+/g, ' ').trim();
          if (!book || !Number.isFinite(chapterNum) || !Number.isFinite(verseNum) || !verseText) return;
          const normalizedKey = `${normalizeBibleBookName(book)}|${chapterNum}|${verseNum}`;
          if (!seen.has(normalizedKey)) {
            seen.add(normalizedKey);
            entries.push({
              book,
              chapter: chapterNum,
              verse: verseNum,
              text: verseText,
              reference: buildBibleReference(book, chapterNum, verseNum),
              sourceLabel
            });
          }
        });

      return entries;
    }

    async function parseBibleFile(file) {
      const lowerName = String(file && file.name ? file.name : '').toLowerCase();
      if (lowerName.endsWith('.xml')) {
        const xmlText = await file.text();
        return parseBibleXml(xmlText, file.name.replace(/\.xml$/i, ''));
      }
      if (lowerName.endsWith('.json')) {
        const jsonText = await file.text();
        return parseBibleJson(jsonText, file.name.replace(/\.json$/i, ''));
      }
      if (lowerName.endsWith('.sql')) {
        const sqlText = await file.text();
        return parseBibleSql(sqlText, file.name.replace(/\.sql$/i, ''));
      }
      if (lowerName.endsWith('.pdf') && typeof pdfjsLib !== 'undefined') {
        const pdfData = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
        let fullText = '';
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
          const page = await pdf.getPage(pageNum);
          const content = await page.getTextContent();
          const pageText = content.items.map((item) => item.str).join(' ');
          fullText += `${fullText ? '\n' : ''}${pageText}`;
        }
        return parseBiblePdfText(fullText, file.name.replace(/\.pdf$/i, ''));
      }
      return [];
    }

    function openBibleDB() {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open('MPS_Bible_DB', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('bibles', { keyPath: 'key' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    async function saveBibleLibraryToDB(key, bible) {
      const db = await openBibleDB();
      return new Promise((resolve) => {
        const tx = db.transaction('bibles', 'readwrite');
        tx.objectStore('bibles').put({ key, label: bible.label || key, entries: bible.entries || [] });
        tx.oncomplete = () => resolve();
      });
    }

    async function loadBibleLibrariesFromStorage() {
      try {
        const db = await openBibleDB();
        const result = await new Promise((resolve) => {
          const tx = db.transaction('bibles', 'readonly');
          const req = tx.objectStore('bibles').getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        });

        bibleLibraries = {};
        result.forEach((item) => {
          if (item && item.key) {
            bibleLibraries[item.key] = { key: item.key, label: item.label || item.key, entries: item.entries || [] };
          }
        });

        if (!activeBibleKey && Object.keys(bibleLibraries).length) {
          activeBibleKey = Object.keys(bibleLibraries)[0];
        }
      } catch (e) {
        bibleLibraries = {};
      }
    }

    function populateBibleLibrarySelector() {
      const select = document.getElementById('bible-language-select');
      if (!select) return;
      select.innerHTML = '';

      const keys = Object.keys(bibleLibraries).sort();
      if (!keys.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'No Bible imported';
        select.appendChild(option);
        return;
      }

      keys.forEach((key) => {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = bibleLibraries[key].label || key;
        if (key === activeBibleKey) option.selected = true;
        select.appendChild(option);
      });
    }

    function setActiveBibleLibrary(key) {
      activeBibleKey = key;
      currentBibleSearchResult = null;
      renderBibleSearchResult();
    }

    async function importBibleFileObject(file) {
      if (!file || !isSupportedBibleFile(file.name)) return { imported: false, reason: 'unsupported' };

      const key = makeBibleLibraryKey(file.name);
      if (!key) return { imported: false, reason: 'duplicate' };

      try {
        const entries = await parseBibleFile(file);
        if (!entries.length) return { imported: false, reason: 'no readable verses' };

        const label = file.name.replace(/\.(xml|json|sql|txt|csv|pdf)$/i, '');
        bibleLibraries[key] = { key, label, entries };
        await saveBibleLibraryToDB(key, bibleLibraries[key]);
        if (!activeBibleKey) activeBibleKey = key;
        return { imported: true, key, label };
      } catch (error) {
        return { imported: false, reason: error && error.message ? error.message : 'read failed' };
      }
    }

    async function importBibleFiles() {
      const input = document.getElementById('bible-file-input');
      const files = input && input.files ? Array.from(input.files) : [];
      if (!files.length) return;

      let importedCount = 0;
      const skipped = [];
      for (const file of files) {
        if (!isSupportedBibleFile(file.name)) continue;
        const result = await importBibleFileObject(file);
        if (result.imported) importedCount += 1;
        else if (result.reason !== 'duplicate') skipped.push(`${file.name}: ${result.reason}`);
      }

      populateBibleLibrarySelector();
      renderBibleSearchResult();

      if (importedCount) {
        if (skipped.length) {
          showModal('Bible Import Complete', `Imported ${importedCount} Bible file${importedCount === 1 ? '' : 's'}. Some items were skipped: ${skipped.slice(0, 3).join('; ')}`, false);
        }
      } else if (skipped.length) {
        showModal('Bible Import Failed', `No readable Bible content was found. ${skipped[0]}`, false);
      }

      if (input) input.value = '';
    }

    function renderBibleSearchResult(message = '') {
      const resultBox = document.getElementById('bible-search-result');
      if (!resultBox) return;

      if (message) {
        resultBox.innerHTML = `<div style="color: var(--accent-red);">${escapeHtml(message)}</div>`;
        return;
      }

      if (!activeBibleKey || !bibleLibraries[activeBibleKey]) {
        resultBox.innerHTML = '<div style="color: var(--text-muted);">Import a Bible XML file to begin searching.</div>';
        return;
      }

      if (!currentBibleSearchResult) {
        resultBox.innerHTML = '<div style="color: var(--text-muted);">Search using the format Book:Chapter:Verse, such as Genesis 1:1.</div>';
        return;
      }

      resultBox.innerHTML = `
        <div style="font-weight: 700; color: #fff;">${escapeHtml(currentBibleSearchResult.reference)}</div>
        <div style="margin-top: 6px; color: var(--text-muted);">${escapeHtml(currentBibleSearchResult.text)}</div>
      `;
    }

    function searchBibleVerse() {
      const input = document.getElementById('bible-search-input');
      const query = input ? input.value : '';
      const parsed = normalizeBibleSearchQuery(query);
      const bible = activeBibleKey && bibleLibraries[activeBibleKey] ? bibleLibraries[activeBibleKey] : null;

      if (!bible || !bible.entries || !bible.entries.length) {
        currentBibleSearchResult = null;
        renderBibleSearchResult('Import a Bible XML file first.');
        return;
      }

      if (!parsed) {
        currentBibleSearchResult = null;
        renderBibleSearchResult('Use the format Book:Chapter:Verse, for example Genesis 1:1');
        return;
      }

      const match = bible.entries.find((entry) => {
        return normalizeBibleBookName(entry.book) === normalizeBibleBookName(parsed.book) && entry.chapter === parsed.chapter && entry.verse === parsed.verse;
      });

      currentBibleSearchResult = match || null;
      if (!currentBibleSearchResult) {
        renderBibleSearchResult(`No result found for ${parsed.book}:${parsed.chapter}:${parsed.verse}.`);
      } else {
        renderBibleSearchResult();
      }
    }

    function previewBibleSearchResult() {
      if (!currentBibleSearchResult) {
        renderBibleSearchResult('Search for a verse before previewing it.');
        return;
      }

      const bible = activeBibleKey && bibleLibraries[activeBibleKey] ? bibleLibraries[activeBibleKey] : null;
      staged = {
        type: 'bible',
        value: {
          category: bible ? (bible.label || activeBibleKey) : 'Bible',
          reference: currentBibleSearchResult.reference,
          text: currentBibleSearchResult.text
        },
        name: currentBibleSearchResult.reference,
        category: bible ? (bible.label || activeBibleKey) : 'Bible',
        sceneItemIndex: -1,
        page: 1,
        videoTime: 0,
        videoPlaying: false
      };
      renderSceneDeckUI();
      renderPreview();
      setSlideStatus();
    }

    function addBibleSearchResultToScene() {
      if (!currentBibleSearchResult) {
        renderBibleSearchResult('Search for a verse before adding it to the scene.');
        return;
      }

      const scene = getActiveScene();
      const bible = activeBibleKey && bibleLibraries[activeBibleKey] ? bibleLibraries[activeBibleKey] : null;
      if (!scene) return;

      scene.items.push({
        id: uid(),
        type: 'bible',
        value: {
          category: bible ? (bible.label || activeBibleKey) : 'Bible',
          reference: currentBibleSearchResult.reference,
          text: currentBibleSearchResult.text
        },
        name: currentBibleSearchResult.reference,
        category: bible ? (bible.label || activeBibleKey) : 'Bible'
      });
      persistScenes();
      renderSceneDeckUI();
      setStagedFromSceneIndex(scene.items.length - 1);
    }

    async function renderMediaIntoViewport(target, payload, options = {}) {
      const label = target.querySelector('.viewport-label');
      const placeholderId = options.placeholderId || 'preview-placeholder';
      let placeholder = document.getElementById(placeholderId);

      // V67: PDF slides render into a hidden replacement layer first. Keep the
      // current canvas mounted until the next page has fully rendered so the
      // Preview never flashes/clears while using the keyboard or slide browser.
      if (payload && payload.type === 'pdf' && payload.value) {
        if (!placeholder) {
          placeholder = document.createElement('div');
          placeholder.id = placeholderId;
          placeholder.style.color = '#555';
        }

        const nextWrap = document.createElement('div');
        nextWrap.className = 'v67-pdf-buffer-layer';
        nextWrap.style.width = '100%';
        nextWrap.style.height = '100%';
        nextWrap.style.display = 'flex';
        nextWrap.style.alignItems = 'center';
        nextWrap.style.justifyContent = 'center';
        nextWrap.style.opacity = '0';
        nextWrap.style.position = 'absolute';
        nextWrap.style.inset = '0';
        nextWrap.style.pointerEvents = 'none';
        target.appendChild(nextWrap);

        try {
          if (!options.readOnly) pdfDoc = null;
          const loadingTask = pdfjsLib.getDocument(getPdfJsSource(payload));
          const doc = await loadingTask.promise;
          if (!options.readOnly) pdfDoc = doc;
          const pageNum = Math.max(1, Math.min(payload.page || 1, doc.numPages));
          if (!options.readOnly) staged.page = pageNum;

          const page = await doc.getPage(pageNum);
          const viewport = page.getViewport({ scale: 1.6 });
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', { alpha: false });
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = '100%';
          canvas.style.height = '100%';
          canvas.style.objectFit = 'contain';
          await page.render({ canvasContext: ctx, viewport }).promise;
          nextWrap.appendChild(canvas);

          // Swap only after the new canvas has painted at least once.
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          Array.from(target.children).forEach(child => {
            if (child !== label && child !== nextWrap && !child.classList?.contains('pdf-live-nav')) child.remove();
          });
          nextWrap.style.position = '';
          nextWrap.style.inset = '';
          nextWrap.style.pointerEvents = '';
          nextWrap.style.opacity = '1';

          if (options.readOnly && target.id === 'live-viewport') {
            addPdfLiveNavigation(target, pageNum, doc.numPages);
          }
        } catch (e) {
          nextWrap.remove();
          // Preserve the previous rendered page on failure. Only show an error
          // if there was no previous PDF canvas to keep on screen.
          if (!target.querySelector('canvas')) {
            placeholder.style.color = '#ccc';
            placeholder.textContent = 'PDF rendering failed';
            target.appendChild(placeholder);
          }
        }
        return;
      }

      target.innerHTML = '';
      if (label) target.appendChild(label);

      if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.id = placeholderId;
        placeholder.style.color = '#555';
      }

      if (!payload || payload.type === 'none') {
        placeholder.style.color = '#555';
        placeholder.textContent = options.emptyText || 'No Media Queued';
        target.appendChild(placeholder);
        return;
      }

      if (payload.type === 'bible') {
        const verse = payload.value || {};
        const card = document.createElement('div');
        card.className = 'bible-card';
        card.innerHTML = '<div class="bible-category-tag">' + escapeHtml(verse.category || payload.category || 'Bible') + '</div>' +
          '<div class="bible-text">' + escapeHtml(verse.text || '') + '</div>' +
          '<div class="bible-reference">' + escapeHtml(verse.reference || payload.name || '') + '</div>';
        target.appendChild(card);
        return;
      }

      if (!payload.value) {
        placeholder.style.color = '#aaa';
        placeholder.innerHTML = payload.type === 'pdf'
          ? '<div>⚠️ PDF data is not available in this browser. Open View PDFs or upload the file once to restore it.</div>'
          : '<div>⚠️ File unlinked. Unlock folder token above to scan.</div>';
        target.appendChild(placeholder);
        return;
      }

      if (payload.type === 'image') {
        const img = document.createElement('img');
        img.src = payload.value;
        target.appendChild(img);
        return;
      }

      if (payload.type === 'video') {
        const video = document.createElement('video');
        video.src = payload.value;
        video.controls = false;
        video.muted = true;
        video.currentTime = payload.videoTime || 0;
        if (options.liveVideoId) video.id = options.liveVideoId;
        target.appendChild(video);
        if (options.readOnly && payload.videoPlaying) {
          video.play().catch(() => {});
        }

        if (!options.readOnly) {
          const videoToolbar = document.createElement('div');
          videoToolbar.className = 'video-toolbar';
          videoToolbar.innerHTML = `
            <button id="preview-vid-toggle-btn" onclick="togglePreviewVideo()">▶ Play</button>
            <button onclick="controlPreviewVideo('rewind')">⏪ Reset</button>
            <span id="vid-runtime-lbl">0:00</span>
          `;
          target.appendChild(videoToolbar);

          video.ontimeupdate = () => {
            const lbl = document.getElementById('vid-runtime-lbl');
            if (lbl) lbl.textContent = new Date(video.currentTime * 1000).toISOString().substr(14, 5);
            staged.videoTime = video.currentTime;
            syncLiveVideoFromPreview(video.currentTime, staged.videoPlaying);
          };
          video.onended = () => {
            staged.videoPlaying = false;
            const btn = document.getElementById('preview-vid-toggle-btn');
            if (btn) btn.textContent = "▶ Play";
          };
        }
        return;
      }

      if (payload.type === 'url') {
        const iframe = document.createElement('iframe');
        iframe.src = payload.value;
        iframe.style.width = '100%'; iframe.style.height = '100%';
        iframe.setAttribute('allow', 'fullscreen');
        target.appendChild(iframe);
        return;
      }

      if (payload.type === 'pdf') {
        const wrap = document.createElement('div');
        wrap.style.width = '100%'; wrap.style.height = '100%';
        wrap.style.display = 'flex'; wrap.style.alignItems = 'center'; wrap.style.justifyContent = 'center';
        wrap.innerHTML = '<div style="color:#666; padding:16px;">Loading PDF...</div>';
        target.appendChild(wrap);

        try {
          if (!options.readOnly) pdfDoc = null;
          const loadingTask = pdfjsLib.getDocument(getPdfJsSource(payload));
          const doc = await loadingTask.promise;
          if (!options.readOnly) pdfDoc = doc;
          const pageNum = Math.max(1, Math.min(payload.page || 1, doc.numPages));
          if (!options.readOnly) staged.page = pageNum;

          const page = await doc.getPage(pageNum);
          const viewport = page.getViewport({ scale: 1.6 });
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          canvas.width = viewport.width; canvas.height = viewport.height;

          await page.render({ canvasContext: ctx, viewport }).promise;
          wrap.innerHTML = '';
          canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.objectFit = 'contain';
          wrap.appendChild(canvas);

          if (options.readOnly && target.id === 'live-viewport') {
            addPdfLiveNavigation(target, pageNum, doc.numPages);
          }
        } catch (e) {
          wrap.innerHTML = '<div style="color:#ccc; padding:16px;">PDF rendering failed</div>';
        }
      }
    }

    function ensureLiveMonitorOverlays() {
      const target = document.getElementById('live-viewport');
      if (!target) return;
      let bg = document.getElementById('live-bg-overlay');
      let black = document.getElementById('live-black-overlay');
      if (!bg) {
        bg = document.createElement('div');
        bg.id = 'live-bg-overlay';
        bg.className = 'live-monitor-overlay';
      }
      if (!black) {
        black = document.createElement('div');
        black.id = 'live-black-overlay';
        black.className = 'live-monitor-overlay';
      }
      target.appendChild(bg);
      target.appendChild(black);
    }

    function updateLiveMonitorOverlays() {
      ensureLiveMonitorOverlays();
      const bg = document.getElementById('live-bg-overlay');
      const black = document.getElementById('live-black-overlay');
      if (bg) {
        if (currentBackgroundSource) bg.innerHTML = '<img src="' + currentBackgroundSource + '" alt="Background View" />';
        bg.classList.toggle('active', isFTGActive);
      }
      if (black) black.classList.toggle('active', isFTBActive);
    }

    function isStagedLiveVideo() {
      if (staged.type !== 'video' || liveState.type !== 'video') return false;
      if (staged.itemId && liveState.itemId) return staged.itemId === liveState.itemId;
      return Boolean(staged.value && liveState.value && staged.value === liveState.value);
    }

    function syncLiveVideoFromPreview(time, playing) {
      if (!isStagedLiveVideo()) return;
      liveState.videoTime = time;
      liveState.videoPlaying = playing;
      const monitorVideo = document.getElementById('operator-live-video');
      if (monitorVideo) {
        if (Math.abs(monitorVideo.currentTime - time) > 0.5) monitorVideo.currentTime = time;
        if (playing && monitorVideo.paused) monitorVideo.play().catch(() => {});
        if (!playing && !monitorVideo.paused) monitorVideo.pause();
      }
      channel.postMessage({ command: 'SYNC_VIDEO_STATE', time, playing });
    }

    async function renderLiveView() {
      const target = document.getElementById('live-viewport');
      if (!target) return;
      await renderMediaIntoViewport(target, liveState, { readOnly: true, liveVideoId: 'operator-live-video', placeholderId: 'live-placeholder', emptyText: 'Nothing Live' });
      updateLiveMonitorOverlays();
    }

    async function renderPreview() {
      const target = document.getElementById('preview-viewport');
      if (!target) return;
      await renderMediaIntoViewport(target, staged, { placeholderId: 'preview-placeholder', emptyText: 'No Media Queued' });
    }
    function togglePreviewVideo() {
      const vid = document.querySelector('#preview-viewport video');
      const btn = document.getElementById('preview-vid-toggle-btn');
      if (!vid || !btn) return;

      if (vid.paused) {
        vid.play();
        staged.videoPlaying = true;
        btn.textContent = "⏹ Stop";
      } else {
        vid.pause();
        staged.videoPlaying = false;
        btn.textContent = "▶ Play";
      }
      syncLiveVideoFromPreview(vid.currentTime, staged.videoPlaying);
    }

    function controlPreviewVideo(action) {
      const vid = document.querySelector('#preview-viewport video');
      if (!vid) return;
      if (action === 'rewind') { 
        vid.currentTime = 0; 
      }
      syncLiveVideoFromPreview(vid.currentTime, staged.videoPlaying);
    }

    function setPdfPage(page) {
      if (staged.type !== 'pdf') return;
      const maxPage = pdfDoc && pdfDoc.numPages ? pdfDoc.numPages : Number.MAX_SAFE_INTEGER;
      const nextPage = Math.max(1, Math.min(Number(page) || 1, maxPage));
      if (nextPage === staged.page) return;
      staged.page = nextPage;
      setSlideStatus();
      updateSlidePreviewActiveState();
      renderPreview();
      // Keep thumbnail canvases mounted to prevent slide-browser flicker.
    }

    function removePdfLiveNavigation(target) {
      if (!target) return;
      target.querySelectorAll('.pdf-live-nav').forEach(el => el.remove());
    }

    function addPdfLiveNavigation(target, pageNum, totalPages) {
      if (!target || target.id !== 'live-viewport') return;
      removePdfLiveNavigation(target);
      const nav = document.createElement('div');
      nav.className = 'pdf-live-nav';
      const prev = document.createElement('button');
      prev.type = 'button';
      prev.innerHTML = '&#8249;';
      prev.title = 'Previous PDF slide';
      prev.setAttribute('aria-label', 'Previous PDF slide');
      prev.disabled = pageNum <= 1;
      prev.onclick = (event) => { event.stopPropagation(); navigateLivePdf(-1); };
      const next = document.createElement('button');
      next.type = 'button';
      next.innerHTML = '&#8250;';
      next.title = 'Next PDF slide';
      next.setAttribute('aria-label', 'Next PDF slide');
      next.disabled = pageNum >= totalPages;
      next.onclick = (event) => { event.stopPropagation(); navigateLivePdf(1); };
      const label = document.createElement('div');
      label.className = 'pdf-live-page-label';
      label.textContent = `Slide ${pageNum} / ${totalPages}`;
      nav.appendChild(prev);
      nav.appendChild(next);
      nav.appendChild(label);
      target.appendChild(nav);
    }

    async function navigateLivePdf(delta) {
      if (!liveState || liveState.type !== 'pdf' || !liveState.value) return;
      try {
        const doc = await pdfjsLib.getDocument(liveState.value).promise;
        const nextPage = Math.max(1, Math.min((liveState.page || 1) + delta, doc.numPages));
        if (nextPage === liveState.page) return;
        liveState.page = nextPage;
        await renderLiveView();
        channel.postMessage({ command: 'UPDATE_LIVE_PDF_PAGE', payload: liveState });
      } catch (error) {
        console.warn('Unable to navigate live PDF:', error);
      }
    }

    async function renderAudience(payload) {
      const audienceTarget = document.getElementById('audience-view');
      
      let bgLayer = document.getElementById('audience-bg-layer');
      if (!bgLayer) {
        bgLayer = document.createElement('div');
        bgLayer.id = 'audience-bg-layer';
        audienceTarget.appendChild(bgLayer);
      }

      const tempWrapper = document.createElement('div');
      tempWrapper.style.width = '100%';
      tempWrapper.style.height = '100%';
      tempWrapper.style.position = 'absolute';

      if (!payload || payload.type === 'none') return;
      if (!payload.value) {
        audienceTarget.innerHTML = `<div style="color:#bbb; padding:16px; text-align:center;">Local file data unlinked. Unlock folder on control panel.</div>`;
        audienceTarget.appendChild(bgLayer);
        return;
      }

      if (payload.type === 'image') {
        const img = document.createElement('img');
        img.src = payload.value;
        tempWrapper.appendChild(img);
      } else if (payload.type === 'video') {
        const video = document.createElement('video');
        video.id = "audience-live-video";
        video.src = payload.value;
        video.controls = false; 
        video.style.width = '100%'; video.style.height = '100%'; video.style.objectFit = 'contain';
        tempWrapper.appendChild(video);
        video.currentTime = payload.videoTime || 0;
        if (payload.videoPlaying) video.play();
      } else if (payload.type === 'url') {
        const iframe = document.createElement('iframe');
        iframe.src = payload.value;
        iframe.style.border = 'none'; iframe.style.width = '100%'; iframe.style.height = '100%';
        tempWrapper.appendChild(iframe);
      } else if (payload.type === 'pdf') {
        const wrap = document.createElement('div');
        wrap.style.width = '100%'; wrap.style.height = '100%';
        wrap.style.display = 'flex'; wrap.style.alignItems = 'center'; wrap.style.justifyContent = 'center';
        tempWrapper.appendChild(wrap);

        try {
          const doc = await pdfjsLib.getDocument(getPdfJsSource(payload)).promise;
          const pageNum = Math.max(1, Math.min(payload.page || 1, doc.numPages));
          const page = await doc.getPage(pageNum);
          const viewport = page.getViewport({ scale: 1.6 });
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          canvas.width = viewport.width; canvas.height = viewport.height;

          await page.render({ canvasContext: ctx, viewport }).promise;
          canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.objectFit = 'contain';
          wrap.appendChild(canvas);
        } catch (e) {
          wrap.innerHTML = `<div>PDF rendering failed</div>`;
        }
      }

      const extensions = Array.from(audienceTarget.children).filter(el => el.id !== 'audience-bg-layer');
      extensions.forEach(el => el.remove());
      audienceTarget.appendChild(tempWrapper);
    }

    function fireLive() {
      if (isFTBActive || isFTGActive) {
        showModal('Live View Is Covered', 'Turn off Fade To Black or Fade To Background before sending a new preview live.', false);
        return;
      }
      const transType = document.getElementById('transition-type-select').value;
      liveState = clonePresenterPayload(staged);
      renderLiveView();
      channel.postMessage({ command: 'TRIGGER_LIVE_FADE', payload: clonePresenterPayload(staged), transitionType: transType });
    }

    function toggleFadeToBlack() {
      isFTBActive = !isFTBActive;
      
      if (isFTBActive && isFTGActive) {
        toggleFadeToBackground();
      }

      const btn = document.getElementById('ftb-toggle-btn');
      if (isFTBActive) {
        btn.classList.add('active');
        btn.textContent = "🔴 Blackout Active";
      } else {
        btn.classList.remove('active');
        btn.textContent = "⚫ Fade To Black";
      }
      updateLiveMonitorOverlays();
      channel.postMessage({ command: 'TOGGLE_FTB_STATE', active: isFTBActive });
    }

    function toggleFadeToBackground() {
      const currentBgFile = localStorage.getItem(LS_BG_TARGET);
      if (!currentBgFile && !isFTGActive) {
        showModal("Background Image Required", "Please choose an image file from the dropdown list before triggering background fade.", false);
        return;
      }

      isFTGActive = !isFTGActive;

      if (isFTGActive && isFTBActive) {
        toggleFadeToBlack();
      }

      const btn = document.getElementById('ftg-toggle-btn');
      if (isFTGActive) {
        btn.classList.add('active');
        btn.textContent = "🖼️ Background Off";
      } else {
        btn.classList.remove('active');
        btn.textContent = "🖼️ Background On";
      }
      updateLiveMonitorOverlays();
      channel.postMessage({ command: 'TOGGLE_FTG_STATE', active: isFTGActive });
    }

    function closeDisplayScreen() {
      if (displayWindow) { displayWindow.close(); displayWindow = null; }
      channel.postMessage({ command: 'CLOSE_DISPLAY' });
      updateDisplayToggleButton();
    }

    // Exposed for the PPTX-only Extender. Stop Presenting uses this after the
    // safety background has faded in so the secondary audience window closes
    // without ever revealing the PowerPoint editor.
    window.closeOnlyOfficeAudienceDisplay = function() {
      closeDisplayScreen();
      return true;
    };

    async function buildAudienceMediaLayer(payload) {
      const layer = document.createElement('div');
      layer.className = 'audience-media-layer';
      layer.style.zIndex = '10';

      if (!payload || payload.type === 'none') return layer;

      if (payload.type === 'bible') {
        const card = makeBiblePresentationCard(payload);
        layer.appendChild(card);
        requestAnimationFrame(() => fitBibleCardText(card));
        return layer;
      }

      if (payload.type === 'image') {
        const img = document.createElement('img');
        img.src = payload.value || '';
        if (img.decode) { try { await img.decode(); } catch (e) {} }
        layer.appendChild(img);
        return layer;
      }

      if (payload.type === 'video') {
        const video = document.createElement('video');
        video.id = 'audience-live-video';
        video.src = payload.value || '';
        video.controls = false;
        video.playsInline = true;
        video.preload = 'auto';
        video.currentTime = payload.videoTime || 0;
        await new Promise(resolve => {
          if (video.readyState >= 2) return resolve();
          const done = () => resolve();
          video.addEventListener('loadeddata', done, { once: true });
          video.addEventListener('error', done, { once: true });
          setTimeout(done, 1800);
        });
        layer.appendChild(video);
        if (payload.videoPlaying) video.play().catch(() => {});
        return layer;
      }

      if (payload.type === 'url') {
        const iframe = document.createElement('iframe');
        iframe.src = payload.value || '';
        iframe.setAttribute('allow', 'fullscreen');
        iframe.setAttribute('scrolling', 'no');
        layer.appendChild(iframe);
        return layer;
      }

      if (payload.type === 'pdf') {
        const source = getPdfJsSource(payload);
        if (!source) throw new Error('PDF source unavailable');
        const doc = await pdfjsLib.getDocument(source).promise;
        const pageNum = Math.max(1, Math.min(payload.page || 1, doc.numPages));
        const page = await doc.getPage(pageNum);
        const baseViewport = page.getViewport({ scale: 1 });
        const screenScale = Math.max(1.5, Math.min(3, Math.max(window.innerWidth / baseViewport.width, window.innerHeight / baseViewport.height) * (window.devicePixelRatio || 1)));
        const viewport = page.getViewport({ scale: screenScale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.objectFit = 'contain';
        await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport }).promise;
        layer.appendChild(canvas);
        return layer;
      }

      return layer;
    }

    let audienceTransitionToken = 0;
    async function performAudienceTransition(payload, transitionType) {
      const view = document.getElementById('audience-view');
      if (!view) return;
      const token = ++audienceTransitionToken;
      let nextLayer;
      try {
        nextLayer = await buildAudienceMediaLayer(payload);
      } catch (error) {
        console.error('Audience render failed:', error);
        return; // Keep the current slide visible instead of flashing an error screen.
      }
      if (token !== audienceTransitionToken) return;

      const oldLayers = Array.from(view.querySelectorAll(':scope > .audience-media-layer'));
      // V67: stop the outgoing program video immediately when another scene is
      // committed. This prevents its audio/playback continuing underneath the
      // incoming image/PDF/Bible/video during a fade or dissolve.
      oldLayers.forEach(layer => layer.querySelectorAll('video').forEach(video => {
        try { video.pause(); } catch (_) {}
        try { video.muted = true; video.volume = 0; } catch (_) {}
      }));
      const bgLayer = document.getElementById('audience-bg-layer');
      if (bgLayer && bgLayer.parentNode !== view) view.appendChild(bgLayer);

      const type = ['fade', 'dissolve', 'cut'].includes(transitionType) ? transitionType : 'fade';
      nextLayer.style.zIndex = '20';

      if (type === 'cut' || !oldLayers.length) {
        nextLayer.style.opacity = '1';
        view.appendChild(nextLayer);
        oldLayers.forEach(layer => layer.remove());
        return;
      }

      const duration = type === 'dissolve' ? 700 : 450;
      nextLayer.style.opacity = '0';
      nextLayer.style.transition = `opacity ${duration}ms ease-in-out, filter ${duration}ms ease-in-out`;
      if (type === 'dissolve') nextLayer.style.filter = 'blur(5px)';
      view.appendChild(nextLayer);

      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (token !== audienceTransitionToken) { nextLayer.remove(); return; }
      nextLayer.style.opacity = '1';
      nextLayer.style.filter = 'blur(0px)';
      oldLayers.forEach(layer => {
        layer.style.zIndex = '10';
        layer.style.transition = `opacity ${duration}ms ease-in-out`;
        layer.style.opacity = '0';
      });
      setTimeout(() => {
        if (token !== audienceTransitionToken) return;
        oldLayers.forEach(layer => layer.remove());
        nextLayer.style.transition = '';
        nextLayer.style.filter = '';
      }, duration + 80);
    }

    channel.onmessage = async (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.command === 'TRIGGER_LIVE_FADE') {
        lastIncoming = msg.payload;
        if (!document.body.classList.contains('live-window-mode')) {
          liveState = clonePresenterPayload(msg.payload);
          renderLiveView();
          setSlideStatus();
        }
        if (document.body.classList.contains('live-window-mode')) {
          await performAudienceTransition(msg.payload, msg.transitionType);
        }
      }

      if (msg.command === 'TOGGLE_FTB_STATE') {
        const view = document.getElementById('audience-view');
        if (view) {
          if (msg.active) view.classList.add('ftb-active');
          else view.classList.remove('ftb-active');
        }
        if (!document.body.classList.contains('live-window-mode')) {
          isFTBActive = msg.active;
          updateLiveMonitorOverlays();
        }
      }

      if (msg.command === 'TOGGLE_FTG_STATE') {
        const bgLayer = document.getElementById('audience-bg-layer');
        if (bgLayer) {
          if (msg.active) bgLayer.classList.add('active');
          else bgLayer.classList.remove('active');
        }
        if (!document.body.classList.contains('live-window-mode')) {
          isFTGActive = msg.active;
          updateLiveMonitorOverlays();
        }
      }

      if (msg.command === 'UPDATE_BACKGROUND_SOURCE') {
        const bgLayer = document.getElementById('audience-bg-layer');
        if (bgLayer) {
          if (msg.value) {
            bgLayer.innerHTML = `<img src="${msg.value}" alt="Background View" />`;
          } else {
            bgLayer.innerHTML = '';
          }
        }
        if (!document.body.classList.contains('live-window-mode')) {
          currentBackgroundSource = msg.value || '';
          updateLiveMonitorOverlays();
        }
      }

      if (msg.command === 'SYNC_VIDEO_STATE') {
        if (document.body.classList.contains('live-window-mode')) {
          const liveVid = document.getElementById('audience-live-video');
          if (liveVid) {
            if (Math.abs(liveVid.currentTime - msg.time) > 0.5) liveVid.currentTime = msg.time;
            if (msg.playing && liveVid.paused) liveVid.play();
            if (!msg.playing && !liveVid.paused) liveVid.pause();
          }
        }
      }

      if (msg.command === 'UPDATE_LIVE_PDF_PAGE') {
        lastIncoming = msg.payload;
        if (document.body.classList.contains('live-window-mode')) {
          await performAudienceTransition(msg.payload, 'fade');
        } else {
          liveState = JSON.parse(JSON.stringify(msg.payload));
          await renderLiveView();
        }
      }

      if (msg.command === 'UPDATE_MIRROR_LENS_FRAME') {
        if (document.body.classList.contains('live-window-mode')) {
          const targetView = document.getElementById('audience-view');
          if (targetView) {
            let mirrorImg = document.getElementById('audience-precision-lens-frame');
            if (!mirrorImg) {
              const bgLayer = document.getElementById('audience-bg-layer');
              targetView.innerHTML = ''; 
              if (bgLayer) targetView.appendChild(bgLayer);
              
              mirrorImg = document.createElement('img');
              mirrorImg.id = 'audience-precision-lens-frame';
              mirrorImg.style.width = '100%'; mirrorImg.style.height = '100%'; mirrorImg.style.objectFit = 'contain';
              targetView.appendChild(mirrorImg);
            }
            mirrorImg.src = msg.frame;
          }
        }
      }

      if (msg.command === 'CLEAR_MIRROR_LENS') {
        if (document.body.classList.contains('live-window-mode') && lastIncoming) renderAudience(lastIncoming);
      }

      if (msg.command === 'CLOSE_DISPLAY') {
        const view = document.getElementById('audience-view');
        if (view) {
          view.classList.add('fade-transition', 'fade-out-active');
          setTimeout(() => { 
            const bgLayer = document.getElementById('audience-bg-layer');
            view.innerHTML = ''; 
            if (bgLayer) view.appendChild(bgLayer);
          }, 600);
        }
      }

      if (msg.command === 'REQUEST_CURRENT_OUTPUT') {
        if (lastIncoming) channel.postMessage({ command: 'TRIGGER_LIVE_FADE', payload: lastIncoming, transitionType: 'cut' });
        else if (staged.type !== 'none') channel.postMessage({ command: 'TRIGGER_LIVE_FADE', payload: staged, transitionType: 'cut' });
        
        channel.postMessage({ command: 'TOGGLE_FTB_STATE', active: isFTBActive });
        channel.postMessage({ command: 'TOGGLE_FTG_STATE', active: isFTGActive });
        const savedBg = localStorage.getItem(LS_BG_TARGET);
        if (savedBg && discoveredWorkspaceImages[savedBg]) {
          currentBackgroundSource = discoveredWorkspaceImages[savedBg];
          updateLiveMonitorOverlays();
          channel.postMessage({ command: 'UPDATE_BACKGROUND_SOURCE', value: discoveredWorkspaceImages[savedBg] });
        }
      }
    };

    function getStoredSelectedMonitor() {
      try { return JSON.parse(localStorage.getItem(LS_SELECTED_MONITOR) || 'null'); }
      catch (e) { return null; }
    }

    function monitorIdentity(screen, index) {
      return {
        index,
        label: screen.label || `Display ${index + 1}`,
        left: Number(screen.availLeft ?? screen.left ?? 0),
        top: Number(screen.availTop ?? screen.top ?? 0),
        width: Number(screen.availWidth ?? screen.width ?? 1280),
        height: Number(screen.availHeight ?? screen.height ?? 720),
        isPrimary: Boolean(screen.isPrimary),
        isInternal: Boolean(screen.isInternal),
        devicePixelRatio: Number(screen.devicePixelRatio || 1)
      };
    }

    function renderMonitorChoices() {
      const list = document.getElementById('monitor-list');
      const useBtn = document.getElementById('monitor-use-btn');
      if (!list) return;
      list.innerHTML = '';
      availableDisplayScreens.forEach((screen, index) => {
        const info = monitorIdentity(screen, index);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'monitor-choice' + (index === pendingMonitorIndex ? ' active' : '');
        const badges = [info.isPrimary ? 'Primary' : 'Secondary', info.isInternal ? 'Internal' : 'External'].join(' · ');
        btn.innerHTML = `
          <span class="monitor-choice-icon">${info.isPrimary ? '💻' : '🖥️'}</span>
          <span class="monitor-choice-info">
            <span class="monitor-choice-name">${escapeHtml(info.label)}</span>
            <span class="monitor-choice-meta">${info.width} × ${info.height} · Position ${info.left}, ${info.top} · Scale ${info.devicePixelRatio}</span>
          </span>
          <span class="monitor-choice-badge">${escapeHtml(badges)}</span>`;
        btn.onclick = () => {
          pendingMonitorIndex = index;
          renderMonitorChoices();
        };
        list.appendChild(btn);
      });
      if (useBtn) useBtn.disabled = pendingMonitorIndex < 0 || !availableDisplayScreens[pendingMonitorIndex];
    }

    async function detectSecondaryMonitors() {
      const modal = document.getElementById('monitor-selection-modal');
      const status = document.getElementById('monitor-modal-status');
      const list = document.getElementById('monitor-list');
      if (modal) modal.classList.add('open');
      if (list) list.innerHTML = '';
      if (status) status.textContent = 'Requesting permission and scanning connected displays...';

      if (!('getScreenDetails' in window)) {
        availableDisplayScreens = [];
        pendingMonitorIndex = -1;
        if (status) status.innerHTML = 'This browser does not support automatic monitor detection. Use a current Chromium-based browser over HTTPS or localhost, or move the display window manually.';
        return;
      }

      try {
        const details = await window.getScreenDetails();
        availableDisplayScreens = Array.from(details.screens || []);
        const stored = getStoredSelectedMonitor();
        let matchedIndex = -1;
        if (stored) {
          matchedIndex = availableDisplayScreens.findIndex((screen, index) => {
            const info = monitorIdentity(screen, index);
            return info.left === stored.left && info.top === stored.top && info.width === stored.width && info.height === stored.height;
          });
        }
        if (matchedIndex < 0) matchedIndex = availableDisplayScreens.findIndex(screen => !screen.isPrimary);
        if (matchedIndex < 0 && availableDisplayScreens.length) matchedIndex = 0;
        pendingMonitorIndex = matchedIndex;
        renderMonitorChoices();
        const secondaryCount = availableDisplayScreens.filter(screen => !screen.isPrimary).length;
        if (status) status.textContent = `${availableDisplayScreens.length} display${availableDisplayScreens.length === 1 ? '' : 's'} detected. ${secondaryCount ? secondaryCount + ' secondary monitor' + (secondaryCount === 1 ? '' : 's') + ' available.' : 'No separate secondary monitor was reported.'}`;
      } catch (error) {
        availableDisplayScreens = [];
        pendingMonitorIndex = -1;
        if (status) status.textContent = 'Monitor detection was not allowed or failed: ' + (error && error.message ? error.message : 'permission denied');
      }
    }

    function closeMonitorSelectionModal() {
      const modal = document.getElementById('monitor-selection-modal');
      if (modal) modal.classList.remove('open');
    }

    function confirmSelectedMonitor() {
      const screen = availableDisplayScreens[pendingMonitorIndex];
      if (!screen) return;
      selectedMonitor = monitorIdentity(screen, pendingMonitorIndex);
      localStorage.setItem(LS_SELECTED_MONITOR, JSON.stringify(selectedMonitor));
      try { window.dispatchEvent(new CustomEvent('jil-selected-monitor-changed', { detail: selectedMonitor })); } catch (_) {}
      try { if (typeof window.syncOnlyOfficeAudienceMonitor === 'function') window.syncOnlyOfficeAudienceMonitor(selectedMonitor); } catch (_) {}
      updateSelectedMonitorButton();
      closeMonitorSelectionModal();
      showModal('Display Monitor Selected', `${selectedMonitor.label} (${selectedMonitor.width} × ${selectedMonitor.height}) will be used when you open the display screen.`, false);
    }

    function updateSelectedMonitorButton() {
      const btn = document.getElementById('monitor-detect-btn');
      if (!btn) return;
      selectedMonitor = selectedMonitor || getStoredSelectedMonitor();
      if (selectedMonitor) {
        btn.textContent = '🖥️ ' + (selectedMonitor.label || 'Monitor Selected');
        btn.title = `Selected: ${selectedMonitor.label || 'Display'} — ${selectedMonitor.width} × ${selectedMonitor.height}`;
        btn.classList.add('selected');
      } else {
        btn.textContent = '🖥️ Detect Monitor';
        btn.title = 'Detect and choose a secondary monitor';
        btn.classList.remove('selected');
      }
    }

    async function openDisplayWindow() {
      const base = window.location.href.split('?')[0];
      selectedMonitor = selectedMonitor || getStoredSelectedMonitor();
      const target = selectedMonitor;
      const width = target ? Math.max(640, target.width) : 1280;
      const height = target ? Math.max(480, target.height) : 720;
      const left = target ? target.left : (window.screenX + window.outerWidth);
      const top = target ? target.top : 0;
      const features = `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
      displayWindow = window.open(base + '?display=true', 'ProjectorOutputWindow', features);
      if (!displayWindow) {
        showModal('Display Window Blocked', 'Please allow popups, then click Open Display Screen again.', false);
        return;
      }
      try {
        displayWindow.moveTo(left, top);
        displayWindow.resizeTo(width, height);
        displayWindow.focus();
      } catch (e) {}
      if (!target) {
        showModal('No Monitor Selected', 'The display window was opened using the browser default position. Use Detect Monitor to choose a secondary display automatically.', false);
      }
      updateDisplayToggleButton();
      if (displayWindow) displayWindow.addEventListener('beforeunload', () => { displayWindow = null; updateDisplayToggleButton(); });
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'F11') {
        e.preventDefault();
        enterFullscreen();
        const hint = document.getElementById('fs-hint-overlay');
        if(hint) hint.remove();
      }

      if (e.key === 'Enter') {
        const el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
        e.preventDefault(); fireLive();
      }
    });



    const BIBLE_BOOKS_ENGLISH = [
      'Genesis','Exodus','Leviticus','Numbers','Deuteronomy','Joshua','Judges','Ruth','1 Samuel','2 Samuel','1 Kings','2 Kings','1 Chronicles','2 Chronicles','Ezra','Nehemiah','Esther','Job','Psalms','Proverbs','Ecclesiastes','Song of Solomon','Isaiah','Jeremiah','Lamentations','Ezekiel','Daniel','Hosea','Joel','Amos','Obadiah','Jonah','Micah','Nahum','Habakkuk','Zephaniah','Haggai','Zechariah','Malachi','Matthew','Mark','Luke','John','Acts','Romans','1 Corinthians','2 Corinthians','Galatians','Ephesians','Philippians','Colossians','1 Thessalonians','2 Thessalonians','1 Timothy','2 Timothy','Titus','Philemon','Hebrews','James','1 Peter','2 Peter','1 John','2 John','3 John','Jude','Revelation'
    ];

    let bibleSuggestionItems = [];
    let bibleSuggestionIndex = -1;

    function getActiveBibleEntries() {
      const bible = activeBibleKey && bibleLibraries[activeBibleKey] ? bibleLibraries[activeBibleKey] : null;
      return bible && Array.isArray(bible.entries) ? bible.entries : [];
    }

    function normalizeBibleSearchQuery(input) {
      const trimmed = String(input || '').trim().replace(/\s+/g, ' ');
      if (!trimmed) return null;

      const match = trimmed.match(/^(.+?)\s+(\d+)\s*[:.]\s*(\d+)(?:\s*[-–—]\s*(\d+))?$/i);
      if (!match) return null;

      return {
        book: match[1].trim(),
        chapter: parseInt(match[2], 10),
        verse: parseInt(match[3], 10),
        endVerse: match[4] ? parseInt(match[4], 10) : null
      };
    }

    function sqlUnescape(value) {
      return String(value || '').replace(/''/g, "'").replace(/\\'/g, "'").replace(/\\"/g, '"').trim();
    }

    function splitSqlTuple(tupleText) {
      const values = [];
      let current = '';
      let quote = '';
      for (let i = 0; i < tupleText.length; i += 1) {
        const ch = tupleText[i];
        const next = tupleText[i + 1];
        if (quote) {
          if (ch === quote && next === quote) { current += ch; i += 1; continue; }
          if (ch === quote) { quote = ''; continue; }
          current += ch;
          continue;
        }
        if (ch === "'" || ch === '"') { quote = ch; continue; }
        if (ch === ',') { values.push(current.trim()); current = ''; continue; }
        current += ch;
      }
      values.push(current.trim());
      return values.map(v => sqlUnescape(v.replace(/^NULL$/i, '')));
    }

    function extractSqlTuples(sqlText) {
      const tuples = [];
      const insertPattern = /INSERT\s+(?:OR\s+IGNORE\s+)?INTO[\s\S]*?VALUES\s*/gi;
      let match;
      while ((match = insertPattern.exec(sqlText))) {
        let i = insertPattern.lastIndex;
        let depth = 0;
        let quote = '';
        let start = -1;
        for (; i < sqlText.length; i += 1) {
          const ch = sqlText[i];
          const next = sqlText[i + 1];
          if (quote) {
            if (ch === quote && next === quote) { i += 1; continue; }
            if (ch === quote) quote = '';
            continue;
          }
          if (ch === "'" || ch === '"') { quote = ch; continue; }
          if (ch === '(') {
            if (depth === 0) start = i + 1;
            depth += 1;
            continue;
          }
          if (ch === ')') {
            depth -= 1;
            if (depth === 0 && start >= 0) tuples.push(sqlText.slice(start, i));
            continue;
          }
          if (ch === ';' && depth === 0) break;
        }
        insertPattern.lastIndex = i;
      }
      return tuples;
    }

    function parseBibleSql(sqlText, sourceLabel) {
      const entries = [];
      const seen = new Set();
      const addEntry = (book, chapter, verse, text) => {
        let bookName = book;
        if (/^\d+$/.test(String(bookName).trim())) {
          const bookIndex = parseInt(bookName, 10);
          bookName = BIBLE_BOOKS_ENGLISH[bookIndex - 1] || bookName;
        }
        const chapterNum = parseInt(String(chapter).replace(/[^0-9]/g, ''), 10);
        const verseNum = parseInt(String(verse).replace(/[^0-9]/g, ''), 10);
        const verseText = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!bookName || !Number.isFinite(chapterNum) || !Number.isFinite(verseNum) || !verseText) return;
        const normalizedKey = `${normalizeBibleBookName(bookName)}|${chapterNum}|${verseNum}`;
        if (seen.has(normalizedKey)) return;
        seen.add(normalizedKey);
        entries.push({ book: String(bookName).trim(), chapter: chapterNum, verse: verseNum, text: verseText, reference: buildBibleReference(String(bookName).trim(), chapterNum, verseNum), sourceLabel });
      };

      extractSqlTuples(sqlText).forEach(tuple => {
        const cols = splitSqlTuple(tuple);
        if (cols.length < 4) return;
        const textIndex = cols.findIndex(v => /[A-Za-zÀ-ž]{3,}/.test(v) && String(v).length > 8);
        if (textIndex < 0) return;
        const numeric = cols.map((v, idx) => ({ v, idx })).filter(x => /^\d+$/.test(String(x.v).trim()));
        if (numeric.length >= 3) {
          const verse = numeric[numeric.length - 1].v;
          const chapter = numeric[numeric.length - 2].v;
          const bookCandidate = numeric[numeric.length - 3].v;
          const bookTextCandidate = cols.find((v, idx) => idx !== textIndex && /[A-Za-zÀ-ž]{2,}/.test(v) && String(v).length < 40);
          addEntry(bookTextCandidate || bookCandidate, chapter, verse, cols[textIndex]);
        } else if (numeric.length >= 2) {
          const bookTextCandidate = cols.find((v, idx) => idx !== textIndex && /[A-Za-zÀ-ž]{2,}/.test(v) && String(v).length < 40);
          if (bookTextCandidate) addEntry(bookTextCandidate, numeric[0].v, numeric[1].v, cols[textIndex]);
        }
      });

      if (!entries.length) {
        const fallbackPattern = /(['"]?)([A-Za-zÀ-ž0-9 .,'-]+)\1\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*(['"])([\s\S]*?)\5/gi;
        let match;
        while ((match = fallbackPattern.exec(sqlText))) addEntry(match[2], match[3], match[4], match[6]);
      }
      return entries;
    }

    function parseBibleJson(jsonText, sourceLabel) {
      const entries = [];
      const seen = new Set();

      const normalizeBookValue = (book) => {
        let bookName = String(book || '').trim();
        if (/^\d+$/.test(bookName)) {
          const bookIndex = parseInt(bookName, 10);
          bookName = BIBLE_BOOKS_ENGLISH[bookIndex - 1] || bookName;
        }
        return bookName;
      };

      const addEntry = (book, chapter, verse, text) => {
        const bookName = normalizeBookValue(book);
        const chapterNum = parseInt(String(chapter).replace(/[^0-9]/g, ''), 10);
        const verseNum = parseInt(String(verse).replace(/[^0-9]/g, ''), 10);
        const verseText = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!bookName || !Number.isFinite(chapterNum) || !Number.isFinite(verseNum) || !verseText) return;
        const normalizedKey = `${normalizeBibleBookName(bookName)}|${chapterNum}|${verseNum}`;
        if (seen.has(normalizedKey)) return;
        seen.add(normalizedKey);
        entries.push({
          book: bookName,
          chapter: chapterNum,
          verse: verseNum,
          text: verseText,
          reference: buildBibleReference(bookName, chapterNum, verseNum),
          sourceLabel
        });
      };

      const getTextValue = (value) => {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string' || typeof value === 'number') return String(value);
        if (typeof value !== 'object') return '';
        return value.text || value.content || value.verseText || value.versetext || value.scripture || value.message || value.value || '';
      };

      const readChapterObject = (chapterObj, ctx = {}) => {
        if (!chapterObj || typeof chapterObj !== 'object') return false;
        const book = chapterObj.book || chapterObj.bookName || chapterObj.bookname || ctx.book;
        const chapter = chapterObj.chapter || chapterObj.ch || chapterObj.chap || chapterObj.chapterNumber || chapterObj.number || ctx.chapter;
        const verses = chapterObj.verses || chapterObj.verseList || chapterObj.children || chapterObj.items;
        let added = false;

        if (book && chapter && Array.isArray(verses)) {
          verses.forEach((verseObj, idx) => {
            if (verseObj && typeof verseObj === 'object') {
              const verse = verseObj.verse || verseObj.verseNumber || verseObj.verseNum || verseObj.number || verseObj.v || String(idx + 1);
              const text = getTextValue(verseObj);
              const before = entries.length;
              addEntry(book, chapter, verse, text);
              if (entries.length > before) added = true;
            } else {
              const before = entries.length;
              addEntry(book, chapter, idx + 1, verseObj);
              if (entries.length > before) added = true;
            }
          });
        } else if (book && chapter && verses && typeof verses === 'object') {
          Object.keys(verses).forEach((verseKey) => {
            const before = entries.length;
            addEntry(book, chapter, verseKey, getTextValue(verses[verseKey]));
            if (entries.length > before) added = true;
          });
        }
        return added;
      };

      const walk = (value, ctx = {}, parentKey = '') => {
        if (value === null || value === undefined) return;
        if (typeof value === 'string' || typeof value === 'number') {
          if (ctx.book && ctx.chapter && ctx.verse) addEntry(ctx.book, ctx.chapter, ctx.verse, value);
          return;
        }
        if (Array.isArray(value)) {
          value.forEach((item, idx) => {
            const nextCtx = { ...ctx };
            if (/^chapters?$/i.test(parentKey) && !nextCtx.chapter) nextCtx.chapter = String(idx + 1);
            if (/^verses?$/i.test(parentKey) && !nextCtx.verse) nextCtx.verse = String(idx + 1);
            walk(item, nextCtx, parentKey);
          });
          return;
        }
        if (typeof value !== 'object') return;

        const ctxBook = value.book || value.bibleBook || value.bookName || value.bookname || value.name || value.title || ctx.book;
        const ctxChapter = value.chapter || value.ch || value.chap || value.chapterNumber || ctx.chapter;
        const ctxVerse = value.verse || value.verseNumber || value.verseNum || value.number || value.versenum || value.v || ctx.verse;
        const textValue = getTextValue(value);

        if (ctxBook && ctxChapter !== undefined && ctxVerse !== undefined && textValue) addEntry(ctxBook, ctxChapter, ctxVerse, textValue);
        readChapterObject(value, { book: ctxBook, chapter: ctxChapter });

        Object.keys(value).forEach((key) => {
          const child = value[key];
          const normalizedKey = String(key).toLowerCase();
          if (['text','content','versetext','scripture','message','value'].includes(normalizedKey)) return;

          const nextCtx = { book: ctxBook, chapter: ctxChapter, verse: ctxVerse };
          if (normalizedKey === 'chapters' || normalizedKey === 'chapterlist') {
            walk(child, { book: ctxBook }, key);
            return;
          }
          if (normalizedKey === 'verses' || normalizedKey === 'verselist') {
            walk(child, { book: ctxBook, chapter: ctxChapter }, key);
            return;
          }

          const keyText = String(key).trim();
          const keyHasLetters = /[A-Za-zÀ-ž]/.test(keyText);
          const keyNumber = keyText.match(/\d+/);
          if (!nextCtx.book && keyHasLetters && !['book','biblebook','bookname','name','title'].includes(normalizedKey)) nextCtx.book = keyText;
          else if (nextCtx.book && !nextCtx.chapter && keyNumber) nextCtx.chapter = keyNumber[0];
          else if (nextCtx.book && nextCtx.chapter && !nextCtx.verse && keyNumber) nextCtx.verse = keyNumber[0];
          walk(child, nextCtx, key);
        });
      };

      try {
        const data = JSON.parse(jsonText);
        walk(data, {});
      } catch (e) {}
      return entries;
    }

    function parseBibleXml(xmlText, sourceLabel) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) return [];
      const entries = [];
      const seen = new Set();
      const addEntry = (book, chapter, verse, text) => {
        const chapterNum = parseInt(String(chapter).replace(/[^0-9]/g, ''), 10);
        const verseNum = parseInt(String(verse).replace(/[^0-9]/g, ''), 10);
        const verseText = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (!book || !Number.isFinite(chapterNum) || !Number.isFinite(verseNum) || !verseText) return;
        const normalizedKey = `${normalizeBibleBookName(book)}|${chapterNum}|${verseNum}`;
        if (seen.has(normalizedKey)) return;
        seen.add(normalizedKey);
        entries.push({ book: String(book).trim(), chapter: chapterNum, verse: verseNum, text: verseText, reference: buildBibleReference(String(book).trim(), chapterNum, verseNum), sourceLabel });
      };
      const walk = (node, currentBook = '', currentChapter = '') => {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = (node.tagName || '').toLowerCase();
        const attrs = {};
        Array.from(node.attributes || []).forEach(attr => attrs[attr.name.toLowerCase()] = attr.value);
        let book = currentBook;
        let chapter = currentChapter;
        if (['book','biblebook','osisbook','bookofbible','b'].includes(tag)) book = attrs.book || attrs.name || attrs.osisid || attrs.id || attrs.bookname || attrs.bname || attrs.n || book;
        if (['chapter','chap','c'].includes(tag)) chapter = attrs.chapter || attrs.ch || attrs.number || attrs.n || attrs.cnumber || attrs.chapternum || attrs.value || chapter;
        const verseValue = attrs.verse || attrs.v || attrs.number || attrs.n || attrs.vnumber || attrs.versenum || attrs.value;
        if ((['verse','v'].includes(tag) || /verse/i.test(tag)) && book && chapter && verseValue) {
          addEntry(book, chapter, verseValue, node.textContent);
        }
        Array.from(node.children).forEach(child => walk(child, book, chapter));
      };
      walk(doc.documentElement);
      return entries;
    }

    function isSupportedBibleFile(fileName) {
      const lowerName = String(fileName || '').toLowerCase();
      return lowerName.endsWith('.xml') || lowerName.endsWith('.json') || lowerName.endsWith('.sql') || lowerName.endsWith('.txt') || lowerName.endsWith('.csv');
    }

    function makeBibleLibraryKey(fileName) {
      const baseName = String(fileName || '')
        .replace(/\.(xml|json|sql|txt|csv)$/i, '')
        .trim()
        .replace(/[^a-z0-9]+/gi, '_')
        .replace(/^_+|_+$/g, '') || 'imported_bible';
      let key = baseName.toLowerCase();
      let suffix = 2;
      while (bibleLibraries[key]) key = `${baseName.toLowerCase()}_${suffix++}`;
      return key;
    }

    async function parseBibleFile(file) {
      const lowerName = String(file && file.name ? file.name : '').toLowerCase();
      const sourceLabel = file.name.replace(/\.(xml|json|sql|txt|csv)$/i, '');
      const text = await file.text();
      if (lowerName.endsWith('.xml')) return parseBibleXml(text, sourceLabel);
      if (lowerName.endsWith('.json')) return parseBibleJson(text, sourceLabel);
      if (lowerName.endsWith('.sql')) return parseBibleSql(text, sourceLabel);
      return parseBiblePlainText(text, sourceLabel);
    }

    function parseBiblePlainText(text, sourceLabel) {
      const entries = [];
      const seen = new Set();
      const addEntry = (book, chapter, verse, verseText) => {
        const chapterNum = parseInt(chapter, 10);
        const verseNum = parseInt(verse, 10);
        const cleanText = String(verseText || '').replace(/\s+/g, ' ').trim();
        if (!book || !Number.isFinite(chapterNum) || !Number.isFinite(verseNum) || !cleanText) return;
        const normalizedKey = `${normalizeBibleBookName(book)}|${chapterNum}|${verseNum}`;
        if (seen.has(normalizedKey)) return;
        seen.add(normalizedKey);
        entries.push({ book, chapter: chapterNum, verse: verseNum, text: cleanText, reference: buildBibleReference(book, chapterNum, verseNum), sourceLabel });
      };
      String(text || '').split(/\r?\n/).forEach(line => {
        const direct = line.trim().match(/^(.+?)\s+(\d+)\s*[:.]\s*(\d+)\s+(.+)$/);
        if (direct) addEntry(direct[1].trim(), direct[2], direct[3], direct[4]);
        const csv = line.match(/^"?([^",]+)"?,\s*(\d+),\s*(\d+),\s*"?(.+?)"?$/);
        if (csv) addEntry(csv[1].trim(), csv[2], csv[3], csv[4]);
      });
      return entries;
    }

    function chooseBibleFolderFiles() {
      const folderInput = document.getElementById('bible-folder-uploader');
      if (folderInput) folderInput.click();
    }

    function getPendingBibleImportFiles() {
      const fileInput = document.getElementById('bible-file-uploader');
      const folderInput = document.getElementById('bible-folder-uploader');
      const allFiles = [];
      if (fileInput && fileInput.files) allFiles.push(...Array.from(fileInput.files));
      if (folderInput && folderInput.files) allFiles.push(...Array.from(folderInput.files));

      const unique = [];
      const seen = new Set();
      allFiles.forEach((file) => {
        const path = file.webkitRelativePath || file.name || '';
        const key = `${path}|${file.size}|${file.lastModified}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(file);
        }
      });
      return unique;
    }

    function updateBiblePendingFileStatus() {
      const status = document.getElementById('bible-pending-file-status');
      if (!status) return;
      const files = getPendingBibleImportFiles();
      const supported = files.filter(file => isSupportedBibleFile(file.name));
      const folderCount = supported.filter(file => file.webkitRelativePath).length;
      if (!files.length) {
        status.textContent = '';
        showBibleLibraryFlash('', false, true);
        return;
      }
      const sampleNames = supported.slice(0, 3).map(file => file.webkitRelativePath || file.name).join(', ');
      const msg = `Bible import: ${supported.length} supported file${supported.length === 1 ? '' : 's'} ready${folderCount ? ' from folder upload' : ''}. ${sampleNames ? 'Example: ' + sampleNames : ''}`;
      status.textContent = msg;
      showBibleLibraryFlash(msg, false, false);
    }

    async function importBibleFiles() {
      const input = document.getElementById('bible-file-uploader');
      const folderInput = document.getElementById('bible-folder-uploader');
      const files = getPendingBibleImportFiles();
      if (!files.length) {
        renderBibleSearchResult('Choose Bible files or a Bible folder first, then click Accept.');
        updateBiblePendingFileStatus();
        return;
      }

      const supportedFiles = files.filter(file => isSupportedBibleFile(file.name));
      if (!supportedFiles.length) {
        renderBibleSearchResult('No supported Bible files found in the selected folder. Use JSON, XML, SQL, TXT, or CSV.');
        updateBiblePendingFileStatus();
        return;
      }

      let importedCount = 0;
      const skipped = [];
      const folderGroups = {};
      const singleFiles = [];

      supportedFiles.forEach((file) => {
        const relativePath = file.webkitRelativePath || '';
        if (relativePath && relativePath.includes('/')) {
          const folderName = relativePath.split('/')[0] || 'Folder Bible';
          if (!folderGroups[folderName]) folderGroups[folderName] = [];
          folderGroups[folderName].push(file);
        } else {
          singleFiles.push(file);
        }
      });

      const saveMergedLibrary = async (label, entries) => {
        const fixedEntries = fixBibleEntryBookNames ? fixBibleEntryBookNames(entries) : entries;
        if (!fixedEntries.length) return { imported: false, reason: 'no readable verses' };
        const key = makeBibleLibraryKey(label + '.json');
        bibleLibraries[key] = { key, label, entries: fixedEntries };
        await saveBibleLibraryToDB(key, bibleLibraries[key]);
        if (!activeBibleKey) activeBibleKey = key;
        if (typeof saveBibleLibraryToFirebase === 'function') {
          try {
            setBibleFirebaseStatus('Firebase: saving Bible folder only...');
            const cloudResult = await saveBibleLibraryToFirebase(key, bibleLibraries[key]);
            setBibleFirebaseStatus('Firebase: saved Bible folder only (' + (cloudResult.verseCount || fixedEntries.length) + ' verses).');
          } catch (error) {
            setBibleFirebaseStatus('Firebase: Bible folder cloud save failed - ' + (error && error.message ? error.message : 'cloud save failed'), true);
          }
        }
        return { imported: true, key, label };
      };

      for (const folderName of Object.keys(folderGroups)) {
        const groupFiles = folderGroups[folderName].sort((a, b) => String(a.webkitRelativePath || a.name).localeCompare(String(b.webkitRelativePath || b.name), undefined, { numeric: true }));
        const mergedEntries = [];
        for (const file of groupFiles) {
          try {
            const parsed = await parseBibleFile(file);
            if (parsed && parsed.length) mergedEntries.push(...parsed);
            else skipped.push(`${file.webkitRelativePath || file.name}: no readable verses`);
          } catch (error) {
            skipped.push(`${file.webkitRelativePath || file.name}: ${error && error.message ? error.message : 'read failed'}`);
          }
        }
        const result = await saveMergedLibrary(folderName, mergedEntries);
        if (result.imported) importedCount += 1;
        else skipped.push(`${folderName}: ${result.reason || 'skipped'}`);
      }

      for (const file of singleFiles) {
        const result = await importBibleFileObject(file);
        if (result.imported) importedCount += 1;
        else skipped.push(`${file.name}: ${result.reason || 'skipped'}`);
      }

      populateBibleLibrarySelector();
      renderBibleSearchResult(importedCount ? '' : (skipped[0] || 'No readable Bible content was found.'));
      updateBibleSuggestions();
      if (importedCount) showModal('Bible Import Complete', `Imported ${importedCount} Bible librar${importedCount === 1 ? 'y' : 'ies'}. ${Object.keys(folderGroups).length ? 'Folder files were merged into folder Bible libraries. ' : ''}${skipped.length ? 'Skipped: ' + skipped.slice(0, 3).join('; ') : ''}`, false);
      if (input) input.value = '';
      if (folderInput) folderInput.value = '';
      updateBiblePendingFileStatus();
    }

    function setActiveBibleLibrary(key) {
      activeBibleKey = key;
      currentBibleSearchResult = null;
      renderBibleSearchResult();
      updateBibleSuggestions();
    }

    function getReferencePartsForLooseQuery(raw) {
      const query = String(raw || '').trim().replace(/\s+/g, ' ');
      if (!query) return null;
      const full = query.match(/^(.+?)\s+(\d+)\s*[:.]\s*(\d+)(?:\s*[-–—]\s*(\d+))?$/i);
      if (full) return { book: full[1].trim(), chapter: parseInt(full[2], 10), verse: parseInt(full[3], 10), endVerse: full[4] ? parseInt(full[4], 10) : null };
      const chapterOnly = query.match(/^(.+?)\s+(\d+)$/i);
      if (chapterOnly) return { book: chapterOnly[1].trim(), chapter: parseInt(chapterOnly[2], 10), verse: null, endVerse: null };
      return null;
    }

    function buildBibleSuggestions(query) {
      const entries = getActiveBibleEntries();
      if (!entries.length) return [];
      const raw = String(query || '').trim().replace(/\s+/g, ' ');
      if (!raw) return [];

      const normalizedRaw = normalizeBibleBookName(raw);
      const refParts = getReferencePartsForLooseQuery(raw);
      const seen = new Set();
      const suggestions = [];
      const addSuggestion = (label, value, entry) => {
        const key = value + '|' + label;
        if (seen.has(key)) return;
        seen.add(key);
        suggestions.push({ label, value, entry });
      };

      if (refParts && refParts.book && refParts.chapter && refParts.verse !== null) {
        entries
          .filter(entry => normalizeBibleBookName(entry.book).includes(normalizeBibleBookName(refParts.book)) && entry.chapter === refParts.chapter && String(entry.verse).startsWith(String(refParts.verse)))
          .slice(0, 20)
          .forEach(entry => addSuggestion(`${entry.reference} — ${entry.text.slice(0, 90)}`, entry.reference, entry));
        return suggestions;
      }

      if (refParts && refParts.book && refParts.chapter) {
        entries
          .filter(entry => normalizeBibleBookName(entry.book).includes(normalizeBibleBookName(refParts.book)) && entry.chapter === refParts.chapter)
          .slice(0, 30)
          .forEach(entry => addSuggestion(`${entry.reference} — ${entry.text.slice(0, 90)}`, entry.reference, entry));
        return suggestions;
      }

      const books = Array.from(new Set(entries.map(entry => entry.book))).sort((a, b) => a.localeCompare(b));
      books
        .filter(book => normalizeBibleBookName(book).includes(normalizedRaw))
        .slice(0, 8)
        .forEach(book => addSuggestion(book, `${book} `, null));

      entries
        .filter(entry => {
          const refText = `${entry.book} ${entry.chapter}:${entry.verse}`.toLowerCase();
          const verseText = String(entry.text || '').toLowerCase();
          const q = raw.toLowerCase();
          return refText.includes(q) || verseText.includes(q);
        })
        .slice(0, 20)
        .forEach(entry => addSuggestion(`${entry.reference} — ${entry.text.slice(0, 90)}`, entry.reference, entry));

      return suggestions.slice(0, 25);
    }

    function updateBibleSuggestions() {
      const input = document.getElementById('bible-search-input');
      const box = document.getElementById('bible-suggestions');
      if (!input || !box) return;
      bibleSuggestionItems = buildBibleSuggestions(input.value);
      bibleSuggestionIndex = -1;
      if (!bibleSuggestionItems.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.innerHTML = bibleSuggestionItems.map((item, idx) => `<button type="button" class="bible-suggestion-item" data-index="${idx}">${escapeHtml(item.label)}</button>`).join('');
      box.style.display = 'block';
      Array.from(box.querySelectorAll('.bible-suggestion-item')).forEach(btn => {
        btn.onclick = () => selectBibleSuggestion(parseInt(btn.getAttribute('data-index'), 10));
      });
    }

    function selectBibleSuggestion(index) {
      const item = bibleSuggestionItems[index];
      const input = document.getElementById('bible-search-input');
      const box = document.getElementById('bible-suggestions');
      if (!item || !input) return;
      input.value = item.value;
      if (box) { box.style.display = 'none'; box.innerHTML = ''; }
      if (item.entry || /\d+\s*[:.]\s*\d+/.test(item.value)) searchBibleVerse();
      else { input.focus(); updateBibleSuggestions(); }
    }

    function handleBibleSearchKeydown(event) {
      const box = document.getElementById('bible-suggestions');
      const buttons = box ? Array.from(box.querySelectorAll('.bible-suggestion-item')) : [];
      if (event.key === 'Enter') {
        if (bibleSuggestionIndex >= 0 && bibleSuggestionItems[bibleSuggestionIndex]) {
          event.preventDefault();
          selectBibleSuggestion(bibleSuggestionIndex);
        } else {
          event.preventDefault();
          searchBibleVerse();
        }
        return;
      }
      if (!buttons.length || !['ArrowDown','ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      bibleSuggestionIndex += event.key === 'ArrowDown' ? 1 : -1;
      if (bibleSuggestionIndex < 0) bibleSuggestionIndex = buttons.length - 1;
      if (bibleSuggestionIndex >= buttons.length) bibleSuggestionIndex = 0;
      buttons.forEach((btn, idx) => btn.classList.toggle('active', idx === bibleSuggestionIndex));
      buttons[bibleSuggestionIndex].scrollIntoView({ block: 'nearest' });
    }

    function searchBibleVerse() {
      const input = document.getElementById('bible-search-input');
      const query = input ? input.value : '';
      const parsed = normalizeBibleSearchQuery(query);
      const bible = activeBibleKey && bibleLibraries[activeBibleKey] ? bibleLibraries[activeBibleKey] : null;
      const suggestionsBox = document.getElementById('bible-suggestions');
      if (suggestionsBox) suggestionsBox.style.display = 'none';

      if (!bible || !bible.entries || !bible.entries.length) {
        currentBibleSearchResult = null;
        renderBibleSearchResult('Choose a Bible file and click Accept first.');
        return;
      }

      let matches = [];
      if (parsed) {
        matches = bible.entries.filter(entry => normalizeBibleBookName(entry.book) === normalizeBibleBookName(parsed.book) && entry.chapter === parsed.chapter && entry.verse >= parsed.verse && entry.verse <= (parsed.endVerse || parsed.verse));
      }

      if (!matches.length) {
        const suggestions = buildBibleSuggestions(query);
        const firstVerseSuggestion = suggestions.find(item => item.entry);
        if (firstVerseSuggestion && firstVerseSuggestion.entry) {
          matches = [firstVerseSuggestion.entry];
          if (input) input.value = firstVerseSuggestion.entry.reference;
        }
      }

      if (!matches.length) {
        currentBibleSearchResult = null;
        renderBibleSearchResult('No match yet. Keep typing and choose from the suggestions.');
        updateBibleSuggestions();
        return;
      }

      currentBibleSearchResult = {
        book: matches[0].book,
        chapter: matches[0].chapter,
        verse: matches[0].verse,
        reference: matches.length > 1 ? `${matches[0].book} ${matches[0].chapter}:${matches[0].verse}-${matches[matches.length - 1].verse}` : matches[0].reference,
        text: matches.map(m => m.text).join(' '),
        sourceLabel: matches[0].sourceLabel
      };
      renderBibleSearchResult();
    }

    function renderBibleSearchResult(message = '') {
      const resultBox = document.getElementById('bible-search-result');
      if (!resultBox) return;
      if (message) { resultBox.innerHTML = `<div style="color: var(--accent-red);">${escapeHtml(message)}</div>`; return; }
      const totalLibraries = Object.keys(bibleLibraries).length;
      if (!activeBibleKey || !bibleLibraries[activeBibleKey]) {
        resultBox.innerHTML = '<div style="color: var(--text-muted);">Choose a Bible file, click Accept, then type freely to search.</div>';
        return;
      }
      if (!currentBibleSearchResult) {
        const active = bibleLibraries[activeBibleKey];
        resultBox.innerHTML = `<div style="color: var(--text-muted);">${escapeHtml(active.label || activeBibleKey)} loaded with ${(active.entries || []).length.toLocaleString()} verses. ${totalLibraries > 1 ? totalLibraries + ' Bible libraries available.' : ''} Type freely to search books, chapters, verses, or words.</div>`;
        return;
      }
      resultBox.innerHTML = `
        <div style="font-weight: 700; color: var(--text);">${escapeHtml(currentBibleSearchResult.reference)}</div>
        <div style="margin-top: 6px; color: var(--text-muted);">${escapeHtml(currentBibleSearchResult.text)}</div>
      `;
    }

    const originalRenderAudience = renderAudience;
    renderAudience = async function(payload) {
      if (payload && payload.type === 'bible') {
        const audienceTarget = document.getElementById('audience-view');
        let bgLayer = document.getElementById('audience-bg-layer');
        if (!bgLayer) { bgLayer = document.createElement('div'); bgLayer.id = 'audience-bg-layer'; }
        const verse = payload.value || {};
        const tempWrapper = document.createElement('div');
        tempWrapper.style.width = '100%';
        tempWrapper.style.height = '100%';
        tempWrapper.style.position = 'absolute';
        const card = document.createElement('div');
        card.className = 'bible-card';
        card.innerHTML = '<div class="bible-category-tag">' + escapeHtml(verse.category || payload.category || 'Bible') + '</div>' +
          '<div class="bible-text">' + escapeHtml(verse.text || '') + '</div>' +
          '<div class="bible-reference">' + escapeHtml(verse.reference || payload.name || '') + '</div>';
        tempWrapper.appendChild(card);
        Array.from(audienceTarget.children).filter(el => el.id !== 'audience-bg-layer').forEach(el => el.remove());
        audienceTarget.appendChild(bgLayer);
        audienceTarget.appendChild(tempWrapper);
        return;
      }
      return originalRenderAudience(payload);
    };


    /* Final Bible fixes: free search display names, fit-to-screen text, and verse background images. */
    const BIBLE_BOOK_CANONICAL_NAMES = [
      'Genesis','Exodus','Leviticus','Numbers','Deuteronomy','Joshua','Judges','Ruth','1 Samuel','2 Samuel','1 Kings','2 Kings','1 Chronicles','2 Chronicles','Ezra','Nehemiah','Esther','Job','Psalms','Proverbs','Ecclesiastes','Song of Solomon','Isaiah','Jeremiah','Lamentations','Ezekiel','Daniel','Hosea','Joel','Amos','Obadiah','Jonah','Micah','Nahum','Habakkuk','Zephaniah','Haggai','Zechariah','Malachi','Matthew','Mark','Luke','John','Acts','Romans','1 Corinthians','2 Corinthians','Galatians','Ephesians','Philippians','Colossians','1 Thessalonians','2 Thessalonians','1 Timothy','2 Timothy','Titus','Philemon','Hebrews','James','1 Peter','2 Peter','1 John','2 John','3 John','Jude','Revelation'
    ];

    const BIBLE_BOOK_ALIAS_MAP = (() => {
      const pairs = [
        ['gen','Genesis'],['ge','Genesis'],['gn','Genesis'],['exo','Exodus'],['exod','Exodus'],['ex','Exodus'],['lev','Leviticus'],['num','Numbers'],['deut','Deuteronomy'],['dt','Deuteronomy'],['josh','Joshua'],['judg','Judges'],['jdg','Judges'],['ps','Psalms'],['psa','Psalms'],['psalm','Psalms'],['prov','Proverbs'],['pr','Proverbs'],['eccl','Ecclesiastes'],['song','Song of Solomon'],['sos','Song of Solomon'],['isa','Isaiah'],['jer','Jeremiah'],['lam','Lamentations'],['ezek','Ezekiel'],['dan','Daniel'],['hos','Hosea'],['obad','Obadiah'],['jon','Jonah'],['mic','Micah'],['nah','Nahum'],['hab','Habakkuk'],['zeph','Zephaniah'],['hag','Haggai'],['zech','Zechariah'],['mal','Malachi'],['matt','Matthew'],['mt','Matthew'],['mk','Mark'],['mrk','Mark'],['lk','Luke'],['jn','John'],['rom','Romans'],['1cor','1 Corinthians'],['2cor','2 Corinthians'],['gal','Galatians'],['eph','Ephesians'],['phil','Philippians'],['col','Colossians'],['1thess','1 Thessalonians'],['2thess','2 Thessalonians'],['1tim','1 Timothy'],['2tim','2 Timothy'],['heb','Hebrews'],['jas','James'],['rev','Revelation']
      ];
      const map = {};
      BIBLE_BOOK_CANONICAL_NAMES.forEach((name, index) => {
        map[String(index + 1)] = name;
        map[normalizeBibleBookName(name)] = name;
      });
      pairs.forEach(([alias, name]) => { map[normalizeBibleBookName(alias)] = name; });
      return map;
    })();

    function canonicalBibleBookName(value) {
      const raw = String(value || '').trim();
      if (!raw) return raw;
      if (/^0*\d+$/.test(raw)) {
        const bookNumber = parseInt(raw, 10);
        return BIBLE_BOOK_CANONICAL_NAMES[bookNumber - 1] || raw;
      }
      const normalized = normalizeBibleBookName(raw);
      return BIBLE_BOOK_ALIAS_MAP[normalized] || raw;
    }

    function fixBibleEntryBookNames(entries) {
      return (entries || []).map(entry => {
        const fixedBook = canonicalBibleBookName(entry.book);
        const chapterNum = parseInt(String(entry.chapter).replace(/[^0-9]/g, ''), 10) || 1;
        const verseNum = parseInt(String(entry.verse).replace(/[^0-9]/g, ''), 10) || 1;
        return Object.assign({}, entry, {
          book: fixedBook,
          chapter: chapterNum,
          verse: verseNum,
          reference: buildBibleReference(fixedBook, chapterNum, verseNum)
        });
      });
    }

    const finalOriginalImportBibleFileObject = importBibleFileObject;
    importBibleFileObject = async function(file) {
      const result = await finalOriginalImportBibleFileObject(file);
      if (result && result.imported && result.key && bibleLibraries[result.key]) {
        bibleLibraries[result.key].entries = fixBibleEntryBookNames(bibleLibraries[result.key].entries);
        await saveBibleLibraryToDB(result.key, bibleLibraries[result.key]);
      }
      return result;
    };

    const finalOriginalLoadBibleLibrariesFromStorage = loadBibleLibrariesFromStorage;
    loadBibleLibrariesFromStorage = async function() {
      await finalOriginalLoadBibleLibrariesFromStorage();
      Object.keys(bibleLibraries).forEach(key => {
        bibleLibraries[key].entries = fixBibleEntryBookNames(bibleLibraries[key].entries);
      });
    };

    function getBibleBackgroundSourceFromPayload(payload) {
      const verse = payload && payload.value ? payload.value : {};
      return verse.backgroundSource || payload.backgroundSource || currentBackgroundSource || '';
    }

    function makeBiblePresentationCard(payload) {
      const verse = payload && payload.value ? payload.value : {};
      const card = document.createElement('div');
      card.className = 'bible-card';
      const bg = getBibleBackgroundSourceFromPayload(payload);
      if (bg) {
        card.style.backgroundImage = "url('" + String(bg).replace(/'/g, "%27") + "')";
      }
      const reference = verse.reference || payload.name || '';
      card.innerHTML = '<div class="bible-category-tag">' + escapeHtml(verse.category || payload.category || 'Bible') + '</div>' +
        '<div class="bible-text">' + escapeHtml(verse.text || '') + '</div>' +
        '<div class="bible-reference">' + escapeHtml(reference) + '</div>';
      return card;
    }

    function fitBibleCardText(card) {
      if (!card) return;
      const text = card.querySelector('.bible-text');
      const reference = card.querySelector('.bible-reference');
      const category = card.querySelector('.bible-category-tag');
      if (!text) return;

      text.style.fontSize = '';
      reference && (reference.style.fontSize = '');
      category && (category.style.fontSize = '');

      const cardHeight = Math.max(1, card.clientHeight);
      const cardWidth = Math.max(1, card.clientWidth);
      let textSize = Math.min(52, Math.max(18, cardWidth * 0.045));
      let refSize = Math.min(30, Math.max(14, cardWidth * 0.024));
      let tagSize = Math.min(15, Math.max(10, cardWidth * 0.012));

      const applySizes = () => {
        text.style.fontSize = textSize + 'px';
        text.style.lineHeight = textSize <= 24 ? '1.08' : '1.14';
        if (reference) reference.style.fontSize = refSize + 'px';
        if (category) category.style.fontSize = tagSize + 'px';
      };

      applySizes();
      let guard = 0;
      while ((card.scrollHeight > cardHeight || card.scrollWidth > cardWidth) && textSize > 13 && guard < 80) {
        textSize -= 1;
        refSize = Math.max(11, refSize - 0.35);
        tagSize = Math.max(8, tagSize - 0.18);
        applySizes();
        guard += 1;
      }
    }

    function fitAllBibleCardsSoon() {
      requestAnimationFrame(() => {
        document.querySelectorAll('.bible-card').forEach(fitBibleCardText);
      });
    }

    const finalOriginalRenderMediaIntoViewport = renderMediaIntoViewport;
    renderMediaIntoViewport = async function(target, payload, options = {}) {
      if (payload && payload.type === 'bible') {
        const label = target.querySelector('.viewport-label');
        const placeholderId = options.placeholderId || 'preview-placeholder';
        target.innerHTML = '';
        if (label) target.appendChild(label);
        if (!payload.value) {
          const placeholder = document.createElement('div');
          placeholder.id = placeholderId;
          placeholder.style.color = '#555';
          placeholder.textContent = options.emptyText || 'No Media Queued';
          target.appendChild(placeholder);
          return;
        }
        const card = makeBiblePresentationCard(payload);
        target.appendChild(card);
        fitBibleCardText(card);
        setTimeout(() => fitBibleCardText(card), 80);
        return;
      }
      return finalOriginalRenderMediaIntoViewport(target, payload, options);
    };

    function bibleResultToPayload(result, bible) {
      return {
        category: bible ? (bible.label || activeBibleKey) : 'Bible',
        reference: result.reference,
        text: result.text,
        backgroundSource: currentBackgroundSource || ''
      };
    }

    previewBibleSearchResult = function() {
      if (!currentBibleSearchResult) {
        renderBibleSearchResult('Search for a verse before previewing it.');
        return;
      }
      const bible = activeBibleKey && bibleLibraries[activeBibleKey] ? bibleLibraries[activeBibleKey] : null;
      staged = {
        type: 'bible',
        value: bibleResultToPayload(currentBibleSearchResult, bible),
        name: currentBibleSearchResult.reference,
        category: bible ? (bible.label || activeBibleKey) : 'Bible',
        sceneItemIndex: -1,
        page: 1,
        videoTime: 0,
        videoPlaying: false
      };
      renderSceneDeckUI();
      renderPreview();
      setSlideStatus();
    };

    addBibleSearchResultToScene = function() {
      if (!currentBibleSearchResult) {
        renderBibleSearchResult('Search for a verse before adding it to the scene.');
        return;
      }
      const scene = getActiveScene();
      const bible = activeBibleKey && bibleLibraries[activeBibleKey] ? bibleLibraries[activeBibleKey] : null;
      if (!scene) return;
      scene.items.push({
        id: uid(),
        type: 'bible',
        value: bibleResultToPayload(currentBibleSearchResult, bible),
        name: currentBibleSearchResult.reference,
        category: bible ? (bible.label || activeBibleKey) : 'Bible'
      });
      persistScenes();
      renderSceneDeckUI();
      setStagedFromSceneIndex(scene.items.length - 1);
    };

    const finalOriginalRenderAudience = renderAudience;
    renderAudience = async function(payload) {
      if (payload && payload.type === 'bible') {
        const audienceTarget = document.getElementById('audience-view');
        let bgLayer = document.getElementById('audience-bg-layer');
        if (!bgLayer) { bgLayer = document.createElement('div'); bgLayer.id = 'audience-bg-layer'; }
        const tempWrapper = document.createElement('div');
        tempWrapper.style.width = '100%';
        tempWrapper.style.height = '100%';
        tempWrapper.style.position = 'absolute';
        tempWrapper.style.inset = '0';
        const card = makeBiblePresentationCard(payload);
        tempWrapper.appendChild(card);
        Array.from(audienceTarget.children).filter(el => el.id !== 'audience-bg-layer').forEach(el => el.remove());
        audienceTarget.appendChild(bgLayer);
        audienceTarget.appendChild(tempWrapper);
        fitBibleCardText(card);
        setTimeout(() => fitBibleCardText(card), 120);
        return;
      }
      return finalOriginalRenderAudience(payload);
    };


    /* User-requested final improvements: no word hyphenation, no language flash, and Canva live mirroring. */
    function makeBiblePresentationCard(payload) {
      const verse = payload && payload.value ? payload.value : {};
      const card = document.createElement('div');
      card.className = 'bible-card';
      const bg = getBibleBackgroundSourceFromPayload(payload);
      if (bg) card.style.backgroundImage = "url('" + String(bg).replace(/'/g, "%27") + "')";
      const reference = verse.reference || payload.name || '';
      card.innerHTML =
        '<div class="bible-text">' + escapeHtml(verse.text || '') + '</div>' +
        '<div class="bible-reference">' + escapeHtml(reference) + '</div>';
      return card;
    }

    function fitBibleCardText(card) {
      if (!card) return;
      const text = card.querySelector('.bible-text');
      const reference = card.querySelector('.bible-reference');
      if (!text) return;

      text.style.fontSize = '';
      text.style.lineHeight = '';
      text.style.overflowWrap = 'normal';
      text.style.wordBreak = 'normal';
      text.style.hyphens = 'none';
      text.style.webkitHyphens = 'none';
      if (reference) {
        reference.style.fontSize = '';
        reference.style.overflowWrap = 'normal';
        reference.style.wordBreak = 'normal';
        reference.style.hyphens = 'none';
        reference.style.webkitHyphens = 'none';
      }

      const cardHeight = Math.max(1, card.clientHeight);
      const cardWidth = Math.max(1, card.clientWidth);
      let textSize = Math.min(52, Math.max(18, cardWidth * 0.044));
      let refSize = Math.min(30, Math.max(14, cardWidth * 0.024));

      const applySizes = () => {
        text.style.fontSize = textSize + 'px';
        text.style.lineHeight = textSize <= 22 ? '1.06' : '1.13';
        if (reference) reference.style.fontSize = refSize + 'px';
      };

      applySizes();
      let guard = 0;
      while ((card.scrollHeight > cardHeight || card.scrollWidth > cardWidth) && textSize > 10 && guard < 100) {
        textSize -= 1;
        refSize = Math.max(10, refSize - 0.35);
        applySizes();
        guard += 1;
      }
    }

    /* Canva behaves as a normal embedded presentation. Manual preview-target synchronization is removed. */


    /* Canva safe display: hide LIVE badge only for Canva and add small safe-area scaling to avoid edge cropping. */
    function tuneCanvaViewport(target, payload) {
      if (!target) return;
      const isCanva = Boolean(payload && payload.type === 'url');
      target.classList.toggle('canva-content-mode', isCanva);
      target.classList.toggle('canva-live-content-mode', isCanva && target.id === 'live-viewport');
      if (!isCanva) return;
      const iframe = target.querySelector('iframe');
      if (iframe) {
        iframe.classList.add('canva-fit-frame');
        iframe.setAttribute('scrolling', 'no');
        iframe.style.border = '0';
        iframe.style.display = 'block';
        iframe.style.background = '#000';
      }
    }

    const canvaSafeOriginalRenderMediaIntoViewport = renderMediaIntoViewport;
    renderMediaIntoViewport = async function(target, payload, options = {}) {
      if (target) {
        const isCanva = Boolean(payload && payload.type === 'url');
        target.classList.toggle('canva-content-mode', isCanva);
        target.classList.toggle('canva-live-content-mode', isCanva && target.id === 'live-viewport');
      }
      const result = await canvaSafeOriginalRenderMediaIntoViewport(target, payload, options);
      tuneCanvaViewport(target, payload);
      return result;
    };

    const canvaSafeOriginalRenderAudience = renderAudience;
    renderAudience = async function(payload) {
      if (payload && payload.type === 'url' && payload.value) {
        const audienceTarget = document.getElementById('audience-view');
        let bgLayer = document.getElementById('audience-bg-layer');
        if (!bgLayer) {
          bgLayer = document.createElement('div');
          bgLayer.id = 'audience-bg-layer';
        }

        const tempWrapper = document.createElement('div');
        tempWrapper.className = 'canva-audience-wrapper';
        tempWrapper.style.width = '100%';
        tempWrapper.style.height = '100%';
        tempWrapper.style.position = 'absolute';
        tempWrapper.style.inset = '0';
        tempWrapper.style.overflow = 'hidden';
        tempWrapper.style.background = '#000';

        const iframe = document.createElement('iframe');
        iframe.src = payload.value;
        iframe.className = 'canva-fit-frame';
        iframe.setAttribute('allow', 'fullscreen');
        iframe.setAttribute('scrolling', 'no');
        iframe.style.border = '0';
        iframe.style.display = 'block';
        iframe.style.background = '#000';
        tempWrapper.appendChild(iframe);

        Array.from(audienceTarget.children).filter(el => el.id !== 'audience-bg-layer').forEach(el => el.remove());
        audienceTarget.appendChild(bgLayer);
        audienceTarget.appendChild(tempWrapper);
        return;
      }
      return canvaSafeOriginalRenderAudience(payload);
    };



    /* Bible Library tools: reset saved Bibles, choose a dedicated Bible background, and dissolve transitions. */
    const LS_BIBLE_BG_DATA = 'mps_bible_background_data_v1';
    const LS_BIBLE_BG_NAME = 'mps_bible_background_name_v1';
    let currentBibleBackgroundSource = localStorage.getItem(LS_BIBLE_BG_DATA) || '';

    function updateBibleBackgroundStatus() {
      const el = document.getElementById('bible-background-status');
      if (!el) return;
      const name = localStorage.getItem('LS_BIBLE_BG_NAME') || localStorage.getItem('mps_bible_background_name_v1') || '';
      if (currentBibleBackgroundSource) {
        el.textContent = 'Bible background: ' + (name || 'custom image') + ' selected.';
      } else if (currentBackgroundSource) {
        el.textContent = 'Bible background: using the current global background.';
      } else {
        el.textContent = '';
      }
    }

    function getSelectedBibleBackgroundSource() {
      return currentBibleBackgroundSource || currentBackgroundSource || '';
    }

    function chooseBibleBackgroundImage() {
      const input = document.getElementById('bible-background-uploader');
      if (input) input.click();
    }

    function handleBibleBackgroundFile(event) {
      const file = event && event.target && event.target.files ? event.target.files[0] : null;
      if (!file) return;
      if (!file.type || !file.type.startsWith('image/')) {
        showModal('Invalid Background', 'Please choose an image file for the Bible verse background.', false);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        currentBibleBackgroundSource = String(reader.result || '');
        try {
          localStorage.setItem(LS_BIBLE_BG_DATA, currentBibleBackgroundSource);
          localStorage.setItem(LS_BIBLE_BG_NAME, file.name || 'custom image');
        } catch (e) {
          showModal('Background Too Large', 'The selected image is too large to save locally. Try a smaller background image.', false);
          return;
        }
        updateBibleBackgroundStatus();
        showBibleLibraryFlash('Bible background selected: ' + (file.name || 'custom image') + '.', false, true);
        if (staged && staged.type === 'bible' && staged.value) {
          staged.value.backgroundSource = getSelectedBibleBackgroundSource();
          renderPreview();
        }
        if (liveState && liveState.type === 'bible' && liveState.value) {
          liveState.value.backgroundSource = getSelectedBibleBackgroundSource();
          renderLiveView();
        }
      };
      reader.readAsDataURL(file);
      if (event.target) event.target.value = '';
    }

    async function clearBibleObjectStore() {
      const db = await openBibleDB();
      return new Promise((resolve) => {
        const tx = db.transaction('bibles', 'readwrite');
        tx.objectStore('bibles').clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    }

    async function resetBibleLibraries() {
      const res = await showModal('Reset Bible Library', 'This will remove all Bible files saved locally in this browser. Continue?', false);
      if (!res || !res.confirmed) return;
      await clearBibleObjectStore();
      bibleLibraries = {};
      activeBibleKey = '';
      currentBibleSearchResult = null;
      const input = document.getElementById('bible-file-uploader');
      if (input) input.value = '';
      const suggestions = document.getElementById('bible-suggestions');
      if (suggestions) suggestions.innerHTML = '';
      populateBibleLibrarySelector();
      renderBibleSearchResult('Bible libraries saved locally were reset. Choose a file and click Accept to import again.');
    }

    const bibleToolsOriginalBibleResultToPayload = bibleResultToPayload;
    bibleResultToPayload = function(result, bible) {
      const payload = bibleToolsOriginalBibleResultToPayload(result, bible);
      payload.backgroundSource = getSelectedBibleBackgroundSource();
      return payload;
    };

    const bibleToolsOriginalChangeBackgroundTarget = changeBackgroundTarget;
    changeBackgroundTarget = function(filename) {
      bibleToolsOriginalChangeBackgroundTarget(filename);
      updateBibleBackgroundStatus();
    };

    async function renderAudienceDissolve(payload) {
      const audienceTarget = document.getElementById('audience-view');
      if (!audienceTarget) return;
      const oldChildren = Array.from(audienceTarget.children).filter(el => el.id !== 'audience-bg-layer');
      const oldLayer = document.createElement('div');
      oldLayer.className = 'dissolve-old-layer';
      oldChildren.forEach(el => oldLayer.appendChild(el.cloneNode(true)));
      if (oldChildren.length) audienceTarget.appendChild(oldLayer);
      await renderAudience(payload);
      requestAnimationFrame(() => oldLayer.classList.add('dissolve-out'));
      setTimeout(() => { if (oldLayer && oldLayer.parentNode) oldLayer.remove(); }, 760);
    }

    const bibleToolsOriginalPopulateBibleLibrarySelector = populateBibleLibrarySelector;
    populateBibleLibrarySelector = function() {
      bibleToolsOriginalPopulateBibleLibrarySelector();
      updateBibleBackgroundStatus();
    };


    /* Firebase Bible-only cloud save. This intentionally saves only Bible library objects, not scenes, media, backgrounds, UI settings, or other presenter data. */
    const FIREBASE_BIBLE_ROOT_URL = 'https://biblelibrary-42031-default-rtdb.firebaseio.com/';
    const FIREBASE_BIBLE_COLLECTION = 'bibles';

    function getFirebaseBibleCollectionUrl() {
      return FIREBASE_BIBLE_ROOT_URL.replace(/\/+$/, '') + '/' + FIREBASE_BIBLE_COLLECTION;
    }

    function getFirebaseBibleItemUrl(key) {
      return getFirebaseBibleCollectionUrl() + '/' + encodeURIComponent(String(key || 'imported_bible')) + '.json';
    }

    function setBibleFirebaseStatus(message, isError = false) {
      const el = document.getElementById('bible-firebase-status');
      if (el) {
        el.textContent = message;
        el.style.color = isError ? 'var(--accent-red)' : 'var(--text-muted)';
        el.style.borderColor = isError ? 'rgba(230, 57, 70, 0.55)' : 'var(--border)';
      }
      showBibleLibraryFlash(message, isError, true);
    }

    function makeFirebaseBiblePayload(key, bible) {
      const cleanEntries = (bible && Array.isArray(bible.entries) ? bible.entries : []).map((entry) => ({
        book: String(entry.book || ''),
        chapter: Number(entry.chapter) || 1,
        verse: Number(entry.verse) || 1,
        text: String(entry.text || ''),
        reference: String(entry.reference || buildBibleReference(entry.book, entry.chapter, entry.verse)),
        sourceLabel: String(entry.sourceLabel || bible.label || key || '')
      }));
      return {
        key: String(key || ''),
        label: String((bible && bible.label) || key || ''),
        entries: cleanEntries,
        verseCount: cleanEntries.length,
        updatedAt: new Date().toISOString(),
        savedBy: 'JIL TAGUIG PRESENTER Bible Library'
      };
    }

    async function saveBibleLibraryToFirebase(key, bible) {
      if (String(key || '').startsWith('api:') || (bible && bible.apiMode)) {
        setBibleFirebaseStatus('Firebase: skipped online API Bible. Only chosen local files/folders are saved.');
        return { saved: false, skipped: true, reason: 'api Bible is live only' };
      }
      if (!key || !bible || !Array.isArray(bible.entries) || !bible.entries.length) return { saved: false, reason: 'empty Bible library' };
      const payload = makeFirebaseBiblePayload(key, bible);
      const response = await fetch(getFirebaseBibleItemUrl(key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) throw new Error('Firebase rejected the Bible save (' + response.status + ')');
      return { saved: true, verseCount: payload.verseCount };
    }

    async function loadBibleLibrariesFromFirebase() {
      try {
        const response = await fetch(getFirebaseBibleCollectionUrl() + '.json', { method: 'GET' });
        if (!response.ok) throw new Error('Firebase read failed (' + response.status + ')');
        const data = await response.json();
        if (!data || typeof data !== 'object') {
          setBibleFirebaseStatus('Firebase: no Bible libraries found yet.');
          return 0;
        }
        let loadedCount = 0;
        for (const key of Object.keys(data)) {
          const bible = data[key];
          if (!bible || !Array.isArray(bible.entries) || !bible.entries.length) continue;
          const fixedEntries = fixBibleEntryBookNames(bible.entries);
          bibleLibraries[key] = {
            key,
            label: bible.label || key,
            entries: fixedEntries
          };
          await saveBibleLibraryToDB(key, bibleLibraries[key]);
          loadedCount += 1;
        }
        if (!activeBibleKey && Object.keys(bibleLibraries).length) activeBibleKey = Object.keys(bibleLibraries)[0];
        if (loadedCount) setBibleFirebaseStatus('Firebase: loaded ' + loadedCount + ' Bible librar' + (loadedCount === 1 ? 'y' : 'ies') + '.');
        else setBibleFirebaseStatus('Firebase: no readable Bible libraries found.');
        return loadedCount;
      } catch (error) {
        setBibleFirebaseStatus('Firebase: cloud load skipped - ' + (error && error.message ? error.message : 'connection blocked'), true);
        return 0;
      }
    }

    const firebaseOriginalImportBibleFileObject = importBibleFileObject;
    importBibleFileObject = async function(file) {
      const result = await firebaseOriginalImportBibleFileObject(file);
      if (result && result.imported && result.key && bibleLibraries[result.key]) {
        try {
          setBibleFirebaseStatus('Firebase: saving Bible only...');
          const cloudResult = await saveBibleLibraryToFirebase(result.key, bibleLibraries[result.key]);
          result.firebaseSaved = true;
          setBibleFirebaseStatus('Firebase: saved Bible only (' + (cloudResult.verseCount || bibleLibraries[result.key].entries.length) + ' verses).');
        } catch (error) {
          result.firebaseSaved = false;
          result.firebaseReason = error && error.message ? error.message : 'cloud save failed';
          setBibleFirebaseStatus('Firebase: Bible cloud save failed - ' + result.firebaseReason, true);
        }
      }
      return result;
    };

    const firebaseOriginalLoadBibleLibrariesFromStorage = loadBibleLibrariesFromStorage;
    loadBibleLibrariesFromStorage = async function() {
      await firebaseOriginalLoadBibleLibrariesFromStorage();
      await loadBibleLibrariesFromFirebase();
    };


    window.addEventListener('resize', fitAllBibleCardsSoon);


    function updateHeaderClock() {
      const el = document.getElementById('header-clock');
      if (!el) return;
      el.textContent = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      }).format(new Date());
    }

    function hideIntroLoadingScreen() {
      const intro = document.getElementById('intro-loading-screen');
      if (!intro) return;
      setTimeout(() => intro.classList.add('hide'), 1100);
      setTimeout(() => { if (intro && intro.parentNode) intro.remove(); }, 2000);
    }

    function updateDisplayToggleButton() {
      const btn = document.getElementById('display-toggle-btn');
      if (!btn) return;
      const isOpen = Boolean(displayWindow && !displayWindow.closed);
      btn.textContent = isOpen ? 'Close Display Screen' : 'Open Display Screen';
      btn.classList.toggle('active', isOpen);
    }

    function toggleDisplayScreen() {
      if (displayWindow && !displayWindow.closed) closeDisplayScreen();
      else openDisplayWindow();
      updateDisplayToggleButton();
    }

    function openAddBibleModal() {
      const modal = document.getElementById('add-bible-modal');
      if (!modal) return;
      updateBiblePendingFileStatus();
      modal.classList.add('open');
    }

    function closeAddBibleModal() {
      const modal = document.getElementById('add-bible-modal');
      if (modal) modal.classList.remove('open');
    }

    function chooseBibleFiles() {
      const input = document.getElementById('bible-file-uploader');
      if (input) input.click();
    }

    function handleBiblePickerSelection() {
      updateBiblePendingFileStatus();
      const status = document.getElementById('add-bible-modal-status');
      const files = getPendingBibleImportFiles();
      const supported = files.filter(file => isSupportedBibleFile(file.name));
      if (status) {
        status.style.display = 'block';
        status.textContent = supported.length
          ? `${supported.length} supported Bible file${supported.length === 1 ? '' : 's'} selected and ready to import.`
          : 'No supported Bible files were found in this selection.';
      }
    }

    async function importBibleFilesFromModal() {
      const btn = document.getElementById('add-bible-import-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Importing...'; }
      try {
        await importBibleFiles();
        const remaining = getPendingBibleImportFiles();
        if (!remaining.length) closeAddBibleModal();
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Import Bible'; }
      }
    }

    window.addEventListener('DOMContentLoaded', async () => {
      updateHeaderClock();
      setInterval(updateHeaderClock, 1000);
      loadCanvaPdfStorageSettings();
      updateDisplayToggleButton();
      hideIntroLoadingScreen();

      // Check for user theme preferences on load
      const savedTheme = localStorage.getItem('mps_theme_mode');
      const toggleCheckbox = document.getElementById('checkbox');
      if (savedTheme === 'light') {
        document.body.classList.add('light-mode');
        if (toggleCheckbox) toggleCheckbox.checked = true;
      }

      const params = new URLSearchParams(window.location.search);
      if (params.get('display') === 'true') {
        document.body.classList.add('live-window-mode');
        setupDisplayWindowFeatures(); 
        channel.postMessage({ command: 'REQUEST_CURRENT_OUTPUT' });
      } else {
        await loadScenes(); 
        await verifySavedFolderAccess();
        await loadBibleLibrariesFromStorage();
        renderSceneList();
        populateBibleLibrarySelector();
        renderBibleSearchResult();
        renderSceneDeckUI(); 
        populateSlidePreviewGrid();
        renderPreview();
        renderLiveView();
        setSlideStatus();
        updateSelectedMonitorButton();
      }
    });
  

    /* Bible live verse navigation: use arrows in the operator Live View to move to previous/next verse and sync the extended display. */
    function getBiblePayloadMeta(payload) {
      const value = payload && payload.value ? payload.value : {};
      const reference = String(value.reference || (payload && payload.name) || '').trim();
      let book = value.book || payload.book || '';
      let chapter = parseInt(value.chapter || payload.chapter || '', 10);
      let verse = parseInt(value.verse || payload.verse || '', 10);

      if ((!book || !Number.isFinite(chapter) || !Number.isFinite(verse)) && reference) {
        const match = reference.match(/^(.+?)\s+(\d+)\s*[:.]\s*(\d+)/);
        if (match) {
          book = book || match[1].trim();
          chapter = Number.isFinite(chapter) ? chapter : parseInt(match[2], 10);
          verse = Number.isFinite(verse) ? verse : parseInt(match[3], 10);
        }
      }

      return {
        bibleKey: value.bibleKey || payload.bibleKey || activeBibleKey || '',
        book: canonicalBibleBookName(book),
        chapter: Number.isFinite(chapter) ? chapter : null,
        verse: Number.isFinite(verse) ? verse : null
      };
    }

    function getOrderedBibleEntriesForKey(key) {
      const bible = key && bibleLibraries[key] ? bibleLibraries[key] : (activeBibleKey && bibleLibraries[activeBibleKey] ? bibleLibraries[activeBibleKey] : null);
      if (!bible || !Array.isArray(bible.entries)) return [];
      const order = {};
      if (typeof BIBLE_BOOK_CANONICAL_NAMES !== 'undefined') {
        BIBLE_BOOK_CANONICAL_NAMES.forEach((name, index) => { order[normalizeBibleBookName(name)] = index + 1; });
      }
      return bible.entries.slice().sort((a, b) => {
        const ao = order[normalizeBibleBookName(canonicalBibleBookName(a.book))] || 999;
        const bo = order[normalizeBibleBookName(canonicalBibleBookName(b.book))] || 999;
        if (ao !== bo) return ao - bo;
        if ((Number(a.chapter) || 0) !== (Number(b.chapter) || 0)) return (Number(a.chapter) || 0) - (Number(b.chapter) || 0);
        return (Number(a.verse) || 0) - (Number(b.verse) || 0);
      });
    }

    function getAdjacentBibleEntryFromPayload(payload, delta) {
      const meta = getBiblePayloadMeta(payload);
      const entries = getOrderedBibleEntriesForKey(meta.bibleKey);
      if (!entries.length || !meta.book || !meta.chapter || !meta.verse) return null;
      const normalizedBook = normalizeBibleBookName(canonicalBibleBookName(meta.book));
      const index = entries.findIndex(entry =>
        normalizeBibleBookName(canonicalBibleBookName(entry.book)) === normalizedBook &&
        Number(entry.chapter) === Number(meta.chapter) &&
        Number(entry.verse) === Number(meta.verse)
      );
      if (index < 0) return null;
      return entries[index + delta] || null;
    }

    function makeBiblePayloadFromEntry(entry, bibleKey) {
      const bible = bibleKey && bibleLibraries[bibleKey] ? bibleLibraries[bibleKey] : (activeBibleKey && bibleLibraries[activeBibleKey] ? bibleLibraries[activeBibleKey] : null);
      const result = {
        book: canonicalBibleBookName(entry.book),
        chapter: Number(entry.chapter) || 1,
        verse: Number(entry.verse) || 1,
        reference: buildBibleReference(canonicalBibleBookName(entry.book), Number(entry.chapter) || 1, Number(entry.verse) || 1),
        text: String(entry.text || ''),
        sourceLabel: entry.sourceLabel || (bible ? bible.label : '')
      };
      const payloadValue = bibleResultToPayload(result, bible);
      payloadValue.book = result.book;
      payloadValue.chapter = result.chapter;
      payloadValue.verse = result.verse;
      payloadValue.bibleKey = bibleKey || activeBibleKey || '';
      return {
        type: 'bible',
        value: payloadValue,
        name: result.reference,
        category: bible ? (bible.label || bibleKey || activeBibleKey || 'Bible') : 'Bible',
        sceneItemIndex: -1,
        page: 1,
        videoTime: 0,
        videoPlaying: false
      };
    }

    function canNavigateLiveBible(delta) {
      if (!liveState || liveState.type !== 'bible') return false;
      return Boolean(getAdjacentBibleEntryFromPayload(liveState, delta));
    }

    async function navigateLiveBibleVerse(delta) {
      if (!liveState || liveState.type !== 'bible') return;
      const meta = getBiblePayloadMeta(liveState);
      const nextEntry = getAdjacentBibleEntryFromPayload(liveState, delta);
      if (!nextEntry) return;
      const nextPayload = makeBiblePayloadFromEntry(nextEntry, meta.bibleKey || activeBibleKey);
      liveState = JSON.parse(JSON.stringify(nextPayload));
      currentBibleSearchResult = {
        book: nextPayload.value.book,
        chapter: nextPayload.value.chapter,
        verse: nextPayload.value.verse,
        reference: nextPayload.value.reference,
        text: nextPayload.value.text,
        sourceLabel: nextPayload.value.category
      };
      const searchInput = document.getElementById('bible-search-input');
      if (searchInput) searchInput.value = nextPayload.value.reference || nextPayload.name || '';
      renderBibleSearchResult();
      await renderLiveView();
      channel.postMessage({ command: 'UPDATE_LIVE_BIBLE_VERSE', payload: liveState });
    }

    function removeBibleLiveNavigation(target) {
      if (!target) return;
      target.querySelectorAll('.bible-live-nav').forEach(el => el.remove());
    }

    function addBibleLiveNavigation(target, payload) {
      if (!target || target.id !== 'live-viewport' || !payload || payload.type !== 'bible') return;
      removeBibleLiveNavigation(target);
      const nav = document.createElement('div');
      nav.className = 'bible-live-nav';
      const prev = document.createElement('button');
      prev.type = 'button';
      prev.setAttribute('aria-label', 'Previous Bible verse');
      prev.innerHTML = '&#8249;';
      prev.disabled = !canNavigateLiveBible(-1);
      prev.onclick = (event) => { event.stopPropagation(); navigateLiveBibleVerse(-1); };
      const next = document.createElement('button');
      next.type = 'button';
      next.setAttribute('aria-label', 'Next Bible verse');
      next.innerHTML = '&#8250;';
      next.disabled = !canNavigateLiveBible(1);
      next.onclick = (event) => { event.stopPropagation(); navigateLiveBibleVerse(1); };
      const hint = document.createElement('div');
      hint.className = 'bible-live-nav-label';
      hint.textContent = 'Verse navigation';
      nav.appendChild(prev);
      nav.appendChild(next);
      nav.appendChild(hint);
      target.appendChild(nav);
    }

    const bibleNavOriginalRenderMediaIntoViewport = renderMediaIntoViewport;
    renderMediaIntoViewport = async function(target, payload, options = {}) {
      const result = await bibleNavOriginalRenderMediaIntoViewport(target, payload, options);
      if (target && target.id === 'live-viewport') {
        removeBibleLiveNavigation(target);
        if (payload && payload.type === 'bible') addBibleLiveNavigation(target, payload);
      }
      return result;
    };

    const bibleNavOriginalBibleResultToPayload = bibleResultToPayload;
    bibleResultToPayload = function(result, bible) {
      const payload = bibleNavOriginalBibleResultToPayload(result, bible);
      payload.book = canonicalBibleBookName(result.book);
      payload.chapter = Number(result.chapter) || 1;
      payload.verse = Number(result.verse) || 1;
      payload.bibleKey = (bible && bible.key) || activeBibleKey || '';
      return payload;
    };

    channel.addEventListener('message', async (event) => {
      const msg = event.data;
      if (!msg || msg.command !== 'UPDATE_LIVE_BIBLE_VERSE') return;
      lastIncoming = msg.payload;
      if (document.body.classList.contains('live-window-mode')) {
        await performAudienceTransition(msg.payload, 'fade');
      }
    });


    /* Online Bible API integration: Free Use Bible API (AO Lab). This uses live API reads only and does not save API Bible text to Firebase. */
    const HELLOAO_BIBLE_API_BASE = 'https://bible.helloao.org/api';
    let bibleApiTranslations = [];
    let bibleApiBooksCache = {};
    let bibleApiChapterCache = {};

    function setBibleApiStatus(message, isError = false) {
      const el = document.getElementById('bible-api-status');
      if (el) {
        el.textContent = message;
        el.style.color = isError ? 'var(--accent-red)' : 'var(--text-muted)';
        el.style.borderColor = isError ? 'rgba(230, 57, 70, 0.55)' : 'var(--border)';
      }
      showBibleLibraryFlash(message, isError, true);
    }

    function injectBibleApiControls() {
      const firebaseStatus = document.getElementById('bible-firebase-status');
      if (!firebaseStatus || document.getElementById('bible-api-row')) return;
      firebaseStatus.textContent = '';

      const apiRow = document.createElement('div');
      apiRow.id = 'bible-api-row';
      apiRow.className = 'bible-tool-row';
      apiRow.style.display = 'grid';
      apiRow.style.gridTemplateColumns = '1fr auto auto';
      apiRow.style.gap = '8px';
      apiRow.style.alignItems = 'center';
      apiRow.innerHTML = `
        <select id="bible-api-version-select" style="margin-bottom:0; min-width: 180px;">
          <option value="">Online Bible API: English/Tagalog only</option>
        </select>
        <button type="button" class="bible-tool-btn" onclick="loadBibleApiTranslations()">🌐 Load Versions</button>
        <button type="button" class="bible-tool-btn accept" onclick="activateSelectedBibleApiVersion()">Use API</button>
      `;
      const apiStatus = document.createElement('div');
      apiStatus.id = 'bible-api-status';
      apiStatus.className = 'bible-background-status bible-library-hidden-status';
      apiStatus.textContent = '';
      firebaseStatus.insertAdjacentElement('afterend', apiStatus);
      apiStatus.insertAdjacentElement('beforebegin', apiRow);
    }

    function collectBibleApiTranslations(data, out = []) {
      if (!data) return out;
      if (Array.isArray(data)) {
        data.forEach(item => collectBibleApiTranslations(item, out));
        return out;
      }
      if (typeof data !== 'object') return out;
      if (data.id && (data.name || data.englishName || data.shortName)) {
        out.push(data);
      }
      Object.keys(data).forEach(key => {
        if (key === 'translation') return;
        const value = data[key];
        if (value && typeof value === 'object') collectBibleApiTranslations(value, out);
      });
      return out;
    }

    function isEnglishOrTagalogBibleApiTranslation(translation) {
      if (!translation) return false;
      const languageText = [
        translation.languageEnglishName,
        translation.languageName,
        translation.language,
        translation.languageCode,
        translation.languageId,
        translation.lang,
        translation.iso,
        translation.iso6393
      ].filter(Boolean).join(' ').toLowerCase();
      const idText = String(translation.id || '').toLowerCase();
      const nameText = [translation.shortName, translation.name, translation.englishName].filter(Boolean).join(' ').toLowerCase();
      const combined = (languageText + ' ' + idText + ' ' + nameText).replace(/[_-]+/g, ' ');

      const isEnglish = /\benglish\b/.test(combined) || /\beng\b/.test(combined) || idText === 'eng' || idText.startsWith('eng-');
      const isTagalog = /\btagalog\b/.test(combined) || /\bfilipino\b/.test(combined) || /\bpilipino\b/.test(combined) || /\btgl\b/.test(combined) || /\bfil\b/.test(combined) || idText === 'tgl' || idText === 'fil' || idText.startsWith('tgl-') || idText.startsWith('fil-');
      return isEnglish || isTagalog;
    }

    async function loadBibleApiTranslations() {
      injectBibleApiControls();
      const select = document.getElementById('bible-api-version-select');
      try {
        setBibleApiStatus('Online Bible API: loading English and Tagalog versions only...');
        if (select) select.innerHTML = '<option value="">Loading versions...</option>';
        const response = await fetch(HELLOAO_BIBLE_API_BASE + '/available_translations.json', { method: 'GET' });
        if (!response.ok) throw new Error('API returned ' + response.status);
        const data = await response.json();
        const seen = new Set();
        bibleApiTranslations = collectBibleApiTranslations(data)
          .filter(t => t && t.id && isEnglishOrTagalogBibleApiTranslation(t) && !seen.has(String(t.id)) && seen.add(String(t.id)))
          .sort((a, b) => String(a.languageEnglishName || a.languageName || '').localeCompare(String(b.languageEnglishName || b.languageName || '')) || String(a.englishName || a.name || a.id).localeCompare(String(b.englishName || b.name || b.id)));

        if (!bibleApiTranslations.length) throw new Error('No English or Tagalog versions found');
        if (select) {
          select.innerHTML = '<option value="">Choose English or Tagalog API Bible Version</option>';
          bibleApiTranslations.forEach(t => {
            const opt = document.createElement('option');
            opt.value = t.id;
            const lang = t.languageEnglishName || t.languageName || t.language || '';
            const short = t.shortName || t.id;
            opt.textContent = `${short} — ${t.englishName || t.name || t.id}${lang ? ' (' + lang + ')' : ''}`;
            select.appendChild(opt);
          });
          const bsb = Array.from(select.options).find(o => o.value === 'BSB');
          if (bsb) select.value = 'BSB';
        }
        setBibleApiStatus('Online Bible API: loaded ' + bibleApiTranslations.length + ' English/Tagalog version' + (bibleApiTranslations.length === 1 ? '' : 's') + '. Choose one and click Use API.');
      } catch (error) {
        if (select) select.innerHTML = '<option value="">Unable to load API versions</option>';
        setBibleApiStatus('Online Bible API: failed to load versions - ' + (error && error.message ? error.message : 'network error'), true);
      }
    }

    function getBibleApiTranslationInfo(id) {
      return bibleApiTranslations.find(t => String(t.id) === String(id)) || { id, shortName: id, name: id, englishName: id };
    }

    async function fetchBibleApiBooks(translationId) {
      if (bibleApiBooksCache[translationId]) return bibleApiBooksCache[translationId];
      const response = await fetch(`${HELLOAO_BIBLE_API_BASE}/${encodeURIComponent(translationId)}/books.json`, { method: 'GET' });
      if (!response.ok) throw new Error('Books API returned ' + response.status);
      const data = await response.json();
      const books = Array.isArray(data.books) ? data.books : [];
      bibleApiBooksCache[translationId] = books;
      const key = 'api:' + translationId;
      if (bibleLibraries[key]) bibleLibraries[key].books = books;
      return books;
    }

    async function activateSelectedBibleApiVersion() {
      injectBibleApiControls();
      const select = document.getElementById('bible-api-version-select');
      const translationId = select && select.value ? select.value : '';
      if (!translationId) {
        setBibleApiStatus('Online Bible API: choose a version first.');
        return;
      }
      const info = getBibleApiTranslationInfo(translationId);
      const key = 'api:' + translationId;
      const label = (info.shortName || info.id || translationId) + ' API';
      bibleLibraries[key] = {
        key,
        label,
        entries: [],
        books: bibleApiBooksCache[translationId] || [],
        apiMode: true,
        translationId,
        translationInfo: info
      };
      activeBibleKey = key;
      currentBibleSearchResult = null;
      populateBibleLibrarySelector();
      const librarySelect = document.getElementById('bible-language-select');
      if (librarySelect) librarySelect.value = key;
      renderBibleSearchResult();
      try {
        setBibleApiStatus('Online Bible API: loading books for ' + label + '...');
        await fetchBibleApiBooks(translationId);
        setBibleApiStatus('Online Bible API: using ' + label + ' (English/Tagalog filter). Type a book, chapter, verse, or phrase. API verses are not saved to Firebase.');
        updateBibleSuggestions();
      } catch (error) {
        setBibleApiStatus('Online Bible API: failed to load books - ' + (error && error.message ? error.message : 'network error'), true);
      }
    }

    function isActiveBibleApiMode() {
      return Boolean(activeBibleKey && bibleLibraries[activeBibleKey] && bibleLibraries[activeBibleKey].apiMode);
    }

    function getActiveBibleApiLibrary() {
      return isActiveBibleApiMode() ? bibleLibraries[activeBibleKey] : null;
    }

    const apiOriginalPopulateBibleLibrarySelector = populateBibleLibrarySelector;
    populateBibleLibrarySelector = function() {
      apiOriginalPopulateBibleLibrarySelector();
      const select = document.getElementById('bible-language-select');
      if (!select) return;
      Array.from(select.options).forEach(opt => {
        if (String(opt.value).startsWith('api:') && !String(opt.textContent).includes('🌐')) opt.textContent = '🌐 ' + opt.textContent;
      });
    };

    function normalizeApiBookInput(value) {
      return normalizeBibleBookName(canonicalBibleBookName(value));
    }

    function findBibleApiBook(raw, books) {
      const wanted = normalizeApiBookInput(raw);
      if (!wanted) return null;
      return (books || []).find(book => {
        const names = [book.id, book.name, book.commonName, book.title].filter(Boolean);
        return names.some(name => normalizeApiBookInput(name) === wanted || normalizeApiBookInput(name).includes(wanted) || wanted.includes(normalizeApiBookInput(name)));
      }) || null;
    }

    function stringifyApiContentPart(part) {
      if (part === null || part === undefined) return '';
      if (typeof part === 'string' || typeof part === 'number') return String(part);
      if (Array.isArray(part)) return part.map(stringifyApiContentPart).join(' ');
      if (typeof part !== 'object') return '';
      if (part.lineBreak) return ' ';
      if (part.text) return String(part.text);
      if (part.heading) return '';
      if (part.content) return stringifyApiContentPart(part.content);
      return '';
    }

    function apiChapterToEntries(chapterData, translationId) {
      const book = chapterData.book || {};
      const chapterNumber = Number(chapterData.chapter && chapterData.chapter.number) || Number(chapterData.number) || 1;
      const content = chapterData.chapter && Array.isArray(chapterData.chapter.content) ? chapterData.chapter.content : [];
      const bookName = book.commonName || book.name || book.id || 'Bible';
      return content
        .filter(item => item && item.type === 'verse')
        .map(item => {
          const verseNumber = Number(item.number) || 1;
          const text = stringifyApiContentPart(item.content).replace(/\s+/g, ' ').trim();
          return {
            book: bookName,
            bookId: book.id || '',
            chapter: chapterNumber,
            verse: verseNumber,
            text,
            reference: buildBibleReference(bookName, chapterNumber, verseNumber),
            sourceLabel: translationId,
            apiMode: true,
            bibleKey: 'api:' + translationId
          };
        })
        .filter(entry => entry.text);
    }

    async function fetchBibleApiChapter(translationId, bookId, chapter) {
      const cacheKey = `${translationId}|${bookId}|${chapter}`;
      if (bibleApiChapterCache[cacheKey]) return bibleApiChapterCache[cacheKey];
      const response = await fetch(`${HELLOAO_BIBLE_API_BASE}/${encodeURIComponent(translationId)}/${encodeURIComponent(bookId)}/${encodeURIComponent(chapter)}.json`, { method: 'GET' });
      if (!response.ok) throw new Error('Chapter API returned ' + response.status);
      const data = await response.json();
      const entries = apiChapterToEntries(data, translationId);
      bibleApiChapterCache[cacheKey] = entries;
      const lib = bibleLibraries['api:' + translationId];
      if (lib) {
        const existing = new Set((lib.entries || []).map(e => `${normalizeBibleBookName(e.book)}|${e.chapter}|${e.verse}`));
        entries.forEach(e => {
          const key = `${normalizeBibleBookName(e.book)}|${e.chapter}|${e.verse}`;
          if (!existing.has(key)) {
            existing.add(key);
            lib.entries.push(e);
          }
        });
      }
      return entries;
    }

    async function buildBibleApiSuggestions(query) {
      const lib = getActiveBibleApiLibrary();
      if (!lib) return [];
      const raw = String(query || '').trim().replace(/\s+/g, ' ');
      if (!raw) return [];
      const books = lib.books && lib.books.length ? lib.books : await fetchBibleApiBooks(lib.translationId);
      const ref = getReferencePartsForLooseQuery(raw);
      const suggestions = [];
      const seen = new Set();
      const add = (label, value, entry) => {
        const key = label + '|' + value;
        if (seen.has(key)) return;
        seen.add(key);
        suggestions.push({ label, value, entry });
      };

      if (ref && ref.book && ref.chapter) {
        const book = findBibleApiBook(ref.book, books);
        if (book) {
          try {
            const verses = await fetchBibleApiChapter(lib.translationId, book.id, ref.chapter);
            verses
              .filter(v => ref.verse === null || String(v.verse).startsWith(String(ref.verse)))
              .slice(0, 30)
              .forEach(v => add(`${v.reference} — ${v.text.slice(0, 90)}`, v.reference, v));
          } catch (e) {
            add('Unable to load chapter from API. Try another reference.', raw, null);
          }
          return suggestions;
        }
      }

      const q = normalizeBibleBookName(raw);
      books
        .filter(book => [book.name, book.commonName, book.title, book.id].filter(Boolean).some(name => normalizeBibleBookName(name).includes(q)))
        .slice(0, 12)
        .forEach(book => add(`${book.commonName || book.name} — ${book.numberOfChapters || '?'} chapters`, `${book.commonName || book.name} `, null));

      (lib.entries || [])
        .filter(entry => (`${entry.reference} ${entry.text}`).toLowerCase().includes(raw.toLowerCase()))
        .slice(0, 15)
        .forEach(entry => add(`${entry.reference} — ${entry.text.slice(0, 90)}`, entry.reference, entry));

      return suggestions.slice(0, 25);
    }

    const apiOriginalUpdateBibleSuggestions = updateBibleSuggestions;
    updateBibleSuggestions = async function() {
      if (!isActiveBibleApiMode()) return apiOriginalUpdateBibleSuggestions();
      const input = document.getElementById('bible-search-input');
      const box = document.getElementById('bible-suggestions');
      if (!input || !box) return;
      const queryAtStart = input.value;
      try {
        bibleSuggestionItems = await buildBibleApiSuggestions(queryAtStart);
      } catch (error) {
        bibleSuggestionItems = [];
        setBibleApiStatus('Online Bible API: suggestion error - ' + (error && error.message ? error.message : 'network error'), true);
      }
      if (input.value !== queryAtStart) return;
      bibleSuggestionIndex = -1;
      if (!bibleSuggestionItems.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.innerHTML = bibleSuggestionItems.map((item, idx) => `<button type="button" class="bible-suggestion-item" data-index="${idx}">${escapeHtml(item.label)}</button>`).join('');
      box.style.display = 'block';
      Array.from(box.querySelectorAll('.bible-suggestion-item')).forEach(btn => {
        btn.onclick = () => selectBibleSuggestion(parseInt(btn.getAttribute('data-index'), 10));
      });
    };

    const apiOriginalSearchBibleVerse = searchBibleVerse;
    searchBibleVerse = async function() {
      if (!isActiveBibleApiMode()) return apiOriginalSearchBibleVerse();
      const input = document.getElementById('bible-search-input');
      const query = input ? input.value : '';
      const parsed = normalizeBibleSearchQuery(query);
      const lib = getActiveBibleApiLibrary();
      const suggestionsBox = document.getElementById('bible-suggestions');
      if (suggestionsBox) suggestionsBox.style.display = 'none';
      if (!lib) return;

      try {
        const books = lib.books && lib.books.length ? lib.books : await fetchBibleApiBooks(lib.translationId);
        let matches = [];
        if (parsed) {
          const book = findBibleApiBook(parsed.book, books);
          if (!book) {
            currentBibleSearchResult = null;
            renderBibleSearchResult('No API book match yet. Keep typing and choose from suggestions.');
            return;
          }
          setBibleApiStatus('Online Bible API: fetching ' + (book.commonName || book.name) + ' ' + parsed.chapter + '...');
          const verses = await fetchBibleApiChapter(lib.translationId, book.id, parsed.chapter);
          matches = verses.filter(entry => entry.verse >= parsed.verse && entry.verse <= (parsed.endVerse || parsed.verse));
        }

        if (!matches.length) {
          const suggestions = await buildBibleApiSuggestions(query);
          const first = suggestions.find(item => item.entry);
          if (first && first.entry) {
            matches = [first.entry];
            if (input) input.value = first.entry.reference;
          }
        }

        if (!matches.length) {
          currentBibleSearchResult = null;
          renderBibleSearchResult('No API result yet. Type a reference like Genesis 1:1 or choose from suggestions.');
          updateBibleSuggestions();
          return;
        }

        currentBibleSearchResult = {
          book: matches[0].book,
          chapter: matches[0].chapter,
          verse: matches[0].verse,
          reference: matches.length > 1 ? `${matches[0].book} ${matches[0].chapter}:${matches[0].verse}-${matches[matches.length - 1].verse}` : matches[0].reference,
          text: matches.map(m => m.text).join(' '),
          sourceLabel: lib.label,
          apiMode: true,
          bibleKey: activeBibleKey
        };
        setBibleApiStatus('Online Bible API: loaded ' + currentBibleSearchResult.reference + '. Nothing was saved to Firebase.');
        renderBibleSearchResult();
      } catch (error) {
        currentBibleSearchResult = null;
        renderBibleSearchResult('API lookup failed: ' + (error && error.message ? error.message : 'network error'));
        setBibleApiStatus('Online Bible API: lookup failed - ' + (error && error.message ? error.message : 'network error'), true);
      }
    };

    const apiOriginalRenderBibleSearchResult = renderBibleSearchResult;
    renderBibleSearchResult = function(message = '') {
      if (!isActiveBibleApiMode()) return apiOriginalRenderBibleSearchResult(message);
      const resultBox = document.getElementById('bible-search-result');
      if (!resultBox) return;
      if (message) { resultBox.innerHTML = `<div style="color: var(--accent-red);">${escapeHtml(message)}</div>`; return; }
      const lib = getActiveBibleApiLibrary();
      if (!currentBibleSearchResult) {
        resultBox.innerHTML = `<div style="color: var(--text-muted);">${escapeHtml(lib.label)} online API mode is active. Type freely to search; verses are fetched live and are not saved to Firebase.</div>`;
        return;
      }
      resultBox.innerHTML = `
        <div style="font-weight: 700; color: var(--text);">${escapeHtml(currentBibleSearchResult.reference)}</div>
        <div style="margin-top: 6px; color: var(--text-muted);">${escapeHtml(currentBibleSearchResult.text)}</div>
      `;
    };

    const apiOriginalBibleResultToPayload = bibleResultToPayload;
    bibleResultToPayload = function(result, bible) {
      const payload = apiOriginalBibleResultToPayload(result, bible);
      if (result && result.apiMode) {
        payload.apiMode = true;
        payload.book = result.book;
        payload.chapter = Number(result.chapter) || 1;
        payload.verse = Number(result.verse) || 1;
        payload.bibleKey = result.bibleKey || activeBibleKey || '';
      }
      return payload;
    };

    const apiOriginalCanNavigateLiveBible = canNavigateLiveBible;
    canNavigateLiveBible = function(delta) {
      if (liveState && liveState.type === 'bible' && liveState.value && liveState.value.apiMode) return true;
      return apiOriginalCanNavigateLiveBible(delta);
    };

    const apiOriginalNavigateLiveBibleVerse = navigateLiveBibleVerse;
    navigateLiveBibleVerse = async function(delta) {
      if (!(liveState && liveState.type === 'bible' && liveState.value && liveState.value.apiMode)) return apiOriginalNavigateLiveBibleVerse(delta);
      const meta = getBiblePayloadMeta(liveState);
      const lib = bibleLibraries[meta.bibleKey] || getActiveBibleApiLibrary();
      if (!lib || !lib.apiMode) return;
      try {
        const books = lib.books && lib.books.length ? lib.books : await fetchBibleApiBooks(lib.translationId);
        const book = findBibleApiBook(meta.book, books);
        if (!book) return;
        let verses = await fetchBibleApiChapter(lib.translationId, book.id, meta.chapter);
        let currentIndex = verses.findIndex(v => Number(v.verse) === Number(meta.verse));
        let nextEntry = verses[currentIndex + delta] || null;
        if (!nextEntry) {
          const orderedBooks = books.slice().sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
          const bookIndex = orderedBooks.findIndex(b => b.id === book.id);
          let nextBook = book;
          let nextChapter = meta.chapter + delta;
          if (delta > 0 && nextChapter > Number(book.lastChapterNumber || book.numberOfChapters || meta.chapter)) {
            nextBook = orderedBooks[bookIndex + 1];
            nextChapter = nextBook ? Number(nextBook.firstChapterNumber || 1) : null;
          }
          if (delta < 0 && nextChapter < Number(book.firstChapterNumber || 1)) {
            nextBook = orderedBooks[bookIndex - 1];
            nextChapter = nextBook ? Number(nextBook.lastChapterNumber || nextBook.numberOfChapters || 1) : null;
          }
          if (!nextBook || !nextChapter) return;
          const nextVerses = await fetchBibleApiChapter(lib.translationId, nextBook.id, nextChapter);
          nextEntry = delta > 0 ? nextVerses[0] : nextVerses[nextVerses.length - 1];
        }
        if (!nextEntry) return;
        const result = {
          book: nextEntry.book,
          chapter: nextEntry.chapter,
          verse: nextEntry.verse,
          reference: nextEntry.reference,
          text: nextEntry.text,
          sourceLabel: lib.label,
          apiMode: true,
          bibleKey: lib.key
        };
        const payloadValue = bibleResultToPayload(result, lib);
        liveState = { type: 'bible', value: payloadValue, name: result.reference, category: lib.label, sceneItemIndex: -1, page: 1, videoTime: 0, videoPlaying: false };
        currentBibleSearchResult = result;
        const searchInput = document.getElementById('bible-search-input');
        if (searchInput) searchInput.value = result.reference;
        renderBibleSearchResult();
        await renderLiveView();
        channel.postMessage({ command: 'UPDATE_LIVE_BIBLE_VERSE', payload: liveState });
      } catch (error) {
        setBibleApiStatus('Online Bible API: verse navigation failed - ' + (error && error.message ? error.message : 'network error'), true);
      }
    };

    /* Firebase is enabled again only for chosen local Bible files/folders. Online API Bible text remains live-only and is not uploaded. */
    window.addEventListener('DOMContentLoaded', () => {
      injectBibleApiControls();
      setBibleFirebaseStatus('Firebase: local file/folder Bible save ready. Online API Bible text is not saved.');
    });


    /* V12 PDF rendering patch: keep the current frame visible while the next page renders,
       reuse opened PDF documents/pages, and resolve large PDFs from IndexedDB in the output window. */
    const v12PdfDocumentCache = new Map();
    const v12PdfBlobUrlCache = new Map();
    const v12PdfPageCache = new Map();
    let v12PdfRenderSequence = 0;

    function v12PdfIdentity(payload) {
      return String((payload && (payload.itemId || payload.id || payload.name || payload.value)) || 'pdf');
    }

    async function v12ResolvePdfSource(payload) {
      if (!payload) return null;
      if (payload.pdfData instanceof ArrayBuffer && payload.pdfData.byteLength) {
        return { data: payload.pdfData.slice(0) };
      }

      const itemId = payload.itemId || payload.id || '';
      if (itemId) {
        if (v12PdfBlobUrlCache.has(itemId)) return v12PdfBlobUrlCache.get(itemId);
        try {
          const cached = await loadPdfFromPersistentCache(itemId);
          if (cached && cached.pdfBlob) {
            const url = URL.createObjectURL(cached.pdfBlob);
            v12PdfBlobUrlCache.set(itemId, url);
            return url;
          }
        } catch (error) {
          console.warn('Unable to restore PDF from persistent cache:', error);
        }
      }

      return payload.value || null;
    }

    async function v12GetPdfDocument(payload) {
      const key = v12PdfIdentity(payload);
      if (v12PdfDocumentCache.has(key)) return v12PdfDocumentCache.get(key);
      const promise = (async () => {
        const source = await v12ResolvePdfSource(payload);
        if (!source) throw new Error('PDF source unavailable');
        return pdfjsLib.getDocument(source).promise;
      })();
      v12PdfDocumentCache.set(key, promise);
      try {
        return await promise;
      } catch (error) {
        v12PdfDocumentCache.delete(key);
        throw error;
      }
    }

    function v12RememberRenderedPage(key, canvas) {
      v12PdfPageCache.set(key, canvas);
      while (v12PdfPageCache.size > 18) {
        const oldest = v12PdfPageCache.keys().next().value;
        v12PdfPageCache.delete(oldest);
      }
    }

    async function v12RenderPdfCanvas(payload, target, qualityMode) {
      const doc = await v12GetPdfDocument(payload);
      const pageNum = Math.max(1, Math.min(Number(payload.page) || 1, doc.numPages));
      const width = Math.max(320, target.clientWidth || window.innerWidth || 1280);
      const height = Math.max(180, target.clientHeight || window.innerHeight || 720);
      const density = qualityMode === 'audience' ? Math.min(2, window.devicePixelRatio || 1) : 1.25;
      const cacheKey = `${v12PdfIdentity(payload)}|${pageNum}|${Math.round(width)}x${Math.round(height)}|${qualityMode}`;
      const cachedCanvas = v12PdfPageCache.get(cacheKey);
      if (cachedCanvas) {
        const copy = document.createElement('canvas');
        copy.width = cachedCanvas.width;
        copy.height = cachedCanvas.height;
        copy.getContext('2d', { alpha: false }).drawImage(cachedCanvas, 0, 0);
        return { canvas: copy, pageNum, totalPages: doc.numPages };
      }

      const page = await doc.getPage(pageNum);
      const base = page.getViewport({ scale: 1 });
      const fitScale = Math.min(width / base.width, height / base.height);
      const scale = Math.max(0.75, fitScale * density);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      v12RememberRenderedPage(cacheKey, canvas);

      const output = document.createElement('canvas');
      output.width = canvas.width;
      output.height = canvas.height;
      output.getContext('2d', { alpha: false }).drawImage(canvas, 0, 0);
      return { canvas: output, pageNum, totalPages: doc.numPages };
    }

    const v12OriginalRenderMediaIntoViewport = renderMediaIntoViewport;
    renderMediaIntoViewport = async function(target, payload, options = {}) {
      if (!(payload && payload.type === 'pdf')) {
        return v12OriginalRenderMediaIntoViewport(target, payload, options);
      }

      const renderToken = String(++v12PdfRenderSequence);
      target.dataset.v12PdfRenderToken = renderToken;
      try {
        const result = await v12RenderPdfCanvas(payload, target, target.id === 'live-viewport' ? 'live' : 'preview');
        if (target.dataset.v12PdfRenderToken !== renderToken) return;

        const existingLabel = target.querySelector('.viewport-label');
        const frame = document.createElement('div');
        frame.className = 'v12-pdf-frame';
        frame.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#000;opacity:0;transition:opacity 140ms ease-out;';
        result.canvas.style.width = '100%';
        result.canvas.style.height = '100%';
        result.canvas.style.objectFit = 'contain';
        frame.appendChild(result.canvas);

        target.querySelectorAll('.v12-pdf-frame').forEach((old) => {
          old.style.zIndex = '1';
        });
        frame.style.zIndex = '2';
        target.appendChild(frame);
        requestAnimationFrame(() => { frame.style.opacity = '1'; });

        setTimeout(() => {
          if (target.dataset.v12PdfRenderToken !== renderToken) return;
          Array.from(target.children).forEach((child) => {
            if (child === frame || child === existingLabel || child.classList.contains('live-monitor-overlay') || child.classList.contains('pdf-live-nav')) return;
            child.remove();
          });
          target.querySelectorAll('.v12-pdf-frame').forEach((old) => { if (old !== frame) old.remove(); });
        }, 170);

        if (!options.readOnly) {
          staged.page = result.pageNum;
          pdfDoc = await v12GetPdfDocument(payload);
        }
        if (options.readOnly && target.id === 'live-viewport') {
          addPdfLiveNavigation(target, result.pageNum, result.totalPages);
        }
        return result;
      } catch (error) {
        console.error('PDF rendering failed:', error);
        // Keep the previous visible frame instead of replacing it with a loading/error message.
        if (!target.querySelector('.v12-pdf-frame, canvas')) {
          const fallback = document.createElement('div');
          fallback.style.cssText = 'color:#ccc;padding:16px;text-align:center;';
          fallback.textContent = 'PDF could not be rendered.';
          target.appendChild(fallback);
        }
      }
    };

    const v12OriginalBuildAudienceMediaLayer = buildAudienceMediaLayer;
    buildAudienceMediaLayer = async function(payload) {
      if (!(payload && payload.type === 'pdf')) return v12OriginalBuildAudienceMediaLayer(payload);
      const layer = document.createElement('div');
      layer.className = 'audience-media-layer';
      layer.style.zIndex = '10';
      const result = await v12RenderPdfCanvas(payload, document.getElementById('audience-view') || document.body, 'audience');
      result.canvas.style.width = '100%';
      result.canvas.style.height = '100%';
      result.canvas.style.objectFit = 'contain';
      layer.appendChild(result.canvas);
      return layer;
    };

    navigateLivePdf = async function(delta) {
      if (!liveState || liveState.type !== 'pdf') return;
      try {
        const doc = await v12GetPdfDocument(liveState);
        const nextPage = Math.max(1, Math.min((Number(liveState.page) || 1) + delta, doc.numPages));
        if (nextPage === Number(liveState.page || 1)) return;
        liveState.page = nextPage;
        await renderLiveView();
        channel.postMessage({ command: 'UPDATE_LIVE_PDF_PAGE', payload: clonePresenterPayload(liveState) });
      } catch (error) {
        console.warn('Unable to navigate live PDF:', error);
      }
    };

    // Warm the next and previous PDF pages after each selection so navigation feels immediate.
    async function v12PreloadAdjacentPdfPages(payload) {
      if (!(payload && payload.type === 'pdf')) return;
      try {
        const doc = await v12GetPdfDocument(payload);
        const current = Math.max(1, Math.min(Number(payload.page) || 1, doc.numPages));
        const previewTarget = document.getElementById('preview-viewport');
        for (const pageNum of [current - 1, current + 1]) {
          if (pageNum < 1 || pageNum > doc.numPages) continue;
          const preloadPayload = Object.assign({}, payload, { page: pageNum });
          v12RenderPdfCanvas(preloadPayload, previewTarget, 'preview').catch(() => {});
        }
      } catch (e) {}
    }

    const v12OriginalRenderPreview = renderPreview;
    renderPreview = async function() {
      const result = await v12OriginalRenderPreview();
      v12PreloadAdjacentPdfPages(staged);
      return result;
    };



    /* V13: shared scenes with Local / Online storage sources and Drive file management. */
    const LS_STORAGE_MODE = 'jil_presenter_storage_mode_v1';
    let currentStorageMode = localStorage.getItem(LS_STORAGE_MODE) || 'local';
    let onlineDriveFilesCache = [];

    function setStorageMode(mode) {
      currentStorageMode = mode === 'online' ? 'online' : 'local';
      localStorage.setItem(LS_STORAGE_MODE, currentStorageMode);
      const online = currentStorageMode === 'online';
      const title = document.getElementById('storage-source-title');
      if (title) title.textContent = online ? 'Online Folder Link' : 'Local Folder Link';
      const localPanel = document.getElementById('local-folder-panel');
      const onlinePanel = document.getElementById('online-folder-panel');
      if (localPanel) localPanel.style.display = online ? 'none' : '';
      if (onlinePanel) onlinePanel.style.display = online ? '' : 'none';
      const localPicker = document.getElementById('local-media-picker-wrap');
      const onlineTools = document.getElementById('online-media-tools');
      if (localPicker) localPicker.style.display = online ? 'none' : '';
      if (onlineTools) onlineTools.style.display = online ? '' : 'none';
      const badge = document.getElementById('media-assets-source-badge');
      if (badge) badge.textContent = online ? 'Google Drive' : 'Local storage';
      const canvaPdfOnlineOnly = document.getElementById('canva-pdf-online-only');
      if (canvaPdfOnlineOnly) canvaPdfOnlineOnly.style.display = online ? '' : 'none';
      document.getElementById('storage-mode-local')?.classList.toggle('active', !online);
      document.getElementById('storage-mode-online')?.classList.toggle('active', online);
      // Scenes and existing scene items intentionally remain untouched.
    }

    function chooseOnlineMediaFiles(){ document.getElementById('online-media-uploader')?.click(); }
    function setOnlineUploadProgress(percent, detail=''){
      const wrap=document.getElementById('online-upload-progress'); const bar=document.getElementById('online-upload-progress-bar'); const label=document.getElementById('online-upload-progress-label');
      const p=Math.max(0,Math.min(100,Number(percent)||0)); wrap?.classList.add('show'); label?.classList.add('show'); if(bar)bar.style.width=p+'%'; if(label)label.textContent=Math.round(p)+'%'+(detail?' · '+detail:'');
    }

    async function getDriveFilesFromBackend(force=false){
      if (!force && onlineDriveFilesCache.length) return onlineDriveFilesCache;
      const url=GOOGLE_SCRIPT_PDF_UPLOAD_URL+(GOOGLE_SCRIPT_PDF_UPLOAD_URL.includes('?')?'&':'?')+'action=listFiles&_='+Date.now();
      const response=await fetch(url,{cache:'no-store',redirect:'follow'}); const text=await response.text(); let data;
      try{data=JSON.parse(text)}catch(e){throw new Error('Apps Script file listing is not enabled. Deploy the supplied V4 backend.');}
      if(!response.ok||!data||data.success===false||!Array.isArray(data.files)) throw new Error(data?.error||'Unable to list files.');
      onlineDriveFilesCache=data.files; return onlineDriveFilesCache;
    }

    function driveFileType(file){const mime=String(file?.mimeType||'').toLowerCase(),name=String(file?.name||'').toLowerCase();if(mime.includes('pdf')||name.endsWith('.pdf'))return'pdf';if(mime.startsWith('image/'))return'image';if(mime.startsWith('video/'))return'video';if(mime.startsWith('audio/'))return'audio';return'file';}
    function driveFileIcon(type){return {pdf:'📄',image:'🖼️',video:'🎬',audio:'🎵',file:'🗂️'}[type]||'🗂️';}
    function driveFilePreviewHtml(file){const type=driveFileType(file);if(type==='image'&&file.thumbnailUrl)return `<img src="${escapeHtml(file.thumbnailUrl)}" alt="">`;return `<span>${driveFileIcon(type)}</span>`;}

    async function addDriveFileToActiveScene(file){
      const scene=getActiveScene(); if(!scene) return;
      const type=driveFileType(file); const itemId=uid();
      const item={id:itemId,type:type==='file'||type==='audio'?'url':type,name:file.name||'Drive file',value:file.downloadUrl||file.webViewLink||'',googleDrive:{fileId:file.id,driveUrl:file.webViewLink||'',previewUrl:file.previewUrl||'',downloadUrl:file.downloadUrl||'',mimeType:file.mimeType||'',size:file.size||0,uploadedAt:file.createdTime||new Date().toISOString(),source:'online-folder'}};
      if(type==='pdf'){
        try{
          setCanvaPdfUploadStatus('Downloading '+item.name+' from Google Drive for reliable PDF preview...');
          const r=await fetch(file.downloadUrl,{redirect:'follow'}); if(!r.ok)throw new Error('Drive download failed ('+r.status+')'); const blob=await r.blob();
          item.value=URL.createObjectURL(blob); item.pdfData=blob.size<=60*1024*1024?await blob.arrayBuffer():null; await savePdfToPersistentCache(itemId,item.name,blob,item.googleDrive);
        }catch(e){
          item.value=file.downloadUrl||file.previewUrl||file.webViewLink||'';
          setCanvaPdfUploadStatus('Added to scene, but local PDF caching was blocked. The Drive file remains linked.','error');
        }
      }
      scene.items.push(item); persistScenes(); renderSceneDeckUI(); setStagedFromSceneIndex(scene.items.length-1); closeOnlineFilesModal(); closeDrivePdfModal();
    }

    async function uploadOneOnlineFile(file, fileIndex, totalFiles){
      const init=await postGoogleScriptJson({action:'initResumableFileUpload',fileName:file.name,mimeType:file.type||'application/octet-stream',fileSize:file.size});
      const chunkSize=8*1024*1024; let offset=0,finalResult={};
      while(offset<file.size){const chunk=file.slice(offset,Math.min(offset+chunkSize,file.size),file.type||'application/octet-stream');const start=offset;const result=await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('PUT',init.uploadUrl,true);xhr.setRequestHeader('Content-Type',file.type||'application/octet-stream');xhr.setRequestHeader('Content-Range',`bytes ${start}-${start+chunk.size-1}/${file.size}`);xhr.upload.onprogress=e=>{if(e.lengthComputable){const within=(start+e.loaded)/file.size;const all=((fileIndex+within)/totalFiles)*100;setOnlineUploadProgress(all,`${fileIndex+1}/${totalFiles} · ${formatFileBytes(start+e.loaded)} / ${formatFileBytes(file.size)}`)}};xhr.onerror=()=>reject(new Error('Network error while uploading '+file.name));xhr.onload=()=>{if([200,201,308].includes(xhr.status)){let obj={};try{obj=JSON.parse(xhr.responseText||'{}')}catch(e){}resolve(obj)}else reject(new Error('Drive rejected '+file.name+' ('+xhr.status+')'))};xhr.send(chunk)});offset+=chunk.size;if(result&&Object.keys(result).length)finalResult=result;}
      return finalResult;
    }

    async function uploadOnlineMediaFiles(event){
      const input=event?.target; const files=Array.from(input?.files||[]); if(!files.length)return;
      try{
        await verifyGoogleScriptResumableBackend();
        for(let i=0;i<files.length;i++)await uploadOneOnlineFile(files[i],i,files.length);
        setOnlineUploadProgress(100,files.length+' file'+(files.length===1?'':'s')+' uploaded'); onlineDriveFilesCache=[]; document.getElementById('online-folder-status').textContent='✅ Upload complete. Files are available in the online folder.';
        await getDriveFilesFromBackend(true);
      }catch(e){
        const raw=String(e&&e.message?e.message:e||'Upload failed');
        const permissionProblem=/UrlFetchApp\.fetch|script\.external_request|pahintulot|permission/i.test(raw);
        document.getElementById('online-folder-status').textContent=permissionProblem
          ? '⚠️ Google Apps Script needs one-time authorization for large file uploads. Run authorizeBackend() in Apps Script, approve access, then redeploy the current web app version.'
          : '⚠️ '+raw;
      }
      finally{if(input)input.value='';setTimeout(()=>{document.getElementById('online-upload-progress')?.classList.remove('show');document.getElementById('online-upload-progress-label')?.classList.remove('show')},2200)}
    }

    function renderDriveFileCards(files,targetId){
      const list=document.getElementById(targetId); if(!list)return;
      if(!files.length){list.innerHTML='<div style="grid-column:1/-1;color:var(--text-muted);padding:22px;text-align:center;">No matching files are available.</div>';return;}
      list.innerHTML=files.map((file,index)=>{const type=driveFileType(file);return `<div class="drive-pdf-card"><button class="drive-file-delete" title="Delete from Google Drive" onclick="deleteOnlineDriveFile('${escapeHtml(file.id)}')">🗑</button><div class="drive-file-thumb">${driveFilePreviewHtml(file)}</div><div class="drive-file-kind">${escapeHtml(type)}</div><div class="drive-pdf-card-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div><div class="drive-pdf-card-meta">${escapeHtml(formatFileBytes(file.size||0))}<br>${escapeHtml(file.createdTime?new Date(file.createdTime).toLocaleString():'')}</div><div class="drive-pdf-card-actions"><button onclick="addDriveFileToActiveScene(onlineDriveFilesCache.find(f=>f.id==='${escapeHtml(file.id)}'))">Add to Scene</button>${file.webViewLink?`<button style="background:var(--accent-purple)" onclick="window.open('${escapeHtml(file.webViewLink)}','_blank','noopener')">View</button>`:''}</div></div>`}).join('');
    }

    async function openOnlineFilesModal(){const modal=document.getElementById('online-files-modal');modal?.classList.add('open');const list=document.getElementById('online-files-list');if(list)list.innerHTML='<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted)">Loading files...</div>';try{renderDriveFileCards(await getDriveFilesFromBackend(false),'online-files-list')}catch(e){if(list)list.innerHTML='<div style="grid-column:1/-1;color:var(--accent-red);padding:20px">'+escapeHtml(e.message||e)+'</div>'}}
    function closeOnlineFilesModal(){document.getElementById('online-files-modal')?.classList.remove('open')}
    async function refreshOnlineFilesModal(){onlineDriveFilesCache=[];await openOnlineFilesModal()}

    async function deleteOnlineDriveFile(fileId,fileName){
      if(!fileId)return; const matchedFile=onlineDriveFilesCache.find(f=>f.id===fileId); fileName=fileName||(matchedFile&&matchedFile.name)||'this file'; const answer=await showModal('Delete File',`Delete "${fileName}" from cloud storage and remove it from all scenes?`,false);if(!answer?.confirmed)return;
      try{await postGoogleScriptJson({action:'deleteDriveFile',fileId});
        for(const scene of scenes){const removed=(scene.items||[]).filter(i=>i.googleDrive?.fileId===fileId);for(const item of removed)if(item.type==='pdf')await removePdfFromPersistentCache(item.id);scene.items=(scene.items||[]).filter(i=>i.googleDrive?.fileId!==fileId)}
        if(staged?.googleDrive?.fileId===fileId)staged={type:'none',value:null,sceneItemIndex:-1,page:1,videoTime:0,videoPlaying:false}; if(liveState?.googleDrive?.fileId===fileId)liveState={type:'none',value:null,sceneItemIndex:-1,page:1,videoTime:0,videoPlaying:false};
        persistScenes();renderSceneDeckUI();renderPreview();renderLiveView();setSlideStatus();onlineDriveFilesCache=onlineDriveFilesCache.filter(f=>f.id!==fileId);renderDrivePdfList();renderDriveFileCards(onlineDriveFilesCache,'online-files-list');
      }catch(e){showModal('Delete Failed',e.message||String(e),false)}
    }

    const v13OriginalRenderDrivePdfList=renderDrivePdfList;
    renderDrivePdfList=async function(){
      const list=document.getElementById('drive-pdf-list');if(!list)return;list.innerHTML='<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted)">Loading files...</div>';
      try{const files=await getDriveFilesFromBackend(false);const pdfOnly=document.getElementById('drive-pdf-only-filter')?.checked!==false;renderDriveFileCards(pdfOnly?files.filter(f=>driveFileType(f)==='pdf'):files,'drive-pdf-list')}
      catch(e){v13OriginalRenderDrivePdfList(); const records=collectDrivePdfRecords(); if(records.length){const note=document.createElement('div');note.style.cssText='grid-column:1/-1;color:var(--accent-red);padding:8px';note.textContent='Cloud list unavailable: '+(e.message||e)+'. Showing locally recorded PDFs.';list.prepend(note)}}
    };
    async function refreshDriveFilesForViewer(){onlineDriveFilesCache=[];await renderDrivePdfList()}

    const v13OriginalOpenDrivePdfModal=openDrivePdfModal;
    openDrivePdfModal=function(){document.getElementById('drive-pdf-modal')?.classList.add('open');renderDrivePdfList()};


    /* V14: restore Google Drive media links after refresh without changing scenes. */
    async function restoreOnlineSceneAssetsFromDrive(){
      const onlineItems=[];
      for(const scene of scenes){
        for(const item of (scene.items||[])){
          if(item&&item.googleDrive&&item.googleDrive.fileId) onlineItems.push(item);
        }
      }
      if(!onlineItems.length) return 0;
      try{
        const files=await getDriveFilesFromBackend(true);
        const byId=new Map(files.map(file=>[String(file.id||file.fileId||''),file]));
        let restored=0;
        for(const item of onlineItems){
          const file=byId.get(String(item.googleDrive.fileId||''));
          if(!file) continue;
          item.googleDrive=Object.assign({},item.googleDrive,{
            driveUrl:file.webViewLink||file.driveUrl||item.googleDrive.driveUrl||'',
            previewUrl:file.previewUrl||item.googleDrive.previewUrl||'',
            downloadUrl:file.downloadUrl||file.directUrl||item.googleDrive.downloadUrl||'',
            mimeType:file.mimeType||item.googleDrive.mimeType||'',
            size:file.size||item.googleDrive.size||0,
            source:'online-folder'
          });
          if(item.type==='pdf'){
            if(!item.value) item.value=item.googleDrive.downloadUrl||item.googleDrive.previewUrl||item.googleDrive.driveUrl||'';
          }else if(item.type==='image'||item.type==='video'){
            item.value=file.downloadUrl||file.directUrl||file.webViewLink||item.value||'';
          }else if(item.type==='url'){
            item.value=file.previewUrl||file.webViewLink||file.downloadUrl||item.value||'';
          }
          restored+=1;
        }
        if(restored){
          persistScenes();
          renderSceneDeckUI();
          if(staged&&staged.sceneItemIndex>=0){
            const deck=getActiveDeck();
            const current=deck[staged.sceneItemIndex];
            if(current&&current.googleDrive&&current.googleDrive.fileId){
              staged.value=current.value;
              staged.googleDrive=current.googleDrive;
              renderPreview();
            }
          }
        }
        return restored;
      }catch(error){
        console.warn('Online assets will retry when the Drive backend is available:',error);
        return 0;
      }
    }

    const v14OriginalLoadScenes=loadScenes;
    loadScenes=async function(){
      await v14OriginalLoadScenes();
      await restoreOnlineSceneAssetsFromDrive();
    };

    window.addEventListener('DOMContentLoaded',()=>setStorageMode(currentStorageMode));

    /* V15: verify successful Drive uploads and render persistent online PDFs/videos. */
    function getDrivePreviewUrl(fileLike) {
      const drive = (fileLike && fileLike.googleDrive) || fileLike || {};
      const fileId = drive.fileId || drive.id || '';
      return drive.previewUrl || drive.embedUrl || (fileId ? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview` : '') || drive.driveUrl || drive.webViewLink || '';
    }

    function getDriveDownloadUrl(fileLike) {
      const drive = (fileLike && fileLike.googleDrive) || fileLike || {};
      const fileId = drive.fileId || drive.id || '';
      return drive.downloadUrl || drive.directUrl || (fileId ? `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}` : '') || '';
    }

    function driveRecordMatchesUpload(record, file) {
      if (!record || !file) return false;
      const sameName = String(record.name || record.fileName || '').trim() === String(file.name || '').trim();
      const listedSize = Number(record.size || 0);
      const sameSize = !listedSize || !file.size || listedSize === Number(file.size);
      return sameName && sameSize;
    }

    async function verifyUploadedDriveFile(file, attempts = 7) {
      let lastError = null;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          onlineDriveFilesCache = [];
          const files = await getDriveFilesFromBackend(true);
          const match = files.find(record => driveRecordMatchesUpload(record, file));
          if (match) return match;
        } catch (error) {
          lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 700 + attempt * 350));
      }
      if (lastError) console.warn('Drive verification warning:', lastError);
      return null;
    }

    uploadOneOnlineFile = async function(file, fileIndex, totalFiles) {
      const init = await postGoogleScriptJson({
        action: 'initResumableFileUpload',
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        fileSize: file.size
      });

      const chunkSize = 8 * 1024 * 1024;
      let offset = 0;
      let finalResult = {};

      while (offset < file.size) {
        const chunk = file.slice(offset, Math.min(offset + chunkSize, file.size), file.type || 'application/octet-stream');
        const start = offset;
        try {
          const result = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('PUT', init.uploadUrl, true);
            xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
            xhr.setRequestHeader('Content-Range', `bytes ${start}-${start + chunk.size - 1}/${file.size}`);
            xhr.timeout = 180000;
            xhr.upload.onprogress = event => {
              if (!event.lengthComputable) return;
              const within = (start + event.loaded) / file.size;
              const all = ((fileIndex + within) / totalFiles) * 100;
              setOnlineUploadProgress(all, `${fileIndex + 1}/${totalFiles} · ${formatFileBytes(start + event.loaded)} / ${formatFileBytes(file.size)}`);
            };
            xhr.onload = () => {
              if ([200, 201, 308].includes(xhr.status)) {
                let parsed = {};
                try { parsed = JSON.parse(xhr.responseText || '{}'); } catch (error) {}
                resolve(parsed);
              } else {
                reject(new Error(`Drive rejected ${file.name} (${xhr.status})`));
              }
            };
            xhr.onerror = () => reject(new Error(`Upload response was interrupted for ${file.name}`));
            xhr.ontimeout = () => reject(new Error(`Upload response timed out for ${file.name}`));
            xhr.send(chunk);
          });
          offset += chunk.size;
          if (result && Object.keys(result).length) finalResult = result;
        } catch (error) {
          // Google Drive can finish the final chunk even when the browser cannot read
          // its final cross-origin response. Verify the file before reporting failure.
          const verified = await verifyUploadedDriveFile(file, 5);
          if (verified) {
            setOnlineUploadProgress(((fileIndex + 1) / totalFiles) * 100, `${fileIndex + 1}/${totalFiles} · upload verified`);
            return verified;
          }
          throw error;
        }
      }

      const verified = await verifyUploadedDriveFile(file, 7);
      if (verified) return verified;
      if (finalResult && (finalResult.id || finalResult.fileId)) return finalResult;
      throw new Error(`Google Drive received ${file.name}, but the presenter could not verify it yet. Open View Files and refresh.`);
    };

    async function attachUploadedOnlineFileToScene(record, sourceFile) {
      const scene = getActiveScene();
      if (!scene || !record) return null;
      const fileId = record.id || record.fileId || '';
      if (fileId && (scene.items || []).some(item => item.googleDrive && String(item.googleDrive.fileId) === String(fileId))) {
        return scene.items.find(item => item.googleDrive && String(item.googleDrive.fileId) === String(fileId));
      }

      const type = driveFileType(record);
      const itemId = uid();
      const driveMeta = {
        fileId,
        driveUrl: record.webViewLink || record.driveUrl || '',
        previewUrl: record.previewUrl || getDrivePreviewUrl(record),
        downloadUrl: record.downloadUrl || record.directUrl || getDriveDownloadUrl(record),
        mimeType: record.mimeType || (sourceFile && sourceFile.type) || '',
        size: Number(record.size || (sourceFile && sourceFile.size) || 0),
        uploadedAt: record.createdTime || new Date().toISOString(),
        source: 'online-folder'
      };

      const item = {
        id: itemId,
        type: type === 'file' || type === 'audio' ? 'url' : type,
        name: record.name || record.fileName || (sourceFile && sourceFile.name) || 'Drive file',
        value: driveMeta.previewUrl || driveMeta.downloadUrl || driveMeta.driveUrl,
        googleDrive: driveMeta,
        page: 1,
        videoTime: 0,
        videoPlaying: false
      };

      if (sourceFile) {
        if (type === 'pdf') {
          try {
            item.value = URL.createObjectURL(sourceFile);
            item.pdfData = sourceFile.size <= 60 * 1024 * 1024 ? await sourceFile.arrayBuffer() : null;
            await savePdfToPersistentCache(itemId, item.name, sourceFile, driveMeta);
          } catch (error) {
            console.warn('Large PDF local cache was unavailable; using Drive preview instead.', error);
            item.value = driveMeta.previewUrl || driveMeta.downloadUrl || driveMeta.driveUrl;
          }
        } else if (type === 'video' || type === 'image' || type === 'audio') {
          item.value = URL.createObjectURL(sourceFile);
        }
      }

      scene.items.push(item);
      persistScenes();
      renderSceneDeckUI();
      setStagedFromSceneIndex(scene.items.length - 1);
      return item;
    }

    uploadOnlineMediaFiles = async function(event) {
      const input = event && event.target;
      const files = Array.from((input && input.files) || []);
      if (!files.length) return;
      const uploaded = [];
      try {
        await verifyGoogleScriptResumableBackend();
        for (let index = 0; index < files.length; index += 1) {
          const record = await uploadOneOnlineFile(files[index], index, files.length);
          uploaded.push(record);
          await attachUploadedOnlineFileToScene(record, files[index]);
        }
        setOnlineUploadProgress(100, `${files.length} file${files.length === 1 ? '' : 's'} uploaded and added to the active scene`);
        onlineDriveFilesCache = [];
        const status = document.getElementById('online-folder-status');
        if (status) status.textContent = '✅ Upload verified. The files are saved in Google Drive and attached to the active scene.';
        await getDriveFilesFromBackend(true);
      } catch (error) {
        const raw = String(error && error.message ? error.message : error || 'Upload failed');
        const permissionProblem = /UrlFetchApp\.fetch|script\.external_request|pahintulot|permission/i.test(raw);
        const status = document.getElementById('online-folder-status');
        if (status) status.textContent = permissionProblem
          ? '⚠️ Google Apps Script needs one-time authorization. Run authorizeBackend(), approve access, and redeploy.'
          : `⚠️ ${raw}`;
      } finally {
        if (input) input.value = '';
        setTimeout(() => {
          document.getElementById('online-upload-progress')?.classList.remove('show');
          document.getElementById('online-upload-progress-label')?.classList.remove('show');
        }, 3200);
      }
    };

    function shouldUseDriveEmbed(payload) {
      if (!payload || !payload.googleDrive || !payload.googleDrive.fileId) return false;
      if (!['pdf', 'video'].includes(payload.type)) return false;
      const value = String(payload.value || '');
      if (value.startsWith('blob:') || value.startsWith('data:')) return false;
      if (payload.type === 'pdf' && payload.pdfData) return false;
      return Boolean(getDrivePreviewUrl(payload));
    }

    async function renderDriveEmbedIntoViewport(target, payload, options = {}) {
      const previewUrl = getDrivePreviewUrl(payload);
      if (!target || !previewUrl) return false;
      const oldContent = Array.from(target.children).filter(node => !node.classList?.contains('viewport-label') && !node.classList?.contains('live-monitor-overlay'));
      const frame = document.createElement('iframe');
      frame.src = previewUrl;
      frame.className = 'drive-online-preview-frame';
      frame.setAttribute('allow', 'autoplay; fullscreen');
      frame.setAttribute('allowfullscreen', '');
      frame.setAttribute('scrolling', 'no');
      frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;opacity:0;transition:opacity .22s ease;';
      target.appendChild(frame);
      await new Promise(resolve => {
        let settled = false;
        const finish = () => { if (!settled) { settled = true; resolve(); } };
        frame.onload = finish;
        setTimeout(finish, 2400);
      });
      oldContent.forEach(node => node.remove());
      frame.style.opacity = '1';
      return true;
    }

    const v15OriginalRenderMediaIntoViewport = renderMediaIntoViewport;
    renderMediaIntoViewport = async function(target, payload, options = {}) {
      if (shouldUseDriveEmbed(payload)) {
        await renderDriveEmbedIntoViewport(target, payload, options);
        if (target && target.id === 'live-viewport') updateLiveMonitorOverlays();
        return;
      }
      return v15OriginalRenderMediaIntoViewport(target, payload, options);
    };

    const v15OriginalRenderAudience = renderAudience;
    renderAudience = async function(payload) {
      if (shouldUseDriveEmbed(payload)) {
        const audienceTarget = document.getElementById('audience-view');
        if (!audienceTarget) return;
        let bgLayer = document.getElementById('audience-bg-layer');
        if (!bgLayer) { bgLayer = document.createElement('div'); bgLayer.id = 'audience-bg-layer'; }
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;background:#000;';
        const frame = document.createElement('iframe');
        frame.src = getDrivePreviewUrl(payload);
        frame.setAttribute('allow', 'autoplay; fullscreen');
        frame.setAttribute('allowfullscreen', '');
        frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#000;';
        wrapper.appendChild(frame);
        Array.from(audienceTarget.children).filter(node => node.id !== 'audience-bg-layer').forEach(node => node.remove());
        audienceTarget.appendChild(bgLayer);
        audienceTarget.appendChild(wrapper);
        return;
      }
      return v15OriginalRenderAudience(payload);
    };

    const v15OriginalPopulateSlidePreviewGrid = populateSlidePreviewGrid;
    populateSlidePreviewGrid = async function() {
      if (staged && shouldUseDriveEmbed(staged)) {
        const grid = document.getElementById('slide-preview-grid');
        if (!grid) return;
        grid.innerHTML = '';
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'preview-slide-card active';
        card.innerHTML = `<div class="preview-slide-thumb"><div>${staged.type === 'pdf' ? '📄 Online PDF' : '🎬 Online Video'}</div></div><div class="preview-slide-meta"><strong>${escapeHtml(staged.name || 'Google Drive media')}</strong><span>Stored in Google Drive · opens through Drive preview</span></div>`;
        card.onclick = () => renderPreview();
        grid.appendChild(card);
        return;
      }
      return v15OriginalPopulateSlidePreviewGrid();
    };

    restoreOnlineSceneAssetsFromDrive = async function() {
      const onlineItems = [];
      for (const scene of scenes) {
        for (const item of (scene.items || [])) {
          if (item && item.googleDrive && item.googleDrive.fileId) onlineItems.push(item);
        }
      }
      if (!onlineItems.length) return 0;
      try {
        const files = await getDriveFilesFromBackend(true);
        const byId = new Map(files.map(file => [String(file.id || file.fileId || ''), file]));
        let restored = 0;
        for (const item of onlineItems) {
          const file = byId.get(String(item.googleDrive.fileId || ''));
          if (!file) continue;
          item.googleDrive = Object.assign({}, item.googleDrive, {
            driveUrl: file.webViewLink || file.driveUrl || item.googleDrive.driveUrl || '',
            previewUrl: file.previewUrl || getDrivePreviewUrl(file) || item.googleDrive.previewUrl || '',
            downloadUrl: file.downloadUrl || file.directUrl || item.googleDrive.downloadUrl || '',
            mimeType: file.mimeType || item.googleDrive.mimeType || '',
            size: Number(file.size || item.googleDrive.size || 0),
            source: 'online-folder'
          });
          if (item.type === 'pdf' || item.type === 'video') {
            if (!String(item.value || '').startsWith('blob:')) item.value = item.googleDrive.previewUrl || item.googleDrive.driveUrl;
          } else if (item.type === 'image') {
            item.value = file.thumbnailUrl || file.downloadUrl || file.webViewLink || item.value || '';
          } else if (item.type === 'url') {
            item.value = file.previewUrl || file.webViewLink || item.value || '';
          }
          restored += 1;
        }
        if (restored) {
          persistScenes();
          renderSceneDeckUI();
        }
        return restored;
      } catch (error) {
        console.warn('Online assets will retry when the Drive backend is available:', error);
        return 0;
      }
    };


    /* V16: preserve Google Drive assets in scenes and staged/live payloads. */
    function v16CloneDriveMeta(meta) {
      if (!meta || typeof meta !== 'object') return null;
      return {
        fileId: String(meta.fileId || meta.id || ''),
        driveUrl: String(meta.driveUrl || meta.webViewLink || ''),
        previewUrl: String(meta.previewUrl || meta.embedUrl || ''),
        downloadUrl: String(meta.downloadUrl || meta.directUrl || meta.webContentLink || ''),
        thumbnailUrl: String(meta.thumbnailUrl || ''),
        mimeType: String(meta.mimeType || ''),
        size: Number(meta.size || 0),
        uploadedAt: String(meta.uploadedAt || meta.createdTime || ''),
        syncStatus: String(meta.syncStatus || 'synced'),
        source: String(meta.source || 'online-folder')
      };
    }

    persistScenes = function() {
      try {
        const cleanScenes = scenes.map(scene => ({
          id: scene.id,
          name: scene.name,
          items: (scene.items || []).map(item => {
            const online = Boolean(item.googleDrive && item.googleDrive.fileId);
            return {
              id: item.id,
              type: item.type,
              value: online
                ? String(item.value || item.googleDrive.previewUrl || item.googleDrive.downloadUrl || item.googleDrive.driveUrl || '')
                : ((item.type === 'url' || item.type === 'bible') ? item.value : ''),
              name: item.name || '',
              category: item.category || '',
              page: Number(item.page || 1),
              videoTime: Number(item.videoTime || 0),
              videoPlaying: Boolean(item.videoPlaying),
              googleDrive: online ? v16CloneDriveMeta(item.googleDrive) : null,
              pdfCacheKey: item.pdfCacheKey || (item.type === 'pdf' ? item.id : '')
            };
          })
        }));
        localStorage.setItem(LS_KEY, JSON.stringify(cleanScenes));
        localStorage.setItem(LS_ACTIVE_SCENE, activeSceneId || '');
      } catch (error) {
        console.error('Unable to save scenes:', error);
      }
    };

    setStagedFromSceneIndex = function(idx) {
      const deck = getActiveDeck();
      const item = deck[idx];
      if (!item) {
        staged = { type: 'none', value: null, sceneItemIndex: -1, page: 1, videoTime: 0, videoPlaying: false };
        renderPreview();
        setSlideStatus();
        renderSceneDeckUI();
        return;
      }

      staged = {
        itemId: item.id || null,
        id: item.id || null,
        sceneItemIndex: idx,
        type: item.type,
        value: item.value,
        name: item.name || '',
        category: item.category || '',
        page: Number(item.page || 1),
        videoTime: Number(item.videoTime || 0),
        videoPlaying: Boolean(item.videoPlaying),
        googleDrive: v16CloneDriveMeta(item.googleDrive),
        pdfCacheKey: item.pdfCacheKey || (item.type === 'pdf' ? item.id : '')
      };
      if (item.pdfData instanceof ArrayBuffer) staged.pdfData = item.pdfData;

      // An online item must always retain a usable Drive preview source.
      if (staged.googleDrive && staged.googleDrive.fileId) {
        if (!staged.googleDrive.previewUrl) {
          staged.googleDrive.previewUrl = `https://drive.google.com/file/d/${encodeURIComponent(staged.googleDrive.fileId)}/preview`;
        }
        if (!staged.value || (!String(staged.value).startsWith('blob:') && !String(staged.value).startsWith('data:'))) {
          if (staged.type === 'pdf' || staged.type === 'video' || staged.type === 'url') {
            staged.value = staged.googleDrive.previewUrl || staged.googleDrive.driveUrl || staged.googleDrive.downloadUrl;
          } else if (staged.type === 'image') {
            staged.value = staged.googleDrive.thumbnailUrl || staged.googleDrive.downloadUrl || staged.googleDrive.driveUrl;
          }
        }
      }

      renderSceneDeckUI();
      renderPreview();
      setSlideStatus();
      if (typeof populateSlidePreviewGrid === 'function') populateSlidePreviewGrid();
    };

    // Replace the Drive-file add routine so a blocked local cache is not treated as failure.
    addDriveFileToActiveScene = async function(file) {
      const scene = getActiveScene();
      if (!scene || !file) return;
      const fileId = String(file.id || file.fileId || '');
      const existingIndex = (scene.items || []).findIndex(item => item.googleDrive && String(item.googleDrive.fileId || '') === fileId);
      if (existingIndex >= 0) {
        setStagedFromSceneIndex(existingIndex);
        closeOnlineFilesModal();
        closeDrivePdfModal();
        return;
      }

      const type = driveFileType(file);
      const driveMeta = v16CloneDriveMeta({
        fileId,
        driveUrl: file.webViewLink || file.driveUrl || '',
        previewUrl: file.previewUrl || (fileId ? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview` : ''),
        downloadUrl: file.downloadUrl || file.directUrl || '',
        thumbnailUrl: file.thumbnailUrl || '',
        mimeType: file.mimeType || '',
        size: file.size || 0,
        uploadedAt: file.createdTime || new Date().toISOString(),
        source: 'online-folder',
        syncStatus: 'synced'
      });
      const itemId = uid();
      const item = {
        id: itemId,
        type: (type === 'file' || type === 'audio') ? 'url' : type,
        name: file.name || file.fileName || 'Drive file',
        value: (type === 'image')
          ? (driveMeta.thumbnailUrl || driveMeta.downloadUrl || driveMeta.driveUrl)
          : (driveMeta.previewUrl || driveMeta.driveUrl || driveMeta.downloadUrl),
        googleDrive: driveMeta,
        page: 1,
        videoTime: 0,
        videoPlaying: false,
        pdfCacheKey: type === 'pdf' ? itemId : ''
      };

      scene.items.push(item);
      persistScenes();
      renderSceneDeckUI();
      setStagedFromSceneIndex(scene.items.length - 1);
      closeOnlineFilesModal();
      closeDrivePdfModal();
      if (type === 'pdf') {
        setCanvaPdfUploadStatus('PDF added from Google Drive. It remains linked and readable after refresh.', 'success');
      }
    };

    // Ensure uploaded files are saved with persistent Drive metadata before rendering.
    const v16OriginalAttachUploadedOnlineFileToScene = attachUploadedOnlineFileToScene;
    attachUploadedOnlineFileToScene = async function(record, sourceFile) {
      const item = await v16OriginalAttachUploadedOnlineFileToScene(record, sourceFile);
      if (item && record) {
        const fileId = record.id || record.fileId || (item.googleDrive && item.googleDrive.fileId) || '';
        item.googleDrive = v16CloneDriveMeta(Object.assign({}, item.googleDrive || {}, {
          fileId,
          driveUrl: record.webViewLink || record.driveUrl || '',
          previewUrl: record.previewUrl || (fileId ? `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview` : ''),
          downloadUrl: record.downloadUrl || record.directUrl || '',
          thumbnailUrl: record.thumbnailUrl || '',
          mimeType: record.mimeType || (sourceFile && sourceFile.type) || '',
          size: record.size || (sourceFile && sourceFile.size) || 0,
          source: 'online-folder',
          syncStatus: 'synced'
        }));
        persistScenes();
        const scene = getActiveScene();
        const index = scene ? scene.items.indexOf(item) : -1;
        if (index >= 0) setStagedFromSceneIndex(index);
      }
      return item;
    };

    // Repair online records already loaded in memory, then save the corrected shape.
    window.addEventListener('DOMContentLoaded', async () => {
      if (document.body.classList.contains('live-window-mode')) return;
      setTimeout(async () => {
        await restoreOnlineSceneAssetsFromDrive();
        persistScenes();
        const deck = getActiveDeck();
        if (staged && staged.sceneItemIndex >= 0 && deck[staged.sceneItemIndex]) {
          setStagedFromSceneIndex(staged.sceneItemIndex);
        }
      }, 500);
    });



    /* V17: presentation-style PDF navigation and Preview -> Live -> Output synchronization. */
    function v17IsOnlineDrivePdf(payload) {
      return Boolean(payload && payload.type === 'pdf' && payload.googleDrive && payload.googleDrive.fileId && !String(payload.value || '').startsWith('blob:') && !payload.pdfData);
    }

    function v17DrivePdfPageUrl(payload, pageNumber) {
      const fileId = payload && payload.googleDrive ? String(payload.googleDrive.fileId || '') : '';
      const page = Math.max(1, Number(pageNumber || payload.page || 1));
      if (!fileId) return '';
      return `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview?rm=minimal#page=${page}&toolbar=0&navpanes=0&scrollbar=0&view=FitH`;
    }

    function v17SamePresentation(a, b) {
      if (!a || !b || a.type !== 'pdf' || b.type !== 'pdf') return false;
      if (a.itemId && b.itemId) return String(a.itemId) === String(b.itemId);
      const af = a.googleDrive && a.googleDrive.fileId;
      const bf = b.googleDrive && b.googleDrive.fileId;
      if (af && bf) return String(af) === String(bf);
      return Boolean(a.value && b.value && String(a.value) === String(b.value));
    }

    function v17RemovePdfNavigation(target) {
      if (!target) return;
      target.querySelectorAll('.v17-pdf-nav').forEach(node => node.remove());
    }

    function v17AddPreviewPdfNavigation(target, payload) {
      if (!target || target.id !== 'preview-viewport' || !payload || payload.type !== 'pdf') return;
      v17RemovePdfNavigation(target);
      const nav = document.createElement('div');
      nav.className = 'v17-pdf-nav';
      nav.innerHTML = `
        <button type="button" class="v17-pdf-arrow" aria-label="Previous slide">&#8249;</button>
        <div class="v17-pdf-page">Slide ${Math.max(1, Number(payload.page || 1))}</div>
        <button type="button" class="v17-pdf-arrow" aria-label="Next slide">&#8250;</button>`;
      const buttons = nav.querySelectorAll('button');
      buttons[0].disabled = Number(payload.page || 1) <= 1;
      buttons[0].onclick = (event) => { event.stopPropagation(); setPdfPage(Number(staged.page || 1) - 1); };
      buttons[1].onclick = (event) => { event.stopPropagation(); setPdfPage(Number(staged.page || 1) + 1); };
      target.appendChild(nav);
    }

    async function v17RenderOnlinePdfSlide(target, payload, options = {}) {
      if (!target || !v17IsOnlineDrivePdf(payload)) return false;
      const page = Math.max(1, Number(payload.page || 1));
      const pageUrl = v17DrivePdfPageUrl(payload, page);
      if (!pageUrl) return false;

      const previous = target.querySelector('.v17-online-pdf-layer.active');
      const next = document.createElement('div');
      next.className = 'v17-online-pdf-layer';
      const frame = document.createElement('iframe');
      frame.src = pageUrl;
      frame.title = `${payload.name || 'PDF presentation'} - slide ${page}`;
      frame.setAttribute('allow', 'fullscreen');
      frame.setAttribute('scrolling', 'no');
      frame.tabIndex = -1;
      next.appendChild(frame);
      target.appendChild(next);

      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        frame.onload = finish;
        setTimeout(finish, 1800);
      });

      next.classList.add('active');
      if (previous && previous !== next) {
        previous.classList.remove('active');
        setTimeout(() => previous.remove(), 280);
      }
      Array.from(target.querySelectorAll('.v17-online-pdf-layer')).forEach(layer => {
        if (layer !== next && layer !== previous) layer.remove();
      });

      v17RemovePdfNavigation(target);
      if (!options.readOnly && target.id === 'preview-viewport') v17AddPreviewPdfNavigation(target, payload);
      return true;
    }

    const v17PreviousRenderMediaIntoViewport = renderMediaIntoViewport;
    renderMediaIntoViewport = async function(target, payload, options = {}) {
      if (v17IsOnlineDrivePdf(payload)) {
        await v17RenderOnlinePdfSlide(target, payload, options);
        if (target && target.id === 'live-viewport') updateLiveMonitorOverlays();
        return;
      }
      const result = await v17PreviousRenderMediaIntoViewport(target, payload, options);
      v17RemovePdfNavigation(target);
      if (target && target.id === 'preview-viewport' && payload && payload.type === 'pdf') {
        v17AddPreviewPdfNavigation(target, payload);
      }
      return result;
    };

    const v17PreviousRenderAudience = renderAudience;
    renderAudience = async function(payload) {
      if (!v17IsOnlineDrivePdf(payload)) return v17PreviousRenderAudience(payload);
      const audience = document.getElementById('audience-view');
      if (!audience) return;
      let bgLayer = document.getElementById('audience-bg-layer');
      if (!bgLayer) { bgLayer = document.createElement('div'); bgLayer.id = 'audience-bg-layer'; }

      const previous = audience.querySelector('.v17-output-pdf-layer.active');
      const next = document.createElement('div');
      next.className = 'v17-output-pdf-layer';
      const frame = document.createElement('iframe');
      frame.src = v17DrivePdfPageUrl(payload, payload.page || 1);
      frame.setAttribute('allow', 'fullscreen');
      frame.setAttribute('scrolling', 'no');
      frame.tabIndex = -1;
      next.appendChild(frame);
      audience.appendChild(next);

      await new Promise(resolve => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        frame.onload = finish;
        setTimeout(finish, 1800);
      });
      if (!bgLayer.parentNode) audience.appendChild(bgLayer);
      next.classList.add('active');
      if (previous && previous !== next) {
        previous.classList.remove('active');
        setTimeout(() => previous.remove(), 300);
      }
      Array.from(audience.querySelectorAll('.v17-output-pdf-layer')).forEach(layer => {
        if (layer !== next && layer !== previous) layer.remove();
      });
    };

    async function v17SyncPreviewPdfPageToLive() {
      if (!staged || staged.type !== 'pdf') return;
      const scene = getActiveScene();
      if (scene && staged.sceneItemIndex >= 0 && scene.items && scene.items[staged.sceneItemIndex]) {
        scene.items[staged.sceneItemIndex].page = Number(staged.page || 1);
        persistScenes();
      }
      if (!v17SamePresentation(staged, liveState)) return;
      liveState.page = Number(staged.page || 1);
      await renderLiveView();
      channel.postMessage({ command: 'UPDATE_LIVE_PDF_PAGE_V17', payload: JSON.parse(JSON.stringify(liveState)) });
    }

    setPdfPage = function(page) {
      if (!staged || staged.type !== 'pdf') return;
      let nextPage = Math.max(1, Number(page || 1));
      if (pdfDoc && Number(pdfDoc.numPages)) nextPage = Math.min(nextPage, Number(pdfDoc.numPages));
      if (nextPage === Number(staged.page || 1)) return;
      staged.page = nextPage;
      setSlideStatus();
      renderPreview();
      if (typeof updateEmbeddedSlideActiveState === 'function') updateEmbeddedSlideActiveState();
      v17SyncPreviewPdfPageToLive();
    };

    channel.addEventListener('message', async (event) => {
      const msg = event.data;
      if (!msg || msg.command !== 'UPDATE_LIVE_PDF_PAGE_V17' || !msg.payload) return;
      lastIncoming = msg.payload;
      if (document.body.classList.contains('live-window-mode')) {
        await renderAudience(msg.payload);
      } else {
        liveState = msg.payload;
        await renderLiveView();
      }
    });

    const v17PreviousFireLive = fireLive;
    fireLive = function() {
      v17PreviousFireLive();
      if (staged && staged.type === 'pdf') {
        setTimeout(() => {
          if (v17SamePresentation(staged, liveState)) {
            channel.postMessage({ command: 'UPDATE_LIVE_PDF_PAGE_V17', payload: JSON.parse(JSON.stringify(liveState)) });
          }
        }, 80);
      }
    };

/* ===== Extracted inline script block ===== */

/* V18: local working copies for Local and Online assets.
   Drive remains the cloud library, while presentation playback uses IndexedDB Blobs. */
(() => {
  const MEDIA_CACHE_DB = 'JIL_Presenter_Media_Cache';
  const MEDIA_CACHE_STORE = 'mediaFiles';

  function openMediaCacheDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(MEDIA_CACHE_DB, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(MEDIA_CACHE_STORE)) {
          request.result.createObjectStore(MEDIA_CACHE_STORE, { keyPath: 'itemId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function saveMediaWorkingCopy(itemId, fileName, source, mimeType = '', googleDrive = {}) {
    if (!itemId || !(source instanceof Blob) || !source.size) return false;
    try {
      if (navigator.storage && navigator.storage.persist) {
        try { await navigator.storage.persist(); } catch (e) {}
      }
      const db = await openMediaCacheDB();
      return await new Promise(resolve => {
        const tx = db.transaction(MEDIA_CACHE_STORE, 'readwrite');
        tx.objectStore(MEDIA_CACHE_STORE).put({
          itemId,
          fileName: fileName || 'media-file',
          mimeType: mimeType || source.type || 'application/octet-stream',
          mediaBlob: source,
          googleDrive: googleDrive || {},
          savedAt: new Date().toISOString()
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      });
    } catch (error) {
      console.warn('Unable to save local media working copy:', error);
      return false;
    }
  }

  async function loadMediaWorkingCopy(itemId) {
    if (!itemId) return null;
    try {
      const db = await openMediaCacheDB();
      return await new Promise(resolve => {
        const tx = db.transaction(MEDIA_CACHE_STORE, 'readonly');
        const request = tx.objectStore(MEDIA_CACHE_STORE).get(itemId);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
      });
    } catch (error) {
      return null;
    }
  }

  async function deleteMediaWorkingCopy(itemId) {
    if (!itemId) return;
    try {
      const db = await openMediaCacheDB();
      const tx = db.transaction(MEDIA_CACHE_STORE, 'readwrite');
      tx.objectStore(MEDIA_CACHE_STORE).delete(itemId);
    } catch (error) {}
  }

  function inferMediaType(file) {
    const name = String(file && file.name || '').toLowerCase();
    const mime = String(file && file.type || '').toLowerCase();
    if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('image/')) return 'image';
    return 'url';
  }

  function makeCachedUrl(blob) {
    try { return URL.createObjectURL(blob); } catch (error) { return ''; }
  }

  async function applyWorkingCopyToItem(item) {
    if (!item || !item.id) return false;

    if (item.type === 'pdf' && typeof loadPdfFromPersistentCache === 'function') {
      const pdfRecord = await loadPdfFromPersistentCache(item.id);
      if (pdfRecord && pdfRecord.pdfBlob) {
        item.value = makeCachedUrl(pdfRecord.pdfBlob);
        item.localCached = true;
        item.localCacheSize = pdfRecord.pdfBlob.size;
        if (pdfRecord.pdfBlob.size <= 64 * 1024 * 1024) {
          try { item.pdfData = await pdfRecord.pdfBlob.arrayBuffer(); } catch (error) {}
        } else {
          delete item.pdfData;
        }
        return true;
      }
    }

    const record = await loadMediaWorkingCopy(item.id);
    if (!record || !record.mediaBlob) return false;
    item.value = makeCachedUrl(record.mediaBlob);
    item.localCached = true;
    item.localCacheSize = record.mediaBlob.size;
    item.mimeType = item.mimeType || record.mimeType;
    if ((!item.googleDrive || !item.googleDrive.fileId) && record.googleDrive) {
      item.googleDrive = record.googleDrive;
    }
    return true;
  }

  async function restoreAllWorkingCopies() {
    let restored = 0;
    for (const scene of (window.scenes || scenes || [])) {
      for (const item of (scene.items || [])) {
        if (await applyWorkingCopyToItem(item)) restored += 1;
      }
    }
    return restored;
  }

  // Local Media Assets now accepts PDFs and stores all selected files locally.
  const localUploader = document.getElementById('file-uploader');
  if (localUploader) localUploader.accept = 'image/*,video/*,audio/*,application/pdf';

  window.handleUpload = async function(event) {
    const input = event && event.target;
    const files = Array.from((input && input.files) || []);
    if (!files.length) return;
    const scene = getActiveScene();
    if (!scene) return;

    let firstNewIndex = scene.items.length;
    for (const file of files) {
      const type = inferMediaType(file);
      if (!['image', 'video', 'audio', 'pdf'].includes(type)) continue;
      const itemId = uid();
      const item = {
        id: itemId,
        type: type === 'audio' ? 'video' : type,
        value: makeCachedUrl(file),
        name: file.name,
        mimeType: file.type || '',
        storageSource: 'local-cache',
        localCached: true,
        page: 1,
        videoTime: 0,
        videoPlaying: false
      };

      const saved = await saveMediaWorkingCopy(itemId, file.name, file, file.type || '', {});
      if (type === 'pdf') {
        if (typeof savePdfToPersistentCache === 'function') {
          await savePdfToPersistentCache(itemId, file.name, file, {});
        }
        if (file.size <= 64 * 1024 * 1024) {
          try { item.pdfData = await file.arrayBuffer(); } catch (error) {}
        }
      }
      item.localCached = saved || type === 'pdf';
      scene.items.push(item);
    }

    persistScenes();
    renderSceneDeckUI();
    if (scene.items.length > firstNewIndex) setStagedFromSceneIndex(firstNewIndex);
    if (typeof populateSlidePreviewGrid === 'function') populateSlidePreviewGrid();
    if (input) input.value = '';
  };

  // Every freshly uploaded Online file gets a local working copy immediately.
  const previousAttachOnline = window.attachUploadedOnlineFileToScene;
  if (typeof previousAttachOnline === 'function') {
    window.attachUploadedOnlineFileToScene = async function(record, sourceFile) {
      const item = await previousAttachOnline(record, sourceFile);
      if (!item) return item;
      if (sourceFile instanceof Blob && sourceFile.size) {
        const saved = await saveMediaWorkingCopy(
          item.id,
          item.name || sourceFile.name,
          sourceFile,
          sourceFile.type || (item.googleDrive && item.googleDrive.mimeType) || '',
          item.googleDrive || {}
        );
        if (item.type === 'pdf' && typeof savePdfToPersistentCache === 'function') {
          await savePdfToPersistentCache(item.id, item.name, sourceFile, item.googleDrive || {});
        }
        if (saved) {
          item.value = makeCachedUrl(sourceFile);
          item.localCached = true;
          item.localCacheSize = sourceFile.size;
          item.storageSource = 'online-local-cache';
          persistScenes();
          const active = getActiveScene();
          const index = active ? active.items.indexOf(item) : -1;
          if (index >= 0) setStagedFromSceneIndex(index);
        }
      }
      return item;
    };
  }

  // Resolve a cached Blob in both the operator page and ?display=true output window.
  async function resolvePayloadWorkingCopy(payload) {
    if (!payload || !payload.itemId) return payload;
    const copy = typeof clonePresenterPayload === 'function'
      ? clonePresenterPayload(payload)
      : Object.assign({}, payload);

    if (copy.type === 'pdf' && typeof loadPdfFromPersistentCache === 'function') {
      const pdfRecord = await loadPdfFromPersistentCache(copy.itemId);
      if (pdfRecord && pdfRecord.pdfBlob) {
        copy.value = makeCachedUrl(pdfRecord.pdfBlob);
        copy.localCached = true;
        if (pdfRecord.pdfBlob.size <= 64 * 1024 * 1024) {
          try { copy.pdfData = await pdfRecord.pdfBlob.arrayBuffer(); } catch (error) {}
        } else {
          delete copy.pdfData;
        }
        return copy;
      }
    }

    const record = await loadMediaWorkingCopy(copy.itemId);
    if (record && record.mediaBlob) {
      copy.value = makeCachedUrl(record.mediaBlob);
      copy.localCached = true;
      copy.mimeType = copy.mimeType || record.mimeType;
    }
    return copy;
  }

  const previousRenderMediaV18 = window.renderMediaIntoViewport;
  window.renderMediaIntoViewport = async function(target, payload, options = {}) {
    const resolved = await resolvePayloadWorkingCopy(payload);
    return previousRenderMediaV18(target, resolved, options);
  };

  const previousRenderAudienceV18 = window.renderAudience;
  window.renderAudience = async function(payload) {
    const resolved = await resolvePayloadWorkingCopy(payload);
    return previousRenderAudienceV18(resolved);
  };

  // Keep staged/live payloads complete and include the item id used by IndexedDB.
  const previousSetStagedV18 = window.setStagedFromSceneIndex;
  window.setStagedFromSceneIndex = function(index) {
    previousSetStagedV18(index);
    const deck = getActiveDeck();
    const item = deck[index];
    if (!item || !window.staged) return;
    staged.itemId = item.id || staged.itemId || null;
    staged.mimeType = item.mimeType || (item.googleDrive && item.googleDrive.mimeType) || staged.mimeType || '';
    staged.googleDrive = item.googleDrive ? JSON.parse(JSON.stringify(item.googleDrive)) : staged.googleDrive;
    staged.localCached = Boolean(item.localCached);
    staged.storageSource = item.storageSource || staged.storageSource || '';
  };

  // Remove local cached bytes when a scene asset is deleted.
  document.addEventListener('click', event => {
    const button = event.target;
    if (!button || button.textContent !== '✕') return;
    const thumb = button.closest('.thumb-item');
    if (!thumb || !thumb.id) return;
    const index = Number(String(thumb.id).replace('slide-thumb-', ''));
    const deck = getActiveDeck();
    const item = deck[index];
    if (!item || !item.id) return;
    setTimeout(() => deleteMediaWorkingCopy(item.id), 0);
  }, true);

  window.addEventListener('DOMContentLoaded', () => {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    setTimeout(async () => {
      const restored = await restoreAllWorkingCopies();
      if (!restored || document.body.classList.contains('live-window-mode')) return;
      persistScenes();
      renderSceneDeckUI();
      const deck = getActiveDeck();
      if (staged && staged.sceneItemIndex >= 0 && deck[staged.sceneItemIndex]) {
        setStagedFromSceneIndex(staged.sceneItemIndex);
      } else if (deck.length) {
        setStagedFromSceneIndex(0);
      }
      if (typeof populateSlidePreviewGrid === 'function') populateSlidePreviewGrid();
    }, 0);
  });
})();

/* ===== Extracted inline script block ===== */

/* V18.1: attach an existing Drive record to a user-selected local working copy. */
(() => {
  window.chooseLocalWorkingCopyForDriveFile = function(fileId) {
    const record = (window.onlineDriveFilesCache || onlineDriveFilesCache || []).find(file => String(file.id || file.fileId) === String(fileId));
    if (!record) return;
    const picker = document.createElement('input');
    picker.type = 'file';
    picker.accept = record.mimeType === 'application/pdf' || /\.pdf$/i.test(record.name || '')
      ? 'application/pdf'
      : (record.mimeType || 'image/*,video/*,audio/*,application/pdf');
    picker.style.display = 'none';
    picker.onchange = async () => {
      const file = picker.files && picker.files[0];
      picker.remove();
      if (!file) return;
      const expectedName = String(record.name || '').trim();
      if (expectedName && file.name !== expectedName) {
        const answer = await showModal('Different File Name', `The selected local file is "${file.name}" but the Drive file is "${expectedName}". Use it as the working copy anyway?`, false);
        if (!answer || !answer.confirmed) return;
      }
      let item = null;
      for (const scene of scenes) {
        item = (scene.items || []).find(entry => entry.googleDrive && String(entry.googleDrive.fileId) === String(fileId));
        if (item) break;
      }
      if (!item) item = await attachUploadedOnlineFileToScene(record, file);
      if (!item) return;
      await saveMediaWorkingCopy(item.id, item.name || file.name, file, file.type || record.mimeType || '', item.googleDrive || {});
      if (item.type === 'pdf' && typeof savePdfToPersistentCache === 'function') {
        await savePdfToPersistentCache(item.id, item.name || file.name, file, item.googleDrive || {});
        if (file.size <= 64 * 1024 * 1024) {
          try { item.pdfData = await file.arrayBuffer(); } catch (error) {}
        } else delete item.pdfData;
      }
      item.value = URL.createObjectURL(file);
      item.localCached = true;
      item.localCacheSize = file.size;
      item.storageSource = 'online-local-cache';
      persistScenes();
      const active = getActiveScene();
      const index = active ? active.items.indexOf(item) : -1;
      if (index >= 0) setStagedFromSceneIndex(index);
      renderSceneDeckUI();
      renderPreview();
      if (typeof populateSlidePreviewGrid === 'function') populateSlidePreviewGrid();
      const status = document.getElementById('online-folder-status');
      if (status) status.textContent = `✅ Local working copy ready: ${file.name}`;
    };
    document.body.appendChild(picker);
    picker.click();
  };

  const previousRenderDriveCardsV181 = window.renderDriveFileCards;
  if (typeof previousRenderDriveCardsV181 === 'function') {
    window.renderDriveFileCards = function(files, targetId) {
      const result = previousRenderDriveCardsV181(files, targetId);
      const target = document.getElementById(targetId);
      if (!target) return result;
      Array.from(target.querySelectorAll('.drive-pdf-card')).forEach((card, index) => {
        const file = (files || [])[index];
        if (!file) return;
        const actions = card.querySelector('.drive-pdf-card-actions');
        if (!actions || actions.querySelector('.v18-cache-local-btn')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'v18-cache-local-btn';
        button.style.background = 'var(--accent-green)';
        button.textContent = 'Use Local Copy';
        button.onclick = event => {
          event.stopPropagation();
          chooseLocalWorkingCopyForDriveFile(file.id || file.fileId || '');
        };
        actions.appendChild(button);
      });
      return result;
    };
  }
})();

/* ===== Extracted inline script block ===== */

/* V19: local page renderer for very large Online PDFs and frame-based external output. */
(() => {
  const pdfDocuments = new Map();
  const pdfRenderTokens = new WeakMap();
  let livePdfIdentity = '';

  function pdfIdentity(payload){
    if(!payload) return '';
    return String(payload.itemId || (payload.googleDrive && payload.googleDrive.fileId) || payload.value || '');
  }

  async function getCachedPdfBlob(payload){
    if(!payload) return null;
    if(payload.pdfData instanceof ArrayBuffer && payload.pdfData.byteLength) return new Blob([payload.pdfData],{type:'application/pdf'});
    if(payload.itemId && typeof loadPdfFromPersistentCache === 'function'){
      const record=await loadPdfFromPersistentCache(payload.itemId);
      if(record && record.pdfBlob) return record.pdfBlob;
    }
    if(payload.itemId && typeof loadMediaWorkingCopy === 'function'){
      const record=await loadMediaWorkingCopy(payload.itemId);
      if(record && record.mediaBlob && (/pdf/i.test(record.mimeType||'') || /\.pdf$/i.test(record.fileName||payload.name||''))) return record.mediaBlob;
    }
    if(payload.value && String(payload.value).startsWith('blob:')){
      try{const response=await fetch(payload.value);if(response.ok)return await response.blob();}catch(e){}
    }
    return null;
  }

  async function getLocalPdfDocument(payload){
    const key=pdfIdentity(payload);
    if(!key) throw new Error('PDF identity is missing.');
    if(pdfDocuments.has(key)) return pdfDocuments.get(key);
    const blob=await getCachedPdfBlob(payload);
    if(!blob) throw new Error('Choose a local working copy for this Drive PDF first.');
    const url=URL.createObjectURL(blob);
    const promise=pdfjsLib.getDocument({url, disableAutoFetch:false, disableStream:false, disableRange:false}).promise
      .then(doc=>{doc.__v19Url=url;return doc;})
      .catch(error=>{URL.revokeObjectURL(url);pdfDocuments.delete(key);throw error;});
    pdfDocuments.set(key,promise);
    return promise;
  }

  function addPreviewControls(target,payload,total){
    target.querySelectorAll('.v17-pdf-nav,.pdf-toolbar,.pdf-live-nav,.v19-pdf-nav').forEach(n=>n.remove());
    if(target.id!=='preview-viewport') return;
    const nav=document.createElement('div');nav.className='v19-pdf-nav';
    const previous=document.createElement('button');previous.type='button';previous.innerHTML='&#8249;';previous.disabled=(payload.page||1)<=1;
    const next=document.createElement('button');next.type='button';next.innerHTML='&#8250;';next.disabled=(payload.page||1)>=total;
    const count=document.createElement('div');count.className='v19-pdf-count';count.textContent=`Slide ${payload.page||1} / ${total}`;
    previous.onclick=e=>{e.stopPropagation();setPdfPage((staged.page||1)-1)};
    next.onclick=e=>{e.stopPropagation();setPdfPage((staged.page||1)+1)};
    nav.append(previous,next,count);target.appendChild(nav);
  }

  async function renderLocalPdfPage(target,payload,options={}){
    if(!target || !payload || payload.type!=='pdf') return false;
    const blob=await getCachedPdfBlob(payload);
    if(!blob) return false;
    const token={};pdfRenderTokens.set(target,token);
    let stage=target.querySelector('.v19-pdf-stage');
    if(!stage){stage=document.createElement('div');stage.className='v19-pdf-stage';target.appendChild(stage)}
    try{
      const doc=await getLocalPdfDocument(payload);
      if(pdfRenderTokens.get(target)!==token)return true;
      const pageNumber=Math.max(1,Math.min(Number(payload.page||1),doc.numPages));
      payload.page=pageNumber;payload.totalPages=doc.numPages;
      const page=await doc.getPage(pageNumber);
      const box=target.getBoundingClientRect();
      const base=page.getViewport({scale:1});
      const scale=Math.max(.25,Math.min(2.2,Math.min((box.width||1280)/base.width,(box.height||720)/base.height)*(window.devicePixelRatio||1)));
      const viewport=page.getViewport({scale});
      const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      await page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport}).promise;
      if(pdfRenderTokens.get(target)!==token)return true;
      stage.replaceChildren(canvas);
      addPreviewControls(target,payload,doc.numPages);
      return true;
    }catch(error){
      if(!stage.children.length){
        const note=document.createElement('div');note.className='v19-pdf-cache-note';
        note.textContent=(payload.googleDrive&&payload.googleDrive.fileId)
          ? 'This online PDF needs a local working copy. Open View Files and choose Use Local Copy once. Google Drive remains the cloud backup.'
          : 'Unable to open this PDF from local storage.';
        stage.replaceChildren(note);
      }
      console.error('V19 PDF render failed:',error);
      return true;
    }
  }

  async function makePdfFrame(payload){
    const doc=await getLocalPdfDocument(payload);
    const pageNumber=Math.max(1,Math.min(Number(payload.page||1),doc.numPages));
    const page=await doc.getPage(pageNumber);
    const base=page.getViewport({scale:1});
    const scale=Math.min(2,1920/base.width,1080/base.height);
    const viewport=page.getViewport({scale});
    const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    await page.render({canvasContext:canvas.getContext('2d',{alpha:false}),viewport}).promise;
    return {frame:canvas.toDataURL('image/jpeg',.93),page:pageNumber,totalPages:doc.numPages,itemId:payload.itemId||'',name:payload.name||''};
  }

  async function broadcastPdfFrame(payload,transitionType='cut'){
    try{
      const data=await makePdfFrame(payload);
      channel.postMessage({command:'V19_RENDERED_PDF_FRAME',payload:data,transitionType});
    }catch(error){console.error('Unable to send PDF frame:',error)}
  }

  function showOutputFrame(data,transitionType='cut'){
    const audience=document.getElementById('audience-view');if(!audience)return;
    let bg=document.getElementById('audience-bg-layer');if(!bg){bg=document.createElement('div');bg.id='audience-bg-layer'}
    const old=audience.querySelector('.v19-output-frame.active');
    const layer=document.createElement('div');layer.className='v19-output-frame';
    Object.assign(layer.style,{position:'absolute',inset:'0',background:'#000',display:'flex',alignItems:'center',justifyContent:'center',opacity:transitionType==='cut'?'1':'0',transition:transitionType==='cut'?'none':'opacity .45s ease'});
    const img=document.createElement('img');img.src=data.frame;Object.assign(img.style,{width:'100%',height:'100%',objectFit:'contain'});layer.appendChild(img);
    audience.appendChild(layer);
    requestAnimationFrame(()=>{layer.classList.add('active');layer.style.opacity='1';if(old&&old!==layer){old.style.opacity='0';setTimeout(()=>old.remove(),transitionType==='cut'?0:500)}});
    if(!bg.parentNode)audience.appendChild(bg);
  }

  const previousRenderMedia=window.renderMediaIntoViewport;
  window.renderMediaIntoViewport=async function(target,payload,options={}){
    if(payload&&payload.type==='pdf'){
      const handled=await renderLocalPdfPage(target,payload,options);
      if(handled){if(target&&target.id==='live-viewport')updateLiveMonitorOverlays();return}
    }
    return previousRenderMedia(target,payload,options);
  };

  const previousSetPdfPage=window.setPdfPage;
  window.setPdfPage=function(page){
    if(!staged||staged.type!=='pdf')return previousSetPdfPage(page);
    const total=Number(staged.totalPages||0);
    let next=Math.max(1,Number(page||1));if(total)next=Math.min(next,total);
    if(next===Number(staged.page||1))return;
    staged.page=next;setSlideStatus();renderPreview();
    const scene=getActiveScene();if(scene&&staged.sceneItemIndex>=0&&scene.items[staged.sceneItemIndex]){scene.items[staged.sceneItemIndex].page=next;persistScenes()}
    if(livePdfIdentity&&livePdfIdentity===pdfIdentity(staged)){
      liveState=clonePresenterPayload(staged);renderLiveView();broadcastPdfFrame(liveState,'cut');
    }
    if(typeof updateEmbeddedSlideActiveState==='function')updateEmbeddedSlideActiveState();
  };

  const previousFireLive=window.fireLive;
  window.fireLive=function(){
    if(staged&&staged.type==='pdf'){
      if(isFTBActive||isFTGActive){showModal('Live View Is Covered','Turn off Fade To Black or Fade To Background before sending a new preview live.',false);return}
      const transition=document.getElementById('transition-type-select').value;
      liveState=clonePresenterPayload(staged);livePdfIdentity=pdfIdentity(liveState);renderLiveView();
      broadcastPdfFrame(liveState,transition);
      return;
    }
    livePdfIdentity='';return previousFireLive();
  };

  channel.addEventListener('message',event=>{
    const msg=event.data;if(!msg||msg.command!=='V19_RENDERED_PDF_FRAME'||!msg.payload)return;
    if(document.body.classList.contains('live-window-mode'))showOutputFrame(msg.payload,msg.transitionType||'cut');
  });

  // Ask the opener directly as a fallback because file:// BroadcastChannel support varies by browser.
  window.addEventListener('DOMContentLoaded',()=>{
    if(document.body.classList.contains('live-window-mode')){
      try{if(window.opener&&typeof window.opener.__v19SendCurrentLivePdf==='function')setTimeout(()=>window.opener.__v19SendCurrentLivePdf(),300)}catch(e){}
    }
  });
  window.__v19SendCurrentLivePdf=()=>{if(liveState&&liveState.type==='pdf')broadcastPdfFrame(liveState,'cut')};
})();

/* ===== Extracted inline script block ===== */

/* V20: Drive is storage only. Presentation playback always uses a local browser cache. */
(() => {
  function hasLocalWorkingCopy(item) {
    return Boolean(item && (item.localCached || String(item.value || '').startsWith('blob:') || item.pdfData instanceof ArrayBuffer));
  }

  // A Drive library item must be paired with a local file before it enters a scene.
  window.addDriveFileToActiveScene = async function(file) {
    if (!file) return;
    const fileId = String(file.id || file.fileId || '');
    let existing = null;
    for (const scene of scenes) {
      existing = (scene.items || []).find(item => item.googleDrive && String(item.googleDrive.fileId || '') === fileId);
      if (existing) break;
    }
    if (existing && hasLocalWorkingCopy(existing)) {
      const active = getActiveScene();
      const index = active ? active.items.indexOf(existing) : -1;
      if (index >= 0) setStagedFromSceneIndex(index);
      closeOnlineFilesModal();
      closeDrivePdfModal();
      return;
    }
    closeOnlineFilesModal();
    closeDrivePdfModal();
    await showModal(
      'Select Local Working Copy',
      'Google Drive will remain the cloud backup, but presentation playback will not read from Drive. Select the matching file from this computer so Preview, Live View, and Display Screen can play it smoothly.',
      false
    );
    chooseLocalWorkingCopyForDriveFile(fileId);
  };

  // Never replace cached online assets with a Drive preview URL during restoration.
  if (typeof window.restoreOnlineSceneAssetsFromDrive === 'function') {
    const oldRestore = window.restoreOnlineSceneAssetsFromDrive;
    window.restoreOnlineSceneAssetsFromDrive = async function() {
      const snapshots = new Map();
      scenes.forEach(scene => (scene.items || []).forEach(item => {
        if (item.id && hasLocalWorkingCopy(item)) snapshots.set(item.id, { value:item.value, localCached:item.localCached, storageSource:item.storageSource });
      }));
      const result = await oldRestore();
      scenes.forEach(scene => (scene.items || []).forEach(item => {
        const snap = snapshots.get(item.id);
        if (snap) Object.assign(item, snap);
        else if (item.googleDrive && item.googleDrive.fileId) {
          item.value = '';
          item.localCached = false;
          item.storageSource = 'drive-backup-only';
        }
      }));
      persistScenes();
      return result;
    };
  }

  // Rendered slide frames are delivered directly to the popup as well as BroadcastChannel.
  function receiveRenderedFrame(data, transitionType='cut') {
    const audience = document.getElementById('audience-view');
    if (!audience || !data || !data.frame) return;
    let bg = document.getElementById('audience-bg-layer');
    if (!bg) { bg = document.createElement('div'); bg.id = 'audience-bg-layer'; audience.appendChild(bg); }
    const old = audience.querySelector('.v20-output-frame.active');
    const layer = document.createElement('div');
    layer.className = 'v20-output-frame';
    Object.assign(layer.style, {
      position:'absolute', inset:'0', background:'#000', display:'flex', alignItems:'center', justifyContent:'center',
      opacity: transitionType === 'cut' ? '1' : '0', transition: transitionType === 'cut' ? 'none' : 'opacity .5s ease', zIndex:'20'
    });
    const img = document.createElement('img');
    img.src = data.frame;
    Object.assign(img.style, { width:'100%', height:'100%', objectFit:'contain', display:'block' });
    layer.appendChild(img);
    audience.appendChild(layer);
    requestAnimationFrame(() => {
      layer.classList.add('active');
      layer.style.opacity = '1';
      if (old && old !== layer) {
        old.style.opacity = '0';
        setTimeout(() => old.remove(), transitionType === 'cut' ? 0 : 550);
      }
    });
  }
  window.__v20ReceiveRenderedFrame = receiveRenderedFrame;

  const rawPost = channel.postMessage.bind(channel);
  channel.postMessage = function(message) {
    rawPost(message);
    if (message && message.command === 'V19_RENDERED_PDF_FRAME' && message.payload) {
      try {
        if (displayWindow && !displayWindow.closed && typeof displayWindow.__v20ReceiveRenderedFrame === 'function') {
          displayWindow.__v20ReceiveRenderedFrame(message.payload, message.transitionType || 'cut');
        }
      } catch (error) { console.warn('Direct display frame delivery failed:', error); }
    }
  };

  // When the popup is opened, request the currently live local PDF frame again.
  const oldOpenDisplayWindow = window.openDisplayWindow;
  window.openDisplayWindow = async function() {
    const result = await oldOpenDisplayWindow();
    setTimeout(() => {
      try {
        if (liveState && liveState.type === 'pdf' && typeof window.__v19SendCurrentLivePdf === 'function') {
          window.__v19SendCurrentLivePdf();
        }
      } catch (error) {}
    }, 800);
    return result;
  };

  // Clearly identify locally backed online media in the monitors.
  const oldRenderMedia = window.renderMediaIntoViewport;
  window.renderMediaIntoViewport = async function(target, payload, options={}) {
    const result = await oldRenderMedia(target, payload, options);
    if (target && payload && payload.googleDrive && payload.googleDrive.fileId && payload.localCached) {
      const badge = document.createElement('div');
      badge.className = 'v20-local-only-badge';
      badge.textContent = 'Local playback';
      target.appendChild(badge);
    }
    return result;
  };
})();


    /* V21: one required local root folder; cloud is transfer-only. */
    function setStorageMode(){
      currentStorageMode='local';
      try{localStorage.setItem(LS_STORAGE_MODE,'local')}catch(e){}
      const title=document.getElementById('storage-source-title'); if(title)title.textContent='Local Folder Link';
      document.getElementById('local-folder-panel')?.style.removeProperty('display');
      const badge=document.getElementById('media-assets-source-badge');if(badge)badge.textContent='Root folder';
    }

    function setCloudTransferStatus(message,isError=false){
      const el=document.getElementById('online-folder-status');if(!el)return;
      el.textContent=String(message||'');
      el.classList.toggle('show',Boolean(message));
      el.classList.toggle('error',Boolean(isError));
    }

    async function ensureRootFolderPermission(interactive=false){
      if(!folderHandle) folderHandle=await loadFolderHandle();
      if(!folderHandle){if(interactive)openRootFolderSetupModal('Choose a root folder before continuing.');return false}
      try{
        const options={mode:'readwrite'};
        let state=await folderHandle.queryPermission(options);
        if(state!=='granted'&&interactive)state=await folderHandle.requestPermission(options);
        if(state!=='granted'){if(interactive)openRootFolderSetupModal('Folder permission is required. Click Choose Root Folder.');return false}
        return true;
      }catch(e){if(interactive)openRootFolderSetupModal(e.message||'Unable to access the root folder.');return false}
    }

    function openRootFolderSetupModal(message='No root folder selected.'){
      const modal=document.getElementById('root-folder-setup-modal');
      const status=document.getElementById('root-folder-modal-status');
      if(status)status.textContent=message;
      modal?.classList.add('open');
    }
    function closeRootFolderSetupModal(){document.getElementById('root-folder-setup-modal')?.classList.remove('open')}

    async function chooseRequiredRootFolder(){
      const status=document.getElementById('root-folder-modal-status');
      try{
        if(!window.showDirectoryPicker)throw new Error('Use a Chromium-based browser to select a persistent root folder.');
        folderHandle=await window.showDirectoryPicker({mode:'readwrite'});
        await saveFolderHandle(folderHandle);
        updateFolderUI(true);
        if(status)status.textContent='Root folder connected: '+(folderHandle.name||'selected folder');
        await scanAndRestoreLocalFiles();
        closeRootFolderSetupModal();
      }catch(e){if(status)status.textContent=e&&e.name==='AbortError'?'Folder selection was cancelled.':(e.message||String(e))}
    }

    const v21OriginalRequestFolderPermission=requestFolderPermission;
    requestFolderPermission=async function(){
      await chooseRequiredRootFolder();
    };

    const v21OriginalUpdateFolderUI=updateFolderUI;
    updateFolderUI=function(isConnected){
      v21OriginalUpdateFolderUI(isConnected);
      const txt=document.getElementById('folder-status-txt');
      const btn=document.getElementById('folder-action-btn');
      if(isConnected){if(txt)txt.textContent='✅ Root folder connected: '+(folderHandle?.name||'selected folder');if(btn)btn.textContent='Change Root Folder'}
      else{if(txt)txt.textContent='📁 Root folder is required.';if(btn)btn.textContent='Choose Root Folder'}
    };

    function driveTypeToSceneType(file){
      const mime=String(file?.mimeType||'').toLowerCase(); const name=String(file?.name||'').toLowerCase();
      if(mime.includes('pdf')||name.endsWith('.pdf'))return'pdf';
      if(mime.startsWith('image/'))return'image';
      if(mime.startsWith('video/'))return'video';
      if(mime.startsWith('audio/'))return'audio';
      return'url';
    }

    async function writeResponseToRootFolder(file,response,onProgress){
      const fileHandle=await folderHandle.getFileHandle(file.name,{create:true});
      const writable=await fileHandle.createWritable();
      const total=Number(response.headers.get('content-length'))||Number(file.size)||0;
      let loaded=0;
      try{
        if(response.body&&response.body.getReader){
          const reader=response.body.getReader();
          while(true){const {done,value}=await reader.read();if(done)break;await writable.write(value);loaded+=value.byteLength;if(onProgress)onProgress(loaded,total)}
        }else{
          const blob=await response.blob();await writable.write(blob);loaded=blob.size;if(onProgress)onProgress(loaded,total||blob.size);
        }
        await writable.close();
      }catch(e){try{await writable.abort()}catch(_){}throw e}
      return fileHandle;
    }

    async function addDownloadedRootFileToScene(fileName,driveFile){
      const scene=getActiveScene();if(!scene)throw new Error('Choose an active scene first.');
      const fh=await folderHandle.getFileHandle(fileName);const localFile=await fh.getFile();
      const type=driveTypeToSceneType({name:fileName,mimeType:localFile.type||driveFile?.mimeType});
      const existing=(scene.items||[]).find(i=>i.name===fileName);
      const item=existing||{id:uid(),type,name:fileName,page:1,videoTime:0,videoPlaying:false};
      item.type=type;item.value=URL.createObjectURL(localFile);item.rootFolderFile=true;
      item.googleDrive=driveFile?{fileId:driveFile.id||driveFile.fileId||'',driveUrl:driveFile.webViewLink||'',previewUrl:driveFile.previewUrl||'',downloadUrl:driveFile.downloadUrl||'',mimeType:driveFile.mimeType||localFile.type||'',size:driveFile.size||localFile.size||0,source:'cloud-backup'}:item.googleDrive;
      if(type==='pdf'&&typeof savePdfToPersistentCache==='function'){
        try{await savePdfToPersistentCache(item.id,item.name,localFile,item.googleDrive||{})}catch(e){}
      }
      if(!existing)scene.items.push(item);
      persistScenes();renderSceneDeckUI();setStagedFromSceneIndex(scene.items.indexOf(item));
    }

    async function downloadCloudFileToRoot(fileId){
      let file=onlineDriveFilesCache.find(f=>String(f.id||f.fileId)===String(fileId));
      if(!file){const files=await getDriveFilesFromBackend(true);file=files.find(f=>String(f.id||f.fileId)===String(fileId))}
      if(!file)throw new Error('The selected file is no longer available.');
      if(!(await ensureRootFolderPermission(true)))return;
      const url=file.downloadUrl||file.directUrl;
      if(!url){showModal('Download Unavailable','The backend did not provide a downloadable file URL.',false);return}
      const card=document.querySelector(`[data-drive-file-id="${CSS.escape(String(fileId))}"]`);
      const progress=card?.querySelector('.drive-download-progress span');
      const action=card?.querySelector('.drive-download-action');
      try{
        if(action){action.disabled=true;action.textContent='Downloading 0%'}
        setCloudTransferStatus('Downloading '+file.name+' into the root folder...');
        const response=await fetch(url,{method:'GET',redirect:'follow'});
        if(!response.ok)throw new Error('Download failed ('+response.status+'). Make sure the file can be accessed by the deployed backend.');
        await writeResponseToRootFolder(file,response,(loaded,total)=>{const pct=total?Math.min(100,Math.round(loaded/total*100)):0;if(progress)progress.style.width=pct+'%';if(action)action.textContent=total?'Downloading '+pct+'%':'Downloading...'});
        await addDownloadedRootFileToScene(file.name,file);
        setCloudTransferStatus('✅ '+file.name+' was saved in the root folder and added to the active scene.');
        if(action){action.textContent='Downloaded';action.disabled=false}
      }catch(e){
        setCloudTransferStatus('Download failed: '+(e.message||e),true);
        if(action){action.disabled=false;action.textContent='Download'}
        showModal('Download Failed',(e.message||String(e))+' The file remains available in View Files.',false);
      }
    }

    renderDriveFileCards=function(files,targetId){
      const list=document.getElementById(targetId);if(!list)return;
      if(!files.length){list.innerHTML='<div style="grid-column:1/-1;color:var(--text-muted);padding:22px;text-align:center;">No matching files are available.</div>';return}
      list.innerHTML=files.map(file=>{const id=String(file.id||file.fileId||'');const type=driveFileType(file);return `<div class="drive-pdf-card" data-drive-file-id="${escapeHtml(id)}"><button class="drive-file-delete" title="Delete file" onclick="deleteOnlineDriveFile('${escapeHtml(id)}')">🗑</button><div class="drive-file-thumb">${driveFilePreviewHtml(file)}</div><div class="drive-file-kind">${escapeHtml(type)}</div><div class="drive-pdf-card-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div><div class="drive-pdf-card-meta">${escapeHtml(formatFileBytes(file.size||0))}<br>${escapeHtml(file.createdTime?new Date(file.createdTime).toLocaleString():'')}</div><div class="drive-download-progress"><span></span></div><div class="drive-pdf-card-actions"><button class="drive-download-action" onclick="downloadCloudFileToRoot('${escapeHtml(id)}')">⬇ Download</button>${file.webViewLink?`<button style="background:var(--accent-purple)" onclick="window.open('${escapeHtml(file.webViewLink)}','_blank','noopener')">View</button>`:''}</div></div>`}).join('');
    };

    renderDrivePdfList=async function(){
      const list=document.getElementById('drive-pdf-list');if(!list)return;
      list.innerHTML='<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted)">Loading files...</div>';
      try{const files=await getDriveFilesFromBackend(false);const pdfOnly=document.getElementById('drive-pdf-only-filter')?.checked!==false;renderDriveFileCards(pdfOnly?files.filter(f=>driveFileType(f)==='pdf'):files,'drive-pdf-list')}
      catch(e){list.innerHTML='<div style="grid-column:1/-1;color:var(--accent-red);padding:20px">'+escapeHtml(e.message||e)+'</div>'}
    };
    openDrivePdfModal=function(){document.getElementById('drive-pdf-modal')?.classList.add('open');renderDrivePdfList()};

    const v21OriginalUploadOnlineMediaFiles=uploadOnlineMediaFiles;
    uploadOnlineMediaFiles=async function(event){
      setCloudTransferStatus('Uploading selected files...');
      await v21OriginalUploadOnlineMediaFiles(event);
      const text=document.getElementById('online-folder-status')?.textContent||'';
      if(text&&!/⚠️/.test(text))setCloudTransferStatus(text);
    };

    window.addEventListener('DOMContentLoaded',()=>{
      setStorageMode('local');
      setTimeout(async()=>{
        if(document.body.classList.contains('live-window-mode'))return;
        const ok=await ensureRootFolderPermission(false);
        if(!ok)openRootFolderSetupModal('Choose a root folder to start using the presenter.');
        else updateFolderUI(true);
      },700);
    });

/* ===== Extracted inline script block ===== */

/* V22: authenticated chunk download through Apps Script.
   Avoids browser CORS failures from direct Drive download URLs. */
const ROOT_DOWNLOAD_CHUNK_SIZE = 2 * 1024 * 1024;

function base64ChunkToUint8Array(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function fetchCloudDownloadChunk(fileId, start, end) {
  const separator = GOOGLE_SCRIPT_PDF_UPLOAD_URL.includes('?') ? '&' : '?';
  const url = GOOGLE_SCRIPT_PDF_UPLOAD_URL + separator + new URLSearchParams({
    action: 'downloadChunk',
    fileId: String(fileId),
    start: String(start),
    end: String(end),
    _: String(Date.now())
  }).toString();

  const response = await fetch(url, {
    method: 'GET',
    cache: 'no-store',
    redirect: 'follow'
  });

  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch (error) {
    throw new Error('The download backend returned an unreadable response. Redeploy the updated Apps Script backend.');
  }

  if (!response.ok || !result || result.success === false) {
    throw new Error((result && result.error) || ('Chunk download failed (' + response.status + ').'));
  }
  if (!result.base64Data) throw new Error('The backend returned an empty file chunk.');
  return result;
}

async function downloadCloudFileInChunksToRoot(file, onProgress) {
  if (!folderHandle) throw new Error('Choose the root folder first.');
  const fileId = String(file.id || file.fileId || '');
  if (!fileId) throw new Error('Missing cloud file ID.');

  const safeName = String(file.name || file.fileName || 'downloaded-file').replace(/[\\/:*?"<>|]/g, '_');
  const destination = await folderHandle.getFileHandle(safeName, { create: true });
  const writable = await destination.createWritable();
  const expectedTotal = Math.max(0, Number(file.size) || 0);
  let offset = 0;
  let total = expectedTotal;

  try {
    while (total === 0 || offset < total) {
      const requestedEnd = offset + ROOT_DOWNLOAD_CHUNK_SIZE - 1;
      const result = await fetchCloudDownloadChunk(fileId, offset, requestedEnd);
      const bytes = base64ChunkToUint8Array(result.base64Data);
      if (!bytes.byteLength) throw new Error('The backend returned a zero-byte file chunk.');

      await writable.write({ type: 'write', position: offset, data: bytes });
      offset += bytes.byteLength;
      total = Math.max(total, Number(result.totalSize) || 0);
      if (onProgress) onProgress(offset, total);

      if (result.done === true || bytes.byteLength < ROOT_DOWNLOAD_CHUNK_SIZE) break;
    }

    await writable.truncate(offset);
    await writable.close();
    return { fileHandle: destination, fileName: safeName, size: offset };
  } catch (error) {
    try { await writable.abort(); } catch (_) {}
    throw error;
  }
}

downloadCloudFileToRoot = async function(fileId) {
  let file = onlineDriveFilesCache.find(f => String(f.id || f.fileId) === String(fileId));
  if (!file) {
    const files = await getDriveFilesFromBackend(true);
    file = files.find(f => String(f.id || f.fileId) === String(fileId));
  }
  if (!file) {
    await showModal('Download Unavailable', 'The selected file is no longer available.', false);
    return;
  }
  if (!(await ensureRootFolderPermission(true))) return;

  const card = document.querySelector(`[data-drive-file-id="${CSS.escape(String(fileId))}"]`);
  const progress = card?.querySelector('.drive-download-progress span');
  const action = card?.querySelector('.drive-download-action');

  try {
    if (action) { action.disabled = true; action.textContent = 'Downloading 0%'; }
    if (progress) progress.style.width = '0%';
    setCloudTransferStatus('Downloading ' + file.name + ' into the root folder...');

    const saved = await downloadCloudFileInChunksToRoot(file, (loaded, total) => {
      const pct = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      if (progress) progress.style.width = pct + '%';
      if (action) action.textContent = total > 0 ? ('Downloading ' + pct + '%') : ('Downloading ' + formatFileBytes(loaded));
      setCloudTransferStatus('Downloading ' + file.name + ': ' + (total > 0 ? pct + '%' : formatFileBytes(loaded)));
    });

    await addDownloadedRootFileToScene(saved.fileName, file);
    if (progress) progress.style.width = '100%';
    if (action) { action.textContent = 'Downloaded'; action.disabled = false; }
    setCloudTransferStatus('✅ ' + saved.fileName + ' was saved in the root folder and added to the active scene.');
  } catch (error) {
    if (action) { action.disabled = false; action.textContent = 'Download'; }
    const message = error && error.message ? error.message : String(error);
    setCloudTransferStatus('Download failed: ' + message, true);
    await showModal('Download Failed', message + ' The file remains available in View Files.', false);
  }
};

/* ===== Extracted inline script block ===== */

/* V25: faster adaptive downloads and local root-folder file browser. */
(() => {
  const V25_DOWNLOAD_CHUNKS = [16 * 1024 * 1024, 8 * 1024 * 1024, 4 * 1024 * 1024, 2 * 1024 * 1024];
  let rootFilesCache = [];

  window.downloadCloudFileInChunksToRoot = async function(file, onProgress) {
    if (!folderHandle) throw new Error('Choose the root folder first.');
    const fileId = String(file.id || file.fileId || '');
    if (!fileId) throw new Error('Missing file ID.');
    const safeName = String(file.name || file.fileName || 'downloaded-file').replace(/[\\/:*?"<>|]/g, '_');
    const destination = await folderHandle.getFileHandle(safeName, { create:true });
    const writable = await destination.createWritable();
    let offset = 0;
    let total = Math.max(0, Number(file.size) || 0);
    let preferredIndex = 0;
    try {
      while (total === 0 || offset < total) {
        let result = null, bytes = null, lastError = null;
        for (let i = preferredIndex; i < V25_DOWNLOAD_CHUNKS.length; i += 1) {
          try {
            const chunkSize = V25_DOWNLOAD_CHUNKS[i];
            result = await fetchCloudDownloadChunk(fileId, offset, offset + chunkSize - 1);
            bytes = base64ChunkToUint8Array(result.base64Data);
            if (!bytes.byteLength) throw new Error('The backend returned an empty file chunk.');
            preferredIndex = i;
            break;
          } catch (error) {
            lastError = error;
            preferredIndex = Math.min(i + 1, V25_DOWNLOAD_CHUNKS.length - 1);
          }
        }
        if (!bytes) throw lastError || new Error('Unable to download the next file chunk.');
        await writable.write({ type:'write', position:offset, data:bytes });
        offset += bytes.byteLength;
        total = Math.max(total, Number(result.totalSize) || 0);
        if (onProgress) onProgress(offset, total);
        if (result.done === true || (total > 0 && offset >= total)) break;
      }
      await writable.truncate(offset);
      await writable.close();
      return { fileHandle:destination, fileName:safeName, size:offset };
    } catch (error) {
      try { await writable.abort(); } catch (_) {}
      throw error;
    }
  };

  function rootFileType(file) {
    const mime=String(file.type||'').toLowerCase(), name=String(file.name||'').toLowerCase();
    if(
      mime==='application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
      name.endsWith('.pptx')
    ) return 'pptx';
    if(mime==='application/pdf'||name.endsWith('.pdf'))return'pdf';
    if(mime.startsWith('image/'))return'image';
    if(mime.startsWith('video/'))return'video';
    if(mime.startsWith('audio/'))return'audio';
    return'url';
  }

  async function collectRootFiles(dirHandle, prefix='') {
    const output=[];
    for await (const entry of dirHandle.values()) {
      const path=prefix ? prefix+'/'+entry.name : entry.name;
      if(entry.kind==='file') {
        try { const file=await entry.getFile(); output.push({path,name:entry.name,file,handle:entry,parent:dirHandle}); } catch (_) {}
      } else if(entry.kind==='directory') {
        output.push(...await collectRootFiles(entry,path));
      }
    }
    return output;
  }

  function rootThumb(record) {
    const t=rootFileType(record.file);
    if(t==='image') { const url=URL.createObjectURL(record.file); return `<img src="${url}" alt="">`; }
    return t==='pptx'?'📊':t==='pdf'?'📄':t==='video'?'🎬':'📦';
  }

  window.openRootFilesModal = async function() {
    if (!(await ensureRootFolderPermission(true))) return;
    document.getElementById('root-files-modal')?.classList.add('open');
    await renderRootFilesList(true);
  };
  window.closeRootFilesModal = function(){document.getElementById('root-files-modal')?.classList.remove('open')};

  window.renderRootFilesList = async function(force=false) {
    const list=document.getElementById('root-files-list'); if(!list)return;
    if(!folderHandle){list.innerHTML='<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted)">Choose the root folder first.</div>';return}
    list.innerHTML='<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted)">Reading and organizing root folder...</div>';
    if(force || !rootFilesCache.length) rootFilesCache=await collectRootFiles(folderHandle);
    const selectedType=String(document.getElementById('root-file-type-filter')?.value||'all');
    const indexed=rootFilesCache.map((record,index)=>({record,index,type:rootFileType(record.file)}));
    const visible=indexed.filter(entry=>selectedType==='all'||entry.type===selectedType);
    if(!visible.length){list.innerHTML='<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted)">No matching files found.</div>';return}

    const order=['image','video','pdf','pptx','audio','url'];
    const labels={image:'Images',video:'Videos',pdf:'PDF Documents',pptx:'PowerPoint',audio:'Audio',url:'Other Files'};
    const icons={image:'🖼️',video:'🎬',pdf:'📄',pptx:'📊',audio:'🎵',url:'📦'};
    const groups=new Map();
    visible.forEach(entry=>{if(!groups.has(entry.type))groups.set(entry.type,[]);groups.get(entry.type).push(entry)});
    const sections=[];
    order.forEach(type=>{
      const entries=groups.get(type)||[];
      if(!entries.length)return;
      entries.sort((a,b)=>String(a.record.name||'').localeCompare(String(b.record.name||''),undefined,{numeric:true,sensitivity:'base'}));
      sections.push(`<div class="root-file-category"><strong>${icons[type]||'📦'} ${labels[type]||type}</strong><span>${entries.length} file${entries.length===1?'':'s'}</span></div>`);
      sections.push(entries.map(({record:r,index:i})=>`<div class="drive-pdf-card" data-root-index="${i}"><button class="root-file-delete" title="Delete from root folder" onclick="deleteRootFile(${i})">🗑</button><div class="drive-file-thumb">${rootThumb(r)}</div><div class="drive-file-kind">${escapeHtml(rootFileType(r.file))}</div><div class="drive-pdf-card-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</div><div class="root-file-path">${escapeHtml(r.path)}</div><div class="drive-pdf-card-meta">${escapeHtml(formatFileBytes(r.file.size||0))}</div><div class="drive-pdf-card-actions"><button onclick="addRootFileToScene(${i})">＋ Add to Scene</button></div></div>`).join(''));
    });
    list.innerHTML=sections.join('');
  };

  function showPptxChoiceModal(title, message, choices) {
    return new Promise(resolve => {
      const overlay=document.createElement('div');
      overlay.style.cssText='position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.72);display:grid;place-items:center;padding:20px;isolation:isolate';
      overlay.setAttribute('role','dialog');
      overlay.setAttribute('aria-modal','true');
      overlay.className='pptx-decision-overlay';
      const card=document.createElement('div');
      card.style.cssText='width:min(560px,96vw);background:var(--panel,#161616);color:var(--text,#fff);border:1px solid rgba(255,255,255,.16);border-radius:16px;padding:22px;box-shadow:0 24px 80px rgba(0,0,0,.55)';
      const heading=document.createElement('h3');
      heading.textContent=title;
      heading.style.cssText='margin:0 0 10px;font-size:20px';
      const body=document.createElement('div');
      body.textContent=message;
      body.style.cssText='white-space:pre-wrap;line-height:1.5;color:var(--text-muted,#bbb);margin-bottom:18px';
      const actions=document.createElement('div');
      actions.style.cssText='display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end';
      const finish=value=>{overlay.remove();resolve(value)};
      (choices||[]).forEach(choice=>{
        const button=document.createElement('button');
        button.type='button';button.textContent=choice.label;
        button.style.cssText='padding:10px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.18);cursor:pointer;background:'+(choice.primary?'var(--accent,#6c63ff)':'rgba(255,255,255,.08)')+';color:#fff';
        button.onclick=()=>finish(choice.value);
        actions.appendChild(button);
      });
      overlay.addEventListener('click',event=>{if(event.target===overlay)finish('cancel')});
      card.append(heading,body,actions);overlay.appendChild(card);document.body.appendChild(overlay);
    });
  }

  async function findRootPptxInCloud(file){
    const separator=GOOGLE_SCRIPT_PDF_UPLOAD_URL.includes('?')?'&':'?';
    const url=GOOGLE_SCRIPT_PDF_UPLOAD_URL+separator+new URLSearchParams({
      action:'findUploadedFile',fileName:file.name,fileSize:String(file.size||0),modifiedAfter:'0',_:String(Date.now())
    });
    const response=await fetch(url,{cache:'no-store',redirect:'follow'});
    const raw=await response.text();let result;
    try{result=JSON.parse(raw)}catch(_){throw new Error('Apps Script returned an unreadable duplicate-check response.')}
    if(!response.ok||result.success===false)throw new Error(result.error||'Unable to check cloud storage.');
    return result.found&&result.file?result.file:null;
  }

  async function keepRootPptxAsPowerPoint(record){
    let existing=null;
    try{existing=await findRootPptxInCloud(record.file)}catch(error){console.warn('PPTX duplicate check failed:',error)}
    if(existing){
      const decision=await showPptxChoiceModal(
        'PowerPoint already in cloud storage',
        `${record.name} is already inside the configured Google Drive folder.\n\nUse the existing cloud copy, replace it with the selected root-folder file, or cancel?`,
        [
          {label:'Use Existing',value:'existing',primary:true},
          {label:'Replace',value:'replace'},
          {label:'Cancel',value:'cancel'}
        ]
      );
      if(decision==='cancel')return;
      if(decision==='existing'){
        if(typeof window.prepareExistingDrivePptx!=='function')throw new Error('The cloud PowerPoint loader is not ready.');
        await window.prepareExistingDrivePptx(existing);
        closeRootFilesModal();
        return;
      }
      if(decision==='replace'){
        await postGoogleScriptJson({action:'deleteDriveFile',fileId:String(existing.id||existing.fileId||'')});
      }
    }
    await window.startPptxEditing({target:{files:[record.file],value:''}});
    closeRootFilesModal();
  }

  async function convertRootPptxToPdf(record){
    await window.convertSelectedPptx({target:{files:[record.file],value:''}});
    closeRootFilesModal();
  }

  window.addRootFileToScene = async function(index) {
    const record=rootFilesCache[index];
    if(!record)return;

    const scene=getActiveScene();
    if(!scene){
      await showModal('Scene Required','Choose a scene first.',false);
      return;
    }

    const type=rootFileType(record.file);

    if(type==='pptx'){
      const choice=await showPptxChoiceModal(
        'Add PowerPoint to Scene',
        `Choose how to process ${record.name}.\n\nKeep as PPTX uploads/imports it to Google Drive so Google Slides can present it. Convert to PDF sends it to the configured conversion API, saves the returned PDF in the root folder, and adds that PDF to the active scene.`,
        [
          {label:'Keep as PPTX',value:'pptx',primary:true},
          {label:'Convert to PDF',value:'pdf'},
          {label:'Cancel',value:'cancel'}
        ]
      );
      try{
        if(choice==='pptx')await keepRootPptxAsPowerPoint(record);
        else if(choice==='pdf')await convertRootPptxToPdf(record);
      }catch(error){
        console.error('PowerPoint processing failed:',error);
        await showModal('PowerPoint Processing Failed',error?.message||String(error),false);
      }
      return;
    }

    let item=(scene.items||[]).find(x=>x.rootRelativePath===record.path);
    if(!item){
      item={
        id:uid(),type,name:record.name,page:1,videoTime:0,videoPlaying:false,
        rootFolderFile:true,rootRelativePath:record.path
      };
      scene.items.push(item);
    }

    item.type=type;
    item.value=URL.createObjectURL(record.file);
    item.mimeType=record.file.type||'';
    item.rootFolderFile=true;
    item.rootRelativePath=record.path;

    if(type==='pdf'&&typeof savePdfToPersistentCache==='function'){
      try{await savePdfToPersistentCache(item.id,item.name,record.file,{})}catch(_){}
    }

    persistScenes();
    renderSceneDeckUI();
    setStagedFromSceneIndex(scene.items.indexOf(item));
    if(typeof populateSlidePreviewGrid==='function')populateSlidePreviewGrid();
  };

  window.deleteRootFile = async function(index) {
    const record=rootFilesCache[index]; if(!record)return;
    const answer=await showModal('Delete Root File','Delete "'+record.name+'" from the selected root folder?',false);
    if(!answer?.confirmed)return;
    try {
      await record.parent.removeEntry(record.name);
      for(const scene of scenes){scene.items=(scene.items||[]).filter(item=>item.rootRelativePath!==record.path)}
      persistScenes(); rootFilesCache=[]; renderSceneDeckUI(); renderPreview(); setSlideStatus(); await renderRootFilesList(true);
    } catch(error){await showModal('Delete Failed',error?.message||String(error),false)}
  };

  async function resolveRootPath(path) {
    if(!folderHandle||!path)return null;
    const parts=String(path).split('/').filter(Boolean); let dir=folderHandle;
    for(let i=0;i<parts.length-1;i++)dir=await dir.getDirectoryHandle(parts[i]);
    const handle=await dir.getFileHandle(parts[parts.length-1]); return handle.getFile();
  }

  window.addEventListener('DOMContentLoaded',()=>setTimeout(async()=>{
    if(!folderHandle)return;
    let changed=false;
    for(const scene of scenes){for(const item of (scene.items||[])){if(item.rootRelativePath){try{const file=await resolveRootPath(item.rootRelativePath);item.value=URL.createObjectURL(file);item.mimeType=item.mimeType||file.type;changed=true}catch(_){}}}}
    if(changed){persistScenes();renderSceneDeckUI();if(staged?.sceneItemIndex>=0)setStagedFromSceneIndex(staged.sceneItemIndex)}
  },1400));
})();

/* ===== Extracted inline script block ===== */

/* V26: reliable local video transfer, synchronized playback, and audio in Display Screen. */
(() => {
  const VIDEO_BLOB_COMMAND = 'PRESENTER_VIDEO_BLOB_LIVE_V26';
  let outputVideoObjectUrl = '';
  let lastVideoBlobPayload = null;

  async function getLocalVideoBlob(payload) {
    if (!payload || payload.type !== 'video') return null;

    // Root-folder files are the preferred source because their temporary blob URL
    // cannot be reused by the separate display window.
    if (payload.rootRelativePath && typeof resolveRootPath === 'function') {
      try {
        const file = await resolveRootPath(payload.rootRelativePath);
        if (file) return file;
      } catch (_) {}
    }

    // Cached assets may already have a Blob/File saved in IndexedDB.
    if (typeof getCachedMediaBlob === 'function') {
      try {
        const cached = await getCachedMediaBlob(payload);
        if (cached) return cached;
      } catch (_) {}
    }
    if (typeof getCachedPdfBlob === 'function') {
      try {
        const cached = await getCachedPdfBlob(payload);
        if (cached && String(cached.type || '').startsWith('video/')) return cached;
      } catch (_) {}
    }

    // A blob URL can be fetched only in the operator window where it was created.
    if (payload.value && /^blob:/i.test(String(payload.value))) {
      try {
        const response = await fetch(payload.value);
        if (response.ok) return await response.blob();
      } catch (_) {}
    }
    return null;
  }

  function cloneVideoMetadata(payload) {
    return {
      type: 'video',
      itemId: payload.itemId || payload.id || '',
      name: payload.name || 'Video',
      mimeType: payload.mimeType || '',
      videoTime: Number(payload.videoTime || 0),
      videoPlaying: Boolean(payload.videoPlaying),
      rootRelativePath: payload.rootRelativePath || '',
      sceneItemIndex: Number.isFinite(payload.sceneItemIndex) ? payload.sceneItemIndex : -1
    };
  }

  async function sendVideoBlobToDisplay(payload, transitionType = 'cut') {
    const blob = await getLocalVideoBlob(payload);
    if (!blob) return false;
    const message = {
      command: VIDEO_BLOB_COMMAND,
      blob,
      payload: cloneVideoMetadata(payload),
      transitionType
    };
    lastVideoBlobPayload = message;
    channel.postMessage(message);
    try {
      if (displayWindow && !displayWindow.closed) displayWindow.postMessage(message, '*');
    } catch (_) {}
    return true;
  }

  function showAudioUnlock(video) {
    const view = document.getElementById('audience-view');
    if (!view || document.getElementById('display-audio-unlock-v26')) return;
    const button = document.createElement('button');
    button.id = 'display-audio-unlock-v26';
    button.type = 'button';
    button.textContent = '▶ Start Video With Sound';
    button.style.cssText = [
      'position:fixed','left:50%','top:50%','transform:translate(-50%,-50%)',
      'z-index:999999','padding:16px 24px','font-size:18px','font-weight:800',
      'border-radius:12px','background:#0084ff','color:#fff','border:1px solid rgba(255,255,255,.35)',
      'box-shadow:0 14px 40px rgba(0,0,0,.55)','cursor:pointer'
    ].join(';');
    button.onclick = async () => {
      window.__displayAudioUnlockedV26 = true;
      video.muted = false;
      video.volume = 1;
      try { await video.play(); } catch (_) {}
      button.remove();
    };
    view.appendChild(button);
  }

  async function renderDisplayVideoFromBlob(message) {
    if (!document.body.classList.contains('live-window-mode')) return;
    if (!message || message.command !== VIDEO_BLOB_COMMAND || !message.blob) return;

    const audience = document.getElementById('audience-view');
    if (!audience) return;
    const bgLayer = document.getElementById('audience-bg-layer');
    Array.from(audience.children).forEach(el => {
      if (el !== bgLayer) el.remove();
    });

    if (outputVideoObjectUrl) {
      try { URL.revokeObjectURL(outputVideoObjectUrl); } catch (_) {}
    }
    outputVideoObjectUrl = URL.createObjectURL(message.blob);

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'position:absolute;inset:0;background:#000;display:flex;align-items:center;justify-content:center;';
    const video = document.createElement('video');
    video.id = 'audience-live-video';
    video.src = outputVideoObjectUrl;
    video.preload = 'auto';
    video.playsInline = true;
    video.controls = false;
    video.muted = false;
    video.volume = 1;
    video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
    wrapper.appendChild(video);
    if (bgLayer) audience.appendChild(bgLayer);
    audience.appendChild(wrapper);

    const meta = message.payload || {};
    video.addEventListener('loadedmetadata', async () => {
      const requestedTime = Number(meta.videoTime || 0);
      if (Number.isFinite(requestedTime) && requestedTime > 0) {
        try { video.currentTime = Math.min(requestedTime, Math.max(0, video.duration || requestedTime)); } catch (_) {}
      }
      if (meta.videoPlaying) {
        try {
          await video.play();
          window.__displayAudioUnlockedV26 = true;
        } catch (_) {
          showAudioUnlock(video);
        }
      }
    }, { once: true });
  }

  channel.addEventListener('message', event => renderDisplayVideoFromBlob(event.data));
  window.addEventListener('message', event => renderDisplayVideoFromBlob(event.data));

  // Ask the operator window to resend the video Blob when the display is newly opened.
  channel.addEventListener('message', event => {
    const message = event.data || {};
    if (message.command === 'REQUEST_CURRENT_OUTPUT' && !document.body.classList.contains('live-window-mode')) {
      if (liveState && liveState.type === 'video') sendVideoBlobToDisplay(liveState, 'cut');
    }
  });

  const previousFireLiveV26 = window.fireLive;
  window.fireLive = async function() {
    if (staged && staged.type === 'video') {
      if (isFTBActive || isFTGActive) return previousFireLiveV26();
      const transition = document.getElementById('transition-type-select')?.value || 'cut';
      liveState = (typeof clonePresenterPayload === 'function')
        ? clonePresenterPayload(staged)
        : JSON.parse(JSON.stringify(staged));
      await renderLiveView();
      const sent = await sendVideoBlobToDisplay(liveState, transition);
      if (sent) return;
    }
    return previousFireLiveV26();
  };

  // Keep the display video synchronized with Preview play/pause and seeking.
  const previousSyncLiveVideoV26 = window.syncLiveVideoFromPreview;
  window.syncLiveVideoFromPreview = function(time, playing) {
    if (typeof previousSyncLiveVideoV26 === 'function') previousSyncLiveVideoV26(time, playing);
    const message = {
      command: 'SYNC_VIDEO_STATE',
      time: Number(time || 0),
      playing: Boolean(playing),
      muted: false,
      volume: 1
    };
    channel.postMessage(message);
    try {
      if (displayWindow && !displayWindow.closed) displayWindow.postMessage(message, '*');
    } catch (_) {}
  };

  async function applyVideoSync(message) {
    if (!document.body.classList.contains('live-window-mode')) return;
    if (!message || message.command !== 'SYNC_VIDEO_STATE') return;
    const video = document.getElementById('audience-live-video');
    if (!video) return;
    const time = Number(message.time || 0);
    if (Number.isFinite(time) && Math.abs((video.currentTime || 0) - time) > 0.35) {
      try { video.currentTime = time; } catch (_) {}
    }
    video.muted = false;
    video.volume = 1;
    if (message.playing) {
      try {
        await video.play();
      } catch (_) {
        showAudioUnlock(video);
      }
    } else if (!video.paused) {
      video.pause();
    }
  }
  channel.addEventListener('message', event => applyVideoSync(event.data));
  window.addEventListener('message', event => applyVideoSync(event.data));

  // The fullscreen/start button is a user gesture, so use it to unlock audio.
  document.addEventListener('click', event => {
    if (!document.body.classList.contains('live-window-mode')) return;
    if (event.target && event.target.id === 'fs-engage-btn') {
      window.__displayAudioUnlockedV26 = true;
      const video = document.getElementById('audience-live-video');
      if (video) {
        video.muted = false;
        video.volume = 1;
        if (lastIncoming && lastIncoming.videoPlaying) video.play().catch(() => {});
      }
    }
  }, true);
})();

/* ===== Extracted inline script block ===== */

/* V28: retain each scene video's playback state while browsing scenes. */
(() => {
  let restoringVideoState = false;

  function activeSceneVideoItem() {
    try {
      const scene = getActiveScene();
      if (!scene || !staged || staged.type !== 'video') return null;
      if (Number.isInteger(staged.sceneItemIndex) && scene.items?.[staged.sceneItemIndex]) {
        return scene.items[staged.sceneItemIndex];
      }
      return scene.items?.find(item => (staged.itemId && item.id === staged.itemId) || (staged.id && item.id === staged.id)) || null;
    } catch (_) { return null; }
  }

  function saveCurrentPreviewVideoState() {
    const video = document.querySelector('#preview-viewport video');
    const item = activeSceneVideoItem();
    if (!video || !item) return;
    item.videoTime = Number(video.currentTime || 0);
    item.videoPlaying = !video.paused && !video.ended;
    staged.videoTime = item.videoTime;
    staged.videoPlaying = item.videoPlaying;
    try { persistScenes(); } catch (_) {}
  }

  function bindPreviewVideoState() {
    const video = document.querySelector('#preview-viewport video');
    if (!video || video.dataset.v28StateBound === '1') return;
    video.dataset.v28StateBound = '1';

    const update = () => {
      if (restoringVideoState) return;
      const item = activeSceneVideoItem();
      if (!item) return;
      item.videoTime = Number(video.currentTime || 0);
      item.videoPlaying = !video.paused && !video.ended;
      staged.videoTime = item.videoTime;
      staged.videoPlaying = item.videoPlaying;
    };
    video.addEventListener('timeupdate', update);
    video.addEventListener('play', () => { update(); try { persistScenes(); } catch (_) {} });
    video.addEventListener('pause', () => { update(); try { persistScenes(); } catch (_) {} });
    video.addEventListener('seeked', update);
    video.addEventListener('ended', () => {
      const item = activeSceneVideoItem();
      if (item) { item.videoTime = Number(video.duration || video.currentTime || 0); item.videoPlaying = false; }
      staged.videoPlaying = false;
      try { persistScenes(); } catch (_) {}
    });
  }

  const previousRenderPreview = window.renderPreview;
  window.renderPreview = async function(...args) {
    const result = await previousRenderPreview.apply(this, args);
    bindPreviewVideoState();
    const video = document.querySelector('#preview-viewport video');
    if (video && staged?.type === 'video') {
      const wantedTime = Number(staged.videoTime || 0);
      const shouldPlay = Boolean(staged.videoPlaying);
      restoringVideoState = true;
      try {
        if (Number.isFinite(wantedTime) && Math.abs(Number(video.currentTime || 0) - wantedTime) > 0.25) {
          video.currentTime = wantedTime;
        }
        const button = document.getElementById('preview-vid-toggle-btn');
        if (shouldPlay) {
          await video.play().catch(() => {});
          if (button) button.textContent = '⏹ Stop';
        } else {
          video.pause();
          if (button) button.textContent = '▶ Play';
        }
      } finally {
        restoringVideoState = false;
      }
    }
    return result;
  };

  // Save the outgoing scene's preview position before its click handler changes activeSceneId.
  document.addEventListener('pointerdown', event => {
    if (event.target.closest('#scene-list .scene-item')) saveCurrentPreviewVideoState();
  }, true);

  window.addEventListener('beforeunload', saveCurrentPreviewVideoState);
})();

/* ===== Extracted inline script block ===== */

/* Built-in PPTX -> PDF conversion through CloudConvert.
   The CloudConvert API key is stored only in Google Apps Script Script Properties. */
(() => {
  let pptxConversionBusy = false;

  window.choosePptxForConversion = function() {
    if (pptxConversionBusy) return;
    document.getElementById('pptx-converter-input')?.click();
  };

  function setPptxStatus(message, state = '') {
    const el = document.getElementById('pptx-convert-status');
    if (!el) return;
    el.textContent = String(message || '');
    el.classList.toggle('show', Boolean(message));
    el.classList.toggle('error', state === 'error');
    if (state === 'success') {
      el.style.borderColor = 'rgba(36,180,81,.5)';
      el.style.background = 'rgba(36,180,81,.1)';
      el.style.color = 'var(--accent-green)';
    } else {
      el.style.removeProperty('border-color');
      el.style.removeProperty('background');
      el.style.removeProperty('color');
    }
  }

  function setPptxProgress(percent, detail = '', visible = true) {
    const wrap = document.getElementById('pptx-convert-progress');
    const bar = document.getElementById('pptx-convert-progress-bar');
    const label = document.getElementById('pptx-convert-progress-label');
    const value = Math.max(0, Math.min(100, Number(percent) || 0));
    wrap?.classList.toggle('show', visible);
    label?.classList.toggle('show', visible);
    if (bar) bar.style.width = value + '%';
    if (label) label.textContent = Math.round(value) + '%' + (detail ? ' · ' + detail : '');
  }

  function uploadPptxToCloudConvert(upload, file) {
    return new Promise((resolve, reject) => {
      if (!upload || !upload.url) return reject(new Error('CloudConvert did not return an upload URL.'));
      const form = new FormData();
      Object.entries(upload.parameters || {}).forEach(([key, value]) => form.append(key, String(value)));
      form.append('file', file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', upload.url, true);
      xhr.timeout = 10 * 60 * 1000;
      xhr.upload.onprogress = event => {
        if (!event.lengthComputable) return;
        const percent = 5 + (event.loaded / event.total) * 45;
        setPptxProgress(percent, 'Uploading PowerPoint');
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 400) resolve();
        else reject(new Error('CloudConvert upload failed (' + xhr.status + ').'));
      };
      xhr.onerror = () => reject(new Error('Network error while uploading the PowerPoint file.'));
      xhr.ontimeout = () => reject(new Error('PowerPoint upload timed out.'));
      xhr.send(form);
    });
  }

  async function waitForPptxConversion(jobId) {
    const started = Date.now();
    while (Date.now() - started < 12 * 60 * 1000) {
      const separator = GOOGLE_SCRIPT_PDF_UPLOAD_URL.includes('?') ? '&' : '?';
      const url = GOOGLE_SCRIPT_PDF_UPLOAD_URL + separator + new URLSearchParams({
        action: 'cloudConvertPptxStatus',
        jobId: String(jobId),
        _: String(Date.now())
      });
      const response = await fetch(url, { cache: 'no-store', redirect: 'follow' });
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); }
      catch (_) { throw new Error('Apps Script returned an unreadable conversion response.'); }
      if (!response.ok || result.success === false) throw new Error(result.error || 'Unable to read conversion status.');
      if (result.status === 'error') throw new Error(result.error || 'CloudConvert could not convert this presentation.');
      if (result.status === 'finished' && result.url) return result;
      const percent = Number(result.percent || 0);
      setPptxProgress(52 + Math.min(38, percent * 0.38), result.message || 'Converting to PDF');
      await new Promise(resolve => setTimeout(resolve, 1800));
    }
    throw new Error('Conversion took too long. Check the CloudConvert dashboard for this job.');
  }

  async function saveConvertedPdfToRoot(pdfBlob, pdfName) {
    if (!(await ensureRootFolderPermission(true))) throw new Error('A writable root folder is required.');
    const safeName = String(pdfName || 'converted-presentation.pdf').replace(/[\\/:*?"<>|]/g, '_');
    const handle = await folderHandle.getFileHandle(safeName, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(pdfBlob);
      await writable.close();
    } catch (error) {
      try { await writable.abort(); } catch (_) {}
      throw error;
    }
    await addDownloadedRootFileToScene(safeName, null);
    if (typeof refreshRootFolderNow === 'function') await refreshRootFolderNow(false);
    return safeName;
  }

  window.convertSelectedPptx = async function(event) {
    const input = event?.target;
    const file = input?.files?.[0];
    if (!file || pptxConversionBusy) return;
    const lower = String(file.name || '').toLowerCase();
    if (!lower.endsWith('.pptx')) {
      setPptxStatus('Choose a .pptx PowerPoint file.', 'error');
      input.value = '';
      return;
    }

    const button = document.getElementById('pptx-convert-btn');
    pptxConversionBusy = true;
    if (button) { button.disabled = true; button.textContent = 'Converting PowerPoint...'; }
    setPptxStatus('Preparing ' + file.name + '...');
    setPptxProgress(2, formatFileBytes(file.size), true);

    try {
      if (!(await ensureRootFolderPermission(true))) throw new Error('Choose the root folder before converting.');
      const init = await postGoogleScriptJson({
        action: 'createCloudConvertPptxJob',
        fileName: file.name,
        fileSize: file.size
      });
      if (!init.jobId || !init.upload) throw new Error('The backend did not return a CloudConvert upload task.');

      setPptxStatus('Uploading PowerPoint securely to CloudConvert...');
      await uploadPptxToCloudConvert(init.upload, file);
      setPptxProgress(52, 'Upload complete');
      setPptxStatus('CloudConvert is creating the PDF...');

      const finished = await waitForPptxConversion(init.jobId);
      setPptxProgress(92, 'Downloading PDF');
      const pdfResponse = await fetch(finished.url, { redirect: 'follow', cache: 'no-store' });
      if (!pdfResponse.ok) throw new Error('Converted PDF download failed (' + pdfResponse.status + ').');
      const pdfBlob = await pdfResponse.blob();
      if (!pdfBlob.size) throw new Error('CloudConvert returned an empty PDF.');
      const defaultName = file.name.replace(/\.pptx$/i, '') + '.pdf';
      const savedName = await saveConvertedPdfToRoot(pdfBlob, finished.fileName || defaultName);

      setPptxProgress(100, 'Ready');
      setPptxStatus('✅ Converted, saved to the root folder, and added to the active scene: ' + savedName, 'success');
      setTimeout(() => setPptxProgress(0, '', false), 2800);
    } catch (error) {
      console.error('PPTX conversion failed:', error);
      setPptxProgress(0, '', false);
      setPptxStatus('Conversion failed: ' + (error?.message || String(error)), 'error');
    } finally {
      pptxConversionBusy = false;
      if (button) { button.disabled = false; button.textContent = '📊 Convert PPTX to PDF'; }
      if (input) input.value = '';
    }
  };
})();

/* ===== Extracted inline script block ===== */

/* Google Slides text editor. CloudConvert quick conversion remains unchanged.
   Required Apps Script actions:
   prepareGoogleSlidesEditor, updateGoogleSlidesText, updateGoogleSlidesSlideText,
   resetGoogleSlidesPresentation, exportEditedSlidesToPdf, cancelGoogleSlidesEditing. */
(() => {
  const editorState = {
    busy:false, sourceFileId:'', sourceFileName:'', presentationId:'', temporaryFileIds:[],
    slides:[], selectedSlideIndex:0, selectedObjectId:'', originalSnapshotId:'',
    autoApplyTimer:null, autoApplyRequest:0, lastAppliedKey:'', pendingEdits:{}, dragState:null
  };
  window.pptxEditorState = editorState;

  function setEditStatus(message, state='') {
    const el=document.getElementById('pptx-edit-status');
    if(!el)return;
    el.textContent=String(message||'');
    el.classList.toggle('show',Boolean(message));
    el.classList.toggle('error',state==='error');
  }
  function setEditorStatus(message,state=''){
    const el=document.getElementById('pptx-editor-status');if(!el)return;
    el.textContent=String(message||'');el.classList.toggle('show',Boolean(message));el.classList.toggle('error',state==='error');
    if(state==='success'){el.style.borderColor='rgba(36,180,81,.5)';el.style.background='rgba(36,180,81,.1)';el.style.color='var(--accent-green)'}
    else{el.style.removeProperty('border-color');el.style.removeProperty('background');el.style.removeProperty('color')}
  }
  function setEditorProgress(percent,detail='',visible=true){
    const p=Math.max(0,Math.min(100,Number(percent)||0));
    const targets=[
      ['pptx-editor-progress','pptx-editor-progress-bar','pptx-editor-progress-label'],
      ['pptx-edit-upload-progress','pptx-edit-upload-progress-bar','pptx-edit-upload-progress-label']
    ];
    targets.forEach(([wrapId,barId,labelId])=>{
      const wrap=document.getElementById(wrapId),bar=document.getElementById(barId),label=document.getElementById(labelId);
      wrap?.classList.toggle('show',visible);label?.classList.toggle('show',visible);
      if(bar)bar.style.width=p+'%';
      if(label)label.textContent=Math.round(p)+'%'+(detail?' · '+detail:'');
    });
  }
  function setEditorBusy(busy,label=''){
    editorState.busy=Boolean(busy);
    ['pptx-edit-btn','pptx-editor-export-btn','pptx-editor-add-btn'].forEach(id=>{const b=document.getElementById(id);if(b)b.disabled=editorState.busy});
    const main=document.getElementById('pptx-edit-btn');if(main)main.textContent=busy?(label||'Preparing PowerPoint...'):'📊 Add / Edit PowerPoint';
  }

  window.choosePptxForEditing=function(){if(editorState.busy)return;document.getElementById('pptx-editor-input')?.click()};

  async function uploadPptxForSlides(file){
    const init=await postGoogleScriptJson({action:'initResumableFileUpload',fileName:file.name,mimeType:file.type||'application/vnd.openxmlformats-officedocument.presentationml.presentation',fileSize:file.size});
    if(!init.uploadUrl)throw new Error('Apps Script did not return an upload URL.');
    return new Promise((resolve,reject)=>{
      const xhr=new XMLHttpRequest();xhr.open('PUT',init.uploadUrl,true);xhr.timeout=10*60*1000;
      xhr.setRequestHeader('Content-Type',file.type||'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      xhr.setRequestHeader('Content-Range',`bytes 0-${file.size-1}/${file.size}`);
      xhr.upload.onprogress=e=>{if(e.lengthComputable)setEditorProgress(3+(e.loaded/e.total)*62,'Uploading PowerPoint · '+formatFileBytes(e.loaded)+' / '+formatFileBytes(e.total))};
      xhr.onload=()=>{
        if([200,201,308].includes(xhr.status)){
          let obj={};
          try{obj=JSON.parse(xhr.responseText||'{}')}catch(_){}
          resolve(obj);
        }else{
          reject(new Error('Drive upload failed ('+xhr.status+').'));
        }
      };
      // Google Drive may complete a resumable upload but omit browser-readable
      // CORS headers on the final response. Verify the uploaded file afterward
      // instead of immediately treating that response as a failed upload.
      xhr.onerror=()=>resolve({uploadResponseUnreadable:true});
      xhr.ontimeout=()=>resolve({uploadResponseUnreadable:true,uploadTimedOut:true});
      xhr.send(file);
    });
  }

  async function findUploadedPptx(file,uploadResult){
    if(uploadResult&&(uploadResult.id||uploadResult.fileId))return uploadResult;

    const startedAt=Date.now();
    let lastError=null;
    for(let attempt=0;attempt<8;attempt+=1){
      const pct=Math.min(74,67+attempt);
      setEditorProgress(pct,'Verifying PowerPoint upload'+(attempt?' · retry '+attempt:''));
      try{
        const separator=GOOGLE_SCRIPT_PDF_UPLOAD_URL.includes('?')?'&':'?';
        const url=GOOGLE_SCRIPT_PDF_UPLOAD_URL+separator+new URLSearchParams({
          action:'findUploadedFile',
          fileName:file.name,
          fileSize:String(file.size),
          modifiedAfter:String(startedAt-120000),
          _:String(Date.now())
        }).toString();
        const response=await fetch(url,{cache:'no-store',redirect:'follow'});
        const raw=await response.text();
        let result=null;
        try{result=JSON.parse(raw)}catch(_){}
        if(response.ok&&result&&result.success!==false&&result.found&&result.file)return result.file;
        if(result&&result.success===false)lastError=new Error(result.error||'Fast upload verification failed.');
      }catch(error){lastError=error}
      await new Promise(resolve=>setTimeout(resolve,attempt<2?350:650));
    }

    // Compatibility fallback for an older Apps Script deployment.
    const record=await verifyUploadedDriveFile(file,3);
    if(record)return record;
    if(lastError)console.warn('Fast PPTX verification warning:',lastError);
    throw new Error('The PowerPoint upload finished, but the file could not be verified. Redeploy the updated Apps Script backend, then try again.');
  }

  window.startPptxEditing=async function(event){
    const input=event?.target,file=input?.files?.[0];if(!file||editorState.busy)return;
    if(!/\.pptx$/i.test(file.name)){setEditStatus('Choose a .pptx PowerPoint file.','error');input.value='';return}
    setEditorBusy(true,'Uploading for editing...');setEditStatus('Preparing '+file.name+' for Google Slides editing...');setEditorProgress(2,formatFileBytes(file.size),true);
    try{
      await verifyGoogleScriptResumableBackend();
      const uploadResult=await uploadPptxForSlides(file);
      const driveRecord=await findUploadedPptx(file,uploadResult);
      editorState.sourceFileId=String(driveRecord.id||driveRecord.fileId||'');editorState.sourceFileName=file.name;
      if(!editorState.sourceFileId)throw new Error('Missing uploaded PowerPoint file ID.');
      setEditorProgress(72,'Importing into Google Slides');
      const prepared=await postGoogleScriptJson({action:'prepareGoogleSlidesEditor',sourceFileId:editorState.sourceFileId,fileName:file.name});
      if(!prepared.presentationId||!Array.isArray(prepared.slides))throw new Error('Apps Script did not return editable slide data.');
      editorState.presentationId=String(prepared.presentationId);editorState.slides=prepared.slides;editorState.originalSnapshotId=String(prepared.originalSnapshotId||'');editorState.temporaryFileIds=Array.from(new Set([editorState.sourceFileId,...(prepared.temporaryFileIds||[]),editorState.presentationId].filter(Boolean)));
      editorState.selectedSlideIndex=0;editorState.selectedObjectId='';editorState.pendingEdits={};
      document.getElementById('pptx-editor-file-name').textContent=file.name;
      renderPptxEditor();
      if (typeof window.addCurrentPptxPresentationToScene === 'function') {
        await window.addCurrentPptxPresentationToScene();
      }setEditorProgress(100,'Ready');setEditorStatus('Preview font size, color, and position. Click Add / Update Presentation Asset to save.','success');setEditStatus('PowerPoint editor opened.');
      setTimeout(()=>setEditorProgress(0,'',false),1200);
    }catch(error){console.error('Google Slides editor preparation failed:',error);setEditorProgress(0,'',false);setEditStatus('Editor failed: '+(error?.message||String(error)),'error');await cleanupPptxEditorTemporaryFiles(false)}
    finally{setEditorBusy(false);if(input)input.value=''}
  };

  function currentEditorSlide(){return editorState.slides[editorState.selectedSlideIndex]||null}
  function textBoxesForSlide(slide){return Array.isArray(slide?.textBoxes)?slide.textBoxes:[]}

  function editForBox(box){
    const key=String(box?.objectId||'');
    return editorState.pendingEdits[key] || null;
  }
  function effectiveBox(box){
    const edit=editForBox(box)||{};
    const original=box?.bounds||{};
    return Object.assign({},box,{
      fontSize:Number(edit.fontSize||box?.fontSize||24),
      fontColor:String(edit.fontColor||box?.fontColor||'#ffffff'),
      bounds:Object.assign({},original,{
        leftPercent:Number(original.leftPercent||0)+Number(edit.dxPercent||0),
        topPercent:Number(original.topPercent||0)+Number(edit.dyPercent||0)
      })
    });
  }
  function slideHasPending(slide){return textBoxesForSlide(slide).some(box=>Boolean(editForBox(box)))}
  function beginPptxBoxDrag(event,box){
    if(event.button!==undefined&&event.button!==0)return;
    event.preventDefault();event.stopPropagation();
    selectPptxTextBox(String(box.objectId));
    const preview=document.getElementById('pptx-editor-preview');
    const rect=preview?.getBoundingClientRect();if(!rect)return;
    const current=editForBox(box)||{};
    editorState.dragState={objectId:String(box.objectId),startX:event.clientX,startY:event.clientY,startDx:Number(current.dxPercent||0),startDy:Number(current.dyPercent||0),width:rect.width,height:rect.height};
    const move=e=>{
      const drag=editorState.dragState;if(!drag)return;
      const edit=Object.assign({},editorState.pendingEdits[drag.objectId]||{});
      edit.dxPercent=drag.startDx+(e.clientX-drag.startX)/Math.max(1,drag.width)*100;
      edit.dyPercent=drag.startDy+(e.clientY-drag.startY)/Math.max(1,drag.height)*100;
      editorState.pendingEdits[drag.objectId]=edit;renderPptxEditor();
    };
    const up=()=>{editorState.dragState=null;window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);setEditorStatus('Position preview updated. Click Add / Update Presentation Asset to save.','success')};
    window.addEventListener('pointermove',move);window.addEventListener('pointerup',up,{once:true});
  }
  function renderPptxEditor(){
    const list=document.getElementById('pptx-editor-slide-list');if(list){list.innerHTML='';editorState.slides.forEach((slide,index)=>{const b=document.createElement('button');b.type='button';b.className='pptx-editor-slide-button'+(index===editorState.selectedSlideIndex?' active':'')+(slideHasPending(slide)?' pending':'');b.innerHTML=(slide.thumbnailUrl?`<img src="${escapeHtml(slide.thumbnailUrl)}" alt="Slide ${index+1}">`:'<div style="aspect-ratio:16/9;background:#000;display:grid;place-items:center;border-radius:6px;margin-bottom:7px;">Slide '+(index+1)+'</div>')+`<span>Slide ${index+1} · ${textBoxesForSlide(slide).length} text box${textBoxesForSlide(slide).length===1?'':'es'}</span>`;b.onclick=()=>{editorState.selectedSlideIndex=index;editorState.selectedObjectId='';renderPptxEditor()};list.appendChild(b)})}
    const slide=currentEditorSlide(),preview=document.getElementById('pptx-editor-preview');if(preview){preview.innerHTML='';if(!slide){preview.innerHTML='<div class="status-text">No slide data returned.</div>'}else{const img=document.createElement('img');img.src=slide.thumbnailUrl||'';img.alt='Selected slide preview';preview.appendChild(img);textBoxesForSlide(slide).forEach(box=>{if(!box.bounds)return;const effective=effectiveBox(box),overlay=document.createElement('button');overlay.type='button';overlay.className='pptx-editor-overlay'+(String(box.objectId)===editorState.selectedObjectId?' active':'')+(editForBox(box)?' pending':'');overlay.title=(box.text||'Text box')+' — drag to move';overlay.textContent=box.text||'';overlay.style.left=(Number(effective.bounds.leftPercent)||0)+'%';overlay.style.top=(Number(effective.bounds.topPercent)||0)+'%';overlay.style.width=Math.max(.8,Number(effective.bounds.widthPercent)||0)+'%';overlay.style.height=Math.max(.8,Number(effective.bounds.heightPercent)||0)+'%';overlay.style.color=effective.fontColor;overlay.style.fontSize=Math.max(7,Math.min(42,effective.fontSize*.45))+'px';overlay.onclick=e=>{e.stopPropagation();selectPptxTextBox(String(box.objectId))};overlay.onpointerdown=e=>beginPptxBoxDrag(e,box);preview.appendChild(overlay)})}}
    const select=document.getElementById('pptx-editor-textbox-select');if(select){select.innerHTML='<option value="">Choose a text box</option>';textBoxesForSlide(slide).forEach((box,index)=>{const o=document.createElement('option');o.value=String(box.objectId);o.textContent=`${index+1}. ${(box.text||'Text box').slice(0,75)}`;o.selected=o.value===editorState.selectedObjectId;select.appendChild(o)})}
    updateSelectedTextBoxUi();
  }
  window.renderPptxEditor=renderPptxEditor;

  window.selectPptxTextBox=function(objectId){editorState.selectedObjectId=String(objectId||'');renderPptxEditor()};
  function selectedTextBox(){return textBoxesForSlide(currentEditorSlide()).find(box=>String(box.objectId)===editorState.selectedObjectId)||null}
  function updateSelectedTextBoxUi(){
    const box=selectedTextBox(),effective=box?effectiveBox(box):null,sample=document.getElementById('pptx-editor-text-sample'),size=document.getElementById('pptx-editor-font-size'),color=document.getElementById('pptx-editor-font-color'),label=document.getElementById('pptx-editor-auto-save-label');
    if(sample)sample.textContent=box?(box.text||'Empty text box'):'No text box selected.';
    if(size){size.value=effective?String(Number(effective.fontSize)||''):'';size.disabled=!box||editorState.busy}
    if(color){color.value=effective?.fontColor||'#ffffff';color.disabled=!box||editorState.busy}
    if(label)label.textContent=box?(editForBox(box)?'Pending save':'Preview only'):'Select text';
  }
  function stageSelectedEdit(patch){
    const box=selectedTextBox();if(!box||editorState.busy)return;
    const key=String(box.objectId);editorState.pendingEdits[key]=Object.assign({},editorState.pendingEdits[key]||{},patch||{});
    renderPptxEditor();setEditorStatus('Preview updated locally. Click Add / Update Presentation Asset to save.','success');
  }
  window.adjustPptxFontSize=function(delta){const input=document.getElementById('pptx-editor-font-size'),box=selectedTextBox();if(!input||!box)return;const current=Number(input.value)||Number(effectiveBox(box).fontSize)||12;input.value=String(Math.max(1,Math.min(300,current+Number(delta||0))));window.queuePptxFontSizeUpdate()};
  window.queuePptxFontSizeUpdate=function(){const input=document.getElementById('pptx-editor-font-size');const value=Math.max(1,Math.min(300,Number(input?.value)||0));if(value)stageSelectedEdit({fontSize:value})};
  window.queuePptxFontColorUpdate=function(){const color=document.getElementById('pptx-editor-font-color')?.value;if(color)stageSelectedEdit({fontColor:color})};
  window.applyPptxFontSize=function(){window.queuePptxFontSizeUpdate()};
  async function refreshEditorPresentation(){const data=await postGoogleScriptJson({action:'getGoogleSlidesEditorData',presentationId:editorState.presentationId});if(Array.isArray(data.slides)){editorState.slides=data.slides;renderPptxEditor()}}
  window.commitPptxPendingEdits=async function(){
    const edits=Object.entries(editorState.pendingEdits).map(([objectId,edit])=>Object.assign({objectId},edit));
    if(!edits.length)return {applied:0};
    setEditorBusy(true,'Saving edits...');setEditorStatus('Saving '+edits.length+' pending edit'+(edits.length===1?'':'s')+' to Google Slides...');
    try{const result=await postGoogleScriptJson({action:'applyGoogleSlidesEdits',presentationId:editorState.presentationId,edits});editorState.pendingEdits={};await refreshEditorPresentation();setEditorStatus('All previewed edits were saved.','success');return result}
    catch(error){setEditorStatus('Save failed: '+(error?.message||String(error)),'error');throw error}
    finally{setEditorBusy(false)}
  };

  window.applyPptxFontToSlide=function(){const slide=currentEditorSlide();if(!slide)return;const fontSize=Math.max(6,Math.min(120,Number(document.getElementById('pptx-editor-font-size')?.value)||24));textBoxesForSlide(slide).forEach(box=>{editorState.pendingEdits[String(box.objectId)]=Object.assign({},editorState.pendingEdits[String(box.objectId)]||{},{fontSize})});renderPptxEditor();setEditorStatus('Font-size preview applied to all text on slide '+(editorState.selectedSlideIndex+1)+'.','success')};

  window.resetPptxEditorChanges=async function(){if(!editorState.presentationId)return;editorState.pendingEdits={};setEditorBusy(true,'Resetting...');setEditorStatus('Restoring the original imported presentation...');try{const result=await postGoogleScriptJson({action:'resetGoogleSlidesPresentation',presentationId:editorState.presentationId,originalSnapshotId:editorState.originalSnapshotId});if(result.presentationId)editorState.presentationId=String(result.presentationId);if(typeof window.syncCurrentPptxAssetFromEditor==='function')window.syncCurrentPptxAssetFromEditor();if(Array.isArray(result.slides))editorState.slides=result.slides;else await refreshEditorPresentation();editorState.selectedSlideIndex=0;editorState.selectedObjectId='';renderPptxEditor();setEditorStatus('Presentation reset.','success')}catch(error){setEditorStatus('Reset failed: '+(error?.message||String(error)),'error')}finally{setEditorBusy(false)}};

  async function saveTemporaryPdfRecordToRoot(record){if(!(await ensureRootFolderPermission(true)))throw new Error('Choose the root folder first.');const saved=await downloadCloudFileInChunksToRoot(record,(loaded,total)=>{const pct=total?70+(loaded/total)*25:80;setEditorProgress(pct,'Saving PDF to root folder')});await addDownloadedRootFileToScene(saved.fileName,record);return saved}

  window.exportEditedPptxToPdf=async function(){if(!editorState.presentationId||editorState.busy)return;setEditorBusy(true,'Exporting PDF...');setEditorProgress(5,'Exporting Google Slides',true);setEditorStatus('Creating the edited PDF...');try{const base=editorState.sourceFileName.replace(/\.pptx$/i,'')||'edited-presentation';const result=await postGoogleScriptJson({action:'exportEditedSlidesToPdf',presentationId:editorState.presentationId,fileName:base+'-edited.pdf'});const record=result.file||result;if(!(record.id||record.fileId)||!record.name)throw new Error('Apps Script did not return the temporary PDF file record.');editorState.temporaryFileIds.push(String(record.id||record.fileId));setEditorProgress(65,'Downloading edited PDF');const saved=await saveTemporaryPdfRecordToRoot(record);setEditorProgress(100,'Ready');setEditorStatus('✅ Saved to the root folder and added to Media Assets: '+saved.fileName,'success');setEditStatus('Edited presentation exported: '+saved.fileName);if(typeof window.syncCurrentPptxAssetFromEditor==='function')window.syncCurrentPptxAssetFromEditor();setTimeout(()=>{setEditorProgress(0,'',false)},1000)}catch(error){console.error('Edited PPTX export failed:',error);setEditorProgress(0,'',false);setEditorStatus('PDF export failed: '+(error?.message||String(error)),'error')}finally{setEditorBusy(false)}};

  async function cleanupPptxEditorTemporaryFiles(includePresentation=true){const ids=Array.from(new Set(editorState.temporaryFileIds.filter(Boolean)));if(includePresentation&&editorState.presentationId)ids.push(editorState.presentationId);try{await postGoogleScriptJson({action:'cancelGoogleSlidesEditing',presentationId:includePresentation?editorState.presentationId:'',fileIds:Array.from(new Set(ids))})}catch(error){console.warn('Temporary editor cleanup warning:',error)}}

  window.closePptxEditor=async function(force=false){if(editorState.busy&&!force)return;const modal=document.getElementById('pptx-editor-modal');if(!modal?.classList.contains('open'))return;const answer=force?{confirmed:true}:await showModal('Close PowerPoint Editor','Close the editor and delete its temporary Google Drive files? Unsaved edits will be discarded.',false);if(!answer?.confirmed)return;modal.classList.remove('open');await cleanupPptxEditorTemporaryFiles(true);if(editorState.autoApplyTimer)clearTimeout(editorState.autoApplyTimer);Object.assign(editorState,{busy:false,sourceFileId:'',sourceFileName:'',presentationId:'',temporaryFileIds:[],slides:[],selectedSlideIndex:0,selectedObjectId:'',originalSnapshotId:'',autoApplyTimer:null,autoApplyRequest:0,lastAppliedKey:'',pendingEdits:{},dragState:null});setEditorStatus('');setEditorProgress(0,'',false)};
})();

/* ===== Extracted inline script block ===== */

/* V30: one PPTX asset that can be presented, reopened for editing, or exported to PDF. */
(() => {
  function slidesState(){ return window.pptxEditorState || null; }
  function slidesPreviewUrl(id, slideId=''){
    if(!id)return '';
    const base=`https://docs.google.com/presentation/d/${encodeURIComponent(id)}/preview?rm=minimal` ;
    return slideId ? base + '&slide=id.' + encodeURIComponent(String(slideId).replace(/^id\./,'')) : base;
  }
  function slidesPresentUrl(id){ return id ? `https://docs.google.com/presentation/d/${encodeURIComponent(id)}/present?rm=minimal` : ''; }
  function isSlidesAsset(payload){ return Boolean(payload && payload.type === 'google-slides' && payload.googleSlides && payload.googleSlides.presentationId); }

  function currentSlidesAsset(){
    const scene=getActiveScene();
    if(!scene)return null;
    if(staged && staged.type==='google-slides' && Number.isInteger(staged.sceneItemIndex)) return scene.items?.[staged.sceneItemIndex] || null;
    const state=slidesState();
    return state ? (scene.items||[]).find(item=>item.googleSlides && String(item.googleSlides.presentationId)===String(state.presentationId)) || null : null;
  }

  window.syncCurrentPptxAssetFromEditor=function(){
    const state=slidesState();if(!state||!state.presentationId)return null;
    let found=null;
    for(const scene of scenes){
      found=(scene.items||[]).find(item=>item.googleSlides && (String(item.googleSlides.presentationId)===String(state.presentationId) || String(item.googleSlides.originalSnapshotId||'')===String(state.originalSnapshotId||'')));
      if(found)break;
    }
    if(found){
      found.value=slidesPreviewUrl(state.presentationId, found.googleSlides?.currentSlideId || '');
      found.name=state.sourceFileName||found.name;
      found.googleSlides=Object.assign({},found.googleSlides||{}, {
        presentationId:state.presentationId,
        originalSnapshotId:state.originalSnapshotId||'',
        sourceFileId:state.sourceFileId||'',
        sourceFileName:state.sourceFileName||found.name||'Presentation.pptx',
        previewUrl:slidesPreviewUrl(state.presentationId),
        presentUrl:slidesPresentUrl(state.presentationId),
        slides:Array.isArray(state.slides)?state.slides:[]
      });
      persistScenes();
    }
    return found;
  };

  window.addCurrentPptxPresentationToScene=async function(){
    const state=slidesState();
    if(!state||!state.presentationId)throw new Error('No editable presentation is ready.');
    if(typeof window.commitPptxPendingEdits==='function')await window.commitPptxPendingEdits();
    const scene=getActiveScene();if(!scene)throw new Error('Choose an active scene first.');
    let item=(scene.items||[]).find(entry=>entry.googleSlides && String(entry.googleSlides.presentationId)===String(state.presentationId));
    if(!item){
      item={
        id:uid(),type:'google-slides',name:state.sourceFileName||'Presentation.pptx',
        value:slidesPreviewUrl(state.presentationId),page:1,
        googleSlides:{
          presentationId:state.presentationId,
          originalSnapshotId:state.originalSnapshotId||'',
          sourceFileId:state.sourceFileId||'',
          sourceFileName:state.sourceFileName||'Presentation.pptx',
          previewUrl:slidesPreviewUrl(state.presentationId),
          presentUrl:slidesPresentUrl(state.presentationId),
          slides:Array.isArray(state.slides)?state.slides:[]
        }
      };
      scene.items.push(item);
    }else{
      item.value=slidesPreviewUrl(state.presentationId, item.googleSlides?.currentSlideId || '');
      item.googleSlides.slides=Array.isArray(state.slides)?state.slides:[];
    }
    persistScenes();renderSceneDeckUI();setStagedFromSceneIndex(scene.items.indexOf(item));
    if(typeof populateSlidePreviewGrid==='function')populateSlidePreviewGrid();
    document.getElementById('pptx-editor-modal')?.classList.remove('open');
    if(typeof setEditStatus==='function')setEditStatus('✅ PowerPoint added as an editable presentation asset.','success');
    return item;
  };

  window.openGoogleSlidesAssetEditor=async function(){
    const item=currentSlidesAsset();if(!item||!item.googleSlides)return;
    const state=slidesState();if(!state)return;
    const meta=item.googleSlides;
    Object.assign(state,{
      busy:false,
      sourceFileId:String(meta.sourceFileId||''),
      sourceFileName:String(meta.sourceFileName||item.name||'Presentation.pptx'),
      presentationId:String(meta.presentationId||''),
      originalSnapshotId:String(meta.originalSnapshotId||''),
      temporaryFileIds:Array.from(new Set([meta.sourceFileId,meta.originalSnapshotId].filter(Boolean))),
      slides:Array.isArray(meta.slides)?meta.slides:[],selectedSlideIndex:0,selectedObjectId:'',lastAppliedKey:'',pendingEdits:{},dragState:null
    });
    document.getElementById('pptx-editor-file-name').textContent=state.sourceFileName;
    document.getElementById('pptx-editor-modal')?.classList.add('open');
    try{
      const data=await postGoogleScriptJson({action:'getGoogleSlidesEditorData',presentationId:state.presentationId});
      if(Array.isArray(data.slides)){state.slides=data.slides;meta.slides=data.slides;persistScenes();}
      if(typeof renderPptxEditor==='function')renderPptxEditor();
    }catch(error){
      const status=document.getElementById('pptx-editor-status');if(status){status.textContent='Unable to refresh editor: '+(error?.message||String(error));status.classList.add('show','error');}
    }
  };

  window.closePptxEditor=async function(){
    const state=slidesState();
    if(state?.busy)return;
    window.syncCurrentPptxAssetFromEditor();
    document.getElementById('pptx-editor-modal')?.classList.remove('open');
  };

  const persistBeforeV30=window.persistScenes;
  window.persistScenes=function(){
    try{
      const cleanScenes=scenes.map(scene=>({id:scene.id,name:scene.name,items:(scene.items||[]).map(item=>({
        id:item.id,type:item.type,value:(item.type==='url'||item.type==='bible'||item.type==='google-slides'||(item.googleDrive&&item.googleDrive.fileId))?item.value:'',
        name:item.name||'',category:item.category||'',page:Number(item.page||1),videoTime:Number(item.videoTime||0),videoPlaying:Boolean(item.videoPlaying),
        googleDrive:item.googleDrive||null,googleSlides:item.googleSlides||null,rootFolderFile:Boolean(item.rootFolderFile),rootRelativePath:item.rootRelativePath||'',mimeType:item.mimeType||''
      }))}));
      localStorage.setItem(LS_KEY,JSON.stringify(cleanScenes));localStorage.setItem(LS_ACTIVE_SCENE,activeSceneId||'');
    }catch(error){if(typeof persistBeforeV30==='function')persistBeforeV30();}
  };

  const stageBeforeV30=window.setStagedFromSceneIndex;
  window.setStagedFromSceneIndex=function(index){
    stageBeforeV30(index);
    const item=getActiveDeck()?.[index];
    if(item&&item.type==='google-slides'){
      staged.type='google-slides';
      const selectedSlideId=item.googleSlides?.currentSlideId||item.googleSlides?.slides?.[Math.max(0,Number(item.page||1)-1)]?.slideId||'';
      staged.value=slidesPreviewUrl(item.googleSlides?.presentationId,selectedSlideId);
      staged.googleSlides=item.googleSlides?JSON.parse(JSON.stringify(item.googleSlides)):null;
      staged.itemId=item.id;staged.id=item.id;staged.name=item.name||'Presentation.pptx';
      renderPreview();setSlideStatus();
    }
  };

  const mediaBeforeV30=window.renderMediaIntoViewport;
  window.renderMediaIntoViewport=async function(target,payload,options={}){
    if(!isSlidesAsset(payload))return mediaBeforeV30(target,payload,options);
    const label=target.querySelector('.viewport-label');target.innerHTML='';if(label)target.appendChild(label);
    const stage=document.createElement('div');stage.className='google-slides-stage';
    const iframe=document.createElement('iframe');
    const selectedSlideId=payload.googleSlides.currentSlideId||payload.googleSlides.slides?.[Math.max(0,Number(payload.page||1)-1)]?.slideId||'';
    iframe.src=slidesPreviewUrl(payload.googleSlides.presentationId,selectedSlideId);
    iframe.setAttribute('allow','autoplay; fullscreen');iframe.setAttribute('allowfullscreen','');iframe.setAttribute('scrolling','no');
    stage.appendChild(iframe);target.appendChild(stage);
    if(target.id==='preview-viewport'&&!options.readOnly){
      const badge=document.createElement('div');badge.className='google-slides-badge';badge.textContent='Editable PowerPoint';target.appendChild(badge);
      const tools=document.createElement('div');tools.className='google-slides-preview-tools';
      tools.innerHTML='<button type="button" onclick="openGoogleSlidesAssetEditor()">✏️ Edit Presentation</button><button type="button" style="background:var(--accent-green)" onclick="openGoogleSlidesAssetEditor();setTimeout(()=>exportEditedPptxToPdf(),350)">📄 Convert to PDF</button><button type="button" style="background:var(--accent-purple)" onclick="window.open(staged.googleSlides.presentUrl,\'_blank\',\'noopener\')">⛶ Open Presentation</button>';
      target.appendChild(tools);
    }
    return true;
  };

  const audienceLayerBeforeV30=window.buildAudienceMediaLayer;
  window.buildAudienceMediaLayer=async function(payload){
    if(!isSlidesAsset(payload))return audienceLayerBeforeV30(payload);
    const layer=document.createElement('div');layer.className='audience-media-layer';layer.style.zIndex='10';
    const iframe=document.createElement('iframe');
    const selectedSlideId=payload.googleSlides.currentSlideId||payload.googleSlides.slides?.[Math.max(0,Number(payload.page||1)-1)]?.slideId||'';
    iframe.src=slidesPreviewUrl(payload.googleSlides.presentationId,selectedSlideId);
    iframe.setAttribute('allow','autoplay; fullscreen');iframe.setAttribute('allowfullscreen','');iframe.setAttribute('scrolling','no');
    layer.appendChild(iframe);return layer;
  };

  const audienceBeforeV30=window.renderAudience;
  window.renderAudience=async function(payload){
    if(!isSlidesAsset(payload))return audienceBeforeV30(payload);
    const audience=document.getElementById('audience-view');if(!audience)return;
    let bg=document.getElementById('audience-bg-layer');if(!bg){bg=document.createElement('div');bg.id='audience-bg-layer';}
    Array.from(audience.children).filter(node=>node.id!=='audience-bg-layer').forEach(node=>node.remove());
    if(!bg.parentNode)audience.appendChild(bg);
    const layer=await window.buildAudienceMediaLayer(payload);audience.appendChild(layer);
  };

  const statusBeforeV30=window.setSlideStatus;
  window.setSlideStatus=function(){
    if(staged&&staged.type==='google-slides'){
      const el=document.getElementById('slide-status');if(el)el.textContent='PowerPoint presentation: '+(staged.name||'Google Slides');return;
    }
    return statusBeforeV30();
  };



  window.selectGoogleSlideForPreview=function(index){
    if(!(staged&&isSlidesAsset(staged)))return;
    const slides=staged.googleSlides.slides||[];
    const slide=slides[index];
    if(!slide)return;
    const page=index+1;
    const slideId=String(slide.slideId||slide.objectId||'');
    staged.page=page;
    staged.googleSlides.currentSlideId=slideId;
    staged.googleSlides.previewUrl=slidesPreviewUrl(staged.googleSlides.presentationId,slideId);
    staged.value=staged.googleSlides.previewUrl;
    const scene=getActiveScene();
    if(scene&&Number.isInteger(staged.sceneItemIndex)&&scene.items?.[staged.sceneItemIndex]){
      const item=scene.items[staged.sceneItemIndex];
      item.page=page;
      item.value=staged.value;
      item.googleSlides=Object.assign({},item.googleSlides||{},staged.googleSlides,{currentSlideId:slideId,previewUrl:staged.value});
      persistScenes();
    }
    renderPreview();
    setSlideStatus();
    document.querySelectorAll('#slide-preview-grid .preview-slide-card').forEach((card,cardIndex)=>card.classList.toggle('active',cardIndex===index));
  };

  const gridBeforeV30=window.populateSlidePreviewGrid;
  window.populateSlidePreviewGrid=async function(){
    if(!(staged&&isSlidesAsset(staged)))return gridBeforeV30();
    const grid=document.getElementById('slide-preview-grid');if(!grid)return;grid.innerHTML='';
    const slides=staged.googleSlides.slides||[];
    if(!slides.length){grid.innerHTML='<div style="grid-column:1/-1;color:var(--text-muted)">Open Edit Presentation to refresh slide thumbnails.</div>';return;}
    slides.forEach((slide,index)=>{
      const card=document.createElement('button');
      card.type='button';
      card.className='preview-slide-card'+(Number(staged.page||1)===index+1?' active':'');
      card.dataset.googleSlideIndex=String(index);
      card.innerHTML=`<div class="preview-slide-thumb">${slide.thumbnailUrl?`<img src="${escapeHtml(slide.thumbnailUrl)}" alt="Slide ${index+1}">`:'<div>Slide '+(index+1)+'</div>'}</div><div class="preview-slide-meta"><strong>Slide ${index+1}</strong><span>Click to load in Preview</span></div>`;
      card.onclick=()=>window.selectGoogleSlideForPreview(index);
      grid.appendChild(card);
    });
  };
})();

/* ===== Extracted inline script block ===== */

/* V33: visible automatic PowerPoint recovery state after a browser refresh. */
(() => {
  let recoveryActive=false;
  let recoveryStartedAt=0;
  let recoveryTimer=null;
  let priorPopulate=null;

  function isPptx(item){
    return Boolean(item&&item.type==='google-slides'&&item.googleSlides&&item.googleSlides.presentationId);
  }

  function allPptxAssets(){
    const result=[];
    try{(window.scenes||scenes||[]).forEach(scene=>(scene.items||[]).forEach(item=>{if(isPptx(item))result.push(item)}));}catch(_){ }
    return result;
  }

  function selectedPptx(){
    try{
      if(isPptx(window.staged||staged))return window.staged||staged;
      const scene=window.getActiveScene?.()||null;
      const index=Number((window.staged||staged)?.sceneItemIndex);
      if(scene&&Number.isInteger(index)&&isPptx(scene.items?.[index]))return scene.items[index];
    }catch(_){ }
    return null;
  }

  function recoveryMarkup(message){
    return '<div class="v33-pptx-recovery" role="status" aria-live="polite">'+
      '<div class="v33-pptx-recovery-card">'+
        '<div class="v33-pptx-recovery-spinner"></div>'+
        '<div class="v33-pptx-recovery-title">Recovering PowerPoint presentation</div>'+
        '<div class="v33-pptx-recovery-message">'+(message||'Reconnecting the saved Google Slides file and refreshing all slide previews…')+'</div>'+
        '<div class="v33-pptx-recovery-track"><div class="v33-pptx-recovery-bar"></div></div>'+
        '<div class="v33-pptx-recovery-note">Keep this page open. Your saved PPTX link is being restored automatically.</div>'+
      '</div></div>';
  }

  function showRecovery(message){
    const grid=document.getElementById('slide-preview-grid');
    if(!grid)return;
    grid.innerHTML=recoveryMarkup(message);
  }

  function hasRecoveredSlides(){
    const item=selectedPptx();
    return Boolean(item&&Array.isArray(item.googleSlides?.slides)&&item.googleSlides.slides.length);
  }

  function finishRecovery(){
    recoveryActive=false;
    if(recoveryTimer){clearInterval(recoveryTimer);recoveryTimer=null;}
    try{priorPopulate?.();}catch(_){window.populateSlidePreviewGrid?.();}
  }

  function beginRecovery(){
    if(recoveryActive)return;
    const assets=allPptxAssets();
    if(!assets.length)return;
    recoveryActive=true;
    recoveryStartedAt=Date.now();
    showRecovery();
    recoveryTimer=setInterval(()=>{
      if(hasRecoveredSlides()){
        finishRecovery();
        return;
      }
      const elapsed=Date.now()-recoveryStartedAt;
      if(elapsed>12000){
        showRecovery('The presentation is still reconnecting. Google Drive can take a little longer after a refresh.');
      }
      if(elapsed>45000){
        clearInterval(recoveryTimer);recoveryTimer=null;
        showRecovery('Recovery is taking longer than expected. Use the Refresh button above to try again without re-uploading the PPTX.');
      }
    },250);
  }

  function installPopulateWrapper(){
    if(window.populateSlidePreviewGrid?.__v33Wrapped)return;
    const previousPopulate=window.populateSlidePreviewGrid;
    priorPopulate=previousPopulate;
    const wrapped=async function(){
      const item=selectedPptx();
      const noSlides=Boolean(item && (!Array.isArray(item.googleSlides?.slides) || item.googleSlides.slides.length===0));
      if(recoveryActive&&item&&noSlides){showRecovery();return;}
      return typeof previousPopulate==='function' ? previousPopulate.apply(this,arguments) : undefined;
    };
    wrapped.__v33Wrapped=true;
    wrapped.__v33Previous=previousPopulate;
    window.populateSlidePreviewGrid=wrapped;
  }

  function boot(){
    installPopulateWrapper();
    // Start immediately when saved PPTX assets are detected; do not briefly show an empty slide panel.
    const detect=setInterval(()=>{
      installPopulateWrapper();
      if(allPptxAssets().length){clearInterval(detect);beginRecovery();}
    },100);
    setTimeout(()=>clearInterval(detect),5000);
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});
  else boot();

  // Manual Refresh also shows the reassuring recovery state while links are renewed.
  document.addEventListener('click',event=>{
    const button=event.target.closest('button[onclick*="populateSlidePreviewGrid"]');
    if(!button||!allPptxAssets().length)return;
    recoveryActive=true;recoveryStartedAt=Date.now();showRecovery('Refreshing the saved PowerPoint link and slide previews…');
    setTimeout(()=>{if(hasRecoveredSlides())finishRecovery();},500);
  },true);
})();

/* ===== Extracted inline script block ===== */

/* V42: unified Media Assets chooser, reusable cloud PPTX library, refined scrollbars, and help reminders. */
(() => {
  const PPTX_MIME='application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const legacyHandleUpload=window.handleUpload || handleUpload;

  window.handleUnifiedMediaUpload=async function(event){
    const input=event?.target;
    const all=Array.from(input?.files||[]);
    if(!all.length)return;
    const pptx=all.filter(file=>/\.pptx$/i.test(file.name)||file.type===PPTX_MIME);
    const regular=all.filter(file=>!pptx.includes(file));
    try{
      if(regular.length){
        const dt=new DataTransfer();regular.forEach(file=>dt.items.add(file));
        await legacyHandleUpload({target:{files:dt.files,value:''}});
      }
      for(const file of pptx){
        await window.startPptxEditing({target:{files:[file],value:''}});
      }
    }finally{if(input)input.value=''}
  };

  async function prepareExistingDrivePptx(file){
    if(!file)return;
    const id=String(file.id||file.fileId||'');
    if(!id)throw new Error('The selected PowerPoint file has no Drive file ID.');
    const name=String(file.name||file.fileName||'Presentation.pptx');
    if(!/\.pptx$/i.test(name))throw new Error('Choose a PPTX file.');
    const state=window.pptxEditorState;
    if(!state)throw new Error('PowerPoint editor is not ready.');
    const status=document.getElementById('pptx-edit-status');
    if(status){status.textContent='Preparing existing PowerPoint from cloud storage...';status.classList.add('show');status.classList.remove('error')}
    try{
      const prepared=await postGoogleScriptJson({action:'prepareGoogleSlidesEditor',sourceFileId:id,fileName:name});
      if(!prepared.presentationId||!Array.isArray(prepared.slides))throw new Error('Apps Script did not return editable slide data.');
      Object.assign(state,{
        sourceFileId:id,sourceFileName:name,presentationId:String(prepared.presentationId),
        slides:prepared.slides,originalSnapshotId:String(prepared.originalSnapshotId||''),
        temporaryFileIds:Array.from(new Set([id,...(prepared.temporaryFileIds||[]),prepared.presentationId].filter(Boolean))),
        selectedSlideIndex:0,selectedObjectId:''
      });
      const label=document.getElementById('pptx-editor-file-name');if(label)label.textContent=name;
      if(typeof renderPptxEditor==='function')renderPptxEditor();
      await window.addCurrentPptxPresentationToScene();
      if(status){status.textContent='✅ Existing PowerPoint added to the active scene.';status.classList.add('show');status.classList.remove('error')}
      closeDrivePdfModal();
    }catch(error){
      if(status){status.textContent='Editor failed: '+(error?.message||String(error));status.classList.add('show','error')}
      throw error;
    }
  }

  window.prepareExistingDrivePptx=prepareExistingDrivePptx;

  const originalAddDriveFile=window.addDriveFileToActiveScene;
  window.addDriveFileToActiveScene=async function(file){
    const name=String(file?.name||file?.fileName||'');
    if(/\.pptx$/i.test(name)||file?.mimeType===PPTX_MIME)return window.prepareExistingDrivePptx(file);
    return originalAddDriveFile(file);
  };

  window.openDrivePptxFilesModal=async function(){
    const modal=document.getElementById('drive-pdf-modal');
    const title=modal?.querySelector('.modal-title');if(title)title.textContent='PowerPoint Files';
    const description=modal?.querySelector('.modal-body');if(description)description.textContent='Choose Add to Scene to reuse an existing PPTX from cloud storage. The file is not uploaded again.';
    const toolbar=modal?.querySelector('.drive-view-toolbar');if(toolbar)toolbar.style.display='none';
    modal?.classList.add('open');
    const list=document.getElementById('drive-pdf-list');if(list)list.innerHTML='<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted)">Loading PowerPoint files...</div>';
    try{
      const files=(await getDriveFilesFromBackend(false)).filter(file=>/\.pptx$/i.test(String(file.name||''))||file.mimeType===PPTX_MIME);
      renderDriveFileCards(files,'drive-pdf-list');
    }catch(error){if(list)list.innerHTML='<div style="grid-column:1/-1;color:var(--accent-red);padding:20px">'+escapeHtml(error?.message||String(error))+'</div>'}
  };

  const oldOpenDrivePdfModal=window.openDrivePdfModal;
  window.openDrivePdfModal=function(){
    const modal=document.getElementById('drive-pdf-modal');
    const title=modal?.querySelector('.modal-title');if(title)title.textContent='Available Files';
    const description=modal?.querySelector('.modal-body');if(description)description.textContent='Turn off the filter to view all available files. Download saves the file into your selected root folder and adds the local copy to the active scene.';
    const toolbar=modal?.querySelector('.drive-view-toolbar');if(toolbar)toolbar.style.display='flex';
    return oldOpenDrivePdfModal();
  };

  window.openPresenterInstructions=function(){
    document.getElementById('presenter-help-modal')?.classList.add('open');
    document.getElementById('presenter-help-reminder')?.classList.remove('show');
    document.getElementById('presenter-help-button')?.classList.remove('reminding');
  };
  window.closePresenterInstructions=function(){document.getElementById('presenter-help-modal')?.classList.remove('open')};
  function showHelpReminder(){
    const bubble=document.getElementById('presenter-help-reminder'),button=document.getElementById('presenter-help-button');
    bubble?.classList.add('show');button?.classList.add('reminding');
    setTimeout(()=>{bubble?.classList.remove('show');button?.classList.remove('reminding')},10000);
  }
  window.addEventListener('DOMContentLoaded',()=>{
    setTimeout(showHelpReminder,10000);
    setInterval(showHelpReminder,5*60*1000);
  });
})();

/* ===== Extracted inline script block ===== */

/* V44: operator-only help, collapsible Canva/Bible panels, and root-folder-first media picker. */
(() => {
  window.toggleToolPanel=function(sectionId,button){
    const section=document.getElementById(sectionId);if(!section)return;
    const minimized=section.classList.toggle('is-minimized');
    if(button){button.textContent=minimized?'+':'−';button.setAttribute('aria-expanded',String(!minimized));button.title=(minimized?'Expand ':'Minimize ')+(sectionId==='bible-library-section'?'Bible Library':'Canva Presentation');}
    try{localStorage.setItem('jil_panel_'+sectionId,minimized?'1':'0')}catch(_){ }
  };
  function restorePanel(sectionId){
    let minimized=false;try{minimized=localStorage.getItem('jil_panel_'+sectionId)==='1'}catch(_){ }
    if(!minimized)return;const section=document.getElementById(sectionId),button=section?.querySelector('.panel-minimize-btn');
    section?.classList.add('is-minimized');if(button){button.textContent='+';button.setAttribute('aria-expanded','false');}
  }
  window.openMediaRootConfirmation=async function(){
    const modal=document.getElementById('media-root-confirm-modal');
    const status=document.getElementById('media-root-confirm-status');
    if(!folderHandle){try{folderHandle=await loadFolderHandle()}catch(_){ }}
    if(status)status.textContent=folderHandle?'Selected root folder: '+(folderHandle.name||'Root folder'):'No root folder is connected yet. Choose a root folder first.';
    modal?.classList.add('open');
  };
  window.closeMediaRootConfirmation=function(){document.getElementById('media-root-confirm-modal')?.classList.remove('open')};
  window.confirmMediaRootSelection=async function(){
    const status=document.getElementById('media-root-confirm-status');
    try{
      if(!folderHandle)folderHandle=await loadFolderHandle();
      if(!folderHandle){closeMediaRootConfirmation();openRootFolderSetupModal('Choose a root folder before adding media files.');return;}
      let permission=await folderHandle.queryPermission({mode:'readwrite'});
      if(permission!=='granted')permission=await folderHandle.requestPermission({mode:'readwrite'});
      if(permission!=='granted')throw new Error('Root folder permission was not granted.');
      closeMediaRootConfirmation();
      if(typeof window.showOpenFilePicker==='function'){
        const handles=await window.showOpenFilePicker({
          multiple:true,startIn:folderHandle,
          types:[{description:'Presentation media',accept:{
            'image/*':['.png','.jpg','.jpeg','.gif','.webp','.svg'],
            'video/*':['.mp4','.webm','.mov','.m4v'],
            'audio/*':['.mp3','.wav','.m4a','.ogg'],
            'application/pdf':['.pdf'],
            'application/vnd.openxmlformats-officedocument.presentationml.presentation':['.pptx']
          }}]
        });
        const files=await Promise.all(handles.map(handle=>handle.getFile()));
        // Pass the actual selected File objects to the unified uploader. The previous
        // version accidentally passed an empty `files` property, so PDF bytes were
        // never copied into IndexedDB and Preview could not open the document.
        await window.handleUnifiedMediaUpload({target:{files:files,value:''}});
      }else{
        document.getElementById('file-uploader')?.click();
      }
    }catch(error){
      if(error?.name==='AbortError')return;
      if(status)status.textContent=error?.message||String(error);
      document.getElementById('media-root-confirm-modal')?.classList.add('open');
    }
  };
  window.addEventListener('DOMContentLoaded',()=>{restorePanel('canva-presentation-section');restorePanel('bible-library-section')});
})();

/* ===== Extracted inline script block ===== */

/* V45: prevent a false local-PDF error while persistent media is being restored. */
(() => {
  const originalGetCachedPdfBlob = window.getCachedPdfBlob;
  // The original function is lexical in older builds, so we also refresh the staged
  // item after IndexedDB restoration and rerender Preview/Slides immediately.
  window.addEventListener('DOMContentLoaded', () => {
    const preview=document.getElementById('preview-viewport');
    const deck=getActiveDeck?.()||[];
    const item=deck[staged?.sceneItemIndex];
    if(preview && item?.type==='pdf' && !item.pdfData){
      const note=document.createElement('div');
      note.className='v45-pdf-recovering';
      note.innerHTML='<div class="v45-pdf-spinner"></div><strong>Recovering PDF from the selected root folder...</strong><span>Please wait while the local working copy is restored.</span>';
      preview.replaceChildren(note);
    }
    setTimeout(async()=>{
      try{
        if(typeof restoreAllWorkingCopies==='function') await restoreAllWorkingCopies();
        const current=(getActiveDeck?.()||[])[staged?.sceneItemIndex];
        if(current && typeof setStagedFromSceneIndex==='function') setStagedFromSceneIndex(staged.sceneItemIndex);
        if(typeof renderPreview==='function') renderPreview();
        if(typeof populateSlidePreviewGrid==='function') populateSlidePreviewGrid();
      }catch(e){console.warn('PDF recovery refresh failed:',e)}
    },50);
  });
})();

/* ===== Extracted inline script block ===== */

/* V45: stable PPTX/Google Slides Preview.
   Uses the saved slide thumbnail as a persistent frame and never replaces the
   current frame with a blank iframe while another slide is loading. */
(() => {
  let v45PreviewRequest = 0;
  const v45ImageCache = new Map();

  function isGoogleSlidesPayload(payload) {
    return Boolean(payload && payload.type === 'google-slides' && payload.googleSlides && payload.googleSlides.presentationId);
  }

  function getSlides(payload) {
    return Array.isArray(payload?.googleSlides?.slides) ? payload.googleSlides.slides : [];
  }

  function getSlideIndex(payload) {
    const slides = getSlides(payload);
    if (!slides.length) return -1;
    const currentId = String(payload?.googleSlides?.currentSlideId || '');
    const byId = currentId
      ? slides.findIndex(slide => String(slide.slideId || slide.objectId || '') === currentId)
      : -1;
    if (byId >= 0) return byId;
    return Math.max(0, Math.min(slides.length - 1, Number(payload?.page || 1) - 1));
  }

  function getThumbnail(payload) {
    const slides = getSlides(payload);
    const index = getSlideIndex(payload);
    return index >= 0 ? String(slides[index]?.thumbnailUrl || '') : '';
  }

  async function loadStableImage(url) {
    if (!url) throw new Error('This PowerPoint slide has no thumbnail image. Open Edit Presentation once to refresh it.');
    if (v45ImageCache.has(url)) return v45ImageCache.get(url).cloneNode(true);

    const image = new Image();
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.src = url;
    await new Promise((resolve, reject) => {
      if (image.complete && image.naturalWidth > 0) return resolve();
      image.onload = resolve;
      image.onerror = () => reject(new Error('The PowerPoint slide image could not be loaded.'));
    });
    v45ImageCache.set(url, image);
    return image.cloneNode(true);
  }

  function keepPreviewChrome(target) {
    const label = target.querySelector('.viewport-label');
    if (label) target.appendChild(label);
    target.querySelectorAll('.google-slides-badge,.google-slides-preview-tools').forEach(node => target.appendChild(node));
  }

  async function renderStableGoogleSlidePreview(payload) {
    const target = document.getElementById('preview-viewport');
    if (!target) return false;
    const request = ++v45PreviewRequest;
    const url = getThumbnail(payload);

    try {
      const image = await loadStableImage(url);
      if (request !== v45PreviewRequest || !isGoogleSlidesPayload(staged)) return true;

      const next = document.createElement('div');
      next.className = 'v45-pptx-frame';
      next.appendChild(image);
      target.appendChild(next);
      keepPreviewChrome(target);

      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (request !== v45PreviewRequest) {
        next.remove();
        return true;
      }

      next.classList.add('active');
      const oldFrames = Array.from(target.querySelectorAll('.v45-pptx-frame')).filter(node => node !== next);
      oldFrames.forEach(node => node.classList.remove('active'));

      // Remove legacy iframe/canvas layers only after the new image is visible.
      setTimeout(() => {
        if (request !== v45PreviewRequest) return;
        oldFrames.forEach(node => node.remove());
        target.querySelectorAll('.v31-gs-layer,.google-slides-stage,.drive-online-preview-frame').forEach(node => node.remove());
        keepPreviewChrome(target);
      }, 190);
      return true;
    } catch (error) {
      console.warn('Stable PowerPoint preview kept the previous frame:', error);
      // Important: do not clear the current Preview and do not fall back to the
      // Google Slides iframe, which is the source of the black flash.
      return true;
    }
  }

  const renderBeforeV45 = window.renderMediaIntoViewport;
  window.renderMediaIntoViewport = async function(target, payload, options = {}) {
    if (target && target.id === 'preview-viewport' && isGoogleSlidesPayload(payload)) {
      return renderStableGoogleSlidePreview(payload);
    }
    return renderBeforeV45(target, payload, options);
  };

  // Replace the long wrapper chain for thumbnail clicks with one atomic update.
  window.selectGoogleSlideForPreview = async function(index) {
    const scene = typeof getActiveScene === 'function' ? getActiveScene() : null;
    if (!scene) return;

    let itemIndex = Number.isInteger(staged?.sceneItemIndex) ? staged.sceneItemIndex : -1;
    let item = scene.items?.[itemIndex];
    if (!item || item.type !== 'google-slides') {
      itemIndex = (scene.items || []).findIndex(entry => entry?.type === 'google-slides');
      item = scene.items?.[itemIndex];
    }
    if (!item || !item.googleSlides) return;

    const slides = Array.isArray(item.googleSlides.slides) ? item.googleSlides.slides : [];
    const safeIndex = Math.max(0, Math.min(slides.length - 1, Number(index) || 0));
    const slide = slides[safeIndex];
    if (!slide) return;

    const slideId = String(slide.slideId || slide.objectId || '');
    item.page = safeIndex + 1;
    item.googleSlides.currentSlideId = slideId;
    item.googleSlides.thumbnailUrl = String(slide.thumbnailUrl || '');
    if (typeof slidesPreviewUrl === 'function') {
      item.value = slidesPreviewUrl(item.googleSlides.presentationId, slideId);
      item.googleSlides.previewUrl = item.value;
    }

    staged = {
      ...staged,
      id: item.id,
      itemId: item.id,
      sceneId: scene.id,
      sceneItemIndex: itemIndex,
      type: 'google-slides',
      name: item.name || 'Presentation.pptx',
      value: item.value,
      page: safeIndex + 1,
      googleSlides: JSON.parse(JSON.stringify(item.googleSlides))
    };

    try { persistScenes(); } catch (_) {}
    setSlideStatus();
    await renderStableGoogleSlidePreview(staged);

    document.querySelectorAll('#slide-preview-grid .preview-slide-card').forEach((card, cardIndex) => {
      card.classList.toggle('active', cardIndex === safeIndex);
    });
  };
})();

/* ===== Extracted inline script block ===== */

/* V46: hard fix for PPTX/Google Slides Preview turning black.
   Preview uses the selected slide thumbnail only. The Google iframe is never
   inserted into Preview, and the previous frame stays visible until the new
   image has fully loaded. */
(() => {
  let requestId = 0;

  function isGoogleSlidesPayload(payload) {
    return Boolean(payload && payload.type === 'google-slides' && payload.googleSlides);
  }

  function slidesOf(payload) {
    return Array.isArray(payload?.googleSlides?.slides) ? payload.googleSlides.slides : [];
  }

  function selectedIndex(payload) {
    const slides = slidesOf(payload);
    if (!slides.length) return 0;
    const currentId = String(payload?.googleSlides?.currentSlideId || '');
    const found = currentId
      ? slides.findIndex(slide => String(slide.slideId || slide.objectId || '') === currentId)
      : -1;
    return found >= 0
      ? found
      : Math.max(0, Math.min(slides.length - 1, Number(payload?.page || 1) - 1));
  }

  function thumbnailFor(payload) {
    const slide = slidesOf(payload)[selectedIndex(payload)] || null;
    return String(slide?.thumbnailUrl || payload?.googleSlides?.thumbnailUrl || '');
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      if (!url) return reject(new Error('The selected PowerPoint slide has no thumbnail URL.'));
      const image = new Image();
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('The selected PowerPoint slide image could not load.'));
      image.src = url;
      if (image.complete && image.naturalWidth > 0) resolve(image);
    });
  }

  async function renderStableGoogleSlidePreview(payload) {
    const target = document.getElementById('preview-viewport');
    if (!target) return true;

    const id = ++requestId;
    const url = thumbnailFor(payload);
    let loading = target.querySelector('.v46-gs-loading');
    if (!loading) {
      loading = document.createElement('div');
      loading.className = 'v46-gs-loading';
      loading.textContent = 'Loading slide…';
      target.appendChild(loading);
    }

    try {
      const image = await loadImage(url);
      if (id !== requestId || !isGoogleSlidesPayload(staged)) return true;

      const frame = document.createElement('div');
      frame.className = 'v46-gs-frame';
      frame.appendChild(image);

      // Preserve the old frame until the replacement image is ready.
      target.appendChild(frame);
      target.querySelectorAll('.v46-gs-frame').forEach(node => {
        if (node !== frame) node.remove();
      });

      // Remove every older Google Slides iframe/layer that can cover the image black.
      target.querySelectorAll(
        '.google-slides-stage,.v31-gs-layer,.v17-online-pdf-layer,.drive-online-preview-frame,iframe'
      ).forEach(node => node.remove());

      const label = target.querySelector('.viewport-label');
      if (label) target.appendChild(label);
      loading.remove();
      return true;
    } catch (error) {
      console.warn('Stable PowerPoint preview kept the previous frame:', error);
      loading.textContent = 'Keeping previous slide';
      setTimeout(() => loading?.remove(), 900);
      // Never call an iframe fallback here. Keeping the current frame avoids black Preview.
      return true;
    }
  }

  const renderBeforeV46 = window.renderMediaIntoViewport;
  window.renderMediaIntoViewport = async function(target, payload, options = {}) {
    if (target?.id === 'preview-viewport' && isGoogleSlidesPayload(payload)) {
      return renderStableGoogleSlidePreview(payload);
    }
    return renderBeforeV46(target, payload, options);
  };

  // Replace the accumulated slide-click wrappers with one deterministic update.
  window.selectGoogleSlideForPreview = async function(index) {
    const scene = typeof getActiveScene === 'function' ? getActiveScene() : null;
    if (!scene) return;

    let itemIndex = Number.isInteger(staged?.sceneItemIndex) ? staged.sceneItemIndex : -1;
    let item = scene.items?.[itemIndex];
    if (!item || item.type !== 'google-slides') {
      itemIndex = (scene.items || []).findIndex(entry => entry?.type === 'google-slides');
      item = scene.items?.[itemIndex];
    }
    if (!item || item.type !== 'google-slides') return;

    const slides = Array.isArray(item.googleSlides?.slides) ? item.googleSlides.slides : [];
    const safeIndex = Math.max(0, Math.min(slides.length - 1, Number(index) || 0));
    const slide = slides[safeIndex];
    if (!slide) return;

    const slideId = String(slide.slideId || slide.objectId || '');
    item.page = safeIndex + 1;
    item.googleSlides = Object.assign({}, item.googleSlides || {}, {
      currentSlideId: slideId,
      thumbnailUrl: String(slide.thumbnailUrl || '')
    });

    staged = {
      type: 'google-slides',
      id: item.id,
      itemId: item.id,
      name: item.name || 'Presentation.pptx',
      value: item.value,
      page: safeIndex + 1,
      sceneItemIndex: itemIndex,
      sceneId: scene.id,
      googleSlides: JSON.parse(JSON.stringify(item.googleSlides))
    };

    persistScenes();
    setSlideStatus();
    await renderStableGoogleSlidePreview(staged);

    document.querySelectorAll('#slide-preview-grid .preview-slide-card').forEach((card, i) => {
      card.classList.toggle('active', i === safeIndex);
    });
  };
})();

/* ===== Extracted inline script block ===== */

/* V48: isolate every PowerPoint render by monitor and scene.
   Fixes the next scene being cancelled by a delayed Google Slides render. */
(() => {
  const renderTokens = new WeakMap();

  function isGs48(payload){
    return Boolean(payload && payload.type === 'google-slides' && payload.googleSlides && payload.googleSlides.presentationId);
  }
  function clone48(value){
    try { return typeof clonePresenterPayload === 'function' ? clonePresenterPayload(value) : structuredClone(value); }
    catch (_) { try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; } }
  }
  function slides48(payload){ return Array.isArray(payload?.googleSlides?.slides) ? payload.googleSlides.slides : []; }
  function index48(payload){
    const list=slides48(payload); if(!list.length)return 0;
    const id=String(payload?.googleSlides?.currentSlideId||'');
    const found=id?list.findIndex(slide=>String(slide.slideId||slide.objectId||'')===id):-1;
    return found>=0?found:Math.max(0,Math.min(list.length-1,Number(payload?.page||1)-1));
  }
  function thumb48(payload){
    const slide=slides48(payload)[index48(payload)];
    return String(slide?.thumbnailUrl||payload?.googleSlides?.thumbnailUrl||'');
  }
  function sceneId48(payload){ return String(payload?.sceneId||''); }
  function currentSceneId48(){
    try { return String(getActiveScene?.()?.id || activeSceneId || ''); } catch (_) { return String(activeSceneId||''); }
  }
  function loadImage48(url){
    return new Promise((resolve,reject)=>{
      if(!url)return reject(new Error('No PowerPoint thumbnail URL.'));
      const image=new Image(); image.decoding='async'; image.referrerPolicy='no-referrer';
      image.onload=()=>resolve(image); image.onerror=()=>reject(new Error('PowerPoint thumbnail failed to load.'));
      image.src=url;
      if(image.complete&&image.naturalWidth>0)resolve(image);
    });
  }
  function clearGsLayers48(target){
    if(!target)return;
    target.querySelectorAll('.v47-gs-frame,.v48-gs-frame,.google-slides-stage,.v31-gs-layer,.v45-pptx-frame,.v46-gs-frame').forEach(node=>node.remove());
  }

  async function renderGs48(target,payload,options={}){
    if(!target||!isGs48(payload))return false;
    const token={
      sceneId:sceneId48(payload), itemId:String(payload.itemId||payload.id||''), page:Number(payload.page||1), targetId:target.id||''
    };
    renderTokens.set(target,token);
    const previous=target.querySelector('.v48-gs-frame.active, .v47-gs-frame.active');
    try{
      const image=await loadImage48(thumb48(payload));
      if(renderTokens.get(target)!==token)return true;
      if(target.id==='preview-viewport' && token.sceneId && token.sceneId!==currentSceneId48())return true;

      const frame=document.createElement('div'); frame.className='v48-gs-frame';
      frame.dataset.sceneId=token.sceneId; frame.dataset.itemId=token.itemId; frame.dataset.page=String(token.page);
      frame.appendChild(image);
      const count=document.createElement('div'); count.className='v48-gs-count';
      count.textContent=`Slide ${index48(payload)+1} / ${Math.max(1,slides48(payload).length)}`;
      frame.appendChild(count); target.appendChild(frame);
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      if(renderTokens.get(target)!==token){frame.remove();return true;}
      if(target.id==='preview-viewport' && token.sceneId && token.sceneId!==currentSceneId48()){frame.remove();return true;}
      frame.classList.add('active');
      if(previous&&previous!==frame)previous.classList.remove('active');
      setTimeout(()=>{
        if(renderTokens.get(target)!==token)return;
        target.querySelectorAll('.v47-gs-frame,.v48-gs-frame').forEach(node=>{if(node!==frame)node.remove();});
        target.querySelectorAll('.google-slides-stage,.v31-gs-layer,.v45-pptx-frame,.v46-gs-frame,.drive-online-preview-frame').forEach(node=>node.remove());
      },190);
      return true;
    }catch(error){
      console.warn('V48 retained the previous PowerPoint frame:',error);
      return true;
    }
  }

  const mediaBefore48=window.renderMediaIntoViewport;
  window.renderMediaIntoViewport=async function(target,payload,options={}){
    if(isGs48(payload))return renderGs48(target,payload,options);
    // Invalidate only this monitor. A render in Preview must never cancel Live View or another scene.
    if(target)renderTokens.set(target,{});
    const result=await mediaBefore48(target,payload,options);
    if(target&&!isGs48(payload))clearGsLayers48(target);
    return result;
  };

  window.selectGoogleSlideForPreview=async function(index){
    const scene=getActiveScene?.(); if(!scene)return;
    let itemIndex=Number.isInteger(staged?.sceneItemIndex)?staged.sceneItemIndex:-1;
    let item=scene.items?.[itemIndex];
    if(!item||item.type!=='google-slides'){
      itemIndex=(scene.items||[]).findIndex(entry=>entry?.type==='google-slides');
      item=scene.items?.[itemIndex];
    }
    if(!item?.googleSlides)return;
    const list=Array.isArray(item.googleSlides.slides)?item.googleSlides.slides:[];
    const safe=Math.max(0,Math.min(list.length-1,Number(index)||0));
    const slide=list[safe]; if(!slide)return;
    const slideId=String(slide.slideId||slide.objectId||'');
    item.page=safe+1; item.googleSlides.currentSlideId=slideId; item.googleSlides.thumbnailUrl=String(slide.thumbnailUrl||'');
    staged={...clone48(item),id:item.id,itemId:item.id,sceneId:scene.id,sceneItemIndex:itemIndex,type:'google-slides',page:safe+1,name:item.name||'Presentation.pptx',googleSlides:clone48(item.googleSlides)};
    try{persistScenes();}catch(_){}
    setSlideStatus();
    await renderGs48(document.getElementById('preview-viewport'),staged,{readOnly:false});
    document.querySelectorAll('#slide-preview-grid .preview-slide-card').forEach((card,i)=>card.classList.toggle('active',i===safe));
  };

  const fireBefore48=window.fireLive;
  window.fireLive=async function(){
    if(!isGs48(staged))return fireBefore48.apply(this,arguments);
    if(isFTBActive||isFTGActive){showModal('Live View Is Covered','Turn off Fade To Black or Fade To Background before sending a new preview live.',false);return;}
    const activeId=currentSceneId48();
    if(staged.sceneId&&String(staged.sceneId)!==activeId)return;
    const transition=document.getElementById('transition-type-select')?.value||'fade';
    liveState=clone48(staged); lastIncoming=clone48(liveState);
    await renderGs48(document.getElementById('live-viewport'),liveState,{readOnly:true});
    const message={command:'TRIGGER_LIVE_FADE',payload:clone48(liveState),transitionType:transition};
    channel.postMessage(message);
    try{if(displayWindow&&!displayWindow.closed)displayWindow.postMessage(message,'*');}catch(_){}
  };

  // Immediately invalidate the outgoing Preview before the original scene handler runs.
  document.addEventListener('pointerdown',event=>{
    const row=event.target.closest('#scene-list .scene-item'); if(!row)return;
    const preview=document.getElementById('preview-viewport'); if(preview)renderTokens.set(preview,{});
  },true);
})();

/* ===== Extracted inline script block ===== */

/* V48 FINAL PDF LIVE FIX: use the already-rendered Preview slide as the exact
   Live View and Display Screen frame. This avoids stale PDF loaders and black frames. */
(() => {
  const PDF_FRAME_COMMAND = 'V48_SHOW_PDF_FRAME';
  let pdfLiveSerial = 0;

  function isPdf(payload) {
    return Boolean(payload && payload.type === 'pdf');
  }

  function clonePayload(value) {
    try {
      if (typeof clonePresenterPayload === 'function') return clonePresenterPayload(value);
      if (typeof structuredClone === 'function') return structuredClone(value);
    } catch (_) {}
    return JSON.parse(JSON.stringify(value));
  }

  async function waitForPreviewPdfCanvas(timeout = 3500) {
    const preview = document.getElementById('preview-viewport');
    if (!preview) return null;
    const started = performance.now();
    while (performance.now() - started < timeout) {
      const canvases = Array.from(preview.querySelectorAll('canvas')).filter(canvas => canvas.width > 10 && canvas.height > 10);
      const visible = canvases.reverse().find(canvas => {
        const style = getComputedStyle(canvas);
        const rect = canvas.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 10 && rect.height > 10;
      });
      if (visible) return visible;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
  }

  async function makeCurrentPdfFrame() {
    const serial = ++pdfLiveSerial;
    if (typeof renderPreview === 'function') await renderPreview();
    const canvas = await waitForPreviewPdfCanvas();
    if (serial !== pdfLiveSerial || !canvas) throw new Error('The selected PDF slide is not ready yet.');
    return canvas.toDataURL('image/png');
  }

  function showFrameInLive(frame, payload) {
    const target = document.getElementById('live-viewport');
    if (!target || !frame) return;
    const old = target.querySelector('.v48-pdf-live-frame.active');
    const layer = document.createElement('div');
    layer.className = 'v48-pdf-live-frame';
    const image = document.createElement('img');
    image.src = frame;
    image.alt = payload?.name || 'PDF slide';
    layer.appendChild(image);
    target.appendChild(layer);
    requestAnimationFrame(() => {
      layer.classList.add('active');
      if (old && old !== layer) {
        old.classList.remove('active');
        setTimeout(() => old.remove(), 260);
      }
    });
    target.querySelectorAll('.v48-pdf-live-frame').forEach(node => {
      if (node !== layer && node !== old) node.remove();
    });
    if (typeof updateLiveMonitorOverlays === 'function') updateLiveMonitorOverlays();
  }

  function showFrameInOutput(message) {
    if (!document.body.classList.contains('live-window-mode')) return;
    if (!message || message.command !== PDF_FRAME_COMMAND || !message.frame) return;
    const audience = document.getElementById('audience-view');
    if (!audience) return;
    let bg = document.getElementById('audience-bg-layer');
    if (!bg) {
      bg = document.createElement('div');
      bg.id = 'audience-bg-layer';
      audience.appendChild(bg);
    }
    const old = audience.querySelector('.v48-pdf-output-frame.active');
    const layer = document.createElement('div');
    layer.className = 'v48-pdf-output-frame';
    const image = document.createElement('img');
    image.src = message.frame;
    image.alt = message.payload?.name || 'PDF slide';
    layer.appendChild(image);
    audience.appendChild(layer);
    requestAnimationFrame(() => {
      layer.classList.add('active');
      if (old && old !== layer) {
        old.classList.remove('active');
        setTimeout(() => old.remove(), message.transitionType === 'cut' ? 0 : 300);
      }
    });
    Array.from(audience.children).forEach(node => {
      if (node === bg || node === layer || node === old) return;
      if (node.classList?.contains('v48-pdf-output-frame')) node.remove();
    });
  }

  channel.addEventListener('message', event => showFrameInOutput(event.data));
  window.addEventListener('message', event => showFrameInOutput(event.data));

  const previousFireLiveV48 = window.fireLive;
  window.fireLive = async function(...args) {
    if (!isPdf(staged)) return previousFireLiveV48.apply(this, args);
    if (isFTBActive || isFTGActive) {
      await showModal('Live View Is Covered', 'Turn off Fade To Black or Fade To Background before sending a new preview live.', false);
      return;
    }
    const transitionType = document.getElementById('transition-type-select')?.value || 'fade';
    try {
      const frame = await makeCurrentPdfFrame();
      liveState = clonePayload(staged);
      lastIncoming = clonePayload(liveState);
      showFrameInLive(frame, liveState);
      const message = {
        command: PDF_FRAME_COMMAND,
        frame,
        payload: clonePayload(liveState),
        transitionType
      };
      channel.postMessage(message);
      try {
        if (displayWindow && !displayWindow.closed) displayWindow.postMessage(message, '*');
      } catch (_) {}
    } catch (error) {
      console.error('V48 PDF live frame failed:', error);
      await showModal('PDF Slide Not Ready', error?.message || 'Wait for the PDF slide to appear in Preview, then click Go Live again.', false);
    }
  };

  // Resend the current PDF slide when the Display Screen opens after Go Live.
  channel.addEventListener('message', async event => {
    const message = event.data || {};
    if (message.command !== 'REQUEST_CURRENT_OUTPUT' || document.body.classList.contains('live-window-mode')) return;
    if (!isPdf(liveState)) return;
    try {
      const frame = await makeCurrentPdfFrame();
      channel.postMessage({ command: PDF_FRAME_COMMAND, frame, payload: clonePayload(liveState), transitionType: 'cut' });
    } catch (_) {}
  });
})();

/* ===== Extracted inline script block ===== */

/* V23: Live View controls the PDF presentation and always updates the external display. */
(() => {
  function copyPayload(value) {
    if (typeof clonePresenterPayload === 'function') return clonePresenterPayload(value);
    try { return structuredClone(value); } catch (_) { return JSON.parse(JSON.stringify(value)); }
  }

  function currentPdfPayload() {
    if (liveState && liveState.type === 'pdf') return liveState;
    if (staged && staged.type === 'pdf') return staged;
    return null;
  }

  async function sendCurrentPdfLive(transitionType) {
    if (!staged || staged.type !== 'pdf') return;
    if (isFTBActive || isFTGActive) return;
    const transition = transitionType || document.getElementById('transition-type-select')?.value || 'cut';
    // Reuse the established PDF live path so the rendered frame reaches the popup.
    window.fireLive();
    // Retry once after rendering, useful for very large PDF pages.
    setTimeout(() => {
      try {
        if (liveState && liveState.type === 'pdf' && typeof window.__v19SendCurrentLivePdf === 'function') {
          window.__v19SendCurrentLivePdf();
        }
      } catch (_) {}
    }, 220);
  }

  window.v23NavigateLivePdf = async function(delta) {
    let source = currentPdfPayload();
    if (!source) return;

    // Keep Preview as the mirrored working state, but Live View is the controller.
    if (!staged || staged.type !== 'pdf' ||
        (source.itemId && staged.itemId && source.itemId !== staged.itemId)) {
      staged = copyPayload(source);
    }

    const total = Number(staged.totalPages || source.totalPages || 0);
    let next = Math.max(1, Number(staged.page || source.page || 1) + Number(delta || 0));
    if (total) next = Math.min(next, total);
    if (next === Number(staged.page || 1)) return;

    staged.page = next;
    if (source !== staged) source.page = next;
    const scene = getActiveScene();
    if (scene && staged.sceneItemIndex >= 0 && scene.items?.[staged.sceneItemIndex]) {
      scene.items[staged.sceneItemIndex].page = next;
      persistScenes();
    }

    setSlideStatus();
    await renderPreview();
    if (typeof updateEmbeddedSlideActiveState === 'function') updateEmbeddedSlideActiveState();
    if (typeof updateSlidePreviewActiveState === 'function') updateSlidePreviewActiveState();
    await sendCurrentPdfLive('cut');
  };

  function installLivePdfNavigation() {
    const target = document.getElementById('live-viewport');
    if (!target) return;
    target.querySelectorAll('.v23-live-pdf-nav').forEach(node => node.remove());
    const payload = currentPdfPayload();
    if (!payload) return;

    const page = Number(payload.page || 1);
    const total = Number(payload.totalPages || staged?.totalPages || 0);
    const nav = document.createElement('div');
    nav.className = 'v23-live-pdf-nav';

    const previous = document.createElement('button');
    previous.type = 'button';
    previous.innerHTML = '&#8249;';
    previous.title = 'Previous slide';
    previous.disabled = page <= 1;
    previous.onclick = event => { event.stopPropagation(); window.v23NavigateLivePdf(-1); };

    const next = document.createElement('button');
    next.type = 'button';
    next.innerHTML = '&#8250;';
    next.title = 'Next slide';
    next.disabled = Boolean(total && page >= total);
    next.onclick = event => { event.stopPropagation(); window.v23NavigateLivePdf(1); };

    const count = document.createElement('div');
    count.className = 'v23-live-pdf-count';
    count.textContent = total ? `Slide ${page} / ${total}` : `Slide ${page}`;
    nav.append(previous, next, count);
    target.appendChild(nav);
  }

  const previousRenderLiveView = window.renderLiveView;
  window.renderLiveView = async function() {
    const result = await previousRenderLiveView();
    installLivePdfNavigation();
    return result;
  };

  // Any PDF page selected through an older control should immediately update Live and Output.
  const previousSetPdfPageV23 = window.setPdfPage;
  window.setPdfPage = function(page) {
    if (!staged || staged.type !== 'pdf') return previousSetPdfPageV23(page);
    const before = Number(staged.page || 1);
    const result = previousSetPdfPageV23(page);
    const after = Number(staged.page || 1);
    if (after !== before) {
      setTimeout(() => sendCurrentPdfLive('cut'), 0);
    }
    return result;
  };

  // Double-click a presentation thumbnail to transition it directly to Live and Output.
  function installSlideDoubleClick() {
    const grid = document.getElementById('slide-preview-grid');
    if (!grid || grid.dataset.v23DoubleClick === '1') return;
    grid.dataset.v23DoubleClick = '1';
    grid.addEventListener('dblclick', async event => {
      const card = event.target.closest('.preview-slide-card');
      if (!card) return;
      event.preventDefault();
      event.stopPropagation();

      if (card.dataset.pdfPage) {
        const page = Number(card.dataset.pdfPage);
        if (staged?.type === 'pdf' && Number(staged.page || 1) !== page) {
          staged.page = page;
          const scene = getActiveScene();
          if (scene && staged.sceneItemIndex >= 0 && scene.items?.[staged.sceneItemIndex]) {
            scene.items[staged.sceneItemIndex].page = page;
            persistScenes();
          }
          await renderPreview();
          setSlideStatus();
          if (typeof updateSlidePreviewActiveState === 'function') updateSlidePreviewActiveState();
        }
      } else if (card.dataset.sceneIndex) {
        const index = Number(card.dataset.sceneIndex);
        if (Number.isFinite(index)) setStagedFromSceneIndex(index);
      }
      await sendCurrentPdfLive(document.getElementById('transition-type-select')?.value || 'fade');
      if (staged && staged.type !== 'pdf') window.fireLive();
    });
  }

  const observer = new MutationObserver(() => {
    installSlideDoubleClick();
    installLivePdfNavigation();
  });
  window.addEventListener('DOMContentLoaded', () => {
    installSlideDoubleClick();
    installLivePdfNavigation();
    const grid = document.getElementById('slide-preview-grid');
    if (grid) observer.observe(grid, { childList:true, subtree:false });
  });
})();

/* ===== Extracted inline script block ===== */

/* V23 faster adaptive downloads: 8 MB normally, then 4/2 MB fallback on constrained links. */
(() => {
  const FAST_DOWNLOAD_CHUNKS = [8 * 1024 * 1024, 4 * 1024 * 1024, 2 * 1024 * 1024];

  window.downloadCloudFileInChunksToRoot = async function(file, onProgress) {
    if (!folderHandle) throw new Error('Choose the root folder first.');
    const fileId = String(file.id || file.fileId || '');
    if (!fileId) throw new Error('Missing cloud file ID.');

    const safeName = String(file.name || file.fileName || 'downloaded-file').replace(/[\\/:*?"<>|]/g, '_');
    const destination = await folderHandle.getFileHandle(safeName, { create: true });
    const writable = await destination.createWritable();
    let offset = 0;
    let total = Math.max(0, Number(file.size) || 0);
    let chunkIndex = 0;

    try {
      while (total === 0 || offset < total) {
        let result = null;
        let bytes = null;
        let lastError = null;

        for (let attempt = chunkIndex; attempt < FAST_DOWNLOAD_CHUNKS.length; attempt += 1) {
          const chunkSize = FAST_DOWNLOAD_CHUNKS[attempt];
          try {
            result = await fetchCloudDownloadChunk(fileId, offset, offset + chunkSize - 1);
            bytes = base64ChunkToUint8Array(result.base64Data);
            if (!bytes.byteLength) throw new Error('The backend returned a zero-byte file chunk.');
            chunkIndex = attempt;
            break;
          } catch (error) {
            lastError = error;
            chunkIndex = Math.min(attempt + 1, FAST_DOWNLOAD_CHUNKS.length - 1);
          }
        }

        if (!bytes) throw lastError || new Error('Unable to download the next file chunk.');
        await writable.write({ type:'write', position:offset, data:bytes });
        offset += bytes.byteLength;
        total = Math.max(total, Number(result.totalSize) || 0);
        if (onProgress) onProgress(offset, total);
        if (result.done === true || (total > 0 && offset >= total)) break;
      }

      await writable.truncate(offset);
      await writable.close();
      return { fileHandle:destination, fileName:safeName, size:offset };
    } catch (error) {
      try { await writable.abort(); } catch (_) {}
      throw error;
    }
  };
})();

/* ===== Extracted inline script block ===== */

/* V24: synchronize the exact rendered PDF slide frame with Live View and Display Screen. */
(() => {
  const FRAME_COMMAND = 'V24_SHOW_RENDERED_PDF_FRAME';
  let frameSequence = 0;

  function getVisiblePdfCanvas() {
    const preview = document.getElementById('preview-viewport');
    if (!preview) return null;
    const frames = Array.from(preview.querySelectorAll('.v12-pdf-frame canvas, canvas'));
    return frames.length ? frames[frames.length - 1] : null;
  }

  function canvasToFrame(canvas) {
    if (!canvas) return '';
    try { return canvas.toDataURL('image/jpeg', 0.94); }
    catch (_) {
      try { return canvas.toDataURL('image/png'); } catch (_) { return ''; }
    }
  }

  async function waitForCurrentPreviewFrame(timeoutMs = 12000) {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const canvas = getVisiblePdfCanvas();
      if (canvas && canvas.width > 0 && canvas.height > 0) return canvas;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    return null;
  }

  function paintFrameIntoLive(frame, page, total) {
    const target = document.getElementById('live-viewport');
    if (!target || !frame) return;
    const label = target.querySelector('.viewport-label');
    const overlays = Array.from(target.querySelectorAll('.live-monitor-overlay'));
    target.querySelectorAll('.v24-live-frame, .v12-pdf-frame, canvas, iframe, video, img:not(.v24-live-frame img)').forEach(node => {
      if (!node.closest('.live-monitor-overlay')) node.remove();
    });
    const shell = document.createElement('div');
    shell.className = 'v24-live-frame';
    shell.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#000;z-index:4;';
    const image = document.createElement('img');
    image.src = frame;
    image.alt = 'Current PDF slide';
    image.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
    shell.appendChild(image);
    target.insertBefore(shell, target.firstChild);
    if (label) target.appendChild(label);
    overlays.forEach(overlay => target.appendChild(overlay));
    if (typeof installLivePdfNavigation === 'function') installLivePdfNavigation();
    const count = target.querySelector('.v23-live-pdf-count');
    if (count) count.textContent = total ? `Slide ${page} / ${total}` : `Slide ${page}`;
  }

  async function broadcastCurrentPdfFrame(transitionType = 'cut') {
    if (!staged || staged.type !== 'pdf') return false;
    const token = ++frameSequence;
    const canvas = await waitForCurrentPreviewFrame();
    if (!canvas || token !== frameSequence) return false;
    const frame = canvasToFrame(canvas);
    if (!frame) return false;

    const page = Number(staged.page || 1);
    const total = Number(staged.totalPages || 0);
    liveState = (typeof clonePresenterPayload === 'function')
      ? clonePresenterPayload(staged)
      : JSON.parse(JSON.stringify(staged));

    paintFrameIntoLive(frame, page, total);
    const message = { command: FRAME_COMMAND, frame, page, total, transitionType, sequence: token };
    channel.postMessage(message);
    try {
      if (displayWindow && !displayWindow.closed) displayWindow.postMessage(message, '*');
    } catch (_) {}
    return true;
  }
  window.__v24BroadcastCurrentPdfFrame = broadcastCurrentPdfFrame;

  async function receiveRenderedPdfFrame(message) {
    if (!message || message.command !== FRAME_COMMAND || !message.frame) return;
    if (!document.body.classList.contains('live-window-mode')) return;
    const payload = { type: 'image', value: message.frame, name: `PDF slide ${message.page || 1}` };
    const view = document.getElementById('audience-view');
    if (!view) return;
    const transition = message.transitionType || 'cut';
    if (transition === 'fade') {
      view.classList.add('fade-transition', 'fade-out-active');
      await new Promise(resolve => setTimeout(resolve, 180));
      await renderAudience(payload);
      requestAnimationFrame(() => view.classList.remove('fade-out-active'));
    } else if (transition === 'dissolve' && typeof renderAudienceDissolve === 'function') {
      await renderAudienceDissolve(payload);
    } else {
      view.classList.remove('fade-transition', 'fade-out-active');
      await renderAudience(payload);
    }
  }

  channel.addEventListener('message', event => receiveRenderedPdfFrame(event.data));
  window.addEventListener('message', event => receiveRenderedPdfFrame(event.data));

  const originalV23Navigate = window.v23NavigateLivePdf;
  window.v23NavigateLivePdf = async function(delta) {
    let source = (liveState && liveState.type === 'pdf') ? liveState : staged;
    if (!source || source.type !== 'pdf') return;
    if (!staged || staged.type !== 'pdf') staged = (typeof clonePresenterPayload === 'function') ? clonePresenterPayload(source) : JSON.parse(JSON.stringify(source));
    const total = Number(staged.totalPages || source.totalPages || 0);
    const current = Number(staged.page || source.page || 1);
    let next = Math.max(1, current + Number(delta || 0));
    if (total) next = Math.min(next, total);
    if (next === current) return;
    staged.page = next;
    const scene = getActiveScene();
    if (scene && staged.sceneItemIndex >= 0 && scene.items && scene.items[staged.sceneItemIndex]) {
      scene.items[staged.sceneItemIndex].page = next;
      persistScenes();
    }
    setSlideStatus();
    await renderPreview();
    if (typeof updateSlidePreviewActiveState === 'function') updateSlidePreviewActiveState();
    await broadcastCurrentPdfFrame('cut');
  };

  const originalFireLiveV24 = window.fireLive;
  window.fireLive = async function() {
    if (staged && staged.type === 'pdf') {
      if (isFTBActive || isFTGActive) {
        return originalFireLiveV24();
      }
      const transition = document.getElementById('transition-type-select')?.value || 'fade';
      const sent = await broadcastCurrentPdfFrame(transition);
      if (sent) return;
    }
    return originalFireLiveV24();
  };

  // Double-clicked PDF thumbnails are already staged by V23; resend the rendered frame after it settles.
  const grid = document.getElementById('slide-preview-grid');
  if (grid) {
    grid.addEventListener('dblclick', () => {
      setTimeout(() => broadcastCurrentPdfFrame(document.getElementById('transition-type-select')?.value || 'fade'), 80);
    }, true);
  }
})();

/* ===== Extracted inline script block ===== */

/* V27: stable live video playback and automatic root-folder refresh. */
(() => {
  const VIDEO_CLOCK_COMMAND = 'V27_VIDEO_CLOCK';
  let lastClockSentAt = 0;
  let lastClockPlaying = null;
  let rootSignature = '';
  let rootRefreshBusy = false;
  let rootWatchTimer = null;

  function sameLiveVideo() {
    try {
      if (!staged || !liveState || staged.type !== 'video' || liveState.type !== 'video') return false;
      if (staged.itemId && liveState.itemId) return staged.itemId === liveState.itemId;
      if (staged.id && liveState.id) return staged.id === liveState.id;
      if (staged.rootRelativePath && liveState.rootRelativePath) return staged.rootRelativePath === liveState.rootRelativePath;
      return Boolean(staged.value && liveState.value && staged.value === liveState.value);
    } catch (_) { return false; }
  }

  function gentlySyncVideo(video, targetTime, playing) {
    if (!video) return;
    const time = Number(targetTime || 0);
    const drift = Number.isFinite(time) ? time - Number(video.currentTime || 0) : 0;

    // Large drift gets one correction. Small drift uses tiny playback-rate changes,
    // preventing the repeated seek/jump behavior that caused display lag.
    if (Math.abs(drift) > 1.5) {
      try { video.currentTime = Math.max(0, time); } catch (_) {}
      video.playbackRate = 1;
    } else if (playing && Math.abs(drift) > 0.18) {
      video.playbackRate = drift > 0 ? 1.035 : 0.965;
    } else {
      video.playbackRate = 1;
    }

    video.muted = false;
    video.volume = 1;
    if (playing) {
      if (video.paused) video.play().catch(() => {
        if (typeof showAudioUnlock === 'function') showAudioUnlock(video);
      });
    } else if (!video.paused) {
      video.pause();
    }
  }

  // Replace the previous broad sync. Browsing another scene must never pause,
  // seek, or mute the video that is already live.
  window.syncLiveVideoFromPreview = function(time, playing) {
    if (!sameLiveVideo()) return;

    liveState.videoTime = Number(time || 0);
    liveState.videoPlaying = Boolean(playing);
    const monitorVideo = document.getElementById('operator-live-video');
    gentlySyncVideo(monitorVideo, liveState.videoTime, liveState.videoPlaying);

    const now = performance.now();
    const stateChanged = lastClockPlaying !== liveState.videoPlaying;
    if (!stateChanged && now - lastClockSentAt < 900) return;
    lastClockSentAt = now;
    lastClockPlaying = liveState.videoPlaying;

    const message = {
      command: VIDEO_CLOCK_COMMAND,
      time: liveState.videoTime,
      playing: liveState.videoPlaying,
      sentAt: Date.now()
    };
    channel.postMessage(message);
    try {
      if (displayWindow && !displayWindow.closed) displayWindow.postMessage(message, '*');
    } catch (_) {}
  };

  async function applyStableDisplayClock(message) {
    if (!document.body.classList.contains('live-window-mode')) return;
    if (!message || message.command !== VIDEO_CLOCK_COMMAND) return;
    const video = document.getElementById('audience-live-video');
    if (!video) return;
    gentlySyncVideo(video, message.time, Boolean(message.playing));
  }
  channel.addEventListener('message', event => applyStableDisplayClock(event.data));
  window.addEventListener('message', event => applyStableDisplayClock(event.data));

  async function buildRootSignature() {
    if (!folderHandle || typeof collectRootFiles !== 'function') return '';
    const files = await collectRootFiles(folderHandle);
    files.sort((a,b) => String(a.path).localeCompare(String(b.path)));
    return files.map(record => [record.path, record.file.size, record.file.lastModified].join(':')).join('|');
  }

  window.refreshRootFolderNow = async function(showFeedback = false) {
    if (rootRefreshBusy) return;
    rootRefreshBusy = true;
    const button = document.getElementById('root-refresh-btn');
    button?.classList.add('refreshing');
    try {
      if (typeof ensureRootFolderPermission === 'function') {
        const allowed = await ensureRootFolderPermission(Boolean(showFeedback));
        if (!allowed) return;
      }
      if (!folderHandle) return;

      if (typeof collectRootFiles === 'function') {
        rootFilesCache = await collectRootFiles(folderHandle);
        rootFilesCache.sort((a,b) => String(a.path).localeCompare(String(b.path)));
        rootSignature = rootFilesCache.map(record => [record.path, record.file.size, record.file.lastModified].join(':')).join('|');
      }

      const modal = document.getElementById('root-files-modal');
      if (modal?.classList.contains('open') && typeof renderRootFilesList === 'function') {
        await renderRootFilesList(false);
      }

      // Reconnect only missing root-backed scene items. Do not rerender Preview or
      // Live View, so an active video and its audio continue uninterrupted.
      let changed = false;
      if (typeof resolveRootPath === 'function') {
        for (const scene of (scenes || [])) {
          for (const item of (scene.items || [])) {
            if (!item.rootRelativePath || item.value) continue;
            try {
              const file = await resolveRootPath(item.rootRelativePath);
              item.value = URL.createObjectURL(file);
              item.mimeType = item.mimeType || file.type || '';
              changed = true;
            } catch (_) {}
          }
        }
      }
      if (changed) {
        persistScenes();
        renderSceneDeckUI();
      }

      if (showFeedback && typeof showBibleLibraryFlash === 'function') {
        showBibleLibraryFlash('Root folder refreshed.', false, true);
      }
    } catch (error) {
      if (showFeedback && typeof showModal === 'function') {
        await showModal('Refresh Failed', error?.message || String(error), false);
      }
    } finally {
      button?.classList.remove('refreshing');
      rootRefreshBusy = false;
    }
  };

  async function pollRootFolder() {
    if (rootRefreshBusy || !folderHandle || document.body.classList.contains('live-window-mode')) return;
    try {
      const next = await buildRootSignature();
      if (!rootSignature) {
        rootSignature = next;
        return;
      }
      if (next !== rootSignature) await window.refreshRootFolderNow(false);
    } catch (_) {}
  }

  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => window.refreshRootFolderNow(false), 1800);
    rootWatchTimer = setInterval(pollRootFolder, 3000);
  });

  window.addEventListener('beforeunload', () => {
    if (rootWatchTimer) clearInterval(rootWatchTimer);
  });
})();


    /* V29: reliable background transfer to the separate Display Screen. */
    const BACKGROUND_BLOB_COMMAND_V29 = 'SET_DISPLAY_BACKGROUND_BLOB_V29';
    let displayBackgroundObjectUrlV29 = '';
    let lastBackgroundBlobV29 = null;

    function postPresenterMessageV29(message) {
      try { channel.postMessage(message); } catch (_) {}
      try {
        if (displayWindow && !displayWindow.closed) {
          displayWindow.postMessage(message, '*');
        }
      } catch (_) {}
    }

    async function getCurrentBackgroundBlobV29() {
      if (lastBackgroundBlobV29 instanceof Blob) return lastBackgroundBlobV29;
      const source = currentBackgroundSource || '';
      if (!source) return null;
      try {
        const response = await fetch(source);
        if (!response.ok) throw new Error('Background image could not be read.');
        const blob = await response.blob();
        if (!blob || !blob.size) return null;
        lastBackgroundBlobV29 = blob;
        return blob;
      } catch (_) {
        return null;
      }
    }

    async function sendBackgroundToDisplayV29(forceState = null) {
      const blob = await getCurrentBackgroundBlobV29();
      if (blob) {
        postPresenterMessageV29({
          command: BACKGROUND_BLOB_COMMAND_V29,
          blob,
          active: forceState === null ? Boolean(isFTGActive) : Boolean(forceState)
        });
      } else {
        postPresenterMessageV29({
          command: BACKGROUND_BLOB_COMMAND_V29,
          blob: null,
          active: forceState === null ? Boolean(isFTGActive) : Boolean(forceState)
        });
      }
    }

    function applyDisplayBackgroundBlobV29(message) {
      if (!document.body.classList.contains('live-window-mode')) return;
      const audience = document.getElementById('audience-view');
      if (!audience) return;

      let bgLayer = document.getElementById('audience-bg-layer');
      if (!bgLayer) {
        bgLayer = document.createElement('div');
        bgLayer.id = 'audience-bg-layer';
        audience.insertBefore(bgLayer, audience.firstChild || null);
      }

      if (displayBackgroundObjectUrlV29) {
        try { URL.revokeObjectURL(displayBackgroundObjectUrlV29); } catch (_) {}
        displayBackgroundObjectUrlV29 = '';
      }

      if (message && message.blob instanceof Blob && message.blob.size) {
        displayBackgroundObjectUrlV29 = URL.createObjectURL(message.blob);
        const img = document.createElement('img');
        img.src = displayBackgroundObjectUrlV29;
        img.alt = 'Background View';
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#000;';
        bgLayer.replaceChildren(img);
      }

      bgLayer.classList.toggle('active', Boolean(message && message.active));
    }

    window.addEventListener('message', (event) => {
      const message = event && event.data;
      if (message && message.command === BACKGROUND_BLOB_COMMAND_V29) {
        applyDisplayBackgroundBlobV29(message);
      }
    });

    channel.addEventListener('message', (event) => {
      const message = event && event.data;
      if (message && message.command === BACKGROUND_BLOB_COMMAND_V29) {
        applyDisplayBackgroundBlobV29(message);
      }
    });

    const changeBackgroundTargetBeforeV29 = changeBackgroundTarget;
    changeBackgroundTarget = function(filename) {
      lastBackgroundBlobV29 = null;
      changeBackgroundTargetBeforeV29(filename);
      if (filename) sendBackgroundToDisplayV29(isFTGActive);
      else postPresenterMessageV29({ command: BACKGROUND_BLOB_COMMAND_V29, blob: null, active: false });
    };

    const toggleFadeToBackgroundBeforeV29 = toggleFadeToBackground;
    toggleFadeToBackground = async function() {
      const wasActive = Boolean(isFTGActive);
      toggleFadeToBackgroundBeforeV29();
      if (Boolean(isFTGActive) === wasActive && !wasActive) return;
      await sendBackgroundToDisplayV29(isFTGActive);
      postPresenterMessageV29({ command: 'TOGGLE_FTG_STATE', active: Boolean(isFTGActive) });
    };

    const openDisplayWindowBeforeV29 = openDisplayWindow;
    openDisplayWindow = async function() {
      await openDisplayWindowBeforeV29();
      if (!displayWindow) return;
      setTimeout(() => {
        sendBackgroundToDisplayV29(isFTGActive);
        postPresenterMessageV29({ command: 'TOGGLE_FTG_STATE', active: Boolean(isFTGActive) });
        postPresenterMessageV29({ command: 'TOGGLE_FTB_STATE', active: Boolean(isFTBActive) });
      }, 900);
    };

/* ===== Extracted inline script block ===== */

/* V31: flicker-free Google Slides frames, upload percentage, and Live View navigation. */
(() => {
  const GS_SYNC_COMMAND='V31_GOOGLE_SLIDE_LIVE';
  const renderTokens=new WeakMap();

  function isGs(payload){return Boolean(payload&&payload.type==='google-slides'&&payload.googleSlides&&payload.googleSlides.presentationId)}
  function gsSlides(payload){return Array.isArray(payload?.googleSlides?.slides)?payload.googleSlides.slides:[]}
  function gsIndex(payload){
    const slides=gsSlides(payload);if(!slides.length)return 0;
    const id=String(payload?.googleSlides?.currentSlideId||'');
    const byId=id?slides.findIndex(s=>String(s.slideId||s.objectId||'')===id):-1;
    return byId>=0?byId:Math.max(0,Math.min(slides.length-1,Number(payload?.page||1)-1));
  }
  function gsSlide(payload,index=gsIndex(payload)){return gsSlides(payload)[index]||null}
  function gsThumb(payload,index=gsIndex(payload)){return String(gsSlide(payload,index)?.thumbnailUrl||'')}
  function clone(value){try{return typeof clonePresenterPayload==='function'?clonePresenterPayload(value):structuredClone(value)}catch(_){return JSON.parse(JSON.stringify(value))}}

  function applySlide(payload,index){
    const slides=gsSlides(payload);if(!slides.length)return payload;
    index=Math.max(0,Math.min(slides.length-1,Number(index)||0));
    const slide=slides[index];
    payload.page=index+1;
    payload.googleSlides.currentSlideId=String(slide.slideId||slide.objectId||'');
    payload.googleSlides.thumbnailUrl=String(slide.thumbnailUrl||'');
    return payload;
  }

  async function preloadImage(url){
    if(!url)throw new Error('Slide thumbnail is unavailable. Open Edit Presentation to refresh the slides.');
    const img=new Image();img.decoding='async';img.src=url;
    if(img.decode){try{await img.decode();return img}catch(_){}}
    await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(new Error('Unable to load slide image.'))});
    return img;
  }

  function ensurePreviewTools(target){
    if(target.id!=='preview-viewport'||target.querySelector('.google-slides-preview-tools'))return;
    const badge=document.createElement('div');badge.className='google-slides-badge';badge.textContent='Editable PowerPoint';target.appendChild(badge);
    const tools=document.createElement('div');tools.className='google-slides-preview-tools';
    tools.innerHTML='<button type="button" onclick="openGoogleSlidesAssetEditor()">✏️ Edit Presentation</button><button type="button" style="background:var(--accent-green)" onclick="openGoogleSlidesAssetEditor();setTimeout(()=>exportEditedPptxToPdf(),350)">📄 Convert to PDF</button><button type="button" style="background:var(--accent-purple)" onclick="window.open(staged.googleSlides.presentUrl,\'_blank\',\'noopener\')">⛶ Open Presentation</button>';
    target.appendChild(tools);
  }

  function installGsLiveNav(target,payload){
    target.querySelectorAll('.v31-gs-live-nav').forEach(n=>n.remove());
    if(target.id!=='live-viewport'||!isGs(payload))return;
    const slides=gsSlides(payload),index=gsIndex(payload);
    const nav=document.createElement('div');nav.className='v31-gs-live-nav';
    const prev=document.createElement('button');prev.type='button';prev.innerHTML='&#8249;';prev.title='Previous slide';prev.disabled=index<=0;prev.onclick=e=>{e.stopPropagation();window.v31NavigateGoogleSlide(-1)};
    const next=document.createElement('button');next.type='button';next.innerHTML='&#8250;';next.title='Next slide';next.disabled=index>=slides.length-1;next.onclick=e=>{e.stopPropagation();window.v31NavigateGoogleSlide(1)};
    const count=document.createElement('div');count.className='v31-gs-count';count.textContent=`Slide ${index+1} / ${slides.length}`;
    nav.append(prev,next,count);target.appendChild(nav);
  }

  async function renderGsFrame(target,payload,options={}){
    const token={};renderTokens.set(target,token);
    const url=gsThumb(payload);
    const image=await preloadImage(url);
    if(renderTokens.get(target)!==token)return true;
    const label=target.querySelector('.viewport-label');
    const overlays=Array.from(target.querySelectorAll('.live-monitor-overlay'));
    const old=target.querySelector('.v31-gs-layer.active');
    const layer=document.createElement('div');layer.className='v31-gs-layer';layer.appendChild(image);target.appendChild(layer);
    requestAnimationFrame(()=>layer.classList.add('active'));
    if(label)target.appendChild(label);overlays.forEach(o=>target.appendChild(o));
    ensurePreviewTools(target);installGsLiveNav(target,payload);
    setTimeout(()=>{target.querySelectorAll('.v31-gs-layer').forEach(n=>{if(n!==layer)n.remove()});target.querySelectorAll('.google-slides-stage').forEach(n=>n.remove())},220);
    if(old&&old!==layer)old.classList.remove('active');
    return true;
  }

  const priorMedia=window.renderMediaIntoViewport;
  window.renderMediaIntoViewport=async function(target,payload,options={}){
    if(!isGs(payload))return priorMedia(target,payload,options);
    try{return await renderGsFrame(target,payload,options)}catch(error){console.warn('Google slide frame failed:',error);return priorMedia(target,payload,options)}
  };

  const priorLayer=window.buildAudienceMediaLayer;
  window.buildAudienceMediaLayer=async function(payload){
    if(!isGs(payload))return priorLayer(payload);
    const layer=document.createElement('div');layer.className='audience-media-layer';layer.style.zIndex='10';
    const image=await preloadImage(gsThumb(payload));image.style.cssText='width:100%;height:100%;object-fit:contain;display:block;background:#000;';layer.appendChild(image);return layer;
  };

  window.v31NavigateGoogleSlide=async function(delta){
    if(!isGs(liveState))return;
    const slides=gsSlides(liveState),current=gsIndex(liveState),next=Math.max(0,Math.min(slides.length-1,current+Number(delta||0)));
    if(next===current)return;
    applySlide(liveState,next);
    if(isGs(staged)&&String(staged.googleSlides.presentationId)===String(liveState.googleSlides.presentationId)){
      applySlide(staged,next);
      const scene=getActiveScene();
      if(scene&&Number.isInteger(staged.sceneItemIndex)&&scene.items?.[staged.sceneItemIndex]){
        const item=scene.items[staged.sceneItemIndex];item.page=staged.page;item.googleSlides=clone(staged.googleSlides);persistScenes();
      }
      await renderPreview();
      if(typeof populateSlidePreviewGrid==='function')populateSlidePreviewGrid();
    }
    await renderLiveView();
    const message={command:GS_SYNC_COMMAND,payload:clone(liveState)};
    channel.postMessage(message);
    try{if(displayWindow&&!displayWindow.closed)displayWindow.postMessage(message,'*')}catch(_){}
  };

  async function receiveGsSync(message){
    if(!message||message.command!==GS_SYNC_COMMAND||!isGs(message.payload))return;
    if(document.body.classList.contains('live-window-mode')){
      await performAudienceTransition(message.payload,'cut');
    }else{
      liveState=clone(message.payload);await renderLiveView();
    }
  }
  channel.addEventListener('message',e=>receiveGsSync(e.data));
  window.addEventListener('message',e=>receiveGsSync(e.data));

  const priorSelect=window.selectGoogleSlideForPreview;
  window.selectGoogleSlideForPreview=async function(index){
    if(!(isGs(staged)))return priorSelect(index);
    applySlide(staged,index);
    const scene=getActiveScene();
    if(scene&&Number.isInteger(staged.sceneItemIndex)&&scene.items?.[staged.sceneItemIndex]){
      const item=scene.items[staged.sceneItemIndex];item.page=staged.page;item.googleSlides=clone(staged.googleSlides);persistScenes();
    }
    await renderPreview();setSlideStatus();
    document.querySelectorAll('#slide-preview-grid .preview-slide-card').forEach((card,i)=>card.classList.toggle('active',i===Number(index)));
  };

  const priorRenderLive=window.renderLiveView;
  window.renderLiveView=async function(){const result=await priorRenderLive();if(isGs(liveState))installGsLiveNav(document.getElementById('live-viewport'),liveState);return result};
})();

/* ===== Extracted inline script block ===== */

/* V32: persistent PPTX relinking and an external icon-only Preview toolbar. */
(() => {
  const editSvg='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
  const pdfSvg='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 15h2a2 2 0 0 0 0-4H8v6"/><path d="M14 11v6"/><path d="M14 11h2.5"/></svg>';

  function isPptxAsset(payload){
    return Boolean(payload && payload.type==='google-slides' && payload.googleSlides && payload.googleSlides.presentationId);
  }

  function ensureToolbar(){
    let bar=document.getElementById('v32-pptx-toolbar');
    if(bar)return bar;
    const viewport=document.getElementById('preview-viewport');
    if(!viewport)return null;
    bar=document.createElement('div');bar.id='v32-pptx-toolbar';
    bar.innerHTML='<span class="v32-pptx-link-status">Editable PowerPoint</span>'+
      '<button type="button" class="v32-icon-btn edit" title="Edit presentation" aria-label="Edit presentation">'+editSvg+'</button>'+
      '<button type="button" class="v32-icon-btn convert" title="Convert to PDF" aria-label="Convert to PDF">'+pdfSvg+'</button>';
    viewport.insertAdjacentElement('afterend',bar);
    bar.querySelector('.edit').addEventListener('click',()=>window.openGoogleSlidesAssetEditor?.());
    bar.querySelector('.convert').addEventListener('click',()=>{
      window.openGoogleSlidesAssetEditor?.();
      setTimeout(()=>window.exportEditedPptxToPdf?.(),350);
    });
    return bar;
  }

  function updateToolbar(){
    const bar=ensureToolbar();if(!bar)return;
    const active=isPptxAsset(staged);
    bar.classList.toggle('show',active);
    const status=bar.querySelector('.v32-pptx-link-status');
    if(status)status.textContent=active?(staged.name||staged.googleSlides?.sourceFileName||'Editable PowerPoint'):'Editable PowerPoint';
    document.querySelectorAll('#preview-viewport .google-slides-preview-tools').forEach(n=>n.remove());
  }

  const preview=document.getElementById('preview-viewport');
  if(preview){new MutationObserver(updateToolbar).observe(preview,{childList:true,subtree:true});}

  const priorRenderPreview=window.renderPreview;
  window.renderPreview=async function(){
    const result=await priorRenderPreview.apply(this,arguments);
    updateToolbar();return result;
  };

  const priorStage=window.setStagedFromSceneIndex;
  window.setStagedFromSceneIndex=function(index){
    const result=priorStage.apply(this,arguments);
    const item=getActiveDeck?.()?.[index];
    if(isPptxAsset(item)){
      staged.page=Math.max(1,Number(item.page||1));
      staged.googleSlides=JSON.parse(JSON.stringify(item.googleSlides));
      staged.googleSlides.currentSlideId=item.googleSlides.currentSlideId||item.googleSlides.slides?.[staged.page-1]?.slideId||'';
    }
    updateToolbar();return result;
  };

  async function refreshOne(item){
    if(!isPptxAsset(item))return false;
    const id=String(item.googleSlides.presentationId||'');if(!id)return false;
    const data=await postGoogleScriptJson({action:'getGoogleSlidesEditorData',presentationId:id});
    if(!Array.isArray(data.slides))return false;
    const currentId=String(item.googleSlides.currentSlideId||'');
    item.googleSlides.slides=data.slides;
    item.googleSlides.previewUrl=`https://docs.google.com/presentation/d/${encodeURIComponent(id)}/preview?rm=minimal`;
    item.googleSlides.presentUrl=`https://docs.google.com/presentation/d/${encodeURIComponent(id)}/present?rm=minimal`;
    let index=currentId?data.slides.findIndex(s=>String(s.slideId||s.objectId||'')===currentId):-1;
    if(index<0)index=Math.max(0,Math.min(data.slides.length-1,Number(item.page||1)-1));
    const slide=data.slides[index]||data.slides[0];
    item.page=index+1;
    item.googleSlides.currentSlideId=String(slide?.slideId||slide?.objectId||'');
    item.googleSlides.thumbnailUrl=String(slide?.thumbnailUrl||'');
    item.value=item.googleSlides.previewUrl+(item.googleSlides.currentSlideId?'&slide=id.'+encodeURIComponent(item.googleSlides.currentSlideId.replace(/^id\./,'')):'');
    return true;
  }

  async function restorePptxLinks(){
    const assets=[];
    (scenes||[]).forEach(scene=>(scene.items||[]).forEach(item=>{if(isPptxAsset(item))assets.push(item)}));
    if(!assets.length){updateToolbar();return;}
    const status=ensureToolbar()?.querySelector('.v32-pptx-link-status');
    if(status)status.textContent='Restoring PowerPoint link…';
    let changed=false;
    for(const item of assets){
      try{changed=(await refreshOne(item))||changed;}catch(error){console.warn('Unable to restore PowerPoint link:',error);}
    }
    if(changed){persistScenes?.();renderSceneDeckUI?.();populateSlidePreviewGrid?.();}
    const scene=getActiveScene?.();
    if(scene&&Number.isInteger(staged?.sceneItemIndex)&&isPptxAsset(scene.items?.[staged.sceneItemIndex])){
      const item=scene.items[staged.sceneItemIndex];
      staged.googleSlides=JSON.parse(JSON.stringify(item.googleSlides));staged.page=item.page;staged.value=item.value;
      await renderPreview?.();
    }
    updateToolbar();
  }

  window.addEventListener('DOMContentLoaded',()=>setTimeout(restorePptxLinks,900));
  setTimeout(updateToolbar,0);
})();

/* ===== Extracted inline script block ===== */

/* V43: Existing cloud PPTX files are added directly to the active scene. */
(() => {
  const PPTX_MIME_V43 = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  let pptxLibraryMode = false;

  function isPptxFile(file) {
    return /\.pptx$/i.test(String(file?.name || file?.fileName || '')) ||
      String(file?.mimeType || '') === PPTX_MIME_V43;
  }

  async function findDriveFile(fileId) {
    const id = String(fileId || '');
    let file = Array.isArray(window.onlineDriveFilesCache)
      ? window.onlineDriveFilesCache.find(item => String(item.id || item.fileId || '') === id)
      : null;
    if (!file && typeof getDriveFilesFromBackend === 'function') {
      const files = await getDriveFilesFromBackend(false);
      file = files.find(item => String(item.id || item.fileId || '') === id);
    }
    return file || null;
  }

  window.addCloudPptxDirectlyToScene = async function(fileId) {
    const id = String(fileId || '');
    const card = document.querySelector(`.drive-pdf-card[data-drive-file-id="${CSS.escape(id)}"]`);
    const button = card?.querySelector('.drive-pptx-add-action');
    const status = card?.querySelector('.drive-pptx-card-status');

    try {
      if (button) {
        button.disabled = true;
        button.innerHTML = '<span>⏳</span><span>Preparing…</span>';
      }
      if (status) {
        status.textContent = 'Connecting the saved PowerPoint to Google Slides…';
        status.className = 'drive-pptx-card-status';
      }

      const file = await findDriveFile(id);
      if (!file) throw new Error('The selected PowerPoint is no longer available in cloud storage.');
      if (!isPptxFile(file)) throw new Error('The selected cloud file is not a PPTX presentation.');
      if (typeof window.addDriveFileToActiveScene !== 'function') {
        throw new Error('The Add to Scene function is not ready. Refresh the website and try again.');
      }

      await window.addDriveFileToActiveScene(file);

      if (status) {
        status.textContent = '✓ Added to the active scene';
        status.className = 'drive-pptx-card-status success';
      }
      if (button) {
        button.disabled = false;
        button.innerHTML = '<span>✓</span><span>Added to Scene</span>';
      }
    } catch (error) {
      if (status) {
        status.textContent = error?.message || String(error);
        status.className = 'drive-pptx-card-status error';
      }
      if (button) {
        button.disabled = false;
        button.innerHTML = '<span>＋</span><span>Add to Scene</span>';
      }
    }
  };

  function renderPptxLibraryCards(files, targetId) {
    const list = document.getElementById(targetId);
    if (!list) return;
    if (!files.length) {
      list.innerHTML = '<div style="grid-column:1/-1;color:var(--text-muted);padding:22px;text-align:center;">No PowerPoint files are available.</div>';
      return;
    }

    list.innerHTML = files.map(file => {
      const id = String(file.id || file.fileId || '');
      const name = String(file.name || file.fileName || 'Presentation.pptx');
      const created = file.createdTime ? new Date(file.createdTime).toLocaleString() : '';
      return `<div class="drive-pdf-card" data-drive-file-id="${escapeHtml(id)}">
        <button class="drive-file-delete" title="Delete file" onclick="deleteOnlineDriveFile('${escapeHtml(id)}')">🗑</button>
        <div class="drive-file-thumb">${driveFilePreviewHtml(file)}</div>
        <div class="drive-file-kind">POWERPOINT</div>
        <div class="drive-pdf-card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
        <div class="drive-pdf-card-meta">${escapeHtml(formatFileBytes(file.size || 0))}<br>${escapeHtml(created)}</div>
        <div class="drive-pdf-card-actions">
          <button class="drive-pptx-add-action" onclick="addCloudPptxDirectlyToScene('${escapeHtml(id)}')">
            <span>＋</span><span>Add to Scene</span>
          </button>
        </div>
        <div class="drive-pptx-card-status" aria-live="polite">Uses the existing cloud file — no download or re-upload.</div>
      </div>`;
    }).join('');
  }

  const previousRenderDriveFileCards = window.renderDriveFileCards;
  window.renderDriveFileCards = function(files, targetId) {
    if (pptxLibraryMode && targetId === 'drive-pdf-list') {
      renderPptxLibraryCards((files || []).filter(isPptxFile), targetId);
      return;
    }
    return previousRenderDriveFileCards(files, targetId);
  };

  window.openDrivePptxFilesModal = async function() {
    pptxLibraryMode = true;
    const modal = document.getElementById('drive-pdf-modal');
    const title = modal?.querySelector('.modal-title');
    const description = modal?.querySelector('.modal-body');
    const toolbar = modal?.querySelector('.drive-view-toolbar');
    const list = document.getElementById('drive-pdf-list');

    if (title) title.textContent = 'PowerPoint Files';
    if (description) description.textContent = 'Click Add to Scene to reuse a PPTX already stored in cloud storage. It will not be downloaded or uploaded again.';
    if (toolbar) toolbar.style.display = 'none';
    modal?.classList.add('open');
    if (list) list.innerHTML = '<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted)">Loading PowerPoint files…</div>';

    try {
      const files = (await getDriveFilesFromBackend(false)).filter(isPptxFile);
      renderPptxLibraryCards(files, 'drive-pdf-list');
    } catch (error) {
      if (list) list.innerHTML = '<div style="grid-column:1/-1;color:var(--accent-red);padding:20px">' + escapeHtml(error?.message || String(error)) + '</div>';
    }
  };

  const previousOpenDrivePdfModal = window.openDrivePdfModal;
  window.openDrivePdfModal = function() {
    pptxLibraryMode = false;
    return previousOpenDrivePdfModal.apply(this, arguments);
  };
})();

/* ===== Extracted inline script block ===== */

/* V44: keep Preview bound to the active scene and prevent an older scene render
   from replacing the newly selected scene/slide. */
(() => {
  let previewSceneVersion = 0;

  function activeSceneToken() {
    const scene = typeof getActiveScene === 'function' ? getActiveScene() : null;
    return `${scene?.id || activeSceneId || ''}|${staged?.itemId || staged?.id || ''}|${staged?.page || 1}|${previewSceneVersion}`;
  }

  function cloneStageForRender(value) {
    if (!value) return value;
    try {
      return typeof clonePresenterPayload === 'function'
        ? clonePresenterPayload(value)
        : structuredClone(value);
    } catch (_) {
      return Object.assign({}, value, {
        googleSlides: value.googleSlides ? JSON.parse(JSON.stringify(value.googleSlides)) : value.googleSlides
      });
    }
  }

  const previousSetStagedV44 = window.setStagedFromSceneIndex;
  window.setStagedFromSceneIndex = function(index) {
    previewSceneVersion += 1;
    const result = previousSetStagedV44.apply(this, arguments);
    const scene = typeof getActiveScene === 'function' ? getActiveScene() : null;
    if (staged) staged.sceneId = scene?.id || activeSceneId || '';
    return result;
  };

  const previousRenderPreviewV44 = window.renderPreview;
  window.renderPreview = async function() {
    const sceneAtStart = typeof getActiveScene === 'function' ? getActiveScene() : null;
    const expectedSceneId = sceneAtStart?.id || activeSceneId || '';
    const expectedVersion = previewSceneVersion;
    const payload = cloneStageForRender(staged);
    if (payload) payload.sceneId = expectedSceneId;

    const target = document.getElementById('preview-viewport');
    if (!target) return;
    const requestToken = `${expectedSceneId}|${payload?.itemId || payload?.id || ''}|${payload?.page || 1}|${expectedVersion}|${Date.now()}|${Math.random()}`;
    target.dataset.v44PreviewToken = requestToken;

    await renderMediaIntoViewport(target, payload, {
      placeholderId: 'preview-placeholder',
      emptyText: 'No Media Queued'
    });

    const currentSceneId = (typeof getActiveScene === 'function' ? getActiveScene()?.id : activeSceneId) || '';
    if (target.dataset.v44PreviewToken !== requestToken || currentSceneId !== expectedSceneId || previewSceneVersion !== expectedVersion) {
      return;
    }

    if (typeof updateSlidePreviewActiveState === 'function') updateSlidePreviewActiveState();
  };

  const previousSelectGoogleSlideV44 = window.selectGoogleSlideForPreview;
  window.selectGoogleSlideForPreview = async function(index) {
    const scene = typeof getActiveScene === 'function' ? getActiveScene() : null;
    if (!scene) return;

    // Rebuild staged from the active scene when a stale scene payload is still held.
    if (!staged || staged.sceneId !== scene.id || staged.type !== 'google-slides') {
      let itemIndex = Number.isInteger(staged?.sceneItemIndex) ? staged.sceneItemIndex : -1;
      if (!scene.items?.[itemIndex] || scene.items[itemIndex].type !== 'google-slides') {
        itemIndex = (scene.items || []).findIndex(item => item?.type === 'google-slides');
      }
      if (itemIndex >= 0) window.setStagedFromSceneIndex(itemIndex);
    }

    previewSceneVersion += 1;
    const result = await previousSelectGoogleSlideV44.apply(this, arguments);
    if (staged) staged.sceneId = scene.id;
    await window.renderPreview();
    return result;
  };

  // Scene clicks are handled in the original inline listener. Capture the click first,
  // invalidate any pending preview render, then enforce the selected scene after it runs.
  document.addEventListener('click', event => {
    const sceneRow = event.target.closest('#scene-list .scene-item');
    if (!sceneRow) return;
    previewSceneVersion += 1;
    const clickedIndex = Array.from(document.querySelectorAll('#scene-list .scene-item')).indexOf(sceneRow);
    const clickedScene = scenes?.[clickedIndex];
    if (!clickedScene) return;

    setTimeout(() => {
      if (activeSceneId !== clickedScene.id) return;
      const deck = clickedScene.items || [];
      if (!deck.length) {
        staged = { type:'none', value:null, sceneItemIndex:-1, page:1, videoTime:0, videoPlaying:false, sceneId:clickedScene.id };
        window.renderPreview();
        if (typeof populateSlidePreviewGrid === 'function') populateSlidePreviewGrid();
        return;
      }

      const stagedBelongsToScene = staged && staged.sceneId === clickedScene.id &&
        Number.isInteger(staged.sceneItemIndex) && deck[staged.sceneItemIndex];
      if (!stagedBelongsToScene) window.setStagedFromSceneIndex(0);
      else window.renderPreview();
      if (typeof populateSlidePreviewGrid === 'function') populateSlidePreviewGrid();
    }, 0);
  }, true);
})();

/* ===== Extracted inline script block ===== */

/* V47 FINAL: atomic Google Slides selection, Preview, Live View, and Display output.
   This intentionally bypasses every older Google Slides iframe/render wrapper. */
(() => {
  let gsRenderSerial = 0;

  function isGs(payload){
    return Boolean(payload && payload.type === 'google-slides' && payload.googleSlides && payload.googleSlides.presentationId);
  }
  function gsSlides(payload){
    return Array.isArray(payload?.googleSlides?.slides) ? payload.googleSlides.slides : [];
  }
  function gsIndex(payload){
    const slides = gsSlides(payload);
    if (!slides.length) return 0;
    const currentId = String(payload?.googleSlides?.currentSlideId || '');
    const found = currentId ? slides.findIndex(s => String(s.slideId || s.objectId || '') === currentId) : -1;
    return found >= 0 ? found : Math.max(0, Math.min(slides.length - 1, Number(payload?.page || 1) - 1));
  }
  function gsSlide(payload){ return gsSlides(payload)[gsIndex(payload)] || null; }
  function gsThumb(payload){
    const slide = gsSlide(payload);
    return String(slide?.thumbnailUrl || payload?.googleSlides?.thumbnailUrl || '');
  }
  function cloneGs(value){
    try { return typeof clonePresenterPayload === 'function' ? clonePresenterPayload(value) : structuredClone(value); }
    catch (_) { return JSON.parse(JSON.stringify(value)); }
  }

  function loadGsImage(url){
    return new Promise((resolve,reject) => {
      if (!url) return reject(new Error('No slide thumbnail URL.'));
      const img = new Image();
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Slide thumbnail failed to load.'));
      img.src = url;
      if (img.complete && img.naturalWidth > 0) resolve(img);
    });
  }

  async function renderGsInto(target,payload,readOnly=false){
    if (!target || !isGs(payload)) return false;
    const serial = ++gsRenderSerial;
    const old = target.querySelector('.v47-gs-frame.active');
    const url = gsThumb(payload);

    try {
      const image = await loadGsImage(url);
      if (serial !== gsRenderSerial) return true;

      const frame = document.createElement('div');
      frame.className = 'v47-gs-frame';
      frame.appendChild(image);
      target.appendChild(frame);

      const label = target.querySelector('.viewport-label');
      const overlays = Array.from(target.querySelectorAll('.live-monitor-overlay'));
      if (label) target.appendChild(label);
      overlays.forEach(el => target.appendChild(el));

      const count = document.createElement('div');
      count.className = 'v47-gs-count';
      count.textContent = `Slide ${gsIndex(payload)+1} / ${Math.max(1,gsSlides(payload).length)}`;
      frame.appendChild(count);

      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (serial !== gsRenderSerial) { frame.remove(); return true; }
      frame.classList.add('active');
      if (old && old !== frame) old.classList.remove('active');

      setTimeout(() => {
        if (serial !== gsRenderSerial) return;
        target.querySelectorAll('.v47-gs-frame').forEach(node => { if (node !== frame) node.remove(); });
        target.querySelectorAll('.google-slides-stage,.v31-gs-layer,.v45-pptx-frame,.v46-gs-frame,.drive-online-preview-frame').forEach(node => node.remove());
        if (label) target.appendChild(label);
        overlays.forEach(el => target.appendChild(el));
      }, 190);
      return true;
    } catch (error) {
      console.warn('V47 kept the existing Google Slides frame:', error);
      // Never clear the previous frame and never fall back to an iframe.
      return true;
    }
  }

  const mediaBeforeV47 = window.renderMediaIntoViewport;
  window.renderMediaIntoViewport = async function(target,payload,options={}){
    if (isGs(payload)) return renderGsInto(target,payload,Boolean(options.readOnly));
    return mediaBeforeV47(target,payload,options);
  };

  window.selectGoogleSlideForPreview = async function(index){
    const scene = getActiveScene?.();
    if (!scene) return;
    let itemIndex = Number.isInteger(staged?.sceneItemIndex) ? staged.sceneItemIndex : -1;
    let item = scene.items?.[itemIndex];
    if (!item || item.type !== 'google-slides') {
      itemIndex = (scene.items || []).findIndex(entry => entry?.type === 'google-slides');
      item = scene.items?.[itemIndex];
    }
    if (!item || !item.googleSlides) return;

    const slides = Array.isArray(item.googleSlides.slides) ? item.googleSlides.slides : [];
    const safe = Math.max(0,Math.min(slides.length-1,Number(index)||0));
    const slide = slides[safe];
    if (!slide) return;
    const slideId = String(slide.slideId || slide.objectId || '');

    item.page = safe + 1;
    item.googleSlides.currentSlideId = slideId;
    item.googleSlides.thumbnailUrl = String(slide.thumbnailUrl || '');
    staged = {
      ...cloneGs(item),
      id:item.id,itemId:item.id,sceneId:scene.id,sceneItemIndex:itemIndex,
      type:'google-slides',page:safe+1,name:item.name || 'Presentation.pptx',
      googleSlides:cloneGs(item.googleSlides)
    };
    try { persistScenes(); } catch (_) {}
    setSlideStatus();
    await renderGsInto(document.getElementById('preview-viewport'),staged,false);
    document.querySelectorAll('#slide-preview-grid .preview-slide-card').forEach((card,i)=>card.classList.toggle('active',i===safe));
  };

  const layerBeforeV47 = window.buildAudienceMediaLayer;
  window.buildAudienceMediaLayer = async function(payload){
    if (!isGs(payload)) return layerBeforeV47(payload);
    const layer = document.createElement('div');
    layer.className = 'audience-media-layer';
    layer.style.zIndex = '10';
    const image = await loadGsImage(gsThumb(payload));
    image.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#000;';
    layer.appendChild(image);
    return layer;
  };

  const fireBeforeV47 = window.fireLive;
  window.fireLive = async function(){
    if (!isGs(staged)) return fireBeforeV47.apply(this,arguments);
    if (isFTBActive || isFTGActive) {
      showModal('Live View Is Covered','Turn off Fade To Black or Fade To Background before sending a new preview live.',false);
      return;
    }
    const transition = document.getElementById('transition-type-select')?.value || 'fade';
    liveState = cloneGs(staged);
    await renderGsInto(document.getElementById('live-viewport'),liveState,true);
    lastIncoming = cloneGs(liveState);
    const message = {command:'TRIGGER_LIVE_FADE',payload:cloneGs(liveState),transitionType:transition};
    channel.postMessage(message);
    try {
      if (displayWindow && !displayWindow.closed) displayWindow.postMessage(message,'*');
    } catch (_) {}
  };

  // Direct popup fallback for browsers where BroadcastChannel is delayed.
  window.addEventListener('message', async event => {
    const msg = event.data;
    if (!document.body.classList.contains('live-window-mode') || !msg || msg.command !== 'TRIGGER_LIVE_FADE' || !isGs(msg.payload)) return;
    await performAudienceTransition(msg.payload,msg.transitionType || 'fade');
  });
})();

/* ===== Extracted inline script block ===== */

/* V49: one presentation layer per monitor. Prevent a previous PPTX layer and its
   controls from covering a PDF frame (and vice versa). */
(() => {
  function mediaType(payload) {
    if (!payload) return '';
    if (payload.type === 'google-slides') return 'google-slides';
    if (payload.type === 'pdf') return 'pdf';
    return String(payload.type || '');
  }

  function removeNodes(root, selectors) {
    if (!root) return;
    root.querySelectorAll(selectors).forEach(node => node.remove());
  }

  function normalizeLiveLayers(payload) {
    const live = document.getElementById('live-viewport');
    if (!live) return;
    const type = mediaType(payload);
    live.dataset.v49Media = type;

    if (type === 'pdf') {
      removeNodes(live, '.v47-gs-frame,.v46-gs-frame,.v45-pptx-frame,.v31-gs-layer,.google-slides-stage,.drive-online-preview-frame,.v47-gs-count');
      // V23 and V24 can both install navigation/count controls. Keep only one nav.
      const navs = Array.from(live.querySelectorAll('.v23-live-pdf-nav'));
      navs.slice(0, -1).forEach(node => node.remove());
      removeNodes(live, '.v23-live-pdf-count,.v49-live-slide-count');
      const count = document.createElement('div');
      count.className = 'v49-live-slide-count';
      const page = Math.max(1, Number(payload?.page || 1));
      const total = Math.max(0, Number(payload?.totalPages || 0));
      count.textContent = total ? `Slide ${page} / ${total}` : `Slide ${page}`;
      live.appendChild(count);
    } else if (type === 'google-slides') {
      removeNodes(live, '.v48-pdf-live-frame,.v24-live-frame,.v12-pdf-frame,.v19-pdf-stage,.v17-online-pdf-layer,.v23-live-pdf-nav,.v23-live-pdf-count,.v49-live-slide-count');
      // V47 already supplies the correct PPTX slide counter.
    } else {
      removeNodes(live, '.v47-gs-frame,.v46-gs-frame,.v45-pptx-frame,.v31-gs-layer,.google-slides-stage,.v48-pdf-live-frame,.v24-live-frame,.v12-pdf-frame,.v19-pdf-stage,.v17-online-pdf-layer,.v23-live-pdf-nav,.v23-live-pdf-count,.v47-gs-count,.v49-live-slide-count');
    }

    if (typeof updateLiveMonitorOverlays === 'function') updateLiveMonitorOverlays();
  }

  const fireBeforeV49 = window.fireLive;
  window.fireLive = async function(...args) {
    const outgoing = staged;
    const type = mediaType(outgoing);
    const live = document.getElementById('live-viewport');
    if (live) live.dataset.v49Media = type;

    // Remove the outgoing presentation type before an older asynchronous renderer
    // gets a chance to leave its black layer over the new slide.
    if (type === 'pdf') {
      removeNodes(live, '.v47-gs-frame,.v46-gs-frame,.v45-pptx-frame,.v31-gs-layer,.google-slides-stage,.drive-online-preview-frame,.v47-gs-count');
    } else if (type === 'google-slides') {
      removeNodes(live, '.v48-pdf-live-frame,.v24-live-frame,.v12-pdf-frame,.v19-pdf-stage,.v17-online-pdf-layer,.v23-live-pdf-nav,.v23-live-pdf-count,.v49-live-slide-count');
    }

    const result = await fireBeforeV49.apply(this, args);
    normalizeLiveLayers(liveState || outgoing);
    // Run once more after transition timers from older versions have completed.
    setTimeout(() => normalizeLiveLayers(liveState || outgoing), 360);
    return result;
  };

  // Keep cleanup active when PDF navigation updates the current live page.
  const navigateBeforeV49 = window.v23NavigateLivePdf;
  if (typeof navigateBeforeV49 === 'function') {
    window.v23NavigateLivePdf = async function(...args) {
      const result = await navigateBeforeV49.apply(this, args);
      normalizeLiveLayers(liveState || staged);
      setTimeout(() => normalizeLiveLayers(liveState || staged), 180);
      return result;
    };
  }

  // External display: remove layers belonging to the previous presentation type.
  function normalizeAudience(payload) {
    if (!document.body.classList.contains('live-window-mode')) return;
    const audience = document.getElementById('audience-view');
    if (!audience) return;
    const type = mediaType(payload);
    audience.dataset.v49Media = type;
    if (type === 'pdf') {
      removeNodes(audience, '.v47-gs-frame,.v46-gs-frame,.v45-pptx-frame,.v31-gs-layer,.google-slides-stage,.drive-online-preview-frame,.v47-gs-count');
    } else if (type === 'google-slides') {
      removeNodes(audience, '.v48-pdf-output-frame,.v24-live-frame,.v12-pdf-frame,.v19-pdf-stage,.v17-output-pdf-layer,.v23-live-pdf-nav,.v23-live-pdf-count,.v49-live-slide-count');
    }
  }

  channel.addEventListener('message', event => {
    const msg = event.data || {};
    if (msg.command === 'V48_SHOW_PDF_FRAME' || msg.command === 'V24_SHOW_RENDERED_PDF_FRAME') {
      normalizeAudience({type:'pdf'});
      setTimeout(() => normalizeAudience({type:'pdf'}), 360);
    } else if (msg.command === 'TRIGGER_LIVE_FADE' && msg.payload) {
      normalizeAudience(msg.payload);
      setTimeout(() => normalizeAudience(msg.payload), 360);
    }
  });
  window.addEventListener('message', event => {
    const msg = event.data || {};
    if (msg.command === 'V48_SHOW_PDF_FRAME' || msg.command === 'V24_SHOW_RENDERED_PDF_FRAME') normalizeAudience({type:'pdf'});
    if (msg.command === 'TRIGGER_LIVE_FADE' && msg.payload) normalizeAudience(msg.payload);
  });
})();

/* ===== Extracted inline script block ===== */

/* V50: PPTX Live View navigation and strict external-display presentation cleanup. */
(() => {
  const GS_TYPE = 'google-slides';
  const PDF_GHOST_SELECTORS = [
    '.v48-pdf-output-frame','.v48-pdf-live-frame','.v24-live-frame',
    '.v12-pdf-frame','.v19-pdf-stage','.v17-output-pdf-layer',
    '.v17-online-pdf-layer','.v23-live-pdf-nav','.v23-live-pdf-count',
    '.v49-live-slide-count','canvas[data-pdf-page]'
  ].join(',');
  const GS_GHOST_SELECTORS = [
    '.v47-gs-frame','.v46-gs-frame','.v45-pptx-frame','.v31-gs-layer',
    '.google-slides-stage','.drive-online-preview-frame','.v47-gs-count'
  ].join(',');

  function cloneV50(value) {
    try { return typeof clonePresenterPayload === 'function' ? clonePresenterPayload(value) : structuredClone(value); }
    catch (_) { return JSON.parse(JSON.stringify(value)); }
  }
  function isGsV50(payload) {
    return Boolean(payload && payload.type === GS_TYPE && payload.googleSlides && Array.isArray(payload.googleSlides.slides));
  }
  function gsSlidesV50(payload) { return Array.isArray(payload?.googleSlides?.slides) ? payload.googleSlides.slides : []; }
  function gsIndexV50(payload) {
    const slides = gsSlidesV50(payload);
    if (!slides.length) return 0;
    const id = String(payload?.googleSlides?.currentSlideId || '');
    const byId = id ? slides.findIndex(s => String(s.slideId || s.objectId || '') === id) : -1;
    return byId >= 0 ? byId : Math.max(0, Math.min(slides.length - 1, Number(payload?.page || 1) - 1));
  }
  function removeAll(root, selectors) {
    if (!root) return;
    root.querySelectorAll(selectors).forEach(node => node.remove());
  }

  function installLivePptxNav() {
    const live = document.getElementById('live-viewport');
    if (!live) return;
    let nav = live.querySelector('.v50-pptx-live-nav');
    if (!isGsV50(liveState)) {
      nav?.remove();
      return;
    }
    if (!nav) {
      nav = document.createElement('div');
      nav.className = 'v50-pptx-live-nav';
      nav.innerHTML = `
        <button class="v50-pptx-prev" type="button" title="Previous slide" aria-label="Previous slide"><span class="material-symbols-rounded">chevron_left</span></button>
        <button class="v50-pptx-next" type="button" title="Next slide" aria-label="Next slide"><span class="material-symbols-rounded">chevron_right</span></button>`;
      live.appendChild(nav);
      nav.querySelector('.v50-pptx-prev').addEventListener('click', () => window.v50NavigateLivePptx(-1));
      nav.querySelector('.v50-pptx-next').addEventListener('click', () => window.v50NavigateLivePptx(1));
    }
    const index = gsIndexV50(liveState);
    const total = gsSlidesV50(liveState).length;
    nav.querySelector('.v50-pptx-prev').disabled = index <= 0;
    nav.querySelector('.v50-pptx-next').disabled = !total || index >= total - 1;
    live.appendChild(nav);
  }

  window.v50NavigateLivePptx = async function(direction) {
    if (!isGsV50(liveState)) return;
    const slides = gsSlidesV50(liveState);
    const current = gsIndexV50(liveState);
    const next = Math.max(0, Math.min(slides.length - 1, current + Number(direction || 0)));
    if (next === current || !slides[next]) return;

    const updated = cloneV50(liveState);
    const slide = slides[next];
    updated.page = next + 1;
    updated.googleSlides.currentSlideId = String(slide.slideId || slide.objectId || '');
    updated.googleSlides.thumbnailUrl = String(slide.thumbnailUrl || '');
    liveState = updated;
    lastIncoming = cloneV50(updated);

    const live = document.getElementById('live-viewport');
    if (live) {
      live.dataset.v49Media = GS_TYPE;
      removeAll(live, PDF_GHOST_SELECTORS);
      await window.renderMediaIntoViewport(live, updated, {readOnly:true});
    }
    installLivePptxNav();

    // Slide navigation is intentionally a clean cut. This prevents a removed PDF
    // frame from becoming visible for one transition frame on the external screen.
    const message = {command:'TRIGGER_LIVE_FADE', payload:cloneV50(updated), transitionType:'cut', v50PptxSlideChange:true};
    channel.postMessage(message);
    try { if (displayWindow && !displayWindow.closed) displayWindow.postMessage(message, '*'); } catch (_) {}
  };

  const fireBeforeV50 = window.fireLive;
  window.fireLive = async function(...args) {
    const result = await fireBeforeV50.apply(this, args);
    installLivePptxNav();
    setTimeout(installLivePptxNav, 250);
    return result;
  };

  // Purge the opposite presentation before the existing async transition renderer
  // finishes building its next layer. This removes the one-frame PDF flash.
  function prepareAudienceFor(payload) {
    if (!document.body.classList.contains('live-window-mode')) return;
    const audience = document.getElementById('audience-view');
    if (!audience || !payload) return;
    const type = String(payload.type || '');
    audience.dataset.v50Media = type;
    if (type === GS_TYPE) removeAll(audience, PDF_GHOST_SELECTORS);
    else if (type === 'pdf') removeAll(audience, GS_GHOST_SELECTORS);
  }

  channel.addEventListener('message', event => {
    const msg = event.data || {};
    if (msg.command === 'TRIGGER_LIVE_FADE' && msg.payload) {
      prepareAudienceFor(msg.payload);
      setTimeout(() => prepareAudienceFor(msg.payload), 0);
      setTimeout(() => prepareAudienceFor(msg.payload), 180);
      setTimeout(() => prepareAudienceFor(msg.payload), 760);
    }
  });
  window.addEventListener('message', event => {
    const msg = event.data || {};
    if (msg.command === 'TRIGGER_LIVE_FADE' && msg.payload) {
      prepareAudienceFor(msg.payload);
      setTimeout(() => prepareAudienceFor(msg.payload), 180);
      setTimeout(() => prepareAudienceFor(msg.payload), 760);
    }
  });

  // Continue removing delayed legacy PDF nodes while PPTX is the active output.
  const audience = document.getElementById('audience-view');
  if (audience) {
    new MutationObserver(() => {
      if (audience.dataset.v50Media === GS_TYPE) removeAll(audience, PDF_GHOST_SELECTORS);
      if (audience.dataset.v50Media === 'pdf') removeAll(audience, GS_GHOST_SELECTORS);
    }).observe(audience, {childList:true, subtree:true});
  }

  const live = document.getElementById('live-viewport');
  if (live) {
    new MutationObserver(installLivePptxNav).observe(live, {childList:true, subtree:false});
  }
  installLivePptxNav();
})();

/* ===== Extracted inline script block ===== */

/* V51: cache and pre-decode Google Slides thumbnails so PPTX navigation stays smooth. */
(() => {
  const cache = new Map();
  const targetTokens = new WeakMap();

  function isDeck(payload){
    return Boolean(payload && payload.type === 'google-slides' && Array.isArray(payload?.googleSlides?.slides));
  }
  function slidesOf(payload){ return Array.isArray(payload?.googleSlides?.slides) ? payload.googleSlides.slides : []; }
  function indexOfSlide(payload){
    const slides = slidesOf(payload);
    if (!slides.length) return 0;
    const id = String(payload?.googleSlides?.currentSlideId || '');
    const found = id ? slides.findIndex(s => String(s.slideId || s.objectId || '') === id) : -1;
    return found >= 0 ? found : Math.max(0, Math.min(slides.length - 1, Number(payload?.page || 1) - 1));
  }
  function urlFor(payload, index = indexOfSlide(payload)){
    const slide = slidesOf(payload)[index];
    return String(slide?.thumbnailUrl || (index === indexOfSlide(payload) ? payload?.googleSlides?.thumbnailUrl : '') || '');
  }

  function cachedImage(url){
    if (!url) return Promise.reject(new Error('Missing PPTX thumbnail.'));
    if (cache.has(url)) return cache.get(url);
    const promise = new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.onload = async () => {
        try { if (typeof img.decode === 'function') await img.decode(); } catch (_) {}
        resolve(img);
      };
      img.onerror = () => { cache.delete(url); reject(new Error('PPTX thumbnail failed to load.')); };
      img.src = url;
      if (img.complete && img.naturalWidth > 0) resolve(img);
    });
    cache.set(url, promise);
    return promise;
  }

  function warmNearby(payload){
    const current = indexOfSlide(payload);
    const total = slidesOf(payload).length;
    [current - 1, current + 1, current + 2].forEach(i => {
      if (i >= 0 && i < total) cachedImage(urlFor(payload, i)).catch(() => {});
    });
  }

  function removeLegacyDeckLayers(target, keep){
    target.querySelectorAll('.v47-gs-frame,.v46-gs-frame,.v45-pptx-frame,.v31-gs-layer,.google-slides-stage,.drive-online-preview-frame').forEach(node => {
      if (node !== keep) node.remove();
    });
  }

  async function renderFast(target, payload){
    if (!target || !isDeck(payload)) return false;
    const token = (targetTokens.get(target) || 0) + 1;
    targetTokens.set(target, token);
    const source = await cachedImage(urlFor(payload));
    if (targetTokens.get(target) !== token) return true;

    let frame = target.querySelector(':scope > .v51-pptx-fast-frame');
    if (!frame) {
      frame = document.createElement('div');
      frame.className = 'v51-pptx-fast-frame';
      frame.innerHTML = '<img alt="Presentation slide"><div class="v51-pptx-fast-count"></div>';
      target.appendChild(frame);
    }

    const image = frame.querySelector('img');
    const count = frame.querySelector('.v51-pptx-fast-count');
    // Reuse the already decoded browser image instead of downloading it again.
    image.src = source.currentSrc || source.src;
    count.textContent = `Slide ${indexOfSlide(payload) + 1} / ${Math.max(1, slidesOf(payload).length)}`;

    removeLegacyDeckLayers(target, frame);
    const label = target.querySelector('.viewport-label');
    if (label) target.appendChild(label);
    target.querySelectorAll('.live-monitor-overlay,.v50-pptx-live-nav').forEach(node => target.appendChild(node));
    warmNearby(payload);
    return true;
  }

  const previousRender = window.renderMediaIntoViewport;
  window.renderMediaIntoViewport = async function(target, payload, options = {}){
    if (isDeck(payload)) return renderFast(target, payload);
    return previousRender(target, payload, options);
  };

  const previousAudienceLayer = window.buildAudienceMediaLayer;
  window.buildAudienceMediaLayer = async function(payload){
    if (!isDeck(payload)) return previousAudienceLayer(payload);
    const source = await cachedImage(urlFor(payload));
    const layer = document.createElement('div');
    layer.className = 'audience-media-layer v51-pptx-audience-layer';
    layer.style.zIndex = '20';
    const image = document.createElement('img');
    image.alt = 'Presentation slide';
    image.src = source.currentSrc || source.src;
    image.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;background:#000;';
    layer.appendChild(image);
    warmNearby(payload);
    return layer;
  };

  // Begin caching as soon as a PPTX is selected, not only after Go Live.
  document.addEventListener('click', event => {
    if (!event.target.closest('#slide-preview-grid .preview-slide-card')) return;
    setTimeout(() => { if (isDeck(staged)) warmNearby(staged); }, 0);
  }, true);

  // Warm the current live deck after Go Live and after navigation.
  const oldNavigate = window.v50NavigateLivePptx;
  if (typeof oldNavigate === 'function') {
    window.v50NavigateLivePptx = async function(direction){
      if (isDeck(liveState)) warmNearby(liveState);
      const result = await oldNavigate.call(this, direction);
      if (isDeck(liveState)) warmNearby(liveState);
      return result;
    };
  }

  if (isDeck(staged)) warmNearby(staged);
  if (isDeck(liveState)) warmNearby(liveState);
})();

/* ===== Extracted inline script block ===== */

/* V52: prevent the PPTX Live View navigation observer from creating an append loop.
   The older V50 observer calls appendChild(nav) after every child mutation. Re-appending
   the already-last navigation node creates another mutation and can lock the page after Go Live. */
(() => {
  if (window.__v52AppendLoopGuardInstalled) return;
  window.__v52AppendLoopGuardInstalled = true;

  const nativeAppendChild = Node.prototype.appendChild;
  Node.prototype.appendChild = function(child) {
    try {
      if (
        this && this.id === 'live-viewport' &&
        child && child.nodeType === 1 &&
        child.classList && child.classList.contains('v50-pptx-live-nav') &&
        child.parentNode === this &&
        this.lastElementChild === child
      ) {
        return child;
      }
    } catch (_) {}
    return nativeAppendChild.call(this, child);
  };

  // Keep toolbar/nav stacking correct without moving an element that is already last.
  window.v52PlacePptxNavLast = function() {
    const live = document.getElementById('live-viewport');
    const nav = live?.querySelector(':scope > .v50-pptx-live-nav');
    if (live && nav && live.lastElementChild !== nav) nativeAppendChild.call(live, nav);
  };

  // Avoid redundant duplicate Go Live clicks while the first async transition is running.
  const oldFireLive = window.fireLive;
  let goLiveBusy = false;
  if (typeof oldFireLive === 'function') {
    window.fireLive = async function(...args) {
      if (goLiveBusy) return;
      goLiveBusy = true;
      const button = document.getElementById('go-live-btn') || document.querySelector('[data-action="go-live"], .go-live-btn');
      if (button) button.disabled = true;
      try {
        return await oldFireLive.apply(this, args);
      } finally {
        goLiveBusy = false;
        if (button) button.disabled = false;
        requestAnimationFrame(() => window.v52PlacePptxNavLast?.());
      }
    };
  }
})();

/* ===== Extracted inline script block ===== */

/* V53: remove duplicated presentation layers/counters and replace unavailable icon-font glyphs. */
(() => {
  if (window.__v53PptxCleanupInstalled) return;
  window.__v53PptxCleanupInstalled = true;

  const OLD_COUNTERS = [
    '.v47-gs-count','.v49-live-slide-count','.v23-live-pdf-count',
    '.v24-live-count','.v19-pdf-count','.v17-pdf-count',
    '.slide-count','.slide-number','.presentation-slide-count'
  ].join(',');

  const OLD_PRESENTATION_LAYERS = [
    '.v47-gs-frame','.v46-gs-frame','.v45-pptx-frame','.v31-gs-layer',
    '.google-slides-stage','.drive-online-preview-frame',
    '.v48-pdf-output-frame','.v48-pdf-live-frame','.v24-live-frame',
    '.v12-pdf-frame','.v19-pdf-stage','.v17-output-pdf-layer',
    '.v17-online-pdf-layer'
  ].join(',');

  function useRealChevron(nav) {
    if (!nav) return;
    const prev = nav.querySelector('.v50-pptx-prev');
    const next = nav.querySelector('.v50-pptx-next');
    if (prev) {
      prev.innerHTML = '<span aria-hidden="true">‹</span>';
      prev.setAttribute('aria-label', 'Previous slide');
      prev.title = 'Previous slide';
    }
    if (next) {
      next.innerHTML = '<span aria-hidden="true">›</span>';
      next.setAttribute('aria-label', 'Next slide');
      next.title = 'Next slide';
    }
  }

  function cleanViewport(viewport) {
    if (!viewport) return;
    const active = viewport.querySelector(':scope > .v51-pptx-fast-frame');
    if (!active) return;

    viewport.querySelectorAll(OLD_PRESENTATION_LAYERS).forEach(node => {
      if (node !== active && !active.contains(node)) node.remove();
    });

    viewport.querySelectorAll(OLD_COUNTERS).forEach(node => {
      if (!active.contains(node)) node.remove();
    });

    // Remove accidental duplicate fast frames, preserving the newest one.
    const frames = [...viewport.querySelectorAll(':scope > .v51-pptx-fast-frame')];
    frames.slice(0, -1).forEach(node => node.remove());

    // Keep only one navigation overlay.
    const navs = [...viewport.querySelectorAll(':scope > .v50-pptx-live-nav')];
    navs.slice(0, -1).forEach(node => node.remove());
    useRealChevron(navs.at(-1));
  }

  function cleanAll() {
    cleanViewport(document.getElementById('preview-viewport'));
    cleanViewport(document.getElementById('live-viewport'));
  }

  const oldRender = window.renderMediaIntoViewport;
  if (typeof oldRender === 'function') {
    window.renderMediaIntoViewport = async function(target, payload, options = {}) {
      const result = await oldRender.call(this, target, payload, options);
      if (payload?.type === 'google-slides') {
        cleanViewport(target);
        requestAnimationFrame(() => cleanViewport(target));
      }
      return result;
    };
  }

  const live = document.getElementById('live-viewport');
  const preview = document.getElementById('preview-viewport');
  [live, preview].filter(Boolean).forEach(viewport => {
    let pending = false;
    new MutationObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        cleanViewport(viewport);
      });
    }).observe(viewport, { childList:true, subtree:false });
  });

  document.addEventListener('click', event => {
    if (event.target.closest('.v50-pptx-prev,.v50-pptx-next,#go-live-btn')) {
      setTimeout(cleanAll, 0);
      setTimeout(cleanAll, 120);
      setTimeout(cleanAll, 500);
    }
  }, true);

  cleanAll();
})();

/* ===== Extracted inline script block ===== */

/* V54: authoritative PPTX Preview slide synchronization.
   The page had several older slide-selection wrappers. One could restore page 1
   after the selected thumbnail had already updated the scene data. */
(() => {
  if (window.__v54PptxPreviewSyncInstalled) return;
  window.__v54PptxPreviewSyncInstalled = true;

  let previewSelectionToken = 0;

  function cloneValue(value) {
    try {
      return typeof clonePresenterPayload === 'function'
        ? clonePresenterPayload(value)
        : structuredClone(value);
    } catch (_) {
      return JSON.parse(JSON.stringify(value));
    }
  }

  function activeScene() {
    return typeof getActiveScene === 'function'
      ? getActiveScene()
      : (Array.isArray(scenes) ? scenes.find(scene => scene?.id === activeSceneId) : null);
  }

  function locateDeck(scene) {
    if (!scene || !Array.isArray(scene.items)) return null;
    let index = Number.isInteger(staged?.sceneItemIndex) ? staged.sceneItemIndex : -1;
    if (!scene.items[index] || scene.items[index].type !== 'google-slides') {
      index = scene.items.findIndex(item => item?.type === 'google-slides');
    }
    if (index < 0) return null;
    return { index, item: scene.items[index] };
  }

  function normalizeDeckToIndex(payload, index) {
    const slides = Array.isArray(payload?.googleSlides?.slides) ? payload.googleSlides.slides : [];
    if (!slides.length) return null;
    const safe = Math.max(0, Math.min(slides.length - 1, Number(index) || 0));
    const slide = slides[safe];
    const slideId = String(slide?.slideId || slide?.objectId || '');
    payload.page = safe + 1;
    payload.googleSlides.currentSlideId = slideId;
    payload.googleSlides.thumbnailUrl = String(slide?.thumbnailUrl || '');
    return { safe, slide };
  }

  async function selectPreviewSlide(index) {
    const token = ++previewSelectionToken;
    const scene = activeScene();
    const found = locateDeck(scene);
    if (!scene || !found?.item?.googleSlides) return;

    const normalized = normalizeDeckToIndex(found.item, index);
    if (!normalized) return;
    const { safe } = normalized;

    staged = {
      ...cloneValue(found.item),
      id: found.item.id,
      itemId: found.item.id,
      sceneId: scene.id,
      sceneItemIndex: found.index,
      type: 'google-slides',
      page: safe + 1,
      name: found.item.name || 'Presentation.pptx',
      googleSlides: cloneValue(found.item.googleSlides)
    };

    // Keep every index source aligned. Older renderers prioritize currentSlideId,
    // while others prioritize page, so both must always identify the same slide.
    normalizeDeckToIndex(staged, safe);

    try { if (typeof persistScenes === 'function') persistScenes(); } catch (_) {}

    document.querySelectorAll('#slide-preview-grid .preview-slide-card').forEach((card, i) => {
      card.classList.toggle('active', i === safe);
      card.setAttribute('aria-selected', i === safe ? 'true' : 'false');
    });

    const target = document.getElementById('preview-viewport');
    if (!target) return;
    target.dataset.v54Slide = String(safe);

    const payload = cloneValue(staged);
    normalizeDeckToIndex(payload, safe);
    await window.renderMediaIntoViewport(target, payload, {
      placeholderId: 'preview-placeholder',
      emptyText: 'No Media Queued'
    });

    if (token !== previewSelectionToken || target.dataset.v54Slide !== String(safe)) return;

    // A delayed legacy renderer may still finish after this render. Reassert only
    // when it actually changed the displayed counter away from the chosen slide.
    requestAnimationFrame(() => {
      if (token !== previewSelectionToken) return;
      const frame = target.querySelector(':scope > .v51-pptx-fast-frame');
      const count = frame?.querySelector('.v51-pptx-fast-count');
      if (count) count.textContent = `Slide ${safe + 1} / ${payload.googleSlides.slides.length}`;
    });
  }

  window.selectGoogleSlideForPreview = selectPreviewSlide;

  // Own thumbnail clicks before the chain of legacy onclick handlers can run.
  document.addEventListener('click', event => {
    const card = event.target.closest('#slide-preview-grid .preview-slide-card');
    if (!card) return;

    // V54 owns only Google Slides/PPTX thumbnail clicks. PDF cards already have
    // their own page-selection handler. Intercepting a PDF card here caused the
    // code to locate an older PPTX item in the scene and restore that deck into
    // Preview, leaving both Preview and Go Live stuck on the PPTX presentation.
    if (card.dataset.pdfPage || !card.dataset.googleSlideIndex) return;

    const cards = Array.from(document.querySelectorAll('#slide-preview-grid .preview-slide-card'));
    const index = cards.indexOf(card);
    if (index < 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    selectPreviewSlide(index);
  }, true);
})();

/* ===== Extracted inline script block ===== */

/* V55: authoritative PDF selection when returning from a PPTX scene.
   Older handlers could update the visible Preview without replacing `staged`, so Go Live
   still received the previous PPTX payload. PDF cards now rebuild `staged` from the active
   scene before rendering and before Go Live can run. */
(() => {
  if (window.__v55PdfAuthoritativeSelectionInstalled) return;
  window.__v55PdfAuthoritativeSelectionInstalled = true;

  let pdfSelectionToken = 0;

  function cloneValue(value) {
    try {
      return typeof clonePresenterPayload === 'function'
        ? clonePresenterPayload(value)
        : structuredClone(value);
    } catch (_) {
      return JSON.parse(JSON.stringify(value));
    }
  }

  function getScene() {
    try {
      if (typeof getActiveScene === 'function') return getActiveScene();
    } catch (_) {}
    return Array.isArray(window.scenes)
      ? window.scenes.find(scene => scene?.id === window.activeSceneId)
      : null;
  }

  function findPdfItem(scene) {
    if (!scene || !Array.isArray(scene.items)) return null;

    const currentIndex = Number.isInteger(window.staged?.sceneItemIndex)
      ? window.staged.sceneItemIndex
      : -1;
    if (scene.items[currentIndex]?.type === 'pdf') {
      return { index: currentIndex, item: scene.items[currentIndex] };
    }

    const index = scene.items.findIndex(item => item?.type === 'pdf');
    return index >= 0 ? { index, item: scene.items[index] } : null;
  }

  function removePreviousPresentationUi(target) {
    if (!target) return;
    target.querySelectorAll(
      ':scope > .v51-pptx-fast-frame,' +
      ':scope > .v50-pptx-live-nav,' +
      ':scope > .v47-gs-frame,' +
      ':scope > .v46-gs-frame,' +
      ':scope > .v45-pptx-frame,' +
      ':scope > .v31-gs-layer,' +
      ':scope > .google-slides-stage,' +
      ':scope > .drive-online-preview-frame'
    ).forEach(node => node.remove());
  }

  async function selectPdfPage(pageNumber) {
    const token = ++pdfSelectionToken;
    const scene = getScene();
    const found = findPdfItem(scene);
    if (!scene || !found?.item) return false;

    const total = Number(found.item.totalPages || found.item.pdfPageCount || 0);
    let page = Math.max(1, Number(pageNumber) || 1);
    if (total) page = Math.min(page, total);

    found.item.page = page;

    window.staged = {
      ...cloneValue(found.item),
      id: found.item.id,
      itemId: found.item.itemId || found.item.id,
      sceneId: scene.id,
      sceneItemIndex: found.index,
      type: 'pdf',
      page,
      totalPages: total || Number(found.item.totalPages || 0)
    };

    try { if (typeof persistScenes === 'function') persistScenes(); } catch (_) {}
    try { if (typeof setSlideStatus === 'function') setSlideStatus(); } catch (_) {}

    document.querySelectorAll('#slide-preview-grid .preview-slide-card').forEach(card => {
      const cardPage = Number(card.dataset.pdfPage || 0);
      const active = cardPage === page;
      card.classList.toggle('active', active);
      card.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    const preview = document.getElementById('preview-viewport');
    removePreviousPresentationUi(preview);

    const payload = cloneValue(window.staged);
    if (typeof window.renderMediaIntoViewport === 'function' && preview) {
      await window.renderMediaIntoViewport(preview, payload, {
        placeholderId: 'preview-placeholder',
        emptyText: 'No Media Queued'
      });
    } else if (typeof window.renderPreview === 'function') {
      await window.renderPreview();
    }

    if (token !== pdfSelectionToken) return false;
    try { if (typeof updateSlidePreviewActiveState === 'function') updateSlidePreviewActiveState(); } catch (_) {}
    try { if (typeof updateEmbeddedSlideActiveState === 'function') updateEmbeddedSlideActiveState(); } catch (_) {}
    return true;
  }

  window.v55SelectPdfPage = selectPdfPage;

  // Capture PDF thumbnail clicks before any legacy PPTX/PDF handler can restore stale state.
  document.addEventListener('click', event => {
    const card = event.target.closest('#slide-preview-grid .preview-slide-card[data-pdf-page]');
    if (!card) return;

    const page = Number(card.dataset.pdfPage || 1);
    event.preventDefault();
    event.stopImmediatePropagation();
    selectPdfPage(page).catch(error => console.error('V55 PDF selection failed:', error));
  }, true);

  // Immediately before Go Live, verify that a visible selected PDF card and `staged`
  // identify the same PDF page. This fixes returning to a PDF after presenting a PPTX.
  document.addEventListener('click', event => {
    const button = event.target.closest('#go-live-btn,[data-action="go-live"],.go-live-btn');
    if (!button) return;

    const selectedPdf = document.querySelector(
      '#slide-preview-grid .preview-slide-card[data-pdf-page].active,' +
      '#slide-preview-grid .preview-slide-card[data-pdf-page][aria-selected="true"]'
    );
    if (!selectedPdf) return;

    const page = Number(selectedPdf.dataset.pdfPage || 1);
    if (window.staged?.type === 'pdf' && Number(window.staged.page || 1) === page) {
      removePreviousPresentationUi(document.getElementById('live-viewport'));
      return;
    }

    // Cancel this click, repair the authoritative state, then invoke Go Live exactly once.
    event.preventDefault();
    event.stopImmediatePropagation();
    selectPdfPage(page).then(ok => {
      if (!ok) return;
      removePreviousPresentationUi(document.getElementById('live-viewport'));
      requestAnimationFrame(() => {
        if (typeof window.fireLive === 'function') window.fireLive();
      });
    }).catch(error => console.error('V55 PDF Go Live repair failed:', error));
  }, true);
})();

/* ===== Extracted inline script block ===== */

/* V56: one authoritative presentation layer and one control set in Live View. */
(() => {
  if (window.__v56SinglePresentationLayerInstalled) return;
  window.__v56SinglePresentationLayerInstalled = true;

  const liveViewport = () => document.getElementById('live-viewport');
  const clone = value => {
    try { return typeof clonePresenterPayload === 'function' ? clonePresenterPayload(value) : structuredClone(value); }
    catch (_) { return JSON.parse(JSON.stringify(value)); }
  };

  const artifactSelector = [
    '.v50-pptx-live-nav','.v23-live-pdf-nav','.v49-live-slide-count','.v47-gs-count',
    '.v23-live-pdf-count','.v24-live-count','.v19-pdf-count','.v17-pdf-count',
    '.slide-count','.slide-number','.presentation-slide-count',
    '.v47-gs-frame','.v46-gs-frame','.v45-pptx-frame','.v31-gs-layer',
    '.google-slides-stage','.drive-online-preview-frame',
    '.v48-pdf-output-frame','.v48-pdf-live-frame','.v24-live-frame',
    '.v12-pdf-frame','.v19-pdf-stage','.v17-output-pdf-layer','.v17-online-pdf-layer'
  ].join(',');

  function getTotal(payload) {
    if (payload?.type === 'google-slides') return payload.googleSlides?.slides?.length || 0;
    if (payload?.type === 'pdf') return Number(payload.totalPages || payload.pdfPageCount || 0);
    return 0;
  }

  function cleanup(viewport, keepFastFrame = true) {
    if (!viewport) return;
    viewport.querySelectorAll(artifactSelector).forEach(node => node.remove());

    const fastFrames = [...viewport.querySelectorAll(':scope > .v51-pptx-fast-frame')];
    if (keepFastFrame && fastFrames.length) fastFrames.slice(0, -1).forEach(node => node.remove());
    else fastFrames.forEach(node => node.remove());

    const customNavs = [...viewport.querySelectorAll(':scope > .v56-live-nav')];
    customNavs.slice(0, -1).forEach(node => node.remove());
    const customCounts = [...viewport.querySelectorAll(':scope > .v56-live-count')];
    customCounts.slice(0, -1).forEach(node => node.remove());
  }

  function installCanonicalControls(payload) {
    const viewport = liveViewport();
    if (!viewport || !['pdf','google-slides'].includes(payload?.type)) return;

    viewport.querySelectorAll(':scope > .v56-live-nav,:scope > .v56-live-count').forEach(n => n.remove());
    const total = getTotal(payload);
    const page = Math.max(1, Number(payload.page || 1));

    const nav = document.createElement('div');
    nav.className = 'v56-live-nav';
    nav.innerHTML = '<button class="prev" type="button" aria-label="Previous slide">‹</button><button class="next" type="button" aria-label="Next slide">›</button>';
    const prev = nav.querySelector('.prev');
    const next = nav.querySelector('.next');
    prev.disabled = page <= 1;
    next.disabled = !!total && page >= total;

    const count = document.createElement('div');
    count.className = 'v56-live-count';
    count.textContent = total ? `Slide ${page} / ${total}` : `Slide ${page}`;

    const navigate = async delta => {
      const nextPage = Math.max(1, total ? Math.min(total, page + delta) : page + delta);
      if (nextPage === page) return;
      const updated = clone(payload);
      updated.page = nextPage;
      if (updated.type === 'google-slides' && updated.googleSlides?.slides?.length) {
        const slide = updated.googleSlides.slides[nextPage - 1];
        updated.googleSlides.currentSlideId = slide?.slideId || slide?.objectId || '';
        updated.googleSlides.thumbnailUrl = slide?.thumbnailUrl || '';
      }
      window.live = clone(updated);
      cleanup(viewport, false);
      await window.renderMediaIntoViewport(viewport, updated, { placeholderId:'live-placeholder', emptyText:'Nothing Live' });
      cleanup(viewport, true);
      installCanonicalControls(updated);
    };
    prev.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); navigate(-1); });
    next.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); navigate(1); });

    viewport.append(nav, count);
  }

  async function ensureRendered(payload) {
    const viewport = liveViewport();
    if (!viewport || !['pdf','google-slides'].includes(payload?.type)) return;
    cleanup(viewport, true);

    const hasPresentation = !!viewport.querySelector(':scope > .v51-pptx-fast-frame, :scope > .v48-pdf-live-frame, :scope > canvas, :scope > img');
    if (!hasPresentation && typeof window.renderMediaIntoViewport === 'function') {
      await window.renderMediaIntoViewport(viewport, clone(payload), { placeholderId:'live-placeholder', emptyText:'Nothing Live' });
    }
    cleanup(viewport, true);
    installCanonicalControls(payload);
  }

  const previousFireLive = window.fireLive;
  if (typeof previousFireLive === 'function') {
    window.fireLive = async function(...args) {
      const payload = clone(window.staged || {});
      const viewport = liveViewport();
      if (['pdf','google-slides'].includes(payload.type)) cleanup(viewport, false);
      const result = await previousFireLive.apply(this, args);
      if (['pdf','google-slides'].includes(payload.type)) {
        window.live = clone(payload);
        await ensureRendered(payload);
        requestAnimationFrame(() => ensureRendered(payload));
        setTimeout(() => ensureRendered(payload), 140);
      }
      return result;
    };
  }

  const viewport = liveViewport();
  if (viewport) {
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const payload = window.live;
        if (['pdf','google-slides'].includes(payload?.type)) cleanup(viewport, true);
      });
    }).observe(viewport, { childList:true, subtree:false });
  }
})();

/* ===== Extracted inline script block ===== */

/* V57: Preview follows the selected scene; Live changes only on Go Live.
   Leaving a scene resets that scene's presentation selection to slide/page 1.
   Live View uses one canonical frame, so PDF/PPTX renderers cannot overlap. */
(() => {
  if (window.__v57AuthoritativePreviewLiveInstalled) return;
  window.__v57AuthoritativePreviewLiveInstalled = true;

  const PRESENTATION_TYPES = new Set(['pdf','google-slides']);
  let sceneSwitchSerial = 0;
  let liveRenderSerial = 0;

  const clone = value => {
    try { return typeof clonePresenterPayload === 'function' ? clonePresenterPayload(value) : structuredClone(value); }
    catch (_) { return JSON.parse(JSON.stringify(value || {})); }
  };

  function currentScene() {
    try { return typeof getActiveScene === 'function' ? getActiveScene() : null; }
    catch (_) { return null; }
  }

  function resetPresentationItem(item) {
    if (!item || !PRESENTATION_TYPES.has(item.type)) return;
    item.page = 1;
    if (item.type === 'google-slides' && item.googleSlides?.slides?.length) {
      const first = item.googleSlides.slides[0];
      item.googleSlides.currentSlideId = first?.slideId || first?.objectId || '';
      item.googleSlides.thumbnailUrl = first?.thumbnailUrl || '';
    }
  }

  function wipePresentationArtifacts(viewport) {
    if (!viewport) return;
    viewport.querySelectorAll('*').forEach(node => {
      if (node.id === 'live-placeholder' || node.id === 'preview-placeholder') return;
      node.remove();
    });
  }

  function visibleMedia(root) {
    if (!root) return null;
    const candidates = [...root.querySelectorAll('canvas,img')].reverse();
    return candidates.find(el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 10 && r.height > 10 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
    }) || null;
  }

  function cloneVisual(source) {
    if (!source) return null;
    if (source.tagName === 'CANVAS') {
      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const ctx = canvas.getContext('2d');
      try { ctx.drawImage(source, 0, 0); } catch (_) { return null; }
      return canvas;
    }
    const img = document.createElement('img');
    img.src = source.currentSrc || source.src || '';
    img.alt = source.alt || 'Presentation slide';
    return img.src ? img : null;
  }

  function totalSlides(payload) {
    if (payload?.type === 'google-slides') return Number(payload.googleSlides?.slides?.length || 0);
    if (payload?.type === 'pdf') return Number(payload.totalPages || payload.pdfPageCount || 0);
    return 0;
  }

  function normalizePage(payload, page) {
    const total = totalSlides(payload);
    const next = Math.max(1, Number(page || 1));
    return total ? Math.min(total, next) : next;
  }

  function applyPage(payload, page) {
    payload.page = normalizePage(payload, page);
    if (payload.type === 'google-slides' && payload.googleSlides?.slides?.length) {
      const slide = payload.googleSlides.slides[payload.page - 1];
      payload.googleSlides.currentSlideId = slide?.slideId || slide?.objectId || '';
      payload.googleSlides.thumbnailUrl = slide?.thumbnailUrl || '';
    }
    return payload;
  }

  function mountCanonicalLive(payload, visual) {
    const viewport = document.getElementById('live-viewport');
    if (!viewport || !visual) return false;
    wipePresentationArtifacts(viewport);

    const frame = document.createElement('div');
    frame.className = 'v57-live-frame';
    frame.appendChild(visual);
    viewport.appendChild(frame);

    const total = totalSlides(payload);
    const page = normalizePage(payload, payload.page);
    const nav = document.createElement('div');
    nav.className = 'v57-live-nav';
    nav.innerHTML = '<button class="prev" type="button" aria-label="Previous slide">‹</button><button class="next" type="button" aria-label="Next slide">›</button>';
    nav.querySelector('.prev').disabled = page <= 1;
    nav.querySelector('.next').disabled = !!total && page >= total;
    nav.querySelector('.prev').onclick = e => { e.preventDefault(); e.stopPropagation(); navigateLive(-1); };
    nav.querySelector('.next').onclick = e => { e.preventDefault(); e.stopPropagation(); navigateLive(1); };

    const count = document.createElement('div');
    count.className = 'v57-live-count';
    count.textContent = total ? `Slide ${page} / ${total}` : `Slide ${page}`;
    viewport.append(nav, count);
    return true;
  }

  async function renderDetached(payload) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:-100000px;top:-100000px;width:1280px;height:720px;overflow:hidden;background:#000;pointer-events:none;';
    document.body.appendChild(host);
    try {
      await window.renderMediaIntoViewport(host, clone(payload), { emptyText:'', placeholderId:'' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return cloneVisual(visibleMedia(host));
    } finally {
      host.remove();
    }
  }

  async function navigateLive(delta) {
    if (!PRESENTATION_TYPES.has(window.live?.type)) return;
    const serial = ++liveRenderSerial;
    const payload = applyPage(clone(window.live), Number(window.live.page || 1) + delta);
    if (payload.page === Number(window.live.page || 1)) return;
    const visual = await renderDetached(payload);
    if (serial !== liveRenderSerial || !visual) return;
    window.live = clone(payload);
    try { liveState = clone(payload); } catch (_) {}
    mountCanonicalLive(payload, visual);
    try {
      if (typeof channel !== 'undefined') {
        channel.postMessage({ command:'TRIGGER_LIVE_FADE', payload:clone(payload), transitionType:'cut' });
      }
    } catch (_) {}
  }

  // Scene selection: reset the newly selected scene to its first item/first slide,
  // update Preview only, and deliberately leave Live View untouched.
  document.addEventListener('click', event => {
    const row = event.target.closest('#scene-list .scene-item');
    if (!row) return;
    const serial = ++sceneSwitchSerial;
    const index = [...document.querySelectorAll('#scene-list .scene-item')].indexOf(row);
    const targetScene = Array.isArray(window.scenes || scenes) ? (window.scenes || scenes)[index] : null;
    if (!targetScene) return;

    setTimeout(async () => {
      if (serial !== sceneSwitchSerial || activeSceneId !== targetScene.id) return;
      const deck = targetScene.items || [];
      deck.forEach(resetPresentationItem);

      if (!deck.length) {
        window.staged = staged = { type:'none', value:null, sceneItemIndex:-1, page:1, videoTime:0, videoPlaying:false, sceneId:targetScene.id };
        if (typeof window.renderPreview === 'function') await window.renderPreview();
      } else {
        if (typeof window.setStagedFromSceneIndex === 'function') window.setStagedFromSceneIndex(0);
        if (staged) {
          staged.sceneId = targetScene.id;
          staged.page = 1;
          if (staged.type === 'google-slides' && staged.googleSlides?.slides?.length) {
            const first = staged.googleSlides.slides[0];
            staged.googleSlides.currentSlideId = first?.slideId || first?.objectId || '';
            staged.googleSlides.thumbnailUrl = first?.thumbnailUrl || '';
          }
        }
        if (typeof window.renderPreview === 'function') await window.renderPreview();
      }
      try { if (typeof populateSlidePreviewGrid === 'function') populateSlidePreviewGrid(); } catch (_) {}
      try { if (typeof renderSceneDeckUI === 'function') renderSceneDeckUI(); } catch (_) {}
      try { if (typeof persistScenes === 'function') persistScenes(); } catch (_) {}
    }, 0);
  }, true);

  const legacyFireLive = window.fireLive;
  window.fireLive = async function(...args) {
    const payload = clone(window.staged || staged || {});
    if (!PRESENTATION_TYPES.has(payload.type)) {
      return typeof legacyFireLive === 'function' ? legacyFireLive.apply(this, args) : undefined;
    }

    if (typeof isFTBActive !== 'undefined' && (isFTBActive || isFTGActive)) {
      try { showModal('Live View Is Covered', 'Turn off Fade To Black or Fade To Background before sending a new preview live.', false); } catch (_) {}
      return;
    }

    const serial = ++liveRenderSerial;
    const preview = document.getElementById('preview-viewport');
    let visual = cloneVisual(visibleMedia(preview));
    if (!visual) visual = await renderDetached(payload);
    if (serial !== liveRenderSerial || !visual) return;

    window.live = clone(payload);
    try { liveState = clone(payload); } catch (_) {}
    mountCanonicalLive(payload, visual);

    const transitionType = document.getElementById('transition-type-select')?.value || 'cut';
    try {
      if (typeof channel !== 'undefined') {
        channel.postMessage({ command:'TRIGGER_LIVE_FADE', payload:clone(payload), transitionType });
      }
    } catch (error) { console.warn('V57 display update failed:', error); }
  };

  // Prevent delayed legacy mutations from adding a second presentation layer.
  const liveViewport = document.getElementById('live-viewport');
  if (liveViewport) {
    let cleaning = false;
    new MutationObserver(() => {
      if (cleaning || !PRESENTATION_TYPES.has(window.live?.type)) return;
      const canonical = liveViewport.querySelector(':scope > .v57-live-frame');
      if (!canonical) return;
      cleaning = true;
      [...liveViewport.children].forEach(child => {
        if (!child.classList?.contains('v57-live-frame') && !child.classList?.contains('v57-live-nav') && !child.classList?.contains('v57-live-count')) child.remove();
      });
      [...liveViewport.querySelectorAll(':scope > .v57-live-frame')].slice(1).forEach(n => n.remove());
      [...liveViewport.querySelectorAll(':scope > .v57-live-nav')].slice(1).forEach(n => n.remove());
      [...liveViewport.querySelectorAll(':scope > .v57-live-count')].slice(1).forEach(n => n.remove());
      cleaning = false;
    }).observe(liveViewport, { childList:true });
  }
})();

/* ===== Extracted inline script block ===== */

/* V58 FINAL: Preview is independent. Go Live is the only Preview -> Live commit.
   PDF/PPTX display uses a single pre-rendered frame, preventing iframe/PDF worker overlap. */
(() => {
  const TYPES = new Set(['pdf','google-slides']);
  const OUTPUT_COMMAND = 'V58_PRESENTATION_FRAME';
  let commitSerial = 0;
  let livePayloadV58 = null;
  let liveFrameV58 = '';

  const copy = value => {
    try { return typeof clonePresenterPayload === 'function' ? clonePresenterPayload(value) : structuredClone(value); }
    catch (_) { try { return JSON.parse(JSON.stringify(value || {})); } catch (_) { return value; } }
  };

  function isPresentation(value){ return Boolean(value && TYPES.has(value.type)); }
  function slides(value){ return Array.isArray(value?.googleSlides?.slides) ? value.googleSlides.slides : []; }
  function total(value){
    if(value?.type === 'google-slides') return slides(value).length;
    return Number(value?.totalPages || value?.pdfPageCount || 0);
  }
  function normalizePage(value,page){
    const count=total(value); const p=Math.max(1,Number(page||1)); return count?Math.min(count,p):p;
  }
  function applyPage(value,page){
    value.page=normalizePage(value,page);
    if(value.type==='google-slides' && slides(value).length){
      const slide=slides(value)[value.page-1];
      value.googleSlides.currentSlideId=String(slide?.slideId||slide?.objectId||'');
      value.googleSlides.thumbnailUrl=String(slide?.thumbnailUrl||'');
    }
    return value;
  }
  function pptxFrame(value){
    const list=slides(value); if(!list.length)return '';
    const id=String(value?.googleSlides?.currentSlideId||'');
    let index=id?list.findIndex(s=>String(s.slideId||s.objectId||'')===id):-1;
    if(index<0)index=Math.max(0,Math.min(list.length-1,Number(value.page||1)-1));
    return String(list[index]?.thumbnailUrl||value.googleSlides?.thumbnailUrl||'');
  }
  function visiblePreviewCanvas(){
    const root=document.getElementById('preview-viewport'); if(!root)return null;
    return [...root.querySelectorAll('canvas')].reverse().find(c=>c.width>10&&c.height>10&&c.getBoundingClientRect().width>10)||null;
  }
  async function waitPreviewCanvas(timeout=5000){
    const start=performance.now();
    while(performance.now()-start<timeout){
      const canvas=visiblePreviewCanvas(); if(canvas)return canvas;
      await new Promise(r=>setTimeout(r,35));
    }
    return null;
  }
  async function frameFor(value, preferPreview=false){
    if(value.type==='google-slides') return pptxFrame(value);
    if(value.type!=='pdf')return '';
    if(preferPreview){
      const canvas=await waitPreviewCanvas();
      if(canvas){try{return canvas.toDataURL('image/jpeg',.92)}catch(_){}}
    }
    const host=document.createElement('div');
    host.style.cssText='position:fixed;left:-100000px;top:-100000px;width:1280px;height:720px;background:#000;overflow:hidden;';
    document.body.appendChild(host);
    try{
      await window.renderMediaIntoViewport(host,copy(value),{readOnly:true,placeholderId:'',emptyText:''});
      const canvas=[...host.querySelectorAll('canvas')].reverse().find(c=>c.width>10&&c.height>10);
      if(!canvas)return '';
      try{return canvas.toDataURL('image/jpeg',.92)}catch(_){return canvas.toDataURL('image/png')}
    }finally{host.remove()}
  }
  function cleanPresentationLayers(root){
    if(!root)return;
    [...root.children].forEach(node=>{
      if(node.classList?.contains('viewport-label')||node.classList?.contains('live-monitor-overlay'))return;
      node.remove();
    });
  }
  function mountLive(value,src){
    const root=document.getElementById('live-viewport'); if(!root||!src)return;
    cleanPresentationLayers(root);
    const frame=document.createElement('div'); frame.className='v58-presentation-frame';
    const image=document.createElement('img'); image.src=src; image.alt=value.name||'Presentation slide';
    frame.appendChild(image); root.appendChild(frame);
    const count=total(value),page=normalizePage(value,value.page);
    const nav=document.createElement('div');nav.className='v58-presentation-nav';
    const prev=document.createElement('button');prev.type='button';prev.innerHTML='&#8249;';prev.setAttribute('aria-label','Previous slide');prev.disabled=page<=1;
    const next=document.createElement('button');next.type='button';next.innerHTML='&#8250;';next.setAttribute('aria-label','Next slide');next.disabled=!!count&&page>=count;
    prev.onclick=e=>{e.stopPropagation();navigateLiveV58(-1)};next.onclick=e=>{e.stopPropagation();navigateLiveV58(1)};
    nav.append(prev,next);root.appendChild(nav);
    const label=document.createElement('div');label.className='v58-presentation-count';label.textContent=count?`Slide ${page} / ${count}`:`Slide ${page}`;root.appendChild(label);
    if(typeof updateLiveMonitorOverlays==='function')updateLiveMonitorOverlays();
  }
  function mountOutput(message){
    if(!document.body.classList.contains('live-window-mode')||!message?.src)return;
    const root=document.getElementById('audience-view');if(!root)return;
    const bg=document.getElementById('audience-bg-layer');
    [...root.children].forEach(node=>{if(node!==bg)node.remove()});
    if(bg&&!bg.parentNode)root.appendChild(bg);
    const frame=document.createElement('div');frame.className='v58-presentation-frame';
    const image=document.createElement('img');image.src=message.src;image.alt=message.payload?.name||'Presentation slide';frame.appendChild(image);root.appendChild(frame);
  }
  function sendOutput(value,src,transitionType='cut'){
    const message={command:OUTPUT_COMMAND,payload:copy(value),src,transitionType};
    try{channel.postMessage(message)}catch(_){}
    try{if(displayWindow&&!displayWindow.closed)displayWindow.postMessage(message,'*')}catch(_){}
  }
  async function navigateLiveV58(delta){
    if(!isPresentation(livePayloadV58))return;
    const before=Number(livePayloadV58.page||1);
    const next=applyPage(copy(livePayloadV58),before+Number(delta||0));
    if(Number(next.page)===before)return;
    const serial=++commitSerial;const src=await frameFor(next,false);
    if(serial!==commitSerial||!src)return;
    livePayloadV58=copy(next);liveFrameV58=src;
    try{liveState=copy(next);lastIncoming=copy(next)}catch(_){}
    mountLive(next,src);sendOutput(next,src,'cut');
  }
  window.navigateLiveV58=navigateLiveV58;

  channel.addEventListener('message',event=>mountOutput(event.data));
  window.addEventListener('message',event=>mountOutput(event.data));

  // Neutralize legacy presentation page auto-commit: Preview changes remain Preview only.
  window.v23NavigateLivePdf = navigateLiveV58;

  const oldFire=window.fireLive;
  window.fireLive=async function(...args){
    const value=copy(window.staged||staged||{});
    if(!isPresentation(value))return typeof oldFire==='function'?oldFire.apply(this,args):undefined;
    if(typeof isFTBActive!=='undefined'&&(isFTBActive||isFTGActive)){
      try{showModal('Live View Is Covered','Turn off Fade To Black or Fade To Background before sending a new preview live.',false)}catch(_){}
      return;
    }
    const serial=++commitSerial;
    const src=await frameFor(value,true);
    if(serial!==commitSerial||!src){
      try{showModal('Presentation Not Ready','Wait until the selected slide appears in Preview, then click Go Live again.',false)}catch(_){}
      return;
    }
    livePayloadV58=copy(value);liveFrameV58=src;
    try{liveState=copy(value);lastIncoming=copy(value)}catch(_){}
    mountLive(value,src);
    sendOutput(value,src,document.getElementById('transition-type-select')?.value||'fade');
  };

  // Scene changes reset only Preview to the scene's first asset/first page. Live is untouched.
  document.addEventListener('click',event=>{
    const row=event.target.closest('#scene-list .scene-item');if(!row)return;
    setTimeout(async()=>{
      const scene=typeof getActiveScene==='function'?getActiveScene():null;if(!scene)return;
      const deck=scene.items||[];
      deck.forEach(item=>{
        if(!isPresentation(item))return;
        applyPage(item,1);
      });
      if(deck.length){
        window.setStagedFromSceneIndex?.(0);
        if(staged){staged.sceneId=scene.id;applyPage(staged,1)}
      }else{
        staged={type:'none',value:null,sceneItemIndex:-1,page:1,sceneId:scene.id,videoTime:0,videoPlaying:false};
      }
      try{persistScenes()}catch(_){}
      await window.renderPreview?.();
      try{populateSlidePreviewGrid()}catch(_){}
    },0);
  },true);

  // New display window receives exactly the retained live frame, never current Preview.
  channel.addEventListener('message',event=>{
    const msg=event.data||{};
    if(msg.command!=='REQUEST_CURRENT_OUTPUT'||document.body.classList.contains('live-window-mode'))return;
    if(isPresentation(livePayloadV58)&&liveFrameV58)sendOutput(livePayloadV58,liveFrameV58,'cut');
  });
})();

/* ===== Extracted inline script block ===== */

/* V59: PDF thumbnail double-click must never enter legacy live/render handlers.
   Select/render the requested page in Preview first, then perform one V58 Go Live commit. */
(() => {
  let doubleClickToken = 0;

  const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  async function commitPdfCard(card) {
    const token = ++doubleClickToken;
    const page = Math.max(1, Number(card?.dataset?.pdfPage || 1));

    try {
      if (typeof window.v55SelectPdfPage === 'function') {
        const selected = await window.v55SelectPdfPage(page);
        if (selected === false || token !== doubleClickToken) return;
      } else {
        const payload = window.staged || (typeof staged !== 'undefined' ? staged : null);
        if (!payload || payload.type !== 'pdf') return;
        payload.page = page;
        if (typeof window.renderPreview === 'function') await window.renderPreview();
      }

      await nextFrame();
      if (token !== doubleClickToken) return;

      const preview = document.getElementById('preview-viewport');
      const canvas = preview && [...preview.querySelectorAll('canvas')]
        .reverse()
        .find(node => node.width > 10 && node.height > 10 && node.getBoundingClientRect().width > 10);

      if (!canvas) {
        try {
          if (typeof showModal === 'function') {
            showModal('Presentation Not Ready', 'The PDF page is still loading in Preview. Please double-click it again after it appears.', false);
          }
        } catch (_) {}
        return;
      }

      if (typeof window.fireLive === 'function') await window.fireLive();
    } catch (error) {
      console.error('V59 PDF double-click commit failed:', error);
    }
  }

  // Capture phase blocks every older PDF/PPTX double-click handler below this patch.
  document.addEventListener('dblclick', event => {
    const card = event.target.closest('#slide-preview-grid .preview-slide-card[data-pdf-page]');
    if (!card) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    commitPdfCard(card);
  }, true);
})();

/* ===== Extracted inline script block ===== */

/* V60: When switching from PDF to PPTX, commit the PPTX frame already visible in Preview.
   Do not depend on stale PDF state or a delayed thumbnail readiness flag. */
(() => {
  const previousFireLive = window.fireLive;

  function cloneValue(value) {
    try {
      return typeof clonePresenterPayload === 'function'
        ? clonePresenterPayload(value)
        : structuredClone(value);
    } catch (_) {
      try { return JSON.parse(JSON.stringify(value || {})); }
      catch (_) { return value; }
    }
  }

  function activeSceneValue() {
    try {
      if (typeof getActiveScene === 'function') return getActiveScene();
    } catch (_) {}
    try {
      return Array.isArray(scenes) ? scenes.find(scene => scene?.id === activeSceneId) : null;
    } catch (_) { return null; }
  }

  function visiblePptxImage() {
    const preview = document.getElementById('preview-viewport');
    if (!preview) return null;
    const images = [...preview.querySelectorAll('img')].reverse();
    return images.find(img => {
      const rect = img.getBoundingClientRect();
      const src = String(img.currentSrc || img.src || '');
      return src && img.complete && img.naturalWidth > 10 && img.naturalHeight > 10 && rect.width > 10 && rect.height > 10;
    }) || null;
  }

  function selectedPptxPage(preview, item) {
    const selected = document.querySelector('#slide-preview-grid .preview-slide-card.active[data-google-slide-index], #slide-preview-grid .preview-slide-card[aria-selected="true"][data-google-slide-index]');
    if (selected) {
      const raw = Number(selected.dataset.googleSlideIndex);
      if (Number.isFinite(raw)) return raw + 1;
    }
    const datasetIndex = Number(preview?.dataset?.v54Slide);
    if (Number.isFinite(datasetIndex)) return datasetIndex + 1;
    const count = preview?.querySelector('.v51-pptx-fast-count')?.textContent || '';
    const match = count.match(/(?:Slide\s*)?(\d+)\s*\//i);
    if (match) return Math.max(1, Number(match[1]) || 1);
    return Math.max(1, Number(staged?.page || item?.page || 1));
  }

  function buildVisiblePptxPayload() {
    const preview = document.getElementById('preview-viewport');
    const scene = activeSceneValue();
    if (!preview || !scene || !Array.isArray(scene.items)) return null;

    let index = Number.isInteger(staged?.sceneItemIndex) ? staged.sceneItemIndex : -1;
    if (scene.items[index]?.type !== 'google-slides') {
      index = scene.items.findIndex(item => item?.type === 'google-slides');
    }
    if (index < 0) return null;

    const item = scene.items[index];
    const list = Array.isArray(item?.googleSlides?.slides) ? item.googleSlides.slides : [];
    if (!list.length) return null;

    const page = Math.max(1, Math.min(list.length, selectedPptxPage(preview, item)));
    const slide = list[page - 1] || {};
    const image = visiblePptxImage();
    const visibleSrc = String(image?.currentSrc || image?.src || '');
    const src = visibleSrc || String(slide.thumbnailUrl || item.googleSlides?.thumbnailUrl || '');
    if (!src) return null;

    const payload = cloneValue(item);
    payload.type = 'google-slides';
    payload.sceneId = scene.id;
    payload.sceneItemIndex = index;
    payload.itemId = item.id;
    payload.page = page;
    payload.name = item.name || 'Presentation.pptx';
    payload.googleSlides = cloneValue(item.googleSlides || {});
    payload.googleSlides.currentSlideId = String(slide.slideId || slide.objectId || '');
    payload.googleSlides.thumbnailUrl = src;

    return { payload, src };
  }

  async function commitVisiblePptx() {
    const resolved = buildVisiblePptxPayload();
    if (!resolved) return false;

    const { payload, src } = resolved;
    try {
      staged = cloneValue(payload);
      const scene = activeSceneValue();
      if (scene?.items?.[payload.sceneItemIndex]) {
        scene.items[payload.sceneItemIndex].page = payload.page;
        scene.items[payload.sceneItemIndex].googleSlides.currentSlideId = payload.googleSlides.currentSlideId;
        scene.items[payload.sceneItemIndex].googleSlides.thumbnailUrl = src;
      }
      if (typeof persistScenes === 'function') persistScenes();
    } catch (_) {}

    // V58 reads the thumbnail URL from staged. It now receives the exact visible Preview frame.
    await previousFireLive.call(window);
    return true;
  }

  window.fireLive = async function(...args) {
    const preview = document.getElementById('preview-viewport');
    const hasVisiblePptx = Boolean(
      preview?.querySelector(':scope > .v51-pptx-fast-frame img, :scope > .v47-gs-frame img, :scope > .v46-gs-frame img, :scope > .v45-pptx-frame img, :scope > img')
    );

    if (hasVisiblePptx) {
      const committed = await commitVisiblePptx();
      if (committed) return;
    }

    return typeof previousFireLive === 'function'
      ? previousFireLive.apply(this, args)
      : undefined;
  };
})();

/* ===== Extracted inline script block ===== */

/* V61 FINAL AUTHORITY
   Every Go Live action first resets Live/output and then commits the current Preview.
   PDF/PPTX never depend on legacy readiness flags and never stack multiple layers. */
(() => {
  const previousFireLiveV61 = window.fireLive;
  const CLEAR = 'V61_CLEAR_LIVE_OUTPUT';
  const FRAME = 'V61_COMMIT_PREVIEW_FRAME';
  let commitIdV61 = 0;
  let retainedFrameV61 = null;

  const cloneV61 = value => {
    try { return typeof clonePresenterPayload === 'function' ? clonePresenterPayload(value) : structuredClone(value); }
    catch (_) { try { return JSON.parse(JSON.stringify(value || {})); } catch (_) { return value; } }
  };

  function activeSceneV61() {
    try { if (typeof getActiveScene === 'function') return getActiveScene(); } catch (_) {}
    try { return Array.isArray(scenes) ? scenes.find(s => s?.id === activeSceneId) : null; } catch (_) { return null; }
  }

  function visibleElementV61(root, selector) {
    if (!root) return null;
    return [...root.querySelectorAll(selector)].reverse().find(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    }) || null;
  }

  function previewPresentationFrameV61() {
    const root = document.getElementById('preview-viewport');
    if (!root) return null;

    const canvas = visibleElementV61(root, 'canvas');
    if (canvas && canvas.width > 10 && canvas.height > 10) {
      try { return { src: canvas.toDataURL('image/jpeg', .94), kind: 'canvas' }; }
      catch (_) { try { return { src: canvas.toDataURL('image/png'), kind: 'canvas' }; } catch (_) {} }
    }

    const image = visibleElementV61(root, 'img');
    if (image && image.complete && image.naturalWidth > 10) {
      const src = String(image.currentSrc || image.src || '');
      if (src) return { src, kind: 'image' };
    }
    return null;
  }

  function currentPayloadV61() {
    const scene = activeSceneV61();
    let value = cloneV61(window.staged || (typeof staged !== 'undefined' ? staged : null) || {});
    if (!scene || !Array.isArray(scene.items)) return value;

    let index = Number.isInteger(value?.sceneItemIndex) ? value.sceneItemIndex : -1;
    if (!scene.items[index] || (value?.itemId && scene.items[index]?.id !== value.itemId)) {
      index = value?.itemId ? scene.items.findIndex(item => item?.id === value.itemId) : -1;
    }
    if (index < 0 && scene.items.length === 1) index = 0;
    if (index >= 0 && scene.items[index]) {
      const sceneItem = cloneV61(scene.items[index]);
      value = Object.assign(sceneItem || {}, value || {});
      value.sceneId = scene.id;
      value.sceneItemIndex = index;
      value.itemId = scene.items[index]?.id;
    }
    return value;
  }

  function cleanRootV61(root, preserveBackground) {
    if (!root) return;
    const bg = preserveBackground ? document.getElementById('audience-bg-layer') : null;
    [...root.children].forEach(node => {
      if (node === bg) return;
      if (!preserveBackground && (node.classList?.contains('viewport-label') || node.classList?.contains('live-monitor-overlay'))) return;
      node.remove();
    });
    root.querySelectorAll('.v58-presentation-nav,.v58-presentation-count,.v51-pptx-fast-nav,.v51-pptx-fast-count').forEach(n => n.remove());
  }

  function resetLocalLiveV61() {
    cleanRootV61(document.getElementById('live-viewport'), false);
  }

  function resetAudienceV61() {
    if (!document.body.classList.contains('live-window-mode')) return;
    cleanRootV61(document.getElementById('audience-view'), true);
  }

  function mountFrameV61(root, src, alt, preserveBackground) {
    if (!root || !src) return;
    cleanRootV61(root, preserveBackground);
    const frame = document.createElement('div');
    frame.className = 'v61-live-frame';
    const image = document.createElement('img');
    image.src = src;
    image.alt = alt || 'Live presentation';
    frame.appendChild(image);
    root.appendChild(frame);
    try { if (!preserveBackground && typeof updateLiveMonitorOverlays === 'function') updateLiveMonitorOverlays(); } catch (_) {}
  }

  function postV61(message) {
    try { channel.postMessage(message); } catch (_) {}
    try { if (displayWindow && !displayWindow.closed) displayWindow.postMessage(message, '*'); } catch (_) {}
  }

  function clearEverywhereV61() {
    resetLocalLiveV61();
    postV61({ command: CLEAR, commitId: ++commitIdV61 });
  }

  function isPresentationV61(value) {
    return value?.type === 'pdf' || value?.type === 'google-slides';
  }

  function syncPptxPayloadV61(payload, src) {
    const scene = activeSceneV61();
    const list = Array.isArray(payload?.googleSlides?.slides) ? payload.googleSlides.slides : [];
    let page = Math.max(1, Number(payload?.page || 1));
    const selected = document.querySelector('#slide-preview-grid .preview-slide-card.active[data-google-slide-index],#slide-preview-grid .preview-slide-card[aria-selected="true"][data-google-slide-index]');
    if (selected && Number.isFinite(Number(selected.dataset.googleSlideIndex))) page = Number(selected.dataset.googleSlideIndex) + 1;
    page = list.length ? Math.min(list.length, page) : page;
    payload.page = page;
    payload.googleSlides = cloneV61(payload.googleSlides || {});
    const slide = list[page - 1] || {};
    payload.googleSlides.currentSlideId = String(slide.slideId || slide.objectId || payload.googleSlides.currentSlideId || '');
    payload.googleSlides.thumbnailUrl = src;
    try {
      if (scene?.items?.[payload.sceneItemIndex]) {
        scene.items[payload.sceneItemIndex].page = page;
        scene.items[payload.sceneItemIndex].googleSlides.currentSlideId = payload.googleSlides.currentSlideId;
        scene.items[payload.sceneItemIndex].googleSlides.thumbnailUrl = src;
      }
    } catch (_) {}
  }

  async function commitPresentationV61(payload) {
    const serial = ++commitIdV61;
    let frame = previewPresentationFrameV61();

    // One short repaint wait handles a slide selected immediately before Go Live.
    if (!frame) {
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      frame = previewPresentationFrameV61();
    }

    // PPTX may have a valid thumbnail even when the img readiness event was missed.
    if (!frame && payload?.type === 'google-slides') {
      const list = Array.isArray(payload?.googleSlides?.slides) ? payload.googleSlides.slides : [];
      const page = Math.max(1, Math.min(list.length || 1, Number(payload.page || 1)));
      const src = String(list[page - 1]?.thumbnailUrl || payload?.googleSlides?.thumbnailUrl || '');
      if (src) frame = { src, kind: 'image' };
    }

    if (!frame?.src || serial !== commitIdV61) return false;
    if (payload.type === 'google-slides') syncPptxPayloadV61(payload, frame.src);

    try {
      staged = cloneV61(payload);
      liveState = cloneV61(payload);
      lastIncoming = cloneV61(payload);
      if (typeof persistScenes === 'function') persistScenes();
    } catch (_) {}

    retainedFrameV61 = { payload: cloneV61(payload), src: frame.src };
    mountFrameV61(document.getElementById('live-viewport'), frame.src, payload.name, false);
    postV61({
      command: FRAME,
      commitId: serial,
      payload: cloneV61(payload),
      src: frame.src,
      transitionType: document.getElementById('transition-type-select')?.value || 'cut'
    });
    return true;
  }

  window.fireLive = async function(...args) {
    const payload = currentPayloadV61();

    // Live always resets first. No previous PDF, PPTX, image, or video layer survives.
    clearEverywhereV61();

    if (isPresentationV61(payload)) {
      const committed = await commitPresentationV61(payload);
      if (!committed) {
        // Do not show the incorrect legacy "Presentation Not Ready" modal.
        console.warn('V61: Preview frame was unavailable for this presentation commit.');
      }
      return;
    }

    // Keep video position/play state aligned with Preview before using the established media renderer.
    if (payload?.type === 'video') {
      const previewVideo = visibleElementV61(document.getElementById('preview-viewport'), 'video');
      if (previewVideo) {
        payload.videoTime = Number(previewVideo.currentTime || 0);
        payload.videoPlaying = !previewVideo.paused;
        try { staged = cloneV61(payload); } catch (_) {}
      }
    }

    return typeof previousFireLiveV61 === 'function'
      ? previousFireLiveV61.apply(this, args)
      : undefined;
  };

  function receiveV61(message) {
    if (!document.body.classList.contains('live-window-mode') || !message) return;
    if (message.command === CLEAR) {
      resetAudienceV61();
      return;
    }
    if (message.command === FRAME && message.src) {
      retainedFrameV61 = { payload: cloneV61(message.payload), src: message.src };
      mountFrameV61(document.getElementById('audience-view'), message.src, message.payload?.name, true);
    }
  }

  try { channel.addEventListener('message', event => receiveV61(event.data)); } catch (_) {}
  window.addEventListener('message', event => receiveV61(event.data));

  // A newly opened display receives the last committed Live frame, not current Preview.
  try {
    channel.addEventListener('message', event => {
      const msg = event.data || {};
      if (document.body.classList.contains('live-window-mode') || msg.command !== 'REQUEST_CURRENT_OUTPUT') return;
      if (retainedFrameV61?.src) postV61({ command: FRAME, payload: cloneV61(retainedFrameV61.payload), src: retainedFrameV61.src, transitionType: 'cut' });
    });
  } catch (_) {}
})();

/* ===== Extracted inline script block ===== */

/* V62 FINAL VIDEO AUTHORITY
   A video visible in Preview is committed directly to Live View and Display Screen.
   It never falls back through the old PDF/PPTX/media Go Live wrapper chain. */
(() => {
  const previousFireLiveV62 = window.fireLive;
  const VIDEO_COMMAND = 'PRESENTER_VIDEO_BLOB_LIVE_V26';
  const CLEAR_COMMAND = 'V61_CLEAR_LIVE_OUTPUT';
  let retainedVideoBlobV62 = null;
  let retainedVideoPayloadV62 = null;
  let localVideoUrlV62 = '';

  const cloneV62 = value => {
    try { return typeof clonePresenterPayload === 'function' ? clonePresenterPayload(value) : structuredClone(value); }
    catch (_) { try { return JSON.parse(JSON.stringify(value || {})); } catch (_) { return value || {}; } }
  };

  function visiblePreviewVideoV62() {
    const root = document.getElementById('preview-viewport');
    if (!root) return null;
    return [...root.querySelectorAll('video')].reverse().find(video => {
      const rect = video.getBoundingClientRect();
      const style = getComputedStyle(video);
      return rect.width > 8 && rect.height > 8 && style.display !== 'none' &&
        style.visibility !== 'hidden' && Number(style.opacity || 1) > 0;
    }) || null;
  }

  function currentVideoPayloadV62(previewVideo) {
    let payload = cloneV62(window.staged || (typeof staged !== 'undefined' ? staged : null) || {});
    let scene = null;
    try { scene = typeof getActiveScene === 'function' ? getActiveScene() : scenes?.find(s => s?.id === activeSceneId); } catch (_) {}

    if (scene?.items?.length) {
      let index = Number.isInteger(payload.sceneItemIndex) ? payload.sceneItemIndex : -1;
      if (!scene.items[index] || scene.items[index]?.type !== 'video') {
        index = scene.items.findIndex(item => item?.type === 'video' && (
          (payload.itemId && item.id === payload.itemId) ||
          (previewVideo?.dataset?.itemId && item.id === previewVideo.dataset.itemId) ||
          (item.value && previewVideo?.currentSrc && item.value === previewVideo.currentSrc) ||
          (item.value && previewVideo?.src && item.value === previewVideo.src)
        ));
      }
      if (index < 0) {
        const videos = scene.items.map((item, i) => ({ item, i })).filter(entry => entry.item?.type === 'video');
        if (videos.length === 1) index = videos[0].i;
      }
      if (index >= 0 && scene.items[index]) {
        payload = Object.assign(cloneV62(scene.items[index]), payload);
        payload.sceneId = scene.id;
        payload.sceneItemIndex = index;
        payload.itemId = scene.items[index].id;
      }
    }

    payload.type = 'video';
    payload.videoTime = Number(previewVideo?.currentTime || payload.videoTime || 0);
    payload.videoPlaying = previewVideo ? !previewVideo.paused && !previewVideo.ended : Boolean(payload.videoPlaying);
    payload.mimeType = payload.mimeType || 'video/mp4';
    return payload;
  }

  async function resolveVideoBlobV62(payload, previewVideo) {
    if (payload?.rootRelativePath && typeof resolveRootPath === 'function') {
      try { const file = await resolveRootPath(payload.rootRelativePath); if (file) return file; } catch (_) {}
    }
    if (typeof getCachedMediaBlob === 'function') {
      try { const blob = await getCachedMediaBlob(payload); if (blob) return blob; } catch (_) {}
    }
    const candidates = [previewVideo?.currentSrc, previewVideo?.src, payload?.value].filter(Boolean);
    for (const source of candidates) {
      try {
        const response = await fetch(source);
        if (response.ok) {
          const blob = await response.blob();
          if (blob?.size) return blob;
        }
      } catch (_) {}
    }
    return null;
  }

  function clearLocalLiveV62() {
    const root = document.getElementById('live-viewport');
    if (!root) return;
    [...root.children].forEach(node => {
      if (node.classList?.contains('viewport-label') || node.classList?.contains('live-monitor-overlay')) return;
      node.remove();
    });
  }

  function postV62(message) {
    // The Display Screen already shares the BroadcastChannel. Sending the same
    // video through both BroadcastChannel and postMessage caused two near-simultaneous
    // mounts and could briefly produce overlapping audio. Use one transport only.
    try { channel.postMessage(message); } catch (_) {
      try { if (displayWindow && !displayWindow.closed) displayWindow.postMessage(message, '*'); } catch (_) {}
    }
  }

  function mountLocalVideoV62(blob, payload) {
    const root = document.getElementById('live-viewport');
    if (!root) return null;
    clearLocalLiveV62();
    if (localVideoUrlV62) { try { URL.revokeObjectURL(localVideoUrlV62); } catch (_) {} }
    localVideoUrlV62 = URL.createObjectURL(blob);

    const frame = document.createElement('div');
    frame.className = 'v62-live-video-frame';
    const video = document.createElement('video');
    video.id = 'operator-live-video';
    video.src = localVideoUrlV62;
    video.preload = 'auto';
    video.playsInline = true;
    video.controls = false;
    video.muted = true; // Display Screen remains the sound authority and prevents doubled audio.
    video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;';
    frame.appendChild(video);
    root.appendChild(frame);

    video.addEventListener('loadedmetadata', async () => {
      const requested = Number(payload.videoTime || 0);
      if (Number.isFinite(requested) && requested > 0) {
        try { video.currentTime = Math.min(requested, Math.max(0, video.duration || requested)); } catch (_) {}
      }
      if (payload.videoPlaying) {
        try { await video.play(); } catch (_) {}
      }
    }, { once:true });
    try { if (typeof updateLiveMonitorOverlays === 'function') updateLiveMonitorOverlays(); } catch (_) {}
    return video;
  }

  async function commitVideoV62(previewVideo) {
    const payload = currentVideoPayloadV62(previewVideo);
    const blob = await resolveVideoBlobV62(payload, previewVideo);
    if (!blob) {
      console.error('V62: Unable to resolve the video file currently visible in Preview.');
      return false;
    }

    // Reset both destinations before inserting exactly one video layer.
    clearLocalLiveV62();
    postV62({ command: CLEAR_COMMAND, commitId: Date.now() });

    try {
      staged = cloneV62(payload);
      window.staged = staged;
      liveState = cloneV62(payload);
      lastIncoming = cloneV62(payload);
      if (typeof persistScenes === 'function') persistScenes();
    } catch (_) {}

    retainedVideoBlobV62 = blob;
    retainedVideoPayloadV62 = cloneV62(payload);
    mountLocalVideoV62(blob, payload);

    postV62({
      command: VIDEO_COMMAND,
      blob,
      payload: cloneV62(payload),
      transitionType: document.getElementById('transition-type-select')?.value || 'cut'
    });
    return true;
  }

  window.fireLive = async function(...args) {
    const previewVideo = visiblePreviewVideoV62();
    const stagedType = String((window.staged || (typeof staged !== 'undefined' ? staged : null))?.type || '');
    if (previewVideo || stagedType === 'video') {
      const video = previewVideo || document.querySelector('#preview-viewport video');
      if (video) {
        await commitVideoV62(video);
        return;
      }
    }
    return typeof previousFireLiveV62 === 'function' ? previousFireLiveV62.apply(this, args) : undefined;
  };

  // Newly opened/reloaded Display Screen receives the retained live video, not current Preview.
  try {
    channel.addEventListener('message', event => {
      const message = event.data || {};
      if (document.body.classList.contains('live-window-mode') || message.command !== 'REQUEST_CURRENT_OUTPUT') return;
      if (!retainedVideoBlobV62 || !retainedVideoPayloadV62 || liveState?.type !== 'video') return;
      postV62({ command: VIDEO_COMMAND, blob: retainedVideoBlobV62, payload: cloneV62(retainedVideoPayloadV62), transitionType:'cut' });
    });
  } catch (_) {}
})();


/* V65: unified cloud-file viewer with optional PPTX-only filter. */
(() => {
  const PPTX_MIME_V65 = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  const isPptxV65 = file => /\.pptx$/i.test(String(file?.name || file?.fileName || '')) || String(file?.mimeType || '') === PPTX_MIME_V65;

  function renderPptxCardsV65(files) {
    const list = document.getElementById('drive-pdf-list');
    if (!list) return;
    if (!files.length) {
      list.innerHTML = '<div style="grid-column:1/-1;color:var(--text-muted);padding:22px;text-align:center;">No PowerPoint files are available.</div>';
      return;
    }
    list.innerHTML = files.map(file => {
      const id = String(file.id || file.fileId || '');
      const name = String(file.name || file.fileName || 'Presentation.pptx');
      const created = file.createdTime ? new Date(file.createdTime).toLocaleString() : '';
      return `<div class="drive-pdf-card" data-drive-file-id="${escapeHtml(id)}">
        <button class="drive-file-delete" title="Delete file" onclick="deleteOnlineDriveFile('${escapeHtml(id)}')">🗑</button>
        <div class="drive-file-thumb">${driveFilePreviewHtml(file)}</div>
        <div class="drive-file-kind">POWERPOINT</div>
        <div class="drive-pdf-card-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
        <div class="drive-pdf-card-meta">${escapeHtml(formatFileBytes(file.size || 0))}<br>${escapeHtml(created)}</div>
        <div class="drive-pdf-card-actions">
          <button onclick="prepareExistingDrivePptx(${JSON.stringify(file).replace(/"/g,'&quot;')})">✏ Open in ONLYOFFICE</button>
          <button class="drive-pptx-add-action" onclick="addCloudPptxDirectlyToScene('${escapeHtml(id)}')">＋ Add to Scene</button>
        </div>
        <div class="drive-pptx-card-status" aria-live="polite">Uses the existing cloud PPTX file.</div>
      </div>`;
    }).join('');
  }

  window.renderDrivePdfList = async function() {
    const list = document.getElementById('drive-pdf-list');
    if (!list) return;
    list.innerHTML = '<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--text-muted)">Loading cloud files…</div>';
    try {
      const files = await getDriveFilesFromBackend(false);
      const pptxOnly = Boolean(document.getElementById('drive-pptx-only-filter')?.checked);
      if (pptxOnly) renderPptxCardsV65((files || []).filter(isPptxV65));
      else renderDriveFileCards(files || [], 'drive-pdf-list');
    } catch (error) {
      list.innerHTML = '<div style="grid-column:1/-1;color:var(--accent-red);padding:20px">' + escapeHtml(error?.message || String(error)) + '</div>';
    }
  };

  window.openDrivePdfModal = function() {
    const modal = document.getElementById('drive-pdf-modal');
    const title = modal?.querySelector('.modal-title');
    const description = modal?.querySelector('.modal-body');
    const toolbar = modal?.querySelector('.drive-view-toolbar');
    if (title) title.textContent = 'Cloud Files';
    if (description) description.textContent = 'Turn on the PPTX filter to show only PowerPoint files. Other cloud files can be downloaded into the selected root folder.';
    if (toolbar) toolbar.style.display = 'flex';
    modal?.classList.add('open');
    window.renderDrivePdfList();
  };

  window.openDrivePptxFilesModal = function() {
    const toggle = document.getElementById('drive-pptx-only-filter');
    if (toggle) toggle.checked = true;
    window.openDrivePdfModal();
  };

  window.refreshDriveFilesForViewer = async function() {
    try { await getDriveFilesFromBackend(true); } catch (_) {}
    return window.renderDrivePdfList();
  };
})();

/* ===== ONLYOFFICE audience extender controller ===== */
(() => {
  'use strict';

  const EXTENDER_WINDOW_NAME = 'JILOnlyOfficeExtender';
  const EXTENDER_COMMAND = 'JIL_ONLYOFFICE_EXTENDER_BACKGROUND';
  const EXTENDER_READY = 'JIL_ONLYOFFICE_EXTENDER_READY';
  const EXTENDER_STATE = 'JIL_ONLYOFFICE_EXTENDER_STATE';
  const EXTENDER_OPEN_DISPLAY = 'JIL_ONLYOFFICE_EXTENDER_OPEN_DISPLAY';
  const EXTENDER_DISPLAY_STATE = 'JIL_ONLYOFFICE_EXTENDER_DISPLAY_STATE';
  let onlyOfficeExtenderWindow = null;

  function resolveOnlyOfficeExtenderBackgroundSource() {
    const filename = localStorage.getItem(LS_BG_TARGET) || '';
    let source = currentBackgroundSource || '';

    // The saved background name can exist before currentBackgroundSource is
    // restored (for example when the PPTX Extender opens immediately). Resolve
    // it directly from the workspace image map so the controller does not show
    // a false "No background selected" state.
    if (!source && filename && typeof discoveredWorkspaceImages === 'object' && discoveredWorkspaceImages) {
      source = discoveredWorkspaceImages[filename] || '';
    }

    if (source && source !== currentBackgroundSource) {
      currentBackgroundSource = source;
      try { updateLiveMonitorOverlays(); } catch (_) {}
      try { channel.postMessage({ command: 'UPDATE_BACKGROUND_SOURCE', value: source }); } catch (_) {}
    }

    return { filename, source };
  }

  function currentOnlyOfficeExtenderState() {
    const background = resolveOnlyOfficeExtenderBackgroundSource();
    return {
      active: Boolean(isFTGActive),
      filename: background.filename,
      hasBackground: Boolean(background.filename && background.source),
      source: background.source || '',
      displayOpen: Boolean(displayWindow && !displayWindow.closed),
      monitorSelected: Boolean(selectedMonitor || getStoredSelectedMonitor())
    };
  }

  function publishOnlyOfficeExtenderState() {
    const state = currentOnlyOfficeExtenderState();
    try { channel.postMessage({ command: EXTENDER_STATE, state }); } catch (_) {}
    try {
      if (onlyOfficeExtenderWindow && !onlyOfficeExtenderWindow.closed) {
        onlyOfficeExtenderWindow.postMessage({ command: EXTENDER_STATE, state }, window.location.origin);
      }
    } catch (_) {}
    try {
      window.dispatchEvent(new CustomEvent('jil-onlyoffice-background-state', { detail: state }));
    } catch (_) {}
    return state;
  }

  async function setOnlyOfficeExtenderBackground(active) {
    const desired = Boolean(active);
    const background = resolveOnlyOfficeExtenderBackgroundSource();
    const filename = background.filename;
    if (desired && (!filename || !background.source)) {
      showModal('Background Image Required', 'Choose a background image in the main website and make sure the workspace folder is connected before turning the audience background on.', false);
      publishOnlyOfficeExtenderState();
      return false;
    }

    if (Boolean(isFTGActive) !== desired) {
      await Promise.resolve(toggleFadeToBackground());
    } else {
      try { await sendBackgroundToDisplayV29(desired); } catch (_) {}
      try { postPresenterMessageV29({ command: 'TOGGLE_FTG_STATE', active: desired }); } catch (_) {}
    }

    publishOnlyOfficeExtenderState();
    return Boolean(isFTGActive) === desired;
  }

  function extenderWindowFeatures() {
    const width = Math.min(1180, Math.max(860, Number(window.screen?.availWidth || 1200) - 220));
    const height = Math.min(760, Math.max(620, Number(window.screen?.availHeight || 800) - 160));
    const left = Math.max(0, Number(window.screenX || 0) + 70);
    const top = Math.max(0, Number(window.screenY || 0) + 55);
    return `popup=yes,width=${Math.round(width)},height=${Math.round(height)},left=${Math.round(left)},top=${Math.round(top)},resizable=yes,scrollbars=yes`;
  }

  function showExtenderPopupBlockedModal() {
    let modal = document.getElementById('onlyoffice-extender-popup-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'onlyoffice-extender-popup-modal';
      modal.className = 'modal-overlay';
      modal.style.zIndex = '2147483646';
      modal.innerHTML = `
        <div class="modal" style="width:min(92vw,520px);background:#141922;border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:20px;color:#fff;box-shadow:0 24px 80px rgba(0,0,0,.55)">
          <div style="font-size:12px;font-weight:900;letter-spacing:.12em;color:#8ab4ff;text-transform:uppercase;margin-bottom:8px">ONLYOFFICE Extender</div>
          <h3 style="margin:0 0 10px;font-size:20px">Open the Extender controller</h3>
          <p style="margin:0 0 18px;color:#b6c0d0;line-height:1.5">Chrome blocked the automatic controller window. Click below once to open the Extender in its own Chrome window. Keep this window on the primary monitor.</p>
          <div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">
            <button type="button" onclick="document.getElementById('onlyoffice-extender-popup-modal')?.classList.remove('open')" style="background:#333b49;color:#fff">Not now</button>
            <button type="button" onclick="window.openOnlyOfficeExtenderWindow?.(true);document.getElementById('onlyoffice-extender-popup-modal')?.classList.remove('open')" style="background:#6d4aff;color:#fff">Open Extender Window</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
    }
    modal.classList.add('open');
  }

  function openOnlyOfficeExtenderWindow(fromFallbackClick = false) {
    if (onlyOfficeExtenderWindow && !onlyOfficeExtenderWindow.closed) {
      try { onlyOfficeExtenderWindow.focus(); } catch (_) {}
      return onlyOfficeExtenderWindow;
    }

    const url = new URL('onlyoffice-extender.html', window.location.href).href;
    // Open a blank same-origin window synchronously while the PPTX-open click is
    // still a user gesture. Navigating it afterward is more reliable than doing
    // work before window.open(), especially when the Display Screen is also used.
    let popup = null;
    try {
      popup = window.open('about:blank', EXTENDER_WINDOW_NAME, extenderWindowFeatures());
    } catch (_) {}

    if (!popup) {
      if (!fromFallbackClick) setTimeout(showExtenderPopupBlockedModal, 80);
      return null;
    }

    onlyOfficeExtenderWindow = popup;
    try {
      popup.document.open();
      popup.document.write('<!doctype html><title>Opening ONLYOFFICE Extender…</title><body style="margin:0;background:#0b0f16;color:#fff;font:600 16px system-ui;display:grid;place-items:center;min-height:100vh">Opening ONLYOFFICE Extender…</body>');
      popup.document.close();
    } catch (_) {}
    try { popup.location.replace(url); } catch (_) { try { popup.location.href = url; } catch (_) {} }
    try { popup.focus(); } catch (_) {}
    setTimeout(publishOnlyOfficeExtenderState, 500);
    return popup;
  }

  window.openOnlyOfficeExtenderWindow = openOnlyOfficeExtenderWindow;

  window.prepareOnlyOfficeExtenderWindows = function() {
    // PPTX-only hook: reserve/open only the Extender controller.
    // The audience Display Screen is opened manually from the Extender.
    selectedMonitor = selectedMonitor || getStoredSelectedMonitor();
    if (!selectedMonitor) {
      showModal('Select Audience Monitor', 'Use Detect Monitor and select the secondary display before opening ONLYOFFICE.', false);
      return false;
    }

    // Open the PPTX Extender while the PPTX-open action still has a user gesture.
    if (!onlyOfficeExtenderWindow || onlyOfficeExtenderWindow.closed) {
      openOnlyOfficeExtenderWindow();
    }
    return true;
  };

  window.activateOnlyOfficeExtenderSession = async function() {
    // This function is called only by the PPTX/ONLYOFFICE workflow.
    selectedMonitor = selectedMonitor || getStoredSelectedMonitor();
    if (!onlyOfficeExtenderWindow || onlyOfficeExtenderWindow.closed) {
      const extender = openOnlyOfficeExtenderWindow();
      if (!extender) setTimeout(showExtenderPopupBlockedModal, 120);
    }
    // Keep the audience safety background armed, but do NOT open Display Screen here.
    await setOnlyOfficeExtenderBackground(true);
    setTimeout(publishOnlyOfficeExtenderState, 250);
    setTimeout(publishOnlyOfficeExtenderState, 900);
    setTimeout(publishOnlyOfficeExtenderState, 1800);
  };

  async function openOnlyOfficeDisplayFromExtender() {
    selectedMonitor = selectedMonitor || getStoredSelectedMonitor();
    if (!selectedMonitor) {
      showModal('Select Audience Monitor', 'Use Detect Monitor in the main website and select the secondary display first.', false);
      publishOnlyOfficeExtenderState();
      return false;
    }

    // Cover first so no PPTX/editor frame flashes while the audience window opens.
    await setOnlyOfficeExtenderBackground(true);

    if (!displayWindow || displayWindow.closed) {
      await openDisplayWindow();
    } else {
      try { displayWindow.focus(); } catch (_) {}
    }

    // Re-send the cover after the display has finished loading.
    setTimeout(async () => {
      try { await sendBackgroundToDisplayV29(true); } catch (_) {}
      try { postPresenterMessageV29({ command: 'TOGGLE_FTG_STATE', active: true }); } catch (_) {}
      publishOnlyOfficeExtenderState();
    }, 500);
    publishOnlyOfficeExtenderState();
    return Boolean(displayWindow && !displayWindow.closed);
  }

  window.openOnlyOfficeDisplayFromExtender = openOnlyOfficeDisplayFromExtender;

  window.setOnlyOfficeExtenderBackground = setOnlyOfficeExtenderBackground;
  window.getOnlyOfficeExtenderState = currentOnlyOfficeExtenderState;

  channel.addEventListener('message', async event => {
    const message = event && event.data;
    if (!message) return;
    if (message.command === EXTENDER_COMMAND) {
      await setOnlyOfficeExtenderBackground(Boolean(message.active));
    } else if (message.command === EXTENDER_OPEN_DISPLAY) {
      await openOnlyOfficeDisplayFromExtender();
    } else if (message.command === EXTENDER_READY) {
      publishOnlyOfficeExtenderState();
    }
  });

  window.addEventListener('message', async event => {
    if (event.origin !== window.location.origin) return;
    const message = event.data || {};
    if (message.command === EXTENDER_COMMAND) {
      await setOnlyOfficeExtenderBackground(Boolean(message.active));
    } else if (message.command === EXTENDER_OPEN_DISPLAY) {
      await openOnlyOfficeDisplayFromExtender();
    } else if (message.command === EXTENDER_READY) {
      publishOnlyOfficeExtenderState();
    }
  });

  window.addEventListener('storage', event => {
    if (event.key === LS_BG_TARGET) publishOnlyOfficeExtenderState();
  });
})();


/* V66 MAIN WEBSITE QUALITY PASS
   - smooth file loading feedback
   - PDF preview flicker shield
   - one program-audio authority for live video
   - root-file organization helpers */
(() => {
  let loaderDepthV66 = 0;
  let loaderShownAtV66 = 0;
  let loaderHideTimerV66 = null;

  function showMainFileLoadingV66(title = 'Loading file…', detail = 'Preparing preview') {
    const overlay = document.getElementById('main-file-loading-overlay');
    const titleEl = document.getElementById('main-file-loading-title');
    const detailEl = document.getElementById('main-file-loading-detail');
    if (!overlay) return;
    loaderDepthV66 += 1;
    loaderShownAtV66 = loaderShownAtV66 || Date.now();
    if (loaderHideTimerV66) { clearTimeout(loaderHideTimerV66); loaderHideTimerV66 = null; }
    if (titleEl) titleEl.textContent = title;
    if (detailEl) detailEl.textContent = detail;
    overlay.classList.add('show');
    overlay.setAttribute('aria-hidden', 'false');
  }

  function hideMainFileLoadingV66(force = false) {
    const overlay = document.getElementById('main-file-loading-overlay');
    if (!overlay) return;
    if (force) loaderDepthV66 = 0; else loaderDepthV66 = Math.max(0, loaderDepthV66 - 1);
    if (loaderDepthV66 > 0) return;
    const wait = Math.max(0, 360 - (Date.now() - (loaderShownAtV66 || Date.now())));
    loaderHideTimerV66 = setTimeout(() => {
      overlay.classList.remove('show');
      overlay.setAttribute('aria-hidden', 'true');
      loaderShownAtV66 = 0;
      loaderHideTimerV66 = null;
    }, wait);
  }

  window.showMainFileLoading = showMainFileLoadingV66;
  window.hideMainFileLoading = hideMainFileLoadingV66;

  function fileLabelV66(files) {
    const list = Array.from(files || []);
    if (!list.length) return 'Preparing selected file';
    if (list.length === 1) return list[0].name || 'Preparing selected file';
    return `${list.length} files selected`;
  }

  // Main Media Assets uploader: keep feedback visible for the real async work.
  const unifiedBeforeV66 = window.handleUnifiedMediaUpload;
  if (typeof unifiedBeforeV66 === 'function') {
    window.handleUnifiedMediaUpload = async function(event) {
      const files = event?.target?.files || [];
      showMainFileLoadingV66('Loading media…', fileLabelV66(files));
      try {
        return await unifiedBeforeV66.apply(this, arguments);
      } finally {
        hideMainFileLoadingV66();
      }
    };
  }

  // Root Files -> Add to Scene also gets the same consistent loading treatment.
  const addRootBeforeV66 = window.addRootFileToScene;
  if (typeof addRootBeforeV66 === 'function') {
    window.addRootFileToScene = async function(index) {
      showMainFileLoadingV66('Loading root file…', 'Preparing the selected media');
      try { return await addRootBeforeV66.apply(this, arguments); }
      finally { hideMainFileLoadingV66(); }
    };
  }

  // Fallback for other file pickers (Bible/background/etc.) that have their own handlers.
  document.addEventListener('change', event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file' || !input.files?.length) return;
    if (input.id === 'file-uploader') return; // handled by the async wrapper above
    showMainFileLoadingV66('Loading file…', fileLabelV66(input.files));
    setTimeout(() => hideMainFileLoadingV66(), 650);
  }, true);

  function makePreviewShieldV66() {
    const preview = document.getElementById('preview-viewport');
    if (!preview) return null;
    const rect = preview.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 20) return null;
    const shield = document.createElement('div');
    shield.className = 'preview-flicker-shield';
    shield.style.left = `${rect.left}px`;
    shield.style.top = `${rect.top}px`;
    shield.style.width = `${rect.width}px`;
    shield.style.height = `${rect.height}px`;

    let src = '';
    const canvas = [...preview.querySelectorAll('canvas')].reverse().find(c => c.width > 10 && c.height > 10);
    if (canvas) { try { src = canvas.toDataURL('image/jpeg', .92); } catch (_) {} }
    if (!src) {
      const image = [...preview.querySelectorAll('img')].reverse().find(img => img.complete && img.naturalWidth > 10);
      if (image) src = String(image.currentSrc || image.src || '');
    }
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      shield.appendChild(img);
    } else {
      const spinner = document.createElement('div');
      spinner.className = 'main-file-loading-spinner';
      shield.appendChild(spinner);
    }
    document.body.appendChild(shield);
    return shield;
  }

  function releasePreviewShieldV66(shield) {
    if (!shield) return;
    requestAnimationFrame(() => {
      shield.classList.add('fade-out');
      setTimeout(() => shield.remove(), 200);
    });
  }

  // Buffer PDF preview swaps so the previous frame stays visible until the new page is ready.
  const renderPreviewBeforeV66 = window.renderPreview;
  if (typeof renderPreviewBeforeV66 === 'function') {
    window.renderPreview = async function() {
      const payload = window.staged || (typeof staged !== 'undefined' ? staged : null);
      const smoothPdf = payload?.type === 'pdf';
      const pdfAlreadyVisible = Boolean(smoothPdf && document.querySelector('#preview-viewport canvas'));
      // Initial PDF open gets normal loading feedback. Page-to-page navigation
      // stays inside the Preview so the rest of the main UI does not flicker.
      const shield = smoothPdf && !pdfAlreadyVisible ? makePreviewShieldV66() : null;
      if (smoothPdf && !pdfAlreadyVisible) showMainFileLoadingV66('Loading PDF…', payload?.name || `Page ${payload?.page || 1}`);
      try {
        const result = await renderPreviewBeforeV66.apply(this, arguments);
        // Let the newly rendered canvas/image paint once before releasing the previous frame.
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return result;
      } finally {
        releasePreviewShieldV66(shield);
        if (smoothPdf && !pdfAlreadyVisible) hideMainFileLoadingV66();
      }
    };
  }

  // Enforce one program-audio source after Go Live. Preview never competes with Live.
  function enforceSingleVideoAudioV66() {
    const preview = document.querySelector('#preview-viewport video');
    const operator = document.getElementById('operator-live-video');
    const audience = document.getElementById('audience-live-video');
    const audienceOpen = Boolean(typeof displayWindow !== 'undefined' && displayWindow && !displayWindow.closed);
    if (preview) { preview.muted = true; preview.volume = 0; }
    if (operator) {
      operator.muted = audienceOpen;
      operator.volume = audienceOpen ? 0 : 1;
    }
    if (audience) { audience.muted = false; audience.volume = 1; }
  }

  const fireLiveBeforeV66 = window.fireLive;
  if (typeof fireLiveBeforeV66 === 'function') {
    window.fireLive = async function() {
      const payload = window.staged || (typeof staged !== 'undefined' ? staged : null);
      const result = await fireLiveBeforeV66.apply(this, arguments);
      if (payload?.type === 'video') {
        enforceSingleVideoAudioV66();
        setTimeout(enforceSingleVideoAudioV66, 80);
        setTimeout(enforceSingleVideoAudioV66, 400);
      }
      return result;
    };
  }

  // Any newly mounted video is normalized immediately.
  const videoObserverV66 = new MutationObserver(() => enforceSingleVideoAudioV66());
  document.addEventListener('DOMContentLoaded', () => {
    const operator = document.getElementById('operator-view');
    const audience = document.getElementById('audience-view');
    if (operator) videoObserverV66.observe(operator, {childList:true,subtree:true});
    if (audience) videoObserverV66.observe(audience, {childList:true,subtree:true});
  }, {once:true});
})();

/* V63: Go Live automatically reveals content when Background is active.
   The new Preview is committed while the audience is still safely covered,
   then the background fades off so no previous Live frame can flash. */
(() => {
  const previousFireLiveV63 = window.fireLive;
  let goLiveRevealBusyV63 = false;

  const waitV63 = ms => new Promise(resolve => setTimeout(resolve, ms));

  async function turnBackgroundOffAfterCommitV63() {
    try {
      if (typeof isFTGActive === 'undefined' || !isFTGActive) return;

      // Give the new Live/output frame a moment to mount behind the cover.
      await waitV63(90);

      if (typeof toggleFadeToBackground === 'function') {
        toggleFadeToBackground();
        return;
      }

      // Fallback if the legacy toggle is unavailable for any reason.
      isFTGActive = false;
      const btn = document.getElementById('ftg-toggle-btn');
      if (btn) {
        btn.classList.remove('active');
        btn.textContent = '🖼️ Background On';
      }
      try { if (typeof updateLiveMonitorOverlays === 'function') updateLiveMonitorOverlays(); } catch (_) {}
      try { channel.postMessage({ command: 'TOGGLE_FTG_STATE', active: false }); } catch (_) {}
    } catch (error) {
      console.warn('V63: Unable to automatically turn Background off after Go Live:', error);
    }
  }

  window.fireLive = async function(...args) {
    if (goLiveRevealBusyV63) return;
    goLiveRevealBusyV63 = true;

    const backgroundWasActive = (() => {
      try { return typeof isFTGActive !== 'undefined' && Boolean(isFTGActive); }
      catch (_) { return false; }
    })();

    try {
      // Commit Preview -> Live first while the audience remains covered.
      const result = typeof previousFireLiveV63 === 'function'
        ? await previousFireLiveV63.apply(this, args)
        : undefined;

      // If Background was ON when Go Live was clicked, reveal the newly
      // committed Live output automatically. Existing fade styling is retained.
      if (backgroundWasActive) await turnBackgroundOffAfterCommitV63();
      return result;
    } finally {
      goLiveRevealBusyV63 = false;
    }
  };
})();


/* V67: stop outgoing video on scene changes + keyboard-first PDF presenting. */
(() => {
  if (window.__v67MediaControlInstalled) return;
  window.__v67MediaControlInstalled = true;

  function sameProgramVideoV67(a, b) {
    if (!a || !b || a.type !== 'video' || b.type !== 'video') return false;
    if (a.itemId && b.itemId) return a.itemId === b.itemId;
    return Boolean(a.value && b.value && a.value === b.value);
  }

  function stopVideoNodeV67(video, reset = false) {
    if (!video) return;
    try { video.pause(); } catch (_) {}
    try { video.muted = true; video.volume = 0; } catch (_) {}
    if (reset) { try { video.currentTime = 0; } catch (_) {} }
  }

  function stopOutgoingProgramVideoV67(reset = false) {
    stopVideoNodeV67(document.getElementById('operator-live-video'), reset);
    document.querySelectorAll('#live-viewport video, #operator-view video').forEach(v => stopVideoNodeV67(v, reset));
    try { channel.postMessage({ command: 'V67_STOP_PROGRAM_VIDEO', reset: Boolean(reset) }); } catch (_) {}
  }

  // Stop the previous Live video before a different scene is sent Live.
  const fireLiveBeforeV67 = window.fireLive;
  if (typeof fireLiveBeforeV67 === 'function') {
    window.fireLive = async function(...args) {
      const oldLive = (typeof liveState !== 'undefined' && liveState) ? liveState : null;
      const nextLive = (typeof staged !== 'undefined' && staged) ? staged : null;
      if (oldLive?.type === 'video' && !sameProgramVideoV67(oldLive, nextLive)) {
        stopOutgoingProgramVideoV67(false);
      }
      return await fireLiveBeforeV67.apply(this, args);
    };
  }

  // Display/output windows receive the explicit stop command too, so no hidden
  // outgoing video can keep playing audio under the next scene.
  try {
    channel.addEventListener('message', event => {
      const message = event?.data;
      if (!message || message.command !== 'V67_STOP_PROGRAM_VIDEO') return;
      document.querySelectorAll('#audience-view video, .audience-media-layer video, #live-viewport video').forEach(video => {
        stopVideoNodeV67(video, Boolean(message.reset));
      });
    });
  } catch (_) {}

  function isTypingTargetV67(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = String(target.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON';
  }

  // PDF operator controls:
  // Left / Up   = previous slide
  // Right / Down = next slide
  // Enter       = send the selected PDF slide Live
  window.addEventListener('keydown', event => {
    if (isTypingTargetV67(event.target)) return;
    const current = (typeof staged !== 'undefined' && staged) ? staged : null;
    if (!current || current.type !== 'pdf') return;

    const key = event.key;
    if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'ArrowRight' || key === 'ArrowDown') {
      event.preventDefault();
      event.stopImmediatePropagation();
      const delta = (key === 'ArrowLeft' || key === 'ArrowUp') ? -1 : 1;
      if (typeof setPdfPage === 'function') setPdfPage((Number(current.page) || 1) + delta);
      return;
    }

    if (key === 'Enter') {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (typeof window.fireLive === 'function') window.fireLive();
    }
  }, true);
})();

/* V68: reliable Preview -> Live handoff + authoritative PDF operator navigation.
   - Always synchronizes lexical staged into window.staged before the existing Go Live chain.
   - Replaces legacy PDF page setter so Preview arrows/keyboard only queue a page; Enter sends it Live.
   - Keeps the current PDF frame visible while the next page renders through the existing buffered renderer. */
(() => {
  if (window.__v68ReliableHandoffInstalled) return;
  window.__v68ReliableHandoffInstalled = true;

  const cloneV68 = value => {
    try { return typeof clonePresenterPayload === 'function' ? clonePresenterPayload(value) : structuredClone(value); }
    catch (_) { try { return JSON.parse(JSON.stringify(value || {})); } catch (_) { return value; } }
  };

  function stagedV68() {
    try { return staged || null; } catch (_) { return window.staged || null; }
  }

  function syncWindowStagedV68() {
    const current = stagedV68();
    if (!current) return null;
    try { window.staged = cloneV68(current); } catch (_) { window.staged = current; }
    return current;
  }

  function pdfTotalV68(payload) {
    let total = Number(payload?.totalPages || payload?.pdfPageCount || 0);
    try { if (!total && pdfDoc?.numPages) total = Number(pdfDoc.numPages); } catch (_) {}
    return Number.isFinite(total) && total > 0 ? total : 0;
  }

  async function setQueuedPdfPageV68(page) {
    const current = stagedV68();
    if (!current || current.type !== 'pdf') return;

    const total = pdfTotalV68(current);
    let next = Math.max(1, Number(page || 1));
    if (total) next = Math.min(total, next);
    if (next === Number(current.page || 1)) return;

    current.page = next;
    try { window.staged = cloneV68(current); } catch (_) { window.staged = current; }

    // Persist only the queued Preview page. Do not change Live until Enter / Go Live.
    try {
      const scene = typeof getActiveScene === 'function' ? getActiveScene() : null;
      if (scene?.items && Number.isInteger(current.sceneItemIndex) && scene.items[current.sceneItemIndex]) {
        scene.items[current.sceneItemIndex].page = next;
        if (typeof persistScenes === 'function') persistScenes();
      }
    } catch (_) {}

    try { if (typeof setSlideStatus === 'function') setSlideStatus(); } catch (_) {}
    try { if (typeof updateSlidePreviewActiveState === 'function') updateSlidePreviewActiveState(); } catch (_) {}
    try { if (typeof updateEmbeddedSlideActiveState === 'function') updateEmbeddedSlideActiveState(); } catch (_) {}

    // Use the newest wrapped renderer. It buffers the next page and swaps only after paint.
    try {
      if (typeof window.renderPreview === 'function') await window.renderPreview();
      else if (typeof renderPreview === 'function') await renderPreview();
    } catch (error) {
      console.warn('V68: Unable to render queued PDF page:', error);
    }
  }

  // Make every legacy PDF arrow/key path resolve to one authoritative setter.
  try { setPdfPage = setQueuedPdfPageV68; } catch (_) {}
  window.setPdfPage = setQueuedPdfPageV68;

  // Capture Preview PDF arrow buttons from all generations of the UI.
  document.addEventListener('click', event => {
    const current = stagedV68();
    if (!current || current.type !== 'pdf') return;
    const button = event.target?.closest?.('#preview-viewport button');
    if (!button) return;

    const aria = String(button.getAttribute('aria-label') || '').toLowerCase();
    const title = String(button.getAttribute('title') || '').toLowerCase();
    const cls = String(button.className || '').toLowerCase();
    const text = String(button.textContent || '').trim();

    const isPrev = aria.includes('previous') || title.includes('previous') || cls.includes('prev') || text === '‹' || text === '←';
    const isNext = aria.includes('next') || title.includes('next') || cls.includes('next') || text === '›' || text === '→';
    if (!isPrev && !isNext) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    setQueuedPdfPageV68((Number(current.page) || 1) + (isPrev ? -1 : 1));
  }, true);

  // Existing V67 keyboard listener calls setPdfPage; replacing the binding above
  // makes Left/Right/Up/Down reliable. Its Enter path still calls window.fireLive.

  const previousFireLiveV68 = window.fireLive;
  let fireLiveBusyV68 = false;
  window.fireLive = async function(...args) {
    if (fireLiveBusyV68) return;
    fireLiveBusyV68 = true;
    try {
      // V61 reads window.staged first. Keep it synchronized with the actual Preview
      // so switching away from a video cannot accidentally recommit the old video.
      syncWindowStagedV68();
      return typeof previousFireLiveV68 === 'function'
        ? await previousFireLiveV68.apply(this, args)
        : undefined;
    } finally {
      fireLiveBusyV68 = false;
    }
  };
})();
