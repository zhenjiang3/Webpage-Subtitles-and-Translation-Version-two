# 实施计划：网页实时双语字幕扩展（浏览器扩展 + 本地后端）

## Context（为什么做这个改动）

参考项目 `C:\Users\mengz\Desktop\Webpage Subtitles and Translation` 是一个 Next.js 网页应用：用户**上传视频文件** → ffmpeg 抽音轨 → whisper.cpp 本地 ASR → Xenova NLLB 本地翻译 → 在网页编辑器里编辑/导出 SRT。

用户要求新项目 `c:\Users\mengz\Desktop\版本二` 改为：**启动后，在打开任意一个视频网页时，能实时生成并翻译网页视频的内容，无需上传视频**。

由于网页视频内容受同源策略限制，普通 Next.js 网页无法访问其它网页的 `<video>` 元素——必须靠**浏览器扩展注入**。因此架构从「上传式 Web 应用」改为「Chrome/Edge MV3 扩展 + 本地 Node 后端」。

**用户已确认的三项决策：**
1. 运行架构 = 浏览器扩展 + 本地后端（推荐）
2. 实时方案 = 分段近实时，每 10–15 秒抓一段音频跑 whisper.cpp，延迟 5–10 秒（whisper.cpp 只能处理整段音频文件，无法真正流式推理）
3. 旧功能（上传/编辑器/导出/SQLite 会话）**全部移除**，只做网页实时双语字幕叠加

复用参考项目的核心能力：whisper.cpp ASR、Xenova NLLB 翻译、ffmpeg 抽音轨、Provider 工厂模式、`.md` 记忆/规则文件（AGENTS.md/DESIGN.md/DESIGN-V1.md 原样保留）。

预期结果：用户启动后端 + 加载扩展后，打开任意视频网页（YouTube/Bilibili/MP4 直链等），点扩展图标开启、播放视频，约 15 秒后视频底部出现双语字幕叠加，原文在上、译文在下，后续每 ~12 秒续一段。

---

## 1. 项目结构（`c:\Users\mengz\Desktop\版本二`）

pnpm workspace，两个 app + 一个复用包，**不用 Turborepo**（两个包不需要）：

```
版本二/
├── .gitignore  .prettierrc  .env.example
├── AGENTS.md  DESIGN.md  DESIGN-V1.md      # 原样从参考项目复制
├── README.md                                   # 重写（双语，描述新架构）
├── package.json  pnpm-workspace.yaml  tsconfig.base.json
├── packages/sharp-shim/                        # 原样复制（Xenova 仍依赖 sharp 占位）
└── apps/
    ├── server/                                 # 本地后端
    │   ├── package.json  tsconfig.json  .env.example
    │   ├── scripts/setup-offline.mjs           # 下载 whisper-cli + ggml-small.bin
    │   ├── tools/whisper/                       # gitignore（二进制+模型）
    │   ├── data/                                # gitignore（临时音频块）
    │   └── src/
    │       ├── index.ts                         # http + ws 启动（端口 17712，仅 127.0.0.1）
    │       ├── ws-handler.ts                    # 每连接状态机 + 协议解析
    │       ├── pipeline.ts                      # 块 → ffmpeg → whisper → 翻译 → 回送
    │       ├── asr/{index.ts,types.ts,whispercpp.provider.ts}   # 复用
    │       ├── translator/{index.ts,types.ts,xenova-nllb.provider.ts}  # 复用
    │       ├── ffmpeg.ts                        # 原样复用
    │       └── lib/{types.ts,languages.ts,time.ts,subtitles/index.ts}  # 复用
    └── extension/                              # Chrome/Edge MV3 扩展
        ├── manifest.json  popup.html  build.mjs  package.json  tsconfig.json
        └── src/
            ├── messages.ts   # chrome.runtime + WS 消息类型（单一真源）
            ├── settings.ts   # chrome.storage 包装
            ├── popup.ts      # 开关 + 源/目标语 + 后端状态
            ├── background.ts # service worker：WS 客户端 + 消息中继 + keep-alive
            ├── audio-capture.ts  # AudioContext.createMediaElementSource + MediaRecorder 分块
            ├── timeline.ts   # 每视频 cue 时间线 + 二分查找
            ├── overlay.ts     # 字幕叠加 DOM 渲染
            └── content.ts    # 注入页面、发现 <video>、调度上述模块
```

