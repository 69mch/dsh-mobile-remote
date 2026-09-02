/**
 * proxy.js — 反向代理到 upstream（默认 http://127.0.0.1:3080）
 * - 普通 HTTP：流式转发；对 text/html 响应做有界缓冲注入 <meta viewport> + 移动样式
 * - WebSocket：upgrade 转发（GUI 实时事件/SSE 通道）
 * - 仅处理 GET / 且请求头 Accept 含 text/html 的页面；资源与 API 直通
 */
'use strict';
const http = require('http');
const zlib = require('zlib');
const { Transform } = require('stream');

const MOBILE_INJECT = `<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#0b0d10">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<style>
@media (max-width: 860px){
  html,body{max-width:100vw;overflow-x:hidden}
  #root{min-height:100dvh}
}
</style>`;

const MAX_INJECT_BUFFER = 4 * 1024 * 1024; // 4MB：超过即放弃注入直接透传

function isHtmlPage(req, contentType) {
  return req.method === 'GET' &&
    /text\/html/i.test(contentType || '') &&
    /text\/html/i.test(req.headers.accept || '');
}

/** 有界缓冲 Transform：把首个含 </head> 的窗口注入后透传剩余 */
class InjectTransform extends Transform {
  constructor() {
    super();
    this.buf = [];
    this.bufLen = 0;
    this.injected = false;
  }
  _transform(chunk, _enc, cb) {
    if (this.injected) { cb(null, chunk); return; }
    this.buf.push(chunk);
    this.bufLen += chunk.length;
    const joined = Buffer.concat(this.buf);
    const idx = joined.indexOf('</head>');
    if (idx !== -1) {
      // 找到 </head>：head + 注入 + </head> + 剩余
      this.injected = true;
      const head = joined.subarray(0, idx);
      const rest = joined.subarray(idx + '</head>'.length);
      const injected = Buffer.concat([head, Buffer.from(MOBILE_INJECT), Buffer.from('</head>'), rest]);
      this.buf = [];
      cb(null, injected);
      return;
    }
    if (this.bufLen > MAX_INJECT_BUFFER) {
      // 找不到 </head> 且超限：放弃注入，把已缓冲全部透传
      this.injected = true;
      const all = Buffer.concat(this.buf);
      this.buf = [];
      cb(null, all);
      return;
    }
    cb();
  }
  _flush(cb) {
    if (!this.injected) {
      this.injected = true;
      const all = Buffer.concat(this.buf);
      this.buf = [];
      cb(null, all);
      return;
    }
    cb();
  }
}

function passthroughProxy(req, res, upstream, logger, opts = {}) {
  const target = new URL(upstream);
  const headers = { ...req.headers };
  headers.host = target.host;
  // 同源改写：反代跨源时，Harness 的 CSRF 保护校验 Origin/Referer 必须匹配 Host。
  // 将 Origin/Referer 改写为 upstream 源，保证 host RPC（POST /api/*）不被 403。
  const targetOrigin = target.origin;
  if (headers.origin) headers.origin = targetOrigin;
  if (headers.referer) {
    try { headers.referer = String(headers.referer).replace(/^https?:\/\/[^/]+/, targetOrigin); } catch { /* 保留原值 */ }
  }

  const inject = opts.inject !== false; // 仅 HTML 主页面注入；静态资源不注入

  const preq = http.request({
    hostname: target.hostname,
    port: target.port || 80,
    path: req.url,
    method: req.method,
    headers,
  }, (pres) => {
    const contentType = pres.headers['content-type'] || '';
    const enc = (pres.headers['content-encoding'] || '').toLowerCase();

    if (inject && isHtmlPage(req, contentType) && !enc) {
      // 无压缩时走注入管道
      const outHeaders = rewriteLocation({ ...pres.headers }, req);
      delete outHeaders['content-length']; // 注入改变长度
      res.writeHead(pres.statusCode, outHeaders);
      pres.pipe(new InjectTransform()).pipe(res);
      return;
    }
    if (inject && isHtmlPage(req, contentType) && enc === 'gzip') {
      // gzip 页面：解压→注入→原样转发（编码改 identity）
      const outHeaders = rewriteLocation({ ...pres.headers, 'content-encoding': 'identity' }, req);
      delete outHeaders['content-length'];
      res.writeHead(pres.statusCode, outHeaders);
      pres.pipe(zlib.createGunzip()).pipe(new InjectTransform()).pipe(res);
      return;
    }
    // 其余（API、资源、压缩非 HTML）直通
    res.writeHead(pres.statusCode, rewriteLocation({ ...pres.headers }, req));
    pres.pipe(res);
  });

  preq.on('error', (err) => {
    logger.error({ msg: 'upstream_request_error', err: err.message, url: req.url });
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Gateway: upstream unreachable');
  });
  req.pipe(preq);
}

/** 把响应里的 Location/Content-Location 绝对源改写为客户端所见的网关源，让 302 重定向始终回到网关。 */
function rewriteLocation(headers, req) {
  const clientProto = (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) ? 'https' : 'http';
  const clientHost = req.headers.host;
  if (!clientHost) return headers;
  const clientOrigin = `${clientProto}://${clientHost}`;
  for (const h of ['location', 'content-location']) {
    if (headers[h]) {
      try {
        headers[h] = String(headers[h]).replace(/^https?:\/\/[^/]+/, clientOrigin);
      } catch { /* 保留原值 */ }
    }
  }
  return headers;
}

function upgradeProxy(req, socket, head, upstream, logger) {
  const target = new URL(upstream);
  const headers = { ...req.headers };
  headers.host = target.host;
  const targetOrigin = target.origin;
  if (headers.origin) headers.origin = targetOrigin;
  if (headers.referer) {
    try { headers.referer = String(headers.referer).replace(/^https?:\/\/[^/]+/, targetOrigin); } catch { /* 保留原值 */ }
  }

  const preq = http.request({
    hostname: target.hostname,
    port: target.port || 80,
    path: req.url,
    method: req.method || 'GET',
    headers,
  });
  preq.on('upgrade', (_pres, psocket, phead) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
      `Upgrade: ${_pres.headers.upgrade || 'websocket'}\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Accept: ${_pres.headers['sec-websocket-accept']}\r\n\r\n`);
    if (phead && phead.length) socket.write(phead);
    psocket.pipe(socket).pipe(psocket);
    psocket.on('error', () => socket.destroy());
    socket.on('error', () => psocket.destroy());
  });
  preq.on('error', (err) => {
    logger.error({ msg: 'upstream_ws_error', err: err.message });
    socket.destroy();
  });
  if (head && head.length) preq.write(head);
  preq.end();
}

module.exports = { passthroughProxy, upgradeProxy };
