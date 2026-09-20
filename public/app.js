const state = { tasks: [], comments: [], activities: [] };
let members = [];
let me = null;
let ws = null;
let openTaskId = null;
let dragId = null;

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// 与后端 colorFor 保持一致的配色算法
const PALETTE = ['#4f7cff', '#22a06b', '#e8833a', '#c2477a', '#7a5af8', '#0ea5a5', '#d97706'];
function colorOf(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h + ch.charCodeAt(0)) % PALETTE.length;
  return PALETTE[h];
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initial(name) {
  return String(name || '?').trim().charAt(0).toUpperCase();
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}

const PRIORITY = { high: '高', med: '中', low: '低' };
const STATUS = { todo: '待办', doing: '进行中', done: '已完成' };

// ---------- 接口 ----------

async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    let msg = '请求失败';
    try { msg = (await r.json()).error || msg; } catch { /* 忽略 */ }
    throw new Error(msg);
  }
  return r.json();
}

// ---------- 渲染 ----------

function renderBoard() {
  const buckets = { todo: [], doing: [], done: [] };
  for (const t of state.tasks) (buckets[t.status] || buckets.todo).push(t);

  for (const status of ['todo', 'doing', 'done']) {
    const list = buckets[status].sort((a, b) => a.order - b.order);
    const box = document.querySelector(`.cards[data-drop="${status}"]`);
    document.querySelector(`.count[data-count="${status}"]`).textContent = list.length;
    box.innerHTML = list.length
      ? list.map(cardHTML).join('')
      : '<p class="empty">暂无任务，拖动卡片到这里</p>';
  }
}

function cardHTML(t) {
  const n = state.comments.filter((c) => c.taskId === t.id).length;
  return `
    <div class="card" draggable="true" data-id="${t.id}" data-priority="${t.priority}">
      <p class="card-title">${esc(t.title)}</p>
      <div class="card-meta">
        ${t.assignee
          ? `<span class="assignee"><span class="assignee-dot" style="background:${colorOf(t.assignee)}">${esc(initial(t.assignee))}</span>${esc(t.assignee)}</span>`
          : '<span class="badge">未分配</span>'}
        <span class="badge">${PRIORITY[t.priority] || '中'}</span>
        ${t.due ? `<span class="card-flag">${esc(t.due)}</span>` : ''}
        ${n ? `<span class="badge">${n} 条评论</span>` : ''}
      </div>
    </div>`;
}

function renderStream() {
  const el = $('#streamList');
  if (!state.activities.length) {
    el.innerHTML = '<li class="empty">暂无动态，做点什么看看</li>';
    return;
  }
  el.innerHTML = state.activities
    .map((a, i) => `
      <li class="${a.mentionMe ? 'mine-mention' : ''} ${i === 0 ? 'fresh' : ''}">
        <span class="who">${esc(a.actor)}</span>
        ${a.mentionMe ? '<strong>[提到你]</strong> ' : ''}${esc(a.summary)}
        <span class="when">${timeAgo(a.createdAt)}</span>
      </li>`)
    .join('');
}

function renderMembers() {
  $('#avatars').innerHTML = members
    .map((m) => `<span class="avatar" style="background:${m.color}" title="${esc(m.name)}">${esc(initial(m.name))}</span>`)
    .join('');
  $('#onlineCount').textContent = `在线 ${members.length}`;
  $('#meBtn').textContent = me ? me.name : '未设置';
}

// ---------- 详情面板 ----------

function openPanel(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  openTaskId = id;
  renderPanel(task);
  $('#overlay').classList.remove('hidden');
}

