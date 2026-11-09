// ==================== MyShell 渲染进程 ====================
const Terminal = window.Terminal; // xterm 5.x UMD 将 Terminal 类直接挂在 window 上
const { FitAddon } = window.FitAddon;
const { WebLinksAddon } = window.WebLinksAddon;

// ------------------------------------------------- 配色主题
const THEMES = {
  'Catppuccin (默认)': {
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc',
    selectionBackground: '#585b70',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
    blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7',
    brightCyan: '#94e2d5', brightWhite: '#a6adc8',
  },
  'Solarized Dark': {
    background: '#002b36', foreground: '#839496', cursor: '#93a1a1',
    selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
  },
  'Monokai': {
    background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0',
    selectionBackground: '#49483e',
    black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75',
    blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe9', white: '#f8f8f2',
  },
  'Dracula': {
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f0',
    selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c',
    blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
  },
  'Light': {
    background: '#ffffff', foreground: '#333333', cursor: '#333333',
    selectionBackground: '#add6ff',
    black: '#333333', red: '#d44e40', green: '#448c27', yellow: '#b16504',
    blue: '#4265cf', magenta: '#a45fc2', cyan: '#008b8b', white: '#bbbbbb',
  },
};

// ------------------------------------------------- 全局状态
let tabs = [];          // { id, name, type:'local'|'ssh', session, term, fit, wrapEl, status, logging }
let activeTabId = null;
let sessions = [];      // 已保存会话
let quickCommands = JSON.parse(localStorage.getItem('myshell.quick') || '["htop","df -h","free -h","tail -f /var/log/syslog"]');
let editTarget = null;  // null=新建, 会话对象=编辑
let connectAfterSave = false;
let tabSeq = 0;

const $ = (sel) => document.querySelector(sel);
const termContainer = $('#term-container');
const tabbar = $('#tabbar');

function uid() { return 'tab-' + Date.now() + '-' + (++tabSeq); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ------------------------------------------------- 主题
// 颜色工具: 由终端主题色推导整套 UI 变量
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
function mixColor(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b);
  return rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
function isDarkColor(h) {
  const [r, g, b] = hexToRgb(h);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
}

function uiVars(theme) {
  const bg = theme.background;
  const fg = theme.foreground;
  const dark = isDarkColor(bg);
  return {
    '--bg': bg,
    '--bg-panel': dark ? mixColor(bg, '#000000', 0.18) : mixColor(bg, '#000000', 0.05),
    '--bg-raised': dark ? mixColor(bg, '#ffffff', 0.07) : mixColor(bg, '#000000', 0.09),
    '--border': dark ? mixColor(bg, '#ffffff', 0.15) : mixColor(bg, '#000000', 0.16),
    '--fg': fg,
    '--fg-dim': mixColor(fg, bg, 0.45),
    '--accent': theme.blue || theme.cyan || '#4ea1ff',
    '--green': theme.green || '#4caf50',
    '--red': theme.red || '#f44336',
    '--yellow': theme.yellow || '#ffc107',
  };
}

function applyTheme(name) {
  const theme = THEMES[name];
  if (!theme) return;
  Object.entries(uiVars(theme)).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
  tabs.forEach((t) => { t.term.options.theme = theme; });
}

function initThemeSelect() {
  const sel = $('#theme-select');
  Object.keys(THEMES).forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  sel.value = localStorage.getItem('myshell.theme') || 'Catppuccin (默认)';
  applyTheme(sel.value);
  sel.addEventListener('change', () => {
    localStorage.setItem('myshell.theme', sel.value);
    applyTheme(sel.value);
  });
}

function currentTheme() { return THEMES[$('#theme-select').value]; }

// ------------------------------------------------- 侧边栏文件浏览器 (SFTP)
const fileTree = { root: null, selected: null };

function activeSshTab() {
  const tab = tabs.find((t) => t.id === activeTabId);
  return tab && tab.type === 'ssh' && tab.status !== 'disconnected' ? tab : null;
}

function joinRemotePath(dir, name) {
  return dir.replace(/\/+$/, '') + '/' + String(name).replace(/^\/+/, '');
}

function parentPath(p) {
  const parts = p.replace(/\/+$/, '').split('/');
  parts.pop();
  return parts.join('/') || '/';
}

function basename(p) {
  return p.replace(/^.*[\\/]/, '') || p;
}

function switchSidebarPane(pane) {
  const files = pane === 'files';
  $('#pane-sessions').classList.toggle('hidden', files);
  $('#pane-files').classList.toggle('hidden', !files);
  $('#stab-sessions').classList.toggle('active', !files);
  $('#stab-files').classList.toggle('active', files);
  if (files) initFileBrowser();
}

function initSidebarTabs() {
  $('#stab-sessions').addEventListener('click', () => switchSidebarPane('sessions'));
  $('#stab-files').addEventListener('click', () => switchSidebarPane('files'));
}

async function initFileBrowser() {
  const tab = activeSshTab();
  if (!tab) {
    $('#files-hint').classList.remove('hidden');
    $('#files-body').classList.add('hidden');
    return;
  }
  $('#files-hint').classList.add('hidden');
  $('#files-body').classList.remove('hidden');
  if (!fileTree.root) {
    let home;
    try {
      home = await window.api.fsHome(tab.id);
    } catch (err) {
      showToast('获取主目录失败: ' + err.message);
      return;
    }
    fileTree.root = makeDirNode(home, home);
    fileTree.root.expanded = true;
    fileTree.selected = null;
  }
  $('#f-path').value = fileTree.root.path;
  await ensureChildren(fileTree.root);
  renderTree();
}

function makeDirNode(pathVal, name) {
  return { path: pathVal, name, isDir: true, expanded: false, loaded: false, loading: false, children: null };
}

async function ensureChildren(node) {
  if (!node.isDir || node.loaded || node.loading) return;
  const tab = activeSshTab();
  if (!tab) return;
  node.loading = true;
  try {
    const entries = await window.api.fsList(tab.id, node.path);
    node.children = entries.map((en) => {
      const childPath = joinRemotePath(node.path, en.name);
      return en.isDir
        ? makeDirNode(childPath, en.name)
        : { path: childPath, name: en.name, isDir: false, size: en.size };
    });
    node.loaded = true;
  } catch (err) {
    showToast('读取目录失败: ' + err.message);
    node.children = [];
  } finally {
    node.loading = false;
  }
}

function renderTree() {
  const box = $('#file-tree');
  box.innerHTML = '';
  if (!fileTree.root) return;
  const walk = (node, depth) => {
    box.appendChild(makeTreeRow(node, depth));
    if (node.isDir && node.expanded) {
      if (!node.children || !node.children.length) {
        const empty = document.createElement('div');
        empty.className = 'tree-empty';
        empty.style.paddingLeft = 8 + (depth + 1) * 14 + 'px';
        empty.textContent = '(空目录)';
        box.appendChild(empty);
      } else {
        node.children.forEach((c) => walk(c, depth + 1));
      }
    }
  };
  walk(fileTree.root, 0);
  const sel = box.querySelector('.tree-row.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function makeTreeRow(node, depth) {
  const el = document.createElement('div');
  el.className = 'tree-row' + (node.isDir ? ' dir' : '') + (node === fileTree.selected ? ' selected' : '');
  el.style.paddingLeft = 8 + depth * 14 + 'px';
  const arrow = node.isDir ? (node.expanded ? '▾' : '▸') : '';
  el.innerHTML =
    `<span class="t-arrow">${arrow}</span>` +
    `<span class="f-icon">${node.isDir ? '📁' : '📄'}</span>` +
    `<span class="f-name">${escapeHtml(node.name)}</span>` +
    `<span class="f-size">${node.isDir ? '' : humanBytes(node.size)}</span>`;

  el.addEventListener('click', async () => {
    if (node.isDir) {
      node.expanded = !node.expanded;
      if (node.expanded) await ensureChildren(node);
      renderTree();
    } else {
      fileTree.selected = node;
      renderTree();
    }
  });

  // 右键菜单: 选中并弹出下载
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    fileTree.selected = node;
    renderTree();
    updateDownloadBtn();
    showFileMenu(e, node);
  });

  return el;
}

