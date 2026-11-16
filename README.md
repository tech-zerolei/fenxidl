# FenxiDL

一个使用 Electron + TypeScript 构建的高速多线程下载管理器，界面遵循 **Material Design 3** 规范。

跨平台（Windows / Linux / macOS），支持分段并发下载、断点续传、队列调度、站点抓取与媒体嗅探。

---

## 目录

- [用途](#用途)
- [应用场景](#应用场景)
- [兼容系统](#兼容系统)
- [功能](#功能)
- [界面](#界面)
- [快速开始](#快速开始)
- [构建 Windows 安装程序](#构建-windows-安装程序)
- [架构](#架构)
- [测试](#测试)
- [设计说明](#设计说明)
- [许可证](#许可证)

---

## 用途

FenxiDL 是一个通用下载管理器。它的核心价值在于：

1. **把单连接下载变成多连接并发下载** —— 对同一文件发起多个 HTTP Range 请求并行下载不同区段，显著提高在支持分段的服务上的吞吐量。
2. **让中断的下载可以续传** —— 逐段记录进度并持久化，程序退出、断网、暂停后都能从断点继续，而不是重头再来。
3. **让批量与规则化的下载自动化** —— 队列、计划任务、通配符批量、按站点规则抓取，把重复的手工下载变成配置一次的事情。
4. **提供可复用的下载能力** —— 全部逻辑在主进程以 TypeScript 实现，不依赖原生模块，可以单独取用 `download-engine.ts` 或 `task-manager.ts`。

它不是浏览器内置下载器的替代品，而是补充：浏览器擅长单次小文件，FenxiDL 擅长需要并发、续传、队列和批量的场景。

---

## 应用场景

### 1. 大文件下载

下载几 GB 的系统镜像、数据集、游戏资源包时，单连接往往跑不满带宽，且一旦中断就要重来。

```text
新建下载 → 粘贴地址 → 连接数设为 8～16
```

程序会自动探测服务器是否支持 Range 请求。支持则分段并发；不支持则自动降级为单连接，不会因为盲目并发而失败。

### 2. 不稳定的网络环境

移动网络、Wi-Fi 信号差、需要定时断网的环境。FenxiDL 会：

- 区分可重试错误（连接重置、超时）与不可重试错误（磁盘满、权限不足）
- 按指数退避自动重试
- 暂停后从断点恢复，不会因一次抖动丢掉已下载的数据

### 3. 需要排队与定时下载

夜间带宽空闲时下载、避免影响白天办公。

- **队列**：主队列 + 自定义队列，每个队列独立设置并发上限
- **计划任务**：一次 / 每天 / 每周 / 按间隔，可按星期选择
- **完成动作**：队列结束后退出、关机、睡眠、休眠或挂断拨号

### 4. 批量下载有序文件

一串有规律的地址，例如 `img001.jpg` … `img200.jpg`：

```text
批量下载 → 模板填写 https://example.com/img*.jpg
         起始 1，结束 200，通配符长度 3
```

实时预览会列出将创建的全部地址，确认后再开始。

### 5. 整站资源收集

需要把一个站点的图片、文档、音视频批量取下来做离线归档或分析：

```text
站点抓取 → 起始页 → 限定深度/站点 → 按类型和大小过滤 → 勾选结果加入任务
```

支持限制根站点深度与其他站点深度、按扩展名包含/排除、按路径包含/排除、按文件大小范围过滤，以及限制同时探索/下载的并发数（避免把服务器打挂）。

### 6. 网页媒体保存

保存网页中播放的音视频。浏览器扩展会把页面实际请求的媒体地址报告给本地捕获服务，FenxiDL 解析 HLS（m3u8）与 DASH（mpd）清单，列出可选清晰度。

> 说明：不内嵌 ffmpeg，不做音视频流合并。分离的音视频会保存为多个文件。

### 7. 需要代理或认证的下载

- HTTP / HTTPS / FTP 三套独立代理配置，HTTPS 走标准 CONNECT 隧道
- 按站点保存用户名密码，自动匹配
- 单任务可覆盖引用页（Referer）与自定义请求头

---

## 兼容系统

### 运行环境

| 系统 | 版本要求 | 说明 |
| --- | --- | --- |
| **Windows** | Windows 10 / 11（x64） | 主要目标平台。安装程序与免安装版均为 x64 |
| **Linux** | 带 glibc 的现代发行版（x64） | 已验证 Ubuntu 24.04；其他发行版理论可用，需自备图形环境 |
| **macOS** | macOS 11+（Intel / Apple Silicon） | 未在真机验证，理论上 Electron 支持即可运行 |

Windows 7 / 8 不受支持（Electron 33 已不再支持）。

### 构建环境

| 项目 | 要求 |
| --- | --- |
| Node.js | **22.x** 或 **24.x**（推荐 22 LTS） |
| npm | 随 Node.js 附带 |
| 原生编译工具 | **不需要** —— 项目无原生模块，纯 JavaScript |
| 管理员权限 | **不需要** —— 安装程序默认按当前用户安装 |
| 代码签名证书 | **不需要** —— 未签名时 SmartScreen 会提示，可手动放行 |

在 Linux 上生成 Windows 安装包需要 wine32（用于修改 Windows 可执行文件资源），配置繁琐。**推荐直接在 Windows 上构建。**

### 下载协议支持

| 协议 | 支持 | 说明 |
| --- | --- | --- |
| HTTP / HTTPS | ✅ | 分段并发、Range 续传、重定向、代理、Basic 认证 |
| FTP | ❌ | 未实现（选项页保留配置项但不会发起 FTP 会话） |

---

## 功能

### 下载引擎

- **多线程分段下载**：HTTP Range 并发分段，连接数 1–32 可配置，可按服务器单独覆盖
- **断点续传**：按段记录进度并持久化，重启后继续；服务器不支持 Range 时自动降级单连接
- **可靠探测**：用 `GET Range: bytes=0-0` 而非 `HEAD` 探测，避免服务器不返回长度的陷阱
- **临时目录暂存**：下载中的数据先存临时目录，完成后再移入目标位置，半成品不会出现在你的文件夹
- **自动重试**：区分可重试与不可重试错误，指数退避
- **全局限速**：按字节/秒节流所有传输
- **流量配额**：按时段计量，超额自动暂停并在下一时段恢复
- **代理**：HTTP/HTTPS 独立配置，HTTPS 走 CONNECT 隧道
- **站点凭据**：按主机名自动匹配用户名密码
- **扩展名校正**：服务器 Content-Type 与地址后缀不符时自动修正

### 任务与队列

- 主队列 + 自定义队列，每队列独立并发上限
- 计划任务：一次 / 每天 / 每周 / 按间隔
- 队列结束动作：退出 / 关机 / 睡眠 / 休眠 / 挂断
- 分类管理：程序 / 音乐 / 视频 / 游戏 / 文档 / 压缩文件 / 其他 / 已完成，按扩展名自动归类
- 8 列任务表，7 种排序，搜索过滤，Ctrl / Shift 多选
- 全部状态落盘：任务、队列、计划、设置重启后恢复

### 下载方式

- 单任务：自动探测文件名、大小、续传支持
- 批量：`*` 通配符模板 + 补零宽度，实时预览
- 站点抓取：BFS 爬取 + 深度/类型/路径/大小过滤 + 并发控制 + 实时统计
- 媒体嗅探：回环捕获服务 + HLS / DASH 清单解析

### 其他

- 系统托盘、系统通知、剪贴板监视
- 完成后病毒扫描钩子（自定义程序与参数）
- 导出 / 导入任务列表（`.fdx` 或纯文本）

---

## 界面

界面按 [Material Design 3](https://m3.material.io/) 规范实现：

**设计令牌层**（`src/renderer/md3/tokens.css`）
完整的 MD3 色彩角色（primary / secondary / tertiary / error、5 级 surface 色调、outline）、13 级排版比例、7 级形状刻度、5 级海拔阴影、MD3 动效曲线与时长、标准状态层不透明度。深色为默认，`[data-theme="light"]` 覆盖为浅色。

**导航模式**
左侧 Navigation Rail（FAB + 选中指示器 + 计数徽标）+ Top App Bar。选中任务时应用栏切换为**上下文模式**，只显示与选择相关的操作。

**组件**（`src/renderer/md3/components.tsx`）
Filled / Tonal / Outlined / Text / Elevated / Danger 六种按钮、FAB、IconButton、Outlined TextField、Checkbox、FilterChip、Linear / Circular Progress、Primary Tabs、List、Dialog、Snackbar。

**图标**（`src/renderer/md3/icons.tsx`）
Material Symbols 轮廓集，内联 SVG。图标名是联合类型 `IconName`，拼错会编译失败而不是运行时静默降级。

**无障碍**
图标按钮带 `aria-label`，表头带 `aria-sort`，对话框为 `role="dialog" aria-modal` 并管理焦点，键盘导航有 3px 主色 focus ring。

**修改配色的正确方式**：改 `tokens.css` 里的色彩角色变量，不要在组件里写死色值——否则浅色主题会失效。

---

## 快速开始

### 从源码运行

```bash
git clone <this-repo>
cd fenxi-dl
npm install
npm run build
npm start
```

首次安装若遇到 npm 的 `install-scripts` 拦截警告（electron 与 esbuild 需要下载二进制）：

```bash
npm install-scripts approve electron esbuild
npm install
```

国内网络下载 Electron 较慢时：

```bash
# Windows
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
# Linux / macOS
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

### 运行测试

```bash
npm test          # 27 项单元测试
npm run typecheck # TypeScript 严格模式检查
```

---

## 构建 Windows 安装程序

在 Windows 上，进入项目目录后任选一种：

**方式 A（推荐）**：双击 `build-windows.cmd`

**方式 B**：`powershell -ExecutionPolicy Bypass -File .\build-windows.ps1`

**方式 C**：手动执行

```cmd
npm install
npm run build
npm test
npm run dist:win
```

产物在 `release\`：

| 文件 | 说明 |
| --- | --- |
| `FenxiDL-1.0.0-x64.exe` | NSIS 安装程序（可改目录、建快捷方式、含卸载器） |
| `FenxiDL-1.0.0-portable.exe` | 免安装单文件 |
| `win-unpacked\FenxiDL.exe` | 解包目录，可直接运行 |

详细步骤与故障排查见 [docs/BUILD-WINDOWS.md](docs/BUILD-WINDOWS.md)。

---

## 架构

```
src/
├── main/                    Electron 主进程
│   ├── index.ts             窗口、托盘、50+ IPC 通道、生命周期
│   ├── download-engine.ts   探测、分段并发、断点续传、代理、重试
│   ├── task-manager.ts      队列、调度、配额、限速、持久化
│   ├── grabber.ts           站点抓取（爬取 + 过滤 + 统计）
│   ├── media-sniffer.ts     媒体捕获服务 + HLS/DASH 解析
│   ├── batch.ts             通配符批量
│   ├── settings.ts          默认配置、分类规则
│   └── preload.ts           contextBridge 安全桥接
├── renderer/                React 渲染进程（MD3）
│   ├── App.tsx              主界面
│   ├── dialogs/             9 个对话框
│   └── md3/                 设计令牌、组件、图标
├── shared/types.ts          主进程与渲染进程的类型契约
└── test/                    单元 / 端到端 / 集成测试
```

**安全边界**：渲染进程启用 `contextIsolation`，禁用 `nodeIntegration`，只通过 preload 暴露的白名单 API 与主进程通信。所有 IPC 入参在主进程侧做类型与范围校验，不信任渲染进程。

---

## 测试

| 类型 | 覆盖内容 |
| --- | --- |
| 单元测试（27 项） | 分段规划、文件名安全、批量展开、代理选择、媒体分类、HLS/DASH 解析、链接提取 |
| 端到端 | 真实 HTTP 服务器：分段下载 SHA-256 校验、非 Range 服务器降级、404 处理、断点续传只取剩余字节 |
| 代理穿透 | 真实代理服务器：统计代理收到的请求数，验证每段请求都走代理且内容一致 |
| 临时目录 | 验证分段数据先存临时目录、完成后搬移、无残留 |
| 集成 | 真实 TaskManager 完整生命周期：6.3MB / 6 段 / 哈希一致 / 重启后状态恢复 |
| GUI 冒烟 | 真实 Electron 窗口：渲染断言、9 个对话框逐一挂载、上下文应用栏、MD3 样式校验、截图 |

测试不使用 mock 网络层：每个涉及下载的测试都会启动真实 HTTP 服务器并校验下载内容的 SHA-256。

---

## 设计说明

本项目的功能设计参考了对某个商业下载管理器（Internet Download Manager 6.43）的**静态逆向分析结果**，用于确认应有的功能集合与交互结构。

**边界声明**：

1. 本项目是**独立实现**。不包含原产品的任何二进制代码、图标、语言文件或界面资源。
2. 不实现原产品的授权 / 注册机制。
3. 浏览器集成采用「标准扩展 + 本地回环捕获服务」，不安装内核驱动（原产品通过内核过滤驱动实现）。
4. 不支持 FTP；不做音视频流合并。
5. 界面为全新设计（Material Design 3），仅保留功能语义与信息架构。

本项目与 Internet Download Manager 的发行方（Tonec Inc.）无任何关联、合作或背书关系。

---

## 许可证

源代码采用 MIT 许可证，见 [LICENSE](LICENSE)。

Material Symbols 图标来自 Google，采用 Apache-2.0 许可证。
