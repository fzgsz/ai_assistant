// ── 主题 ────────────────────────────────────────────
function getTheme() {
  return localStorage.getItem('theme')
    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const btn = $('#btnTheme');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  // 同步移动端状态栏颜色
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.content = theme === 'dark' ? '#111827' : '#f5f5f5';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
}

// ── 状态 ────────────────────────────────────────────
const state = {
  conversations: [],
  currentConvId: null,
  isStreaming: false,
  model: localStorage.getItem('model') || 'deepseek-chat'
};

// ── DOM 引用 ────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const messagesEl = $('#messages');
const inputEl = $('#messageInput');
const btnSend = $('#btnSend');
const btnNewChat = $('#btnNewChat');
const btnToggleSidebar = $('#btnToggleSidebar');
const sidebarOverlay = $('#sidebarOverlay');
const conversationList = $('#conversationList');
const currentTitle = $('#currentTitle');
const welcome = $('#welcome');

// ── 初始化 ──────────────────────────────────────────
async function init() {
  setTheme(getTheme());
  const modelSel = $('#modelSelect');
  modelSel.value = state.model;
  modelSel.addEventListener('change', () => {
    state.model = modelSel.value;
    localStorage.setItem('model', state.model);
  });
  await loadConversations();
  if (state.conversations.length === 0) {
    await createConversation();
  }
  selectConversation(state.currentConvId);
}

// ── 会话列表 ────────────────────────────────────────
async function loadConversations() {
  const res = await fetch('/api/conversations');
  state.conversations = await res.json();
  renderConversationList();
}

async function createConversation() {
  const res = await fetch('/api/conversations', { method: 'POST' });
  const { id } = await res.json();
  await loadConversations();
  state.currentConvId = id;
  selectConversation(id);
}

async function deleteConversation(id) {
  await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  if (state.currentConvId === id) {
    state.currentConvId = null;
    messagesEl.innerHTML = '';
    welcome.style.display = 'block';
    currentTitle.textContent = 'AI 助手';
  }
  await loadConversations();
  if (state.conversations.length === 0) {
    await createConversation();
  }
}

function renderConversationList() {
  conversationList.innerHTML = state.conversations.map(c => `
    <div class="conv-item${c.id === state.currentConvId ? ' active' : ''}"
         data-id="${c.id}">
      <span class="conv-title">${escapeHtml(c.title)}</span>
      <button class="btn-delete" data-delete="${c.id}">×</button>
    </div>
  `).join('');

  // 绑定事件
  conversationList.querySelectorAll('.conv-item').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.dataset.delete) {
        e.stopPropagation();
        deleteConversation(Number(e.target.dataset.delete));
        return;
      }
      selectConversation(Number(item.dataset.id));
    });
  });
}

async function selectConversation(id) {
  if (!id) return;
  state.currentConvId = id;
  if (isMobile()) closeSidebar();
  renderConversationList();
  currentTitle.textContent = state.conversations.find(c => c.id === id)?.title || 'AI 助手';

  const res = await fetch(`/api/conversations/${id}`);
  const { messages } = await res.json();
  renderMessages(messages);
}

// ── 消息渲染 ────────────────────────────────────────
function renderMessages(messages) {
  messagesEl.innerHTML = '';
  welcome.style.display = 'none';

  if (messages.length === 0) {
    welcome.style.display = 'block';
    return;
  }

  messages.forEach(msg => {
    appendMessageBubble(msg.role, msg.content, msg.id);
  });
  addMessageActions();
  scrollToBottom();
}

function appendMessageBubble(role, content, msgId) {
  const el = document.createElement('div');
  el.className = `message ${role}`;
  if (msgId) el.dataset.id = msgId;
  const avatar = role === 'user' ? '👤' : '🤖';
  const formatted = role === 'assistant'
    ? marked.parse(content)
    : `<span class="msg-content">${escapeHtml(content)}</span>`;
  el.innerHTML = `
    <div class="avatar">${avatar}</div>
    <div class="bubble">${formatted}</div>
  `;
  if (role === 'assistant') addCopyButtons(el.querySelector('.bubble'));
  messagesEl.appendChild(el);
  welcome.style.display = 'none';
}