async function setTreeRoot(p) {
  if (!p) return;
  fileTree.root = makeDirNode(p, p);
  fileTree.root.expanded = true;
  fileTree.selected = null;
  $('#f-path').value = p;
  await ensureChildren(fileTree.root);
  renderTree();
}

async function refreshTree() {
  if (!fileTree.root) return;
  const reload = async (node) => {
    if (!node.isDir) return;
    node.loaded = false;
    await ensureChildren(node);
    if (node.expanded && node.children) {
      for (const c of node.children) await reload(c);
    }
  };
  await reload(fileTree.root);
  renderTree();
}

function bindFileBrowser() {
  $('#f-go').addEventListener('click', () => {
    const p = $('#f-path').value.trim();
    if (p) setTreeRoot(p);
  });
  $('#f-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#f-go').click();
  });
  $('#f-refresh').addEventListener('click', () => refreshTree());
  $('#f-up').addEventListener('click', () => {
    if (!fileTree.root) return;
    setTreeRoot(parentPath(fileTree.root.path));
  });
}

// 文件右键菜单
let fileMenuNode = null;
function showFileMenu(e, node) {
  fileMenuNode = node;
  const menu = $('#file-ctx-menu');
  menu.querySelector('[data-act="download"]').classList.toggle('disabled', node.isDir);
  menu.classList.remove('hidden');
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.min(e.clientX, window.innerWidth - mw - 4) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - mh - 4) + 'px';
}

function hideFileMenu() {
  $('#file-ctx-menu').classList.add('hidden');
}

function initFileMenu() {
  const menu = $('#file-ctx-menu');
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    hideFileMenu();
    if (!item || item.classList.contains('disabled') || !fileMenuNode) return;
    if (item.dataset.act === 'download') downloadNode(fileMenuNode);
  });
  window.addEventListener('mousedown', (e) => {
    if (!menu.contains(e.target)) hideFileMenu();
  });
}

// 拖拽文件处理
async function handleDrop(fileList, tab) {
  if (!fileList || !fileList.length) return;
  // File.path 在 Electron 32+ 已移除，需通过 webUtils 同步获取
  const files = Array.from(fileList).map((f) => ({
    path: window.api.getPathForFile(f),
    name: f.name,
  })).filter((f) => f.path);

  if (!files.length) {
    showToast('无法获取拖入文件的路径');
    return;
  }

  if (tab.type !== 'ssh' || tab.status === 'disconnected') {
    // 本地终端: 将路径填入命令行
    const text = files.map((f) => (/\s/.test(f.path) ? '"' + f.path + '"' : f.path)).join(' ');
    window.api.input(tab.id, text);
    showToast('已插入文件路径');
    return;
  }

  let cwd;
  try {
    cwd = await window.api.fsCwd(tab.id);
  } catch (err) {
    showToast('获取远端当前目录失败: ' + err.message);
    return;
  }

  for (const f of files) {
    const remote = joinRemotePath(cwd, f.name);
    showToast(`上传中: ${f.name}`);
    try {
      await window.api.fsUpload(tab.id, f.path, remote);
      showToast(`上传完成: ${remote}`);
      if (fileTree.root && (cwd === fileTree.root.path || cwd.startsWith(fileTree.root.path + '/'))) refreshTree();
    } catch (err) {
      showToast('上传失败: ' + err.message);
    }
  }
}

async function downloadNode(node) {
  const tab = activeSshTab();
  if (!tab || !node || node.isDir) {
    showToast('请先选择一个文件');
    return;
  }
  let local;
  try {
    local = await window.api.chooseDownloadPath(node.name);
  } catch (err) {
    showToast('选择保存路径失败: ' + err.message);
    return;
  }
  if (!local) return;
  showToast('开始下载: ' + node.name);
  try {
    await window.api.fsDownload(tab.id, node.path, local);
    showToast('下载完成: ' + local);
  } catch (err) {
    showToast('下载失败: ' + err.message);
  }
}

