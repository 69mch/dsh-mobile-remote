/**
 * store.js — 内存会话/计数存储 + 定期清理（内存与垃圾数据管理）
 * - sessions: 登录会话 Map（sessionId -> {user, expiresAt}），LRU 上限 + 定时清理
 * - counters: 限流/登录失败计数滑动窗口，定时清理过期 key
 */
'use strict';

class MemoryStore {
  constructor(opts = {}) {
    this.maxSessions = opts.maxSessions || 200;
    this.sessions = new Map();     // id -> { user, expiresAt, lastSeen }
    this.counters = new Map();     // key -> { wins: [{ts}] }
    this.fail = new Map();         // ip -> { count, lockedUntil }
    this._timer = setInterval(() => this._cleanup(), 60_000);
    if (this._timer.unref) this._timer.unref();
  }

  // ---------- 会话 ----------
  createSession(user, ttlMs, fixedId) {
    const id = fixedId || require('crypto').randomBytes(24).toString('hex');
    if (!fixedId) {
      if (this.sessions.size >= this.maxSessions) {
        // LRU：淘汰最早 lastSeen
        let oldest = null;
        for (const [k, v] of this.sessions) {
          if (!oldest || v.lastSeen < oldest.v.lastSeen) oldest = { k, v };
        }
        if (oldest) this.sessions.delete(oldest.k);
      }
    }
    this.sessions.set(id, { user, expiresAt: Date.now() + ttlMs, lastSeen: Date.now() });
    return id;
  }

  getSession(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expiresAt < Date.now()) { this.sessions.delete(id); return null; }
    s.lastSeen = Date.now();
    return s;
  }

  destroySession(id) { this.sessions.delete(id); }

  // ---------- 登录失败锁定 ----------
  isLocked(ip) {
    const f = this.fail.get(ip);
    if (!f) return false;
    if (f.lockedUntil && f.lockedUntil > Date.now()) return true;
    if (f.lockedUntil && f.lockedUntil <= Date.now()) this.fail.delete(ip);
    return false;
  }

  recordFail(ip, lockAfter = 5, lockMs = 15 * 60_000) {
    const f = this.fail.get(ip) || { count: 0, lockedUntil: 0 };
    f.count += 1;
    if (f.count >= lockAfter) {
      f.lockedUntil = Date.now() + lockMs;
      f.count = 0;
    }
    this.fail.set(ip, f);
  }

  clearFail(ip) { this.fail.delete(ip); }

  // ---------- 限流（滑动窗口） ----------
  hit(key, windowMs, limit) {
    const now = Date.now();
    let arr = this.counters.get(key);
    if (!arr) { arr = []; this.counters.set(key, arr); }
    // 剪掉窗口外的
    while (arr.length && arr[0] < now - windowMs) arr.shift();
    if (arr.length >= limit) return false;
    arr.push(now);
    return true;
  }

  _cleanup() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.expiresAt < now) this.sessions.delete(id);
    }
    for (const [k, arr] of this.counters) {
      while (arr.length && arr[0] < now - 300_000) arr.shift();
      if (!arr.length) this.counters.delete(k);
    }
    for (const [ip, f] of this.fail) {
      if (f.lockedUntil && f.lockedUntil < now) this.fail.delete(ip);
    }
  }

  close() { clearInterval(this._timer); }
}

module.exports = { MemoryStore };