---

## 2. 后端 `apps/server`

**选型**：Node 原生 `http` + `ws`，**不用 Express/Next**（只有 1 个健康检查路由 + 1 个 WS 端点）。端口 `17712`，仅绑定 `127.0.0.1`（不对外暴露）。

### 2.1 `src/index.ts`
- `http.createServer`：唯一路由 `GET /health` → `{ ok, ffmpeg, whisperCli, whisperModel, translatorProvider }`
- `new WebSocketServer({ server, path: '/ws' })` → 每个 connection 走 `ws-handler`
- `server.listen(17712, '127.0.0.1')`
- `SIGINT`/`SIGTERM` 清理

### 2.2 WebSocket 消息协议（关键，确定 JSON 形状）

每连接按序：TEXT(块头) → BINARY(音频字节)。

**Client → Server：**
```jsonc
{ "type": "start", "sessionId": "<uuid>", "sourceLang": "auto|zh|en|ja",
  "targetLang": "zh|en|ja", "audioFormat": "webm-opus", "sampleRate": 48000, "channels": 1 }

{ "type": "chunk", "chunkId": 1, "videoTimeAtStartSec": 12.34,
  "videoTimeAtEndSec": 24.56, "chunkDurationSec": 12.22 }
// 紧跟一个 BINARY 帧（webm/opus blob）
{ "type": "end", "sessionId": "<uuid>" }
{ "type": "ping" }
```

**Server → Client：**
```jsonc
{ "type": "ready" }
{ "type": "asr_result", "chunkId": 1, "sessionId": "<uuid>",
  "videoTimeAtStartSec": 12.34, "detectedLang": "zh",
  "cues": [ { "startSec": 0.52, "endSec": 2.31, "text": "大家好" } ] }   // 秒，相对块起点
{ "type": "translation", "chunkId": 1, "targetLang": "en",
  "texts": ["Hello everyone"] }   // texts[i] 与 asr_result.cues[i] 一一对应
{ "type": "error", "chunkId": 1, "stage": "ffmpeg|asr|translate", "message": "..." }
{ "type": "status", "message": "loading xenova nllb pipeline..." }
{ "type": "pong" }
```

### 2.3 `src/ws-handler.ts`
每连接持有 `{ sessionId, sourceLang, targetLang, audioFormat, sampleRate, chunkQueue: Map<chunkId, {videoTimeAtStartSec, cues?, translated?}> }`。
收到 `chunk` 文本帧 + 紧跟的二进制帧 → 把二进制写入 `data/<sid>-<cid>.webm` → 入队 `pipeline.runChunk()`（按 sessionId 串行化，单 ASR 并发，复刻参考项目 `scheduler.ts` 的 `ASR_LOCK` 模式）。完成后回送 `asr_result` 再 `translation`。

### 2.4 `src/pipeline.ts`（单块流水线）
1. `audioFormat === 'webm-opus'` → 调 `extractAudioTrack(webmPath, wavPath)`（**直接复用** `ffmpeg.ts`，它已是 `-i in -vn -acodec pcm_s16le -ar 16000 -ac 1 out`，对 webm 输入同样适用）
2. `audioFormat === 'pcm-s16le'` → 直接写 44 字节 WAV 头 + PCM（~15 行，免 ffmpeg）
3. `createAsrProvider()`（模块级单例缓存）→ `asr.transcribe(wavPath, { langHint })` → `AsrResult.segments`
4. segments → `{ startSec, endSec, text }[]`
5. 回送 `asr_result`（带 `videoTimeAtStartSec` 透传）
6. 若 `sourceLang !== targetLang`：`createTranslatorProvider()` → `tr.translate({sourceLang, targetLang, texts})` → 回送 `translation`
7. 清理临时 webm/wav/srt（沿用 `whispercpp.provider.ts` 350-358 行的 SRT 清理模式）

