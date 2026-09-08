'use strict';

/**
 * playlist.js 单元测试(Jest)。
 *
 * mock 掉 ncm.js 的 runNcm,专注测分页逻辑、字段容错与错误路径——
 * 这些是"看起来对但一跑就错"的高危区(分页 bug 会静默丢歌)。
 */

jest.mock('../src/ncm.js', () => ({
  runNcm: jest.fn(),
}));

const { runNcm } = require('../src/ncm.js');
const {
  fetchFavoritePlaylist,
  fetchFavoritePlaylistId,
  fetchPlaylistTracks,
  fetchPlaylistList,
} = require('../src/playlist.js');

/** 造一首歌。 */
function track(id) {
  return { id, name: `song-${id}`, artists: [], album: null };
}

/** 按调用顺序设置 runNcm 的返回序列。 */
function queueResponses(resps) {
  runNcm.mockReset();
  for (const r of resps) runNcm.mockImplementationOnce(() => r);
}

beforeEach(() => {
  runNcm.mockReset();
});

// ---------- fetchFavoritePlaylist ----------

describe('fetchFavoritePlaylist', () => {
  test('返回 { id, name, trackCount }', () => {
    runNcm.mockReturnValueOnce({
      code: 200,
      data: { id: 'PID1', name: '我喜欢的音乐', trackCount: 123 },
    });
    expect(fetchFavoritePlaylist()).toEqual({
      id: 'PID1',
      name: '我喜欢的音乐',
      trackCount: 123,
    });
    expect(runNcm).toHaveBeenCalledWith(['user', 'favorite']);
  });

  test('接口未返回 id 时抛错(带原始响应)', () => {
    runNcm.mockReturnValueOnce({ code: 200, data: {} });
    expect(() => fetchFavoritePlaylist()).toThrow(/未返回 id/);
  });

  test('fetchFavoritePlaylistId 兼容旧签名,只返回 id', () => {
    runNcm.mockReturnValueOnce({
      code: 200,
      data: { id: 'PID2', name: 'x', trackCount: 0 },
    });
    expect(fetchFavoritePlaylistId()).toBe('PID2');
  });
});

// ---------- fetchPlaylistTracks ----------

describe('fetchPlaylistTracks', () => {
  test('单页:meta 拿 trackCount,一次拉全', () => {
    queueResponses([
      { code: 200, data: { trackCount: 3 } },
      { code: 200, data: [track('a'), track('b'), track('c')] },
    ]);
    const out = fetchPlaylistTracks('PID');
    expect(out.map(t => t.id)).toEqual(['a', 'b', 'c']);
    // 第二次调用应带 limit=3 / offset=0
    expect(runNcm).toHaveBeenNthCalledWith(2, [
      'playlist', 'tracks', '--playlistId', 'PID', '--limit', '3', '--offset', '0',
    ]);
  });

  test('多页:按 offset 递增拉取,直到 total', () => {
    queueResponses([
      { code: 200, data: { trackCount: 700 } },
      { code: 200, data: Array.from({ length: 500 }, (_, i) => track(`p1-${i}`)) },
      { code: 200, data: Array.from({ length: 200 }, (_, i) => track(`p2-${i}`)) },
    ]);
    const out = fetchPlaylistTracks('PID');
    expect(out).toHaveLength(700);
    expect(runNcm).toHaveBeenNthCalledWith(2, [
      'playlist', 'tracks', '--playlistId', 'PID', '--limit', '500', '--offset', '0',
    ]);
    expect(runNcm).toHaveBeenNthCalledWith(3, [
      'playlist', 'tracks', '--playlistId', 'PID', '--limit', '200', '--offset', '500',
    ]);
  });

  test('提前返回短页时停止分页(不无限循环)', () => {
    queueResponses([
      { code: 200, data: { trackCount: 1000 } },
      { code: 200, data: Array.from({ length: 300 }, (_, i) => track(i)) }, // 只回 300,短于 limit
    ]);
    const out = fetchPlaylistTracks('PID');
    expect(out).toHaveLength(300);
    expect(runNcm).toHaveBeenCalledTimes(2); // 不再发第 3 页请求
  });

  test('空页立即停止', () => {
    queueResponses([
      { code: 200, data: { trackCount: 100 } },
      { code: 200, data: [] },
    ]);
    expect(fetchPlaylistTracks('PID')).toEqual([]);
    expect(runNcm).toHaveBeenCalledTimes(2);
  });

  test('meta 无 trackCount 时按 500 兜底分页', () => {
    queueResponses([
      { code: 200, data: {} }, // 无 trackCount → 兜底 500
      { code: 200, data: Array.from({ length: 500 }, (_, i) => track(i)) }, // 整页 → 继续
      { code: 200, data: [track('tail')] }, // 第二页短页 → 停
    ]);
    const out = fetchPlaylistTracks('PID');
    // 兜底 total=500:第一页拉满 500 后 offset=total,循环结束,第二页不会发起
    expect(out).toHaveLength(500);
    expect(runNcm).toHaveBeenCalledTimes(2);
    expect(runNcm).toHaveBeenNthCalledWith(2, [
      'playlist', 'tracks', '--playlistId', 'PID', '--limit', '500', '--offset', '0',
    ]);
  });

  test('拿到数量少于期望时打 WARN 但正常返回', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      queueResponses([
        { code: 200, data: { trackCount: 10 } },
        { code: 200, data: [track('a')] }, // 只拿到 1 首,短于 limit=10 → 停
      ]);
      const out = fetchPlaylistTracks('PID');
      expect(out).toHaveLength(1);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[WARN]'));
    } finally {
      errSpy.mockRestore();
    }
  });

  test('onProgress 回调:开始/每页/结束各触发', () => {
    queueResponses([
      { code: 200, data: { trackCount: 600 } },
      { code: 200, data: Array.from({ length: 500 }, (_, i) => track(i)) },
      { code: 200, data: Array.from({ length: 100 }, (_, i) => track(i)) },
    ]);
    const calls = [];
    fetchPlaylistTracks('PID', (loaded, total) => calls.push([loaded, total]));
    expect(calls[0]).toEqual([0, 600]);       // 开始
    expect(calls[1]).toEqual([500, 600]);     // 第一页
    expect(calls[2]).toEqual([600, 600]);     // 第二页
    expect(calls[3]).toEqual([600, 600]);     // 结束
  });
});

