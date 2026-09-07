# 网页视频字幕生成与翻译 App — V1 精简规格

> 版本：v1.0（MVP）  
> 日期：2026-09-02  
> 原则：**能跑通核心流程为第一优先级，其余延后**

---

## 1. V1 范围边界（Scope）

### ✅ In Scope（第一版必须实现）

1. **视频上传**：支持用户上传本地视频文件（MP4/WebM/MOV，≤ 500MB，≤ 30 分钟）
2. **字幕自动生成**：上传后自动识别语音生成带时间轴的字幕
   - 自动检测源语言（中 / 英 / 日）
   - 输出精确到毫秒的时间轴 + 原文
3. **字幕翻译**：用户可选择目标语言，一键翻译整份字幕
   - **目标语言仅 3 种**：英文 (en)、简体中文 (zh)、日语 (ja)
   - 可任意中↔英、中↔日、英↔日互译
4. **字幕在线编辑**：
   - 左侧视频播放 + 右侧字幕列表（双栏）
   - 点击字幕跳转视频对应时间
   - 修改字幕文字、开始/结束时间
   - 保存修改
5. **字幕导出**：SRT、WebVTT 两种格式（可导出原文或译文字幕）

### ❌ Out of Scope（V1 不做，V2+ 再考虑）

| 功能 | 延后理由 |
|------|---------|
| 用户注册/登录 | V1 单用户使用，无需鉴权；后续做多用户再加 |
| 项目列表/历史记录 | V1 每次上传即一次会话；如需保存手动导出 SRT |
| 说话人分离（Diarization） | 复杂度高、依赖 pyannote 模型 |
| 术语表 / 翻译风格选项 | 先用默认翻译 |
| 批量上传 / 断点续传 | V1 单文件单次上传（简单 multipart/form-data） |
| ASS/烧录字幕 | SRT + VTT 已覆盖 90% 使用场景 |
| 分享链接 / 协作 | 无用户系统无从谈起 |
| 付费套餐 / 用量统计 | V1 免费无限用（本地部署 / 私有 API Key） |
| Redis / BullMQ 任务队列 | V1 用内存 Map + 轮询或 WebSocket 推进度 |
| PostgreSQL | 用 SQLite 零运维，Prisma 无缝切换 |
| 对象存储 S3/MinIO | V1 本地文件系统存视频和字幕 |
| 容器化 / K8s 部署 | V1 直接 `pnpm build && pnpm start` 即可 |

---

## 2. V1 核心用户流程（Only One）

```
首页（单一入口）
  │
  ├─► 中心大区域：[拖拽视频到此处 或 点击选择文件]
  │     支持格式：MP4 / WebM / MOV  |  最大 500MB / 30 分钟
  │
  ▼ 上传完成（显示进度条）
  │ 自动跳转到「处理中」页面
  │
  ▼ 阶段1 ── ASR 识别
  │   显示动画 + 进度百分比（例如 识别 35%，预计剩余 42s）
  │   完成后自动进入下一阶段
  │
  ▼ 阶段2 ── 字幕生成完成，跳转到编辑器页面
  │   页面顶部 Banner：✅ 字幕已生成，请核对并编辑
  │                     右侧下拉 [▾ 翻译为 ▼ 英文 ▼ 日语] + [开始翻译] 按钮
  │
  ▼ 用户操作（可反复）：
  │    ├─ 编辑字幕文字 / 时间 → 自动保存
  │    └─ 点击 [开始翻译] → 选择目标语言（英/日/中三选一或多选）
  │         翻译中...（进度条）
  │         翻译完成 → 字幕区切换为「原文 ↔ 译文」双语并排
  │         用户可手动校对修改译文
  │
  ▼ 点击 [导出 ▾]
       ├─ 导出原文 SRT
       ├─ 导出原文 VTT
       ├─ 导出译文 SRT（对应选中语言）
       └─ 导出译文 VTT
```

---

## 3. V1 技术架构（极简版）

