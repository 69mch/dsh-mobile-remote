/**
 * session.js — 无状态设备会话（HMAC 签名 Cookie）
 *
 * Cookie 形如：dshgw_session=<deviceId>.<expEpoch>.<sigHex>
 * - 密钥持久化于 config/session.key（首次生成 32B hex）；网关重启会话不失效。
 * - 有效期 sessionTtlDays（默认 30 天），到期自然失效。
 * - 校验失败/过期 → 401，App 回配对页（同设备可重配）。
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'dshgw_session';

function loadKey(keyFile) {
  try {
    if (fs.existsSync(keyFile)) {
      const k = fs.readFileSync(keyFile, 'utf8').trim();
      if (k) return k;
    }
  } catch { /* 重建 */ }
  const key = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, key, { encoding: 'utf8', mode: 0o600 });
  return key;
}

class Session {
  constructor(keyFile, ttlDays) {
    this.key = loadKey(keyFile);
    this.ttlMs = (ttlDays || 30) * 86400_000;
  }

  _sig(payload) {
    return crypto.createHmac('sha256', this.key).update(payload).digest('hex').slice(0, 32);
  }

  /** 签发 Cookie 值（明文 deviceId + exp + 签名） */
  issue(deviceId) {
    const exp = Math.floor((Date.now() + this.ttlMs) / 1000);
    const payload = `${deviceId}.${exp}`;
    return { value: `${payload}.${this._sig(payload)}`, exp };
  }

  /** 校验 Cookie 值 → 返回 {deviceId, exp} 或 null */
  verify(cookieValue) {
    if (!cookieValue) return null;
    const parts = String(cookieValue).split('.');
    if (parts.length !== 3) return null;
    const [deviceId, expStr, sig] = parts;
    const exp = Number(expStr);
    if (!exp || exp < Math.floor(Date.now() / 1000)) return null; // 过期
    const payload = `${deviceId}.${expStr}`;
    const expect = this._sig(payload);
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expect, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (!deviceId) return null;
    return { deviceId, exp };
  }

  cookieHeader(value, maxAgeSec, secure) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}` + (secure ? '; Secure' : '');
  }
}

module.exports = { Session, COOKIE };
