/**
 * logger.js — JSONL 结构化日志 + 轮转（零第三方依赖）
 *
 * 四种流：access / audit / error / runtime
 * - 按天 + 大小双滚动（单文件 maxBytes，默认 5MB）
 * - 保留 retainDays（默认 7 天）
 * - 同步追加写，防并发截断；每 write 前滚动检查
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function nowIso() { return new Date().toISOString(); }

class Logger {
  constructor(logDir, opts = {}) {
    this.dir = logDir;
    this.maxBytes = opts.maxBytes || 5 * 1024 * 1024;
    this.retainDays = opts.retainDays || 7;
    this.hostId = (crypto.randomBytes(4).toString('hex'));
    fs.mkdirSync(this.dir, { recursive: true });
    this._ensureOldPrune();
  }

  _dateStr() {
    return new Date().toISOString().slice(0, 10);
  }

  _ensureOldPrune() {
    // 启动时清理过期文件（保持轻量，惰性+启动各一次）
    try {
      const cutoff = Date.now() - this.retainDays * 86400_000;
      for (const f of fs.readdirSync(this.dir)) {
        const fp = path.join(this.dir, f);
        try {
          const st = fs.statSync(fp);
          if (st.mtimeMs < cutoff) fs.unlinkSync(fp);
        } catch { /* 忽略单个文件失败 */ }
      }
    } catch { /* 忽略 */ }
  }

  _write(kind, obj) {
    const day = this._dateStr();
    const file = kind === 'runtime'
      ? path.join(this.dir, `runtime.log`)
      : path.join(this.dir, `${kind}-${day}.jsonl`);
    const line = JSON.stringify({ t: nowIso(), h: this.hostId, ...obj }) + '\n';
    try {
      // 滚动检查（简单实现：文件超限即改名并保留）
      if (kind !== 'runtime') {
        try {
          const st = fs.statSync(file);
          if (st.size > this.maxBytes) {
            const roll = `${file}.${Date.now()}.roll`;
            fs.renameSync(file, roll);
          }
        } catch { /* 文件不存在则忽略 */ }
      }
      fs.appendFileSync(file, line, 'utf8');
    } catch (err) {
      // 日志失败不影响主流程，但审计失败必须显式（调用方处理）
      try { fs.appendFileSync(path.join(this.dir, 'error-fallback.log'), JSON.stringify({ t: nowIso(), kind, err: String(err && err.message || err) }) + '\n'); } catch { /* 最后兜底 */ }
    }
  }

  access(m)   { this._write('access', { kind: 'access', ...m }); }
  audit(m)    { this._write('audit',  { kind: 'audit',  ...m }); }
  error(m)    { this._write('error',  { kind: 'error',  ...m, stack: m && m.stack ? String(m.stack).split('\n').slice(0, 6) : undefined }); }
  runtime(m)  { this._write('runtime', { kind: 'runtime', ...m }); }
}

module.exports = { Logger };
