# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)：
`主版本.次版本.修订号`。

- **主版本**：不兼容的变更（配置格式、任务数据格式、IPC 契约）
- **次版本**：向后兼容的功能新增
- **修订号**：向后兼容的缺陷修正

由于 1.x 阶段仍在快速修正，本文件按**发布版本**组织，并在每个版本下列出对应的
提交范围，方便把任意一次构建回溯到确切的源码状态。

---

## 版本对照表

| 版本 | 提交范围 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- | --- |
| `v1.0.0` | `157b647` … `036c8a6` | 2026-11-16 | 已发布 | 首个公开发布版本，Linux x64 |
| `v1.1.0` | `2f9e864` … 当前 | 2026-11-16 | 已发布 | 完整审查后的修复版 |

---

## [1.1.0] — 2026-11-16

完整代码审查后的修复版本。这一版的重点不是加功能，而是修复一批会导致**数据损坏**、
**凭据泄露**和**启动失败**的真实缺陷。

**提交范围**：`2f9e864`、`9c9ff04`、`f449ba6`、`d0714df`、`6321979`
（含随附的版本规划提交）

### 修复 — 数据完整性（最严重）

- **断点续传产出全零坏文件**（`task-manager.ts`）
  旧实现在恢复时无条件信任持久化的分段记账，而工作文件可能已被 `ftruncate`
  预分配成全零。结果是文件大小正确、状态显示"已完成"、内容部分全零。
  现在引入进度 sidecar 与工作文件的一致性校验：只有 sidecar 的分段记账、总长度、
  ETag 与磁盘实际大小**全部吻合**时才复用旧进度，否则整体重下。

- **完成前缺少完整性断言**（`task-manager.ts`）
  新增 `assertComplete`：所有分段必须写满、磁盘大小必须等于总长度，
  否则抛 `EINCOMPLETE` 置为错误状态，绝不标记完成。

- **`fs.writeSync` 短写留下零洞**（`task-manager.ts`）
  返回值被忽略，短写时产生未初始化空洞导致哈希错位。
  新增 `writeFullySync` 循环写满。

- **续传从不真的续传**（`download-engine.ts`）
  预分配使文件大小恒等于总长度，`stat.size < totalBytes` 判定恒假，
  每次恢复都从 0 重下。改为可选预分配：单连接不预分配（文件大小即真实字节数），
  仅多分段并发写同一 fd 时才预分配。

- **拒绝用截断覆盖更大的已有文件**（`download-engine.ts`）

### 修复 — 并发与性能

- **暂停后继续永久卡死**（`task-manager.ts`）
  旧 `run()` 的 catch 按 task-id 清理，会 abort 掉新一轮刚创建的 controller。
  引入**运行令牌**（`token`）机制：每次 start 递增，catch 时校验令牌归属，
  只处理属于自己这一轮的收尾。同时用 `intent` 区分 pause / stop，
  不再把暂停误记成停止。

- **`stopAll` 复活任务**（`task-manager.ts`）
  逐个调 `stop()` 会触发 `pump()`，把排队任务重新拉起继续写盘。
  新增 `pumpHalted` 阻断。

- **限速阻塞事件循环**（`download-engine.ts`）
  同步 `while (Date.now() < until) {}` 自旋使事件循环滞后 2091ms、限速精度超标 27%。
  改为 async `pace()` + 流背压（`pause()` / `resume()`），滞后降至 **1–2ms**。

- **interval 计划任务只触发一次**（`task-manager.ts`）
  重写 interval 调度计算，实测 120 分钟窗口内触发 8/8 次（原为 1 次）。

- **`downloadSegment` 缺显式 settle**（`download-engine.ts`）
  补 `close` 事件监听与空响应无进展检测，避免流挂起时永久等待。

### 修复 — 安全

