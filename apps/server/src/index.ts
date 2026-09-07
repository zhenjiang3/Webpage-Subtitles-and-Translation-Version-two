/**
 * 本地后端服务入口
 * ─────────────────────────────────────────────────────────────────
 * 一个进程内提供两个端点（仅绑定 127.0.0.1，不对外暴露）：
 *   1. GET  /health       — 健康检查 + 二进制/模型自检
 *   2. WS   /ws           — 接收浏览器扩展发来的音频块，跑 ASR + 翻译，回送 cues
 *
 * 协议（每连接按序：TEXT 块头 → BINARY 音频字节）：
 *   Client→Server: start / chunk(text)+binary / end / ping
 *   Server→Client: ready / asr_result / translation / error / status / pong
 */
import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { isFFmpegAvailable } from './ffmpeg.js';
import { handleConnection, type ServerContext } from './ws-handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(SERVER_ROOT, 'data');

const PORT = parseInt(process.env.PORT ?? '17712', 10);

// 确保临时音频块目录存在（.gitignore 已忽略）
fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * 健康检查 handler：返回 ffmpeg / whisper-cli / 模型 / translator provider 的就绪状态。
 * 不在启动时强校验（避免模型缺失导致进程退出），首次 WS 连接时才校验。
 */
async function healthHandler(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const ff = await isFFmpegAvailable();
  const whisperCli =
    process.env.WHISPER_CLI_PATH ??
    path.join(SERVER_ROOT, 'tools', 'whisper', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  const whisperModel =
    process.env.WHISPER_MODEL_PATH ??
    path.join(SERVER_ROOT, 'tools', 'whisper', 'models', 'ggml-small.bin');
  const body = {
    ok: ff.ok && fs.existsSync(whisperCli) && fs.existsSync(whisperModel),
    ffmpeg: ff.ffmpegPath,
    ffprobe: ff.ffprobePath,
    whisperCli: fs.existsSync(whisperCli) ? whisperCli : null,
    whisperModel: fs.existsSync(whisperModel) ? whisperModel : null,
    translatorProvider: process.env.TRANSLATOR_PROVIDER ?? 'xenova-nllb',
    asrProvider: process.env.ASR_PROVIDER ?? 'whisper-cpp',
    port: PORT,
  };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    return healthHandler(req, res);
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found', path: req.url }));
});

const wss = new WebSocketServer({ server, path: '/ws' });

const ctx: ServerContext = { dataDir: DATA_DIR };

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress ?? 'unknown';
  // eslint-disable-next-line no-console
  console.log(`[ws] new connection from ${ip}`);
  handleConnection(ws, ctx).catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[ws] connection handler error:', e);
  });
});

wss.on('error', (e) => {
  // eslint-disable-next-line no-console
  console.error('[ws] server error:', e);
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`\n═══════════════════════════════════════════════════════════`);
  // eslint-disable-next-line no-console
  console.log(`  实时双语字幕后端已启动`);
  // eslint-disable-next-line no-console
  console.log(`  Health : http://127.0.0.1:${PORT}/health`);
  // eslint-disable-next-line no-console
  console.log(`  WS     : ws://127.0.0.1:${PORT}/ws`);
  // eslint-disable-next-line no-console
  console.log(`  数据   : ${DATA_DIR}`);
  // eslint-disable-next-line no-console
  console.log(`═══════════════════════════════════════════════════════════\n`);
});

function shutdown(signal: string) {
  // eslint-disable-next-line no-console
  console.log(`\n[server] received ${signal}, shutting down...`);
  wss.clients.forEach((c) => c.close(1001, 'server shutting down'));
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
