const { app, BrowserWindow, ipcMain, dialog, clipboard, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { Client } = require('ssh2');

let pty = null;
try {
  pty = require('node-pty');
} catch (e) {
  console.error('[myshell] node-pty 加载失败，本地终端不可用:', e.message);
}

let win = null;

// ------------------------------------------------------- 后端进程管理
// backends: id -> { type: 'pty'|'ssh', proc|conn|stream, logStream }
const backends = new Map();

function emit(channel, ...args) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

function emitData(id, data) {
  emit('backend:data', id, data);
  const b = backends.get(id);
  if (b && b.logStream) {
    b.logStream.write(data.toString());
  }
}

function closeLog(id) {
  const b = backends.get(id);
  if (b && b.logStream) {
    b.logStream.end();
    b.logStream = null;
  }
}

function cleanupBackend(id) {
  const b = backends.get(id);
  if (!b) return;
  closeLog(id);
  try {
    if (b.type === 'pty') {
      b.proc && b.proc.kill();
    } else {
      b.stream && b.stream.end();
      b.conn && b.conn.end();
    }
  } catch (_) { /* ignore */ }
  backends.delete(id);
}

function defaultShell() {
  if (process.platform === 'win32') {
    return (process.env.ComSpec && /powershell/i.test(process.env.ComSpec))
      ? process.env.ComSpec
      : 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

// ------------------------------------------------------- IPC: 本地终端
ipcMain.handle('backend:start-local', (e, id, config = {}) => {
  if (!pty) {
    emit('backend:error', id, 'node-pty 不可用：请先执行 npm run rebuild 重新编译本地模块');
    return { ok: false, error: 'node-pty unavailable' };
  }
  try {
    const shell = config.shell || defaultShell();
    const proc = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: config.cols || 80,
      rows: config.rows || 24,
      cwd: config.cwd || app.getPath('home'),
      env: process.env,
    });
    backends.set(id, { type: 'pty', proc, logStream: null });
    proc.onData((d) => emitData(id, d));
    proc.onExit(({ exitCode }) => emitExit(id, exitCode));
    return { ok: true };
  } catch (err) {
    emit('backend:error', id, String(err.message || err));
    return { ok: false, error: String(err.message || err) };
  }
});

// ------------------------------------------------------- IPC: SSH
ipcMain.handle('backend:start-ssh', (e, id, config = {}) => {
  const conn = new Client();
  const store = { type: 'ssh', conn, stream: null, logStream: null };
  backends.set(id, store);

  conn.on('ready', () => {
    conn.shell(
      { term: 'xterm-256color', cols: config.cols || 80, rows: config.rows || 24 },
      (err, stream) => {
        if (err) {
          emit('backend:error', id, err.message);
          emitExit(id, 1);
          return;
        }
        store.stream = stream;
        stream.on('data', (d) => {
          trackCwd(id, d);
          emitData(id, d);
        });
        stream.stderr.on('data', (d) => emitData(id, d));
        stream.on('close', () => {
          conn.end();
          emitExit(id, 0);
        });
        if (config.startupCommand) {
          stream.write(config.startupCommand + '\r');
        }
        emit('backend:ready', id);
      }
    );
  });

  conn.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
    finish(prompts.map(() => config.password || ''));
  });

  conn.on('error', (err) => {
    emit('backend:error', id, err.message);
    if (!store.stream) emitExit(id, 1);
  });
  conn.on('end', () => {
    if (store.stream) emitExit(id, 0);
  });

  const sshConfig = {
    host: config.host,
    port: config.port || 22,
    username: config.username || 'root',
    readyTimeout: 15000,
    keepaliveInterval: config.keepAlive || 10000,
    tryKeyboard: true,
  };
  if (config.authType === 'privateKey') {
    try {
      sshConfig.privateKey = fs.readFileSync(config.privateKeyPath);
    } catch (err) {
      emit('backend:error', id, '读取私钥失败: ' + err.message);
      emitExit(id, 1);
      return { ok: false, error: err.message };
    }
    if (config.passphrase) sshConfig.passphrase = config.passphrase;
  } else {
    sshConfig.password = config.password || '';
  }

  try {
    conn.connect(sshConfig);
  } catch (err) {
    emit('backend:error', id, err.message);
    emitExit(id, 1);
    return { ok: false, error: err.message };
  }
  return { ok: true };
});