```
┌──────────────────────────────────────────────────────────┐
│                    单一 Next.js 15 App                   │
│  （前端页面 + API Routes + 后台任务 全部在一个进程内）    │
│                                                          │
│  ┌───────────────────┐   ┌───────────────────────────┐   │
│  │  Pages (App Rou.) │   │   API Routes (/api/*)     │   │
│  │  /                │   │   POST  /upload           │   │
│  │  /editor/[id]     │   │   GET   /jobs/:id         │   │
│  │                   │   │   GET   /subtitles/:id    │   │
│  │                   │   │   PUT   /subtitles/:id    │   │
│  │                   │   │   POST  /translate        │   │
│  │                   │   │   GET   /export/:id/:fmt  │   │
│  └─────────┬─────────┘   └────────────┬──────────────┘   │
│            │                          │                   │
│            └────────────┬─────────────┘                   │
│                         │                                 │
│         ┌───────────────┼───────────────┐                 │
│         ▼               ▼               ▼                 │
│  ┌─────────────┐  ┌───────────┐  ┌──────────────┐        │
│  │ SQLite(本地)│  │ 本地文件   │  │ 内存任务调度 │        │
│  │  Prisma ORM │  │ ./data/   │  │ (进程内 Map) │        │
│  └─────────────┘  └───────────┘  └──────┬───────┘        │
│                                         │                │
│                          ┌──────────────┴──────────┐     │
│                          ▼                         ▼     │
│                   ┌──────────────┐          ┌──────────┐ │
│                   │ ASR 适配器   │          │ 翻译适配器│ │
│                   │ Whisper API  │          │ DeepL/LLM │ │
│                   └──────────────┘          └──────────┘ │
└──────────────────────────────────────────────────────────┘
```

### 技术栈清单（V1）

| 层级 | 选型 | 备注 |
|-----|------|------|
| **全栈框架** | Next.js 15（App Router） | 单进程部署，前端 + 后端 API 一体 |
| **语言** | TypeScript 5.6 | 全程类型安全 |
| **UI 组件** | shadcn/ui + Tailwind CSS 4 | 轻量、定制化好 |
| **视频播放** | Plyr（React 封装） | 轻量播放器，支持字幕轨道 |
| **状态管理** | React Query + 少量 Zustand | 服务端状态走 RQ，编辑器本地状态走 Zustand |
| **数据库** | SQLite + Prisma 6 | 单文件 `./data/app.db`，零运维 |
| **文件存储** | 本地文件系统 `./data/uploads/` | V1 无分布式需求 |
| **ASR 方案（二选一，推荐前者）** | **A) OpenAI Whisper API** | 直接联网调 `v1/audio/transcriptions`，返回 `verbose_json` 拿到词级时间戳 |
| | B) 本地 faster-whisper (Python) | 用户机器有 GPU 可选，通过 child_process spawn 调用 |
| **翻译方案（二选一，推荐前者）** | **A) DeepL API Free** | 每月免费 50 万字符，中/英/日支持极好 |
| | B) Google Translation API | 备用方案，DeepL 不覆盖时用 |
| **任务进度通知** | **轮询**（每 2s GET /api/jobs/:id） | V1 不上 WebSocket，避免 Socket.io 复杂度 |
| **任务异步** | Node.js 原生 worker_threads + 内存状态 Map | 或简单 `async` 后台执行 + 状态写 DB |
| **构建/包管理** | pnpm 9 | workspace（虽然 V1 单包，但为 V2 拆包预留） |

---

## 4. 目录结构（V1）

