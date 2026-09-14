'use strict';

/**
 * sort.js 纯函数单元测试(Jest)。
 *
 * 覆盖:排序核心规则、专辑归属、无专辑兜底、歌手块全局合并(去重修复)、
 * 歌手块重排容错、artistKey/firstArtist 边界。
 */

const {
  computeNewOrder,
  sortByAddTime,
  collectAlbumIds,
  extractArtistBlocks,
  reorderByArtistBlocks,
  artistKey,
  firstArtist,
  albumInfo,
} = require('../src/sort.js');

/** 造一首歌:artists[0] 决定归属,album 为 null 表示无专辑信息。 */
function track(id, artistName, artistId, albumId) {
  return {
    id,
    name: `song-${id}`,
    artists: [{ id: artistId, name: artistName }],
    album: albumId ? { id: albumId, name: `album-${albumId}` } : null,
  };
}

const ids = tracks => tracks.map(t => t.id);

// ---------- computeNewOrder ----------

describe('computeNewOrder', () => {
  test('专辑聚合 + 艺人按首次出现 + 专辑内按接口顺序', () => {
    // 原歌单:A/B 交错,同专辑的歌被打散
    const tracks = [
      track('x2', 'A', 'a', 'X'), // A 的专辑 X(第 2 首)
      track('z1', 'B', 'b', 'Z'), // B 的专辑 Z(第 1 首)
      track('x1', 'A', 'a', 'X'), // A 的专辑 X(第 1 首)
      track('y1', 'A', 'a', 'Y'), // A 的专辑 Y
      track('z2', 'B', 'b', 'Z'), // B 的专辑 Z(第 2 首)
    ];
    const albumOrder = { X: ['x1', 'x2'], Y: ['y1'], Z: ['z1', 'z2'] };
    const out = computeNewOrder(tracks, albumId => albumOrder[albumId]);

    // A 首次出现更早 → A 在前;A 的专辑按各自首歌位置 X→Y;专辑内按接口顺序
    expect(ids(out)).toEqual(['x1', 'x2', 'y1', 'z1', 'z2']);
  });

  test('合辑整张归到第一首歌的艺人,不被拆散', () => {
    const tracks = [
      track('h1', 'A', 'a', 'H'), // 合辑 H 第一首是 A → 整张归 A
      track('h2', 'C', 'c', 'H'), // H 内 C 主唱的歌,仍留在 H 里
      track('n1', 'B', 'b', null), // 无专辑
    ];
    const out = computeNewOrder(tracks, () => ['h1', 'h2']);
    expect(ids(out)).toEqual(['h1', 'h2', 'n1']);
  });

  test('无专辑的歌归 __unknown__,按首次出现位置插入主排序', () => {
    // __unknown__ 首次出现在位置 1(A 之后、C 之前)→ 整块插在 A 与 C 之间
    const tracks = [
      track('x1', 'A', 'a', 'X'),
      track('n1', 'B', 'b', null),
      track('y1', 'C', 'c', 'Y'),
      track('n2', 'D', 'd', null),
    ];
    const out = computeNewOrder(tracks, () => []);
    expect(ids(out)).toEqual(['x1', 'n1', 'n2', 'y1']);
  });

  test('接口抛错时专辑内退化为原顺序', () => {
    const tracks = [
      track('x2', 'A', 'a', 'X'),
      track('x1', 'A', 'a', 'X'),
    ];
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {}); // 静音 [WARN]
    try {
      const out = computeNewOrder(tracks, () => { throw new Error('boom'); });
      expect(ids(out)).toEqual(['x2', 'x1']);
    } finally {
      spy.mockRestore();
    }
  });

  test('不在接口返回顺序里的歌追加在专辑末尾', () => {
    const tracks = [
      track('x9', 'A', 'a', 'X'), // 接口不认识 x9
      track('x1', 'A', 'a', 'X'),
    ];
    const out = computeNewOrder(tracks, () => ['x1']);
    expect(ids(out)).toEqual(['x1', 'x9']);
  });

  test('空歌单返回空数组', () => {
    expect(computeNewOrder([], () => [])).toEqual([]);
  });

  test('hooks 回调计数正确', () => {
    const tracks = [
      track('x1', 'A', 'a', 'X'),
      track('y1', 'A', 'a', 'Y'),
      track('n1', 'B', 'b', null),
    ];
    const started = [];
    const done = [];
    computeNewOrder(tracks, () => [], {
      onAlbumStart: n => started.push(n),
      onAlbumDone: id => done.push(id),
    });
    expect(started).toEqual([2]); // 不含 __no_album__
    expect([...done].sort()).toEqual(['X', 'Y']);
  });
});