// ------------------------------------------------------- IPC: 输入/尺寸/关闭
ipcMain.on('backend:input', (e, id, data) => {
  const b = backends.get(id);
  if (!b) return;
  if (b.type === 'pty') b.proc.write(data);
  else if (b.stream) b.stream.write(data);
});

ipcMain.on('backend:resize', (e, id, cols, rows) => {
  const b = backends.get(id);
  if (!b) return;
  try {
    if (b.type === 'pty') b.proc.resize(cols, rows);
    else if (b.stream) b.stream.setWindow(rows, cols, null, null);
  } catch (_) { /* ignore */ }
});

ipcMain.handle('backend:kill', (e, id) => {
  cleanupBackend(id);
  return { ok: true };
});

// ------------------------------------------------------- IPC: 资源监控
// monitors: id -> { timer, prevCpu, prevNet, child }
const monitors = new Map();
const MON_INTERVAL = 3000;

function stopMonitor(id) {
  const st = monitors.get(id);
  if (st) {
    clearInterval(st.timer);
    clearInterval(st.netTimer);
    if (st.child) { try { st.child.kill(); } catch (_) {} }
    if (st.netChild) { try { st.netChild.kill(); } catch (_) {} }
    monitors.delete(id);
  }
}

function emitExit(id, code) {
  closeLog(id);
  stopMonitor(id);
  resetSftp(id);
  backends.delete(id);
  emit('backend:exit', id, code);
}

function parseLinuxMon(text, st) {
  const payload = { cpu: null, memTotal: 0, memUsed: 0, netRx: null, netTx: null, nets: [], disks: [], topProcs: [] };
  const sec = {};
  let cur = null;
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^__(CPU|MEM|NET|DISK|PROC|PROC2)__$/);
    if (m) { cur = m[1]; sec[cur] = []; continue; }
    if (cur) sec[cur].push(line);
  }
  // CPU: /proc/stat jiffies 差值
  if (sec.CPU) {
    const cpuLine = sec.CPU.find((l) => l.startsWith('cpu '));
    if (cpuLine) {
      const p = cpuLine.trim().split(/\s+/).slice(1).map(Number);
      const total = p.reduce((a, b) => a + b, 0);
      const idle = (p[3] || 0) + (p[4] || 0);
      if (st.prevCpu) {
        const dt = total - st.prevCpu.total;
        const di = idle - st.prevCpu.idle;
        if (dt > 0) payload.cpu = Math.max(0, Math.min(100, (1 - di / dt) * 100));
      }
      st.prevCpu = { total, idle };
    }
  }
  // MEM: /proc/meminfo (kB)
  if (sec.MEM) {
    let total = null, avail = null, free = null, buffers = null, cached = null;
    for (const l of sec.MEM) {
      let m;
      if ((m = l.match(/^MemTotal:\s+(\d+)/))) total = +m[1];
      else if ((m = l.match(/^MemAvailable:\s+(\d+)/))) avail = +m[1];
      else if ((m = l.match(/^MemFree:\s+(\d+)/))) free = +m[1];
      else if ((m = l.match(/^Buffers:\s+(\d+)/))) buffers = +m[1];
      else if ((m = l.match(/^Cached:\s+(\d+)/))) cached = +m[1];
    }
    if (total) {
      payload.memTotal = total * 1024;
      const usedKb = avail != null ? total - avail : total - (free + buffers + cached);
      payload.memUsed = Math.max(0, usedKb) * 1024;
    }
  }
  // NET: /proc/net/dev 累计字节差值 -> B/s（按网卡分别统计 + 汇总）
  if (sec.NET) {
    let rx = 0, tx = 0, found = false;
    const cur = {};
    for (const l of sec.NET) {
      const idx = l.indexOf(':');
      if (idx < 0) continue;
      const name = l.slice(0, idx).trim();
      if (!name || name === 'lo') continue;
      const cols = l.slice(idx + 1).trim().split(/\s+/).map(Number);
      if (cols.length >= 9) {
        cur[name] = { rx: cols[0], tx: cols[8] };
        rx += cols[0];
        tx += cols[8];
        found = true;
      }
    }
    if (found) {
      const now = Date.now();
      payload.nets = [];
      const prevNics = st.prevNics;
      for (const name of Object.keys(cur)) {
        let nrx = null, ntx = null;
        if (prevNics && prevNics.t && prevNics.data[name]) {
          const dt = (now - prevNics.t) / 1000;
          if (dt > 0) {
            nrx = Math.max(0, (cur[name].rx - prevNics.data[name].rx) / dt);
            ntx = Math.max(0, (cur[name].tx - prevNics.data[name].tx) / dt);
          }
        }
        payload.nets.push({ name, rx: nrx, tx: ntx });
      }
      st.prevNics = { data: cur, t: now };
      if (st.prevNet) {
        const dt = (now - st.prevNet.t) / 1000;
        if (dt > 0) {
          payload.netRx = Math.max(0, (rx - st.prevNet.rx) / dt);
          payload.netTx = Math.max(0, (tx - st.prevNet.tx) / dt);
        }
      }
      st.prevNet = { rx, tx, t: now };
    }
  }
  // DISK: df -P -k
  if (sec.DISK) {
    for (const l of sec.DISK) {
      const c = l.trim().split(/\s+/);
      if (c.length >= 6 && /^\d+$/.test(c[1]) && /%$/.test(c[4])) {
        payload.disks.push({ fs: c[0], mount: c[5], size: +c[1] * 1024, used: +c[2] * 1024, free: +c[3] * 1024 });
      }
    }
  }
  // PROC: CPU 占用 TOP5（pcpu rss pid comm）
  const parseTop = (lines) => {
    const arr = [];
    for (const l of lines || []) {
      const c = l.trim().split(/\s+/);
      if (c.length < 4) continue;
      const cpu = parseFloat(c[0]);
      const rss = parseFloat(c[1]);
      const pid = parseInt(c[2], 10);
      if (isNaN(cpu) || isNaN(rss) || isNaN(pid)) continue;
      arr.push({ name: c.slice(3).join(' ') || 'unknown', pid, cpu, mem: rss * 1024 });
    }
    return arr.slice(0, 5);
  };
  if (sec.PROC) payload.topProcs = parseTop(sec.PROC);
  return payload;
}

