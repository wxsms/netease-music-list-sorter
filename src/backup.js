'use strict';

/**
 * 备份 / 新顺序落盘 / 备份文件枚举。
 *
 * 目录结构(用户级缓存目录下按用途细分,文件名不带类型前缀——目录已表达类型):
 * - <cacheHome>/backups/<playlistId>-<YYYYMMDD-HHMMSS>.json   排序前的原始顺序(每次跑都写)
 * - <cacheHome>/new-order/<playlistId>.json                    排序后的新顺序(固定文件名,覆盖写)
 *
 * 目录解析统一走 cache-home.js(用户目录,可用 NCM_SORTER_CACHE_HOME 覆盖)。
 * 兼容:旧版文件(仓库 output/ 下带前缀、仓库 .cache/ 子目录下带前缀)会在首次调用时自动迁移并重命名。
 */

const fs = require('fs');
const path = require('path');
const { firstArtist, albumInfo } = require('./sort.js');
const { cacheDir } = require('./cache-home.js');

// 仓库内旧版目录(迁移源,只读)
const REPO_ROOT = path.join(__dirname, '..');
const LEGACY_CACHE_ROOT = path.join(REPO_ROOT, '.cache');
const LEGACY_OUTPUT_DIR = path.join(REPO_ROOT, 'output');

/**
 * 把旧版文件迁移到新结构并去掉类型前缀。幂等。
 * 兼容三种旧布局:仓库 output/ 平铺带前缀、仓库 .cache/ 子目录带前缀、
 * 缓存目录内带前缀(上一版结构)、缓存目录内不带前缀(已是新命名,跳过)。
 */
function migrateLegacyOutput() {
  const backupDir = cacheDir('backups');
  const newOrderDir = cacheDir('new-order');
  const moves = [
    // [源目录, 目标目录, 文件名匹配(捕获组 1 = 去掉前缀后的文件名)]
    { from: LEGACY_OUTPUT_DIR, to: backupDir, pattern: /^backup-(.+\.json)$/ },
    { from: LEGACY_OUTPUT_DIR, to: newOrderDir, pattern: /^new-order-(.+\.json)$/ },
    { from: path.join(LEGACY_CACHE_ROOT, 'backups'), to: backupDir, pattern: /^backup-(.+\.json)$/ },
    { from: path.join(LEGACY_CACHE_ROOT, 'new-order'), to: newOrderDir, pattern: /^new-order-(.+\.json)$/ },
    { from: backupDir, to: backupDir, pattern: /^backup-(.+\.json)$/ },
    { from: newOrderDir, to: newOrderDir, pattern: /^new-order-(.+\.json)$/ },
  ];
  for (const { from, to, pattern } of moves) {
    if (!fs.existsSync(from)) continue;
    for (const f of fs.readdirSync(from)) {
      const m = f.match(pattern);
      if (!m) continue;
      fs.mkdirSync(to, { recursive: true });
      const dest = path.join(to, m[1]);
      if (!fs.existsSync(dest)) fs.renameSync(path.join(from, f), dest);
    }
  }
  // 旧目录空了就删掉;还有其它文件则保留(不动用户数据)
  for (const dir of [LEGACY_OUTPUT_DIR, path.join(LEGACY_CACHE_ROOT, 'backups'), path.join(LEGACY_CACHE_ROOT, 'new-order')]) {
    try {
      if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
      }
    } catch {
      // 删除失败不影响功能
    }
  }
}

function snapshot(tracks) {
  return tracks.map(t => ({
    id: t.id,
    originalId: t.originalId,
    name: t.name,
    artist: (firstArtist(t) || {}).name || null,
    album: (albumInfo(t) || {}).name || null,
  }));
}

function writeBackup(playlistId, tracks) {
  migrateLegacyOutput();
  const backupDir = cacheDir('backups');
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const path_ = path.join(backupDir, `${playlistId}-${ts}.json`);
  fs.writeFileSync(path_, JSON.stringify(snapshot(tracks), null, 2), 'utf8');
  return path_;
}

function writeNewOrder(playlistId, tracks) {
  migrateLegacyOutput();
  const newOrderDir = cacheDir('new-order');
  const path_ = path.join(newOrderDir, `${playlistId}.json`);
  fs.writeFileSync(path_, JSON.stringify(snapshot(tracks), null, 2), 'utf8');
  return path_;
}

/**
 * 从 backup 文件名解析歌单 ID,解析不出返回 null。
 * 兼容新命名(<pid>-<ts>.json)与旧命名(backup-<pid>-<ts>.json)。
 */
function extractPlaylistIdFromFilename(filename) {
  const m = filename.match(/^(?:backup-)?([A-F0-9]+)-/);
  return m ? m[1] : null;
}

/**
 * 枚举缓存目录 backups/ 下的备份文件,按文件名时间戳倒序(最新在前)。
 * 返回 [{ path, playlistId, trackCount }],读取失败或无法解析 ID 的文件跳过。
 */
function listBackups() {
  migrateLegacyOutput();
  const backupDir = cacheDir('backups');
  if (!fs.existsSync(backupDir)) return [];
  const entries = fs.readdirSync(backupDir)
    .filter(f => /^(?:backup-)?[A-F0-9]+-.+\.json$/.test(f))
    .sort()
    .reverse();

  const out = [];
  for (const f of entries) {
    const full = path.join(backupDir, f);
    const playlistId = extractPlaylistIdFromFilename(f);
    if (!playlistId) continue;
    let trackCount = null;
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (Array.isArray(data)) trackCount = data.length;
    } catch {
      // 损坏的备份文件:仍列出,trackCount 为 null
    }
    out.push({ path: full, playlistId, trackCount });
  }
  return out;
}

/**
 * 读取 backup 文件,返回 { tracks, encIds }。文件不存在/格式不对时抛错。
 */
function readBackup(backupPath) {
  const full = path.resolve(backupPath);
  if (!fs.existsSync(full)) {
    throw new Error(`文件不存在: ${full}`);
  }
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (!Array.isArray(data)) {
    throw new Error('backup 文件不是 JSON 数组');
  }
  return { tracks: data, encIds: data.map(t => t.id).filter(Boolean), path: full };
}

module.exports = { snapshot, writeBackup, writeNewOrder, listBackups, readBackup, extractPlaylistIdFromFilename, migrateLegacyOutput };