- **任意文件写 → RCE**（`index.ts`）
  `dl:updateTask` 把渲染进程的 patch 原样 `Object.assign` 进任务对象，
  可改 `savePath` 写任意路径，配合病毒扫描钩子达成 RCE
  （已实测写入 `authorized_keys` 并落地 `/bin/sh -c touch` 标记文件）。
  改为字段白名单，并且**显式拒绝**未知字段而不是静默忽略。

- **凭据泄露给第三方主机**（`download-engine.ts` / 新增 `validate.ts`）
  凭据匹配用 `url.includes(site)`，`http://evil.com/?bank.com` 这类 URL
  会把 `bank.com` 的凭据发给攻击者主机（已实测观察到凭据到达 evil 主机）。
  改为严格 host 匹配（host 相等或子域）。

- **跨域重定向未剥离 Cookie**（`download-engine.ts`）
  原来只剥离了 `extraHeaders`，漏了 `options.headers`。

- **preload 暴露面过宽**（`preload.ts`）
  任意通道透传改为具名方法，渲染进程无法再调用未声明的方法。

- **新增统一校验层**（`src/main/validate.ts`，699 行）
  `asString` / `asInt` / `asEnum` / `asArray`、`parseHttpUrl`、
  `assertOutboundHostAllowed`（含 `blockLoopback` / `blockPrivate`）、
  `hostMatchesSite`、`assertSafePath`、`isSensitivePath`、`isWithin`、
  `assertSafeFileName`、`sanitizeHeaderRecord`、`assertExecutableProgram`、
  `buildScanArgv`、`hardenFilePermissions`、`protectSecret` / `unprotectSecret`。

- **导航与权限拦截**（`index.ts`）
  新增 `will-navigate` / `will-frame-navigate` / `will-redirect` 三重拦截与权限处理器。

- **设置项逐字段白名单**（`settings.ts`）
  31 项设置逐字段校验，未知键报错并列出全部合法键。

- **凭据落盘加密**（`settings.ts`）
  磁盘实测为 `fenxi-enc:v1:` 前缀，文件权限 **0600**。

- **媒体嗅探收口**（`media-sniffer.ts`）
  Origin 分级策略（仅 `chrome-extension://` 放行）、共享 token、
  `X-Content-Type-Options`、SSRF 目标拦截、请求体大小限制。

### 修复 — Linux 打包与启动

- **AppImage 以 root 启动崩溃**（`build/patch-appimage.cjs`）
  Chromium 在 root 下要求 `--no-sandbox`，且该检查发生在应用代码之前，
  主进程内 `appendSwitch` 已经太晚。
  `patch-appimage.cjs` 在打包后修改 AppRun，仅当 `uid=0` 时追加该参数，
  普通用户仍保留完整沙箱。

- **AppImage 首次启动弹出 EULA 对话框**（`assets/`、`patch-appimage.cjs`）
  electron-builder 把 `buildResources` 下的 `LICENSE.txt` 当作用户许可协议
  复制到镜像根目录，AppRun 随即用 `zenity --text-info` 阻塞等待"同意"，
  无显示环境下表现为启动挂死。
  修复：`assets/LICENSE.txt` 改名为 `THIRD-PARTY-NOTICES.txt`，
  许可文本仍通过 `extraResources` 以 `resources/LICENSE-FenxiDL.txt` 分发。

  > 1.1.0 修复版源码曾重新引入 `assets/LICENSE.txt`，导致该问题复发；
  > 已在 `6321979` 中删除，并在 `patch-appimage.cjs` 增加 repack 时清除镜像根
  > 许可文件的防线。

- **fuse 加固被静默跳过**（`build/after-pack-linux.cjs`）
  钩子按 `productName` 小写推导可执行文件名（`fenxidl`），
  而 electron-builder 实际生成的是 `fenxi-dl`。文件不存在时只打印一行日志就返回，
  导致 Electron fuses 加固**在 Linux 上从未生效**。
  改为依次尝试多个候选名并做存在性检查。

  现在打包时会真正关闭 `RunAsNode`、`EnableNodeCliInspectArguments`、
  `EnableNodeOptionsEnvironmentVariable`，并只在 asar 内加载应用。