function parseWindowsMon(text) {
  const payload = { cpu: null, memTotal: 0, memUsed: 0, netRx: null, netTx: null, nets: [], disks: [], topProcs: [] };
  for (const line of text.split(/\r?\n/)) {
    const c = line.trim().split('|');
    if (c[0] === 'CPU') payload.cpu = parseFloat(c[1]);
    else if (c[0] === 'MEM' && c.length >= 3) {
      payload.memTotal = +c[1] * 1024;
      payload.memUsed = Math.max(0, +c[1] - +c[2]) * 1024;
    } else if (c[0] === 'NET' && c.length >= 3) {
      payload.netRx = +c[1];
      payload.netTx = +c[2];
    } else if (c[0] === 'NIC' && c.length >= 4) {
      payload.nets.push({ name: c[1].trim(), rx: +c[2], tx: +c[3] });
    } else if (c[0] === 'DISK' && c.length >= 4) {
      payload.disks.push({ fs: c[1], mount: c[1], size: +c[2], used: +c[2] - +c[3], free: +c[3] });
    } else if (c[0] === 'TOPC' && c.length >= 5) {
      payload.topProcs.push({ name: c[1], pid: +c[2] || 0, cpu: +c[3] || 0, mem: (+c[4] || 0) * 1024 * 1024 });
    }
  }
  return payload;
}

const PS_MON_SCRIPT =
  "$cpu=(Get-CimInstance Win32_Processor|Measure-Object -Property LoadPercentage -Average).Average; " +
  "Write-Output ('CPU|'+$cpu); " +
  "$os=Get-CimInstance Win32_OperatingSystem; " +
  "Write-Output ('MEM|'+$os.TotalVisibleMemorySize+'|'+$os.FreePhysicalMemory); " +
  "$rx=0; $tx=0; " +
  "Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | ForEach-Object { $rx+=$_.BytesReceivedPersec; $tx+=$_.BytesSentPersec; Write-Output ('NIC|'+$_.Name+'|'+$_.BytesReceivedPersec+'|'+$_.BytesSentPersec) }; " +
  "Write-Output ('NET|'+$rx+'|'+$tx); " +
  "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { Write-Output ('DISK|'+$_.DeviceID+'|'+$_.Size+'|'+$_.FreeSpace) }; " +
  "Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 | ForEach-Object { Write-Output ('TOPC|'+$_.ProcessName+'|'+$_.Id+'|'+[math]::Round($_.CPU,1)+'|'+[math]::Round($_.WorkingSet64/1MB,1)) }";