// ── 消息操作：编辑 / 重新生成 ────────────────────────
function addMessageActions() {
  const allMessages = messagesEl.querySelectorAll('.message');
  if (allMessages.length === 0) return;

  // 给每条用户消息加编辑按钮
  allMessages.forEach(msg => {
    if (msg.classList.contains('user') && !msg.querySelector('.btn-edit')) {
      const btn = document.createElement('button');
      btn.className = 'btn-edit';
      btn.textContent = '✎';
      btn.title = '编辑消息';
      btn.addEventListener('click', () => startEdit(msg));
      msg.querySelector('.bubble').appendChild(btn);
    }
  });

  // 给最后一条 AI 消息加重试按钮
  const lastAI = [...allMessages].reverse().find(m => m.classList.contains('assistant'));
  if (lastAI && !lastAI.querySelector('.btn-retry')) {
    const btn = document.createElement('button');
    btn.className = 'btn-retry';
    btn.textContent = '↻';
    btn.title = '重新生成';
    btn.addEventListener('click', () => regenerate(lastAI));
    lastAI.querySelector('.bubble').appendChild(btn);
  }
}

function startEdit(msgEl) {
  const msgId = Number(msgEl.dataset.id);
  if (!msgId || state.isStreaming) return;

  const bubble = msgEl.querySelector('.bubble');
  const origText = bubble.querySelector('.msg-content')?.textContent || bubble.childNodes[0]?.textContent || '';

  bubble.innerHTML = `
    <textarea class="edit-textarea">${escapeHtml(origText)}</textarea>
    <div class="edit-actions">
      <button class="btn-cancel-edit">取消</button>
      <button class="btn-save-edit">保存并重发</button>
    </div>
  `;

  const textarea = bubble.querySelector('.edit-textarea');
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);

  bubble.querySelector('.btn-cancel-edit').addEventListener('click', () => {
    selectConversation(state.currentConvId);
  });

  bubble.querySelector('.btn-save-edit').addEventListener('click', () => {
    const newContent = textarea.value.trim();
    if (!newContent) return;
    doRetry(msgId, newContent);
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const newContent = textarea.value.trim();
      if (newContent) doRetry(msgId, newContent);
    }
  });
}

function regenerate(aiMsgEl) {
  if (state.isStreaming) return;

  // 找到 AI 消息前面那条用户消息的 ID
  const userMsg = aiMsgEl.previousElementSibling;
  if (!userMsg || !userMsg.classList.contains('user')) return;
  const msgId = Number(userMsg.dataset.id);
  if (!msgId) return;

  doRetry(msgId, null);
}

