/**
 * ТЕКСТОВЫЙ МОСТ — Cloudflare Worker
 * ------------------------------------------------------------
 * Один файл = весь сайт (бэкенд + фронтенд). Данные в Workers KV —
 * доступны с любого устройства по одной ссылке, без регистрации.
 * Светлый чёрно-белый минималистичный интерфейс, адаптирован под
 * телефон и компьютер. Есть лайки и комментарии к каждой записи.
 * Никаких внешних шрифтов/скриптов — страница лёгкая специально,
 * чтобы открывалась даже при очень плохом интернете.
 *
 * КАК РАЗВЕРНУТЬ (без консоли, всё через сайт Cloudflare):
 *   1. dash.cloudflare.com → бесплатная регистрация (только тебе,
 *      как владельцу; одноклассникам аккаунт не нужен).
 *   2. Слева "Workers & Pages" → "Create" → "Create Worker" →
 *      придумай имя (например textbridge) → Deploy.
 *   3. "Edit code" — сотри содержимое и вставь целиком этот файл →
 *      "Deploy".
 *   4. Слева "Storage & Databases" → "KV" → "Create a namespace" →
 *      назови как угодно, например textbridge-data.
 *   5. Вернись в настройки воркера → вкладка "Bindings" →
 *      "Add binding" → тип "KV Namespace":
 *        Variable name:  TEXTBRIDGE   (именно так, заглавными)
 *        KV namespace:   textbridge-data (созданный в шаге 4)
 *      Сохранить/задеплоить ещё раз.
 *   6. Ссылка вида https://textbridge.<твой-поддомен>.workers.dev
 *      готова — её и скидываешь всем, кому нужен компьютер.
 *
 * Если уже разворачивал предыдущую версию — шаги 1, 4 и 5 повторять
 * не надо: просто замени код (шаг 3) и нажми Deploy ещё раз.
 *
 * ОГРАНИЧЕНИЯ БЕСПЛАТНОГО ТАРИФА (более чем достаточно для пары):
 *   100 000 запросов/день, 1000 записей/день в KV, до 25 МБ на
 *   значение (лимит в 5 МБ ниже — ограничение самого сайта, не
 *   Cloudflare). Записи и комментарии хранятся TTL_SECONDS и потом
 *   сами удаляются.
 */

const MAX_BYTES = 5 * 1024 * 1024;       // 5 МБ — как и просили
const TTL_SECONDS = 60 * 60 * 24 * 30;   // автоудаление через 30 дней
const PREVIEW_LEN = 220;                 // сколько символов хранить как превью для поиска
const LIST_LIMIT = 500;                  // сколько последних записей отдавать разом
const MAX_COMMENT_LEN = 500;             // лимит на длину одного комментария
const MAX_COMMENTS = 200;                // лимит комментариев на одну запись

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      if (pathname === '/api/upload' && request.method === 'POST') {
        return await handleUpload(request, env);
      }
      if (pathname === '/api/list' && request.method === 'GET') {
        return await handleList(env);
      }
      if (pathname.startsWith('/api/item/') && request.method === 'GET') {
        const id = decodeURIComponent(pathname.slice('/api/item/'.length));
        return await handleItem(env, id);
      }
      if (pathname.startsWith('/api/like/') && request.method === 'POST') {
        const id = decodeURIComponent(pathname.slice('/api/like/'.length));
        return await handleLike(request, env, id);
      }
      if (pathname.startsWith('/api/comments/') && request.method === 'GET') {
        const id = decodeURIComponent(pathname.slice('/api/comments/'.length));
        return await handleGetComments(env, id);
      }
      if (pathname.startsWith('/api/comments/') && request.method === 'POST') {
        const id = decodeURIComponent(pathname.slice('/api/comments/'.length));
        return await handleAddComment(request, env, id);
      }
    } catch (err) {
      return jsonResponse({ error: 'server_error' }, 500);
    }

    if (pathname === '/' || pathname === '') {
      return new Response(PAGE_HTML, {
        headers: {
          'content-type': 'text/html; charset=UTF-8',
          'cache-control': 'no-store',
        },
      });
    }

    return new Response('Не найдено', { status: 404 });
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