function runMonitorCycle(id, b, st) {
  if (!backends.has(id)) { stopMonitor(id); return; }
  if (b.type === 'ssh') {
    if (!b.conn) return;
    const cmd = 'echo __CPU__; head -2 /proc/stat; echo __MEM__; head -5 /proc/meminfo; echo __NET__; cat /proc/net/dev; echo __DISK__; df -P -k; echo __PROC__; ps -eo pcpu,rss,pid,comm --sort=-pcpu | head -8';
    b.conn.exec(cmd, (err, stream) => {
      if (err) { emit('mon:error', id, err.message); stopMonitor(id); return; }
      let out = '';
      stream.on('data', (d) => { out += d.toString(); });
      stream.stderr.on('data', () => {});
      stream.on('close', () => emit('mon:data', id, parseLinuxMon(out, st)));
    });
  } else {
    st.child = execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_MON_SCRIPT],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) { emit('mon:error', id, err.message); return; }
        emit('mon:data', id, parseWindowsMon(stdout));
      });
  }
}

// 每秒一次的流量采样（独立于 3s 主指标）
const PS_NET_SCRIPT =
  "Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | ForEach-Object { Write-Output ('NIC|'+$_.Name+'|'+$_.BytesReceivedPersec+'|'+$_.BytesSentPersec) };";

function parseNetLinux(text, stf) {
  const cur = {};
  let rx = 0, tx = 0, found = false;
  for (const l of text.split('\n')) {
    const idx = l.indexOf(':');
    if (idx < 0) continue;
    const name = l.slice(0, idx).trim();
    if (!name || name === 'lo') continue;
    const cols = l.slice(idx + 1).trim().split(/\s+/).map(Number);
    if (cols.length >= 9) {
      cur[name] = { rx: cols[0], tx: cols[8] };
      rx += cols[0];
      tx += cols[8];
      found = true;
    }
  }
  if (!found) return null;
  const now = Date.now();
  const payload = { nets: [], netRx: null, netTx: null };
  const prev = stf.prev;
  for (const name of Object.keys(cur)) {
    let nrx = null, ntx = null;
    if (prev && prev.data[name]) {
      const dt = (now - prev.t) / 1000;
      if (dt > 0) {
        nrx = Math.max(0, (cur[name].rx - prev.data[name].rx) / dt);
        ntx = Math.max(0, (cur[name].tx - prev.data[name].tx) / dt);
      }
    }
    payload.nets.push({ name, rx: nrx, tx: ntx });
  }
  if (prev) {
    const dt = (now - prev.t) / 1000;
    if (dt > 0) {
      payload.netRx = Math.max(0, (rx - prev.rx) / dt);
      payload.netTx = Math.max(0, (tx - prev.tx) / dt);
    }
  }
  stf.prev = { data: cur, rx, tx, t: now };
  return payload;
}

function startNetSampler(id, b, st) {
  st.fastNet = { prev: null };
  st.netTimer = setInterval(() => {
    if (!backends.has(id)) { clearInterval(st.netTimer); return; }
    if (b.type === 'ssh') {
      if (!b.conn) return;
      b.conn.exec('cat /proc/net/dev', (err, stream) => {
        if (err) return;
        let out = '';
        stream.on('data', (d) => { out += d.toString(); });
        stream.stderr.on('data', () => {});
        stream.on('close', () => {
          const p = parseNetLinux(out, st.fastNet);
          if (p) emit('mon:netdata', id, p);
        });
      });
    } else {
      execFile('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS_NET_SCRIPT],
        { windowsHide: true, timeout: 5000 },
        (err, stdout) => {
          if (err) return;
          const nets = [];
          for (const line of String(stdout).split(/\r?\n/)) {
            const c = line.trim().split('|');
            if (c[0] === 'NIC' && c.length >= 4) nets.push({ name: c[1].trim(), rx: +c[2], tx: +c[3] });
          }
          if (nets.length) {
            emit('mon:netdata', id, {
              nets,
              netRx: nets.reduce((a, n) => a + (n.rx || 0), 0),
              netTx: nets.reduce((a, n) => a + (n.tx || 0), 0),
            });
          }
        });
    }
  }, 1000);
}

