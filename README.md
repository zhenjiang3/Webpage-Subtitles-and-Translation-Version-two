# 网页实时双语字幕

打开任意视频网页 → 启动后端 → 实时 ASR + 中英日翻译，字幕叠加显示，**无需上传视频**。

本项目在 `Webpage Subtitles and Translation` 的翻译能力之上重构：旧版只能通过上传视频文件来生成字幕与翻译；新版改为**浏览器扩展 + 本地后端**架构，扩展自动注入到任意包含 `<video>` 的网页，捕获其音频流并实时送后端识别翻译，字幕直接叠加在视频上方。

## 架构

```
┌──────────────────────┐    WebSocket     ┌──────────────────────┐
│  Chrome/Edge MV3 扩展 │  ────────────▶  │  本地 Node 后端       │
│  (任意视频网页)        │                 │  (127.0.0.1:17712)   │
│  ─ audio-capture.ts   │  ◀────────────  │  ─ ffmpeg.ts         │
│  ─ timeline.ts        │   asr_result/   │  ─ whisper.cpp ASR    │
│  ─ overlay.ts         │   translation/  │  ─ Xenova NLLB 翻译    │
│  ─ content.ts        │                 │  ─ pipeline.ts        │
│  ─ background.ts      │                 │  ─ ws-handler.ts      │
└──────────────────────┘                 └──────────────────────┘
```

- **扩展** (`apps/extension`)：MV3，注入到 `<all_urls>`，用 `AudioContext.createMediaElementSource` 抽取视频音频，按 12 秒切块送后端；用 `Overlay` 渲染双语字幕，用 `Timeline` 把 ASR 结果按视频绝对时间排序与查找。
- **后端** (`apps/server`)：纯 Node + `ws`，每连接状态机：收到 `chunk` 头 + 二进制音频 → 写临时文件 → ffmpeg 转 WAV → `whisper-cli` ASR → Xenova 翻译 → 回送 `asr_result` + `translation`。
- **零 API Key**：默认使用本地 `whisper.cpp`（CPU）+ 本地 `Xenova NLLB-200`（CPU），无需 OpenAI/Google 等任何外部 API。

## 快速开始

### 1. 安装依赖

```powershell
cd "c:\Users\mengz\Desktop\版本二"
pnpm install
```

### 2. 下载本地离线模型（首次，约 900MB）

```powershell
pnpm --filter @app/server setup:offline
```

脚本会自动从 GitHub Release / HuggingFace 镜像下载 `whisper-cli.exe` 和 `ggml-small.bin`，并解压到 `apps/server/tools/whisper/`。国内网络已内置多条镜像兜底，PowerShell 走系统证书库，避免 Node undici 在 Windows 上的常见坑。

### 3. 启动后端

```powershell
pnpm dev
# 等价于：pnpm --filter @app/server dev
```