// ------------------------------------------------- 轻提示
let toastTimer = null;
function showToast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1600);
}

// ------------------------------------------------- 终端右键菜单
function showCtxMenu(e, tab) {
  const menu = $('#ctx-menu');
  const copyItem = menu.querySelector('[data-act="copy"]');
  copyItem.classList.toggle('disabled', !tab.term.hasSelection());
  menu.classList.remove('hidden');

  // 防止菜单超出窗口边界
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const x = Math.min(e.clientX, window.innerWidth - mw - 4);
  const y = Math.min(e.clientY, window.innerHeight - mh - 4);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.dataset.tabId = tab.id;
}

function hideCtxMenu() {
  $('#ctx-menu').classList.add('hidden');
}

function initCtxMenu() {
  const menu = $('#ctx-menu');
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.ctx-item');
    if (!item) return;
    const tab = tabs.find((t) => t.id === menu.dataset.tabId);
    hideCtxMenu();
    if (!tab) return;
    const act = item.dataset.act;
    if (act === 'copy') {
      if (tab.term.hasSelection()) window.api.copyText(tab.term.getSelection());
    } else if (act === 'paste') {
      window.api.pasteText().then((text) => {
        if (text) tab.term.paste(text);
      });
    } else if (act === 'selectAll') {
      tab.term.selectAll();
    } else if (act === 'clear') {
      tab.term.clear();
    }
  });
  // 点击其他位置关闭
  window.addEventListener('mousedown', (e) => {
    if (!menu.contains(e.target)) hideCtxMenu();
  });
  window.addEventListener('blur', hideCtxMenu);
}

// ------------------------------------------------- 标签页与终端
function createTab(session, type) {
  const id = uid();
  const name = type === 'local' ? (session.name || '本地终端') : (session.name || session.host);

  const wrap = document.createElement('div');
  wrap.className = 'term-wrap';
  termContainer.appendChild(wrap);

  const term = new Terminal({
    fontSize: 14,
    fontFamily: 'Consolas, "Courier New", monospace',
    cursorBlink: true,
    scrollback: 10000,
    theme: currentTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  term.open(wrap);
  try { fit.fit(); } catch (_) { /* 容器未就绪时忽略 */ }

  // 选中即复制（Xshell 风格）
  term.onSelectionChange(() => {
    if (term.hasSelection()) window.api.copyText(term.getSelection());
  });

  // 快捷键: Ctrl+Shift+C 复制 / Ctrl+V、Ctrl+Shift+V 粘贴
  // 挂在 wrap 捕获阶段，先于 xterm 自身的 keydown 处理，避免 ^C/^V 控制字符发给 shell
  wrap.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    if (e.ctrlKey && e.shiftKey && key === 'c') {
      if (term.hasSelection()) window.api.copyText(term.getSelection());
      e.preventDefault();
      e.stopPropagation();
    } else if (e.ctrlKey && !e.altKey && key === 'v') {
      e.preventDefault();
      e.stopPropagation();
      window.api.pasteText().then((text) => {
        if (text) term.paste(text);
      });
    }
  }, true);

  // 右键上下文菜单
  wrap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCtxMenu(e, tab);
  });

  // 快速双击: 选中单词并复制
  wrap.addEventListener('dblclick', () => {
    setTimeout(() => {
      if (!term.hasSelection()) return;
      const text = term.getSelection();
      window.api.copyText(text);
      showToast('已复制: ' + (text.length > 32 ? text.slice(0, 32) + '…' : text));
    }, 0);
  });

  // 鼠标中键: 粘贴选定内容到命令行（无选区时粘贴剪贴板）
  wrap.addEventListener('mousedown', (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    const sel = term.hasSelection() ? term.getSelection() : '';
    if (sel) {
      term.paste(sel);
      term.clearSelection();
      showToast('已粘贴选定内容');
    } else {
      window.api.pasteText().then((text) => {
        if (text) {
          term.paste(text);
          showToast('已粘贴剪贴板内容');
        }
      });
    }
  }, true);

  // 屏蔽中键默认行为（自动滚动/粘贴），避免重复插入
  wrap.addEventListener('auxclick', (e) => {
    if (e.button === 1) e.preventDefault();
  }, true);

  // 拖拽本地文件: SSH 会话上传到远端当前目录；本地终端填入文件路径
  wrap.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
  wrap.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    handleDrop(e.dataTransfer.files, tab);
  });

  const tab = { id, name, type, session, term, fit, wrap, status: 'connecting', logging: false, ready: false };
  tabs.push(tab);

  term.onData((data) => window.api.input(id, data));
  term.onResize(({ cols, rows }) => window.api.resize(id, cols, rows));

  renderTabbar();
  activateTab(id);
  startBackend(tab);
  return tab;
}

function startBackend(tab) {
  const config = { ...tab.session, cols: tab.term.cols, rows: tab.term.rows };
  if (tab.type === 'local') {
    window.api.startLocal(tab.id, config);
  } else {
    window.api.startSSH(tab.id, config);
  }
  setStatus(tab, 'connecting');
}

function activateTab(id) {
  activeTabId = id;
  tabs.forEach((t) => t.wrap.classList.toggle('active', t.id === id));
  document.querySelectorAll('.tab').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === id);
  });
  // 监控面板跟随活动标签页
  if (monPanelOpen) {
    tabs.forEach((t) => { if (t.id !== id) stopMon(t); });
    resetMonDisplay();
    applyMonNicSelection();
    startMon(tabs.find((t) => t.id === id));
  }
  // 文件浏览器跟随活动标签页
  if (!$('#pane-files').classList.contains('hidden')) {
    fileTree.root = null;
    fileTree.selected = null;
    initFileBrowser();
  }
  const tab = tabs.find((t) => t.id === id);
  if (tab) {
    requestAnimationFrame(() => {
      try {
        tab.fit.fit();
        tab.term.focus();
        window.api.resize(tab.id, tab.term.cols, tab.term.rows);
        updateSizeStatus();
      } catch (_) { /* ignore */ }
    });
  }
}