ipcMain.handle('mon:start', (e, id) => {
  const b = backends.get(id);
  if (!b) return { ok: false, error: 'session not found' };
  stopMonitor(id);
  const st = { timer: null, prevCpu: null, prevNet: null, prevNics: null, child: null, netTimer: null, netChild: null };
  st.timer = setInterval(() => runMonitorCycle(id, b, st), MON_INTERVAL);
  monitors.set(id, st);
  runMonitorCycle(id, b, st);
  startNetSampler(id, b, st);
  return { ok: true };
});

ipcMain.handle('mon:stop', (e, id) => {
  stopMonitor(id);
  return { ok: true };
});

// ------------------------------------------------------- IPC: 剪贴板
ipcMain.on('clipboard:write', (e, text) => {
  clipboard.writeText(String(text));
});

ipcMain.handle('clipboard:read', () => clipboard.readText());

// ------------------------------------------------------- IPC: SFTP 文件操作
// 每个标签页复用同一个 SFTP 通道，避免超过 sshd MaxSessions 限制
const sftps = new Map(); // id -> Promise<sftp>

function resetSftp(id) {
  const p = sftps.get(id);
  sftps.delete(id);
  if (p && p.then) p.then((s) => { try { s.end(); } catch (_) {} }).catch(() => {});
}

function getSftp(id) {
  const b = backends.get(id);
  if (!b || b.type !== 'ssh' || !b.conn) return Promise.reject(new Error('当前标签页未连接 SSH'));
  if (sftps.has(id)) return sftps.get(id);
  const p = new Promise((resolve, reject) => {
    b.conn.sftp((err, sftp) => {
      if (err) { sftps.delete(id); return reject(err); }
      sftp.on('close', () => sftps.delete(id));
      resolve(sftp);
    });
  });
  sftps.set(id, p);
  return p;
}

function sftpTransfer(id, sftp, op, src, dst) {
  return new Promise((resolve, reject) => {
    sftp[op](src, dst, {
      concurrency: 4,
      step: (transferred, chunk, total) => {
        emit('fs:progress', id, {
          file: path.basename(src),
          pct: total > 0 ? Math.min(100, Math.floor((transferred / total) * 100)) : 0,
        });
      },
    }, (err) => (err ? reject(err) : resolve()));
  });
}

ipcMain.handle('fs:list', async (e, id, remotePath) => {
  try {
    const sftp = await getSftp(id);
    return await new Promise((resolve, reject) => {
      sftp.readdir(remotePath || '.', (err, list) => {
        if (err) return reject(err);
        const entries = list.map((f) => ({
          name: f.filename,
          isDir: f.attrs.isDirectory(),
          size: f.attrs.size,
          mtime: f.attrs.mtime * 1000,
        }));
        entries.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
        resolve(entries);
      });
    });
  } catch (err) {
    resetSftp(id);
    throw err;
  }
});

ipcMain.handle('fs:home', async (e, id) => {
  const b = backends.get(id);
  if (b && b.home) return b.home;
  try {
    const sftp = await getSftp(id);
    const home = await new Promise((resolve, reject) =>
      sftp.realpath('.', (err, p) => (err ? reject(err) : resolve(p))));
    if (b) b.home = home;
    return home;
  } catch (err) {
    resetSftp(id);
    throw err;
  }
});

// 从终端输出中解析 OSC 0/2 标题（bash 默认把 cwd 写入标题）与 OSC 7，实时跟踪交互 shell 目录
function trackCwd(id, chunk) {
  const b = backends.get(id);
  if (!b) return;
  b.cwdBuf = (b.cwdBuf || '') + chunk.toString('latin1');
  if (b.cwdBuf.length > 4096) b.cwdBuf = b.cwdBuf.slice(-1024);
  const re = /\x1b\](?:0|2|7);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let m;
  while ((m = re.exec(b.cwdBuf)) !== null) {
    const t = m[1];
    if (t.startsWith('file://')) {
      try { b.cwd = decodeURIComponent(t.slice(7)); } catch (_) {}
      continue;
    }
    const idx = t.lastIndexOf(': ');
    if (idx < 0) continue;
    const p = t.slice(idx + 2).trim();
    if (p.startsWith('/') || p === '~' || p.startsWith('~/')) b.cwd = p;
  }
}

