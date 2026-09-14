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
 * 从(已按歌手块排列的)曲目序列中提取歌手块。
 *
 * 全局按 artistKey 合并:同一歌手的所有段合成一个块(曲目按出现顺序拼接)。
 * 这与排序规则"同一艺人的多张专辑挨着出现"一致——合辑场景下同一歌手会出现在
 * 多张不同合辑里,产生多个同名块,合并后调整界面不再出现重复歌手项。
 *
 * @param {Array} tracks 已按歌手块排列的曲目(如 computeNewOrder 的输出)
 * @returns {Array} [{ artistKey, displayName, tracks }],块内 track 对象与输入共享引用
 */
function extractArtistBlocks(tracks) {
  const byKey = new Map(); // artistKey -> block(保持首次出现顺序)
  const order = [];
  for (const t of tracks) {
    const key = artistKey(firstArtist(t));
    let block = byKey.get(key);
    if (!block) {
      const artist = firstArtist(t);
      block = {
        artistKey: key,
        displayName: (artist && artist.name) || '(无歌手信息)',
        tracks: [],
      };
      byKey.set(key, block);
      order.push(key);
    }
    block.tracks.push(t);
  }
  return order.map(k => byKey.get(k));
}

/**
 * 按目标歌手 key 顺序重排歌手块,块内曲目顺序不变。
 *
 * 未出现在 artistOrder 中的块按原相对顺序追加末尾(容错:调用方漏传不丢歌)。
 *
 * @param {Array} tracks 已按歌手块排列的曲目
 * @param {string[]} artistOrder 目标歌手 key 顺序(如 extractArtistBlocks 返回的 artistKey 列表)
 * @returns {Array} 重排后的曲目
 */
function reorderByArtistBlocks(tracks, artistOrder) {
  const blocks = extractArtistBlocks(tracks);
  const byKey = new Map(blocks.map(b => [b.artistKey, b]));

  const out = [];
  const used = new Set();
  for (const key of artistOrder) {
    const b = byKey.get(key);
    if (!b || used.has(key)) continue;
    used.add(key);
    out.push(...b.tracks);
  }
  for (const b of blocks) {
    if (used.has(b.artistKey)) continue;
    out.push(...b.tracks);
  }
  return out;
}

/**
 * 中位数:排序后取中间元素,偶数个取中间两数平均。
 * 用于"最集中位置"策略:对个别离群歌不敏感。
 */
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 计算新顺序。
 *
 * @param {Array} tracks 歌单曲目(原顺序)
 * @param {(albumId: string) => string[]} getAlbumTrackOrder 返回专辑内 encId 顺序;抛错时本函数退化为原顺序
 * @param {object} [hooks] 可选钩子:
 *   - onAlbumStart(albumCount): 专辑遍历开始时调用一次,告知专辑总数(不含 __no_album__)
 *   - onAlbumDone(albumId): 每张专辑处理完调用一次(含缓存命中)
 * @param {object} [opts] 可选选项:
 *   - positionMode: 'first'(默认,按首次出现位置) | 'median'(按曲目位置中位数,即"最集中位置")
 * @returns {Array} 重排后的曲目数组
 */
function computeNewOrder(tracks, getAlbumTrackOrder, hooks, opts) {
  hooks = hooks || {};
  const medianMode = !!(opts && opts.positionMode === 'median');
  // 1) 按专辑分组
  const albumGroups = new Map(); // albumKey -> [trackIndex...]
  for (let i = 0; i < tracks.length; i++) {
    const al = albumInfo(tracks[i]);
    const alKey = (al && al.id) || '__no_album__';
    if (!albumGroups.has(alKey)) albumGroups.set(alKey, []);
    albumGroups.get(alKey).push(i);
  }

  if (hooks.onAlbumStart) hooks.onAlbumStart([...albumGroups.keys()].filter(k => k !== '__no_album__').length);

  // 2) 每张专辑的归属艺人 + 归属位置
  //    first 模式:最早出现那首歌的位置;median 模式:该专辑全部曲目位置的中位数
  const albumMeta = new Map(); // alKey -> { ownerKey, pos }
  for (const [alKey, idxs] of albumGroups) {
    const firstIdx = idxs[0];
    const owner = firstArtist(tracks[firstIdx]);
    const pos = medianMode ? median(idxs) : firstIdx;
    albumMeta.set(alKey, { ownerKey: artistKey(owner), pos });
  }

  // 3) 每个 owner 的排序键
  //    first 模式:首次出现位置;median 模式:该 owner 全部曲目位置的中位数
  const ownerPos = new Map();
  const ownerAllIdx = new Map(); // ownerKey -> [idx...](median 模式用)
  for (let i = 0; i < tracks.length; i++) {
    const k = artistKey(firstArtist(tracks[i]));
    if (medianMode) {
      if (!ownerAllIdx.has(k)) ownerAllIdx.set(k, []);
      ownerAllIdx.get(k).push(i);
    } else if (!ownerPos.has(k)) {
      ownerPos.set(k, i);
    }
  }
  if (medianMode) {
    for (const [k, idxs] of ownerAllIdx) ownerPos.set(k, median(idxs));
  }

  // 4) 把专辑归到 owner 名下
  const ownerAlbums = new Map(); // ownerKey -> [albumKey...]
  for (const [alKey, meta] of albumMeta) {
    if (!ownerAlbums.has(meta.ownerKey)) ownerAlbums.set(meta.ownerKey, []);
    ownerAlbums.get(meta.ownerKey).push(alKey);
  }

  // owner 之间排序(__unknown__ 落到末尾)
  const ownerOrder = [...ownerAlbums.keys()].sort((a, b) => {
    const pa = ownerPos.has(a) ? ownerPos.get(a) : tracks.length + 1;
    const pb = ownerPos.has(b) ? ownerPos.get(b) : tracks.length + 1;
    return pa - pb;
  });

  const newTracks = [];
  for (const ownerKey of ownerOrder) {
    const albumKeys = ownerAlbums.get(ownerKey).sort((a, b) => albumMeta.get(a).pos - albumMeta.get(b).pos);

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

/**
 * 按"加入歌单时间"排序:曲目按 extMap.addTime(毫秒时间戳)排列。
 *
 * 纯单曲级排序,不聚合专辑、不依赖专辑数据。
 * 容错:extMap 或 addTime 缺失的曲目按原相对顺序追加在末尾(不丢歌);
 * 同时间戳时保持原顺序(Array.prototype.sort 在 V8 中稳定)。
 *
 * @param {Array} tracks 歌单曲目
 * @param {object} [opts] { descending: false } 设为 true 时按时间降序(最新加入在前)
 */
function sortByAddTime(tracks, opts) {
  const descending = !!(opts && opts.descending);
  const withTime = [];
  const withoutTime = [];
  for (const t of tracks) {
    const ts = t.extMap && t.extMap.addTime;
    if (typeof ts === 'number') withTime.push({ t, ts });
    else withoutTime.push(t);
  }
  withTime.sort((a, b) => (descending ? b.ts - a.ts : a.ts - b.ts));
  return [...withTime.map(x => x.t), ...withoutTime];
}

module.exports = { computeNewOrder, sortByAddTime, collectAlbumIds, extractArtistBlocks, reorderByArtistBlocks, firstArtist, albumInfo, artistKey };