async function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const tab = tabs[idx];
  if (tab.logging) await window.api.stopLog(id);
  stopMon(tab);
  await window.api.kill(id);
  tab.term.dispose();
  tab.wrap.remove();
  tabs.splice(idx, 1);
  renderTabbar();
  if (tabs.length === 0) {
    $('#status-conn').textContent = '就绪';
  } else {
    activateTab(tabs[Math.max(0, idx - 1)].id);
  }
}

let dragTabId = null;

function reorderTabs(srcId, dstId) {
  const si = tabs.findIndex((t) => t.id === srcId);
  const di = tabs.findIndex((t) => t.id === dstId);
  if (si === -1 || di === -1 || si === di) return;
  const [moved] = tabs.splice(si, 1);
  tabs.splice(di, 0, moved);
  renderTabbar();
}

function renderTabbar() {
  tabbar.innerHTML = '';
  tabs.forEach((t) => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.id === activeTabId ? ' active' : '') +
      (t.status === 'disconnected' ? ' disconnected' : '') +
      (t.status === 'connecting' ? ' connecting' : '');
    el.dataset.id = t.id;
    el.innerHTML = `<span class="t-dot"></span><span class="t-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span><span class="t-close" title="关闭">×</span>`;
    el.addEventListener('click', () => activateTab(t.id));
    el.querySelector('.t-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });
    // 拖拽移动标签页次序
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      dragTabId = t.id;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', t.name); } catch (_) {}
    });
    el.addEventListener('dragover', (e) => {
      if (dragTabId && dragTabId !== t.id) e.preventDefault();
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragTabId && dragTabId !== t.id) reorderTabs(dragTabId, t.id);
    });
    el.addEventListener('dragend', () => { dragTabId = null; });
    tabbar.appendChild(el);
  });
  if ($('#batch-count') && $('#batch-send')) updateBatchCount();
}

function setStatus(tab, status) {
  tab.status = status;
  renderTabbar();
  if (tab.id === activeTabId) {
    const text = { connecting: '连接中...', connected: '已连接', disconnected: '已断开' }[status];
    $('#status-conn').textContent = `${tab.name} — ${text || status}`;
  }
}

function updateSizeStatus() {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (tab) $('#status-size').textContent = `${tab.term.cols} × ${tab.term.rows}`;
}

// ------------------------------------------------- 会话管理
async function loadSessions() {
  sessions = await window.api.loadSessions();
  renderSessionList();
}

async function persistSessions() {
  await window.api.saveSessions(sessions);
  renderSessionList();
}

// ------------------------------------------------- 会话目录
let dirList = JSON.parse(localStorage.getItem('myshell.dirList') || '[]');
let dirExpanded = JSON.parse(localStorage.getItem('myshell.dirExpanded') || '{}');

function saveDirMeta() {
  localStorage.setItem('myshell.dirList', JSON.stringify(dirList));
  localStorage.setItem('myshell.dirExpanded', JSON.stringify(dirExpanded));
}

function getDirs() {
  const set = new Set([...dirList, ...sessions.map((s) => s.dir).filter(Boolean)]);
  return [...set];
}

function makeSessionLi(s, depth = 0) {
  const li = document.createElement('li');
  li.draggable = true;
  if (depth > 0) {
    li.classList.add('in-dir');
    li.style.paddingLeft = 12 + depth * 16 + 'px';
  }
  li.innerHTML = `
      <span class="s-name">${escapeHtml(s.name)}</span>
      <span class="s-actions">
        <button class="a-edit" title="编辑">改</button>
        <button class="a-del" title="删除">删</button>
      </span>`;
  li.addEventListener('dblclick', () => connectSession(s));
  li.querySelector('.a-edit').addEventListener('click', (e) => {
    e.stopPropagation();
    openSessionModal(s);
  });
  li.querySelector('.a-del').addEventListener('click', async (e) => {
    e.stopPropagation();
    sessions = sessions.filter((x) => x.id !== s.id);
    await persistSessions();
  });
  // 拖拽会话到目录
  li.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/myshell-session', s.id); } catch (_) {}
  });
  return li;
}

function bindDropZone(el, dirValue) {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('drop-hover');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-hover'));
  el.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-hover');
    let id = null;
    try { id = e.dataTransfer.getData('text/myshell-session'); } catch (_) {}
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    if (dirValue) s.dir = dirValue;
    else delete s.dir;
    await persistSessions();
  });
}

// 目录新建/重命名弹窗
let dirEditTarget = null;

function openDirModal(name) {
  dirEditTarget = name || null;
  $('#dir-modal-title').textContent = name ? '重命名目录' : '新建目录';
  const form = $('#dir-form');
  form.reset();
  if (name) form.dirname.value = name;
  $('#dir-modal-overlay').classList.remove('hidden');
  form.dirname.focus();
}

function closeDirModal() {
  $('#dir-modal-overlay').classList.add('hidden');
  dirEditTarget = null;
}

async function saveDirModal(e) {
  e.preventDefault();
  const name = $('#dir-form').dirname.value.trim();
  if (!name) return;
  let isNew = false;
  if (dirEditTarget) {
    if (name !== dirEditTarget) {
      sessions.forEach((s) => { if (s.dir === dirEditTarget) s.dir = name; });
      dirList = dirList.map((x) => (x === dirEditTarget ? name : x));
      if (dirEditTarget in dirExpanded) {
        dirExpanded[name] = dirExpanded[dirEditTarget];
        delete dirExpanded[dirEditTarget];
      }
      saveDirMeta();
      await persistSessions();
    }
  } else {
    if (!dirList.includes(name)) {
      dirList.push(name);
      dirExpanded[name] = true;
      saveDirMeta();
      isNew = true;
    }
  }
  closeDirModal();
  if (isNew) {
    renderSessionList();
    // 新目录可能排在展开的长列表之后，滚动到可视区域
    const sel = '.dir-header[data-dir="' + (window.CSS && CSS.escape ? CSS.escape(name) : name) + '"]';
    const header = document.querySelector(sel);
    if (header) header.scrollIntoView({ block: 'nearest' });
  }
}