ipcMain.handle('fs:cwd', async (e, id) => {
  const b = backends.get(id);
  if (!b || b.type !== 'ssh' || !b.conn) throw new Error('当前标签页未连接 SSH');
  // 1) 优先使用从终端输出跟踪到的真实 cwd
  let cwd = b.cwd;
  if (cwd && (cwd === '~' || cwd.startsWith('~/'))) {
    try {
      const home = b.home || await new Promise((resolve, reject) =>
        getSftp(id).then((s) => s.realpath('.', (err, p) => (err ? reject(err) : resolve(p)))).catch(reject));
      b.home = home;
      cwd = cwd === '~' ? home : home + cwd.slice(1);
    } catch (_) { cwd = null; }
  }
  if (cwd && cwd.startsWith('/')) return cwd;
  // 2) 回退: exec pwd（返回登录目录）
  return await new Promise((resolve, reject) => {
    b.conn.exec('pwd', (err, stream) => {
      if (err) return reject(err);
      let out = '';
      stream.on('data', (d) => { out += d.toString(); });
      stream.on('close', () => resolve(out.trim().split('\n').pop().trim()));
      stream.on('error', reject);
    });
  });
});

ipcMain.handle('download:choose', async (e, defaultName) => {
  const res = await dialog.showSaveDialog(win, {
    title: '保存下载文件',
    defaultPath: path.join(app.getPath('downloads'), defaultName || 'download'),
  });
  if (res.canceled || !res.filePath) return null;
  return res.filePath;
});

ipcMain.handle('fs:download', async (e, id, remotePath, localPath) => {
  try {
    const sftp = await getSftp(id);
    await sftpTransfer(id, sftp, 'fastGet', remotePath, localPath);
    return { ok: true };
  } catch (err) {
    resetSftp(id);
    throw err;
  }
});

