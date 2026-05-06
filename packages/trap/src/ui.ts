export const UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>@mailts/trap</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      background: #fff;
      color: #111;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      border-bottom: 1px solid #e5e5e5;
      flex-shrink: 0;
    }

    header h1 { font-size: 15px; font-weight: 600; }
    header h1 span { color: #0070f3; }

    #stats { font-size: 12px; color: #888; }

    .spacer { flex: 1; }

    button {
      cursor: pointer;
      border: 1px solid #e0e0e0;
      background: #fff;
      border-radius: 6px;
      padding: 5px 11px;
      font-size: 12px;
      color: #444;
    }
    button:hover { background: #f5f5f5; }
    button.danger { border-color: #fca5a5; color: #dc2626; }
    button.danger:hover { background: #fff5f5; }

    .layout { display: flex; flex: 1; overflow: hidden; }

    /* Sidebar */
    #sidebar {
      width: 300px;
      border-right: 1px solid #e5e5e5;
      overflow-y: auto;
      flex-shrink: 0;
      background: #fafafa;
    }

    .empty-state {
      padding: 48px 20px;
      text-align: center;
      color: #bbb;
      font-size: 13px;
      line-height: 1.6;
    }

    .msg-item {
      padding: 11px 14px;
      border-bottom: 1px solid #efefef;
      cursor: pointer;
    }
    .msg-item:hover { background: #f0f0f0; }
    .msg-item.active { background: #e8f0fe; }

    .msg-subject {
      font-size: 13px;
      color: #111;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 3px;
      display: flex;
      align-items: center;
      gap: 5px;
    }

    .unread-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #0070f3;
      flex-shrink: 0;
    }

    .msg-item.unread .msg-subject { font-weight: 600; }

    .msg-from {
      font-size: 11px;
      color: #666;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 2px;
    }

    .msg-meta {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      color: #aaa;
    }

    /* Detail panel */
    #detail { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

    #placeholder {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #ccc;
      font-size: 13px;
    }

    #msg-view { display: none; flex-direction: column; flex: 1; overflow: hidden; }
    #msg-view.visible { display: flex; }

    .msg-headers {
      padding: 16px 20px 14px;
      border-bottom: 1px solid #e5e5e5;
      flex-shrink: 0;
    }

    .msg-headers h2 {
      font-size: 16px;
      font-weight: 600;
      margin-bottom: 10px;
      line-height: 1.35;
    }

    .hrow {
      display: flex;
      gap: 8px;
      font-size: 12px;
      color: #444;
      margin-bottom: 3px;
    }
    .hrow .lbl { color: #aaa; min-width: 36px; font-weight: 500; }

    .msg-toolbar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 7px 16px;
      border-bottom: 1px solid #e5e5e5;
      flex-shrink: 0;
    }

    .tab-btn {
      border: none;
      background: transparent;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 12px;
      color: #666;
      cursor: pointer;
    }
    .tab-btn.active { background: #e8f0fe; color: #0070f3; font-weight: 500; }
    .tab-btn:hover:not(.active) { background: #f0f0f0; }

    #att-bar {
      display: none;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      padding: 7px 16px;
      border-bottom: 1px solid #e5e5e5;
      font-size: 12px;
      flex-shrink: 0;
    }
    #att-bar.visible { display: flex; }
    #att-bar .lbl { color: #aaa; font-size: 11px; }

    .att-pill {
      padding: 3px 9px;
      background: #f0f0f0;
      border-radius: 4px;
      text-decoration: none;
      color: #333;
      font-size: 11px;
    }
    .att-pill:hover { background: #e0e0e0; }

    #body-frame { flex: 1; border: none; width: 100%; }
    #body-pre {
      flex: 1;
      padding: 20px;
      font-family: 'SF Mono', 'Fira Code', 'Menlo', monospace;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-all;
      overflow-y: auto;
      background: #fafafa;
      color: #333;
      display: none;
    }
  </style>
</head>
<body>

<header>
  <h1>@mailts<span>/trap</span></h1>
  <span id="stats"></span>
  <div class="spacer"></div>
  <button id="btn-refresh">Refresh</button>
  <button id="btn-clear" class="danger">Clear all</button>
</header>

<div class="layout">
  <div id="sidebar"></div>

  <div id="detail">
    <div id="placeholder">Select a message to view it</div>
    <div id="msg-view">
      <div class="msg-headers">
        <h2 id="v-subject"></h2>
        <div class="hrow"><span class="lbl">From</span><span id="v-from"></span></div>
        <div class="hrow"><span class="lbl">To</span><span id="v-to"></span></div>
        <div class="hrow" id="v-cc-row"><span class="lbl">Cc</span><span id="v-cc"></span></div>
        <div class="hrow"><span class="lbl">Date</span><span id="v-date"></span></div>
      </div>
      <div class="msg-toolbar">
        <button class="tab-btn active" id="tab-html">HTML</button>
        <button class="tab-btn" id="tab-text">Text</button>
        <button class="tab-btn" id="tab-headers">Headers</button>
        <div class="spacer"></div>
        <button id="btn-delete" class="danger">Delete</button>
      </div>
      <div id="att-bar"></div>
      <iframe id="body-frame" sandbox="allow-same-origin"></iframe>
      <pre id="body-pre"></pre>
    </div>
  </div>
</div>

<script>
  var messages = [];
  var currentId = null;
  var currentMsg = null;

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtAddr(a) { return a.name ? a.name + ' <' + a.email + '>' : a.email; }
  function fmtDate(d) { return new Date(d).toLocaleString(); }

  // ── Data loading ──────────────────────────────────────────────────────────

  function loadMessages() {
    fetch('/api/messages')
      .then(function(r) { return r.json(); })
      .then(function(data) { messages = data; renderList(); });
    fetch('/api/stats')
      .then(function(r) { return r.json(); })
      .then(function(s) {
        $('stats').textContent = s.total + ' message' + (s.total !== 1 ? 's' : '') + '  ·  ' + s.unread + ' unread';
      });
  }

  // ── Sidebar ───────────────────────────────────────────────────────────────

  function renderList() {
    var sb = $('sidebar');
    if (!messages.length) {
      sb.innerHTML = '<div class="empty-state">No messages yet.<br>Point your SMTP config at this trap.</div>';
      return;
    }
    sb.innerHTML = messages.map(function(m) {
      var active = m.id === currentId ? ' active' : '';
      var unread = m.read ? '' : ' unread';
      var dot    = m.read ? '' : '<span class="unread-dot"></span>';
      var subj   = m.subject || '(no subject)';
      var from   = m.from.map(fmtAddr).join(', ');
      var to     = m.to.map(function(a) { return a.email; }).join(', ');
      return '<div class="msg-item' + active + unread + '" data-id="' + esc(m.id) + '">' +
        '<div class="msg-subject">' + dot + esc(subj) + '</div>' +
        '<div class="msg-from">' + esc(from) + '</div>' +
        '<div class="msg-meta"><span>' + esc(to) + '</span><span>' + fmtDate(m.receivedAt) + '</span></div>' +
        '</div>';
    }).join('');
  }

  // Click delegation — no inline onclick, no quoting issues
  $('sidebar').addEventListener('click', function(e) {
    var item = e.target.closest('.msg-item');
    if (!item) return;
    openMsg(item.getAttribute('data-id'));
  });

  // ── Detail view ───────────────────────────────────────────────────────────

  function openMsg(id) {
    currentId = id;
    fetch('/api/messages/' + id)
      .then(function(r) { return r.json(); })
      .then(function(msg) {
        currentMsg = msg;
        var local = messages.find(function(m) { return m.id === id; });
        if (local) local.read = true;
        renderList();
        showMsg();
        loadMessages();
      });
  }

  function showMsg() {
    var m = currentMsg;
    $('placeholder').style.display = 'none';
    $('msg-view').classList.add('visible');

    $('v-subject').textContent = m.subject || '(no subject)';
    $('v-from').textContent    = m.from.map(fmtAddr).join(', ');
    $('v-to').textContent      = m.to.map(fmtAddr).join(', ');
    $('v-date').textContent    = fmtDate(m.receivedAt);

    if (m.cc && m.cc.length) {
      $('v-cc-row').style.display = 'flex';
      $('v-cc').textContent = m.cc.map(fmtAddr).join(', ');
    } else {
      $('v-cc-row').style.display = 'none';
    }

    var bar = $('att-bar');
    if (m.attachments && m.attachments.length) {
      bar.classList.add('visible');
      bar.innerHTML = '<span class="lbl">Attachments</span>' +
        m.attachments.map(function(a, i) {
          return '<a class="att-pill" href="/api/messages/' + m.id + '/attachments/' + i +
            '" download="' + esc(a.filename) + '">' + esc(a.filename) + '</a>';
        }).join('');
    } else {
      bar.classList.remove('visible');
      bar.innerHTML = '';
    }

    $('tab-html').style.display  = m.html  != null ? '' : 'none';
    $('tab-text').style.display  = m.text  != null ? '' : 'none';

    if (m.html  != null) setTab('html');
    else if (m.text != null) setTab('text');
    else setTab('headers');
  }

  function setTab(tab) {
    ['html', 'text', 'headers'].forEach(function(t) {
      $('tab-' + t).classList.toggle('active', t === tab);
    });

    var frame = $('body-frame');
    var pre   = $('body-pre');

    if (tab === 'html') {
      frame.style.display = '';
      pre.style.display   = 'none';
      frame.srcdoc = currentMsg.html || '';
    } else if (tab === 'text') {
      frame.style.display = 'none';
      pre.style.display   = 'block';
      pre.textContent = currentMsg.text || '';
    } else {
      frame.style.display = 'none';
      pre.style.display   = 'block';
      pre.textContent = Object.entries(currentMsg.headers || {})
        .flatMap(function(e) { return e[1].map(function(v) { return e[0] + ': ' + v; }); })
        .join('\\n');
    }
  }

  $('tab-html').onclick    = function() { setTab('html'); };
  $('tab-text').onclick    = function() { setTab('text'); };
  $('tab-headers').onclick = function() { setTab('headers'); };

  // ── Actions ───────────────────────────────────────────────────────────────

  $('btn-delete').onclick = function() {
    if (!currentId) return;
    fetch('/api/messages/' + currentId, { method: 'DELETE' }).then(function() {
      messages = messages.filter(function(m) { return m.id !== currentId; });
      currentId = null;
      currentMsg = null;
      $('msg-view').classList.remove('visible');
      $('placeholder').style.display = '';
      renderList();
      loadMessages();
    });
  };

  $('btn-clear').onclick = function() {
    fetch('/api/messages', { method: 'DELETE' }).then(function() {
      messages = [];
      currentId = null;
      currentMsg = null;
      $('msg-view').classList.remove('visible');
      $('placeholder').style.display = '';
      renderList();
      loadMessages();
    });
  };

  $('btn-refresh').onclick = loadMessages;

  // ── SSE ───────────────────────────────────────────────────────────────────

  function connectSSE() {
    var es = new EventSource('/api/events');
    es.addEventListener('message', loadMessages);
    es.addEventListener('deleted', loadMessages);
    es.addEventListener('cleared', loadMessages);
    es.addEventListener('shutdown', function() { es.close(); });
  }

  loadMessages();
  connectSSE();
</script>
</body>
</html>`;