- **root 启动日志误导**（`src/main/index.ts`）
  检查顺序错误：先判断环境变量、后判断命令行。
  AppImage 已正确传入 `--no-sandbox` 时仍打印
  "Refusing to disable the Chromium sandbox"，看起来像安全违规。
  改为先检查 `hasSwitch('no-sandbox')`。

### 新增 — 界面对齐 MD3 与无障碍

- **Navigation Rail 溢出**（`md3.css` / `App.tsx`）
  11 个目的地塞进 80px 宽导航栏，1180×720 溢出 234px、"关于"完全不可见，
  900×520 溢出 434px。
  改为 3 个主视图 + 1 个可折叠「分类」flyout + 底部「关于」，
  符合 MD3「rail 3–7 个目的地」规范。实测两种尺寸均 0px 溢出。

- **表格键盘不可达**（`App.tsx`）
  整个渲染层只有 1 处 `tabIndex`，表格行无法键盘选中，
  所有批量操作对键盘用户**永久不可用**。
  为 `tr` / `th` 补 `tabIndex` / `role` / `aria-sort` / `onKeyDown`（Enter / Space）。

- **对话框焦点逃逸**（`md3/components.tsx`）
  `aria-modal="true"` 但无焦点陷阱，Tab 一次就逃到遮罩后。
  补完整焦点陷阱（Tab / Shift+Tab 循环、Esc、焦点归还触发按钮、
  `aria-labelledby`）。实测前后向各 20 次 Tab，0 次逃逸。

- **MD3 令牌补齐**（`tokens.css`）
  补全 `letter-spacing` 全档位、light 主题语义色、状态图层百分比变量、rail 尺寸令牌。

### 新增 — 工程化

- `src/test/harness.ts`：测试公共设施（服务器、临时目录、清理）
- `build/env.mjs`：构建环境判定（dev / prod）
- `eslint.config.mjs`（ESLint 9 flat config）、`.prettierrc`、`.prettierignore`、
  `.editorconfig`
- `package.json` 新增 12 个 script（`verify` / `test:*` / `lint` / `format` /
  `build:dev` 等），补 `engines`
- `build-test.mjs` 由硬编码 4 个 entry 改为 glob 发现，新测试不会被遗忘
- 构建产物 sourcemap 可控（`build:dev` 开，发布构建关）

### 新增 — 品牌资产

- **应用图标重新设计**（`assets/icon.svg` / `icon.ico` / `icon.png`）
  三条连接通道汇聚成一个下载箭头，对应产品核心能力：
  多连接分段下载最终落成同一个文件。
  提供矢量源文件与 16 / 24 / 32 / 48 / 64 / 128 / 256 多尺寸 ICO。
- `docs/banner.png`：1280×640 项目横幅
- `docs/logo-256.png`：README 与发布页用标志

### 测试

- 集成测试与临时目录测试显式 `mkdtempSync` + 失败路径 `dispose()` + 正确退出码，
  **由挂死 45s 改为 55ms 退出**
- 新增 Origin 策略用例
- `npm run verify` 一条命令跑完：typecheck + 构建 + 27 单元 + 集成 + 端到端

实测结果：

```
tsc --noEmit                     exit 0（零错误）
npm test                         tests 27 / pass 27 / fail 0
INTEGRATION                      EXIT 0 after 60ms
E2E                              EXIT 0 after 45ms
npm run lint                     0 errors, 14 warnings
```

### 已知遗留

| 编号 | 问题 | 影响 |
| --- | --- | --- |
| H-1 | Electron 33.4.11 已 EOL（2025-04-28），`npm audit` 报 47 条公告 | 已知漏洞无官方补丁 |
| H-2 | 巨型函数未拆分：`registerIpc()` 504 行、`App()` 630 行 | 可维护性 |
| H-3 | 8 个空转配置项 UI 仍可点但无效（`connectionTypeId` 8 档速度、`ftpProxy` 等） | 误导用户 |
| H-4 | `patch-appimage.cjs` 依赖外部 `unsquashfs` / `mksquashfs` | 构建环境依赖 |
| H-5 | 浏览器扩展 ID 未固定 | 任意 `chrome-extension://` 可注入媒体条目 |
| H-6 | 16 个未使用 CSS token | 死代码 |