// 选择本地目录（用于整个目录下载）
ipcMain.handle('dir:choose', async (e, defaultName) => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择保存目录',
    defaultPath: path.join(app.getPath('downloads'), defaultName || ''),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// 递归下载远程目录: 远程目录结构映射到本地 localDir 下
async function downloadDirRec(id, sftp, remoteDir, localDir, counter) {
  await fs.promises.mkdir(localDir, { recursive: true });
  const entries = await new Promise((resolve, reject) => {
    sftp.readdir(remoteDir, (err, list) => (err ? reject(err) : resolve(list)));
  });
  for (const f of entries) {
    const rp = path.posix.join(remoteDir, f.filename);
    const lp = path.join(localDir, f.filename);
    if (f.attrs.isDirectory()) {
      await downloadDirRec(id, sftp, rp, lp, counter);
    } else if (f.attrs.isFile()) {
      try {
        await sftpTransfer(id, sftp, 'fastGet', rp, lp);
        counter.done++;
        counter.bytes += f.attrs.size || 0;
        emit('fs:progress', id, { file: rp, pct: -1, done: counter.done, total: counter.total });
      } catch (err) {
        counter.failed.push(rp + ' (' + err.message + ')');
      }
    }
  }
}

ipcMain.handle('fs:downloadDir', async (e, id, remoteDir, localDir) => {
  try {
    const sftp = await getSftp(id);
    // 先统计文件总数（用于进度提示）
    let total = 0;
    const countFiles = async (dir) => {
      const list = await new Promise((resolve, reject) => {
        sftp.readdir(dir, (err, l) => (err ? reject(err) : resolve(l)));
      });
      for (const f of list) {
        if (f.attrs.isDirectory()) await countFiles(path.posix.join(dir, f.filename));
        else if (f.attrs.isFile()) total++;
      }
    };
    await countFiles(remoteDir);
    const counter = { done: 0, total, bytes: 0, failed: [] };
    await downloadDirRec(id, sftp, remoteDir, localDir, counter);
    return { ok: true, ...counter };
  } catch (err) {
    resetSftp(id);
    throw err;
  }
});

ipcMain.handle('fs:upload', async (e, id, localPath, remotePath) => {
  try {
    const sftp = await getSftp(id);
    // fastPut 签名: (localPath, remotePath)
    await sftpTransfer(id, sftp, 'fastPut', localPath, remotePath);
    return { ok: true };
  } catch (err) {
    resetSftp(id);
    throw err;
  }
});

// ------------------------------------------------------- IPC: 日志
// 自动存储规则: <应用目录>/logs/<会话名>_<yyyymmdd-HHMMSS>.log
function makeLogPath(sessionName) {
  const dir = path.join(app.getAppPath(), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(sessionName || 'session').replace(/[\\/:*?"<>|\s]+/g, '_');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return path.join(dir, `${safe}_${stamp}.log`);
}

ipcMain.handle('file:choose-key', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择私钥文件',
    defaultPath: app.getPath('home'),
    properties: ['openFile', 'showHiddenFiles'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('log:start', (e, id, sessionName) => {
  const b = backends.get(id);
  if (!b) return { ok: false, error: 'session not found' };
  closeLog(id);
  const filePath = makeLogPath(sessionName);
  b.logStream = fs.createWriteStream(filePath, { flags: 'a' });
  b.logStream.write(`==== MyShell session log started at ${new Date().toISOString()} ====\r\n`);
  return { ok: true, filePath };
});

ipcMain.handle('log:stop', (e, id) => {
  closeLog(id);
  return { ok: true };
});

// ------------------------------------------------------- IPC: 会话存取
function sessionsFile() {
  return path.join(app.getPath('userData'), 'sessions.json');
}

// 密码加密存储: safeStorage(DPAPI), 密文带前缀 enc:v1:, 密钥由操作系统管理不落盘
const SECRET_PREFIX = 'enc:v1:';

function isEncSecret(v) {
  return typeof v === 'string' && v.startsWith(SECRET_PREFIX);
}

function encryptSecret(plain) {
  if (!plain) return plain;
  try {
    if (!safeStorage.isEncryptionAvailable()) return plain;
    return SECRET_PREFIX + safeStorage.encryptString(String(plain)).toString('base64');
  } catch (_) {
    return plain;
  }
}

function decryptSecret(val) {
  if (!isEncSecret(val)) return val || '';
  try {
    return safeStorage.decryptString(Buffer.from(val.slice(SECRET_PREFIX.length), 'base64'));
  } catch (_) {
    return '';
  }
}

// 一次性迁移: 把旧的明文密码重新加密写回
function migrateSecrets() {
  try {
    const list = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'));
    if (!Array.isArray(list)) return;
    let changed = false;
    const out = list.map((s) => {
      if (s && typeof s === 'object' && s.password && !isEncSecret(s.password)) {
        changed = true;
        return { ...s, password: encryptSecret(s.password) };
      }
      return s;
    });
    if (changed) fs.writeFileSync(sessionsFile(), JSON.stringify(out, null, 2), 'utf8');
  } catch (_) { /* 文件不存在或损坏时忽略 */ }
}

function readSessions() {
  try {
    const list = JSON.parse(fs.readFileSync(sessionsFile(), 'utf8'));
    if (!Array.isArray(list)) return [];
    return list.map((s) => ({ ...s, password: decryptSecret(s.password) }));
  } catch (_) {
    return [];
  }
}

ipcMain.handle('sessions:load', () => readSessions());

ipcMain.handle('sessions:save', (e, sessions) => {
  const persist = (Array.isArray(sessions) ? sessions : []).map((s) => ({
    ...s,
    password: encryptSecret(s.password),
  }));
  fs.writeFileSync(sessionsFile(), JSON.stringify(persist, null, 2), 'utf8');
  return { ok: true };
});

ipcMain.handle('sessions:import', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '导入会话 (JSON)',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  try {
    return JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8'));
  } catch (err) {
    return { __error: err.message };
  }
});

ipcMain.handle('sessions:export', async (e, sessions) => {
  const res = await dialog.showSaveDialog(win, {
    title: '导出会话',
    defaultPath: path.join(app.getPath('documents'), 'myshell-sessions.json'),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false };
  fs.writeFileSync(res.filePath, JSON.stringify(sessions, null, 2), 'utf8');
  return { ok: true, filePath: res.filePath };
});

// ------------------------------------------------------- 主窗口
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  migrateSecrets();
  createWindow();
});

app.on('window-all-closed', () => {
  for (const id of Array.from(backends.keys())) cleanupBackend(id);
  app.quit();
});