// ---------- fetchPlaylistList ----------

describe('fetchPlaylistList', () => {
  test('kind 非法时抛错', () => {
    expect(() => fetchPlaylistList('favorite')).toThrow(/kind 必须是/);
    expect(runNcm).not.toHaveBeenCalled();
  });

  test('单页返回,字段缺省容错(脏数据不炸列表)', () => {
    runNcm.mockReturnValueOnce({
      code: 200,
      data: {
        recordCount: 3,
        records: [
          { id: 'P1', name: '歌单1', trackCount: 10 },
          { id: 'P2' },                        // 缺 name/trackCount
          null,                                // 整条脏数据
          { name: '无 id 的脏数据' },          // 无 id → 跳过
        ],
      },
    });
    const out = fetchPlaylistList('collected');
    expect(out).toEqual([
      { id: 'P1', name: '歌单1', trackCount: 10 },
      { id: 'P2', name: '(未命名歌单)', trackCount: 0 },
    ]);
  });

  test('多页:按 recordCount 翻页', () => {
    runNcm.mockImplementation((args) => {
      // args: ['playlist', kind, '--limit', '500', '--offset', N]
      const offset = Number(args[args.length - 1]);
      if (offset === 0) {
        return { code: 200, data: { recordCount: 700, records: Array.from({ length: 500 }, (_, i) => ({ id: `P${i}`, name: `n${i}`, trackCount: 1 })) } };
      }
      return { code: 200, data: { recordCount: 700, records: Array.from({ length: 200 }, (_, i) => ({ id: `Q${i}`, name: `m${i}`, trackCount: 2 })) } };
    });
    const out = fetchPlaylistList('created');
    expect(out).toHaveLength(700);
    expect(out[0].id).toBe('P0');
    expect(out[699].id).toBe('Q199');
    expect(runNcm).toHaveBeenCalledTimes(2);
  });

  test('data 直接是数组时也能解析(接口形态容错)', () => {
    runNcm.mockReturnValueOnce({
      code: 200,
      data: [{ id: 'P1', name: 'a', trackCount: 1 }],
    });
    const out = fetchPlaylistList('collected');
    expect(out).toEqual([{ id: 'P1', name: 'a', trackCount: 1 }]);
  });

  test('空列表返回空数组', () => {
    runNcm.mockReturnValueOnce({ code: 200, data: { recordCount: 0, records: [] } });
    expect(fetchPlaylistList('created')).toEqual([]);
  });
});
