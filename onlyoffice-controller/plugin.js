(() => {
  'use strict';

  const CHANNEL_NAME = 'jil_onlyoffice_presenter_sync_v2';
  const channel = new BroadcastChannel(CHANNEL_NAME);
  let currentIndex = 0;

  function post(message) {
    channel.postMessage(Object.assign({ source: 'onlyoffice-plugin', at: Date.now() }, message || {}));
  }

  function readSlideMeta(index) {
    try {
      Asc.scope.jilSlideIndex = Math.max(0, Number(index) || 0);
      window.Asc.plugin.callCommand(function () {
        try {
          const presentation = Api.GetPresentation();
          const slides = presentation.GetAllSlides();
          const targetIndex = Math.max(0, Math.min(slides.length - 1, Number(Asc.scope.jilSlideIndex) || 0));
          const slide = presentation.GetSlideByIndex(targetIndex);
          let notes = '';
          try {
            const notesPage = slide && slide.GetNotesPage ? slide.GetNotesPage() : null;
            const bodyShape = notesPage && notesPage.GetBodyShape ? notesPage.GetBodyShape() : null;
            const content = bodyShape && bodyShape.GetContent ? bodyShape.GetContent() : (bodyShape && bodyShape.GetDocContent ? bodyShape.GetDocContent() : null);
            if (content && content.GetText) notes = String(content.GetText() || '');
          } catch (_) {}
          return { index: targetIndex, count: slides.length, notes: notes };
        } catch (_) {
          return { index: Number(Asc.scope.jilSlideIndex) || 0, count: 0, notes: '' };
        }
      }, false, false, function (result) {
        if (result) post({ type: 'meta', index: Number(result.index) || 0, count: Number(result.count) || 0, notes: String(result.notes || '') });
      });
    } catch (_) {}
  }

  function goTo(index) {
    const n = Math.max(0, Number(index) || 0);
    currentIndex = n;
    try { window.Asc.plugin.executeMethod('GoToSlide', [n]); } catch (_) {}
    try { window.Asc.plugin.executeMethod('GoToSlideInSlideShow', [n]); } catch (_) {}
    readSlideMeta(n);
  }

  function attachEvents() {
    try {
      window.Asc.plugin.attachEditorEvent('onChangeCurrentSlide', function (index) {
        currentIndex = Math.max(0, Number(index) || 0);
        post({ type: 'slidechange', index: currentIndex, sourceEvent: 'editor' });
        readSlideMeta(currentIndex);
      });
    } catch (_) {}

    try {
      window.Asc.plugin.attachEditorEvent('onSlideShowSlideChanged', function (data) {
        currentIndex = Math.max(0, Number(data && data.slideIndex) || 0);
        post({ type: 'slidechange', index: currentIndex, sourceEvent: 'slideshow' });
        readSlideMeta(currentIndex);
      });
    } catch (_) {}

    try { window.Asc.plugin.attachEditorEvent('onSlideShowBegin', function () { post({ type: 'showstate', running: true }); }); } catch (_) {}
    try { window.Asc.plugin.attachEditorEvent('onSlideShowEnd', function () { post({ type: 'showstate', running: false }); }); } catch (_) {}
    try { window.Asc.plugin.attachEditorEvent('onDocumentContentReady', function () { post({ type: 'ready' }); readSlideMeta(currentIndex); }); } catch (_) {}
  }

  channel.onmessage = function (event) {
    const msg = event && event.data || {};
    if (!msg || msg.source === 'onlyoffice-plugin') return;
    try {
      switch (msg.type) {
        case 'goto': goTo(msg.index); break;
        case 'next': window.Asc.plugin.executeMethod('GoToNextSlideInSlideShow', []); break;
        case 'previous': window.Asc.plugin.executeMethod('GoToPreviousSlideInSlideShow', []); break;
        case 'pause': window.Asc.plugin.executeMethod('PauseSlideShow', []); break;
        case 'resume': window.Asc.plugin.executeMethod('ResumeSlideShow', []); break;
        case 'end': window.Asc.plugin.executeMethod('EndSlideShow', []); break;
        case 'request-meta': readSlideMeta(Number(msg.index) || currentIndex); break;
      }
    } catch (_) {}
  };

  window.Asc.plugin.init = function () {
    attachEvents();
    post({ type: 'ready' });
    setTimeout(function () { readSlideMeta(currentIndex); }, 400);
  };

  window.Asc.plugin.button = function () {};
})();
