'use strict';

/**
 * album-cache.js 单元测试(Jest)。
 *
 * album-cache.js 用 __dirname 推导缓存目录,且模块内有进程级 Map 缓存,
 * 这里沿用 backup-io.test.js 的"临时仓库"方案:每个用例把模块拷到
 * tmp 下重新 require,拿到干净的缓存状态与隔离的 .cache/ 目录。
 * ncm.js 依赖被 mock 掉(不打真实请求)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// mock 掉 album-cache 依赖的 ncm.js(拷贝过去的模块 require './ncm.js'
// 会解析到临时 src/ 下的拷贝,所以要在临时目录里放一个假的 ncm.js)
const NCM_STUB = `'use strict';
const runNcm = global.__TEST_NCM_RUNNCM__;
const runNcmAsync = global.__TEST_NCM_RUNNCMASYNC__;
module.exports = { runNcm, runNcmAsync, NcmError: class extends Error {}, resolveNcmEntry: () => ['ncm-cli'] };
`;

/** 在临时目录构建迷你仓库,返回 album-cache 模块与缓存目录。 */
function setupTempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncm-sorter-album-'));
  const srcDir = path.join(root, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'album-cache.js'), path.join(srcDir, 'album-cache.js'));
  fs.writeFileSync(path.join(srcDir, 'ncm.js'), NCM_STUB);

  const mod = require(path.join(srcDir, 'album-cache.js'));
  return {
    mod,
    root,
    albumDir: path.join(root, '.cache', 'albums'),
  };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 造专辑曲目行。 */
function row(id) {
  return { id, name: `t-${id}` };
}

beforeEach(() => {
  global.__TEST_NCM_RUNNCM__ = jest.fn();
  global.__TEST_NCM_RUNNCMASYNC__ = jest.fn();
});

afterEach(() => {
  delete global.__TEST_NCM_RUNNCM__;
  delete global.__TEST_NCM_RUNNCMASYNC__;
});

// ---------- fetchAlbumTracks(三级缓存) ----------

describe('fetchAlbumTracks', () => {
  test('未命中时调接口,结果写入内存与磁盘缓存', () => {
    const { mod, root, albumDir } = setupTempRepo();
    try {
      global.__TEST_NCM_RUNNCM__.mockReturnValue({ code: 200, data: [row('a'), row('b')] });

      const out = mod.fetchAlbumTracks('ALB1');
      expect(out.map(r => r.id)).toEqual(['a', 'b']);
      expect(global.__TEST_NCM_RUNNCM__).toHaveBeenCalledTimes(1);
      // 磁盘缓存已写
      const disk = JSON.parse(fs.readFileSync(path.join(albumDir, 'ALB1.json'), 'utf8'));
      expect(disk).toHaveLength(2);
      // 二次调用走内存缓存,不再发请求
      mod.fetchAlbumTracks('ALB1');
      expect(global.__TEST_NCM_RUNNCM__).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(root);
    }
  });

  test('磁盘缓存命中时不发请求(新进程模拟:先写盘,再 require 新实例)', () => {
    // 第一个实例:拉接口落盘
    const first = setupTempRepo();
    try {
      global.__TEST_NCM_RUNNCM__.mockReturnValue({ code: 200, data: [row('x')] });
      first.mod.fetchAlbumTracks('ALB2');
      expect(global.__TEST_NCM_RUNNCM__).toHaveBeenCalledTimes(1);
    } finally {
      // 暂不清理,把磁盘缓存内容先读出来
    }

    // 第二个实例:全新临时目录(内存缓存为空),把磁盘缓存文件搬过去
    const second = setupTempRepo();
    try {
      fs.mkdirSync(second.albumDir, { recursive: true });
      fs.copyFileSync(path.join(first.albumDir, 'ALB2.json'), path.join(second.albumDir, 'ALB2.json'));

      const out = second.mod.fetchAlbumTracks('ALB2');
      expect(out.map(r => r.id)).toEqual(['x']);
      // 纯磁盘命中:本用例内不再发新请求(第一次调用来自第一个实例)
      expect(global.__TEST_NCM_RUNNCM__).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(second.root);
      cleanup(first.root);
    }
  });

  test('损坏的磁盘缓存被忽略,退回接口', () => {
    const { mod, root, albumDir } = setupTempRepo();
    try {
      fs.mkdirSync(albumDir, { recursive: true });
      fs.writeFileSync(path.join(albumDir, 'ALB3.json'), '{broken');
      global.__TEST_NCM_RUNNCM__.mockReturnValue({ code: 200, data: [row('ok')] });

      const out = mod.fetchAlbumTracks('ALB3');
      expect(out.map(r => r.id)).toEqual(['ok']);
      expect(global.__TEST_NCM_RUNNCM__).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(root);
    }
  });

  test('旧格式缓存(纯 encId 字符串数组)被忽略,重新拉接口升级', () => {
    const { mod, root, albumDir } = setupTempRepo();
    try {
      fs.mkdirSync(albumDir, { recursive: true });
      fs.writeFileSync(path.join(albumDir, 'ALB4.json'), JSON.stringify(['enc1', 'enc2']));
      global.__TEST_NCM_RUNNCM__.mockReturnValue({ code: 200, data: [row('n1')] });

      const out = mod.fetchAlbumTracks('ALB4');
      expect(out).toEqual([row('n1')]); // 不是旧字符串数组
      expect(global.__TEST_NCM_RUNNCM__).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(root);
    }
  });

  test('fetchAlbumTrackOrder 返回专辑内顺序(过滤无 id 行)', () => {
    const { mod, root } = setupTempRepo();
    try {
      global.__TEST_NCM_RUNNCM__.mockReturnValue({
        code: 200,
        data: [row('a'), { name: 'no-id' }, row('b')],
      });
      expect(mod.fetchAlbumTrackOrder('ALB5')).toEqual(['a', 'b']);
    } finally {
      cleanup(root);
    }
  });

  test('cachePathForAlbum 对特殊字符做安全替换', () => {
    const { mod, root } = setupTempRepo();
    try {
      const p = mod.cachePathForAlbum('a/b\\c');
      expect(path.basename(p)).toBe('a_b_c.json');
    } finally {
      cleanup(root);
    }
  });
});

