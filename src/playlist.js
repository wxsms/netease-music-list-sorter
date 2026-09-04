'use strict';

/**
 * 歌单相关数据拉取。
 *
 * ncm-cli 接口返回结构(2026-09 实测,ncm-cli 0.1.6):
 * - `user favorite`        → { code, data: { id, name, trackCount, ... } }
 * - `playlist get`         → { code, data: { trackCount, ... } }
 * - `playlist tracks`      → { code, data: [track, ...] } (支持 --limit/--offset,每页最多 500)
 * - `playlist collected`   → { code, data: { recordCount, records: [{ id, name, trackCount, ... }] } }
 * - `playlist created`     → 结构同 collected
 * collected/created 支持 --limit(默认 20,最多 500)/--offset,recordCount 为总数。
 */

const { runNcm } = require('./ncm.js');

/**
 * 查询红心歌单,返回 { id, name, trackCount }。
 */
function fetchFavoritePlaylist() {
  const resp = runNcm(['user', 'favorite']);
  const data = resp.data || {};
  if (!data.id) {
    throw new Error(`user favorite 未返回 id,响应: ${JSON.stringify(resp)}`);
  }
  return { id: data.id, name: data.name, trackCount: data.trackCount };
}

/**
 * 兼容旧签名:只返回红心歌单 ID。
 */
function fetchFavoritePlaylistId() {
  return fetchFavoritePlaylist().id;
}

/**
 * 拉取歌单全部曲目(自动分页,每页 500)。
 * @param onProgress 可选回调 (loaded, total) => void,每页拉完调用一次。
 */
function fetchPlaylistTracks(playlistId, onProgress) {
  const meta = runNcm(['playlist', 'get', '--playlistId', playlistId]);
  let total = (meta.data || {}).trackCount || 0;
  if (!total) total = 500;

  const PAGE = 500;
  const tracks = [];
  let offset = 0;
  while (offset < total) {
    const limit = Math.min(PAGE, total - offset);
    const resp = runNcm([
      'playlist', 'tracks',
      '--playlistId', playlistId,
      '--limit', String(limit),
      '--offset', String(offset),
    ]);
    const page = resp.data || [];
    if (!page.length) break;
    tracks.push(...page);
    offset += page.length;
    if (onProgress) onProgress(tracks.length, total);
    if (page.length < limit) break;
  }

  if (tracks.length < total) {
    console.error(`[WARN] 期望 ${total} 首,只拿到 ${tracks.length} 首。可能是接口分页变化或部分歌曲已下架。`);
  }
  return tracks;
}

/**
 * 拉取歌单列表(collected / created),自动分页,返回 [{ id, name, trackCount }]。
 * 字段缺省容错:接口字段缺失时给空值,不让单条脏数据炸掉整个列表。
 */
function fetchPlaylistList(kind) {
  if (kind !== 'collected' && kind !== 'created') {
    throw new Error(`fetchPlaylistList: kind 必须是 'collected' 或 'created',收到 ${kind}`);
  }

  const PAGE = 500;
  const out = [];
  let offset = 0;
  let recordCount = Infinity;
  while (offset < recordCount) {
    const resp = runNcm(['playlist', kind, '--limit', String(PAGE), '--offset', String(offset)]);
    const data = resp.data || {};
    const records = Array.isArray(data.records) ? data.records : (Array.isArray(data) ? data : []);
    if (typeof data.recordCount === 'number') recordCount = data.recordCount;
    if (!records.length) break;
    for (const r of records) {
      if (!r || !r.id) continue;
      out.push({ id: r.id, name: r.name || '(未命名歌单)', trackCount: r.trackCount || 0 });
    }
    offset += records.length;
    if (records.length < Math.min(PAGE, recordCount - (offset - records.length))) break;
  }
  return out;
}

module.exports = { fetchFavoritePlaylist, fetchFavoritePlaylistId, fetchPlaylistTracks, fetchPlaylistList };