### 2.5 复用文件改动表

| 参考 → 新位置 | 改动 |
|---|---|
| `apps/web/src/server/asr/whispercpp.provider.ts` → `apps/server/src/asr/` | `getDefaultWhisperPaths` 从向上 4 层改为 3 层（`'..','..','..'`）；2 处错误提示 `@app/web` → `@app/server`。其余原样。 |
| `apps/web/src/server/asr/types.ts` → `apps/server/src/asr/` | 原样 |
| `apps/web/src/server/asr/index.ts` → `apps/server/src/asr/` | 裁剪：去掉 `openai-whisper` 分支。默认 `process.env.ASR_PROVIDER ?? 'whisper-cpp'`。 |
| `apps/web/src/server/translator/xenova-nllb.provider.ts` → `apps/server/src/translator/` | 更新 161-163 行错误提示路径字符串 `apps/web` → `apps/server`、`@app/web` → `@app/server`。其余原样。 |
| `apps/web/src/server/translator/{types,index}.ts` → `apps/server/src/translator/` | `index.ts` 裁剪：去掉 `deepl` 分支，留 `xenova-nllb`。`types.ts` 原样。 |
| `apps/web/src/server/ffmpeg.ts` → `apps/server/src/` | 原样（`extractAudioTrack`/`spawnBin`/`isFFmpegAvailable`/`probeVideo` 全留） |
| `apps/web/src/lib/subtitles/index.ts` → `apps/server/src/lib/subtitles/` | 原样（`parseSrt`） |
| `apps/web/src/lib/types.ts` → `apps/server/src/lib/` | 裁剪：只留 `LanguageCode`、`SubtitleCue`，删 session/job/upload 类型 |
| `apps/web/src/lib/{languages,time}.ts` → `apps/server/src/lib/` | 原样 |
| `apps/web/scripts/setup-offline.mjs` → `apps/server/scripts/` | 路径数学自动适配；打印提示 `@app/web` → `@app/server` |
| `packages/sharp-shim/*` → `packages/sharp-shim/` | 原样 |
| `tsconfig.base.json` | 去掉 `plugins:[{name:'next'}]`、`jsx:'preserve'`、`next-env.d.ts`；设 `module:'NodeNext'`,`moduleResolution:'NodeNext'`；保留 `paths:{'@/*':['./src/*']}`（让复用的 `@/lib/types` 导入路径不改） |
| `AGENTS.md`/`DESIGN.md`/`DESIGN-V1.md` | 原样复制到根 |
| `README.md` | **重写** |
| `.prettierrc` | 去掉 `prettier-plugin-tailwindcss` |

---

## 3. 扩展 `apps/extension`（MV3）

### 3.1 `manifest.json`
```jsonc
{
  "manifest_version": 3,
  "name": "网页实时双语字幕",
  "version": "0.1.0",
  "default_locale": "zh",
  "permissions": ["storage", "activeTab", "tabs", "alarms", "scripting"],
  "host_permissions": ["http://*/*", "https://*/*", "http://localhost:*/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "action": { "default_popup": "popup.html", "default_title": "字幕助手" },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["content.js"], "run_at": "document_idle", "all_frames": false }
  ]
}
```
不需要 `tabCapture`（用 `createMediaElementSource` 而非 `chrome.tabCapture`，免权限弹窗）。

