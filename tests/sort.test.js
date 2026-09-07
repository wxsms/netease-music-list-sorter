'use strict';

/**
 * sort.js 纯函数单元测试(node:test,零依赖)。
 *
 * 覆盖:排序核心规则、专辑归属、无专辑兜底、歌手块全局合并(去重修复)、
 * 歌手块重排容错、artistKey/firstArtist 边界。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  computeNewOrder,
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

test('computeNewOrder: 专辑聚合 + 艺人按首次出现 + 专辑内按接口顺序', () => {
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
  assert.deepEqual(ids(out), ['x1', 'x2', 'y1', 'z1', 'z2']);
});

test('computeNewOrder: 合辑整张归到第一首歌的艺人,不被拆散', () => {
  const tracks = [
    track('h1', 'A', 'a', 'H'), // 合辑 H 第一首是 A → 整张归 A
    track('h2', 'C', 'c', 'H'), // H 内 C 主唱的歌,仍留在 H 里
    track('n1', 'B', 'b', null), // 无专辑
  ];
  const out = computeNewOrder(tracks, () => ['h1', 'h2']);
  assert.deepEqual(ids(out), ['h1', 'h2', 'n1']);
});

test('computeNewOrder: 无专辑的歌归 __unknown__,按首次出现位置插入主排序', () => {
  // __unknown__ 首次出现在位置 1(A 之后、C 之前)→ 整块插在 A 与 C 之间
  const tracks = [
    track('x1', 'A', 'a', 'X'),
    track('n1', 'B', 'b', null),
    track('y1', 'C', 'c', 'Y'),
    track('n2', 'D', 'd', null),
  ];
  const out = computeNewOrder(tracks, () => []);
  assert.deepEqual(ids(out), ['x1', 'n1', 'n2', 'y1']);
});

test('computeNewOrder: 接口抛错时专辑内退化为原顺序', () => {
  const tracks = [
    track('x2', 'A', 'a', 'X'),
    track('x1', 'A', 'a', 'X'),
  ];
  const origErr = console.error;
  console.error = () => {}; // 静音 [WARN]
  try {
    const out = computeNewOrder(tracks, () => { throw new Error('boom'); });
    assert.deepEqual(ids(out), ['x2', 'x1']);
  } finally {
    console.error = origErr;
  }
});

test('computeNewOrder: 不在接口返回顺序里的歌追加在专辑末尾', () => {
  const tracks = [
    track('x9', 'A', 'a', 'X'), // 接口不认识 x9
    track('x1', 'A', 'a', 'X'),
  ];
  const out = computeNewOrder(tracks, () => ['x1']);
  assert.deepEqual(ids(out), ['x1', 'x9']);
});

test('computeNewOrder: 空歌单返回空数组', () => {
  assert.deepEqual(computeNewOrder([], () => []), []);
});

test('computeNewOrder: hooks 回调计数正确', () => {
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
  assert.deepEqual(started, [2]); // 不含 __no_album__
  assert.deepEqual(done.sort(), ['X', 'Y']);
});

// ---------- collectAlbumIds ----------

test('collectAlbumIds: 去重、保持首次出现顺序、跳过无专辑', () => {
  const tracks = [
    track('x1', 'A', 'a', 'X'),
    track('z1', 'B', 'b', 'Z'),
    track('x2', 'A', 'a', 'X'),
    track('n1', 'C', 'c', null),
    track('y1', 'A', 'a', 'Y'),
    track('z2', 'B', 'b', 'Z'),
  ];
  assert.deepEqual(collectAlbumIds(tracks), ['X', 'Z', 'Y']);
});

// ---------- extractArtistBlocks(全局合并去重) ----------

test('extractArtistBlocks: 同一歌手的非相邻块全局合并为一个', () => {
  // 模拟合辑场景:同一歌手被不同合辑拆成多个非相邻段
  const tracks = [
    track('a1', 'A', 'a', 'X'),
    track('a2', 'A', 'a', 'X'),
    track('b1', 'B', 'b', 'Z'),
    track('a3', 'A', 'a', 'H'), // A 又出现在后面的合辑里
    track('b2', 'B', 'b', 'Z'),
  ];
  const blocks = extractArtistBlocks(tracks);

  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map(b => b.artistKey), ['a', 'b']);
  assert.deepEqual(blocks.map(b => b.displayName), ['A', 'B']);
  assert.deepEqual(ids(blocks[0].tracks), ['a1', 'a2', 'a3']);
  assert.deepEqual(ids(blocks[1].tracks), ['b1', 'b2']);
  // 块内 track 与输入共享引用
  assert.equal(blocks[0].tracks[0], tracks[0]);
});

test('extractArtistBlocks: 无歌手信息归入 (无歌手信息) 块', () => {
  const tracks = [
    { id: 'n1', name: 'n1', artists: [], album: null },
  ];
  const blocks = extractArtistBlocks(tracks);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].displayName, '(无歌手信息)');
});

// ---------- reorderByArtistBlocks ----------

test('reorderByArtistBlocks: 按目标顺序移动整块,块内顺序不变', () => {
  const tracks = [
    track('a1', 'A', 'a', 'X'),
    track('a2', 'A', 'a', 'X'),
    track('b1', 'B', 'b', 'Z'),
    track('b2', 'B', 'b', 'Z'),
  ];
  const out = reorderByArtistBlocks(tracks, ['b', 'a']);
  assert.deepEqual(ids(out), ['b1', 'b2', 'a1', 'a2']);
});

test('reorderByArtistBlocks: 未知 key 忽略、漏传的块按原顺序追加,不丢歌', () => {
  const tracks = [
    track('a1', 'A', 'a', 'X'),
    track('b1', 'B', 'b', 'Z'),
    track('c1', 'C', 'c', 'H'),
  ];
  // 'zzz' 不存在 → 忽略;'a' 漏传 → 追加末尾
  const out = reorderByArtistBlocks(tracks, ['zzz', 'c', 'b']);
  assert.deepEqual(ids(out), ['c1', 'b1', 'a1']);
  assert.equal(out.length, tracks.length);
});

test('reorderByArtistBlocks: 重复 key 只生效一次', () => {
  const tracks = [
    track('a1', 'A', 'a', 'X'),
    track('b1', 'B', 'b', 'Z'),
  ];
  const out = reorderByArtistBlocks(tracks, ['b', 'b', 'a']);
  assert.deepEqual(ids(out), ['b1', 'a1']);
});

// ---------- artistKey / firstArtist / albumInfo ----------

test('artistKey: originalId 优先,id 兜底,null 归 __unknown__', () => {
  assert.equal(artistKey({ originalId: 'o1', id: 'i1' }), 'o1');
  assert.equal(artistKey({ id: 'i1' }), 'i1');
  assert.equal(artistKey({ id: 123 }), '123');
  assert.equal(artistKey(null), '__unknown__');
});

test('firstArtist: artists[0],artists 缺失时用 fullArtists 兜底', () => {
  assert.equal(firstArtist({ artists: [{ name: 'A' }] }).name, 'A');
  assert.equal(firstArtist({ artists: null, fullArtists: [{ name: 'F' }] }).name, 'F');
  assert.equal(firstArtist({ artists: [] }), null);
  assert.equal(firstArtist({}), null);
});

test('albumInfo: 返回 track.album 或 null', () => {
  assert.equal(albumInfo({ album: { id: 'X' } }).id, 'X');
  assert.equal(albumInfo({}), null);
});