```
Webpage Subtitles and Translation/
├── data/                        # 本地数据（Git 忽略）
│   ├── app.db                   # SQLite 数据库文件
│   └── uploads/
│       └── {sessionId}/
│           ├── video.mp4        # 原始上传视频
│           └── audio.wav        # 提取后的音轨
│
├── prisma/
│   └── schema.prisma            # 数据模型（见第 5 节）
│
├── src/
│   ├── app/                     # App Router 页面
│   │   ├── layout.tsx           # 全局布局
│   │   ├── page.tsx             # 首页（上传页）
│   │   └── editor/
│   │       └── [sessionId]/
│   │           ├── page.tsx     # 编辑器页（编辑+翻译+导出）
│   │           └── loading.tsx  # 处理中状态
│   │
│   ├── components/              # UI 组件
│   │   ├── ui/                  # shadcn/ui 生成的组件
│   │   │   ├── button.tsx
│   │   │   ├── progress.tsx
│   │   │   ├── select.tsx
│   │   │   ├── input.tsx
│   │   │   └── ...
│   │   ├── upload/
│   │   │   └── VideoUploader.tsx   # 拖拽上传组件
│   │   ├── player/
│   │   │   └── VideoPlayer.tsx     # Plyr 封装的播放器
│   │   └── editor/
│   │       ├── SubtitleList.tsx    # 字幕列表（点击跳转 + 行内编辑）
│   │       ├── SubtitleRow.tsx     # 单条字幕
│   │       ├── TranslatePanel.tsx  # 翻译选择面板
│   │       └── ExportMenu.tsx      # 导出下拉菜单
│   │
│   ├── app/api/                 # API Routes（后端接口）
│   │   ├── upload/
│   │   │   └── route.ts         # POST  视频上传
│   │   ├── jobs/
│   │   │   └── [id]/
│   │   │       └── route.ts     # GET   任务进度
│   │   ├── subtitles/
│   │   │   └── [sessionId]/
│   │   │       └── route.ts     # GET   获取字幕 + PUT 保存字幕
│   │   ├── translate/
│   │   │   └── route.ts         # POST  发起翻译
│   │   └── export/
│   │       └── [sessionId]/
│   │           └── [format]/
│   │               └── route.ts # GET   下载 SRT/VTT
│   │
│   ├── server/                  # 仅服务端代码（App Router "use server" 或被 API 调用）
│   │   ├── db/
│   │   │   └── prisma.ts        # Prisma client 单例
│   │   ├── jobs/
│   │   │   ├── scheduler.ts     # 内存任务调度器（异步执行 ASR/翻译）
│   │   │   ├── types.ts
│   │   │   └── runner.ts
│   │   ├── asr/
│   │   │   ├── asr.provider.ts  # 接口定义
│   │   │   ├── openai-whisper.provider.ts  # 方案 A：API
│   │   │   └── local-whisper.provider.ts   # 方案 B：本地（可选）
│   │   ├── translator/
│   │   │   ├── translator.provider.ts
│   │   │   ├── deepl.provider.ts
│   │   │   └── google.provider.ts
│   │   └── storage/
│   │       └── local.storage.ts  # 本地文件读写
│   │
│   ├── lib/                     # 前后端通用工具
│   │   ├── subtitles/
│   │   │   ├── srt.ts           # SRT 解析/序列化
│   │   │   └── vtt.ts           # VTT 解析/序列化
│   │   ├── time.ts              # 时间格式化（ms → 00:00:00,000）
│   │   ├── languages.ts         # 3 种语言枚举 + label
│   │   └── types.ts             # 全局共享类型
│   │
│   └── styles/
│       └── globals.css
│
├── .env.example                 # 环境变量模板（API Key 等）
├── .env.local                   # 本地配置（Git 忽略）
├── prisma/schema.prisma
├── next.config.mjs
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.mjs
├── pnpm-workspace.yaml          # 预留 V2 拆包
└── package.json
```

---

## 5. 数据模型（V1 Prisma Schema）

V1 极简，只需 3 张表：

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = "file:./data/app.db"
}

// 一次视频处理会话（V1 无用户，单 session 对应单视频）
model Session {
  id           String    @id @default(cuid())  // sess_xxx，用于 URL
  videoName    String                        // 原始文件名 my_video.mp4
  videoPath    String                        // ./data/uploads/{id}/video.mp4
  audioPath    String?                       // 提取后的音频路径
  videoSizeBytes BigInt
  durationSec  Int?                          // 预处理后得到时长
  sourceLang   String?                       // zh / en / ja，ASR 完成后填充
  status       SessionStatus @default(UPLOADING)
  // UPLOADING → PREPROCESSING → ASR_IN_PROGRESS → READY → TRANSLATING → DONE → ERROR
  errorMessage String?
  createdAt    DateTime    @default(now())

  subtitles    Subtitle[]
  jobs         Job[]
}

enum SessionStatus {
  UPLOADING
  PREPROCESSING
  ASR_IN_PROGRESS
  READY          // ASR 完成，可以编辑
  TRANSLATING    // 翻译中
  DONE           // 翻译完成（也可以不翻译就导出）
  ERROR
}