// ---------- computeNewOrder positionMode: 'median' ----------

describe('computeNewOrder median 模式', () => {
  test('歌手块按中位数排,离群首歌不拉偏', () => {
    // A 只有一首歌在开头(位置 0),其余 4 首集中在末尾 → A 的中位数靠后
    // B 的歌全在中间 → B 的中位数更小,B 排在 A 前(first 模式则 A 在前)
    const tracks = [
      track('a0', 'A', 'a', 'X0'),           // 0:A 的离群歌
      track('b1', 'B', 'b', 'Z'),            // 1
      track('b2', 'B', 'b', 'Z'),            // 2
      track('b3', 'B', 'b', 'Z'),            // 3
      track('a1', 'A', 'a', 'X1'),           // 4
      track('a2', 'A', 'a', 'X1'),           // 5
      track('a3', 'A', 'a', 'X2'),           // 6
      track('a4', 'A', 'a', 'X2'),           // 7
    ];
    const out = computeNewOrder(tracks, () => [], null, { positionMode: 'median' });
    // B 中位数 2 < A 中位数 5 → B 块在前
    expect(ids(out)).toEqual(['b1', 'b2', 'b3', 'a0', 'a1', 'a2', 'a3', 'a4']);
  });

  test('同歌手多专辑按各自中位数排', () => {
    // A 的专辑 X1 只有一首在开头,其余歌在专辑 X2 且靠后 → X2 排在 X1 前
    const tracks = [
      track('x1a', 'A', 'a', 'X1'),          // 0:X1 的离群歌
      track('x2a', 'A', 'a', 'X2'),          // 1
      track('x2b', 'A', 'a', 'X2'),          // 2
      track('x2c', 'A', 'a', 'X2'),          // 3
      track('x1b', 'A', 'a', 'X1'),          // 4
      track('x1c', 'A', 'a', 'X1'),          // 5
    ];
    const out = computeNewOrder(tracks, () => [], null, { positionMode: 'median' });
    // X1 中位数 4 > X2 中位数 2 → X2 在前
    expect(ids(out)).toEqual(['x2a', 'x2b', 'x2c', 'x1a', 'x1b', 'x1c']);
  });

  test('专辑聚合与专辑内顺序不变', () => {
    const tracks = [
      track('x2', 'A', 'a', 'X'),
      track('x1', 'A', 'a', 'X'),
      track('y1', 'B', 'b', 'Y'),
    ];
    const out = computeNewOrder(tracks, albumId => (albumId === 'X' ? ['x1', 'x2'] : ['y1']), null, { positionMode: 'median' });
    // A 中位数 0.5 < B 中位数 2 → A 在前;X 内按接口顺序 x1→x2
    expect(ids(out)).toEqual(['x1', 'x2', 'y1']);
  });

  test('无专辑的歌按中位数插入主排序', () => {
    // 无专辑歌 n1/n2 在中间,歌手 A 的歌在两端 → A 中位数 3.5,n 归 __unknown__ 中位数 2.5
    const tracks = [
      track('a1', 'A', 'a', 'X'),            // 0
      track('n1', 'B', 'b', null),           // 1
      track('n2', 'C', 'c', null),           // 2
      track('a2', 'A', 'a', 'X'),            // 3
      track('a3', 'A', 'a', 'X'),            // 4
      track('a4', 'A', 'a', 'X'),            // 5
      track('a5', 'A', 'a', 'X'),            // 6
    ];
    const out = computeNewOrder(tracks, () => [], null, { positionMode: 'median' });
    // __unknown__ 中位数 1.5 < A 中位数 3 → 无专辑块在前
    expect(ids(out)).toEqual(['n1', 'n2', 'a1', 'a2', 'a3', 'a4', 'a5']);
  });

  test('默认参数行为与 first 模式一致', () => {
    const tracks = [
      track('a0', 'A', 'a', 'X0'),
      track('b1', 'B', 'b', 'Z'),
      track('b2', 'B', 'b', 'Z'),
      track('a1', 'A', 'a', 'X1'),
    ];
    const firstDefault = computeNewOrder(tracks, () => []);
    const firstExplicit = computeNewOrder(tracks, () => [], null, { positionMode: 'first' });
    expect(ids(firstDefault)).toEqual(ids(firstExplicit));
    // first 模式 A 首次出现更早,A 在前(与 median 模式相反)
    expect(ids(firstDefault)).toEqual(['a0', 'a1', 'b1', 'b2']);
  });
});

