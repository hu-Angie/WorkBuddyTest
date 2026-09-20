const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const COMMENTS_FILE = path.join(DATA_DIR, 'comments.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error('读取失败', file, e.message);
  }
  return fallback;
}

// 防抖写盘，避免高频操作时反复落盘
function makeWriter(file) {
  let timer = null;
  let pending = null;
  return (data) => {
    pending = data;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        fs.writeFileSync(file, JSON.stringify(pending, null, 2));
      } catch (e) {
        console.error('写入失败', file, e.message);
      }
    }, 200);
  };
}

const now = Date.now();
const seedTasks = [
  { id: 'seed1', title: '搭建项目骨架', desc: '初始化前后端结构并安装依赖', assignee: '小明', priority: 'high', due: '', status: 'done', createdAt: now - 300000, updatedAt: now - 300000, order: 1 },
  { id: 'seed2', title: '实现看板拖拽', desc: '卡片可在三列之间拖动换状态', assignee: '小红', priority: 'med', due: '', status: 'doing', createdAt: now - 200000, updatedAt: now - 200000, order: 2 },
  { id: 'seed3', title: '接入实时活动流', desc: 'WebSocket 广播操作事件并滚动展示', assignee: '', priority: 'low', due: '', status: 'todo', createdAt: now - 100000, updatedAt: now - 100000, order: 3 },
];

let tasks = readJSON(TASKS_FILE, null) || seedTasks;
let comments = readJSON(COMMENTS_FILE, null) || [];
let activities = []; // 活动流仅存内存，最近 50 条

const writeTasks = makeWriter(TASKS_FILE);
const writeComments = makeWriter(COMMENTS_FILE);

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function addActivity(type, actor, summary) {
  const act = { id: uid(), type, actor, summary, createdAt: Date.now() };
  activities.unshift(act);
  if (activities.length > 50) activities.length = 50;
  return act;
}

function extractMentions(text) {
  const found = text.match(/@([^\s@]+)/g);
  return found ? [...new Set(found.map((s) => s.slice(1)))] : [];
}

function labelOf(status) {
  return status === 'todo' ? '待办' : status === 'doing' ? '进行中' : '已完成';
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const members = new Map(); // ws -> member

function onlineMembers() {
  return [...members.values()].map((m) => ({ id: m.id, name: m.name, color: m.color }));
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

// ---------- REST ----------

app.get('/api/state', (req, res) => {
  res.json({ tasks, comments, activities, members: onlineMembers() });
});

app.post('/api/tasks', (req, res) => {
  const { title, desc = '', assignee = '', priority = 'med', due = '', status = 'todo' } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: '标题不能为空' });
  const t = Date.now();
  const task = { id: uid(), title: title.trim(), desc, assignee, priority, due, status, createdAt: t, updatedAt: t, order: t };
  tasks.push(task);
  writeTasks(tasks);
  const act = addActivity('task:created', assignee || '某人', `创建了任务「${task.title}」`);
  broadcast({ type: 'task:created', task, activity: act });
  res.status(201).json(task);
});

app.put('/api/tasks/:id', (req, res) => {
  const task = tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const before = task.status;
  const patch = req.body || {};
  delete patch.id;
  Object.assign(task, patch, { updatedAt: Date.now() });
  writeTasks(tasks);
  const moved = before !== task.status;
  const type = moved ? 'task:moved' : 'task:updated';
  const summary = moved
    ? `将「${task.title}」移动到 ${labelOf(task.status)}`
    : `更新了任务「${task.title}」`;
  const act = addActivity(type, task.assignee || '某人', summary);
  broadcast({ type, task, activity: act });
  res.json(task);
});

app.delete('/api/tasks/:id', (req, res) => {
  const idx = tasks.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '任务不存在' });
  const [task] = tasks.splice(idx, 1);
  comments = comments.filter((c) => c.taskId !== task.id);
  writeTasks(tasks);
  writeComments(comments);
  const act = addActivity('task:deleted', task.assignee || '某人', `删除了任务「${task.title}」`);
  broadcast({ type: 'task:deleted', taskId: task.id, activity: act });
  res.json({ ok: true });
});

app.post('/api/tasks/:id/comments', (req, res) => {
  const task = tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: '任务不存在' });
  const { author = '匿名', text = '' } = req.body || {};
  if (!text.trim()) return res.status(400).json({ error: '评论不能为空' });
  const c = {
    id: uid(),
    taskId: task.id,
    author,
    text: text.trim(),
    mentions: extractMentions(text),
    createdAt: Date.now(),
  };
  comments.push(c);
  writeComments(comments);
  const act = addActivity('comment:added', author, `评论了「${task.title}」`);
  broadcast({ type: 'comment:added', comment: c, activity: act });
  res.status(201).json(c);
});

// ---------- WebSocket ----------

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'hello' && msg.name) {
      const member = {
        id: uid(),
        name: String(msg.name).slice(0, 20),
        color: colorFor(msg.name),
      };
      members.set(ws, member);
      ws.send(JSON.stringify({
        type: 'init',
        tasks,
        comments,
        activities,
        members: onlineMembers(),
        you: member,
      }));
      const act = addActivity('member:joined', member.name, '加入了工作台');
      broadcast({ type: 'member:joined', member, activity: act, members: onlineMembers() });
    }
  });

  ws.on('close', () => {
    const m = members.get(ws);
    if (!m) return;
    members.delete(ws);
    const act = addActivity('member:left', m.name, '离开了工作台');
    broadcast({ type: 'member:left', memberId: m.id, activity: act, members: onlineMembers() });
  });
});

function colorFor(name) {
  const palette = ['#4f7cff', '#22a06b', '#e8833a', '#c2477a', '#7a5af8', '#0ea5a5', '#d97706'];
  let h = 0;
  for (const ch of String(name)) h = (h + ch.charCodeAt(0)) % palette.length;
  return palette[h];
}

server.listen(PORT, () => {
  console.log(`实时协作工作台已启动: http://localhost:${PORT}`);
});