### 3.2 `src/background.ts`（service worker）
- 安装/启动时：`chrome.alarms.create('ws-keepalive', { periodInMinutes: 0.45 })`（27 秒，< SW 30 秒 idle 上限）
- 收 content 的 `chrome.runtime.onMessage`：`chunk-meta`/`chunk-blob`/`start`/`end` → 转发到 WS（文本/二进制帧）
- 收 WS 消息：按 `type` 分派 → `chrome.tabs.sendMessage(tabId, ...)`（`Map<sessionId, tabId>` 跟踪）
- keep-alive：alarm 触发时若 WS 开则发 `{type:'ping'}`，若关则重连。alarm 回调算 SW 活动，重置 idle 计时
- 重连：指数退避 1→2→4→8→16s 上限

### 3.3 `src/audio-capture.ts`（最关键的扩展文件）
```ts
function attachToVideo(video, opts): Detacher {
  const ctx = new AudioContext({ sampleRate: 48000 });
  const src = ctx.createMediaElementSource(video);
  const dest = ctx.createMediaStreamDestination();
  src.connect(dest);              // 抓音频用
  src.connect(ctx.destination);   // 保持视频声音可听见（关键！否则视频会静音）

  const recorder = new MediaRecorder(dest.stream, {
    mimeType: pickMime(),         // 'audio/webm;codecs=opus' 优先
    audioBitsPerSecond: 64000,
  });
  let chunkStartVideoSec = video.currentTime;

  recorder.ondataavailable = async (e) => {
    if (e.data.size === 0) return;
    const chunkEndVideoSec = video.currentTime;
    const chunkId = ++counter;
    chrome.runtime.sendMessage({ kind: 'chunk-meta', chunkId, sessionId,
      videoTimeAtStartSec: chunkStartVideoSec, videoTimeAtEndSec: chunkEndVideoSec, ...opts });
    const buf = await e.data.arrayBuffer();
    chrome.runtime.sendMessage({ kind: 'chunk-blob', chunkId, buffer: buf });
    chunkStartVideoSec = chunkEndVideoSec;
  };

  // 手动分块：每 12 秒 requestData（精确控制 video 时间映射）
  const timer = setInterval(() => {
    if (recorder.state === 'recording' && !video.paused) recorder.requestData();
  }, 12000);
  recorder.start(0);  // 0 = 不自动切片，靠 requestData 驱动
  // video 'pause'/'play' 暂停/恢复 recorder
  // Detach: stop recorder, clearInterval, src.disconnect(), ctx.close()
}
```

**关键约束**：`createMediaElementSource` 一旦对一个 video 调用就**不可逆**（视频音频被永久路由到该 AudioContext）。关闭扩展后恢复原生声音需**刷新页面**。V1 接受此限制并在 popup 提示。Autoplay 策略：在 document 首次 `pointerdown`/`keydown` 后调 `ctx.resume()`。

### 3.4 `src/timeline.ts`
每 video 一条 `Timeline`，`cues: AbsoluteCue[]` 按 `startVideoSec` 保持有序。`insertChunkCues(chunkId, videoTimeAtStartSec, relCues)`：每个 cue 的 `startVideoSec = videoTimeAtStartSec + cue.startSec`。`activeCueAt(t)`：二分查找（复刻参考 `VideoPlayer.tsx` 105-124 行）。`setTranslation(chunkId, texts)` 按 chunkId 回填 `translated`。cue 可能乱序到达，`insertSorted` 保证有序。

### 3.5 `src/overlay.ts`
`div#rt-subtitle-overlay` 绝对定位覆盖视频（用 `getBoundingClientRect()`，监听 `resize`/`scroll`/`fullscreenchange` 重定位）。两行：原文在上、译文在下，半透明黑底，距底 8%。fullscreen 时把 overlay 挂到 `document.fullscreenElement` 子树。只有原文时显示原文一行，译文到了再重渲染双语。

### 3.6 `src/content.ts`
- `chrome.storage.local.get(['enabled','sourceLang','targetLang'])`，若 enabled 开始扫 `<video>`
- `MutationObserver(document.body, {subtree:true, childList:true})` 监听新 `<video>`；hook `history.pushState`/`replaceState`/`popstate` 应对 SPA 导航（YouTube）。`WeakSet<HTMLVideoElement>` 去重
- 每个 video：`attachToVideo` + 自己的 `Timeline`
- `chrome.runtime.onMessage`：`asr_result`/`translation` → push 进对应 session 的 timeline
- `video.timeupdate`：`timeline.activeCueAt(currentTime)` → `overlay.render`

