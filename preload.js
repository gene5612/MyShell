const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 终端后端
  startLocal: (id, config) => ipcRenderer.invoke('backend:start-local', id, config),
  startSSH: (id, config) => ipcRenderer.invoke('backend:start-ssh', id, config),
  input: (id, data) => ipcRenderer.send('backend:input', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('backend:resize', id, cols, rows),
  kill: (id) => ipcRenderer.invoke('backend:kill', id),

  // 事件
  onData: (cb) => ipcRenderer.on('backend:data', (e, id, data) => cb(id, data)),
  onExit: (cb) => ipcRenderer.on('backend:exit', (e, id, code) => cb(id, code)),
  onError: (cb) => ipcRenderer.on('backend:error', (e, id, msg) => cb(id, msg)),
  onReady: (cb) => ipcRenderer.on('backend:ready', (e, id) => cb(id)),

  // 日志
  startLog: (id, sessionName) => ipcRenderer.invoke('log:start', id, sessionName),
  stopLog: (id) => ipcRenderer.invoke('log:stop', id),
  chooseKeyFile: () => ipcRenderer.invoke('file:choose-key'),

  // 资源监控
  monStart: (id) => ipcRenderer.invoke('mon:start', id),
  monStop: (id) => ipcRenderer.invoke('mon:stop', id),
  onMonData: (cb) => ipcRenderer.on('mon:data', (e, id, payload) => cb(id, payload)),
  onMonNetData: (cb) => ipcRenderer.on('mon:netdata', (e, id, payload) => cb(id, payload)),
  onMonError: (cb) => ipcRenderer.on('mon:error', (e, id, msg) => cb(id, msg)),

  // 会话
  loadSessions: () => ipcRenderer.invoke('sessions:load'),
  saveSessions: (sessions) => ipcRenderer.invoke('sessions:save', sessions),
  importSessions: () => ipcRenderer.invoke('sessions:import'),
  exportSessions: (sessions) => ipcRenderer.invoke('sessions:export', sessions),

  // 剪贴板（通过主进程，渲染进程沙箱无法直接访问 clipboard）
  copyText: (text) => ipcRenderer.send('clipboard:write', text),
  pasteText: () => ipcRenderer.invoke('clipboard:read'),

  // SFTP 文件操作
  fsList: (id, remotePath) => ipcRenderer.invoke('fs:list', id, remotePath),
  fsHome: (id) => ipcRenderer.invoke('fs:home', id),
  fsCwd: (id) => ipcRenderer.invoke('fs:cwd', id),
  fsDownload: (id, remotePath, localPath) => ipcRenderer.invoke('fs:download', id, remotePath, localPath),
  fsUpload: (id, localPath, remotePath) => ipcRenderer.invoke('fs:upload', id, localPath, remotePath),
  chooseDownloadPath: (name) => ipcRenderer.invoke('download:choose', name),
  chooseDownloadDir: (name) => ipcRenderer.invoke('dir:choose', name),
  fsDownloadDir: (id, remoteDir, localDir) => ipcRenderer.invoke('fs:downloadDir', id, remoteDir, localDir),
  onFsProgress: (cb) => ipcRenderer.on('fs:progress', (e, id, info) => cb(id, info)),
  getPathForFile: (file) => webUtils.getPathForFile(file),
});