// 字幕内容（按会话 + 语言唯一）
model Subtitle {
  id          String   @id @default(cuid())
  sessionId   String
  session     Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  language    String   // "zh" | "en" | "ja"
  isSource    Boolean  // 是否为 ASR 生成的原文
  cues        Json     // [{index, startMs, endMs, text}] — 整存整取，V1 不需要按 cue 查询
  version     Int      @default(1)  // 用户编辑保存后自增
  updatedAt   DateTime @updatedAt

  @@unique([sessionId, language])
}

// ASR / 翻译任务（供轮询进度用）
model Job {
  id          String   @id @default(cuid())
  sessionId   String
  session     Session  @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  type        JobType  // ASR | TRANSLATE
  targetLang  String?  // TRANSLATE 时用
  status      JobStatus @default(PENDING)
  progress    Int      @default(0)  // 0-100
  stage       String?  // "正在上传音频..." / "识别 42%" / "翻译第 12/50 批"
  startedAt   DateTime?
  finishedAt  DateTime?
  errorLog    String?
  createdAt   DateTime @default(now())
}

enum JobType { ASR TRANSLATE }
enum JobStatus { PENDING RUNNING SUCCESS FAILED }
```

---

## 6. API 接口（V1）

### 6.1 上传视频
```
POST /api/upload
Content-Type: multipart/form-data
Body: { "file": <binary>, "filename": "my_video.mp4" }

响应 202 Accepted:
{
  "sessionId": "sess_abc123",
  "jobId": "job_asr_xyz",       // ASR 任务 ID，前端立即轮询
  "redirectTo": "/editor/sess_abc123"
}
```
**服务端处理**：保存文件 → 创建 session + ASR job → 返回 → 后台异步开始预处理+ASR。

### 6.2 查询任务进度
```
GET /api/jobs/:jobId

响应 200:
{
  "jobId": "job_asr_xyz",
  "type": "ASR",
  "status": "RUNNING",
  "progress": 42,
  "stage": "正在识别语音... (42%)",
  "sessionStatus": "ASR_IN_PROGRESS"
}
```
> 前端每 2 秒轮询一次。`status=SUCCESS` 时停止轮询并刷新字幕。

### 6.3 获取字幕
```
GET /api/subtitles/:sessionId
Query: ?lang=zh  (可选，不传返回所有语言)

响应 200:
{
  "session": { id, name, status, sourceLang, durationSec },
  "subtitles": [
    {
      "language": "zh",
      "isSource": true,
      "version": 1,
      "cues": [
        { "index": 1, "startMs": 2000, "endMs": 5200, "text": "大家好" },
        ...
      ]
    },
    {
      "language": "en",
      "isSource": false,
      "version": 1,
      "cues": [...]
    }
  ]
}
```

### 6.4 保存字幕编辑
```
PUT /api/subtitles/:sessionId
Content-Type: application/json
Body:
{
  "language": "zh",
  "cues": [...]   // 用户修改后的全量 cues
}

响应 200: { "saved": true, "newVersion": 2 }
```

### 6.5 发起翻译
```
POST /api/translate
Content-Type: application/json
Body:
{
  "sessionId": "sess_abc123",
  "sourceLang": "zh",
  "targetLangs": ["en", "ja"]   // V1 三种内任选多选
}

响应 202:
{
  "jobs": [
    { "jobId": "job_trans_en", "targetLang": "en", "status": "RUNNING" },
    { "jobId": "job_trans_ja", "targetLang": "ja", "status": "RUNNING" }
  ]
}
```

### 6.6 导出下载
```
GET /api/export/:sessionId/:format?lang=en
Params:
  :format = srt | vtt
  ?lang   = zh | en | ja   （不传默认导出源语言）

响应：Content-Disposition attachment，文件流
例：Content-Type: application/x-subrip
    Content-Disposition: attachment; filename="sess_abc123.en.srt"