### 3.7 `src/popup.ts` + `popup.html`
开关 `enabled`、`sourceLang`（auto/zh/en/ja）、`targetLang`（zh/en/ja）、后端状态点（绿连/红离，附 `pnpm --filter @app/server dev` 提示）。改设置写 `chrome.storage.local`，content 监听 `chrome.storage.onChanged` 启停捕获。

### 3.8 构建
`build.mjs`：esbuild 打包 `content.ts`/`background.ts`/`popup.ts` → `dist/*.js`；`fs.copyFile` 复制 `manifest.json` + `popup.html`。`dist/` 即加载为"已解压的扩展"。

---

## 4. 时间戳同步数据流（精确）

```
video.currentTime = T0，按播放、ctx resume、recorder.start
   │ 12s 后 setInterval 触发 → recorder.requestData()
   │ video.currentTime = T1 = T0 + ~12s
   ↓
ondataavailable:
   chunkEndVideoSec = T1, chunkStartVideoSec = T0
   ─ TEXT: {type:'chunk', chunkId, videoTimeAtStartSec:T0, videoTimeAtEndSec:T1} ──► background ──► WS ──► server
   ─ BINARY: <webm blob> ───────────────────────────────────────────────────────► server
   chunkStartVideoSec = T1
   ↓
server: webm → wav(ffmpeg) → whisper.cpp → segments(秒,相对块起点)
        回送 {type:'asr_result', chunkId, videoTimeAtStartSec:T0, cues:[{startSec,endSec,text}]}
   ↓
content: timeline.insertChunkCues(chunkId, T0, cues)
   每个 cue → { startVideoSec: T0 + cue.startSec, endVideoSec: T0 + cue.endSec, text }
   ↓
video.timeupdate: t = currentTime → activeCueAt(t) 二分 → overlay.render(text)
[异步稍后] server 翻译完成 → {type:'translation', chunkId, texts} → timeline.setTranslation → 重渲染双语
```

不变量：`videoTimeAtStartSec` 在 `requestData()` 调用时捕获（非 blob 到达时），精确反映块边界。服务器透传该值回 `asr_result`，content 无需维护 chunkId→videoTime 映射（无状态恢复）。

---

## 5. 复用的关键现有函数/路径

