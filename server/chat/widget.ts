/**
 * The live chat widget's browser code. Plain JavaScript in strings, so both platforms serve it the same
 * way with no build step. Keep it free of template-literal syntax: only the marked config is filled in.
 *
 * widget.js runs on the customer's website. It adds a launcher button in a shadow root and opens the chat
 * in an iframe served from this install, so the visitor's token and every API call stay on our origin.
 */
import { escapeHtml } from '../mail/html.ts'

/** JSON that is safe inside a <script> element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c')

export function widgetScript(config: { key: string; base: string; color: string; title: string; hideWhenAway: boolean }) {
  return WIDGET.replace('__CONFIG__', () => scriptJson(config))
}

const WIDGET = String.raw`(function () {
  'use strict';
  if (window.AnsaChat) return;
  var CONFIG = __CONFIG__;
  var base = CONFIG.base;
  try {
    if (document.currentScript && document.currentScript.src) base = new URL(document.currentScript.src).origin;
  } catch (e) {}
  var ACTIVE = 'ansa-chat-active:' + CONFIG.key;
  var frame = null;
  var isOpen = false;

  var host = document.createElement('div');
  host.setAttribute('data-ansa-chat', '');
  var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
  var style = document.createElement('style');
  style.textContent =
    ':host{all:initial}' +
    '.launcher{position:fixed;right:20px;bottom:20px;z-index:2147483646;width:56px;height:56px;border-radius:50%;border:0;padding:0;cursor:pointer;' +
    'background:' + CONFIG.color + ';color:#fff;box-shadow:0 6px 24px rgba(15,15,40,.24);display:flex;align-items:center;justify-content:center;transition:transform .15s ease}' +
    '.launcher:hover{transform:scale(1.06)}.launcher:focus-visible{outline:3px solid ' + CONFIG.color + ';outline-offset:3px}' +
    '.launcher svg{width:26px;height:26px}' +
    '.badge{position:absolute;top:-3px;right:-3px;min-width:20px;height:20px;padding:0 6px;box-sizing:border-box;border-radius:10px;background:#e11d48;color:#fff;' +
    'font:600 12px/20px system-ui,-apple-system,sans-serif;text-align:center;display:none}' +
    '.panel{position:fixed;right:20px;bottom:88px;z-index:2147483647;width:380px;max-width:calc(100vw - 40px);height:620px;max-height:calc(100vh - 108px);' +
    'border:0;border-radius:16px;box-shadow:0 16px 56px rgba(15,15,40,.28);background:transparent;display:none;color-scheme:normal}' +
    '.panel.open{display:block}' +
    '.dot{position:absolute;bottom:1px;right:1px;width:12px;height:12px;box-sizing:border-box;border-radius:50%;background:#22c55e;border:2px solid #fff;display:none}' +
    '@media (max-width:480px){.panel{right:0;bottom:0;width:100vw;max-width:none;height:100%;max-height:none;border-radius:0}.launcher.open{display:none}}';
  root.appendChild(style);

  var ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

  var button = document.createElement('button');
  button.type = 'button';
  button.className = 'launcher';
  button.setAttribute('aria-label', CONFIG.title);
  button.innerHTML = ICON_CHAT;
  var badge = document.createElement('span');
  badge.className = 'badge';
  button.appendChild(badge);
  var dot = document.createElement('span');
  dot.className = 'dot';
  button.appendChild(dot);
  root.appendChild(button);

  // Online or away. With "hide when away", the button waits for the answer before it shows.
  var status = { online: !CONFIG.hideWhenAway, hideWhenAway: CONFIG.hideWhenAway };
  function chatActive() {
    try { return localStorage.getItem(ACTIVE) === '1'; } catch (e) { return false; }
  }
  function applyStatus() {
    dot.style.display = status.online && !isOpen ? 'block' : 'none';
    var hide = !status.online && status.hideWhenAway && !isOpen && !chatActive();
    button.style.display = hide ? 'none' : '';
    button.setAttribute('title', status.online ? CONFIG.title + ' (online)' : CONFIG.title + ' (away)');
  }
  function checkStatus() {
    fetch(base + '/api/chat/status?key=' + encodeURIComponent(CONFIG.key)).then(function (r) { return r.json(); }).then(function (s) {
      if (s && s.available) {
        status = s;
        applyStatus();
      }
    }).catch(function () {});
  }
  applyStatus();
  checkStatus();
  setInterval(checkStatus, 60000);

  function makeFrame() {
    if (frame) return frame;
    frame = document.createElement('iframe');
    frame.className = 'panel';
    frame.title = CONFIG.title;
    frame.setAttribute('allow', 'clipboard-write');
    frame.src = base + '/api/chat/frame?key=' + encodeURIComponent(CONFIG.key);
    frame.addEventListener('load', tell);
    root.appendChild(frame);
    return frame;
  }
  function tell() {
    if (frame && frame.contentWindow) frame.contentWindow.postMessage({ ansaChat: 'visible', visible: isOpen }, base);
  }
  function setOpen(next) {
    isOpen = !!next;
    if (isOpen) makeFrame();
    if (frame) frame.classList.toggle('open', isOpen);
    button.classList.toggle('open', isOpen);
    button.setAttribute('aria-expanded', String(isOpen));
    button.innerHTML = isOpen ? ICON_CLOSE : ICON_CHAT;
    button.appendChild(badge);
    button.appendChild(dot);
    if (isOpen) badge.style.display = 'none';
    applyStatus();
    tell();
  }
  button.addEventListener('click', function () { setOpen(!isOpen); });

  window.addEventListener('message', function (event) {
    if (!frame || event.source !== frame.contentWindow || event.origin !== base) return;
    var data = event.data || {};
    if (data.ansaChat === 'close') setOpen(false);
    else if (data.ansaChat === 'unread') {
      badge.textContent = data.count > 9 ? '9+' : String(data.count || '');
      badge.style.display = data.count > 0 && !isOpen ? 'block' : 'none';
    } else if (data.ansaChat === 'started') {
      try { localStorage.setItem(ACTIVE, '1'); } catch (e) {}
    } else if (data.ansaChat === 'ended') {
      try { localStorage.removeItem(ACTIVE); } catch (e) {}
    }
  });

  function mount() {
    document.body.appendChild(host);
    // A visitor with a chat under way gets the frame at once, so new replies show on the launcher.
    var active = false;
    try { active = localStorage.getItem(ACTIVE) === '1'; } catch (e) {}
    if (active) makeFrame();
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  window.AnsaChat = {
    open: function () { setOpen(true); },
    close: function () { setOpen(false); },
    toggle: function () { setOpen(!isOpen); }
  };
})();
`

export interface FrameConfig {
  key: string
  title: string
  greeting: string
  color: string
  mailboxName: string
  team: { name: string; avatarUrl: string | null }[]
  online: boolean
  awayMessage: string
}

/** The page inside the iframe. Its script is /api/chat/frame.js; the config rides along as JSON. */
export function framePage(config: FrameConfig) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(config.title)}</title>
<style>${FRAME_CSS.replace('__BRAND__', config.color)}</style>
</head>
<body>
<div class="app">
  <header class="head">
    <div class="team" id="team"></div>
    <div class="titles"><h1 id="title">${escapeHtml(config.title)}</h1><p id="subtitle"><span class="state" id="state"></span><span id="names"></span></p></div>
    <button type="button" class="close" id="close" aria-label="Close chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
  </header>
  <main class="log" id="log" aria-live="polite" aria-label="Messages"></main>
  <p class="typing" id="typing" hidden><span></span><span></span><span></span></p>
  <form class="start" id="start" hidden novalidate>
    <label>Your name<input id="name" name="name" autocomplete="name" maxlength="100" required></label>
    <label>Email<input id="email" name="email" type="email" autocomplete="email" maxlength="200" required></label>
    <label>Message<textarea id="first" name="message" rows="3" maxlength="5000" required></textarea></label>
    <p class="error" id="start-error" role="alert" hidden></p>
    <button type="submit" class="primary" id="start-button">Start chat</button>
    <p class="fine" id="fine"></p>
  </form>
  <form class="compose" id="compose" hidden>
    <textarea id="input" rows="1" maxlength="5000" placeholder="Write a message…" aria-label="Message"></textarea>
    <button type="submit" class="send" id="send" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 14-7-4 14-3-6-7-1Z"/></svg></button>
  </form>
  <p class="error compose-error" id="compose-error" role="alert" hidden></p>
  <footer class="foot" id="foot" hidden><button type="button" id="restart">Start a new chat</button></footer>