function renderPanel(task) {
  const opts = (map, cur) =>
    Object.entries(map).map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('');

  $('#panel').innerHTML = `
    <h3>任务详情</h3>
    <div class="field"><label>标题</label><input id="pTitle" value="${esc(task.title)}" maxlength="60"></div>
    <div class="field"><label>描述</label><textarea id="pDesc" placeholder="补充说明">${esc(task.desc)}</textarea></div>
    <div class="row">
      <div class="field"><label>负责人</label><input id="pAssignee" value="${esc(task.assignee)}" placeholder="留空为未分配"></div>
      <div class="field"><label>优先级</label><select id="pPriority">${opts(PRIORITY, task.priority)}</select></div>
    </div>
    <div class="row">
      <div class="field"><label>状态</label><select id="pStatus">${opts(STATUS, task.status)}</select></div>
      <div class="field"><label>截止日期</label><input type="date" id="pDue" value="${esc(task.due)}"></div>
    </div>
    <div class="panel-actions">
      <button class="btn primary" id="pSave">保存</button>
      <button class="btn danger" id="pDelete">删除</button>
      <button class="btn ghost" id="pClose">关闭</button>
    </div>
    <div class="comments">
      <h4>评论 <span id="cCount">0</span></h4>
      <div id="cList"></div>
      <div class="chips" id="cChips"></div>
      <form class="comment-form" id="cForm">
        <input id="cInput" placeholder="写评论，@昵称 可提醒同事" maxlength="200" autocomplete="off">
        <button class="btn primary" type="submit">发送</button>
      </form>
    </div>`;

  renderComments(task.id);
  renderChips();

  $('#pSave').onclick = saveTask;
  $('#pDelete').onclick = deleteTask;
  $('#pClose').onclick = closePanel;
  $('#cForm').onsubmit = sendComment;
}

function renderComments(taskId) {
  const list = state.comments
    .filter((c) => c.taskId === taskId)
    .sort((a, b) => a.createdAt - b.createdAt);
  const box = $('#cList');
  const mine = (c) => me && c.mentions && c.mentions.includes(me.name);
  $('#cCount').textContent = `(${list.length})`;
  box.innerHTML = list.length
    ? list.map((c) => `
        <div class="comment ${mine(c) ? 'mine-mention' : ''}">
          <div class="c-head">
            <span class="c-author">${esc(c.author)}</span>
            <span class="c-time">${timeAgo(c.createdAt)}</span>
          </div>
          <div>${esc(c.text)}</div>
        </div>`).join('')
    : '<p class="empty">还没有评论，来说点什么</p>';
}

function renderChips() {
  const box = $('#cChips');
  if (!box) return;
  box.innerHTML = members.length
    ? `<div class="card-meta" style="margin:6px 0">${members
        .map((m) => `<span class="badge mention" data-name="${esc(m.name)}" style="cursor:pointer;background:${m.color};color:#fff">@${esc(m.name)}</span>`)
        .join('')}</div>`
    : '';
  box.querySelectorAll('.badge').forEach((el) => {
    el.onclick = () => {
      const input = $('#cInput');
      input.value += `@${el.dataset.name} `;
      input.focus();
    };
  });
}

function closePanel() {
  openTaskId = null;
  $('#overlay').classList.add('hidden');
}

async function saveTask() {
  const task = state.tasks.find((t) => t.id === openTaskId);
  if (!task) return;
  try {
    await api('PUT', `/api/tasks/${task.id}`, {
      title: $('#pTitle').value.trim() || task.title,
      desc: $('#pDesc').value,
      assignee: $('#pAssignee').value.trim(),
      priority: $('#pPriority').value,
      status: $('#pStatus').value,
      due: $('#pDue').value,
    });
    closePanel();
  } catch (e) {
    alert(e.message);
  }
}

async function deleteTask() {
  const task = state.tasks.find((t) => t.id === openTaskId);
  if (!task || !confirm(`确定删除「${task.title}」？`)) return;
  await api('DELETE', `/api/tasks/${task.id}`);
  closePanel();
}

async function sendComment(e) {
  e.preventDefault();
  const input = $('#cInput');
  const text = input.value.trim();
  if (!text || !openTaskId) return;
  input.value = '';
  await api('POST', `/api/tasks/${openTaskId}/comments`, { author: me ? me.name : '匿名', text });
}

// ---------- 任务操作 ----------

async function createTask(status, title) {
  await api('POST', '/api/tasks', { title, status });
}

async function moveTask(id, status) {
  const task = state.tasks.find((t) => t.id === id);
  if (!task || task.status === status) return;
  await api('PUT', `/api/tasks/${id}`, { status });
}

// ---------- 实时 ----------

function pushActivity(act) {
  if (!act) return;
  if (state.activities.some((a) => a.id === act.id)) return;
  state.activities.unshift(act);
  if (state.activities.length > 50) state.activities.length = 50;
  renderStream();
}