async function doRetry(msgId, newContent) {
  state.isStreaming = true;
  btnSend.disabled = true;

  // 回溯消息
  await fetch(`/api/messages/${msgId}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: newContent || '' })
  });

  // 重新加载会话（此时已回溯到编辑位置）
  const res = await fetch(`/api/conversations/${state.currentConvId}`);
  const { messages } = await res.json();
  renderMessages(messages);

  // 调用聊天 API 重新生成
  try {
    const chatRes = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: state.currentConvId,
        message: newContent || messages[messages.length - 1]?.content || '',
        model: state.model
      })
    });

    const streamBubble = getOrCreateStreamingBubble();
    streamBubble.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
    scrollToBottom();

    const reader = chatRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.error) {
            streamBubble.innerHTML = `<span style="color:red">错误: ${escapeHtml(data.error)}</span>`;
            return;
          }
          if (data.done) {
            streamBubble.parentElement.classList.remove('streaming');
            return;
          }
          if (data.content) {
            fullText += data.content;
            streamBubble.innerHTML = marked.parse(fullText);
            scrollToBottom();
          }
        } catch (e) { /* ignore */ }
      }
    }
    streamBubble.parentElement.classList.remove('streaming');
    streamBubble.innerHTML = marked.parse(fullText);
    addCopyButtons(streamBubble);
  } catch (err) {
    getOrCreateStreamingBubble().innerHTML = `<span style="color:red">请求失败: ${escapeHtml(err.message)}</span>`;
  } finally {
    state.isStreaming = false;
    btnSend.disabled = false;
    await loadConversations();
  }
}

function getOrCreateStreamingBubble() {
  let el = messagesEl.querySelector('.message.streaming');
  if (!el) {
    el = document.createElement('div');
    el.className = 'message assistant streaming';
    el.innerHTML = `
      <div class="avatar">🤖</div>
      <div class="bubble"></div>
    `;
    messagesEl.appendChild(el);
    welcome.style.display = 'none';
  }
  return el.querySelector('.bubble');
}

// ── 发送消息 ────────────────────────────────────────
async function sendMessage() {
  const content = inputEl.value.trim();
  if (!content || state.isStreaming) return;

  inputEl.value = '';
  inputEl.style.height = 'auto';
  btnSend.disabled = true;
  state.isStreaming = true;

  appendMessageBubble('user', content);
  scrollToBottom();

  // 显示打字指示器
  const streamBubble = getOrCreateStreamingBubble();
  streamBubble.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  scrollToBottom();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversation_id: state.currentConvId,
        message: content,
        model: state.model
      })
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const data = JSON.parse(line.slice(6));
          if (data.error) {
            streamBubble.innerHTML = `<span style="color:red">错误: ${escapeHtml(data.error)}</span>`;
            return;
          }
          if (data.done) {
            streamBubble.parentElement.classList.remove('streaming');
            return;
          }
          if (data.content) {
            fullText += data.content;
            streamBubble.innerHTML = marked.parse(fullText);
            scrollToBottom();
          }
        } catch (e) { /* 忽略解析不完整的行 */ }
      }
    }
    streamBubble.parentElement.classList.remove('streaming');
    streamBubble.innerHTML = marked.parse(fullText);
    addCopyButtons(streamBubble);

  } catch (err) {
    const streamBubble = getOrCreateStreamingBubble();
    streamBubble.innerHTML = `<span style="color:red">请求失败: ${escapeHtml(err.message)}</span>`;
  } finally {
    state.isStreaming = false;
    btnSend.disabled = false;
    await loadConversations();
    inputEl.focus();
  }
}

// ── 代码块复制 ──────────────────────────────────────
function addCopyButtons(bubble) {
  bubble.querySelectorAll('pre').forEach(pre => {
    if (pre.querySelector('.btn-copy')) return; // 已有按钮则跳过
    pre.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'btn-copy';
    btn.textContent = '复制';
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code')?.textContent || pre.textContent;
      navigator.clipboard.writeText(code).then(() => {
        btn.textContent = '已复制';
        setTimeout(() => (btn.textContent = '复制'), 2000);
      });
    });
    pre.appendChild(btn);
  });
}

// ── 工具函数 ────────────────────────────────────────
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, c => map[c]);
}

// ── 事件绑定 ────────────────────────────────────────
$('#btnTheme').addEventListener('click', toggleTheme);
btnNewChat.addEventListener('click', () => createConversation());

btnSend.addEventListener('click', () => sendMessage());

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// 自动调整输入框高度
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
});

function isMobile() {
  return window.matchMedia('(max-width: 768px)').matches;
}

function openSidebar() {
  document.querySelector('.sidebar').classList.add('open');
  sidebarOverlay.classList.add('visible');
}
function closeSidebar() {
  document.querySelector('.sidebar').classList.remove('open');
  sidebarOverlay.classList.remove('visible');
}
function toggleSidebar() {
  const sidebar = document.querySelector('.sidebar');
  if (sidebar.classList.contains('open')) {
    closeSidebar();
  } else {
    openSidebar();
  }
}

btnToggleSidebar.addEventListener('click', toggleSidebar);

// 点击遮罩关闭侧边栏
sidebarOverlay.addEventListener('click', closeSidebar);

// 点击消息区关闭移动端侧边栏
messagesEl.addEventListener('click', () => {
  if (isMobile()) closeSidebar();
});

// ── 启动 ────────────────────────────────────────────
init();