</div>
<script type="application/json" id="config">${scriptJson(config)}</script>
<script src="/api/chat/frame.js"></script>
</body>
</html>`
}

const FRAME_CSS = String.raw`
:root{--brand:__BRAND__;--bg:#fff;--fg:#18181b;--fg2:#52525b;--fg3:#8a8a96;--line:#e7e7ec;--bubble:#f2f2f6;--danger:#dc2626;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#18181b;--fg:#f4f4f5;--fg2:#c4c4cc;--fg3:#8a8a96;--line:#2e2e35;--bubble:#26262c;color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.app{display:flex;flex-direction:column;height:100%;overflow:hidden}
.head{display:flex;align-items:center;gap:12px;padding:16px 14px 16px 18px;background:var(--brand);color:#fff}
.team{display:flex;flex-shrink:0}
.team:empty{display:none}
.avatar{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,.25);color:#fff;font-weight:600;font-size:12px;overflow:hidden;flex-shrink:0;object-fit:cover}
.team .avatar{width:36px;height:36px;border:2px solid var(--brand);margin-left:-10px}
.team .avatar:first-child{margin-left:0}
.titles{min-width:0;flex:1}
h1{margin:0;font-size:16px;font-weight:650;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#subtitle{margin:1px 0 0;font-size:12.5px;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.state{display:inline-flex;align-items:center;gap:5px;font-weight:600}
.state::before{content:"";width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 2px rgba(255,255,255,.35)}
.state.away::before{background:rgba(255,255,255,.55)}
#names:not(:empty)::before{content:" · "}
.close{flex-shrink:0;width:32px;height:32px;border:0;border-radius:8px;background:transparent;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}
.close:hover{background:rgba(255,255,255,.18)}
.close svg{width:20px;height:20px}
.log{flex:1;overflow-y:auto;padding:18px 16px 8px;display:flex;flex-direction:column;gap:12px;overscroll-behavior:contain}
.msg{display:flex;gap:8px;align-items:flex-end;max-width:88%}
.msg .avatar{width:28px;height:28px;background:var(--brand);font-size:11px}
.msg.visitor{align-self:flex-end;flex-direction:row-reverse}
.body{min-width:0}
.who{font-size:12px;color:var(--fg3);margin:0 0 3px 2px}
.bubble{padding:9px 13px;border-radius:16px 16px 16px 4px;background:var(--bubble);overflow-wrap:anywhere}
.visitor .bubble{border-radius:16px 16px 4px 16px;background:var(--brand);color:#fff}
.visitor .bubble a{color:#fff}
.bubble p{margin:0}.bubble p+p{margin-top:8px}
.bubble img{max-width:100%;height:auto;border-radius:8px}
.bubble a{color:inherit;text-decoration:underline}
.bubble blockquote{margin:6px 0;padding-left:10px;border-left:3px solid var(--line);color:var(--fg2)}
.pending .bubble{opacity:.6}
.failed .bubble{outline:1.5px solid var(--danger)}
.note{align-self:center;font-size:12px;color:var(--fg3);text-align:center;margin:4px 0}
.typing{margin:0 16px 8px;display:flex;gap:4px;padding:10px 12px;background:var(--bubble);border-radius:14px;width:max-content}
.typing[hidden]{display:none}
.typing span{width:6px;height:6px;border-radius:50%;background:var(--fg3);animation:blink 1.2s infinite}
.typing span:nth-child(2){animation-delay:.2s}.typing span:nth-child(3){animation-delay:.4s}
@keyframes blink{0%,80%,100%{opacity:.3}40%{opacity:1}}
.start{display:flex;flex-direction:column;gap:10px;padding:14px 16px 16px;border-top:1px solid var(--line)}
.start[hidden],.compose[hidden],.foot[hidden],.error[hidden]{display:none}
label{display:flex;flex-direction:column;gap:4px;font-size:12.5px;font-weight:550;color:var(--fg2)}
input,textarea{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:8px 11px;outline:none;width:100%}
input:focus,textarea:focus{border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 22%,transparent)}
textarea{resize:none}
.primary{height:40px;border:0;border-radius:10px;background:var(--brand);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.primary:disabled{opacity:.6;cursor:default}
.fine{margin:0;font-size:12px;color:var(--fg3);text-align:center}
.error{margin:0;font-size:13px;color:var(--danger)}
.compose-error{padding:0 16px 8px}
.compose{display:flex;align-items:flex-end;gap:8px;padding:10px 12px 12px;border-top:1px solid var(--line)}
.compose textarea{max-height:140px;min-height:40px;border-radius:20px;padding:9px 14px}
.send{flex-shrink:0;width:40px;height:40px;border:0;border-radius:50%;background:var(--brand);color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center}
.send:disabled{opacity:.5;cursor:default}
.send svg{width:18px;height:18px}
.foot{padding:0 0 10px;text-align:center}
.foot button{border:0;background:none;color:var(--fg3);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline}
`

/** The chat window's script. */
export const FRAME_SCRIPT = String.raw`(function () {
  'use strict';
  var cfg = JSON.parse(document.getElementById('config').textContent);
  var STORE = 'ansa-chat-token:' + cfg.key;
  var memory = null;
  var $ = function (id) { return document.getElementById(id); };
  var log = $('log'), start = $('start'), compose = $('compose'), input = $('input'), typing = $('typing'), foot = $('foot');
  var token = load();
  var visible = window.parent === window;
  var unread = 0;
  var known = null;
  var source = null;
  var retry = null;
  var lastHtml = '';

  function load() {
    try { return localStorage.getItem(STORE); } catch (e) { return memory; }
  }
  function save(value) {
    memory = value;
    try {
      if (value) localStorage.setItem(STORE, value);
      else localStorage.removeItem(STORE);
    } catch (e) {}
  }
  function tellParent(message) {
    if (window.parent !== window) window.parent.postMessage(message, '*');
  }

  function call(method, path, body) {
    return fetch('/api/chat' + path, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'X-Ansa-Chat': token || '' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (!response.ok) {
          var error = new Error(data.error || 'Something went wrong. Try again.');
          error.status = response.status;
          throw error;
        }
        return data;
      });
    }, function () {
      throw new Error('Could not connect. Check your connection and try again.');
    });
  }

  function initials(name) {
    var parts = String(name || '?').trim().split(/\s+/);
    return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function avatar(person) {
    if (person.avatarUrl) {
      var img = document.createElement('img');
      img.className = 'avatar';
      img.src = person.avatarUrl;
      img.alt = '';
      return img;
    }
    var span = document.createElement('span');
    span.className = 'avatar';
    span.textContent = initials(person.name);
    return span;
  }

  // Header: up to three teammates, and whether we are online.
  cfg.team.forEach(function (person) { $('team').appendChild(avatar(person)); });
  var online = !!cfg.online;
  function applyOnline(next) {
    var changed = next !== online;
    online = !!next;
    var state = $('state');
    state.textContent = online ? 'Online' : 'Away';
    state.className = online ? 'state' : 'state away';
    var names = cfg.team.map(function (p) { return p.name; });
    $('names').textContent = !online || !names.length ? (online ? '' : 'we reply by email') : names.length === 1 ? names[0] + ' can help' : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] + ' can help';
    $('fine').textContent = online ? "We'll reply here. If you leave, we'll reply by email." : "We'll reply by email as soon as we're back.";
    // Before a chat starts, the first message follows the status: the greeting, or the away message.
    if (changed && !token) showStart();
  }

  function bubble(kind, name, html, person, extraClass) {
    var row = document.createElement('div');
    row.className = 'msg ' + kind + (extraClass ? ' ' + extraClass : '');
    if (kind === 'team') row.appendChild(avatar(person || { name: name }));
    var body = document.createElement('div');
    body.className = 'body';
    if (kind === 'team' && name) {
      var who = document.createElement('p');
      who.className = 'who';
      who.textContent = name;
      body.appendChild(who);
    }
    var b = document.createElement('div');
    b.className = 'bubble';
    // Message HTML is cleaned on the server, and this page's policy allows no inline script.
    b.innerHTML = html;
    var links = b.querySelectorAll('a');
    for (var i = 0; i < links.length; i++) { links[i].target = '_blank'; links[i].rel = 'noopener noreferrer'; }
    body.appendChild(b);
    row.appendChild(body);
    return row;
  }
  function escapeText(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return '<p>' + div.innerHTML.replace(/\n/g, '<br>') + '</p>';
  }
  function greeting() {
    var greeter = cfg.team[0] || { name: cfg.mailboxName, avatarUrl: null };
    var text = !online && cfg.awayMessage ? cfg.awayMessage : cfg.greeting;
    return text ? bubble('team', greeter.name, escapeText(text), greeter) : null;
  }
  function nearBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 80; }
  function scrollDown() { log.scrollTop = log.scrollHeight; }

  function render(data) {
    var stick = nearBottom();
    var html = JSON.stringify(data.messages) + data.status;
    if (html === lastHtml) return;
    lastHtml = html;
    log.textContent = '';
    var hello = greeting();
    if (hello) log.appendChild(hello);
    data.messages.forEach(function (m) {
      log.appendChild(bubble(m.from, m.from === 'team' ? m.name : '', m.html, m));
    });
    if (data.status === 'closed') {
      var note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'This conversation was closed. Write again any time.';
      log.appendChild(note);
    }
    // Count the team's new messages while the window is closed, for the launcher badge.
    var ids = data.messages.filter(function (m) { return m.from === 'team'; }).map(function (m) { return m.id; });
    if (known) {
      var fresh = ids.filter(function (id) { return known.indexOf(id) < 0; }).length;
      if (fresh) typing.hidden = true;
      if (fresh && !visible) {
        unread += fresh;
        tellParent({ ansaChat: 'unread', count: unread });
      }
    }
    known = ids;
    if (stick || !visible) scrollDown();
  }

  function refresh() {
    if (!token) return Promise.resolve();
    return call('GET', '/messages').then(render, function (error) {
      if (error.status === 401 || error.status === 404) reset();
    });
  }

  function connect() {
    if (!token || source || !window.EventSource) return;
    source = new EventSource('/api/chat/events?token=' + encodeURIComponent(token));
    source.onmessage = function (event) {
      var data = {};
      try { data = JSON.parse(event.data); } catch (e) {}
      if (data.type === 'hello' && typeof data.online === 'boolean') applyOnline(data.online);
      if (data.type === 'update' || data.type === 'hello') refresh();
      else if (data.type === 'status') applyOnline(data.online);
      else if (data.type === 'typing') {
        typing.hidden = !data.on;
        if (data.on && nearBottom()) setTimeout(scrollDown, 0);
      }
    };
    source.onerror = function () {
      disconnect();
      clearTimeout(retry);
      retry = setTimeout(function () { refresh().then(connect); }, 4000);
    };
  }
  function disconnect() {
    if (source) source.close();
    source = null;
  }

  function showChat() {
    start.hidden = true;
    compose.hidden = false;
    foot.hidden = false;
  }
  function showStart() {
    start.hidden = false;
    compose.hidden = true;
    foot.hidden = true;
    typing.hidden = true;
    log.textContent = '';
    lastHtml = '';
    known = null;
    var hello = greeting();
    if (hello) log.appendChild(hello);
  }
  function reset() {
    disconnect();
    save(null);
    token = null;
    tellParent({ ansaChat: 'ended' });
    showStart();
  }

  start.addEventListener('submit', function (event) {
    event.preventDefault();
    var error = $('start-error');
    var button = $('start-button');
    error.hidden = true;
    button.disabled = true;
    call('POST', '/start', { key: cfg.key, name: $('name').value, email: $('email').value, message: $('first').value }).then(function (data) {
      token = data.token;
      save(token);
      tellParent({ ansaChat: 'started' });
      $('first').value = '';
      showChat();
      render(data.transcript);
      connect();
      input.focus();
    }, function (err) {
      error.textContent = err.message;
      error.hidden = false;
    }).then(function () { button.disabled = false; });
  });

  function grow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight + 2, 140) + 'px';
  }
  input.addEventListener('input', grow);
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      compose.requestSubmit ? compose.requestSubmit() : send();
    }
  });
  compose.addEventListener('submit', function (event) {
    event.preventDefault();
    send();
  });
  function send() {
    var text = input.value.trim();
    if (!text) return;
    var error = $('compose-error');
    error.hidden = true;
    input.value = '';
    grow();
    var pending = bubble('visitor', '', escapeText(text), null, 'pending');
    log.appendChild(pending);
    scrollDown();
    call('POST', '/messages', { message: text }).then(function (data) {
      render(data.transcript);
    }, function (err) {
      pending.classList.remove('pending');
      pending.classList.add('failed');
      if (!input.value) input.value = text;
      error.textContent = err.message;
      error.hidden = false;
      if (err.status === 401 || err.status === 404) reset();
    });
  }

  $('restart').addEventListener('click', function () {
    if (window.confirm('Start a new chat? This one stays with our team, but you will not see it here any more.')) reset();
  });
  $('close').addEventListener('click', function () { tellParent({ ansaChat: 'close' }); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') tellParent({ ansaChat: 'close' });
  });

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data || {};
    if (data.ansaChat !== 'visible') return;
    visible = !!data.visible;
    if (visible) {
      unread = 0;
      tellParent({ ansaChat: 'unread', count: 0 });
      scrollDown();
      setTimeout(function () { (token ? input : $('name')).focus(); }, 50);
    }
  });

  applyOnline(online);
  if (token) {
    showChat();
    refresh().then(connect);
  } else showStart();

  // Without a chat under way there is no live stream: ask now and then.
  setInterval(function () {
    if (token && source) return;
    fetch('/api/chat/status?key=' + encodeURIComponent(cfg.key)).then(function (r) { return r.json(); }).then(function (s) {
      if (s && s.available) applyOnline(s.online);
    }).catch(function () {});
  }, 60000);
})();
`
