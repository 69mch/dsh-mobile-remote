/**
 * server.js — Mobile Remote Gateway 入口（连接码 + 首设备绑定 + 无状态会话）
 *
 * 认证模型（无账号密码）：
 *   1. Harness 侧持有一个连接码（config/pairing.json，仅一个，可轮换）。
 *   2. 手机 App 输入连接码 + 自身设备 ID 调用 POST /__gw/pair。
 *   3. 首次配对绑定该设备；同设备可重配；其他设备用同一码 → 拒绝。
 *   4. 成功后下发无状态 HMAC 签名 Cookie（30 天，重启不失效）。
 *
 * 用法：node gateway/server.js
 */
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Logger } = require('./lib/logger');
const { MemoryStore } = require('./lib/store');
const { Pairing } = require('./lib/pairing');
const { Session } = require('./lib/session');
const rl = require('./lib/ratelimit');
const { passthroughProxy, upgradeProxy } = require('./lib/proxy');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'gateway.json');

function loadConfig(cfgPath) {
  const p = cfgPath || DEFAULT_CONFIG;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function clientIp(req) {
  // 安全：不信任 x-forwarded-for（可伪造），直接取 socket 远程地址。
  // 网关只监听 127.0.0.1，真实来源经 adb reverse / tailscale serve 仍以 socket 地址为准。
  return req.socket.remoteAddress || '?';
}

/** 多层解码 URL，防单层解码绕过的 %252e 等编码穿越；异常停止并返回已解码部分。 */
function fullyDecode(s) {
  let out = String(s);
  for (let i = 0; i < 3; i++) {
    const prev = out;
    try { out = decodeURIComponent(prev); } catch { break; }
    if (out === prev) break;
  }
  return out;
}

/** 规范化为绝对路径：折叠 // 与 . 段、解析 .. 段（越界 .. 直接丢弃），用于认证判定。 */
function normalizePath(p) {
  const segs = String(p).split('/');
  const out = [];
  for (const seg of segs) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}

function main() {
  const config = loadConfig();
  const logger = new Logger(path.resolve(ROOT, config.logs.dir || 'logs'), config.logs);
  logger.runtime({ msg: 'gateway_start', version: config.version || '1.2.0', auth: 'pairing' });

  const configDir = path.dirname(DEFAULT_CONFIG);
  const pairing = new Pairing(path.join(configDir, 'pairing.json'), logger);
  const firstCode = pairing.ensureCode();
  if (firstCode) {
    logger.runtime({ msg: 'pairing_code_created_first_run' });
    console.log('\n==============================================');
    console.log(' 首次运行：您的连接码是');
    console.log(`     ${firstCode}`);
    console.log(' （仅在本次显示；如需新码运行 scripts/gen-code.ps1）');
    console.log('==============================================\n');
  }

  const session = new Session(path.join(configDir, 'session.key'), config.sessionTtlDays || 30);
  const store = new MemoryStore(config.store || {}); // 仅限流计数
  const upstream = config.upstream || 'http://127.0.0.1:3080';
  const listenHost = config.listenHost || '127.0.0.1';
  const listenPort = config.listenPort || 9443;

  const server = http.createServer((req, res) => {
    const ip = clientIp(req);
    const start = Date.now();

    // ---- 免认证端点 ----
    if (req.url === '/__gw/pair' && req.method === 'POST') {
      handlePair(req, res, pairing, session, store, config, logger, ip);
      return;
    }
    if (req.url === '/__gw/health' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: new Date().toISOString(), auth: 'pairing' }));
      return;
    }
    if (req.url === '/__gw/auth-check' && req.method === 'GET') {
      const sess = session.verify(parseCookie(req));
      res.writeHead(sess ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(sess ? { ok: true, deviceId: sess.deviceId } : { ok: false }));
      return;
    }

    // ---- 认证判定 ----
    // 1) 先 URL 解码 + 规范化，防 %2e%2e 等编码穿越绕过静态资源判断。
    // 2) 可到达 /api/* 或 RPC 的路径一律要求认证；仅真正静态资源免认证。
    // 3) HTML 主页面（/、/index.html）也要求认证。
    const rawPath = req.url.split('?')[0];
    const decodedPath = fullyDecode(rawPath);
    // 规范化：多层解码后解析出绝对路径，折叠 // 与 . 段、解析 .. 段，防 ../../../ 与 %2e%2e 编码穿越绕过认证。
    const normPath = normalizePath(decodedPath);
    const pathHitsApi = normPath.split('/').includes('api'); // 任何层级出现 api 段都要求认证

    // 真正安全的静态资源（免认证）：基于【规范化后】路径判定，且绝不包含 api 段。
    const isStaticAsset =
      !pathHitsApi && req.method === 'GET' && (
        normPath === '/favicon.svg' ||
        normPath === '/favicon.ico' ||
        normPath.startsWith('/manifest') ||
        normPath.startsWith('/plugins/') ||
        normPath.startsWith('/assets/')
      );

    if (!isStaticAsset) {
      const sess = session.verify(parseCookie(req));
      if (!sess) {
        logger.access({ ip, method: req.method, path: req.url, status: 401, dur: Date.now() - start });
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', hint: 'pair via POST /__gw/pair' }));
        return;
      }

      // ---- 限流 ----
      if (!rl.reqOk(store, ip, config.limits || {})) {
        logger.audit({ ev: 'rate_limited', ip, url: req.url });
        res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Too Many Requests');
        return;
      }

      // ---- 需认证的网关元信息端点 ----
      if (req.url === '/__gw/pair-status' && req.method === 'GET') {
        logger.access({ ip, deviceId: sess.deviceId, method: req.method, path: req.url, status: 200, dur: Date.now() - start });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(pairing.status()));
        return;
      }

      // ---- 反向代理（认证资源）----
      passthroughProxy(req, res, upstream, logger);
      res.on('finish', () => {
        logger.access({ ip, deviceId: sess.deviceId, method: req.method, path: req.url, status: res.statusCode, dur: Date.now() - start });
      });
      return;
    }

    // ---- 静态资源：直接转发（免认证），不注入 ----
    passthroughProxy(req, res, upstream, logger, { inject: false });
    res.on('finish', () => {
      logger.access({ ip, method: req.method, path: req.url, status: res.statusCode, dur: Date.now() - start, asset: true });
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const sess = session.verify(parseCookie(req));
    if (!sess) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    upgradeProxy(req, socket, head, upstream, logger);
  });

  server.listen(listenPort, listenHost, () => {
    logger.runtime({ msg: 'listening', host: listenHost, port: listenPort, upstream, auth: 'pairing' });
    console.log(`[gateway] listening on http://${listenHost}:${listenPort} -> ${upstream} (pairing auth)`);
  });

  const shutdown = () => {
    logger.runtime({ msg: 'gateway_stop' });
    store.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function parseCookie(req) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === 'dshgw_session') return part.slice(idx + 1).trim();
  }
  return null;
}