```

---

## 7. 页面设计（V1）

### 7.1 首页 `/` — 上传页

```
┌────────────────────────────────────────────────────────────┐
│ Header:    🎬 网页字幕助手 V1    [GitHub]                   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│                        Hero 区域                           │
│          上传视频，一键生成字幕并翻译成中/英/日              │
│                                                            │
│    ┌──────────────────────────────────────────────────┐    │
│    │                                                  │    │
│    │            ⬆  拖拽视频文件到此处                  │    │
│    │                                                  │    │
│    │           或 [点击选择文件] 按钮                  │    │
│    │                                                  │    │
│    │    支持 MP4 / WebM / MOV  最大 500MB / 30 分钟    │    │
│    └──────────────────────────────────────────────────┘    │
│                                                            │
│    处理流程提示：                                           │
│    ① 上传 → ② AI 识别字幕 → ③ 在线编辑 → ④ 翻译 → ⑤ 导出  │
│                                                            │
│ Footer:  © 2026  使用 Whisper + DeepL 提供技术支持          │
└────────────────────────────────────────────────────────────┘
```

### 7.2 编辑器 `/editor/[sessionId]`

```
┌──────────────────────────────────────────────────────────────────────┐
│  [← 返回首页]  my_video.mp4   状态：✅ 可编辑   源语言：中文         │
│                        [翻译为 ▾ 英文  日文] [🔄 开始翻译]  [导出 ▾] │
├─────────────────────────────────────────────┬────────────────────────┤
│                                             │ 🔍 搜索字幕            │
│                                             ├────────────────────────┤
│                                             │ # │  时 间  │ 文本      │
│          视频播放器 (Plyr)                  │───┼─────────┼──────── │
│   ┌─────────────────────────────────┐       │ 1 │ 00:00:02│ 大家好   │
│   │                                 │       │ 2 │ 00:00:05│ 欢迎…    │
│   │   视频画面 + 渲染字幕            │       │ 3 │ 00:00:08│ 今天…    │
│   │                                 │       │                          │
│   └─────────────────────────────────┘       │ 点击行可跳转到视频位置  │
│   ⏮  ◀◀  ▶  ▶▶  ⏭    00:00:15/00:05:30    │ 双击行可编辑文本/时间   │
│   ████████████████░░░  1.0x 🔊   CC:中     │                          │
│                                             │ (编辑后自动保存 ✓)      │
│                                             │                          │
│   如有翻译结果 → 切换 Tab：[原文 ▾] [译文] │ 已翻译时切换显示双语列    │
└─────────────────────────────────────────────┴────────────────────────┘
```

---

## 8. ASR 与翻译适配层（可切换）

### 8.1 ASR 接口定义（`src/server/asr/asr.provider.ts`）

```ts
export interface AsrWord {
  word: string;
  start: number; // 秒（浮点）
  end: number;
}

export interface AsrSegment {
  start: number;
  end: number;
  text: string;
  words?: AsrWord[];
}

export interface AsrResult {
  language: string;       // "zh" | "en" | "ja"
  duration: number;       // 秒
  segments: AsrSegment[]; // 直接转为 Subtitle.cues
}

export interface AsrProvider {
  name: string;
  transcribe(audioPath: string, onProgress?: (pct: number) => void): Promise<AsrResult>;
}
```

**OpenAI Whisper API 实现要点**：
```
POST https://api.openai.com/v1/audio/transcriptions
Content-Type: multipart/form-data
  file: @audio.wav
  model: whisper-1
  response_format: verbose_json
  temperature: 0
  timestamp_granularities[]: word
  timestamp_granularities[]: segment

返回 JSON 中 .segments[].start/end/text 直接用，.language 做源语言检测
将秒×1000 → 毫秒存入 cues[].startMs/endMs
```

### 8.2 翻译接口定义（`src/server/translator/translator.provider.ts`）

```ts
export interface TranslateBatchInput {
  sourceLang: 'zh' | 'en' | 'ja';
  targetLang: 'zh' | 'en' | 'ja';
  texts: string[];  // 字幕 text 数组（最多 50 条一批）
}

export interface TranslatorProvider {
  name: string;
  translate(input: TranslateBatchInput): Promise<string[]>;
}
```

**DeepL 实现要点**：
```
POST https://api-free.deepl.com/v2/translate
Authorization: DeepL-Auth-Key <YOUR_KEY>
Body (form):
  text=...&text=...
  source_lang=ZH
  target_lang=EN  (注意 DeepL 目标语 EN-US / JA / ZH 需映射)
