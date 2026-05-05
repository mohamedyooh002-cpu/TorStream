(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  const API_BASE = '';
  const DEBOUNCE_MS = 450;
  const CONTROLS_HIDE_MS = 3000;

  // ── State ───────────────────────────────────────────────────────────────────
  let currentView = 'search';
  let currentMovieId = null;
  let currentMovieTitle = '';
  let currentStreamOnly = false;   // true when current player session is stream-only
  let hlsInstance = null;
  let controlsTimeout = null;
  let trackedPlays = new Set();
  let latestSearchResults = [];
  let progressByInfoHash = {};

  // ── Settings ─────────────────────────────────────────────────────────────────
  let streamOnlyMode = localStorage.getItem('torstream-stream-only') === 'true';

  function openSettingsModal() {
    var overlay = document.getElementById('settings-overlay');
    var toggle = document.getElementById('toggle-stream-only');
    if (toggle) toggle.checked = streamOnlyMode;
    if (overlay) overlay.classList.add('open');
  }
  window.openSettingsModal = openSettingsModal;

  function closeSettingsModal() {
    var overlay = document.getElementById('settings-overlay');
    if (overlay) overlay.classList.remove('open');
  }
  window.closeSettingsModal = closeSettingsModal;

  window.handleSettingsOverlayClick = function (e) {
    if (e.target === document.getElementById('settings-overlay')) closeSettingsModal();
  };

  window.onStreamOnlyToggle = function (checked) {
    streamOnlyMode = checked;
    localStorage.setItem('torstream-stream-only', checked ? 'true' : 'false');
  };

  function normalizeProgress(rawProgress) {
    var n = Number(rawProgress);
    if (!isFinite(n) || isNaN(n)) return null;
    // Some emitters send 0..1, others send 0..100
    if (n <= 1) n = n * 100;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  // ── Utility ─────────────────────────────────────────────────────────────────
  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str || '';
    return d.innerHTML;
  }

  function trunc(str, n) {
    if (!str) return '';
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  function fmtTime(s) {
    if (!s || isNaN(s)) return '0:00';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    return m + ':' + String(sec).padStart(2, '0');
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0, v = Number(bytes);
    if (isNaN(v)) return bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  }

  // ── View switcher ────────────────────────────────────────────────────────────
  function switchView(name) {
    currentView = name;
    ['search', 'library', 'player'].forEach(function (v) {
      var el = document.getElementById('view-' + v);
      var tab = document.getElementById('nav-' + v);
      if (el) el.classList.toggle('active', v === name);
      if (tab) tab.classList.toggle('active', v === name);
    });
    window.scrollTo(0, 0);
    if (name === 'library') loadLibrary();
    if (name === 'search') {
      var inp = document.getElementById('search-input');
      if (inp) setTimeout(function () { inp.focus(); }, 80);
    }
  }
  window.switchView = switchView;

  // ── API ──────────────────────────────────────────────────────────────────────
  async function apiSearch(q) {
    const res = await fetch(API_BASE + '/api/search?q=' + encodeURIComponent(q));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    // Backend returns { query, totalResults, results: [...] }
    return Array.isArray(data) ? data : (data.results || []);
  }

  async function apiMovies(params) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(API_BASE + '/api/movies?' + qs);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function apiMovie(id) {
    const res = await fetch(API_BASE + '/api/movies/' + encodeURIComponent(id));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function apiRequestDownload(magnetUri, infoHash, title, source) {
    const res = await fetch(API_BASE + '/api/request-download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ magnetUri, infoHash, title, source, streamOnly: streamOnlyMode }),
    });
    var body = null;
    try { body = await res.json(); } catch (_) {}
    if (!res.ok) {
      if (res.status === 429) {
        const ra = (body && body.retryAfter) || parseInt(res.headers.get('Retry-After') || '0', 10) || 0;
        return { error: ra > 0 ? ('Rate limited. Try again in ' + ra + 's') : 'Rate limited. Try again shortly.', status: 429 };
      }
      return { error: (body && body.error) || ('HTTP ' + res.status) };
    }
    return body;
  }

  async function apiRecordPlay(movieId) {
    try {
      await fetch(API_BASE + '/api/movies/' + encodeURIComponent(movieId) + '/play', { method: 'POST' });
    } catch (_) {}
  }

  // ── Search ───────────────────────────────────────────────────────────────────
  function initSearch() {
    var input = document.getElementById('search-input');
    var clear = document.getElementById('search-clear');
    var submit = document.getElementById('search-submit');
    if (!input) return;

    input.addEventListener('input', function () {
      var q = input.value.trim();
      if (clear) clear.classList.toggle('visible', q.length > 0);
      if (!q) { showSearchState('empty'); document.getElementById('search-results').innerHTML = ''; return; }
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') clearSearch();
      if (e.key === 'Enter') {
        e.preventDefault();
        submitSearch();
      }
    });

    if (submit) {
      submit.addEventListener('click', function () {
        submitSearch();
      });
    }

    lucide.createIcons();
    showSearchState('empty');
  }

  window.submitSearch = function () {
    var input = document.getElementById('search-input');
    if (!input) return;
    var q = input.value.trim();
    if (!q) {
      showSearchState('empty');
      document.getElementById('search-results').innerHTML = '';
      return;
    }
    runSearch(q);
  };

  window.clearSearch = function () {
    var input = document.getElementById('search-input');
    if (input) { input.value = ''; input.focus(); }
    var clear = document.getElementById('search-clear');
    if (clear) clear.classList.remove('visible');
    document.getElementById('search-results').innerHTML = '';
    showSearchState('empty');
  };

  function showSearchState(state) {
    ['empty', 'loading', 'none'].forEach(function (s) {
      var el = document.getElementById('search-state-' + s);
      if (el) el.style.display = s === state ? '' : 'none';
    });
    if (state !== 'loading') document.getElementById('search-results').style.display = state === 'none' ? 'none' : '';
  }

  async function runSearch(q) {
    showSearchState('loading');
    document.getElementById('search-results').innerHTML = '';
    try {
      var results = await apiSearch(q);
      latestSearchResults = Array.isArray(results) ? results : [];
      if (!Array.isArray(results) || results.length === 0) {
        showSearchState('none');
        return;
      }
      showSearchState(null);
      document.getElementById('search-results').style.display = '';
      var grid = document.getElementById('search-results');
      grid.innerHTML = '';
      results.forEach(function (r, i) { grid.appendChild(buildSearchCard(r, i)); });
      lucide.createIcons();
    } catch (err) {
      console.error('search error', err);
      showSearchState('none');
    }
  }

  function buildSearchCard(result, index) {
    var meta = result.metadata || {};
    var poster = meta.poster || result.poster || '';
    var title = meta.title || result.title || 'Unknown';
    var year = meta.year || result.year || '';
    var imdb = meta.imdb_rating || '';
    var isReady = result.cached && result.status === 'ready';

    var card = document.createElement('div');
    card.className = 'movie-card';

    // Poster
    var posterDiv = document.createElement('div');
    posterDiv.className = 'card-poster';

    if (poster && poster !== 'N/A') {
      var img = document.createElement('img');
      img.src = poster;
      img.alt = title;
      img.loading = 'lazy';
      img.onerror = function () {
        this.parentNode.classList.add('card-poster-placeholder');
        this.parentNode.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="m7 8 10 8M7 16 17 8"/></svg>';
      };
      posterDiv.appendChild(img);
    } else {
      posterDiv.classList.add('card-poster-placeholder');
      posterDiv.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="m8 10 8 4-8 4V10z"/></svg>';
    }

    if (result.quality) {
      var qb = document.createElement('span');
      qb.className = 'badge badge-quality';
      qb.textContent = result.quality;
      posterDiv.appendChild(qb);
    }
    if (isReady) {
      var rb = document.createElement('span');
      rb.className = 'badge badge-ready';
      rb.textContent = 'READY';
      posterDiv.appendChild(rb);
    }
    card.appendChild(posterDiv);

    // Body
    var body = document.createElement('div');
    body.className = 'card-body';

    var titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    titleEl.textContent = trunc(title, 50);
    titleEl.title = title;
    body.appendChild(titleEl);

    var meta2 = document.createElement('div');
    meta2.className = 'card-meta';
    if (year) {
      var yearEl = document.createElement('span');
      yearEl.className = 'card-year';
      yearEl.textContent = year;
      meta2.appendChild(yearEl);
    }
    if (imdb && imdb !== 'N/A') {
      var imdbEl = document.createElement('span');
      imdbEl.className = 'card-imdb';
      imdbEl.textContent = '★ ' + imdb;
      meta2.appendChild(imdbEl);
    }
    body.appendChild(meta2);

    var meta3 = document.createElement('div');
    meta3.className = 'card-meta';
    if (result.seeders) {
      var seedEl = document.createElement('span');
      seedEl.className = 'card-seeds';
      seedEl.textContent = '▲ ' + result.seeders;
      meta3.appendChild(seedEl);
    }
    if (result.size) {
      var sizeEl = document.createElement('span');
      sizeEl.className = 'card-size';
      sizeEl.textContent = result.size;
      meta3.appendChild(sizeEl);
    }
    body.appendChild(meta3);
    card.appendChild(body);

    // Action
    var action = document.createElement('div');
    action.className = 'card-action';
    var btn = document.createElement('button');
    btn.dataset.infoHash = String(result.infoHash || '').toLowerCase();
    if (result.movieId) btn.dataset.movieId = result.movieId;
    btn.className = 'btn-stream ' + (isReady ? 'watch' : 'stream');

    if (isReady && result.movieId) {
      btn.innerHTML = '<i data-lucide="play"></i> Watch Now';
      btn.onclick = function () { openPlayer(result.movieId, title); };
    } else {
      btn.innerHTML = '<i data-lucide="radio"></i> Stream';
      btn.onclick = function () { handleStream(result, btn, title); };
    }
    action.appendChild(btn);
    card.appendChild(action);

    return card;
  }

  async function handleStream(result, btn, title) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-2" class="spin-icon"></i> Starting…';
    lucide.createIcons();

    var resp = await apiRequestDownload(result.magnetUri, result.infoHash, title || result.title, result.source || 'search');

    if (resp && resp.error) {
      btn.disabled = false;
      btn.className = 'btn-stream err';
      btn.innerHTML = '<i data-lucide="alert-circle"></i> ' + esc(resp.error);
      lucide.createIcons();
      setTimeout(function () {
        btn.className = 'btn-stream stream';
        btn.innerHTML = '<i data-lucide="radio"></i> Stream';
        lucide.createIcons();
      }, 4000);
      return;
    }

    if (resp && resp.movieId) {
      btn.innerHTML = '<i data-lucide="check"></i> Opening…';
      lucide.createIcons();
      setTimeout(function () {
        openPlayer(resp.movieId, title, resp.streamOnly === true);

        // Keep the button usable after returning from player instead of leaving it on "Opening…"
        btn.disabled = false;
        btn.dataset.movieId = resp.movieId;
        btn.className = 'btn-stream stream';
        btn.innerHTML = '<i data-lucide="radio"></i> Watch Live';
        btn.onclick = function () { openPlayer(resp.movieId, title, false); };
        lucide.createIcons();
      }, 400);
      return;
    }

    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="radio"></i> Stream';
    lucide.createIcons();
  }

  // ── Library ─────────────────────────────────────────────────────────────────
  async function loadLibrary() {
    var grid = document.getElementById('library-grid');
    var loadingEl = document.getElementById('library-state-loading');
    var emptyEl = document.getElementById('library-state-empty');
    var countEl = document.getElementById('library-count-label');

    grid.innerHTML = '';
    if (loadingEl) loadingEl.style.display = '';
    if (emptyEl) emptyEl.style.display = 'none';

    try {
      var data = await apiMovies({ limit: '200', sort: 'added_at' });
      var movies = (data.data || data.movies || data || []);

      if (loadingEl) loadingEl.style.display = 'none';
      if (countEl) countEl.textContent = movies.length + ' item' + (movies.length !== 1 ? 's' : '');

      updateLibraryBadge(movies.length);

      if (movies.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        return;
      }

      movies.forEach(function (m, i) { grid.appendChild(buildLibraryCard(m, i)); });
      lucide.createIcons();
    } catch (err) {
      console.error('library load error', err);
      if (loadingEl) loadingEl.style.display = 'none';
      if (emptyEl) { emptyEl.style.display = ''; emptyEl.querySelector('p').textContent = 'Failed to load library.'; }
    }
  }

  function updateLibraryBadge(count) {
    var badge = document.getElementById('library-badge');
    if (!badge) return;
    if (count > 0) { badge.textContent = count; badge.style.display = ''; }
    else { badge.style.display = 'none'; }
  }

  function buildLibraryCard(movie, index) {
    var posterUrl = movie.poster || (API_BASE + '/api/poster/' + (movie._id || movie.id));
    var movieId = movie._id || movie.id;
    var title = movie.title || 'Unknown';
    var status = (movie.status || '').toLowerCase();
    var progressKey = (movie.info_hash || '').toLowerCase();
    var progress = Object.prototype.hasOwnProperty.call(progressByInfoHash, progressKey)
      ? progressByInfoHash[progressKey]
      : null;

    var card = document.createElement('div');
    card.className = 'movie-card';
    card.style.cursor = status === 'ready' ? 'pointer' : 'default';
    if (status === 'ready' || status === 'downloading' || status === 'converting') {
      card.onclick = function () { openPlayer(movieId, title); };
    }

    var posterDiv = document.createElement('div');
    posterDiv.className = 'card-poster';

    var img = document.createElement('img');
    img.src = posterUrl;
    img.alt = title;
    img.loading = 'lazy';
    img.onerror = function () {
      this.parentNode.classList.add('card-poster-placeholder');
      this.parentNode.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="20" height="20" rx="2"/><path d="m8 10 8 4-8 4V10z"/></svg>';
    };
    posterDiv.appendChild(img);

    if (movie.quality) {
      var qb = document.createElement('span');
      qb.className = 'badge badge-quality';
      qb.textContent = movie.quality;
      posterDiv.appendChild(qb);
    }
    var rb = document.createElement('span');
    rb.className = 'badge badge-ready';
    rb.textContent = status ? status.toUpperCase() : 'READY';
    posterDiv.appendChild(rb);

    card.appendChild(posterDiv);

    var body = document.createElement('div');
    body.className = 'card-body';

    var titleEl = document.createElement('div');
    titleEl.className = 'card-title';
    titleEl.textContent = trunc(title, 50);
    titleEl.title = title;
    body.appendChild(titleEl);

    var meta = document.createElement('div');
    meta.className = 'card-meta';
    if (movie.year) {
      var yearEl = document.createElement('span');
      yearEl.className = 'card-year';
      yearEl.textContent = movie.year;
      meta.appendChild(yearEl);
    }
    if (movie.imdb_rating) {
      var imdbEl = document.createElement('span');
      imdbEl.className = 'card-imdb';
      imdbEl.textContent = '★ ' + movie.imdb_rating;
      meta.appendChild(imdbEl);
    }

    var statusRow = document.createElement('div');
    statusRow.className = 'library-status';
    var statusLabel = document.createElement('span');
    statusLabel.textContent = status === 'downloading' ? 'Downloading' : (status === 'converting' ? 'Converting' : (status === 'error' ? 'Error' : 'Ready'));
    statusRow.appendChild(statusLabel);

    var statusPct = document.createElement('span');
    statusPct.dataset.progressTextFor = String(movie.info_hash || '').toLowerCase();
    statusPct.textContent = (status === 'downloading' || status === 'converting')
      ? (progress === null ? '...' : (Math.round(progress) + '%'))
      : '';
    statusRow.appendChild(statusPct);
    body.appendChild(statusRow);

    if (status === 'downloading' || status === 'converting') {
      var bar = document.createElement('div');
      bar.className = 'library-progress';
      var fill = document.createElement('div');
      fill.className = 'library-progress-fill';
      fill.dataset.progressFor = String(movie.info_hash || '').toLowerCase();
      fill.style.width = (progress === null ? 0 : Math.max(0, Math.min(100, progress))) + '%';
      bar.appendChild(fill);
      body.appendChild(bar);
    }

    body.appendChild(meta);
    card.appendChild(body);

    var action = document.createElement('div');
    action.className = 'card-action';
    var btn = document.createElement('button');
    if (status === 'ready') {
      btn.className = 'btn-stream watch';
      btn.innerHTML = '<i data-lucide="play"></i> Play';
      btn.onclick = function (e) { e.stopPropagation(); openPlayer(movieId, title); };
    } else if (status === 'downloading' || status === 'converting') {
      btn.className = 'btn-stream stream';
      btn.innerHTML = '<i data-lucide="radio"></i> Watch Live';
      btn.onclick = function (e) { e.stopPropagation(); openPlayer(movieId, title); };
    } else {
      btn.className = 'btn-stream err';
      btn.innerHTML = '<i data-lucide="alert-circle"></i> Unavailable';
      btn.disabled = true;
    }
    action.appendChild(btn);
    card.appendChild(action);

    return card;
  }

  // ── Player ───────────────────────────────────────────────────────────────────
  function openPlayer(movieId, title, isStreamOnly) {
    currentMovieId = movieId;
    currentMovieTitle = title || '';
    currentStreamOnly = isStreamOnly === true;
    switchView('player');
    initPlayer(movieId, title);
  }
  window.openPlayer = openPlayer;

  function initPlayer(movieId, title) {
    destroyHls();
    var video = document.getElementById('video-player');
    if (!video) return;
    video.pause();
    video.removeAttribute('src');
    video.load();

    var titleEl = document.getElementById('player-title');
    if (titleEl) titleEl.textContent = title || '';

    var endOverlay = document.getElementById('video-end-overlay');
    if (endOverlay) endOverlay.classList.add('hidden');
    var endTitle = document.getElementById('video-end-title');
    if (endTitle) endTitle.textContent = title || '';

    hidePlayerLoading();

    var hlsUrl = API_BASE + '/stream/' + movieId + '/master.m3u8';
    var directUrl = API_BASE + '/stream/' + movieId + '/direct';
    video.dataset.directUrl = directUrl;

    // Try HLS first, fall back to direct
    apiMovie(movieId).then(function (m) {
      if (m && m.hls_path && typeof Hls !== 'undefined' && Hls.isSupported()) {
        startHls(video, hlsUrl);
      } else {
        startDirect(video, directUrl);
      }
    }).catch(function () {
      startDirect(video, directUrl);
    });

    setupPlayerEvents(video);
  }

  function startDirect(video, url) {
    destroyHls();
    showPlayerLoading();
    video.src = url;
    video.load();
    var retryTimer = null;
    video.addEventListener('canplay', function onCp() {
      hidePlayerLoading();
      video.play().catch(function () {});
      video.removeEventListener('canplay', onCp);
    });
    video.addEventListener('waiting', function () { showPlayerLoading(); });
    video.addEventListener('playing', function () { hidePlayerLoading(); });
    video.addEventListener('error', function () {
      showPlayerLoading();
      if (retryTimer) return;
      retryTimer = setTimeout(function () {
        retryTimer = null;
        if (currentMovieId) {
          apiMovie(currentMovieId).then(function (m) {
            if (m && (m.status === 'downloading' || m.status === 'ready')) {
              video.load();
            } else {
              showPlayerError('Playback failed — file may not be ready yet.');
            }
          }).catch(function () {
            showPlayerError('Playback failed.');
          });
        }
      }, 4000);
    });
  }

  function startHls(video, url) {
    destroyHls();
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      var hls = new Hls({ maxBufferLength: 30, startLevel: -1, progressive: true });
      hlsInstance = hls;
      hls.loadSource(url);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, function () {
        video.play().catch(function () {});
        hidePlayerLoading();
      });
      hls.on(Hls.Events.ERROR, function (e, data) {
        if (data.fatal) {
          hls.destroy(); hlsInstance = null;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            var hls2 = new Hls(); hlsInstance = hls2;
            hls2.loadSource(url); hls2.attachMedia(video);
          } else {
            var du = video.dataset.directUrl;
            if (du) startDirect(video, du);
            else showPlayerError('Playback failed.');
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.addEventListener('loadedmetadata', function () {
        video.play().catch(function () {});
        hidePlayerLoading();
      });
    } else {
      startDirect(video, video.dataset.directUrl);
    }
  }

  function destroyHls() {
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  }

  function showPlayerLoading() { var el = document.getElementById('player-loading'); if (el) el.classList.remove('hidden'); }
  function hidePlayerLoading() { var el = document.getElementById('player-loading'); if (el) el.classList.add('hidden'); }

  function showPlayerError(msg) {
    hidePlayerLoading();
    var w = document.getElementById('player-wrapper');
    var ex = document.getElementById('player-error-msg');
    if (ex) ex.remove();
    if (!w) return;
    var d = document.createElement('div');
    d.id = 'player-error-msg';
    d.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:30;background:rgba(0,0,0,0.75);color:#fff;font-size:15px;text-align:center;padding:24px;';
    d.textContent = msg;
    w.appendChild(d);
  }

  window.exitPlayer = function () {
    var video = document.getElementById('video-player');
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    destroyHls();
    clearTimeout(controlsTimeout);

    // Clean up stream-only session (fire-and-forget)
    if (currentStreamOnly && currentMovieId) {
      var cleanupId = currentMovieId;
      fetch(API_BASE + '/api/movies/' + encodeURIComponent(cleanupId) + '/stream-cleanup', { method: 'DELETE' })
        .catch(function () { /* best-effort */ });
      currentStreamOnly = false;
    }

    switchView('search');
  };

  window.togglePlay = function () {
    var video = document.getElementById('video-player');
    if (!video) return;
    if (video.paused || video.ended) video.play().catch(function () {});
    else video.pause();
    updatePlayIcon();
  };

  function updatePlayIcon() {
    var video = document.getElementById('video-player');
    if (!video) return;
    var paused = video.paused || video.ended;
    var name = paused ? 'play' : 'pause';
    var center = document.getElementById('player-center-play');
    var pp = document.getElementById('icon-pp');
    var ip = document.getElementById('icon-play');
    if (center) {
      center.innerHTML = '<i data-lucide="' + name + '" style="width:30px;height:30px;' + (paused ? 'margin-left:3px;' : '') + '"></i>';
      center.style.opacity = '1';
    }
    if (pp) pp.setAttribute('data-lucide', name);
    if (ip) ip.setAttribute('data-lucide', name);
    lucide.createIcons();
    if (center && !paused) setTimeout(function () { center.style.opacity = '0'; }, 700);
  }

  window.toggleMute = function () {
    var video = document.getElementById('video-player');
    var slider = document.getElementById('volume-slider');
    if (!video) return;
    video.muted = !video.muted;
    if (slider) slider.value = video.muted ? '0' : video.volume;
    updateVolumeIcon();
  };

  function updateVolumeIcon() {
    var video = document.getElementById('video-player');
    var icon = document.getElementById('icon-volume');
    if (!video || !icon) return;
    var name = (video.muted || video.volume === 0) ? 'volume-x' : (video.volume < 0.5 ? 'volume-1' : 'volume-2');
    icon.setAttribute('data-lucide', name);
    lucide.createIcons();
  }

  window.toggleFullscreen = function () {
    var c = document.getElementById('player-wrapper');
    if (!c) return;
    if (!document.fullscreenElement) {
      var fn = c.requestFullscreen || c.webkitRequestFullscreen || c.msRequestFullscreen;
      if (fn) fn.call(c);
    } else {
      var xf = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
      if (xf) xf.call(document);
    }
  };

  function setupPlayerEvents(video) {
    var overlay = document.getElementById('player-overlay');
    var wrapper = document.getElementById('player-wrapper');

    function showControls() {
      if (overlay) { overlay.classList.remove('hide-controls'); }
      clearTimeout(controlsTimeout);
      controlsTimeout = setTimeout(function () {
        if (!video.paused) overlay.classList.add('hide-controls');
      }, CONTROLS_HIDE_MS);
    }

    if (wrapper) {
      wrapper.addEventListener('mousemove', showControls);
      wrapper.addEventListener('touchstart', showControls);
      wrapper.addEventListener('click', function (e) {
        if (e.target === video || e.target === overlay) window.togglePlay();
      });
    }

    // Time update
    video.addEventListener('timeupdate', function () {
      var ct = document.getElementById('player-current-time');
      var dur = document.getElementById('player-duration');
      var played = document.getElementById('progress-played');
      var thumb = document.getElementById('progress-thumb');
      if (ct) ct.textContent = fmtTime(video.currentTime);
      if (dur) dur.textContent = fmtTime(video.duration);
      if (video.duration) {
        var pct = (video.currentTime / video.duration) * 100;
        if (played) played.style.width = pct + '%';
        if (thumb) thumb.style.left = pct + '%';
      }
    });

    // Buffered
    video.addEventListener('progress', function () {
      var buf = document.getElementById('progress-buffered');
      if (buf && video.buffered.length > 0 && video.duration) {
        buf.style.width = (video.buffered.end(video.buffered.length - 1) / video.duration * 100) + '%';
      }
    });

    // Volume slider
    var volSlider = document.getElementById('volume-slider');
    if (volSlider) {
      volSlider.value = '1';
      volSlider.addEventListener('input', function () {
        video.volume = parseFloat(this.value);
        video.muted = parseFloat(this.value) === 0;
        updateVolumeIcon();
      });
    }

    // Play state
    video.addEventListener('play', function () {
      if (currentMovieId && !trackedPlays.has(currentMovieId)) {
        trackedPlays.add(currentMovieId);
        apiRecordPlay(currentMovieId);
      }
      updatePlayIcon();
      showControls();
    });
    video.addEventListener('pause', function () { updatePlayIcon(); showControls(); });
    video.addEventListener('waiting', showPlayerLoading);
    video.addEventListener('canplay', hidePlayerLoading);
    video.addEventListener('ended', function () {
      var eo = document.getElementById('video-end-overlay');
      if (eo) eo.classList.remove('hidden');
      updatePlayIcon();
      showControls();
    });

    // Progress bar seeking
    var prog = document.getElementById('progress-container');
    if (prog) {
      var seeking = false;
      function seekAt(e) {
        var rect = prog.getBoundingClientRect();
        var cx = e.touches ? e.touches[0].clientX : e.clientX;
        var pct = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
        if (video.duration) video.currentTime = pct * video.duration;
      }
      prog.addEventListener('mousedown', function (e) { seeking = true; seekAt(e); });
      document.addEventListener('mousemove', function (e) { if (seeking) seekAt(e); });
      document.addEventListener('mouseup', function () { seeking = false; });
      prog.addEventListener('touchstart', function (e) { seeking = true; seekAt(e); e.preventDefault(); });
      document.addEventListener('touchmove', function (e) { if (seeking) seekAt(e); });
      document.addEventListener('touchend', function () { seeking = false; });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', function (e) {
      if (currentView !== 'player') return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      switch (e.key) {
        case ' ': e.preventDefault(); window.togglePlay(); break;
        case 'ArrowRight': if (video.duration) video.currentTime = Math.min(video.duration, video.currentTime + 10); break;
        case 'ArrowLeft':  video.currentTime = Math.max(0, video.currentTime - 10); break;
        case 'ArrowUp':    video.volume = Math.min(1, video.volume + 0.1); if (volSlider) volSlider.value = video.volume; updateVolumeIcon(); break;
        case 'ArrowDown':  video.volume = Math.max(0, video.volume - 0.1); if (volSlider) volSlider.value = video.volume; updateVolumeIcon(); break;
        case 'm': case 'M': window.toggleMute(); break;
        case 'f': case 'F': window.toggleFullscreen(); break;
        case 'Escape': window.exitPlayer(); break;
      }
    });
  }

  // ── Socket.IO for live progress updates ──────────────────────────────────────
  function initSocket() {
    if (typeof io === 'undefined') return;
    var socket = io({ transports: ['websocket'] });

    function handleProgressEvent(payload) {
      var evt = payload && payload.data ? payload.data : payload;
      if (!evt || !evt.infoHash) return;

      var hash = String(evt.infoHash).toLowerCase();
      var pct = normalizeProgress(evt.progress);
      if (pct === null) return;
      progressByInfoHash[hash] = pct;

      var fills = document.querySelectorAll('[data-progress-for="' + hash + '"]');
      fills.forEach(function (el) { el.style.width = pct + '%'; });
      var labels = document.querySelectorAll('[data-progress-text-for="' + hash + '"]');
      labels.forEach(function (el) { el.textContent = pct + '%'; });

      if (currentView === 'library' && evt.status === 'ready') {
        loadLibrary();
      }

      if (evt.status === 'ready') {
        refreshSearchResultButtons(hash);
        apiMovies({ limit: '200' }).then(function (d) {
          updateLibraryBadge((d.data || d.movies || d || []).length);
        }).catch(function () {});
      }
    }

    socket.on('download-progress', handleProgressEvent);
    socket.on('conversion-progress', handleProgressEvent);
  }

  function refreshSearchResultButtons(infoHash) {
    if (!infoHash) return;
    var hash = String(infoHash).toLowerCase();
    var btns = document.querySelectorAll('button[data-info-hash="' + hash + '"]');
    btns.forEach(function (btn) {
      btn.className = 'btn-stream watch';
      btn.innerHTML = '<i data-lucide="play"></i> Watch Now';
      btn.disabled = false;
      btn.onclick = function () {
        apiMovies({ limit: '200', sort: 'added_at' }).then(function (d) {
          var items = (d.data || d.movies || d || []);
          var found = items.find(function (m) {
            return String(m.info_hash || '').toLowerCase() === hash;
          });
          if (found) openPlayer(found._id || found.id, found.title || '');
        }).catch(function () {});
      };
    });
    lucide.createIcons();
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    lucide.createIcons();
    initSearch();
    initSocket();

    // Load library badge count silently on startup
    apiMovies({ limit: '200' }).then(function (d) {
      updateLibraryBadge((d.data || d.movies || d || []).length);
    }).catch(function () {});
  }

  document.addEventListener('DOMContentLoaded', init);

}());