function upsertTask(task) {
  const i = state.tasks.findIndex((t) => t.id === task.id);
  if (i >= 0) state.tasks[i] = task;
  else state.tasks.push(task);
  renderBoard();
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'init':
      state.tasks = msg.tasks;
      state.comments = msg.comments;
      state.activities = [];
      members = msg.members;
      me = msg.you;
      msg.activities.forEach(pushActivity);
      renderBoard();
      renderStream();
      renderMembers();
      break;

    case 'task:created':
    case 'task:moved':
    case 'task:updated':
      upsertTask(msg.task);
      pushActivity(msg.activity);
      break;

    case 'task:deleted':
      state.tasks = state.tasks.filter((t) => t.id !== msg.taskId);
      state.comments = state.comments.filter((c) => c.taskId !== msg.taskId);
      if (openTaskId === msg.taskId) closePanel();
      renderBoard();
      pushActivity(msg.activity);
      break;

    case 'comment:added': {
      if (!state.comments.some((c) => c.id === msg.comment.id)) state.comments.push(msg.comment);
      renderBoard();
      if (openTaskId === msg.comment.taskId) renderComments(msg.comment.taskId);
      pushActivity({ ...msg.activity, mentionMe: !!me && msg.comment.mentions.includes(me.name) });
      break;
    }

    case 'member:joined':
    case 'member:left':
      members = msg.members;
      renderMembers();
      pushActivity(msg.activity);
      break;
  }
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    $('#connDot').classList.add('on');
    ws.send(JSON.stringify({ type: 'hello', name: me.name }));
  };
  ws.onclose = () => {
    $('#connDot').classList.remove('on');
    setTimeout(connect, 2000);
  };
  ws.onmessage = (e) => {
    try { handleMsg(JSON.parse(e.data)); } catch { /* 忽略异常消息 */ }
  };
}

// ---------- 事件绑定 ----------

const board = $('#board');

board.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.card');
  if (!card) return;
  dragId = card.dataset.id;
  e.dataTransfer.setData('text/plain', dragId);
});

board.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) openPanel(card.dataset.id);
});

$$('.column').forEach((col) => {
  col.addEventListener('dragover', (e) => {
    e.preventDefault();
    col.classList.add('drag-over');
  });
  col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
  col.addEventListener('drop', (e) => {
    e.preventDefault();
    col.classList.remove('drag-over');
    const id = e.dataTransfer.getData('text/plain') || dragId;
    if (id) moveTask(id, col.dataset.status);
  });
});

$$('.add-btn').forEach((btn) => {
  btn.onclick = () => {
    const form = document.querySelector(`.quick-add[data-status="${btn.dataset.status}"]`);
    form.classList.remove('hidden');
    form.querySelector('input').focus();
  };
});

$$('.quick-add').forEach((form) => {
  form.onsubmit = async (e) => {
    e.preventDefault();
    const input = form.querySelector('input');
    const title = input.value.trim();
    if (!title) return;
    input.value = '';
    form.classList.add('hidden');
    await createTask(form.dataset.status, title);
  };
});

$('#overlay').addEventListener('click', (e) => {
  if (e.target.id === 'overlay') closePanel();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePanel();
});

$('#meBtn').onclick = () => {
  const name = prompt('修改昵称（重新进入后生效）', me ? me.name : '');
  if (name && name.trim()) {
    localStorage.setItem('tb-name', name.trim().slice(0, 20));
    location.reload();
  }
};

// ---------- 启动 ----------

function enterBoard(name) {
  me = { name };
  localStorage.setItem('tb-name', name);
  $('#nameOverlay').classList.add('hidden');
  connect();
}

$('#nameSubmit').onclick = () => {
  const v = $('#nameInput').value.trim();
  if (v) enterBoard(v.slice(0, 20));
};

$('#nameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#nameSubmit').click();
});

(function init() {
  const saved = localStorage.getItem('tb-name');
  if (saved) {
    $('#nameOverlay').classList.add('hidden');
    me = { name: saved };
    renderMembers();
    connect();
  } else {
    $('#nameInput').focus();
  }
})();