// ---------- collectAlbumIds ----------

describe('collectAlbumIds', () => {
  test('去重、保持首次出现顺序、跳过无专辑', () => {
    const tracks = [
      track('x1', 'A', 'a', 'X'),
      track('z1', 'B', 'b', 'Z'),
      track('x2', 'A', 'a', 'X'),
      track('n1', 'C', 'c', null),
      track('y1', 'A', 'a', 'Y'),
      track('z2', 'B', 'b', 'Z'),
    ];
    expect(collectAlbumIds(tracks)).toEqual(['X', 'Z', 'Y']);
  });
});

// ---------- extractArtistBlocks(全局合并去重) ----------

describe('extractArtistBlocks', () => {
  test('同一歌手的非相邻块全局合并为一个', () => {
    // 模拟合辑场景:同一歌手被不同合辑拆成多个非相邻段
    const tracks = [
      track('a1', 'A', 'a', 'X'),
      track('a2', 'A', 'a', 'X'),
      track('b1', 'B', 'b', 'Z'),
      track('a3', 'A', 'a', 'H'), // A 又出现在后面的合辑里
      track('b2', 'B', 'b', 'Z'),
    ];
    const blocks = extractArtistBlocks(tracks);

    expect(blocks).toHaveLength(2);
    expect(blocks.map(b => b.artistKey)).toEqual(['a', 'b']);
    expect(blocks.map(b => b.displayName)).toEqual(['A', 'B']);
    expect(ids(blocks[0].tracks)).toEqual(['a1', 'a2', 'a3']);
    expect(ids(blocks[1].tracks)).toEqual(['b1', 'b2']);
    // 块内 track 与输入共享引用
    expect(blocks[0].tracks[0]).toBe(tracks[0]);
  });

  test('无歌手信息归入 (无歌手信息) 块', () => {
    const tracks = [
      { id: 'n1', name: 'n1', artists: [], album: null },
    ];
    const blocks = extractArtistBlocks(tracks);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].displayName).toBe('(无歌手信息)');
  });
});

// ---------- reorderByArtistBlocks ----------

describe('reorderByArtistBlocks', () => {
  test('按目标顺序移动整块,块内顺序不变', () => {
    const tracks = [
      track('a1', 'A', 'a', 'X'),
      track('a2', 'A', 'a', 'X'),
      track('b1', 'B', 'b', 'Z'),
      track('b2', 'B', 'b', 'Z'),
    ];
    const out = reorderByArtistBlocks(tracks, ['b', 'a']);
    expect(ids(out)).toEqual(['b1', 'b2', 'a1', 'a2']);
  });

  test('未知 key 忽略、漏传的块按原顺序追加,不丢歌', () => {
    const tracks = [
      track('a1', 'A', 'a', 'X'),
      track('b1', 'B', 'b', 'Z'),
      track('c1', 'C', 'c', 'H'),
    ];
    // 'zzz' 不存在 → 忽略;'a' 漏传 → 追加末尾
    const out = reorderByArtistBlocks(tracks, ['zzz', 'c', 'b']);
    expect(ids(out)).toEqual(['c1', 'b1', 'a1']);
    expect(out).toHaveLength(tracks.length);
  });

  test('重复 key 只生效一次', () => {
    const tracks = [
      track('a1', 'A', 'a', 'X'),
      track('b1', 'B', 'b', 'Z'),
    ];
    const out = reorderByArtistBlocks(tracks, ['b', 'b', 'a']);
    expect(ids(out)).toEqual(['b1', 'a1']);
  });
});