function renderSessionList() {
  const list = $('#session-list');
  list.innerHTML = '';
  if (!sessions.length) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = '暂无会话。点击右上角 ＋ 新建会话，或导入 JSON 文件。';
    list.appendChild(hint);
    return;
  }
  const dirs = getDirs();
  const rootSessions = sessions.filter((s) => !s.dir || !dirs.includes(s.dir));

  const appendSessions = (arr, depth) => arr.forEach((s) => list.appendChild(makeSessionLi(s, depth)));

  if (dirs.length) {
    // 未分组拖放区
    const rootZone = document.createElement('div');
    rootZone.className = 'root-zone';
    rootZone.textContent = '未分组（拖会话到此处移出目录）';
    bindDropZone(rootZone, null);
    list.appendChild(rootZone);
    appendSessions(rootSessions, 0);

    dirs.forEach((d) => {
      const inDir = sessions.filter((s) => s.dir === d);
      const expanded = dirExpanded[d] !== false;
      const header = document.createElement('div');
      header.className = 'dir-header';
      header.dataset.dir = d;
      header.innerHTML =
        `<span class="d-arrow">${expanded ? '▾' : '▸'}</span>` +
        `<span class="d-icon">📁</span>` +
        `<span class="d-name">${escapeHtml(d)}</span>` +
        `<span class="d-count">${inDir.length}</span>` +
        `<span class="d-del" title="删除目录（会话移回未分组）">×</span>`;
      bindDropZone(header, d);
      const toggle = () => {
        dirExpanded[d] = !expanded;
        saveDirMeta();
        renderSessionList();
      };
      header.addEventListener('click', toggle);
      header.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        openDirModal(d);
      });
      header.querySelector('.d-arrow').addEventListener('click', (e) => {
        e.stopPropagation();
        toggle();
      });
      header.querySelector('.d-del').addEventListener('click', async (e) => {
        e.stopPropagation();
        sessions.forEach((s) => { if (s.dir === d) delete s.dir; });
        dirList = dirList.filter((x) => x !== d);
        delete dirExpanded[d];
        saveDirMeta();
        await persistSessions();
        showToast('目录已删除，会话移回未分组');
      });
      list.appendChild(header);
      if (expanded) appendSessions(inDir, 1);
    });
  } else {
    appendSessions(sessions, 0);
  }
  // 同步会话表单的目录下拉
  $('#dir-list').innerHTML = dirs.map((d) => `<option value="${escapeHtml(d)}"></option>`).join('');
}

function connectSession(s) {
  createTab(s, s.host ? 'ssh' : 'local');
}

// ------------------------------------------------- 会话编辑弹窗
function openSessionModal(session, connectNow = false) {
  editTarget = session || null;
  connectAfterSave = connectNow;
  const form = $('#session-form');
  $('#modal-title').textContent = session ? '编辑会话' : '新建会话';
  form.reset();
  if (session) {
    form.name.value = session.name || '';
    form.dir.value = session.dir || '';
    form.host.value = session.host || '';
    form.port.value = session.port || 22;
    form.username.value = session.username || '';
    form.authType.value = session.authType || 'password';
    form.password.value = session.password || '';
    form.privateKeyPath.value = session.privateKeyPath || '';
    form.startupCommand.value = session.startupCommand || '';
    form.autoLog.checked = !!session.autoLog;
  }
  toggleAuthFields();
  $('#modal-overlay').classList.remove('hidden');
  form.name.focus();
}

function toggleAuthFields() {
  const isKey = $('#session-form').authType.value === 'privateKey';
  document.querySelector('.field-password').classList.toggle('hidden', isKey);
  document.querySelector('.field-privateKey').classList.toggle('hidden', !isKey);
}

function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  editTarget = null;
  connectAfterSave = false;
}

function collectForm() {
  const f = $('#session-form');
  return {
    id: editTarget ? editTarget.id : 's-' + Date.now(),
    name: f.name.value.trim() || '未命名',
    dir: f.dir.value.trim(),
    host: f.host.value.trim(),
    port: parseInt(f.port.value, 10) || 22,
    username: f.username.value.trim(),
    authType: f.authType.value,
    password: f.password.value,
    privateKeyPath: f.privateKeyPath.value.trim(),
    startupCommand: f.startupCommand.value.trim(),
    autoLog: f.autoLog.checked,
    monNic: editTarget ? editTarget.monNic || '' : '',
  };
}

// ------------------------------------------------- 资源监控
let monPanelOpen = false;
const monRunning = new Set(); // 正在监控的 tab id

function humanBytes(n) {
  if (n == null || isNaN(n)) return '--';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

function setBar(fill, val) {
  const pct = Math.max(0, Math.min(100, val));
  fill.style.width = pct + '%';
  fill.style.background = pct > 85 ? 'var(--red)' : pct > 60 ? 'var(--yellow)' : 'var(--green)';
}

let monLast = null; // 最近一次监控数据，切换网卡时复用

function currentMonNic() {
  const tab = tabs.find((t) => t.id === activeTabId);
  return (tab && tab.session && tab.session.monNic) || 'all';
}

function applyMonNicSelection() {
  const sel = $('#mon-nic');
  const want = currentMonNic();
  sel.value = Array.from(sel.options).some((o) => o.value === want) ? want : 'all';
}

function updateNicOptions(nets) {
  const sel = $('#mon-nic');
  const names = (nets || []).map((n) => n.name).filter(Boolean);
  const existing = Array.from(sel.options).slice(1).map((o) => o.value);
  const same = names.length === existing.length && names.every((n, i) => n === existing[i]);
  if (same) return;
  sel.innerHTML = '<option value="all">汇总（所有网卡）</option>' +
    names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  applyMonNicSelection();
}

function renderMonNet(p) {
  updateNicOptions(p.nets);
  const vals = pickNet(p);
  $('#mon-net-rx').textContent = vals.rx == null ? '--' : humanBytes(vals.rx) + '/s';
  $('#mon-net-tx').textContent = vals.tx == null ? '--' : humanBytes(vals.tx) + '/s';
}

function initMonNic() {
  $('#mon-nic').addEventListener('change', async () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    const v = $('#mon-nic').value;
    if (tab) {
      tab.session = tab.session || {};
      tab.session.monNic = v === 'all' ? '' : v;
      // 已保存的会话同步写回 sessions.json，下次打开默认监控该网卡
      if (sessions.some((s) => s.id === tab.session.id)) await persistSessions();
    }
    if (monLast) renderMonNet(monLast);
    showToast(v === 'all' ? '已切换为汇总所有网卡' : '已切换网卡: ' + v);
  });
}

