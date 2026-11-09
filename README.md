# MyShell — 类 Xshell 终端工具

基于 **Electron + xterm.js + node-pty + ssh2** 的桌面 SSH / 本地终端工具。

## 功能

### 终端与会话
- 本地终端（PowerShell / bash，node-pty）
- SSH 连接（密码 / 私钥认证，支持 keyboard-interactive）
- 多标签页管理，连接状态指示（绿=已连接，黄=连接中，红=断开），断开自动置红并提示
- 标签页拖拽调整次序，宽度随名称自适应
- 会话管理器：保存 / 编辑 / 删除，支持 JSON 导入 / 导出
- 会话目录分组：新建 / 重命名 / 删除目录，会话可拖拽移入移出，层级缩进显示
- 会话密码使用 Electron safeStorage（Windows DPAPI）加密存储
- 日志记录：Ctrl+L 或状态栏切换，输出原始终端数据到 `.log` 文件
- 快捷命令栏：一键发送常用命令
- 快捷键：`Ctrl+T` 新建本地终端、`Ctrl+W` 关闭标签、`Ctrl+L` 日志开关

### 终端底部批量命令栏
- 输入命令回车 / 点击「发送全部」，同时写入所有已连接终端（SSH + 本地）并执行
- 实时显示已连接目标数量，无连接时按钮置灰

### 资源监控面板（可拖拽调宽，右侧）
- CPU、内存实时使用率
- **CPU 占用 TOP5 进程**：命令、PID、内存使用量（3 秒刷新）
- **网络流量**：每秒采样，下载/上传不同颜色柱状图记录最近 2 分钟
- 网卡下拉选择：可只看单个网卡，选择按会话记忆，重开会话默认监控该网卡
- 逻辑分区使用情况（可用 / 总量）
- 监控自动跟随当前标签页切换，新会话连接成功后自动接管

### 文件管理（左侧 SFTP 浏览器）
- 远程目录浏览、跳转、上级 / 刷新
- 右键下载、拖拽上传（自动落到当前终端所在目录）
- SFTP 通道按会话复用，自动规避 sshd MaxSessions 限制
- 通过终端标题序列实时跟踪交互 shell 的 cwd（支持 `~` 展开）

### 主题
- 5 套配色（Catppuccin / Solarized / Monokai / Dracula / Light）
- 主题对**整个应用界面**生效（顶栏、侧边栏、标签栏、监控、弹窗），不只终端

## 运行

需要先安装 Node.js（建议 18+）：https://nodejs.org

```powershell
npm install
npm start
```

> `node-pty` 为原生模块，Windows 下安装需要 VS Build Tools。若启动时报 node-pty 加载失败，执行 `npm run rebuild`。

### 无窗口启动

- 双击 `启动MyShell.vbs`（或 `启动MyShell.bat`，二者效果相同）——不产生额外控制台窗口

## 打包

```powershell
npm run dist    # NSIS 安装包 → dist/MyShell-Setup-<version>.exe
npm run dist:dir  # 仅生成免安装目录 dist/win-unpacked/
```

> `dist/win-unpacked/MyShell.exe` 可直接双击运行；`dist/myshell-<version>-x64.nsis.7z` 为安装包载荷，解压后同样可直接使用。

## 项目结构

```
main.js            主进程：pty/ssh 后端、资源监控采集、SFTP、日志、会话加密存储、IPC
preload.js         contextBridge 安全桥接
renderer/
  index.html       UI 布局（标签栏 / 侧边栏 / 批量命令栏 / 状态栏 / 监控面板 / 弹窗）
  styles.css       样式（CSS 变量驱动，随主题切换）
  app.js           标签页、会话目录、监控渲染、文件树、主题、批量发送逻辑
```

## 数据位置

| 数据 | 位置 |
|---|---|
| 会话列表 | `%APPDATA%/myshell/sessions.json`（密码已加密） |
| 会话日志 | `./logs/`（`<会话名>_<时间戳>.log`） |
| 快捷命令 / 目录分组 / 主题等偏好 | Electron localStorage |

## 注意

- 会话密码通过 safeStorage 加密，**换 Windows 账户 / 换机器后无法解密**；迁移会话请使用导出 / 导入。
- 导出的会话 JSON 为明文密码（便于跨机器导入），注意保密。
- SSH 无应用层心跳，网络静默丢包时断开感知可能有延迟。