// ---------- sortByAddTime ----------

describe('sortByAddTime', () => {
  /** 造一首带加入时间戳的歌。 */
  function timedTrack(id, addTime) {
    return { ...track(id, 'A', 'a', 'X'), extMap: { addTime } };
  }

  test('按 addTime 升序排列', () => {
    const tracks = [
      timedTrack('t3', 300),
      timedTrack('t1', 100),
      timedTrack('t2', 200),
    ];
    expect(ids(sortByAddTime(tracks))).toEqual(['t1', 't2', 't3']);
  });

  test('返回顺序与时间顺序不一致时按时间排', () => {
    // 接口返回顺序不保证按 addTime 排(实测非单调)
    const tracks = [
      timedTrack('late', 900),
      timedTrack('early', 100),
      timedTrack('mid', 500),
    ];
    expect(ids(sortByAddTime(tracks))).toEqual(['early', 'mid', 'late']);
  });

  test('缺 addTime 的曲目按原相对顺序追加末尾,不丢歌', () => {
    const tracks = [
      timedTrack('t2', 200),
      track('no1', 'B', 'b', null), // 无 extMap
      timedTrack('t1', 100),
      { ...track('no2', 'C', 'c', null), extMap: {} }, // extMap 无 addTime
    ];
    expect(ids(sortByAddTime(tracks))).toEqual(['t1', 't2', 'no1', 'no2']);
  });

  test('同时间戳保持原顺序(稳定排序)', () => {
    const tracks = [
      timedTrack('a', 100),
      timedTrack('b', 100),
      timedTrack('c', 100),
    ];
    expect(ids(sortByAddTime(tracks))).toEqual(['a', 'b', 'c']);
  });

  test('空歌单返回空数组', () => {
    expect(sortByAddTime([])).toEqual([]);
  });

  test('descending: true 按时间降序,最新在前', () => {
    const tracks = [
      timedTrack('mid', 500),
      timedTrack('late', 900),
      timedTrack('early', 100),
    ];
    expect(ids(sortByAddTime(tracks, { descending: true }))).toEqual(['late', 'mid', 'early']);
  });

  test('descending 缺时间戳的曲目仍追加末尾', () => {
    const tracks = [
      track('no1', 'B', 'b', null),
      timedTrack('t2', 200),
      timedTrack('t1', 100),
    ];
    expect(ids(sortByAddTime(tracks, { descending: true }))).toEqual(['t2', 't1', 'no1']);
  });
});

// ---------- artistKey / firstArtist / albumInfo ----------

describe('artistKey', () => {
  test('originalId 优先,id 兜底,null 归 __unknown__', () => {
    expect(artistKey({ originalId: 'o1', id: 'i1' })).toBe('o1');
    expect(artistKey({ id: 'i1' })).toBe('i1');
    expect(artistKey({ id: 123 })).toBe('123');
    expect(artistKey(null)).toBe('__unknown__');
  });
});

describe('firstArtist', () => {
  test('artists[0],artists 缺失时用 fullArtists 兜底', () => {
    expect(firstArtist({ artists: [{ name: 'A' }] }).name).toBe('A');
    expect(firstArtist({ artists: null, fullArtists: [{ name: 'F' }] }).name).toBe('F');
    expect(firstArtist({ artists: [] })).toBe(null);
    expect(firstArtist({})).toBe(null);
  });
});

describe('albumInfo', () => {
  test('返回 track.album 或 null', () => {
    expect(albumInfo({ album: { id: 'X' } }).id).toBe('X');
    expect(albumInfo({})).toBe(null);
  });
});
