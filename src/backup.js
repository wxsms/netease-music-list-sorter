'use strict';

/**
 * 备份 / 新顺序落盘 / 备份文件枚举。
 *
 * 目录结构(.cache/ 下按用途细分,文件名不带类型前缀——目录已表达类型):
 * - .cache/backups/<playlistId>-<YYYYMMDD-HHMMSS>.json   排序前的原始顺序(每次跑都写)
 * - .cache/new-order/<playlistId>.json                    排序后的新顺序(固定文件名,覆盖写)
 *
 * 兼容:旧版文件(output/ 下带前缀、.cache/ 子目录下带前缀)会在首次调用时自动迁移并重命名。
 */

const fs = require('fs');
const path = require('path');
const { firstArtist, albumInfo } = require('./sort.js');

// NCM_SORTER_HOME:测试注入用——覆盖仓库根目录,使 .cache/ 与 output/ 落到隔离位置
const REPO_ROOT = process.env.NCM_SORTER_HOME || path.join(__dirname, '..');
const CACHE_ROOT = path.join(REPO_ROOT, '.cache');
const BACKUP_DIR = path.join(CACHE_ROOT, 'backups');
const NEW_ORDER_DIR = path.join(CACHE_ROOT, 'new-order');
const LEGACY_OUTPUT_DIR = path.join(REPO_ROOT, 'output');

/**
 * 把旧版文件迁移到新结构并去掉类型前缀。幂等。
 * 兼容三种旧布局:output/ 平铺带前缀、.cache/ 子目录带前缀、.cache/ 子目录不带前缀(已是新命名)。
 */
function migrateLegacyOutput() {
  const moves = [
    // [源目录, 目标目录, 文件名匹配(捕获组 1 = 去掉前缀后的文件名)]
    { from: LEGACY_OUTPUT_DIR, to: BACKUP_DIR, pattern: /^backup-(.+\.json)$/ },
    { from: LEGACY_OUTPUT_DIR, to: NEW_ORDER_DIR, pattern: /^new-order-(.+\.json)$/ },
    { from: BACKUP_DIR, to: BACKUP_DIR, pattern: /^backup-(.+\.json)$/ },
    { from: NEW_ORDER_DIR, to: NEW_ORDER_DIR, pattern: /^new-order-(.+\.json)$/ },
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
  try {
    if (fs.existsSync(LEGACY_OUTPUT_DIR) && fs.readdirSync(LEGACY_OUTPUT_DIR).length === 0) {
      fs.rmdirSync(LEGACY_OUTPUT_DIR);
    }
  } catch {
    // 删除失败不影响功能
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
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const path_ = path.join(BACKUP_DIR, `${playlistId}-${ts}.json`);
  fs.writeFileSync(path_, JSON.stringify(snapshot(tracks), null, 2), 'utf8');
  return path_;
}

function writeNewOrder(playlistId, tracks) {
  migrateLegacyOutput();
  fs.mkdirSync(NEW_ORDER_DIR, { recursive: true });
  const path_ = path.join(NEW_ORDER_DIR, `${playlistId}.json`);
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
 * 枚举 .cache/backups/ 下的备份文件,按文件名时间戳倒序(最新在前)。
 * 返回 [{ path, playlistId, trackCount }],读取失败或无法解析 ID 的文件跳过。
 */
function listBackups() {
  migrateLegacyOutput();
  if (!fs.existsSync(BACKUP_DIR)) return [];
  const entries = fs.readdirSync(BACKUP_DIR)
    .filter(f => /^(?:backup-)?[A-F0-9]+-.+\.json$/.test(f))
    .sort()
    .reverse();

  const out = [];
  for (const f of entries) {
    const full = path.join(BACKUP_DIR, f);
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

module.exports = { snapshot, writeBackup, writeNewOrder, listBackups, readBackup, extractPlaylistIdFromFilename, migrateLegacyOutput, BACKUP_DIR, NEW_ORDER_DIR };