- [extractAudioTrack](file:///C:/Users/mengz/Desktop/Webpage%20Subtitles%20and%20Translation/apps/web/src/server/ffmpeg.ts#L210-L240) —— ffmpeg.ts，原样复用，对 webm 输入同样工作
- [WhisperCppProvider.transcribe](file:///C:/Users/mengz/Desktop/Webpage%20Subtitles%20and%20Translation/apps/web/src/server/asr/whispercpp.provider.ts#L160-L379) —— 只改路径深度
- [createTranslatorProvider](file:///C:/Users/mengz/Desktop/Webpage%20Subtitles%20and%20Translation/apps/web/src/server/translator/index.ts) —— 裁剪留 xenova-nllb
- [parseSrt](file:///C:/Users/mengz/Desktop/Webpage%20Subtitles%20and%20Translation/apps/web/src/lib/subtitles) —— 原样复用

---

## 6. 边界情况与对策

| 情况 | 对策 |
|---|---|
| video 出现晚（SPA 导航） | `MutationObserver` + `history` hook 重扫，`WeakSet` 去重 |
| 多个 `<video>` | 每 video 独立 sessionId + MediaRecorder + Timeline |
| seek 跳转 | 不重处理，timeline 查找新 currentTime（无 cue 则空白），新音频继续补 |
| 后端没开 | popup 红点；WS 退避重连 1→2→4→8→16s；content 丢块不入队 |
| MV3 SW 挂起（WS 断） | `chrome.alarms` 27s → ping + 必要时重连 |
| AudioContext autoplay 挂起 | document 首次 pointerdown/keydown + video 'play' 时 `ctx.resume()` |
| createMediaElementSource 不可逆 | popup 提示"关闭后需刷新页面恢复原生声音" |
| 超长视频内存涨 | timeline 上限 2000 cue FIFO |
| CPU 跟不上（队列>3） | server 发 status + 丢最老块 |
| 翻译滞后 ASR | 设计如此：先显原文，译文到了再补双语 |
| 全屏 | `fullscreenchange` 把 overlay 挂进 `document.fullscreenElement` 子树 |
| 跨域视频 | `createMediaElementSource` 不受 CORS 影响（走本地音频图） |

---

## 7. Git init

`.gitignore`（适配新结构）：`node_modules`、`dist`、`apps/extension/dist`、`apps/server/dist`、`.env*`、`apps/server/data/`、`apps/server/tools/whisper/`、`.cache/`、`*.log`、`*.tsbuildinfo`。

初始 commit（遵循 AGENTS.md `<type>(<scope>): <subject>` 格式）：
```
chore(repo): initialize real-time subtitle extension monorepo

Scaffold pnpm workspace with apps/server (Node http + ws backend
reusing whisper.cpp ASR + Xenova NLLB translator) and apps/extension
(MV3 Chrome/Edge extension with audio capture + overlay). Carry over
AGENTS.md, DESIGN.md, DESIGN-V1.md verbatim and rewrite README.md.
```

---

## 8. 实施顺序

1. `git init` + 根 `package.json`/`pnpm-workspace.yaml`/`tsconfig.base.json`/`.prettierrc`/`.gitignore`/`.env.example`
2. 复制 `packages/sharp-shim/*` 原样；复制 `AGENTS.md`/`DESIGN.md`/`DESIGN-V1.md` 原样
3. 建 `apps/server`：按第 2.5 节表复制复用文件；写 `index.ts`/`ws-handler.ts`/`pipeline.ts`；配 `package.json`/`tsconfig.json`/`setup-offline.mjs`
4. 烟测：`pnpm install` → `pnpm --filter @app/server setup:offline` → `pnpm --filter @app/server dev`，验证 `/health` + WS ping/pong
5. 建 `apps/extension`：`manifest.json`/`popup.html`/`build.mjs` + `src/{messages,settings,popup,background,timeline,overlay,audio-capture,content}.ts`
6. `pnpm --filter @app/extension build`，加载已解压扩展，验证 popup + WS 连接
7. 端到端：YouTube 短视频，按第 9 节验证
8. 修边界（SPA 导航、全屏、SW keep-alive）
9. 重写 `README.md`，commit `docs(readme): rewrite for extension + backend architecture`

---

## 9. 验证（端到端测试计划）

1. `curl http://localhost:17712/health` → JSON 含 `ok:true` + ffmpeg/whisperCli/whisperModel 路径
2. `wscat -c ws://localhost:17712/ws`，发 `{type:'ping'}` → 收 `{type:'pong'}`
3. `chrome://extensions` 加载扩展无报错；popup 绿点"backend: connected"
4. YouTube 1 分钟短视频，`source=auto, target=zh`，播放 → 15-20 秒内底部出现双语叠加，原文在上中文在下，大致同步
5. 点相关视频（SPA 导航，不刷新）→ 新 video 被发现，15 秒内字幕续上
6. 跳到 50% → 显示已有 cue（或空白），新位置继续捕获，无重复 cue
7. 关闭开关 → 捕获停、叠加消失；刷新页面恢复原生声音
8. 停后端、刷新页面 → popup 红点"backend offline"，content-script 控制台无 JS 报错
9. 视频静放 5 分钟无操作 → 字幕持续到达（`chrome.alarms` 保 SW 活），SW 状态"active"
10. Bilibili 同流程验证（不同播放器、不同 video 注入时机）