/** POST /__gw/pair：{code, deviceId, model?, imei?} */
function handlePair(req, res, pairing, session, store, config, logger, ip) {
  if (!store.hit(`pair:${ip}`, 60_000, config.limits?.pairPerMin || 10)) {
    logger.audit({ ev: 'pair_rate_limited', ip });
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, reason: 'rate_limited' }));
    return;
  }

  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
  req.on('end', () => {
    let fields = {};
    try { fields = JSON.parse(body || '{}'); } catch { fields = {}; }

    const result = pairing.pair(
      String(fields.code || ''),
      {
        deviceId: String(fields.deviceId || ''),
        deviceModel: String(fields.model || ''),
        imei: String(fields.imei || ''),
      }
    );

    if (!result.ok) {
      logger.audit({ ev: 'pair_fail', ip, reason: result.reason, deviceId: String(fields.deviceId || '').slice(0, 40) });
      const code = result.reason === 'bound_other' ? 403 : 401;
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: result.reason }));
      return;
    }

    // 成功：签发无状态设备会话
    const issued = session.issue(result.device.deviceId);
    const maxAgeSec = Math.floor(session.ttlMs / 1000);
    // 经 TLS（tailscale serve 设置 X-Forwarded-Proto=https 或直连 socket 加密）时给 Cookie 加 Secure，
    // 使其仅在 HTTPS 通道传输；本机明文联调（adb reverse）不加，仍可正常使用。
    const isSecure = !!req.socket.encrypted || /^https$/i.test(String(req.headers['x-forwarded-proto'] || ''));
    logger.audit({
      ev: 'pair_ok', ip,
      deviceId: result.device.deviceId,
      model: result.device.deviceModel || '',
      rebound: !!result.rebound,
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': session.cookieHeader(issued.value, maxAgeSec, isSecure),
    });
    res.end(JSON.stringify({
      ok: true,
      device: result.device,
      sessionDays: Math.floor(session.ttlMs / 86400_000),
    }));
  });
}

if (require.main === module) main();
module.exports = { main };