以上均不影响功能正确性，也不影响已通过的测试。

---

## [1.0.0] — 2026-11-16

首个公开发布版本。Linux x64 预编译包。

**提交范围**：`157b647`、`33f627c`、`ccb31f3`、`9a325b6`、`852da20`、`036c8a6`

### 功能

- **下载引擎**：HTTP Range 分段并发（连接数 1–32）、断点续传、
  `GET Range: bytes=0-0` 探测、临时目录暂存、自动重试与指数退避、
  全局限速、流量配额、HTTP/HTTPS 代理（CONNECT 隧道）、站点凭据、扩展名校正
- **任务与队列**：主队列 + 自定义队列、计划任务（一次 / 每天 / 每周 / 间隔）、
  队列结束动作（退出 / 关机 / 睡眠 / 休眠 / 挂断）、分类管理、
  8 列任务表 + 7 种排序 + 搜索 + 多选、状态持久化
- **下载方式**：单任务、通配符批量、BFS 站点抓取、HLS/DASH 媒体嗅探
- **界面**：Material Design 3 全套令牌、深浅双主题、Navigation Rail + Top App Bar、
  上下文应用栏、6 种按钮 + 12 类组件、9 个 MD3 对话框、
  Material Symbols 内联 SVG 图标（图标名为联合类型，拼错编译失败）
- **其他**：系统托盘、系统通知、剪贴板监视、完成后病毒扫描钩子、
  导出 / 导入任务列表

### 打包

- Windows：NSIS 安装程序 + 免安装单文件（需在 Windows 上构建）
- Linux：AppImage + deb + 解包目录
- `build-windows.cmd` / `build-windows.ps1` 一键构建脚本

### 本版本包含的启动修复

- `852da20`：修复 AppImage 首次启动弹出许可协议与开发版 DevTools 遮挡窗口
- `036c8a6`：修复 AppImage 以 root 身份无法启动

> **注意**：1.0.0 的发布产物包含上述两项修复，但 `v1.0.0` 的 git 标签
> 最初指向 `9a325b6`（早于这两项修复）。该标签已在版本规划中改为指向
> `036c8a6`，使标签与实际产物一致。

### 已知问题（由 1.1.0 修复）

1.0.0 存在若干在后续审查中发现的缺陷，**建议使用 1.1.0 或更新版本**：

- 断点续传可能产出全零坏文件却标记"已完成"
- 续传从不真的续传（每次从 0 重下）
- 暂停后立即继续会导致任务永久卡死
- 限速阻塞 Node 事件循环（滞后约 2 秒）
- `dl:updateTask` 可被用来任意写文件，进而 RCE
- 凭据可被构造 URL 泄露给第三方主机
- 导航栏在 1180×720 溢出，"关于"入口不可见
- 表格无法键盘操作
- 对话框焦点可逃逸

---

## 版本回溯命令

把任意一次发布对回确切的源码状态：

```bash
# 1.0.0 的源码
git checkout v1.0.0

# 1.1.0 的源码
git checkout v1.1.0

# 查看某个版本包含哪些提交
git log --oneline v1.0.0..v1.1.0
```

校验已下载的安装包：

```bash
sha256sum -c <<'EOF'
# v1.0.0
10d2b7ca8d4488b11d9afc246a6f9c8b286c91e42610941ad04d99dd7cbdda7f  FenxiDL-1.0.0.AppImage
57f60d1f9906808423c4669649abd220acbb3d2a9e448a32d38399453b51f60d  fenxi-dl_1.0.0_amd64.deb
EOF
```