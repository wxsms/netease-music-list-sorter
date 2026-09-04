'use strict';

/**
 * 排序核心:按"专辑优先 + 艺人首次出现"规则重排歌单曲目。
 *
 * 纯函数模块:不做任何 IO。专辑内顺序通过 getAlbumTrackOrder(albumId) 回调注入,
 * 由调用方决定走缓存还是接口(便于单测与复用)。
 *
 * 规则:
 * 1. 专辑作为顶层聚合单位:每张专辑的所有歌连在一起,按专辑内顺序排,不被艺人拆散。
 * 2. 专辑归属艺人 = 该专辑在原歌单里最早出现那首歌的 artists[0]。
 * 3. 艺人之间:按归属艺人在原歌单里的首次出现位置升序。
 * 4. 同一艺人多张专辑:按各自第一首歌在原歌单中的位置升序。
 * 5. 无专辑信息的歌:归到 __unknown__ 虚拟艺人名下,按首次出现位置插入主排序。
 */

function firstArtist(track) {
  const artists = track.artists || track.fullArtists || [];
  return artists[0] || null;
}

function albumInfo(track) {
  return track.album || null;
}

function artistKey(artist) {
  if (!artist) return '__unknown__';
  return String(artist.originalId || artist.id || `enc:${artist.id}`);
}

/**
 * 收集曲目里出现的专辑 ID(去重,保持首次出现顺序),供并发预取用。
 */
function collectAlbumIds(tracks) {
  const seen = new Set();
  const ids = [];
  for (const t of tracks) {
    const al = albumInfo(t);
    const id = al && al.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * 计算新顺序。
 *
 * @param {Array} tracks 歌单曲目(原顺序)
 * @param {(albumId: string) => string[]} getAlbumTrackOrder 返回专辑内 encId 顺序;抛错时本函数退化为原顺序
 * @param {object} [hooks] 可选钩子:
 *   - onAlbumStart(albumCount): 专辑遍历开始时调用一次,告知专辑总数(不含 __no_album__)
 *   - onAlbumDone(albumId): 每张专辑处理完调用一次(含缓存命中)
 * @returns {Array} 重排后的曲目数组
 */
function computeNewOrder(tracks, getAlbumTrackOrder, hooks) {
  hooks = hooks || {};
  // 1) 按专辑分组
  const albumGroups = new Map(); // albumKey -> [trackIndex...]
  for (let i = 0; i < tracks.length; i++) {
    const al = albumInfo(tracks[i]);
    const alKey = (al && al.id) || '__no_album__';
    if (!albumGroups.has(alKey)) albumGroups.set(alKey, []);
    albumGroups.get(alKey).push(i);
  }

  if (hooks.onAlbumStart) hooks.onAlbumStart([...albumGroups.keys()].filter(k => k !== '__no_album__').length);

  // 2) 每张专辑的归属艺人 + 在原歌单中首次位置
  const albumMeta = new Map(); // alKey -> { ownerKey, firstPos }
  for (const [alKey, idxs] of albumGroups) {
    const firstIdx = idxs[0];
    const owner = firstArtist(tracks[firstIdx]);
    albumMeta.set(alKey, { ownerKey: artistKey(owner), firstPos: firstIdx });
  }

  // 3) 每个 owner 在原歌单里首次出现位置(用于艺人之间排序)
  const ownerFirstPos = new Map();
  for (let i = 0; i < tracks.length; i++) {
    const k = artistKey(firstArtist(tracks[i]));
    if (!ownerFirstPos.has(k)) ownerFirstPos.set(k, i);
  }

  // 4) 把专辑归到 owner 名下
  const ownerAlbums = new Map(); // ownerKey -> [albumKey...]
  for (const [alKey, meta] of albumMeta) {
    if (!ownerAlbums.has(meta.ownerKey)) ownerAlbums.set(meta.ownerKey, []);
    ownerAlbums.get(meta.ownerKey).push(alKey);
  }

  // owner 之间排序(__unknown__ 落到末尾)
  const ownerOrder = [...ownerAlbums.keys()].sort((a, b) => {
    const pa = ownerFirstPos.has(a) ? ownerFirstPos.get(a) : tracks.length + 1;
    const pb = ownerFirstPos.has(b) ? ownerFirstPos.get(b) : tracks.length + 1;
    return pa - pb;
  });

  const newTracks = [];
  for (const ownerKey of ownerOrder) {
    const albumKeys = ownerAlbums.get(ownerKey).sort((a, b) => albumMeta.get(a).firstPos - albumMeta.get(b).firstPos);

    for (const alKey of albumKeys) {
      const idxList = albumGroups.get(alKey);
      if (alKey === '__no_album__') {
        for (const idx of idxList) newTracks.push(tracks[idx]);
        continue;
      }

      let albumOrder;
      try {
        albumOrder = getAlbumTrackOrder(alKey);
      } catch (e) {
        console.error(`[WARN] 拉专辑 ${alKey} 顺序失败: ${e.message},退化为原顺序`);
        albumOrder = [];
      }
      if (hooks.onAlbumDone) hooks.onAlbumDone(alKey);

      const inAlbum = [];
      const outAlbum = [];
      for (const idx of idxList) {
        const encId = tracks[idx].id;
        if (albumOrder.includes(encId)) inAlbum.push(idx);
        else outAlbum.push(idx);
      }
      inAlbum.sort((ia, ib) => albumOrder.indexOf(tracks[ia].id) - albumOrder.indexOf(tracks[ib].id));
      for (const idx of inAlbum) newTracks.push(tracks[idx]);
      for (const idx of outAlbum) newTracks.push(tracks[idx]);
    }
  }
  return newTracks;
}

module.exports = { computeNewOrder, collectAlbumIds, firstArtist, albumInfo, artistKey };