function makeId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function expirationFromCreatedAt(createdAt) {
  const base = typeof createdAt === 'number' ? createdAt : Date.now();
  const target = Math.floor((base + TTL_SECONDS * 1000) / 1000);
  // KV не примет expiration ближе ~60 секунд к текущему моменту —
  // на случай лайка/комментария к записи, которая вот-вот истечёт,
  // подстраховываемся минимальным запасом.
  const minAllowed = Math.floor(Date.now() / 1000) + 120;
  return Math.max(target, minAllowed);
}

async function handleUpload(request, env) {
  if (!env.TEXTBRIDGE) return jsonResponse({ error: 'no_kv_binding' }, 500);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'bad_json' }, 400);
  }
  const text = typeof body.text === 'string' ? body.text : '';
  const trimmed = text.trim();
  if (!trimmed) return jsonResponse({ error: 'empty' }, 400);

  const byteLength = new TextEncoder().encode(text).length;
  if (byteLength > MAX_BYTES) {
    return jsonResponse({ error: 'too_big', maxBytes: MAX_BYTES }, 413);
  }

  const id = makeId();
  const preview = trimmed.slice(0, PREVIEW_LEN);
  const createdAt = Date.now();

  await env.TEXTBRIDGE.put(`item:${id}`, text, {
    expirationTtl: TTL_SECONDS,
    metadata: { preview, createdAt, size: byteLength, likes: 0, commentsCount: 0 },
  });

  return jsonResponse({ id, preview, createdAt, size: byteLength, likes: 0, commentsCount: 0 });
}