启动后访问 [http://127.0.0.1:17712/health](http://127.0.0.1:17712/health) 自检 ffmpeg / whisper-cli / 模型是否就绪。

### 4. 构建扩展并加载到浏览器

```powershell
pnpm --filter @app/extension build
```

构建产物在 `apps/extension/dist/`。然后在 Chrome/Edge 中：

1. 打开 `edge://extensions/` 或 `chrome://extensions/`
2. 打开右上角「开发者模式」
3. 点击「加载已解压的扩展」
4. 选择 `apps/extension/dist/` 目录
5. 扩展图标会出现在工具栏

### 5. 使用

1. 打开任意视频网页（B 站、YouTube、Netflix 等）
2. 点击扩展图标 → 勾选「启用字幕」→ 选择源/目标语言
3. 弹窗中确认「后端已连接」绿点
4. 播放视频，几秒后字幕会自动叠加在视频下方

> **注意**：`AudioContext.createMediaElementSource` 一旦对一个 video 调用即不可逆，关闭「启用字幕」后建议刷新页面恢复视频原生声音。

## 项目结构

```
版本二/
├── apps/
│   ├── extension/                # 浏览器扩展（MV3）
│   │   ├── manifest.json
│   │   ├── popup.html
│   │   ├── build.mjs             # esbuild 打包
│   │   └── src/
│   │       ├── content.ts        # 注入网页：检测 video、渲染 overlay
│   │       ├── background.ts     # service worker：管理 WebSocket、桥接消息
│   │       ├── popup.ts          # 弹窗脚本：读写设置、显示连接状态
│   │       ├── audio-capture.ts  # MediaRecorder + createMediaElementSource
│   │       ├── timeline.ts       # 字幕时间线：相对→绝对时间映射、二分查找
│   │       ├── overlay.ts        # 字幕 DOM 叠加层
│   │       ├── settings.ts       # chrome.storage.local 包装
│   │       └── messages.ts       # 全部消息协议类型定义
│   └── server/                   # 本地 Node 后端
│       ├── src/
│       │   ├── index.ts          # HTTP /health + WebSocket /ws
│       │   ├── ws-handler.ts     # 连接状态机、帧配对
│       │   ├── pipeline.ts       # 单块音频处理流水线
│       │   ├── ffmpeg.ts         # ffmpeg/ffprobe 封装
│       │   ├── asr/              # whisper.cpp provider
│       │   ├── translator/       # Xenova NLLB provider
│       │   └── lib/              # 共用工具（语言、时间、字幕解析）
│       ├── scripts/setup-offline.mjs   # 一键下载 whisper + 模型
│       └── .env.example
├── packages/
│   └── sharp-shim/               # Xenova 间接依赖 sharp，本地用 empty 包占位
├── AGENTS.md / DESIGN.md / DESIGN-V1.md   # 设计文档（保留原项目记忆与规则）
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

## 关键技术点

- **音频捕获**：`AudioContext.createMediaElementSource(video)` 抽取视频音频，同时连接到 `MediaStreamAudioDestinationNode`（供 `MediaRecorder` 抓取）和 `ctx.destination`（保持视频声音可听见）。
- **分块策略**：每 12 秒调用 `MediaRecorder.requestData()` 切出一个 webm/opus 块，切那一刻记录 `video.currentTime` 作为块起点，确保 ASR 结果的相对时间戳能精确映射回视频绝对时间。
- **字幕同步**：`Timeline` 类按 `startVideoSec` 升序维护 cue 列表，渲染循环（200ms 节流）按 `video.currentTime` 二分查找当前 cue。
- **多视频支持**：一个页面可同时存在多个 `<video>`（PIP、预告片），每个 video 独立 sessionId，通过 `video.dataset.rtSessionId` 路由 ASR 结果到对应 timeline。
- **全屏支持**：`fullscreenchange` 监听把 overlay 挪到 `document.fullscreenElement` 子树，保证全屏视频可见。
- **服务保活**：MV3 service worker 会被挂起，用 `chrome.alarms` 周期 ping（30s）维持 WS 连接并触发重连；指数退避重连（2s→30s）。
- **零 API**：`whisper.cpp` CPU 跑 `ggml-small.bin`（487MB，中文精度最佳体积权衡）；`Xenova NLLB-200` CPU 跑 600M 模型。两者均首次启动下载，之后纯本地。

## 配置（.env.local）

复制 `apps/server/.env.example` 为 `apps/server/.env.local` 并按需修改：

- `PORT=17712` —— 后端端口，扩展默认连 `ws://127.0.0.1:17712/ws`
- `WHISPER_CLI_PATH` / `WHISPER_MODEL_PATH` —— 自定义 whisper.cpp 路径
- `FFMPEG_BIN_PATH` / `FFPROBE_BIN_PATH` —— 自定义 ffmpeg 路径
- `XENO_REMOTE_HOST` —— Xenova 模型下载镜像（默认 `https://hf-mirror.com/`）

## 故障排查

| 现象 | 排查 |
|------|------|
| 弹窗显示「后端未连接」红点 | 确认 `pnpm dev` 已启动；防火墙未拦 127.0.0.1:17712 |
| 视频没声音了 | 扩展已 route 音频到 AudioContext；关闭扩展后刷新页面即可恢复 |
| 字幕延迟 > 15 秒 | `ggml-small.bin` 在低端 CPU 上较慢，可换 `ggml-base.bin`（148MB） |
| 首次翻译卡住 | Xenova NLLB 首次需下载 ~900MB 模型，请耐心等待 |
| B 站/YouTube 字幕不显示 | 确认视频已 `play`；autoplay 策略下需用户手势 |

## License

Private.