// ---------- prefetchAlbums ----------

describe('prefetchAlbums', () => {
  test('缓存命中的跳过,未命中的并发拉取并落盘', async () => {
    const { mod, root, albumDir } = setupTempRepo();
    try {
      // 先让 ALB1 进内存缓存
      global.__TEST_NCM_RUNNCM__.mockReturnValue({ code: 200, data: [row('m')] });
      mod.fetchAlbumTracks('ALB1');

      global.__TEST_NCM_RUNNCMASYNC__
        .mockResolvedValueOnce({ code: 200, data: [row('p1')] })
        .mockResolvedValueOnce({ code: 200, data: [row('p2')] });

      const progress = [];
      const result = await mod.prefetchAlbums(['ALB1', 'ALB2', 'ALB3'], (d, t) => progress.push([d, t]), 2);
      expect(result).toEqual({ fetched: 2, failed: 0, cached: 1 });
      expect(global.__TEST_NCM_RUNNCMASYNC__).toHaveBeenCalledTimes(2);
      // 拉到的写入磁盘
      expect(fs.existsSync(path.join(albumDir, 'ALB2.json'))).toBe(true);
      expect(fs.existsSync(path.join(albumDir, 'ALB3.json'))).toBe(true);
      // 之后同步路径全部内存命中
      expect(mod.fetchAlbumTrackOrder('ALB2')).toEqual(['p1']);
      expect(global.__TEST_NCM_RUNNCM__).toHaveBeenCalledTimes(1); // 只有最初的 ALB1
      // 进度回调覆盖全部
      expect(progress[progress.length - 1]).toEqual([3, 3]);
    } finally {
      cleanup(root);
    }
  });

  test('单张专辑失败不中断,计入 failed', async () => {
    const { mod, root } = setupTempRepo();
    try {
      global.__TEST_NCM_RUNNCMASYNC__
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ code: 200, data: [row('ok')] });

      const result = await mod.prefetchAlbums(['BAD', 'GOOD'], null, 2);
      expect(result).toEqual({ fetched: 1, failed: 1, cached: 0 });
      // 失败的没落盘,成功的落盘
      expect(fs.existsSync(path.join(root, '.cache', 'albums', 'GOOD.json'))).toBe(true);
      expect(fs.existsSync(path.join(root, '.cache', 'albums', 'BAD.json'))).toBe(false);
    } finally {
      cleanup(root);
    }
  });

  test('空列表直接返回零值', async () => {
    const { mod, root } = setupTempRepo();
    try {
      const result = await mod.prefetchAlbums([]);
      expect(result).toEqual({ fetched: 0, failed: 0, cached: 0 });
      expect(global.__TEST_NCM_RUNNCMASYNC__).not.toHaveBeenCalled();
    } finally {
      cleanup(root);
    }
  });

  test('loadedAlbumCount 反映已加载专辑数', async () => {
    const { mod, root } = setupTempRepo();
    try {
      expect(mod.loadedAlbumCount()).toBe(0);
      global.__TEST_NCM_RUNNCMASYNC__.mockResolvedValue({ code: 200, data: [row('x')] });
      await mod.prefetchAlbums(['A1', 'A2']);
      expect(mod.loadedAlbumCount()).toBe(2);
    } finally {
      cleanup(root);
    }
  });
});

// ---------- 旧版缓存迁移 ----------

describe('migrateLegacyAlbumCache(经 fetchAlbumTracks 触发)', () => {
  test('.cache/ 根目录的 album-*.json 迁移到 albums/ 并去前缀', () => {
    const { mod, root, albumDir } = setupTempRepo();
    try {
      const cacheRoot = path.join(root, '.cache');
      fs.mkdirSync(cacheRoot, { recursive: true });
      fs.writeFileSync(path.join(cacheRoot, 'album-OLD1.json'), JSON.stringify([row('o1')]));
      global.__TEST_NCM_RUNNCM__.mockReturnValue({ code: 200, data: [row('fresh')] });

      // 触发迁移:访问任意专辑
      mod.fetchAlbumTracks('TRIGGER');

      expect(fs.existsSync(path.join(albumDir, 'OLD1.json'))).toBe(true);
      expect(fs.existsSync(path.join(cacheRoot, 'album-OLD1.json'))).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});
