'use strict';

/**
 * album tracks 的三级缓存:进程内 Map → 磁盘 .cache/album-*.json → ncm-cli 接口。
 *
 * 缓存的是 album tracks 的完整返回(歌名、艺人、时长、专辑内顺序等),其它功能可自由读取。
 * 旧格式缓存(只存 encId 列表)在读取时会被自动忽略并重新拉接口升级。
 */

const fs = require('fs');
const path = require('path');
const { runNcm } = require('./ncm.js');

const REPO_ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(REPO_ROOT, '.cache');

function cachePathForAlbum(albumId) {
  const safe = albumId.replace(/[^A-Za-z0-9]/g, '_');
  return path.join(CACHE_DIR, `album-${safe}.json`);
}

const albumCache = new Map(); // albumId -> list of track dicts

function fetchAlbumTracks(albumId) {
  if (albumCache.has(albumId)) return albumCache.get(albumId);

  const diskPath = cachePathForAlbum(albumId);
  if (fs.existsSync(diskPath)) {
    try {
      const rows = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
      if (Array.isArray(rows) && rows.every(r => r && typeof r === 'object' && !Array.isArray(r))) {
        albumCache.set(albumId, rows);
        return rows;
      }
    } catch (e) {
      // 缓存损坏,继续走接口
    }
  }

  const resp = runNcm(['album', 'tracks', '--albumId', albumId]);
  const rows = resp.data || [];
  albumCache.set(albumId, rows);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(diskPath, JSON.stringify(rows, null, 2), 'utf8');
  return rows;
}

function fetchAlbumTrackOrder(albumId) {
  return fetchAlbumTracks(albumId).map(r => r.id).filter(Boolean);
}

/** 当前进程已加载的专辑数(含缓存命中),用于统计输出。 */
function loadedAlbumCount() {
  return albumCache.size;
}

module.exports = { fetchAlbumTracks, fetchAlbumTrackOrder, loadedAlbumCount, cachePathForAlbum };