function renderMon(p) {
  if (!p) return;
  monLast = p;
  if (p.cpu != null) {
    $('#mon-cpu-val').textContent = p.cpu.toFixed(1) + '%';
    setBar($('#mon-cpu-bar'), p.cpu);
  } else {
    $('#mon-cpu-val').textContent = '--';
  }
  if (p.memTotal > 0) {
    setBar($('#mon-mem-bar'), (p.memUsed / p.memTotal) * 100);
    $('#mon-mem-val').textContent = `${humanBytes(p.memUsed)} / ${humanBytes(p.memTotal)}`;
  } else {
    $('#mon-mem-val').textContent = '--';
  }
  renderMonNet(p);
  const ul = $('#mon-disks');
  ul.innerHTML = '';
  (p.disks || []).forEach((d) => {
    if (d.size <= 0) return;
    const pct = (d.used / d.size) * 100;
    const li = document.createElement('li');
    li.innerHTML =
      `<div class="mon-label"><span>${escapeHtml(d.mount)}</span>` +
      `<span>${humanBytes(d.free)} / ${humanBytes(d.size)}</span></div>` +
      `<div class="mon-bar"><div class="mon-bar-fill"></div></div>`;
    setBar(li.querySelector('.mon-bar-fill'), pct);
    ul.appendChild(li);
  });
  renderTopList($('#mon-top-proc'), p.topProcs);
}

// TOP5 进程列表: 命令 / PID / 内存使用量
function renderTopList(el, items) {
  if (!el) return;
  el.innerHTML = '';
  (items || []).forEach((it, i) => {
    const li = document.createElement('li');
    li.innerHTML =
      `<span class="t-rank">${i + 1}</span>` +
      `<span class="t-proc" title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span>` +
      `<span class="t-pid">PID ${it.pid}</span>` +
      `<span class="t-mem">${humanBytes(it.mem)}</span>`;
    el.appendChild(li);
  });
  if (!el.children.length) el.innerHTML = '<li class="t-empty">--</li>';
}

// 每秒流量柱状图（最近 2 分钟）
const NET_HIST_MAX = 120;
const netHist = { rx: [], tx: [] };

function pickNet(p) {
  const sel = $('#mon-nic');
  const cur = (sel && sel.value) || 'all';
  if (cur !== 'all') {
    const item = (p.nets || []).find((n) => n.name === cur);
    return { rx: item ? item.rx : null, tx: item ? item.tx : null };
  }
  return { rx: p.netRx, tx: p.netTx };
}

function drawNetChart() {
  const cv = $('#mon-net-chart');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (w === 0) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const maxVal = Math.max(1024, ...netHist.rx, ...netHist.tx);
  const slotW = w / NET_HIST_MAX;
  const barW = Math.max(1, slotW * 0.4);
  const drawSeries = (arr, color, offset) => {
    ctx.fillStyle = color;
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      if (!v || v <= 0) continue;
      const bh = Math.min(h - 2, (v / maxVal) * (h - 10));
      const x = i * slotW + offset;
      ctx.fillRect(x, h - bh - 1, barW, bh);
    }
  };
  drawSeries(netHist.rx, '#4ea1ff', 0);
  drawSeries(netHist.tx, '#f5a623', barW + 1);
  ctx.fillStyle = 'rgba(128,128,128,0.35)';
  ctx.fillRect(0, h - 1, w, 1);
  ctx.font = '9px sans-serif';
  ctx.fillStyle = 'rgba(128,128,128,0.8)';
  ctx.fillText(humanBytes(maxVal) + '/s', 4, 10);
}

function pushNetHistory(p) {
  const { rx, tx } = pickNet(p);
  netHist.rx.push(rx == null ? 0 : rx);
  netHist.tx.push(tx == null ? 0 : tx);
  while (netHist.rx.length > NET_HIST_MAX) netHist.rx.shift();
  while (netHist.tx.length > NET_HIST_MAX) netHist.tx.shift();
  drawNetChart();
}

function resetMonDisplay() {
  monLast = null;
  netHist.rx = [];
  netHist.tx = [];
  drawNetChart();
  $('#mon-cpu-val').textContent = '--';
  $('#mon-mem-val').textContent = '--';
  $('#mon-net-rx').textContent = '--';
  $('#mon-net-tx').textContent = '--';
  setBar($('#mon-cpu-bar'), 0);
  setBar($('#mon-mem-bar'), 0);
  $('#mon-disks').innerHTML = '<li class="mon-disk">--</li>';
  const tp = $('#mon-top-proc');
  if (tp) tp.innerHTML = '<li class="t-empty">--</li>';
}

function startMon(tab) {
  // 后端未就绪(仍在 connecting)时不发送，等 onReady 后再启动
  if (!tab || monRunning.has(tab.id) || tab.status === 'disconnected' || !tab.ready) return;
  window.api.monStart(tab.id);
  monRunning.add(tab.id);
}

function stopMon(tab) {
  if (!tab) return;
  if (monRunning.has(tab.id)) {
    monRunning.delete(tab.id);
    window.api.monStop(tab.id);
  }
}