返回 translations[].text 数组（顺序对应）
```
批量限制：每次最多 50 条，超过自动分批。

---

## 9. 环境变量（`.env.example`）

```env
# ===== ASR 配置（二选一） =====
# 方案 A：OpenAI Whisper API（推荐，无需 GPU）
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxx
ASR_PROVIDER=openai-whisper

# 方案 B：本地 faster-whisper（需 Python 环境 + GPU/CPU）
# ASR_PROVIDER=local-whisper
# WHISPER_MODEL_SIZE=medium   # tiny / base / small / medium / large-v3

# ===== 翻译配置（二选一） =====
# 方案 A：DeepL Free（每月免费 50 万字符）
DEEPL_API_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx
TRANSLATOR_PROVIDER=deepl

# 方案 B：Google Cloud Translation
# GOOGLE_APPLICATION_CREDENTIALS=./gcp-key.json
# TRANSLATOR_PROVIDER=google

# ===== 本地存储 =====
UPLOAD_DIR=./data/uploads
MAX_UPLOAD_BYTES=524288000   # 500 MB
MAX_DURATION_SEC=1800        # 30 分钟

# ===== 其他 =====
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

---

## 10. V1 开发步骤（分步执行清单）

| 步骤 | 工时 | 交付物 |
|------|------|--------|
| **Step 1 脚手架** | 0.5 天 | `pnpm create next-app@latest` + TS/TSLint/Tailwind + Prisma + SQLite + shadcn/ui 初始化 |
| **Step 2 数据层** | 0.5 天 | Prisma schema 写好 → `prisma migrate dev` → 生成 PrismaClient → 封装 server/db/prisma.ts |
| **Step 3 上传接口** | 1 天 | 首页 VideoUploader 组件 + `/api/upload`（存文件+写 session+job+触发后台 ASR 调度器） |
| **Step 4 视频预处理** | 0.5 天 | 用 ffmpeg 提取音轨（`ffmpeg -i video.mp4 -vn -acodec pcm_s16le -ar 16000 -ac 1 audio.wav`）；获取时长 |
| **Step 5 ASR 适配层** | 1 天 | 实现 OpenAI Whisper provider，跑通 2 分钟音频 → cues JSON；进度回调写 Job |
| **Step 6 任务进度轮询** | 0.5 天 | `/api/jobs/:id` 接口 + 前端 loading 页面 2s 轮询 + 完成后跳编辑器 |
| **Step 7 字幕编辑器 UI** | 2 天 | `/editor/[sessionId]` 布局 + VideoPlayer (Plyr) + SubtitleList (虚拟滚动如用不到可跳过 V1) + 行内编辑 + 自动保存 PUT |
| **Step 8 翻译功能** | 1 天 | 实现 DeepL provider + `/api/translate` 接口 + 翻译面板 UI（下拉选目标语）+ 轮询翻译 job |
| **Step 9 导出 SRT/VTT** | 0.5 天 | SRT/VTT 序列化工具 + `/api/export/:sessionId/:format` 流式下载 |
| **Step 10 联调 & 修复** | 1 天 | 全流程自测：上传 5 分钟 → ASR → 编辑 → 翻译 → 导出；典型错误处理（上传失败、ASR 超时报错提示） |
| **合计** | **~9 天** | 全流程可跑通的 V1 MVP |

---

## 11. 验收标准（V1 Definition of Done）

- [ ] 首页成功拖拽上传 300MB MP4 文件，进度条正常
- [ ] 2 分钟中文视频 → 1 分钟内返回中文字幕，时间轴可对齐语音
- [ ] 编辑器点击任一字幕 → 视频跳转到相应时间点播放
- [ ] 修改字幕文字和时间 → 刷新页面后修改仍保留
- [ ] 中文字幕 → 翻译英文和日文，结果返回时间在 30 秒内（≤ 300 条字幕）
- [ ] 导出的 SRT 文件可用 VLC 正常加载，时间和文字与编辑器一致
- [ ] 上传失败 / ASR 失败 / 翻译失败有明确用户提示（非 500 白屏）

---

> **下一步**：按 Step 1 开始创建项目脚手架并提交 Git。