async function handleList(env) {
  if (!env.TEXTBRIDGE) return jsonResponse({ error: 'no_kv_binding' }, 500);
  const result = await env.TEXTBRIDGE.list({ prefix: 'item:', limit: 1000 });
  const items = result.keys
    .map((k) => ({
      id: k.name.slice('item:'.length),
      preview: (k.metadata && k.metadata.preview) || '',
      createdAt: (k.metadata && k.metadata.createdAt) || 0,
      size: (k.metadata && k.metadata.size) || 0,
      likes: (k.metadata && k.metadata.likes) || 0,
      commentsCount: (k.metadata && k.metadata.commentsCount) || 0,
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, LIST_LIMIT);
  return jsonResponse({ items });
}

async function handleItem(env, id) {
  if (!env.TEXTBRIDGE) return jsonResponse({ error: 'no_kv_binding' }, 500);
  if (!id) return jsonResponse({ error: 'not_found' }, 404);
  const text = await env.TEXTBRIDGE.get(`item:${id}`);
  if (text === null) return jsonResponse({ error: 'not_found' }, 404);
  return jsonResponse({ id, text });
}

async function handleLike(request, env, id) {
  if (!env.TEXTBRIDGE) return jsonResponse({ error: 'no_kv_binding' }, 500);
  const rec = await env.TEXTBRIDGE.getWithMetadata(`item:${id}`);
  if (rec.value === null) return jsonResponse({ error: 'not_found' }, 404);
  let body;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const delta = body.liked === false ? -1 : 1;
  const meta = rec.metadata || {};
  const likes = Math.max(0, (meta.likes || 0) + delta);
  const newMeta = {
    preview: meta.preview,
    createdAt: meta.createdAt,
    size: meta.size,
    likes,
    commentsCount: meta.commentsCount || 0,
  };
  const exp = expirationFromCreatedAt(meta.createdAt);
  await env.TEXTBRIDGE.put(`item:${id}`, rec.value, { expiration: exp, metadata: newMeta });
  return jsonResponse({ likes });
}

async function handleGetComments(env, id) {
  if (!env.TEXTBRIDGE) return jsonResponse({ error: 'no_kv_binding' }, 500);
  const raw = await env.TEXTBRIDGE.get(`comments:${id}`);
  const comments = raw ? JSON.parse(raw) : [];
  return jsonResponse({ comments });
}

async function handleAddComment(request, env, id) {
  if (!env.TEXTBRIDGE) return jsonResponse({ error: 'no_kv_binding' }, 500);
  const rec = await env.TEXTBRIDGE.getWithMetadata(`item:${id}`);
  if (rec.value === null) return jsonResponse({ error: 'not_found' }, 404);
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'bad_json' }, 400);
  }
  const text = (typeof body.text === 'string' ? body.text : '').trim().slice(0, MAX_COMMENT_LEN);
  if (!text) return jsonResponse({ error: 'empty' }, 400);

  const raw = await env.TEXTBRIDGE.get(`comments:${id}`);
  const comments = raw ? JSON.parse(raw) : [];
  if (comments.length >= MAX_COMMENTS) return jsonResponse({ error: 'too_many' }, 400);
  comments.push({ text, createdAt: Date.now() });

  const meta = rec.metadata || {};
  const exp = expirationFromCreatedAt(meta.createdAt);

  await env.TEXTBRIDGE.put(`comments:${id}`, JSON.stringify(comments), { expiration: exp });

  const newMeta = {
    preview: meta.preview,
    createdAt: meta.createdAt,
    size: meta.size,
    likes: meta.likes || 0,
    commentsCount: comments.length,
  };
  await env.TEXTBRIDGE.put(`item:${id}`, rec.value, { expiration: exp, metadata: newMeta });

  return jsonResponse({ comments });
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Текстовый мост</title>
<style>
  :root{
    --bg:#ffffff;
    --border:#dddddd;
    --border-strong:#111111;
    --text:#111111;
    --text-muted:#767676;
    --mono: ui-monospace, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{
    background:var(--bg);
    color:var(--text);
    font-family:var(--sans);
    line-height:1.5;
    padding:28px 20px 56px;
    -webkit-font-smoothing:antialiased;
  }
  .wrap{max-width:640px;margin:0 auto;}
  header{margin-bottom:32px;}
  header h1{
    font-size:22px;
    font-weight:700;
    margin:0 0 6px;
    letter-spacing:-0.01em;
  }
  header p{margin:0;color:var(--text-muted);font-size:14px;}
  section{margin-bottom:32px;}
  label.field-label{display:block;font-size:13px;color:var(--text-muted);margin-bottom:8px;}
  textarea, input[type="text"]{
    width:100%;
    background:#fff;
    border:1px solid var(--border-strong);
    border-radius:0;
    color:var(--text);
    font-family:var(--sans);
    font-size:16px;
    padding:12px 14px;
  }
  textarea{resize:vertical;}
  #upload-text{min-height:130px;}
  .upload-row{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-top:10px;}
  .byte-counter{font-family:var(--mono);font-size:12px;color:var(--text-muted);}
  .byte-counter.over{color:#111;font-weight:700;text-decoration:underline;}
  .file-pick{font-size:12px;color:var(--text-muted);}
  .file-pick input{font-size:12px;max-width:150px;color:var(--text-muted);}
  button{font-family:var(--sans);font-size:14px;font-weight:600;border-radius:0;cursor:pointer;}
  button.primary{background:#111;color:#fff;border:1px solid #111;padding:12px 22px;}
  button.primary:disabled{opacity:0.35;cursor:default;}
  button.ghost{background:transparent;border:1px solid var(--border-strong);color:var(--text);font-weight:500;font-size:13px;padding:10px 16px;}
  button.ghost:hover{background:#111;color:#fff;}
  #status-line{min-height:18px;font-size:13px;margin-top:8px;color:var(--text-muted);}
  #status-line.ok{color:#111;font-weight:600;}
  #status-line.err{color:#111;font-weight:700;text-decoration:underline;}
  .list-meta{display:flex;justify-content:space-between;align-items:baseline;margin-top:20px;margin-bottom:6px;}
  .list-meta h2{font-size:13px;color:var(--text-muted);font-weight:500;margin:0;}
  .list-meta span{font-family:var(--mono);font-size:12px;color:var(--text-muted);}
  #items{border-top:1px solid var(--border);}
  .item{border-bottom:1px solid var(--border);padding:16px 0;cursor:pointer;}
  .item-preview{font-size:15px;color:var(--text);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
  .item-meta{margin-top:8px;display:flex;align-items:center;flex-wrap:wrap;gap:14px;font-family:var(--mono);font-size:12px;color:var(--text-muted);}
  .like-btn{background:none;border:none;padding:4px 2px;margin:-4px -2px;font-family:var(--mono);font-size:12px;color:var(--text-muted);cursor:pointer;}
  .like-btn.liked{color:#111;font-weight:700;}
  .empty-hint{color:var(--text-muted);font-size:13px;padding:20px 0;}
  .panel{margin-top:12px;border:1px solid var(--border-strong);padding:16px;cursor:default;}
  .panel textarea{min-height:160px;font-family:var(--mono);font-size:13px;}
  .panel-actions{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:10px;}
  .panel-hint{font-size:12px;color:var(--text-muted);}
  .comments-block{margin-top:18px;padding-top:16px;border-top:1px solid var(--border);}
  .comments-title{font-size:13px;color:var(--text-muted);margin-bottom:10px;}
  .comment-row{padding:8px 0;border-bottom:1px solid var(--border);}
  .comment-text{font-size:14px;}
  .comment-time{font-family:var(--mono);font-size:11px;color:var(--text-muted);margin-top:3px;}
  .comment-form{display:flex;gap:8px;margin-top:12px;}
  .comment-form input{flex:1;padding:9px 12px;font-size:16px;}
  footer{margin-top:44px;font-size:12px;color:var(--text-muted);}
  @media (max-width:380px){
    body{padding:20px 14px 48px;}
    header h1{font-size:20px;}
  }
</style>
</head>
<body>
<div class="wrap">

  <header>
    <h1>Текстовый мост</h1>
    <p>Вставь текст с телефона — забери его на любом компьютере по этой же ссылке.</p>
  </header>

  <section>
    <label class="field-label" for="upload-text">Новая запись</label>
    <textarea id="upload-text" placeholder="Вставь или напечатай текст сюда…"></textarea>
    <div class="upload-row">
      <div class="file-pick">
        или файл: <input type="file" id="file-pick" accept=".txt,text/plain">
      </div>
      <button class="primary" id="upload-btn" type="button">Опубликовать</button>
    </div>
    <div class="byte-counter" id="byte-counter">0 / 5 МБ</div>
    <div id="status-line"></div>
  </section>

  <section>
    <label class="field-label" for="search-input">Поиск — начни вводить начало текста</label>
    <input type="text" id="search-input" placeholder="Например: первые слова файла…">
    <div class="list-meta">
      <h2 id="list-title">Последние записи</h2>
      <span id="list-count"></span>
    </div>
    <div id="items"></div>
  </section>

  <footer>Записи хранятся 30 дней и удаляются автоматически. Ссылку стоит давать только тем, кому она правда нужна — записи не защищены паролем.</footer>

</div>

<script>
(function(){
  var MAX_BYTES = ${MAX_BYTES};
  var textarea = document.getElementById('upload-text');
  var filePick = document.getElementById('file-pick');
  var uploadBtn = document.getElementById('upload-btn');
  var byteCounter = document.getElementById('byte-counter');
  var statusLine = document.getElementById('status-line');
  var searchInput = document.getElementById('search-input');
  var itemsEl = document.getElementById('items');
  var listTitle = document.getElementById('list-title');
  var listCount = document.getElementById('list-count');

  var allItems = [];
  var openPanelId = null;

  function bytesOf(str){ return new TextEncoder().encode(str).length; }

  function formatSize(bytes){
    if (bytes < 1024) return bytes + ' Б';
    if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' КБ';
    return (bytes/1024/1024).toFixed(2) + ' МБ';
  }

  function formatRelTime(ts){
    var diff = Date.now() - ts;
    var min = Math.floor(diff/60000);
    if (min < 1) return 'только что';
    if (min < 60) return min + ' мин назад';
    var hrs = Math.floor(min/60);
    if (hrs < 24) return hrs + ' ч назад';
    var days = Math.floor(hrs/24);
    if (days < 7) return days + ' дн назад';
    var d = new Date(ts);
    return d.toLocaleDateString('ru-RU');
  }

  function pluralRu(n, one, few, many){
    var mod100 = Math.abs(n) % 100;
    var mod10 = mod100 % 10;
    if (mod100 > 10 && mod100 < 20) return many;
    if (mod10 > 1 && mod10 < 5) return few;
    if (mod10 === 1) return one;
    return many;
  }

  function isLikedLocally(id){
    try { return localStorage.getItem('tb_liked_' + id) === '1'; } catch(e){ return false; }
  }
  function setLikedLocally(id, liked){
    try {
      if (liked) localStorage.setItem('tb_liked_' + id, '1');
      else localStorage.removeItem('tb_liked_' + id);
    } catch(e){}
  }

  function updateByteCounter(){
    var n = bytesOf(textarea.value);
    byteCounter.textContent = formatSize(n) + ' / 5 МБ';
    byteCounter.classList.toggle('over', n > MAX_BYTES);
    uploadBtn.disabled = n === 0 || n > MAX_BYTES;
  }
  textarea.addEventListener('input', updateByteCounter);
  updateByteCounter();

  filePick.addEventListener('change', function(){
    var f = filePick.files && filePick.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function(){
      textarea.value = String(reader.result || '');
      updateByteCounter();
    };
    reader.readAsText(f, 'utf-8');
  });

  function setStatus(msg, kind){
    statusLine.textContent = msg || '';
    statusLine.className = kind ? kind : '';
  }

  uploadBtn.addEventListener('click', function(){
    var text = textarea.value;
    if (!text.trim()) return;
    if (bytesOf(text) > MAX_BYTES){
      setStatus('Файл больше 5 МБ — сократи текст.', 'err');
      return;
    }
    uploadBtn.disabled = true;
    setStatus('Публикую…');
    fetch('/api/upload', {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify({ text: text })
    })
    .then(function(r){ return r.json().then(function(data){ return {ok:r.ok, data:data}; }); })
    .then(function(res){
      if (!res.ok){
        setStatus('Не получилось: ' + (res.data && res.data.error || 'ошибка'), 'err');
        return;
      }
      textarea.value = '';
      filePick.value = '';
      updateByteCounter();
      setStatus('Опубликовано.', 'ok');
      loadList();
    })
    .catch(function(){ setStatus('Нет соединения с сервером.', 'err'); })
    .finally(function(){ updateByteCounter(); });
  });

  function matches(item, q){
    if (!q) return true;
    return item.preview.toLowerCase().indexOf(q) !== -1;
  }

  function renderLikeBtn(el, item){
    var liked = isLikedLocally(item.id);
    el.classList.toggle('liked', liked);
    el.textContent = (liked ? '♥ ' : '♡ ') + (item.likes||0);
  }

  function toggleLike(item, likeEl){
    var liked = isLikedLocally(item.id);
    var next = !liked;
    item.likes = Math.max(0, (item.likes||0) + (next ? 1 : -1));
    setLikedLocally(item.id, next);
    renderLikeBtn(likeEl, item);
    fetch('/api/like/' + encodeURIComponent(item.id), {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ liked: next })
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      if (typeof data.likes === 'number'){
        item.likes = data.likes;
        renderLikeBtn(likeEl, item);
      }
    })
    .catch(function(){});
  }

  function updateCommentBadge(id, count){
    var item = allItems.filter(function(x){ return x.id === id; })[0];
    if (item) item.commentsCount = count;
    var span = document.getElementById('comment-count-' + id);
    if (span){
      if (count > 0){
        span.textContent = count + ' ' + pluralRu(count, 'комментарий', 'комментария', 'комментариев');
      } else {
        span.remove();
      }
    } else if (count > 0) {
      var metaRow = itemsEl.querySelector('[data-item-id="' + id + '"] .item-meta');
      if (metaRow){
        var c = document.createElement('span');
        c.id = 'comment-count-' + id;
        c.textContent = count + ' ' + pluralRu(count, 'комментарий', 'комментария', 'комментариев');
        metaRow.insertBefore(c, metaRow.lastChild);
      }
    }
  }

  function render(){
    var q = searchInput.value.trim().toLowerCase();
    var filtered = allItems.filter(function(it){ return matches(it, q); });

    listTitle.textContent = q ? 'Результаты поиска' : 'Последние записи';
    listCount.textContent = filtered.length ? filtered.length + ' шт.' : '';

    itemsEl.innerHTML = '';
    if (!filtered.length){
      var empty = document.createElement('div');
      empty.className = 'empty-hint';
      empty.textContent = q ? 'Ничего не найдено по этому запросу.' : 'Пока нет ни одной записи — стань первым.';
      itemsEl.appendChild(empty);
      return;
    }

    filtered.forEach(function(it){
      var row = document.createElement('div');
      row.className = 'item';
      row.dataset.itemId = it.id;

      var preview = document.createElement('div');
      preview.className = 'item-preview';
      preview.textContent = it.preview;
      row.appendChild(preview);

      var meta = document.createElement('div');
      meta.className = 'item-meta';

      var t = document.createElement('span');
      t.textContent = formatRelTime(it.createdAt);
      meta.appendChild(t);

      var s = document.createElement('span');
      s.textContent = formatSize(it.size);
      meta.appendChild(s);

      if (it.commentsCount > 0){
        var c = document.createElement('span');
        c.id = 'comment-count-' + it.id;
        c.textContent = it.commentsCount + ' ' + pluralRu(it.commentsCount, 'комментарий', 'комментария', 'комментариев');
        meta.appendChild(c);
      }

      var likeBtn = document.createElement('button');
      likeBtn.className = 'like-btn';
      likeBtn.type = 'button';
      renderLikeBtn(likeBtn, it);
      likeBtn.addEventListener('click', function(ev){
        ev.stopPropagation();
        toggleLike(it, likeBtn);
      });
      meta.appendChild(likeBtn);

      row.appendChild(meta);

      if (openPanelId === it.id){
        row.appendChild(buildPanel(it));
      }

      row.addEventListener('click', function(e){
        if (e.target.closest('.panel') || e.target.closest('.like-btn')) return;
        openPanelId = (openPanelId === it.id) ? null : it.id;
        render();
        if (openPanelId === it.id){
          loadFullText(it.id);
          loadComments(it.id);
        }
      });

      itemsEl.appendChild(row);
    });
  }

  function buildPanel(it){
    var panel = document.createElement('div');
    panel.className = 'panel';

    var ta = document.createElement('textarea');
    ta.readOnly = true;
    ta.value = 'Загружаю…';
    ta.id = 'panel-ta-' + it.id;
    panel.appendChild(ta);

    var actions = document.createElement('div');
    actions.className = 'panel-actions';

    var hint = document.createElement('div');
    hint.className = 'panel-hint';
    hint.textContent = 'Текст выделен — можно нажать Ctrl+C';

    var copyBtn = document.createElement('button');
    copyBtn.className = 'ghost';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Скопировать';
    copyBtn.addEventListener('click', function(ev){
      ev.stopPropagation();
      ta.focus();
      ta.select();
      if (navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(ta.value).then(function(){
          copyBtn.textContent = 'Скопировано';
          setTimeout(function(){ copyBtn.textContent = 'Скопировать'; }, 1500);
        }).catch(function(){});
      }
    });

    actions.appendChild(hint);
    actions.appendChild(copyBtn);
    panel.appendChild(actions);

    var commentsBlock = document.createElement('div');
    commentsBlock.className = 'comments-block';

    var title = document.createElement('div');
    title.className = 'comments-title';
    title.id = 'comments-title-' + it.id;
    title.textContent = 'Комментарии';
    commentsBlock.appendChild(title);

    var list = document.createElement('div');
    list.id = 'comments-list-' + it.id;
    commentsBlock.appendChild(list);

    var form = document.createElement('div');
    form.className = 'comment-form';

    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 500;
    input.placeholder = 'Написать комментарий…';
    input.addEventListener('click', function(ev){ ev.stopPropagation(); });
    input.addEventListener('keydown', function(ev){
      if (ev.key === 'Enter'){ ev.stopPropagation(); submitComment(it.id, input); }
    });

    var sendBtn = document.createElement('button');
    sendBtn.className = 'ghost';
    sendBtn.type = 'button';
    sendBtn.textContent = 'Отправить';
    sendBtn.addEventListener('click', function(ev){
      ev.stopPropagation();
      submitComment(it.id, input);
    });

    form.appendChild(input);
    form.appendChild(sendBtn);
    commentsBlock.appendChild(form);

    panel.appendChild(commentsBlock);
    return panel;
  }

  function renderComments(id, comments){
    var list = document.getElementById('comments-list-' + id);
    var title = document.getElementById('comments-title-' + id);
    if (!list) return;
    list.innerHTML = '';
    if (title){
      title.textContent = comments.length
        ? comments.length + ' ' + pluralRu(comments.length, 'комментарий', 'комментария', 'комментариев')
        : 'Комментариев пока нет';
    }
    comments.slice().reverse().forEach(function(c){
      var row = document.createElement('div');
      row.className = 'comment-row';
      var text = document.createElement('div');
      text.className = 'comment-text';
      text.textContent = c.text;
      var time = document.createElement('div');
      time.className = 'comment-time';
      time.textContent = formatRelTime(c.createdAt);
      row.appendChild(text);
      row.appendChild(time);
      list.appendChild(row);
    });
  }

  function loadComments(id){
    fetch('/api/comments/' + encodeURIComponent(id))
      .then(function(r){ return r.json(); })
      .then(function(data){ renderComments(id, data.comments || []); })
      .catch(function(){});
  }

  function submitComment(id, inputEl){
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.disabled = true;
    fetch('/api/comments/' + encodeURIComponent(id), {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ text: text })
    })
    .then(function(r){ return r.json(); })
    .then(function(data){
      inputEl.value = '';
      var comments = data.comments || [];
      renderComments(id, comments);
      updateCommentBadge(id, comments.length);
    })
    .catch(function(){})
    .finally(function(){ inputEl.disabled = false; });
  }

  function loadFullText(id){
    fetch('/api/item/' + encodeURIComponent(id))
      .then(function(r){ return r.json(); })
      .then(function(data){
        var ta = document.getElementById('panel-ta-' + id);
        if (!ta) return;
        ta.value = data.text || '';
        ta.focus();
        ta.select();
      })
      .catch(function(){
        var ta = document.getElementById('panel-ta-' + id);
        if (ta) ta.value = 'Не удалось загрузить текст.';
      });
  }

  function loadList(){
    fetch('/api/list')
      .then(function(r){ return r.json(); })
      .then(function(data){
        allItems = data.items || [];
        render();
      })
      .catch(function(){
        itemsEl.innerHTML = '';
        var e = document.createElement('div');
        e.className = 'empty-hint';
        e.textContent = 'Не удалось загрузить список — проверь соединение.';
        itemsEl.appendChild(e);
      });
  }

  searchInput.addEventListener('input', render);

  loadList();
})();
</script>
</body>
</html>`;