function toggleMonPanel() {
  monPanelOpen = !monPanelOpen;
  $('#monitor-panel').classList.toggle('hidden', !monPanelOpen);
  $('#mon-resizer').classList.toggle('hidden', !monPanelOpen);
  const tab = tabs.find((t) => t.id === activeTabId);
  if (monPanelOpen) {
    startMon(tab);
  } else {
    tabs.forEach((t) => stopMon(t));
  }
  // 面板开合影响终端宽度，重新适配
  requestAnimationFrame(() => {
    const t = tabs.find((x) => x.id === activeTabId);
    if (t) {
      try {
        t.fit.fit();
        window.api.resize(t.id, t.term.cols, t.term.rows);
        updateSizeStatus();
      } catch (_) {}
    }
  });
}

// ------------------------------------------------- 日志
async function toggleLogForActiveTab() {
  const tab = tabs.find((t) => t.id === activeTabId);
  if (!tab || tab.status === 'disconnected') return;
  if (tab.logging) {
    await window.api.stopLog(tab.id);
    tab.logging = false;
    $('#status-log').classList.add('hidden');
    tab.term.writeln('\r\n\x1b[33m[日志记录已停止]\x1b[0m');
    return;
  }
  const res = await window.api.startLog(tab.id, tab.name);
  if (res && res.ok) {
    tab.logging = true;
    $('#status-log').classList.remove('hidden');
    tab.term.writeln('\r\n\x1b[32m[日志记录中: ' + res.filePath + ']\x1b[0m');
  } else if (res && res.error) {
    tab.term.writeln('\r\n\x1b[31m[日志启动失败: ' + res.error + ']\x1b[0m');
  }
}

async function autoStartLog(tab) {
  if (!tab.session.autoLog) return;
  const res = await window.api.startLog(tab.id, tab.name);
  if (res && res.ok) {
    tab.logging = true;
    $('#status-log').classList.remove('hidden');
    tab.term.writeln('\r\n\x1b[32m[日志记录中: ' + res.filePath + ']\x1b[0m');
  }
}

// ------------------------------------------------- 快捷命令
function renderQuickCommands() {
  const box = $('#quick-commands');
  box.innerHTML = '';
  quickCommands.forEach((cmd, i) => {
    const chip = document.createElement('span');
    chip.className = 'qcmd';
    chip.innerHTML = `<span class="q-text">${escapeHtml(cmd)}</span><span class="q-del" title="删除">×</span>`;
    chip.querySelector('.q-text').addEventListener('click', () => {
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab && tab.status !== 'disconnected') window.api.input(tab.id, cmd + '\r');
    });
    chip.querySelector('.q-del').addEventListener('click', (e) => {
      e.stopPropagation();
      quickCommands.splice(i, 1);
      localStorage.setItem('myshell.quick', JSON.stringify(quickCommands));
      renderQuickCommands();
    });
    box.appendChild(chip);
  });
}

function addQuickCommand() {
  const input = $('#quick-input');
  const val = input.value.trim();
  if (!val) return;
  quickCommands.push(val);
  localStorage.setItem('myshell.quick', JSON.stringify(quickCommands));
  input.value = '';
  renderQuickCommands();
}

// ------------------------------------------------- 主进程事件
window.api.onData((id, data) => {
  const tab = tabs.find((t) => t.id === id);
  if (tab) {
    tab.term.write(data);
    if (tab.status === 'connecting') {
      setStatus(tab, 'connected');
      updateSizeStatus();
    }
  }
});

window.api.onExit((id, code) => {
  const tab = tabs.find((t) => t.id === id);
  if (tab) {
    stopMon(tab);
    setStatus(tab, 'disconnected');
    tab.term.writeln(`\r\n\x1b[31m[会话已断开 (exit ${code})]\x1b[0m`);
  }
});

window.api.onMonData((id, payload) => {
  if (monPanelOpen && id === activeTabId) renderMon(payload);
});

// 每秒流量数据: 更新数字并追加到 2 分钟柱状图
window.api.onMonNetData((id, payload) => {
  if (!monPanelOpen || id !== activeTabId) return;
  renderMonNet(payload);
  pushNetHistory(payload);
});

// 文件传输进度
window.api.onFsProgress((id, info) => {
  if (id === activeTabId) showToast(`${info.file}: ${info.pct}%`);
});

window.api.onMonError((id, msg) => {
  if (monPanelOpen && id === activeTabId) {
    $('#mon-cpu-val').textContent = '--';
    $('#mon-mem-val').textContent = '--';
  }
});

window.api.onError((id, msg) => {
  const tab = tabs.find((t) => t.id === id);
  if (tab) tab.term.writeln(`\r\n\x1b[31m[错误] ${msg}\x1b[0m`);
});

window.api.onReady((id) => {
  const tab = tabs.find((t) => t.id === id);
  if (!tab) return;
  tab.ready = true;
  if (tab.session.autoLog) autoStartLog(tab);
  // 新会话就绪后，若监控面板打开且该会话是当前标签，切换监控目标
  if (monPanelOpen && id === activeTabId) {
    tabs.forEach((t) => { if (t.id !== id) stopMon(t); });
    resetMonDisplay();
    applyMonNicSelection();
    startMon(tab);
  }
});

// ------------------------------------------------- 侧边栏拖拽调宽
function initSidebarResizer() {
  const resizer = $('#sidebar-resizer');
  const sidebar = $('#sidebar');
  const saved = parseInt(localStorage.getItem('myshell.sidebarWidth'), 10);
  if (saved >= 160 && saved <= 600) sidebar.style.width = saved + 'px';

  let dragging = false;
  let rafPending = false;

  const refitActive = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab) {
        try {
          tab.fit.fit();
          window.api.resize(tab.id, tab.term.cols, tab.term.rows);
          updateSizeStatus();
        } catch (_) {}
      }
    });
  };

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const left = $('#main').getBoundingClientRect().left;
    const width = Math.min(600, Math.max(160, e.clientX - left));
    sidebar.style.width = width + 'px';
    refitActive();
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('myshell.sidebarWidth', String(sidebar.offsetWidth));
    refitActive();
  });
}

