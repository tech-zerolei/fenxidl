# 在 Windows 上构建安装程序

本项目已验证：类型检查、24 项单元测试、分段下载端到端测试、真实 TaskManager 集成测试
（6.3 MB / 6 段 / SHA-256 校验一致）、以及 Electron GUI 冒烟测试（真实窗口渲染 + 截图）。

Linux 上已成功生成 `release/win-unpacked/`（可直接运行的 Windows 程序目录），
但生成 **NSIS 安装包** 需要在 Windows 上执行，因为 electron-builder 修改 Windows
可执行文件资源时需要原生 Windows 环境（Linux 下需要 wine32，配置繁琐）。

## 一、环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11 x64 |
| Node.js | **22.12+ / 24.x**（推荐 22 LTS；本项目在 Node 26 上也验证通过） |
| npm | 随 Node.js 附带 |
| 磁盘 | 约 1.5 GB（含 Electron 与依赖） |

安装 Node.js：<https://nodejs.org/> 下载 LTS 版本，安装时勾选 "Add to PATH"。

验证：

```cmd
node -v
npm -v
```

## 二、构建步骤

把整个项目文件夹复制到 Windows（例如 `D:\fenxi-dl`），然后在该目录打开
**PowerShell** 或 **命令提示符**：

```cmd
cd D:\fenxi-dl

REM 1. 安装依赖
npm install

REM 2. 类型检查 + 测试（应当全部通过）
npm run build
npm test

REM 3. 生成安装程序
npm run dist:win
```

完成后产物在 `release\` 目录：

| 文件 | 说明 |
| --- | --- |
| `FenxiDL-1.0.0-x64.exe` | **NSIS 安装程序**（可改安装目录、创建桌面与开始菜单快捷方式、含卸载器） |
| `FenxiDL-1.0.0-portable.exe` | 免安装单文件版 |
| `win-unpacked\` | 解包后的程序目录，可直接运行 `FenxiDL.exe` |

## 三、不需要的东西

- **不需要** Visual Studio / C++ 编译器：项目没有原生模块，全部是纯 JavaScript。
- **不需要** 代码签名证书：未签名时 Windows SmartScreen 会提示"未知发布者"，
  点击"更多信息 → 仍要运行"即可。要消除提示需购买代码签名证书，并在
  `package.json` 的 build 配置中加入 `win.certificateFile` 与 `win.certificatePassword`。
- **不需要** 管理员权限：安装程序默认按当前用户安装（`perMachine: false`）。

## 四、如果构建失败

### 1. 下载 Electron 很慢或失败

国内网络可设置镜像后重试：

```cmd
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run dist:win
```

### 2. `electron-builder` 报 "cannot execute" 或权限错误

以管理员身份重新打开终端，或先清理再重试：

```cmd
rmdir /s /q release
rmdir /s /q node_modules
npm install
npm run dist:win
```

### 3. 只想要能直接跑的 exe，不打安装包

```cmd
npx electron-builder --win --dir
```

产物在 `release\win-unpacked\FenxiDL.exe`，可整体复制到任意位置运行。

### 4. npm 提示 `install-scripts` 未批准

本项目依赖里的 `electron` 与 `esbuild` 有安装脚本（下载各自的二进制）。
新版 npm 会要求确认，执行：

```cmd
npm install-scripts approve electron esbuild
npm install
```

## 五、构建后自检

```cmd
cd release\win-unpacked
FenxiDL.exe
```

应看到主窗口：左侧分类栏、顶部工具栏、中部任务列表。
尝试下载一个文件验证功能：

1. 点击 **新建下载**
2. 输入任意 https 直链（例如 `https://proof.ovh.net/files/10Mb.dat`）
3. 观察状态从「正在连接」→「正在下载」→「已完成」
4. 双击已完成的任务可打开文件

### 验证分段下载

1. 打开 **选项 → 连接**，确认「默认最大连接数」为 8
2. 下载一个较大文件
3. 在任务运行时**双击任务**，打开「下载进度」对话框
4. 展开「各线程的起始位置以及下载进度」，应能看到多条并行区间

### 验证断点续传

1. 下载一个大文件到一半
2. 点击 **暂停**
3. 再次点击 **继续**
4. 进度应从暂停处继续，而不是归零

## 六、浏览器集成（可选）

`extension\` 目录是 Chrome / Edge 扩展：

1. 打开 `chrome://extensions`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择项目的 `extension` 文件夹
4. 先启动 FenxiDL，再打开扩展弹窗，应显示「已连接本地服务」

它在浏览器中捕获音视频请求并报告给本机的 FenxiDL（监听 `127.0.0.1:47823`，
仅回环地址，不注入浏览器进程、不安装内核驱动）。捕获到的内容会出现在
主界面的 **媒体** 面板中。

## 七、目录结构

```
fenxi-dl/
├── src/
│   ├── main/                 主进程
│   │   ├── index.ts          窗口、托盘、IPC、生命周期、冒烟自检
│   │   ├── download-engine.ts  HTTP 探测、分段并发、断点续传
│   │   ├── task-manager.ts   队列、调度、配额、限速、持久化
│   │   ├── grabber.ts        站点抓取（爬取 + 过滤 + 统计）
│   │   ├── media-sniffer.ts  媒体捕获服务 + HLS/DASH 解析
│   │   ├── batch.ts          通配符批量下载
│   │   ├── settings.ts       默认设置与分类规则
│   │   └── preload.ts        contextBridge 桥接
│   ├── renderer/             渲染进程（React + Material Design 3）
│   │   ├── App.tsx           主界面：Navigation Rail + Top App Bar + 任务表
│   │   ├── dialogs/          9 个 MD3 对话框
│   │   └── md3/
│   │       ├── tokens.css    MD3 设计令牌（色彩角色/排版/形状/海拔/动效/深浅主题）
│   │       ├── md3.css       MD3 组件样式
│   │       ├── components.tsx MD3 组件（按钮/FAB/字段/Chip/Snackbar/Dialog/Tabs…）
│   │       └── icons.tsx     Material Symbols 图标（内联 SVG）
│   ├── shared/types.ts       共享类型契约
│   └── test/                 单元 + 端到端 + 集成测试
├── extension/                Chrome/Edge 扩展
├── assets/                   图标与许可证
├── docs/                     功能规格与构建说明
└── dist/                     构建产物（由 npm run build 生成）
```

## 八、已知限制

这些是明确的功能边界，不是缺陷：

1. **不支持 FTP**。原产品实现了 FTP（含 `REST` 续传与 PASV 模式），本实现只做
   HTTP/HTTPS。选项页保留了 FTP 代理配置项以保持界面完整，但不会发起 FTP 会话。
2. **浏览器集成是扩展 + 回环服务**，不是内核驱动。原产品通过 `idmwfp*.sys` /
   `idmtdi*.sys` 在内核层拦截，本实现有意不涉及内核代码。
3. **不含授权/注册机制**。原产品是商业软件，本项目是独立实现，不复制其授权逻辑。
4. **媒体嗅探不做音视频合并**。原产品能将分离的音视频流合并（对应字符串 21192），
   本实现会分别下载并保存为两个文件，不内嵌 ffmpeg。
5. **拨号连接**项仅保存配置，不会实际拨号（依赖系统 RAS，未做跨平台封装）。
