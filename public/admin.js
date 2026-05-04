(function () {
  'use strict';

  // ── DOM references ──────────────────────────────────────────────────────
  const adminLogin = document.getElementById('admin-login');
  const adminDashboard = document.getElementById('admin-dashboard');
  const tabMovies = document.getElementById('tab-movies');
  const tabDownloads = document.getElementById('tab-downloads');
  const tabSearch = document.getElementById('tab-search');
  const tabDisk = document.getElementById('tab-disk');
  const confirmModal = document.getElementById('confirm-modal');

  // ── State ───────────────────────────────────────────────────────────────
  let moviesPage = 1;
  let moviesStatusFilter = '';
  let moviesSort = '';
  let socket = null;
  let statsInterval = null;
  let downloadsInterval = null;

  // ── Utility helpers ─────────────────────────────────────────────────────

  function getToken() {
    return sessionStorage.getItem('admin_token');
  }

  function setToken(token) {
    sessionStorage.setItem('admin_token', token);
  }

  function removeToken() {
    sessionStorage.removeItem('admin_token');
  }

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let val = Number(bytes);
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return val.toFixed(i === 0 ? 0 : 2) + ' ' + units[i];
  }

  function formatDate(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  }

  function formatSpeed(bps) {
    if (!bps || bps === 0) return '0 MB/s';
    return formatBytes(bps) + '/s';
  }

  function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function showToast(message, type) {
    type = type || 'error';
    let container = document.getElementById('toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toast-container';
      container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:10000;display:flex;flex-direction:column;gap:8px;';
      document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.style.cssText =
      'padding:12px 20px;border-radius:8px;color:#fff;font-size:14px;max-width:400px;word-wrap:break-word;box-shadow:0 4px 12px rgba(0,0,0,0.3);transition:opacity 0.3s;';
    if (type === 'success') {
      toast.style.background = '#22c55e';
    } else if (type === 'warning') {
      toast.style.background = '#f59e0b';
    } else {
      toast.style.background = '#ef4444';
    }
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = '0';
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 300);
    }, 4000);
  }

  // ── API helper ──────────────────────────────────────────────────────────

  function adminFetch(url, options) {
    options = options || {};
    const token = getToken();
    const headers = Object.assign({}, options.headers || {});
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    options.headers = headers;
    return fetch(url, options).then(function (response) {
      if (response.status === 401) {
        doLogout();
        throw new Error('Session expired. Please log in again.');
      }
      return response;
    });
  }

  // ── Authentication ──────────────────────────────────────────────────────

  function showLogin() {
    adminLogin.style.display = '';
    adminDashboard.style.display = 'none';
  }

  function showDashboard() {
    adminLogin.style.display = 'none';
    adminDashboard.style.display = '';
  }

  function doLogout() {
    removeToken();
    clearAllIntervals();
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    showLogin();
  }

  function checkExistingSession() {
    const token = getToken();
    if (!token) {
      showLogin();
      return;
    }
    adminFetch('/api/admin/dashboard')
      .then(function (res) {
        if (!res.ok) throw new Error('Invalid session');
        return res.json();
      })
      .then(function (data) {
        showDashboard();
        loadDashboardStats(data);
        setupRealtime();
        startAutoRefresh();
        switchTab('movies');
      })
      .catch(function () {
        doLogout();
      });
  }

  function handleLogin(e) {
    e.preventDefault();
    const usernameEl = document.getElementById('login-username');
    const passwordEl = document.getElementById('login-password');
    const errorEl = document.getElementById('login-error');
    if (errorEl) errorEl.textContent = '';

    const username = usernameEl ? usernameEl.value.trim() : '';
    const password = passwordEl ? passwordEl.value : '';

    if (!username || !password) {
      if (errorEl) errorEl.textContent = 'Please enter username and password.';
      return;
    }

    fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            throw new Error(data.error || data.message || 'Login failed');
          }
          return data;
        });
      })
      .then(function (data) {
        setToken(data.token);
        showDashboard();
        loadDashboardStats();
        setupRealtime();
        startAutoRefresh();
        switchTab('movies');
      })
      .catch(function (err) {
        if (errorEl) errorEl.textContent = err.message || 'Login failed';
      });
  }

  // ── Auto-refresh intervals ──────────────────────────────────────────────

  function clearAllIntervals() {
    if (statsInterval) clearInterval(statsInterval);
    if (downloadsInterval) clearInterval(downloadsInterval);
    statsInterval = null;
    downloadsInterval = null;
  }

  function startAutoRefresh() {
    clearAllIntervals();
    statsInterval = setInterval(function () {
      loadDashboardStats();
    }, 30000);
    downloadsInterval = setInterval(function () {
      loadDownloads();
    }, 5000);
  }

  // ── Realtime (Socket.IO) ────────────────────────────────────────────────

  function setupRealtime() {
    try {
      socket = io({ transports: ['websocket'] });
      socket.on('download-progress', function (data) {
        updateDownloadRow(data);
      });
    } catch (e) {
      // Socket.IO not available; fallback to polling
    }
  }

  // ── Dashboard stats ─────────────────────────────────────────────────────

  function loadDashboardStats(cachedData) {
    const promise = cachedData
      ? Promise.resolve(cachedData)
      : adminFetch('/api/admin/dashboard').then(function (r) { return r.json(); });

    promise
      .then(function (data) {
        setTextContent('stat-total-movies', data.totalMovies);
        setTextContent('stat-cache-size', formatBytes(data.cacheSize));
        setTextContent('stat-disk-free', formatBytes(data.diskFree));
        setTextContent('stat-active-downloads', data.activeDownloads);
        setTextContent('stat-failed-jobs', data.failedJobs);
        callLucide();
      })
      .catch(function (err) {
        showToast('Failed to load dashboard stats: ' + err.message);
      });
  }

  function setTextContent(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  // ── Tab switching ───────────────────────────────────────────────────────

  function switchTab(tabName) {
    var tabs = [
      { el: tabMovies, name: 'movies' },
      { el: tabDownloads, name: 'downloads' },
      { el: tabSearch, name: 'search' },
      { el: tabDisk, name: 'disk' }
    ];
    tabs.forEach(function (t) {
      if (t.el) {
        t.el.style.display = t.name === tabName ? '' : 'none';
      }
    });
    // Highlight active nav button
    document.querySelectorAll('[data-tab]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabName);
    });
    // Load data
    if (tabName === 'movies') loadMovies();
    if (tabName === 'downloads') loadDownloads();
    if (tabName === 'search') { /* loaded on user action */ }
    if (tabName === 'disk') loadDisk();
  }

  // ── Movies Tab ──────────────────────────────────────────────────────────

  function loadMovies() {
    var params = [];
    params.push('page=' + moviesPage);
    params.push('limit=50');
    if (moviesStatusFilter) params.push('status=' + encodeURIComponent(moviesStatusFilter));
    if (moviesSort) params.push('sort=' + encodeURIComponent(moviesSort));

    adminFetch('/api/admin/movies?' + params.join('&'))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        renderMoviesTable(data);
        callLucide();
      })
      .catch(function (err) {
        showToast('Failed to load movies: ' + err.message);
      });
  }

  function renderMoviesTable(data) {
    var tbody = document.getElementById('movies-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    var movies = data.movies || data || [];
    var totalPages = data.totalPages || 1;
    var currentPage = data.page || moviesPage;

    movies.forEach(function (movie) {
      var tr = document.createElement('tr');

      // ID
      var tdId = document.createElement('td');
      tdId.textContent = movie.id || movie._id || '';
      tr.appendChild(tdId);

      // Title
      var tdTitle = document.createElement('td');
      tdTitle.textContent = movie.title || '';
      tr.appendChild(tdTitle);

      // Info Hash
      var tdHash = document.createElement('td');
      tdHash.textContent = movie.infoHash || '';
      tr.appendChild(tdHash);

      // Size
      var tdSize = document.createElement('td');
      tdSize.textContent = formatBytes(movie.sizeBytes || movie.size || 0);
      tr.appendChild(tdSize);

      // Status badge
      var tdStatus = document.createElement('td');
      var badge = document.createElement('span');
      badge.classList.add('badge');
      var status = (movie.status || '').toLowerCase();
      if (status === 'ready') {
        badge.classList.add('badge-green');
      } else if (status === 'downloading' || status === 'converting') {
        badge.classList.add('badge-yellow');
      } else if (status === 'error') {
        badge.classList.add('badge-red');
      }
      badge.textContent = movie.status || '';
      tdStatus.appendChild(badge);
      tr.appendChild(tdStatus);

      // Created
      var tdCreated = document.createElement('td');
      tdCreated.textContent = formatDate(movie.createdAt || movie.created);
      tr.appendChild(tdCreated);

      // Actions
      var tdActions = document.createElement('td');
      tdActions.style.whiteSpace = 'nowrap';

      if (status === 'ready') {
        var playBtn = document.createElement('button');
        playBtn.classList.add('btn', 'btn-sm', 'btn-primary');
        playBtn.setAttribute('title', 'Play');
        playBtn.innerHTML = '<i data-lucide="play" style="width:14px;height:14px;"></i>';
        playBtn.addEventListener('click', function () {
          var id = movie.id || movie._id;
          window.open('/stream/' + id + '/master.m3u8', '_blank');
        });
        tdActions.appendChild(playBtn);
        tdActions.appendChild(document.createTextNode(' '));
      }

      var reconvertBtn = document.createElement('button');
      reconvertBtn.classList.add('btn', 'btn-sm', 'btn-warning');
      reconvertBtn.setAttribute('title', 'Reconvert');
      reconvertBtn.innerHTML = '<i data-lucide="refresh-cw" style="width:14px;height:14px;"></i>';
      reconvertBtn.addEventListener('click', function () {
        var id = movie.id || movie._id;
        adminFetch('/api/admin/movies/' + id + '/reconvert', { method: 'POST' })
          .then(function (res) { return res.json(); })
          .then(function () {
            showToast('Reconvert started', 'success');
            loadMovies();
          })
          .catch(function (err) {
            showToast('Reconvert failed: ' + err.message);
          });
      });
      tdActions.appendChild(reconvertBtn);
      tdActions.appendChild(document.createTextNode(' '));

      var deleteBtn = document.createElement('button');
      deleteBtn.classList.add('btn', 'btn-sm', 'btn-danger');
      deleteBtn.setAttribute('title', 'Delete');
      deleteBtn.innerHTML = '<i data-lucide="trash-2" style="width:14px;height:14px;"></i>';
      deleteBtn.addEventListener('click', function () {
        var id = movie.id || movie._id;
        showModal('Are you sure you want to delete "' + (movie.title || id) + '"?', null, function () {
          adminFetch('/api/admin/movies/' + id, { method: 'DELETE' })
            .then(function () {
              showToast('Movie deleted', 'success');
              loadMovies();
              loadDashboardStats();
            })
            .catch(function (err) {
              showToast('Delete failed: ' + err.message);
            });
        });
      });
      tdActions.appendChild(deleteBtn);

      tr.appendChild(tdActions);
      tbody.appendChild(tr);
    });

    // Pagination
    var paginationEl = document.getElementById('movies-pagination');
    if (paginationEl) {
      paginationEl.innerHTML = '';
      var prevBtn = document.createElement('button');
      prevBtn.classList.add('btn', 'btn-sm');
      prevBtn.textContent = '← Prev';
      prevBtn.disabled = currentPage <= 1;
      prevBtn.addEventListener('click', function () {
        moviesPage = currentPage - 1;
        loadMovies();
      });
      paginationEl.appendChild(prevBtn);

      var pageSpan = document.createElement('span');
      pageSpan.style.margin = '0 12px';
      pageSpan.textContent = 'Page ' + currentPage + ' of ' + totalPages;
      paginationEl.appendChild(pageSpan);

      var nextBtn = document.createElement('button');
      nextBtn.classList.add('btn', 'btn-sm');
      nextBtn.textContent = 'Next →';
      nextBtn.disabled = currentPage >= totalPages;
      nextBtn.addEventListener('click', function () {
        moviesPage = currentPage + 1;
        loadMovies();
      });
      paginationEl.appendChild(nextBtn);
    }
  }

  function setupMoviesFilters() {
    var statusFilter = document.getElementById('movies-status-filter');
    if (statusFilter) {
      statusFilter.addEventListener('change', function () {
        moviesStatusFilter = this.value;
        moviesPage = 1;
        loadMovies();
      });
    }
    var sortSelect = document.getElementById('movies-sort');
    if (sortSelect) {
      sortSelect.addEventListener('change', function () {
        moviesSort = this.value;
        moviesPage = 1;
        loadMovies();
      });
    }
    var deleteAllBtn = document.getElementById('movies-delete-all');
    if (deleteAllBtn) {
      deleteAllBtn.addEventListener('click', function () {
        showModal('This will delete ALL movies. Type DELETE_ALL to confirm.', 'DELETE_ALL', function () {
          adminFetch('/api/admin/movies', {
            method: 'DELETE',
            body: { confirm: 'DELETE_ALL' }
          })
            .then(function () {
              showToast('All movies deleted', 'success');
              loadMovies();
              loadDashboardStats();
            })
            .catch(function (err) {
              showToast('Delete all failed: ' + err.message);
            });
        });
      });
    }
  }

  // ── Downloads Tab ───────────────────────────────────────────────────────

  function loadDownloads() {
    adminFetch('/api/admin/downloads')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        renderDownloadsTable(data);
        callLucide();
      })
      .catch(function (err) {
        showToast('Failed to load downloads: ' + err.message);
      });
  }

  function renderDownloadsTable(data) {
    var container = document.getElementById('downloads-list');
    if (!container) return;
    container.innerHTML = '';

    var downloads = data.downloads || data || [];

    if (downloads.length === 0) {
      var empty = document.createElement('p');
      empty.textContent = 'No active downloads.';
      empty.style.textAlign = 'center';
      empty.style.color = '#888';
      container.appendChild(empty);
      return;
    }

    downloads.forEach(function (dl) {
      var card = document.createElement('div');
      card.classList.add('download-card');
      card.setAttribute('data-download-id', dl.id || dl.infoHash || '');

      // Title row
      var titleRow = document.createElement('div');
      titleRow.style.display = 'flex';
      titleRow.style.justifyContent = 'space-between';
      titleRow.style.alignItems = 'center';
      titleRow.style.marginBottom = '8px';

      var titleEl = document.createElement('strong');
      titleEl.textContent = dl.title || dl.infoHash || 'Unknown';
      titleRow.appendChild(titleEl);

      var cancelBtn = document.createElement('button');
      cancelBtn.classList.add('btn', 'btn-sm', 'btn-danger');
      cancelBtn.innerHTML = '<i data-lucide="x" style="width:14px;height:14px;"></i> Cancel';
      cancelBtn.addEventListener('click', function () {
        var id = dl.id || dl.infoHash;
        adminFetch('/api/admin/downloads/' + id + '/cancel', { method: 'POST' })
          .then(function () {
            showToast('Download cancelled', 'success');
            loadDownloads();
          })
          .catch(function (err) {
            showToast('Cancel failed: ' + err.message);
          });
      });
      titleRow.appendChild(cancelBtn);
      card.appendChild(titleRow);

      // Progress bar
      var progressWrapper = document.createElement('div');
      progressWrapper.classList.add('progress-bar-wrapper');
      progressWrapper.style.cssText = 'background:#333;border-radius:6px;overflow:hidden;height:20px;margin-bottom:8px;';

      var progressFill = document.createElement('div');
      progressFill.classList.add('progress-bar-fill');
      var pct = dl.progress || 0;
      if (typeof pct === 'string') pct = parseFloat(pct);
      if (isNaN(pct)) pct = 0;
      var clampedPct = Math.min(100, Math.max(0, pct));
      progressFill.style.cssText = 'height:100%;border-radius:6px;transition:width 0.3s;text-align:center;line-height:20px;font-size:12px;color:#fff;';
      progressFill.style.width = clampedPct.toFixed(1) + '%';
      if (clampedPct < 30) {
        progressFill.style.background = '#ef4444';
      } else if (clampedPct < 70) {
        progressFill.style.background = '#f59e0b';
      } else {
        progressFill.style.background = '#22c55e';
      }
      progressFill.textContent = clampedPct.toFixed(1) + '%';
      progressWrapper.appendChild(progressFill);
      card.appendChild(progressWrapper);

      // Info row
      var infoRow = document.createElement('div');
      infoRow.style.cssText = 'display:flex;gap:16px;font-size:13px;color:#aaa;flex-wrap:wrap;';

      var speedSpan = document.createElement('span');
      speedSpan.innerHTML = '<i data-lucide="arrow-down" style="width:12px;height:12px;"></i> ';
      speedSpan.appendChild(document.createTextNode(formatSpeed(dl.downloadSpeed || dl.speed || 0)));
      infoRow.appendChild(speedSpan);

      var peersSpan = document.createElement('span');
      peersSpan.innerHTML = '<i data-lucide="users" style="width:12px;height:12px;"></i> ';
      peersSpan.appendChild(document.createTextNode((dl.peers || dl.numPeers || 0) + ' peers'));
      infoRow.appendChild(peersSpan);

      var statusSpan = document.createElement('span');
      statusSpan.textContent = 'Status: ' + (dl.status || 'downloading');
      infoRow.appendChild(statusSpan);

      card.appendChild(infoRow);
      container.appendChild(card);
    });
  }

  function updateDownloadRow(data) {
    var id = data.id || data.infoHash || '';
    if (!id) return;
    var card = document.querySelector('[data-download-id="' + id + '"]');
    if (!card) {
      // Row doesn't exist yet; re-render the whole list
      loadDownloads();
      return;
    }

    // Update progress bar
    var fill = card.querySelector('.progress-bar-fill');
    if (fill && (data.progress !== undefined)) {
      var pct = data.progress;
      if (typeof pct === 'string') pct = parseFloat(pct);
      if (isNaN(pct)) pct = 0;
      var clampedPct = Math.min(100, Math.max(0, pct));
      fill.style.width = clampedPct.toFixed(1) + '%';
      fill.textContent = clampedPct.toFixed(1) + '%';
      if (clampedPct < 30) {
        fill.style.background = '#ef4444';
      } else if (clampedPct < 70) {
        fill.style.background = '#f59e0b';
      } else {
        fill.style.background = '#22c55e';
      }
    }

    // Update speed, peers, status text
    var spans = card.querySelectorAll('div:last-child span');
    if (spans.length >= 1 && data.downloadSpeed !== undefined) {
      spans[0].innerHTML = '<i data-lucide="arrow-down" style="width:12px;height:12px;"></i> ' + formatSpeed(data.downloadSpeed);
    }
    if (spans.length >= 2 && data.peers !== undefined) {
      spans[1].innerHTML = '<i data-lucide="users" style="width:12px;height:12px;"></i> ' + data.peers + ' peers';
    }
    if (spans.length >= 3 && data.status !== undefined) {
      spans[2].textContent = 'Status: ' + data.status;
    }

    callLucide();
  }

  // ── Search & Cache Tab ──────────────────────────────────────────────────

  function handleSearch(e) {
    e.preventDefault();
    var qEl = document.getElementById('search-query');
    if (!qEl) return;
    var q = qEl.value.trim();
    if (!q) return;

    fetch('/api/search?q=' + encodeURIComponent(q))
      .then(function (res) { return res.json(); })
      .then(function (data) {
        renderSearchResults(data);
        callLucide();
      })
      .catch(function (err) {
        showToast('Search failed: ' + err.message);
      });
  }

  function renderSearchResults(data) {
    var tbody = document.getElementById('search-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    var results = data.results || data || [];

    if (results.length === 0) {
      var tr = document.createElement('tr');
      var td = document.createElement('td');
      td.colSpan = 7;
      td.textContent = 'No results found.';
      td.style.textAlign = 'center';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }

    results.forEach(function (item, index) {
      var tr = document.createElement('tr');

      // #
      var tdNum = document.createElement('td');
      tdNum.textContent = index + 1;
      tr.appendChild(tdNum);

      // Title
      var tdTitle = document.createElement('td');
      tdTitle.textContent = item.title || '';
      tr.appendChild(tdTitle);

      // Size
      var tdSize = document.createElement('td');
      tdSize.textContent = item.sizeBytes ? formatBytes(item.sizeBytes) : (item.size || '');
      tr.appendChild(tdSize);

      // Seeders
      var tdSeeders = document.createElement('td');
      tdSeeders.textContent = item.seeders || 0;
      tr.appendChild(tdSeeders);

      // Source
      var tdSource = document.createElement('td');
      tdSource.textContent = item.source || '';
      tr.appendChild(tdSource);

      // Status / message
      var tdStatus = document.createElement('td');
      tdStatus.classList.add('download-status');
      tdStatus.setAttribute('data-info-hash', item.infoHash || '');
      tr.appendChild(tdStatus);

      // Download button
      var tdAction = document.createElement('td');
      var dlBtn = document.createElement('button');
      dlBtn.classList.add('btn', 'btn-sm', 'btn-primary');
      dlBtn.innerHTML = '<i data-lucide="download" style="width:14px;height:14px;"></i> Download';
      dlBtn.addEventListener('click', function () {
        var statusTd = tr.querySelector('.download-status[data-info-hash="' + (item.infoHash || '') + '"]');
        adminFetch('/api/admin/download', {
          method: 'POST',
          body: {
            magnetUri: item.magnetUri || item.magnet || '',
            infoHash: item.infoHash || '',
            title: item.title || '',
            source: item.source || '',
            seeders: item.seeders || 0,
            sizeBytes: item.sizeBytes || 0
          }
        })
          .then(function (res) { return res.json(); })
          .then(function () {
            if (statusTd) {
              statusTd.textContent = '✓ Queued';
              statusTd.style.color = '#22c55e';
            }
            showToast('Download started: ' + (item.title || ''), 'success');
          })
          .catch(function (err) {
            if (statusTd) {
              statusTd.textContent = '✗ Failed';
              statusTd.style.color = '#ef4444';
            }
            showToast('Download failed: ' + err.message);
          });
      });
      tdAction.appendChild(dlBtn);
      tr.appendChild(tdAction);

      tbody.appendChild(tr);
    });

    // Download Top 5 button
    var top5Container = document.getElementById('search-top5-container');
    if (top5Container) {
      top5Container.innerHTML = '';
      if (results.length > 0) {
        var top5Btn = document.createElement('button');
        top5Btn.classList.add('btn', 'btn-primary');
        top5Btn.innerHTML = '<i data-lucide="download" style="width:14px;height:14px;"></i> Download Top 5';
        top5Btn.addEventListener('click', function () {
          var items = results.slice(0, 5).map(function (r) {
            return {
              magnetUri: r.magnetUri || r.magnet || '',
              infoHash: r.infoHash || '',
              title: r.title || '',
              source: r.source || '',
              seeders: r.seeders || 0,
              sizeBytes: r.sizeBytes || 0
            };
          });
          adminFetch('/api/admin/download/batch', {
            method: 'POST',
            body: { items: items }
          })
            .then(function (res) { return res.json(); })
            .then(function () {
              showToast('Top 5 downloads queued', 'success');
            })
            .catch(function (err) {
              showToast('Batch download failed: ' + err.message);
            });
        });
        top5Container.appendChild(top5Btn);
      }
    }
  }

  // ── Disk Management Tab ─────────────────────────────────────────────────

  function loadDisk() {
    adminFetch('/api/admin/disk')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        renderDiskUsage(data);
        callLucide();
      })
      .catch(function (err) {
        showToast('Failed to load disk info: ' + err.message);
      });
  }

  function renderDiskUsage(data) {
    // Overall disk usage bar
    var diskBarContainer = document.getElementById('disk-usage-bar');
    if (diskBarContainer) {
      diskBarContainer.innerHTML = '';

      var total = data.total || data.totalBytes || 0;
      var used = data.used || data.usedBytes || 0;
      var free = data.free || data.freeBytes || 0;
      var usedPct = total > 0 ? ((used / total) * 100).toFixed(1) : 0;
      var freePct = total > 0 ? ((free / total) * 100).toFixed(1) : 0;

      var barWrapper = document.createElement('div');
      barWrapper.style.cssText = 'background:#333;border-radius:8px;overflow:hidden;height:32px;margin-bottom:12px;position:relative;';

      var usedFill = document.createElement('div');
      usedFill.style.cssText = 'height:100%;background:linear-gradient(90deg,#3b82f6,#6366f1);float:left;transition:width 0.3s;';
      usedFill.style.width = usedPct + '%';

      barWrapper.appendChild(usedFill);
      diskBarContainer.appendChild(barWrapper);

      // Legend
      var legend = document.createElement('div');
      legend.style.cssText = 'display:flex;gap:24px;font-size:13px;margin-bottom:20px;flex-wrap:wrap;';

      var usedLabel = document.createElement('span');
      usedLabel.innerHTML = '<span style="display:inline-block;width:12px;height:12px;background:#3b82f6;border-radius:2px;margin-right:4px;vertical-align:middle;"></span>';
      usedLabel.appendChild(document.createTextNode('Used: ' + formatBytes(used) + ' (' + usedPct + '%)'));
      legend.appendChild(usedLabel);

      var freeLabel = document.createElement('span');
      freeLabel.innerHTML = '<span style="display:inline-block;width:12px;height:12px;background:#333;border-radius:2px;margin-right:4px;vertical-align:middle;"></span>';
      freeLabel.appendChild(document.createTextNode('Free: ' + formatBytes(free) + ' (' + freePct + '%)'));
      legend.appendChild(freeLabel);

      var totalLabel = document.createElement('span');
      totalLabel.appendChild(document.createTextNode('Total: ' + formatBytes(total)));
      legend.appendChild(totalLabel);

      diskBarContainer.appendChild(legend);
    }

    // Per-movie disk usage
    var movieUsageContainer = document.getElementById('disk-movie-usage');
    if (movieUsageContainer) {
      movieUsageContainer.innerHTML = '';

      var movies = (data.movies || data.movieUsage || []).slice().sort(function (a, b) {
        return (b.sizeBytes || b.size || 0) - (a.sizeBytes || a.size || 0);
      });

      if (movies.length === 0) {
        var empty = document.createElement('p');
        empty.textContent = 'No movie disk usage data.';
        empty.style.color = '#888';
        movieUsageContainer.appendChild(empty);
      } else {
        movies.forEach(function (movie) {
          var movieSize = movie.sizeBytes || movie.size || 0;
          var moviePct = total > 0 ? ((movieSize / total) * 100) : 0;

          var row = document.createElement('div');
          row.style.cssText = 'margin-bottom:10px;';

          var label = document.createElement('div');
          label.style.cssText = 'display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px;';

          var nameSpan = document.createElement('span');
          nameSpan.textContent = movie.title || movie.infoHash || 'Unknown';
          label.appendChild(nameSpan);

          var sizeSpan = document.createElement('span');
          sizeSpan.textContent = formatBytes(movieSize) + ' (' + moviePct.toFixed(1) + '%)';
          label.appendChild(sizeSpan);

          row.appendChild(label);

          var miniBar = document.createElement('div');
          miniBar.style.cssText = 'background:#333;border-radius:4px;overflow:hidden;height:8px;';

          var miniFill = document.createElement('div');
          miniFill.style.cssText = 'height:100%;background:#6366f1;border-radius:4px;transition:width 0.3s;';
          miniFill.style.width = Math.min(100, moviePct).toFixed(1) + '%';

          miniBar.appendChild(miniFill);
          row.appendChild(miniBar);

          movieUsageContainer.appendChild(row);
        });
      }
    }

    // Action buttons
    var actionsContainer = document.getElementById('disk-actions');
    if (actionsContainer) {
      actionsContainer.innerHTML = '';

      var cleanupBtn = document.createElement('button');
      cleanupBtn.classList.add('btn', 'btn-warning');
      cleanupBtn.innerHTML = '<i data-lucide="trash" style="width:14px;height:14px;"></i> Cleanup Errors';
      cleanupBtn.addEventListener('click', function () {
        adminFetch('/api/admin/cleanup', { method: 'POST' })
          .then(function (res) { return res.json(); })
          .then(function () {
            showToast('Error movies cleaned up', 'success');
            loadDisk();
            loadDashboardStats();
          })
          .catch(function (err) {
            showToast('Cleanup failed: ' + err.message);
          });
      });
      actionsContainer.appendChild(cleanupBtn);
      actionsContainer.appendChild(document.createTextNode(' '));

      var clearAllBtn = document.createElement('button');
      clearAllBtn.classList.add('btn', 'btn-danger');
      clearAllBtn.innerHTML = '<i data-lucide="alert-triangle" style="width:14px;height:14px;"></i> Clear All Cache';
      clearAllBtn.addEventListener('click', function () {
        showModal('This will delete ALL movies and clear the cache. Type DELETE_ALL to confirm.', 'DELETE_ALL', function () {
          adminFetch('/api/admin/movies', {
            method: 'DELETE',
            body: { confirm: 'DELETE_ALL' }
          })
            .then(function () {
              showToast('All cache cleared', 'success');
              loadDisk();
              loadDashboardStats();
            })
            .catch(function (err) {
              showToast('Clear cache failed: ' + err.message);
            });
        });
      });
      actionsContainer.appendChild(clearAllBtn);
    }
  }

  // ── Confirmation Modal ──────────────────────────────────────────────────

  var modalCallback = null;

  function showModal(message, requiredText, callback) {
    if (!confirmModal) return;
    modalCallback = callback;

    var msgEl = document.getElementById('confirm-message');
    if (msgEl) msgEl.textContent = message;

    var inputEl = document.getElementById('confirm-input');
    var confirmBtnEl = document.getElementById('confirm-confirm-btn');

    if (requiredText) {
      if (inputEl) {
        inputEl.style.display = '';
        inputEl.value = '';
      }
      if (confirmBtnEl) confirmBtnEl.disabled = true;
      // Remove previous listener by cloning
      if (inputEl) {
        var newInput = inputEl.cloneNode(true);
        inputEl.parentNode.replaceChild(newInput, inputEl);
        newInput.addEventListener('input', function () {
          if (confirmBtnEl) {
            confirmBtnEl.disabled = newInput.value !== requiredText;
          }
        });
      }
    } else {
      if (inputEl) {
        inputEl.style.display = 'none';
        inputEl.value = '';
      }
      if (confirmBtnEl) confirmBtnEl.disabled = false;
    }

    confirmModal.style.display = '';
  }

  function hideModal() {
    if (!confirmModal) return;
    confirmModal.style.display = 'none';
    modalCallback = null;
    var inputEl = document.getElementById('confirm-input');
    if (inputEl) inputEl.value = '';
  }

  function setupModal() {
    var confirmBtn = document.getElementById('confirm-confirm-btn');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', function () {
        if (typeof modalCallback === 'function') {
          modalCallback();
        }
        hideModal();
      });
    }
    var cancelBtn = document.getElementById('confirm-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        hideModal();
      });
    }
    // Close on backdrop click
    if (confirmModal) {
      confirmModal.addEventListener('click', function (e) {
        if (e.target === confirmModal) {
          hideModal();
        }
      });
    }
  }

  // ── Lucide icons helper ─────────────────────────────────────────────────

  function callLucide() {
    if (typeof lucide !== 'undefined' && lucide.createIcons) {
      try {
        lucide.createIcons();
      } catch (e) {
        // ignore
      }
    }
  }

  // ── Tab navigation binding ──────────────────────────────────────────────

  function setupTabNavigation() {
    document.querySelectorAll('[data-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        switchTab(this.getAttribute('data-tab'));
      });
    });
  }

  // ── Search form binding ─────────────────────────────────────────────────

  function setupSearchForm() {
    var searchForm = document.getElementById('search-form');
    if (searchForm) {
      searchForm.addEventListener('submit', handleSearch);
    }
  }

  // ── Logout button binding ───────────────────────────────────────────────

  function setupLogout() {
    var logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function () {
        doLogout();
      });
    }
  }

  // ── Login form binding ──────────────────────────────────────────────────

  function setupLoginForm() {
    var loginForm = document.getElementById('login-form');
    if (loginForm) {
      loginForm.addEventListener('submit', handleLogin);
    }
  }

  // ── Initialization ──────────────────────────────────────────────────────

  function init() {
    setupLoginForm();
    setupLogout();
    setupTabNavigation();
    setupSearchForm();
    setupModal();
    setupMoviesFilters();
    checkExistingSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