// ------------------------------------------------- 批量发送命令
function batchTargets() {
  return tabs.filter((t) => t.status === 'connected');
}

function updateBatchCount() {
  const n = batchTargets().length;
  $('#batch-count').textContent = n ? `${n} 个终端` : '无已连接终端';
  $('#batch-send').disabled = n === 0;
}

function sendBatchCommand() {
  const input = $('#batch-input');
  const cmd = input.value.trim();
  if (!cmd) return;
  const targets = batchTargets();
  if (!targets.length) {
    showToast('没有已连接的终端');
    return;
  }
  targets.forEach((t) => window.api.input(t.id, cmd + '\r'));
  showToast(`已发送到 ${targets.length} 个终端: ${cmd}`);
  input.value = '';
  input.focus();
}

function initBatchBar() {
  updateBatchCount();
  $('#batch-send').addEventListener('click', sendBatchCommand);
  $('#batch-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendBatchCommand();
    }
  });
}

function initMonitorResizer() {
  const resizer = $('#mon-resizer');
  const panel = $('#monitor-panel');
  const saved = parseInt(localStorage.getItem('myshell.monitorWidth'), 10);
  if (saved >= 200 && saved <= 700) panel.style.width = saved + 'px';

  let dragging = false;
  let rafPending = false;

  const refit = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const tab = tabs.find((t) => t.id === activeTabId);
      if (tab) {
        try {
          tab.fit.fit();
          window.api.resize(tab.id, tab.term.cols, tab.term.rows);
          updateSizeStatus();
        } catch (_) {}
      }
    });
  };

  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    resizer.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const right = panel.getBoundingClientRect().right;
    const width = Math.min(700, Math.max(200, right - e.clientX));
    panel.style.width = width + 'px';
    refit();
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('myshell.monitorWidth', String(panel.offsetWidth));
    refit();
  });
}

// ------------------------------------------------- 事件绑定
function bindEvents() {
  $('#btn-new-local').addEventListener('click', () => {
    createTab({ name: '本地终端' }, 'local');
  });

  $('#btn-new-ssh').addEventListener('click', () => openSessionModal(null, true));

  $('#btn-toggle-monitor').addEventListener('click', toggleMonPanel);
  $('#mon-close').addEventListener('click', toggleMonPanel);

  $('#btn-toggle-sidebar').addEventListener('click', () => {
    $('#sidebar').classList.toggle('hidden');
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab) requestAnimationFrame(() => { try { tab.fit.fit(); } catch (_) {} });
  });

  $('#btn-toggle-quickbar').addEventListener('click', () => {
    $('#quickbar').classList.toggle('hidden');
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab) requestAnimationFrame(() => { try { tab.fit.fit(); } catch (_) {} });
  });

  $('#btn-session-add').addEventListener('click', () => openSessionModal(null));

  // 目录弹窗
  $('#btn-dir-add').addEventListener('click', () => openDirModal(null));
  $('#dir-form').addEventListener('submit', saveDirModal);
  $('#btn-dir-cancel').addEventListener('click', closeDirModal);
  $('#dir-modal-overlay').addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget) closeDirModal();
  });

  $('#btn-session-import').addEventListener('click', async () => {
    const data = await window.api.importSessions();
    if (!data) return;
    if (data.__error) return alert('导入失败: ' + data.__error);
    if (!Array.isArray(data)) return alert('导入失败: 文件格式不正确');
    const existing = new Set(sessions.map((s) => s.name));
    const merged = data.filter((s) => s && s.name && !existing.has(s.name));
    sessions = sessions.concat(merged);
    await persistSessions();
    alert(`成功导入 ${merged.length} 个会话`);
  });

  $('#btn-session-export').addEventListener('click', async () => {
    if (!sessions.length) return alert('暂无会话可导出');
    await window.api.exportSessions(sessions);
  });

  // 弹窗
  $('#session-form').authType.addEventListener('change', toggleAuthFields);
  $('#btn-modal-cancel').addEventListener('click', closeModal);
  $('#modal-overlay').addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  $('#btn-browse-key').addEventListener('click', async () => {
    const file = await window.api.chooseKeyFile();
    if (file) $('#session-form').privateKeyPath.value = file;
  });

  // 「保存并连接」：标记连接意图后触发表单提交
  $('#btn-connect-now').addEventListener('click', () => {
    connectAfterSave = true;
    $('#session-form').requestSubmit();
  });

  $('#session-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = collectForm();
    if (editTarget) {
      const idx = sessions.findIndex((s) => s.id === editTarget.id);
      sessions[idx] = data;
    } else {
      sessions.push(data);
    }
    await persistSessions();
    const connect = connectAfterSave;
    closeModal();
    if (connect) connectSession(data);
  });

  // 快捷命令
  $('#quick-add').addEventListener('click', addQuickCommand);
  $('#quick-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addQuickCommand();
  });

  // 窗口尺寸变化
  window.addEventListener('resize', () => {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab) {
      try {
        tab.fit.fit();
        window.api.resize(tab.id, tab.term.cols, tab.term.rows);
        updateSizeStatus();
      } catch (_) {}
    }
  });

  // 快捷键: Ctrl+T 新建本地终端 / Ctrl+W 关闭标签 / Ctrl+L 切换日志
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      createTab({ name: '本地终端' }, 'local');
    } else if (e.ctrlKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      if (activeTabId) closeTab(activeTabId);
    } else if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      toggleLogForActiveTab();
    }
  });
}

// ------------------------------------------------- 初始化
async function init() {
  initThemeSelect();
  initSidebarResizer();
  initMonitorResizer();
  initBatchBar();
  initMonNic();
  initCtxMenu();
  initSidebarTabs();
  bindFileBrowser();
  initFileMenu();
  renderQuickCommands();
  await loadSessions();
  bindEvents();
  createTab({ name: '本地终端' }, 'local');
}

init();







