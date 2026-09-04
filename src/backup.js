'use strict';

/**
 * 备份 / 新顺序落盘 / 备份文件枚举。
 *
 * 文件命名(与既有行为保持一致):
 * - output/backup-<playlistId>-<YYYYMMDD-HHMMSS>.json  排序前的原始顺序(每次跑都写)
 * - output/new-order-<playlistId>.json                 排序后的新顺序(固定文件名,覆盖写)
 */

const fs = require('fs');
const path = require('path');
const { firstArtist, albumInfo } = require('./sort.js');

const REPO_ROOT = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'output');

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
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const path_ = path.join(OUTPUT_DIR, `backup-${playlistId}-${ts}.json`);
  fs.writeFileSync(path_, JSON.stringify(snapshot(tracks), null, 2), 'utf8');
  return path_;
}

function writeNewOrder(playlistId, tracks) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const path_ = path.join(OUTPUT_DIR, `new-order-${playlistId}.json`);
  fs.writeFileSync(path_, JSON.stringify(snapshot(tracks), null, 2), 'utf8');
  return path_;
}

/**
 * 从 backup 文件名解析歌单 ID,解析不出返回 null。
 */
function extractPlaylistIdFromFilename(filename) {
  const m = filename.match(/backup-([A-F0-9]+)-/);
  return m ? m[1] : null;
}

/**
 * 枚举 output/ 下的备份文件,按文件名时间戳倒序(最新在前)。
 * 返回 [{ path, playlistId, trackCount }],读取失败或无法解析 ID 的文件跳过。
 */
function listBackups() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  const entries = fs.readdirSync(OUTPUT_DIR)
    .filter(f => /^backup-.+\.json$/.test(f))
    .sort()
    .reverse();

  const out = [];
  for (const f of entries) {
    const full = path.join(OUTPUT_DIR, f);
    const playlistId = extractPlaylistIdFromFilename(f);
    if (!playlistId) continue;
    let trackCount = null;
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (Array.isArray(data)) trackCount = data.length;
    } catch (e) {
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

module.exports = { snapshot, writeBackup, writeNewOrder, listBackups, readBackup, extractPlaylistIdFromFilename, OUTPUT_DIR };
