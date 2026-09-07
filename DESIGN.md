# 网页视频字幕生成与翻译 App — 详细设计文档

> 版本：v1.0  
> 日期：2026-09-02  
> 状态：设计阶段

---

## 目录

1. [项目概述](#1-项目概述)
2. [产品需求分析](#2-产品需求分析)
3. [技术架构设计](#3-技术架构设计)
4. [前端详细设计](#4-前端详细设计)
5. [后端详细设计](#5-后端详细设计)
6. [ASR 语音识别模块](#6-asr-语音识别模块)
7. [翻译引擎模块](#7-翻译引擎模块)
8. [数据库设计](#8-数据库设计)
9. [API 接口设计](#9-api-接口设计)
10. [UI/UX 设计规范](#10-uiux-设计规范)
11. [安全设计](#11-安全设计)
12. [部署与运维](#12-部署与运维)
13. [开发路线图](#13-开发路线图)
14. [风险评估与应对](#14-风险评估与应对)

---

## 1. 项目概述

### 1.1 项目背景

随着在线教育、跨境内容创作、自媒体行业的蓬勃发展，视频创作者和学习者经常面临以下痛点：

- **无字幕视频难以理解**：大量优质外语视频没有字幕，听力薄弱的用户难以学习
- **手动打字幕效率低下**：传统人工打字幕耗时耗力，10分钟视频可能需要1-2小时
- **翻译字幕成本高昂**：专业字幕翻译服务价格贵、周期长
- **多平台字幕格式不兼容**：YouTube、Bilibili、抖音、本地播放器各有不同字幕格式

### 1.2 项目目标

构建一款 **基于 Web 的一站式视频字幕生成与翻译平台**，实现：

| 目标维度 | 具体指标 |
|---------|---------|
| 字幕生成速度 | 10分钟视频 ≤ 2分钟出稿 |
| 识别准确率 | 中文 ≥ 95%，英文 ≥ 92% |
| 翻译准确率 | 常用语种 ≥ 90%（BLEU 评分） |
| 支持视频格式 | MP4、WebM、MOV、AVI、MKV、FLV |
| 支持语种 | 源语言 10+，目标语言 50+ |
| 字幕导出格式 | SRT、VTT、ASS、TXT、JSON |
| 最大视频大小 | 单文件 ≤ 2GB |

### 1.3 目标用户

| 用户角色 | 典型场景 |
|---------|---------|
| 在线学习者 | 观看海外课程/TED演讲，需要双语字幕 |
| 自媒体创作者 | 为自己的视频快速生成字幕并翻译到多语种 |
| 翻译从业者 | 使用AI初译 + 人工精校模式提高效率 |
| 企业培训部门 | 将内部培训视频本地化，生成多语言字幕 |
| 字幕组/影视后期 | 批量处理剧集字幕，缩短交付周期 |

### 1.4 项目边界

**包含（In Scope）**：
- 视频上传与在线预览
- AI 自动语音识别生成原始字幕
- 字幕时间轴自动对齐与分句
- AI 多语种字幕翻译
- 在线字幕编辑器（增删改、时间轴调整、翻译校对）
- 字幕多格式导出
- 项目管理与历史记录

**不包含（Out of Scope）**：
- 视频剪辑/合成功能
- 语音合成（TTS）配音功能
- 直播实时字幕（V2 版本规划）
- 移动端 Native App（优先 Web 响应式）

---

## 2. 产品需求分析

### 2.1 核心功能需求（Functional Requirements）

#### FR-01 视频上传与管理
- 用户可通过拖拽、点击选择、粘贴 URL 三种方式上传视频
- 支持断点续传（大文件分片上传）
- 上传过程显示进度条、剩余时间、网速
- 支持批量上传（最多 5 个并行）
- 自动提取视频元信息：时长、分辨率、帧率、编码格式、音频采样率

#### FR-02 字幕自动生成（ASR）
- 上传完成后自动进入识别队列
- 支持手动选择源语言或自动检测语言
- 支持区分说话人（Speaker Diarization），最多识别 10 个说话人
- 自动分句、添加标点符号
- 自动生成时间轴（精确到 10ms 级别）
- 识别过程可查看实时进度（百分比 + 当前识别时间点）
- 提供专业词汇表上传（术语表功能，提升专业内容识别准确率）

#### FR-03 字幕在线编辑
- 左侧视频预览 + 右侧字幕列表的双栏布局
- 点击任一字幕跳转到对应视频时间点播放
- 支持单独编辑字幕文本、开始时间、结束时间
- 支持拖拽调整字幕时间轴长度
- 支持合并相邻字幕、拆分当前字幕
- 支持批量删除、批量调整时间偏移
- 支持说话人标签编辑（颜色区分不同说话人）
- 支持快捷键操作（保存、播放/暂停、跳转上一条/下一条等）
- 编辑器自动保存（每 30s 或每次修改后）

#### FR-04 字幕翻译
- 支持选择目标语言（可多选，一次生成多语种字幕）
- 支持翻译上下文感知（利用前 3-5 句字幕作为上下文提升翻译质量）
- 保留原字幕格式（换行、说话人标记等）
- 翻译结果可逐句校对和修改
- 支持术语翻译表（强制术语翻译一致性）
- 支持「仅翻译未翻译部分」增量翻译
- 翻译进度实时显示

#### FR-05 字幕导出
- 支持单语言导出、多语言并排导出（双语字幕）
- 导出格式：
  - **SRT**：最通用格式，兼容绝大多数播放器
  - **WebVTT (.vtt)**：HTML5 `<track>` 标准格式
  - **ASS/SSA**：支持样式的高级字幕格式（可配置字体、颜色、位置）
  - **TXT**：纯文本剧本格式
  - **JSON**：结构化数据，方便二次开发
  - **SRT + 翻译**：时间轴对齐的双语对照 SRT
- 支持直接嵌入字幕到视频（硬字幕烧录，可选）
- 导出视频平台适配模板：YouTube、Bilibili、抖音/西瓜视频、Netflix

#### FR-06 项目与用户管理
- 项目列表页：按创建时间、处理状态、视频名称筛选搜索
- 项目状态标签：上传中 / 排队中 / 识别中 / 识别完成 / 翻译中 / 已完成 / 失败
- 用户个人中心：API Key 管理、用量统计、计费信息
- 项目分享：生成只读链接，供协作者查看/编辑（可设置密码和过期时间）

### 2.2 非功能需求（Non-Functional Requirements）

#### NFR-01 性能
- 首屏加载时间 ≤ 2s（CDN 加速）
- 字幕编辑器交互响应 ≤ 100ms
- 视频播放启动时间 ≤ 500ms
- API P95 响应时间 ≤ 500ms（不含长时任务）

#### NFR-02 可扩展性
- 支持水平扩展，日均处理 10,000+ 视频
- ASR 和翻译任务使用消息队列解耦，支持动态扩缩容 Worker
- 前端使用微前端架构，支持独立迭代编辑器、播放器等子模块

#### NFR-03 可靠性
- 系统可用性 ≥ 99.9%（月度）
- ASR/翻译任务失败自动重试 3 次
- 数据多副本存储，定期备份（每日增量 + 每周全量）

#### NFR-04 兼容性
- 浏览器：Chrome/Edge（最新版 -2）、Firefox（最新版 -2）、Safari（最新版 -1）
- 操作系统：Windows、macOS、Linux、iPadOS（响应式适配）
- 屏幕分辨率：1280×720 及以上（最低支持），1920×1080（推荐）

#### NFR-05 隐私与合规
- 遵守 GDPR、《个人信息保护法》
- 用户视频和字幕数据默认私有，仅本人可见
- 提供「处理完成后自动删除源视频」选项
- 数据传输全程 HTTPS/TLS 1.3
- 支持用户数据导出与删除（被遗忘权）

---

## 3. 技术架构设计

### 3.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                              客户端层                                │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐ │
│  │  Web 浏览器  │  │  iPad PWA   │  │  小程序端    │  │  API 用户  │ │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  └─────┬──────┘ │
└─────────┼────────────────┼────────────────┼────────────────┼────────┘
          │                │                │                │
          └────────────────┴────────────────┴────────────────┘
                            │ HTTPS / WSS
┌───────────────────────────┼─────────────────────────────────────────┐
│                    网关层 (API Gateway)                              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Nginx / Cloudflare  ──►  限流 + WAF + 负载均衡 + TLS 终止    │   │
│  └──────────────────────────────────────────────────────────────┘   │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
┌───────────────────────────┴─────────────────────────────────────────┐
│                        应用服务层                                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │   Web 服务   │  │  用户服务    │  │  项目/字幕/文件管理服务    │  │
│  │  (Next.js)   │  │  (Node.js)  │  │      (Node.js)            │  │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬──────────────┘  │
│         │                 │                      │                  │
│  ┌──────┴───────┐  ┌──────┴───────┐  ┌───────────┴──────────────┐  │
│  │  认证授权服务 │  │ 通知服务     │  │   实时协作服务 (WebSocket)│  │
│  │ (Auth/JWT)   │  │(邮件/Webhook)│  │      (Socket.io)         │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────────────┐
│                     消息队列与任务调度层                              │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │              BullMQ / Redis (任务队列 + 延迟队列)              │   │
│  │   upload → preprocess → asr_queue → translate → postprocess   │   │
│  └──────────────────────────────────────────────────────────────┘   │
└───────────────────────────┬─────────────────────────────────────────┘
                            │
┌───────────────────────────┴─────────────────────────────────────────┐
│                     AI 与计算服务层 (Worker)                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │  视频预处理 Worker│  │  ASR Worker 集群  │  │  翻译 Worker 集群 │  │
│  │  (抽音/转码/切片) │  │ (Whisper / 其他)  │  │(DeepL/Google/LLM)│  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
└───────────┼──────────────────────┼──────────────────────┼────────────┘
            │                      │                      │
┌───────────┴──────────────────────┴──────────────────────┴────────────┐
│                          数据存储层                                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐ │
│  │ PostgreSQL │  │   Redis    │  │ 对象存储   │  │  Elasticsearch │ │
│  │ (主数据库)  │  │ (缓存/会话)│  │ (S3/MinIO) │  │  (字幕搜索)    │ │
│  └────────────┘  └────────────┘  └────────────┘  └────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.2 技术选型总览

| 层级 | 技术栈 | 选型理由 |
|-----|--------|---------|
| **前端框架** | Next.js 15 (App Router) + React 19 | SSR/SSG 混合渲染、生态成熟、内置 Image/Font 优化 |
| **UI 组件库** | shadcn/ui + Tailwind CSS 4 | 高度可定制、轻量、设计一致性好 |
| **状态管理** | Zustand + React Query (TanStack Query) | Zustand 轻量本地状态，RQ 处理服务端状态缓存 |
| **视频播放** | Video.js / Plyr + Mux.js | 支持多格式、支持自定义控件、字幕轨道切换 |
| **字幕编辑器** | 自研（React + 虚拟列表） | 满足千条级字幕高性能渲染 |
| **后端运行时** | Node.js 22 (LTS) + TypeScript 5.6 | 与前端共享类型、非阻塞 I/O 适合 IO 密集型任务 |
| **API 框架** | Hono / Fastify | 高性能、类型安全、Edge-ready |
| **数据库 ORM** | Prisma 6 | 类型安全、迁移管理方便、多数据库支持 |
| **任务队列** | BullMQ 5 + Redis 7 | 支持延迟、重试、优先级、并发控制，UI 友好 |
| **对象存储** | MinIO (自建) / AWS S3 / 阿里云 OSS | S3 兼容协议，视频和字幕文件存储 |
| **实时通信** | Socket.io 4 | 编辑器自动保存、任务进度推送、多人协作 |
| **ASR 引擎** | OpenAI Whisper Large v3 (自托管) + 备选云API | 开源可自托管、多语言支持好、准确率高 |
| **翻译引擎** | 多适配器：DeepL API / Google Translate / 自研 LLM | 按质量和成本路由，支持降级 |
| **容器化** | Docker + Docker Compose (开发) / Kubernetes (生产) | 环境一致性、弹性扩缩容 |
| **CI/CD** | GitHub Actions | 自动化测试、构建、部署 |
| **监控告警** | Prometheus + Grafana + Sentry | 指标、日志、异常全链路可观测 |

### 3.3 关键技术决策说明

#### 决策 1：ASR 引擎选型 — 自托管 Whisper vs 云 API

| 方案 | 优点 | 缺点 |
|-----|------|------|
| **自托管 Whisper Large v3** | 数据不出域、隐私好、无限量、边际成本低 | 初始 GPU 投入高、运维复杂、冷启动慢 |
| **云 API（讯飞/阿里云/Google Speech）** | 即用即付、运维简单、延迟低 | 按时长计费（约 0.01-0.02 元/秒）、数据出域 |
| **混合方案（推荐）** | 自托管处理日常流量，峰值溢出到云 API | 架构稍复杂 |

**推荐：混合方案**。日常 80% 流量走自托管 Whisper GPU Worker，高峰期或 GPU 队列积压超过 5 分钟时自动路由到云 API。

#### 决策 2：翻译引擎 — LLM 翻译 vs 传统 NMT

| 方案 | 适用场景 | 成本/字符 |
|-----|---------|----------|
| DeepL API | 高质量翻译，欧洲语言首选 | ~$25 / 1M 字符 |
| Google Translation API | 语种覆盖最全（130+） | ~$20 / 1M 字符 |
| 本地 LLM（Qwen2.5-7B-Instruct） | 数据敏感场景、术语一致性 | 仅 GPU 成本 |
| LLM Prompt（GPT-4o / Claude） | 上下文长、需要语气风格控制 | ~$5-15 / 1M 字符 |

**推荐：翻译路由层**。根据「源-目标语言对」「用户付费等级」「术语表需求」自动选择最优引擎。关键路径（付费用户）默认 DeepL，免费用户使用本地 LLM 或 Google。

#### 决策 3：视频存储策略

- 源视频上传后转码为 H.264 + AAC 的 MP4 格式（统一格式便于处理）
- 同时生成 480p 预览缩略视频（编辑器中快速预览）
- 字幕文件、缩略图等小对象直接存对象存储
- 源视频默认保留 30 天，可付费延长；用户可手动设置立即删除

---

## 4. 前端详细设计

### 4.1 项目结构

```
web/
├── src/
│   ├── app/                          # Next.js App Router 页面
│   │   ├── (marketing)/              # 营销页路由组（无需登录）
│   │   │   ├── page.tsx              # 首页（Hero + 功能介绍 + 定价）
│   │   │   ├── features/             # 功能详情页
│   │   │   └── pricing/              # 定价页
│   │   ├── (dashboard)/              # 用户面板路由组（需登录）
│   │   │   ├── projects/
│   │   │   │   ├── page.tsx          # 项目列表
│   │   │   │   └── [id]/
│   │   │   │       ├── page.tsx      # 项目详情/编辑器
│   │   │   │       └── translate/    # 翻译子页面
│   │   │   └── settings/
│   │   │       ├── profile/
│   │   │       └── api-keys/
│   │   ├── auth/                     # 登录/注册/重置密码
│   │   └── share/[token]/            # 分享链接页面
│   │
│   ├── components/                   # 通用组件
│   │   ├── ui/                       # shadcn/ui 基础组件（Button, Input, Modal...）
│   │   ├── layout/                   # 布局组件（Header, Sidebar, Footer）
│   │   └── shared/                   # 业务通用组件
│   │       ├── VideoUploader/        # 视频上传组件
│   │       ├── ProjectCard/          # 项目卡片
│   │       └── ProgressBar/
│   │
│   ├── features/                     # 功能模块（按垂直切片组织）
│   │   ├── editor/                   # 字幕编辑器核心
│   │   │   ├── components/
│   │   │   │   ├── VideoPlayer.tsx   # 视频播放器（集成字幕轨道）
│   │   │   │   ├── SubtitleList.tsx  # 字幕列表（虚拟滚动）
│   │   │   │   ├── SubtitleRow.tsx   # 单条字幕行（文本+时间编辑）
│   │   │   │   ├── Timeline.tsx      # 时间轴可视化组件
│   │   │   │   ├── Toolbar.tsx       # 工具栏（搜索、撤销重做、快捷键提示）
│   │   │   │   └── TranslationPanel  # 翻译面板（原/译文对照编辑）
│   │   │   ├── hooks/
│   │   │   │   ├── useEditor.ts      # 编辑器核心状态逻辑
│   │   │   │   ├── useKeyboard.ts    # 快捷键绑定
│   │   │   │   └── useAutoSave.ts    # 自动保存
│   │   │   └── store/
│   │   │       └── editorStore.ts    # Zustand 编辑器状态
│   │   ├── upload/                   # 上传模块
│   │   ├── translation/              # 翻译模块
│   │   └── export/                   # 导出模块
│   │
│   ├── lib/                          # 工具与基础设施
│   │   ├── api/                      # API 客户端（基于 fetch + TanStack Query）
│   │   ├── hooks/                    # 通用 React Hooks
│   │   ├── utils/                    # 纯函数工具（时间格式化、字幕解析等）
│   │   ├── parsers/                  # 字幕格式解析器（SRT/VTT/ASS）
│   │   │   ├── srt.ts
│   │   │   ├── vtt.ts
│   │   │   └── ass.ts
│   │   └── types/                    # 全局 TypeScript 类型定义
│   │
│   └── styles/                       # 全局样式
│       └── globals.css
│
├── public/
├── tests/                            # Vitest 单测 + Playwright e2e
├── next.config.mjs
├── tailwind.config.ts
└── package.json
```

### 4.2 字幕编辑器核心交互设计

#### 4.2.1 布局（1920×1080 参考）

```
┌─────────────────────────────────────────────────────────────────────────┐
│  顶部工具栏：  [← 返回]  项目名称  [保存中✓]  [翻译] [导出] ▾  [分享]   │
├────────────────────────────────────────┬────────────────────────────────┤
│                                        │  搜索框: [________] [🔍]       │
│                                        ├────────────────────────────────┤
│                                        │  过滤： [全部语言 ▾] [全部说话人▾]│
│           视频播放区域                 ├────────────────────────────────┤
│         (自适应 16:9 或 4:3)          │  #  │ 时间轴  │ 原文 │ 译文     │
│                                        │ ───┼────────┼──────┼────────   │
│   ┌──────────────────────────────┐     │  1 │ 00:00:02│大家好 │ Hello    │
│   │                              │     │  2 │ 00:00:05│欢迎…  │ Welcome… │
│   │   (视频播放器 + 字幕渲染)     │     │  3 │ 00:00:08│今天… │ Today…   │
│   │                              │     │ ...                               │
│   └──────────────────────────────┘     │                                   │
│   播放控制栏:  ⏮  ◀◀  ▶  ▶▶  ⏭          │  (虚拟滚动，支持 10000+ 条)      │
│   00:00:15 / 00:10:30  ████████░  1.0x▾ │  (点击跳转到对应时间)            │
│   音量 ▮▮▮▮▯  CC: [中文▾]              │                                   │
│                                        ├────────────────────────────────┤
│   可视化时间轴 (字幕块时间分布图)        │  快捷操作：[+新增] [合并选中]      │
│   ▁▁▁▃▃▅▇▇████████▇▅▃▃▂▁                │  [拆分] [批量时间偏移+500ms]      │
└────────────────────────────────────────┴────────────────────────────────┘
```

#### 4.2.2 快捷键列表

| 快捷键 | 功能 |
|--------|------|
| `Space` | 播放 / 暂停 |
| `Ctrl+S` | 手动保存 |
| `←` / `→` | 后退 / 前进 5 秒 |
| `Shift+←` / `Shift+→` | 后退 / 前进 1 秒 |
| `↑` / `↓` | 选中上一条 / 下一条字幕 |
| `Enter` | 编辑当前选中字幕 |
| `Ctrl+Enter` | 完成编辑并聚焦下一条 |
| `Ctrl+Shift+D` | 拆分当前字幕（在当前播放点） |
| `Ctrl+E` | 合并当前与下一条字幕 |
| `Ctrl+Z` / `Ctrl+Shift+Z` | 撤销 / 重做 |
| `J` / `K` / `L` | 减速 / 播放暂停 / 加速（VLC 风格） |
| `,` / `.` | 上一帧 / 下一帧 |

---

## 5. 后端详细设计

### 5.1 项目结构

```
server/
├── src/
│   ├── modules/                      # 业务模块（按 DDD 分层）
│   │   ├── auth/                     # 认证模块
│   │   │   ├── auth.controller.ts    # HTTP 路由
│   │   │   ├── auth.service.ts       # 业务逻辑
│   │   │   ├── auth.repository.ts    # 数据访问
│   │   │   └── auth.dto.ts           # 请求/响应 DTO（Zod schema）
│   │   ├── projects/
│   │   ├── videos/
│   │   ├── subtitles/
│   │   ├── translation/
│   │   ├── export/
│   │   └── users/
│   │
│   ├── workers/                      # 后台任务 Worker
│   │   ├── queues.ts                 # 队列定义（BullMQ）
│   │   ├── processors/
│   │   │   ├── video-processor.ts    # 视频预处理：抽音、转码、切片
│   │   │   ├── asr-processor.ts      # ASR 识别任务
│   │   │   ├── translate-processor.ts# 翻译任务
│   │   │   └── export-processor.ts   # 导出任务（烧录字幕等）
│   │   └── scheduler.ts              # 定时任务：清理过期文件等
│   │
│   ├── integrations/                 # 外部服务适配器
│   │   ├── asr/
│   │   │   ├── asr.provider.ts       # 提供者接口
│   │   │   ├── whisper.provider.ts   # 自托管 Whisper
│   │   │   ├── google-speech.provider.ts
│   │   │   └── iflytek.provider.ts
│   │   ├── translator/
│   │   │   ├── translator.provider.ts
│   │   │   ├── deepl.provider.ts
│   │   │   ├── google-translate.provider.ts
│   │   │   └── llm-translator.provider.ts
│   │   └── storage/
│   │       ├── storage.provider.ts
│   │       ├── s3.provider.ts
│   │       └── local.provider.ts     # 本地开发用
│   │
│   ├── common/
│   │   ├── config/                   # 配置管理（Zod 验证环境变量）
│   │   ├── logger/                   # pino 结构化日志
│   │   ├── errors/                   # 错误类与全局错误处理
│   │   ├── middleware/               # 中间件（鉴权、限流、追踪）
│   │   └── utils/
│   │
│   └── websocket/                    # Socket.io 事件处理
│       ├── progress.gateway.ts       # 任务进度推送
│       └── editor.gateway.ts         # 编辑器协作与自动保存
│
├── prisma/
│   ├── schema.prisma                 # 数据模型
│   └── migrations/
│
├── test/
├── Dockerfile
└── package.json
```

### 5.2 任务处理流水线

视频处理采用 **管道与过滤器（Pipeline & Filter）** 架构，每个阶段解耦：

```
用户上传视频
    │
    ▼
┌─────────────────────┐   Queue: upload_queue
│  Stage 1: 上传完成   │─── 触发事件 video.uploaded
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐   Worker: video-processor
│  Stage 2: 视频预处理 │   ① 校验格式/编码
│                     │   ② 转码为统一格式 (H.264/AAC MP4)
│                     │   ③ 提取音轨 (16kHz mono WAV，Whisper 最优)
│                     │   ④ 生成缩略图 / 预览视频
│                     │   ⑤ 上传对象存储，保存 URL 到 DB
└──────────┬──────────┘
           │ 事件 video.preprocessed
           ▼
┌─────────────────────┐   Worker: asr-processor
│  Stage 3: ASR 识别   │   ① 根据用户等级/队列长度选择 ASR 提供者
│                     │   ② 发送音频至 ASR 引擎
│                     │   ③ 接收逐词时间戳 + 说话人标签
│                     │   ④ 后处理：分句、标点、时间轴优化
│                     │   ⑤ 保存原始字幕到 subtitles 表
└──────────┬──────────┘
           │ 事件 subtitle.asr_completed
           ▼
┌─────────────────────┐   (可选) 用户触发翻译
│  Stage 4: 字幕翻译   │   ① 选择翻译提供者（按语言对 + 用户等级）
│                     │   ② 批量分句（按 50 句为一批，保留上下文）
│                     │   ③ 调用翻译 API / LLM
│                     │   ④ 应用术语表覆盖
│                     │   ⑤ 保存翻译结果到 subtitle_translations 表
└──────────┬──────────┘
           │ 事件 subtitle.translated
           ▼
┌─────────────────────┐
│  Stage 5: 后处理     │   ① 计算质量评分（ASR 置信度 + 翻译 BLEU）
│                     │   ② 触发 WebSocket 通知前端
│                     │   ③ 发送邮件通知（用户设置 >10min 视频）
└─────────────────────┘
```

每个 Stage 的失败策略：
- **可重试错误**（网络超时、5xx）：指数退避重试，最多 3 次
- **不可重试错误**（格式不支持、音频损坏）：立即标记失败，写错误日志，通知用户
- **超时**：单任务超时 2× 视频时长（如 10min 视频最多处理 20min）

---

## 6. ASR 语音识别模块

### 6.1 Whisper 自托管部署方案

```
GPU 服务器配置（单机参考）：
  • CPU: 16 核
  • GPU: NVIDIA RTX 4090 24GB (或 A10G 24G / A10 24G)
  • RAM: 64GB
  • 磁盘: 500GB NVMe (存放模型 + 临时音频)
  • 单机并发：2-3 个识别任务（Large v3 FP16）
  • 吞吐：约 8-12x 实时率 (1 分钟音频约 5-8 秒完成)
```

### 6.2 Whisper 推理优化

| 优化手段 | 效果 |
|---------|------|
| **FP16 / BF16 半精度推理** | 显存减半，速度 +40%，精度几乎无损 |
| **Flash Attention 2** | 长音频推理速度 +30% |
| **Speculative Decoding** | 使用 Distil-Whisper 做草稿模型，解码速度 ×2-3 |
| **VAD 过滤静音段** | 跳过纯静音，节省 10-30% 推理时间 |
| **批处理 + 长音频切分** | 30s 切片并行处理，最后合并时间轴 |
| **TensorRT-LLM / vLLM 推理引擎** | 对比原生 PyTorch，吞吐 ×3-5 |

### 6.3 ASR 后处理（提升准确率的关键）

1. **智能分句**：基于标点 + 语义停顿（而非 Whisper 默认长度限制）
2. **标点恢复**：使用专用标点模型（如 Chinese-Punct）二次修正
3. **术语表替换**：正则 + Fuzzy 匹配替换为用户自定义术语
4. **时间轴平滑**：避免字幕闪屏（单条字幕最短时长 800ms，相邻间隔 ≥ 100ms）
5. **置信度过滤**：低置信度词语标红，提醒用户人工校对
6. **说话人分离**：集成 pyannote.audio 做 diarization，结果与 Whisper 时间戳对齐

---

## 7. 翻译引擎模块

### 7.1 翻译路由策略（Router Layer）

```
输入：翻译请求 (source_lang, target_lang, text_batch, user_plan, glossary_id)
    │
    ├─► 检查缓存（Redis）：完全匹配的句对 → 直接返回
    │
    ├─► 付费用户 (Pro/Enterprise)：
    │     ├─ 欧洲语言对 (en↔de/fr/es/it) → DeepL (质量最优)
    │     ├─ 小语种 → Google Translation (语种最全)
    │     └─ 有自定义语气/风格要求 → LLM (GPT-4o / Claude)
    │
    └─► 免费用户 (Free)：
          ├─ 中文↔英文 → 本地部署 Qwen2.5-7B-Instruct (成本可控)
          └─ 其他语言 → Google Translation (标准档位)
```

### 7.2 字幕翻译的特殊处理

字幕翻译不同于普通文本翻译，有以下特殊约束：

1. **字符数限制**：译文长度不应超过原文 1.5 倍（否则屏幕显示不下）
   - 系统自动检测超长并提示用户手动调整
2. **时间轴对齐**：译文必须复用原文字幕的时间戳，不重新分句
3. **换行保留**：原文中的换行符 `\N`（ASS）或两行结构需在译文中保留
4. **人名/地名一致性**：同一文档中的专有名词翻译保持一致（文档级上下文）
5. **幽默/双关处理**：对喜剧类内容，可开启 LLM 的「创意翻译模式」

### 7.3 提示词设计（LLM 翻译模式）

```
你是一位专业的字幕翻译专家。请将以下视频字幕从 {source_lang} 翻译为 {target_lang}。

翻译要求：
1. 保持口语化，适合观众阅读，不要过于书面
2. 每条译文长度尽量接近原文，超长时可分拆到多行（使用 \n 分隔）
3. 保留原文中的专有名词、品牌名（可在括号中标注原名）
4. 保持说话人语气和情绪
5. 严格按 JSON 数组输出，不要添加任何解释性文字

术语表：
{glossary_pairs, 如 "AGI" → "通用人工智能"}

前 5 句上下文（供参考）：
{context_lines}

待翻译字幕：
[
  {{ "id": 1, "start": "00:00:02", "text": "Hello everyone, welcome to our channel." }},
  {{ "id": 2, "start": "00:00:06", "text": "Today we'll talk about AGI and its future." }}
]

请输出：
[
  {{ "id": 1, "text": "大家好，欢迎来到我们的频道。" }},
  {{ "id": 2, "text": "今天我们来聊聊通用人工智能（AGI）及其未来。" }}
]
```

---

## 8. 数据库设计

### 8.1 ER 图（核心实体）

```
┌──────────┐       ┌──────────────┐       ┌──────────────┐
│  users   │1─────*│   projects   │1─────*│    videos    │
├──────────┤       ├──────────────┤       ├──────────────┤
│ id (PK)  │       │ id (PK)      │       │ id (PK)      │
│ email    │       │ user_id (FK) │       │ project_id(FK)│
│ name     │       │ name         │       │ storage_url  │
│ plan     │       │ status       │       │ duration(s)  │
│ usage    │       │ created_at   │       │ resolution   │
└──────────┘       └──────────────┘       └──────┬───────┘
                                                  │1
                                                  │
                          ┌───────────────────────┴────────┐
                          │                                │
                  ┌───────▼─────────┐           ┌──────────▼──────────┐
                  │   subtitles      │1───────*  │subtitle_translations│
                  ├──────────────────┤           ├─────────────────────┤
                  │ id (PK)          │           │ id (PK)             │
                  │ video_id (FK)    │           │ subtitle_id (FK)    │
                  │ language_code    │           │ language_code       │
                  │ version          │           │ text                │
                  │ created_from_asr │           │ translator_provider │
                  └───────┬──────────┘           │ confidence          │
                          │1                      └─────────────────────┘
                          │
                  ┌───────▼──────────┐
                  │  subtitle_cues   │   （每条字幕条目 = Cue）
                  ├──────────────────┤
                  │ id (PK)          │
                  │ subtitle_id (FK) │
                  │ index            │
                  │ start_ms         │
                  │ end_ms           │
                  │ text             │
                  │ speaker_tag      │
                  │ confidence       │
                  └──────────────────┘

┌─────────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐
│     glossaries      │   │   processing_jobs   │   │  api_keys / 用量表   │
├─────────────────────┤   ├─────────────────────┤   ├─────────────────────┤
│ id, user_id, name   │   │ id, project_id      │   │ id, user_id, key_hash│
│ terms (JSONB)       │   │ type, status, stage │   │ permissions, expires│
└─────────────────────┘   │ worker_id, progress │   │ monthly_minutes_used│
                          │ error_log           │   └─────────────────────┘
                          └─────────────────────┘
```

### 8.2 关键表结构详解（Prisma Schema 片段）

```prisma
model User {
  id            String    @id @default(cuid())
  email         String    @unique
  name          String?
  passwordHash  String    // bcrypt
  plan          Plan      @default(FREE) // FREE, PRO, ENTERPRISE
  avatarUrl     String?
  createdAt     DateTime  @default(now())
  projects      Project[]
  apiKeys       ApiKey[]
  usage         Usage?
}

model Project {
  id          String        @id @default(cuid())
  userId      String
  user        User          @relation(fields: [userId], references: [id], onDelete: Cascade)
  name        String
  status      ProjectStatus @default(CREATED)
  sourceLang  String?       // ISO 639-1: zh, en, ja...
  videos      Video[]
  shareToken  String?       @unique
  sharePass   String?       // bcrypt hash
  shareExpire DateTime?
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt
  @@index([userId, createdAt])
}

model Video {
  id           String      @id @default(cuid())
  projectId    String
  project      Project     @relation(...)
  originalName String
  storageUrl   String      // 对象存储 URL (原始)
  transcodedUrl String?    // 对象存储 URL (转码后)
  durationSec  Int         // 秒
  resolution   String      // e.g. "1920x1080"
  fps          Decimal?
  audioTrack   String?     // 提取后的音轨 URL
  fileSizeBytes BigInt
  subtitles    Subtitle[]
  jobs         ProcessingJob[]
  createdAt    DateTime    @default(now())
}

model Subtitle {
  id             String   @id @default(cuid())
  videoId        String
  video          Video    @relation(...)
  languageCode   String   // ISO 639-1
  version        Int      @default(1)  // 用户编辑后 +1
  createdFromAsr Boolean  @default(true)
  asrProvider    String?  // whisper-large-v3, google-speech...
  cues           SubtitleCue[]
  translations   SubtitleTranslation[]
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@unique([videoId, languageCode, version])
}

model SubtitleCue {
  id           String   @id @default(cuid())
  subtitleId   String
  subtitle     Subtitle @relation(...)
  index        Int      // 字幕序号（从 1 开始）
  startMs      Int      // 开始时间（毫秒）
  endMs        Int      // 结束时间（毫秒）
  text         String   @db.Text
  speakerTag   String?  // Speaker A / 说话人1
  confidence   Decimal? // ASR 置信度 0~1
  @@index([subtitleId, index])
}

model SubtitleTranslation {
  id                String   @id @default(cuid())
  subtitleId        String
  subtitle          Subtitle @relation(...)
  languageCode      String
  cues              Json     // 结构同 SubtitleCue[]，但仅存 translated text + 原 cueId
  translatorProvider String  // deepl, google, qwen-7b, gpt-4o
  glossaryApplied   Boolean  @default(false)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@unique([subtitleId, languageCode])
}

model ProcessingJob {
  id         String      @id @default(cuid())
  projectId  String
  type       JobType     // VIDEO_PREPROCESS, ASR, TRANSLATE, EXPORT
  status     JobStatus   @default(PENDING)
  stage      String?     // 子阶段描述
  progress   Int         @default(0) // 0-100
  provider   String?
  errorLog   String?     @db.Text
  startedAt  DateTime?
  finishedAt DateTime?
  createdAt  DateTime    @default(now())
  @@index([status, createdAt])
}
```

### 8.3 数据库选型

- **主数据库：PostgreSQL 16**
  - 支持 JSONB（灵活存储翻译结果、术语表）
  - 全文检索（字幕内容搜索，Phrasal Search）
  - 强事务一致性（字幕编辑时的并发更新）
- **缓存层：Redis 7**
  - 翻译结果缓存（Key = hash(source_lang + target_lang + text)，TTL = 30 天）
  - 热点数据缓存（最近访问的项目/字幕）
  - BullMQ 队列存储
  - 用户 Session
- **搜索引擎（V2 规划）：Elasticsearch / OpenSearch**
  - 跨项目字幕内容搜索
  - 相似度去重

---

## 9. API 接口设计

### 9.1 接口总览

| 方法 | 路径 | 描述 | 鉴权 |
|-----|------|------|------|
| POST | `/api/auth/register` | 注册 | ❌ |
| POST | `/api/auth/login` | 登录 | ❌ |
| GET | `/api/auth/me` | 获取当前用户 | ✅ |
| GET | `/api/projects` | 项目列表（分页+筛选） | ✅ |
| POST | `/api/projects` | 创建项目 | ✅ |
| GET | `/api/projects/:id` | 项目详情 | ✅ |
| PATCH | `/api/projects/:id` | 更新项目 | ✅ |
| DELETE | `/api/projects/:id` | 删除项目 | ✅ |
| POST | `/api/projects/:id/videos` | 视频上传初始化（获取分片上传凭证） | ✅ |
| POST | `/api/videos/:id/complete-upload` | 分片上传完成通知 | ✅ |
| GET | `/api/videos/:id/subtitles/:lang` | 获取指定语言的字幕（含所有 cues） | ✅ |
| PUT | `/api/videos/:id/subtitles/:lang` | 全量更新字幕（保存编辑器修改） | ✅ |
| PATCH | `/api/subtitles/cues/:cueId` | 单条字幕更新 | ✅ |
| POST | `/api/projects/:id/translate` | 发起翻译任务 | ✅ |
| GET | `/api/jobs/:id/progress` | 查询任务进度（或走 WebSocket） | ✅ |
| POST | `/api/projects/:id/export` | 生成导出文件 | ✅ |
| GET | `/api/export/:token/download` | 下载导出文件 | ✅（令牌） |
| POST | `/api/projects/:id/share` | 生成分享链接 | ✅ |

### 9.2 关键接口示例

#### 9.2.1 视频分片上传（TUS 协议 / 自定义分片）

**① 初始化上传**
```http
POST /api/projects/proj_xxx/videos
Authorization: Bearer <jwt>
Content-Type: application/json

{
  "fileName": "ted-talk-ai.mp4",
  "fileSize": 524288000,
  "mimeType": "video/mp4",
  "chunkSize": 5242880
}
```

响应：
```json
{
  "uploadId": "upl_abc123",
  "videoId": "vid_xyz789",
  "chunkSize": 5242880,
  "totalChunks": 100,
  "uploadUrls": [
    { "index": 1, "url": "https://oss.example.com/presigned/chunk1?token=..." },
    { "index": 2, "url": "..." }
  ],
  "expiresAt": "2026-09-02T12:00:00Z"
}
```

**② 客户端分片并行上传** 到预签名 URL（绕过应用服务器，节省带宽）

**③ 通知完成**
```http
POST /api/videos/vid_xyz789/complete-upload
Authorization: Bearer <jwt>

{
  "uploadId": "upl_abc123",
  "checksum": "sha256:abc..."
}
```

服务端响应 `202 Accepted`，并将预处理任务入队。客户端通过 WebSocket 订阅 `jobs:{jobId}:progress` 事件接收进度。

#### 9.2.2 保存字幕（编辑器自动保存）

```http
PUT /api/videos/vid_xyz789/subtitles/zh
Authorization: Bearer <jwt>
Content-Type: application/json
If-Match: "v3-d41d8cd98f00b204"  // 乐观锁，基于 ETag

{
  "version": 4,
  "cues": [
    { "index": 1, "startMs": 2000, "endMs": 5200, "text": "大家好，欢迎来到我们的频道。", "speakerTag": "Speaker A" },
    { "index": 2, "startMs": 5300, "endMs": 9100, "text": "今天我们来聊聊通用人工智能。", "speakerTag": "Speaker A" }
  ],
  "clientUpdatedAt": "2026-09-02T10:30:15.123Z"
}
```

响应：
```json
{
  "saved": true,
  "version": 4,
  "etag": "v4-ef9a7c..."
}
```

#### 9.2.3 发起翻译任务

```http
POST /api/projects/proj_xxx/translate
Authorization: Bearer <jwt>

{
  "sourceLanguage": "zh",
  "targetLanguages": ["en", "ja", "ko"],
  "subtitleVersion": 4,
  "translatorProvider": "auto",  // auto | deepl | google | gpt-4o
  "glossaryId": "glo_custom_001",
  "tone": "natural",  // natural | formal | casual | creative
  "options": {
    "keepLineBreaks": true,
    "maxLengthRatio": 1.5,
    "contextAware": true
  }
}
```

响应 `202 Accepted`：
```json
{
  "jobs": [
    { "jobId": "job_en_01", "targetLanguage": "en", "status": "QUEUED" },
    { "jobId": "job_ja_02", "targetLanguage": "ja", "status": "QUEUED" },
    { "jobId": "job_ko_03", "targetLanguage": "ko", "status": "QUEUED" }
  ]
}
```

### 9.3 WebSocket 事件

客户端连接：`wss://api.example.com/ws?token=<jwt>`

| 事件名 | 方向 | 负载 |
|--------|------|------|
| `job:progress` | 服务端 → 客户端 | `{ jobId, type, status, progress: 42, stage: "translating", etaSec: 30 }` |
| `job:completed` | 服务端 → 客户端 | `{ jobId, resultSummary }` |
| `job:failed` | 服务端 → 客户端 | `{ jobId, errorCode, errorMessage }` |
| `editor:autosave` | 客户端 → 服务端 | `{ videoId, subtitleLang, cuesPatch }` |
| `editor:autosave:ack` | 服务端 → 客户端 | `{ saved, version }` |
| `collab:cue-changed` | 服务端广播 | `{ cueId, patch, changedBy }`（多人协作时） |

---

## 10. UI/UX 设计规范

### 10.1 设计语言

- **风格**：Clean + Professional（简洁专业），避免花哨装饰
- **设计系统**：基于 shadcn/ui 定制
- **主色调**：靛蓝色系（Indigo 600 `#4F46E5`）传递专业与信任
- **辅助色**：Emerald 绿（成功）、Amber 橙（警告）、Rose 红（错误）
- **字体**：
  - 界面文字：Inter（拉丁）+ 思源黑体 SC（中文）
  - 代码/时间轴：JetBrains Mono
- **圆角**：`md` (6px) 为主，`lg` (8px) 用于卡片，避免过大圆角
- **阴影**：分层阴影（悬停时 elevation 提升）

### 10.2 核心页面流程

#### 流程 A：新用户 → 首次生成字幕

```
首页 (Hero + [立即免费开始])
  │
  ▼
注册/登录（邮箱 / Google / GitHub OAuth）
  │
  ▼
空状态项目页（巨大的 [+ 上传视频] 拖拽区 + 引导动画）
  │  拖拽视频
  ▼
上传进度页（[上传中...] 显示进度、预计剩余时间，支持 [后台上传] 按钮）
  │
  ▼
上传完成自动跳转 → 项目详情
  │
  ▼
处理状态页（三个阶段卡片：
  ① 预处理 ✓ ✓ ✓  → 100%
  ② 语音识别 ████░░ → 68%  [识别中，预计 1 分 32 秒]
  ③ 翻译（未开始，需手动触发）
）
  │ ASR 完成 + 自动跳转
  ▼
字幕编辑器（顶部 [识别已完成 ✅ 现在可以编辑或翻译] banner）
```

#### 流程 B：已有字幕 → 翻译 → 导出

```
字幕编辑器
  │  点击顶部 [翻译]
  ▼
翻译对话框
  ├─ 目标语言：多选标签（🇺🇸 English  ✓  🇯🇵 日本語  ✓  🇰🇷 한국어）
  ├─ 翻译引擎：[自动（推荐） ▾]
  ├─ 术语表：[我的 AI 术语表 ▾]  [+ 新建]
  ├─ 高级选项展开：
  │   ├─ ☑ 保留换行符
  │   ├─ ☑ 文档级一致性（较慢）
  │   └─ ☑ 超长提示（> 1.5× 长度时）
  └─ [开始翻译] 按钮（显示消耗金额/用量）
  │
  ▼
编辑器切换到「双语模式」（左右：原文 / 译文）
  翻译进度条在顶部
  每完成一种语言 → 顶部标签新增 Tab [中文] [英文 ✓] [日文 ▓▓░]
  │  翻译完成
  ▼
点击 [导出 ▾]
  ├─ SRT（英文）
  ├─ SRT（中日双语）
  ├─ WebVTT
  ├─ ASS（带样式）
  ├─ 烧录字幕到视频（MP4）
  └─ 批量导出（打包 .zip）
  │
  ▼
下载完成 toast ✓
```

### 10.3 字幕编辑器交互细节

| 场景 | 交互设计 |
|------|---------|
| 编辑器首次进入 | 高亮第一条字幕，播放视频从 0 秒开始，自动滚动字幕列表跟随播放进度（当前行 +1 黄色高亮） |
| 修改单条字幕 | 失焦或 Ctrl+Enter 后，立即乐观更新 UI，后台 debounce 保存；失败时恢复原值 + toast 提示 |
| 批量操作选中 | 长按/Shift 多选后，右侧出现浮动操作面板（删除 / 合并 / 时间 ± ms / 批量翻译） |
| 时间轴拖拽 | 光标变 ↔，拖拽中实时显示 tooltip `00:02:31.450`，支持按住 Shift 吸附 100ms 网格 |
| 低置信度词汇 | 原文中下划虚线（如 `人工智nèng`），鼠标悬停显示「ASR 置信度 62%，建议核对」 |

---

## 11. 安全设计

### 11.1 认证与授权

- **登录方式**：邮箱+密码（bcrypt 12 轮）、Google OAuth、GitHub OAuth
- **会话管理**：
  - Access Token：JWT，15 分钟有效期，存内存
  - Refresh Token：HttpOnly + Secure + SameSite=Lax Cookie，7 天有效期，支持服务端吊销
  - 轮换策略：每次用 Refresh 换新 Token，旧 Refresh 立即作废（防止重放）
- **API 调用**：第三方开发者使用 API Key（请求头 `Authorization: Bearer sk_xxx`），每个 Key 可配置 IP 白名单 + 配额

### 11.2 权限模型（RBAC）

| 角色 | 权限 |
|------|------|
| `project:owner` | 所有者：全部权限（删除项目、管理协作者、永久删除文件） |
| `project:editor` | 编辑者：编辑字幕、翻译、导出 |
| `project:viewer` | 查看者：只读浏览、下载导出（分享链接默认角色） |

### 11.3 输入与数据安全

- **所有用户输入**：Zod Schema 验证（类型、长度、格式、字符集）
- **字幕文本**：存储前过滤不可见控制字符；导出时按目标格式转义（如 SRT 中的 `-->` 必须处理）
- **上传文件**：
  - 魔数校验（禁止改后缀上传脚本/可执行文件）
  - 病毒扫描（ClamAV，异步扫描 + 标记可疑文件）
  - 文件大小上限 2GB，时长上限 6 小时
- **对象存储访问**：
  - 所有资源默认私有
  - 下载/播放使用签名 URL（1 小时有效期）
  - CORS 白名单仅包含前端域名

### 11.4 防滥用

| 措施 | 说明 |
|------|------|
| **速率限制** | 登录接口 5 次/分钟；上传 50 次/天/用户；API 按套餐 QPS |
| **同设备多账号** | 浏览器指纹 + IP 维度关联，免费套餐合并计量 |
| **异常检测** | 1 分钟内并发上传 > 10 个 → 触发人工审核 |
| **内容审核** | 用户生成的译文使用敏感词过滤（NLP + 关键词），违规内容自动标记 |

---

## 12. 部署与运维

### 12.1 生产环境拓扑

```
                 ┌───────────────┐
                 │ Cloudflare CDN│  ← 静态资源、视频分发、WAF
                 └───────┬───────┘
                         │
                 ┌───────▼───────┐
                 │  Nginx 入口   │  ← TLS 终止、限流、真实 IP
                 └───────┬───────┘
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
   ┌────────────┐ ┌────────────┐ ┌────────────┐
   │  Web Pod   │ │  API Pod   │ │  WS Pod    │  (K8s Deployment, HPA)
   │  ×3 (SSR)  │ │  ×3 (API)  │ │  ×2 (实时)  │
   └──────┬─────┘ └──────┬─────┘ └──────┬─────┘
          └───────────────┼──────────────┘
                          │
          ┌───────────────┼───────────────┐
          ▼               ▼               ▼
   ┌────────────┐  ┌────────────┐  ┌────────────┐
   │ PostgreSQL │  │   Redis    │  │  MinIO/S3  │  (K8s StatefulSet + PVC)
   │  Primary + │  │  3 节点集群│  │  多副本存储│
   │  2  Replica │  │            │  │            │
   └────────────┘  └────────────┘  └────────────┘
                          │
                 ┌────────▼────────┐
                 │  GPU Worker 池  │  ← K8s GPU 节点池，独立 HPA
                 │  ×2-4 弹性伸缩  │    (按 asr_queue 长度触发扩容)
                 └─────────────────┘
```

### 12.2 Docker Compose 本地开发环境

为了让开发开箱即用，提供 `docker-compose.dev.yml`：

```yaml
services:
  web:        # Next.js dev server (端口 3000)
  api:        # Node.js + Hapi/Fastify dev (端口 4000)
  worker:     # 单个 Worker 进程 (CPU-only Faster-Whisper tiny 模型)
  postgres:   # PostgreSQL 16 + pgvector
  redis:      # Redis 7 + RedisInsight
  minio:      # 对象存储（本地 S3 兼容）
  mailhog:    # 邮件捕获（开发时看注册验证邮件）
  pgadmin:    # 数据库可视化
```

### 12.3 监控与告警

- **指标**（Prometheus + Grafana 大盘）：
  - 业务指标：日活、上传量、识别成功率、平均处理时长、翻译调用分布
  - 系统指标：Pod CPU/内存/GPU 利用率、队列长度、对象存储空间
  - API 指标：QPS、P50/P95/P99 延迟、错误率（按路由分）
- **日志**：pino JSON 结构化日志 → Loki 聚合 → Grafana 查询
- **异常追踪**：Sentry 捕获前后端未处理错误，关联用户 ID 和请求 Trace ID
- **告警规则（PagerDuty/飞书群）**：
  - ASR 成功率 < 95% 且持续 5 分钟 → P1
  - API 错误率 > 5% → P1
  - GPU Worker 全部不可用 → P0
  - 队列等待 > 100 个任务 → P2

### 12.4 备份与灾备

| 数据类型 | 备份策略 | 保留策略 | RPO | RTO |
|---------|---------|---------|-----|-----|
| PostgreSQL | 每日 03:00 全量 + 每 15 分钟 WAL 增量 | 每日 30 天，每月 1 年 | 15 分钟 | 4 小时 |
| Redis | AOF everysec + 每日 RDB 快照 | 7 天 | 1 秒 | 30 分钟 |
| 对象存储（视频/字幕） | 跨区域复制（CRR）+ 版本控制 | 版本保留 30 天 | 0 | 分钟级 |
| 用户元数据（配合 DB） | 上述 PostgreSQL 备份 | 同上 | 同上 | 同上 |

---

## 13. 开发路线图

### 13.1 Milestone 0：项目脚手架（1 周）

- [x] 初始化 Monorepo（pnpm workspace + TurboRepo）
- [x] Next.js 项目 + shadcn/ui 安装
- [x] 后端 Hono + Prisma 初始化
- [x] Docker Compose 本地环境
- [x] ESLint / Prettier / Husky / commitlint 规范化
- [x] CI/CD 基础流水线（Lint + TypeScript 检查）
- [x] AGENTS.md 项目规则

### 13.2 Milestone 1：MVP — 核心字幕生成（3 周）

**目标**：用户可以上传视频 → 自动生成中文字幕 → 编辑 → 导出 SRT

| 周 | 交付内容 |
|----|---------|
| W1 | 注册登录；项目 CRUD；视频上传（整文件，不超过 500MB）；前端上传进度 |
| W2 | 视频预处理 Worker（ffmpeg 抽音+转码）；集成 Whisper tiny/cpu 跑通 ASR 流程；字幕入库 |
| W3 | 字幕编辑器（列表+视频播放+跳转+编辑单条+保存）；SRT/VTT/TXT 导出；任务进度 WebSocket |

**MVP 成功标准**：能处理 ≤ 5 分钟的中文/英文视频，识别率目测可用，端到端跑通。

### 13.3 Milestone 2：翻译能力上线（2 周）

- 翻译 Worker 骨架 + DeepL/Google 适配器
- 项目详情中的翻译面板（目标语言多选、翻译进度）
- 编辑器双语模式（原文/译文 Tab + 对照编辑）
- 双语字幕导出（中文上、英文下的 SRT/VTT）
- 术语表 V1（用户上传 CSV，翻译时替换）

### 13.4 Milestone 3：生产级优化（2 周）

- GPU Whisper 部署 + 推理优化（FP16 + VAD）
- 分片上传 + 大文件支持（≤ 2GB）
- 编辑器性能优化（虚拟滚动 + 千条级字幕流畅）
- 快捷键、撤销重做、批量操作
- 分享链接功能（只读/可编辑）
- 监控告警、日志链路追踪

### 13.5 Milestone 4：商业化 & 高级特性（3 周+）

- 付费套餐接入（Stripe 订阅）：Free (60min/月)、Pro ($19/月 10h)、Enterprise（按量）
- 说话人分离（pyannote）
- 说话人音色克隆配音（TTS，V2 规划）
- 团队协作空间（成员管理、角色权限）
- Zapier/Make 集成（Webhook 触发翻译完成）
- 字幕字幕搜索（Elasticsearch）

### 13.6 里程碑甘特图（文字版）

```
M0  脚手架   ████ (1周)
M1  MVP      ████████████████ (3周)
M2  翻译               ██████████ (2周)
M3  生产级                     ██████████ (2周)
M4  商业化+高级特性                      ███████████████████ (3周+)
                  ↑
              预计 v1.0 发布 (M3 完成)
              约 8 周 = 2 个月时间
```

---

## 14. 风险评估与应对

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| **GPU 服务器成本高** | 高 | 高 | 初期使用 CPU 跑 Faster-Whisper 做 MVP；接入云 API 按需付费；获得第一批用户后再采购 GPU |
| **ASR 识别准确率低于预期** | 中 | 高 | 编辑器中可视化置信度，引导人工校对；提供术语表；后处理阶段增加错别字检测模型 |
| **翻译质量争议（用户觉得机翻味重）** | 中 | 中 | 提供多引擎切换按钮；V2 加入"人工精校市场"（众包或合作翻译团队） |
| **视频版权问题（用户上传盗版内容）** | 中 | 高 | 用户协议明确禁止侵权；接入版权指纹（V2）；DMCA 投诉处理通道；定期抽查热门项目 |
| **大文件上传失败率高** | 中 | 中 | 使用 TUS 标准协议（断点续传）；分片并行；失败自动重试 + 后台恢复；客户端检测网络弱网提示 |
| **冷启动流量不足** | 低 | 中 | 提供免费额度（每月 60 分钟）；Product Hunt 上线；B站/YouTube 制作"字幕神器"测评视频；SEO 博客 |
| **竞品抄袭/价格战** | 中 | 中 | 核心差异化：多引擎自动路由 + 编辑器深度体验 + 本地化部署选项（企业版私有化） |
| **合规风险（数据跨境）** | 低 | 高 | 国内部署使用国内云厂商（阿里云/腾讯云）；用户可选数据存储区域；签署 DPA（数据处理协议） |

---

## 附录 A：字幕格式参考（开发者速查）

### A.1 SRT 格式

```
1
00:00:02,000 --> 00:00:05,200
大家好，欢迎来到我们的频道。

2
00:00:05,500 --> 00:00:09,100
今天我们来聊聊通用人工智能（AGI）
以及它的未来发展方向。
```

### A.2 WebVTT 格式（HTML5 原生支持）

```
WEBVTT

NOTE 这是注释

1
00:00:02.000 --> 00:00:05.200
大家好，欢迎来到我们的频道。

2
00:00:05.500 --> 00:00:09.100 line:80% position:50%
<c.speakerA>今天我们来聊聊通用人工智能（AGI）</c>
```

---

## 附录 B：性能测试基线（开发完成后验证）

| 测试项 | 基线要求 |
|-------|---------|
| 字幕列表渲染 10,000 条，滚动 FPS | ≥ 50 |
| 视频 seek 响应延迟 | ≤ 200ms |
| 保存 10,000 条字幕 API 响应 | ≤ 2s |
| 10 分钟视频 → 中文识别（GPU） | ≤ 60s |
| 翻译 1,000 条字幕（1 万字，en→zh） | ≤ 20s |

---

> **文档维护者**：项目核心团队  
> **下次 Review 时间**：M1 完成后重新评审架构是否需要调整
