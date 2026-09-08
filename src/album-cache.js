'use strict';

/**
 * album tracks 的三级缓存:进程内 Map → 磁盘 <cacheHome>/albums/*.json → ncm-cli 接口。
 *
 * 缓存的是 album tracks 的完整返回(歌名、艺人、时长、专辑内顺序等),其它功能可自由读取。
 * 旧格式缓存(只存 encId 列表)在读取时会被自动忽略并重新拉接口升级。
 * 旧版平铺在仓库 .cache/ 根目录的 album-*.json 会在首次访问时自动迁移到新缓存目录并去掉前缀。
 *
 * 目录解析统一走 cache-home.js(用户目录,可用 NCM_SORTER_CACHE_HOME 覆盖)。
 */

const fs = require('fs');
const path = require('path');
const { runNcm, runNcmAsync } = require('./ncm.js');
const { cacheDir } = require('./cache-home.js');

// 仓库内旧版目录(迁移源,只读)
const REPO_ROOT = path.join(__dirname, '..');
const LEGACY_CACHE_ROOT = path.join(REPO_ROOT, '.cache');

function cachePathForAlbum(albumId) {
  const safe = albumId.replace(/[^A-Za-z0-9]/g, '_');
  return path.join(cacheDir('albums'), `${safe}.json`);
}

/**
 * 把旧版平铺在仓库 .cache/ 根目录的 album-*.json 迁移到新缓存目录的 albums/ 并去掉 album- 前缀。
 * 同时兼容迁移到 albums/ 但仍带前缀的文件(上一版结构)。幂等。
 */
function migrateLegacyAlbumCache() {
  const albumDir = cacheDir('albums');
  // 仓库 .cache/ 根目录的 album-*.json
  if (fs.existsSync(LEGACY_CACHE_ROOT)) {
    for (const f of fs.readdirSync(LEGACY_CACHE_ROOT)) {
      if (!/^album-.+\.json$/.test(f)) continue;
      const dest = path.join(albumDir, f.replace(/^album-/, ''));
      if (!fs.existsSync(dest)) fs.renameSync(path.join(LEGACY_CACHE_ROOT, f), dest);
    }
  }
  // albums/ 内仍带前缀的文件(上一版结构)
  if (fs.existsSync(albumDir)) {
    for (const f of fs.readdirSync(albumDir)) {
      if (!/^album-.+\.json$/.test(f)) continue;
      const dest = path.join(albumDir, f.replace(/^album-/, ''));
      if (!fs.existsSync(dest)) fs.renameSync(path.join(albumDir, f), dest);
    }
  }
}

const albumCache = new Map(); // albumId -> list of track dicts

function fetchAlbumTracks(albumId) {
  if (albumCache.has(albumId)) return albumCache.get(albumId);

  migrateLegacyAlbumCache();
  const diskPath = cachePathForAlbum(albumId);
  if (fs.existsSync(diskPath)) {
    try {
      const rows = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
      if (Array.isArray(rows) && rows.every(r => r && typeof r === 'object' && !Array.isArray(r))) {
        albumCache.set(albumId, rows);
        return rows;
      }
    } catch {
      // 缓存损坏,继续走接口
    }
  }

  const resp = runNcm(['album', 'tracks', '--albumId', albumId]);
  const rows = resp.data || [];
  albumCache.set(albumId, rows);

  fs.mkdirSync(path.dirname(diskPath), { recursive: true });
  fs.writeFileSync(diskPath, JSON.stringify(rows, null, 2), 'utf8');
  return rows;
}

function fetchAlbumTrackOrder(albumId) {
  return fetchAlbumTracks(albumId).map(r => r.id).filter(Boolean);
}

/**
 * 并发预取专辑数据(异步,不阻塞事件循环)。
 *
 * 缓存命中的专辑直接跳过(不发起请求);未命中的用 runNcmAsync 并发拉取,
 * 限流 concurrency(默认 8,避免压垮 ncm-cli/接口)。拉到的数据写入三级缓存,
 * 之后 computeNewOrder 走同步路径时全部内存命中。
 *
 * 单张专辑失败不中断整体(与同步路径的降级语义一致:computeNewOrder 里
 * getAlbumTrackOrder 抛错会退化为原顺序),只统计失败数。
 *
 * @param {string[]} albumIds 需要的专辑 ID 列表
 * @param {(done, total) => void} onProgress 可选进度回调(含缓存命中)
 * @param {number} concurrency 并发上限,默认 8
 * @returns {Promise<{fetched: number, failed: number, cached: number}>}
 */
async function prefetchAlbums(albumIds, onProgress, concurrency = 8) {
  migrateLegacyAlbumCache();

  // 先筛出真正需要拉接口的(内存/磁盘缓存命中)
  const pending = [];
  let cached = 0;
  for (const id of albumIds) {
    if (albumCache.has(id)) { cached++; continue; }
    const diskPath = cachePathForAlbum(id);
    let hit = false;
    if (fs.existsSync(diskPath)) {
      try {
        const rows = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
        if (Array.isArray(rows) && rows.every(r => r && typeof r === 'object' && !Array.isArray(r))) {
          albumCache.set(id, rows);
          hit = true;
        }
      } catch { /* 缓存损坏,走接口 */ }
    }
    if (hit) cached++; else pending.push(id);
  }

  const total = albumIds.length;
  let done = cached;
  let fetched = 0;
  let failed = 0;
  if (onProgress) onProgress(done, total);

  // 限流并发:worker 池模式
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const id = pending[cursor++];
      try {
        const resp = await runNcmAsync(['album', 'tracks', '--albumId', id]);
        const rows = resp.data || [];
        albumCache.set(id, rows);
        const diskPath = cachePathForAlbum(id);
        fs.mkdirSync(path.dirname(diskPath), { recursive: true });
        fs.writeFileSync(diskPath, JSON.stringify(rows, null, 2), 'utf8');
        fetched++;
      } catch {
        failed++;
      }
      done++;
      if (onProgress) onProgress(done, total);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, () => worker());
  await Promise.all(workers);
  return { fetched, failed, cached };
}

/** 当前进程已加载的专辑数(含缓存命中),用于统计输出。 */
function loadedAlbumCount() {
  return albumCache.size;
}

module.exports = { fetchAlbumTracks, fetchAlbumTrackOrder, prefetchAlbums, loadedAlbumCount, cachePathForAlbum };
