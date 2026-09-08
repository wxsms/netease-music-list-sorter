'use strict';

/**
 * album-cache.js 单元测试(Jest)。
 *
 * 通过 NCM_SORTER_HOME 环境变量把缓存目录指到 os.tmpdir() 下的隔离目录,
 * 并用 jest.isolateModules 每次拿到内存 Map 缓存为空的干净模块实例。
 * ncm.js 依赖用标准 jest.mock 替换(不打真实请求)。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../src/ncm.js', () => ({
  runNcm: jest.fn(),
  runNcmAsync: jest.fn(),
}));

const { runNcm, runNcmAsync } = require('../src/ncm.js');

/** 在临时根目录下加载 album-cache 模块,返回 { mod, root, albumDir }。 */
function loadModule() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncm-sorter-album-'));
  process.env.NCM_SORTER_HOME = root;
  let mod;
  jest.isolateModules(() => {
    mod = require('../src/album-cache.js');
  });
  delete process.env.NCM_SORTER_HOME;
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
  runNcm.mockReset();
  runNcmAsync.mockReset();
});

// ---------- fetchAlbumTracks(三级缓存) ----------

describe('fetchAlbumTracks', () => {
  test('未命中时调接口,结果写入内存与磁盘缓存', () => {
    const { mod, root, albumDir } = loadModule();
    try {
      runNcm.mockReturnValue({ code: 200, data: [row('a'), row('b')] });

      const out = mod.fetchAlbumTracks('ALB1');
      expect(out.map(r => r.id)).toEqual(['a', 'b']);
      expect(runNcm).toHaveBeenCalledTimes(1);
      // 磁盘缓存已写
      const disk = JSON.parse(fs.readFileSync(path.join(albumDir, 'ALB1.json'), 'utf8'));
      expect(disk).toHaveLength(2);
      // 二次调用走内存缓存,不再发请求
      mod.fetchAlbumTracks('ALB1');
      expect(runNcm).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(root);
    }
  });

  test('磁盘缓存命中时不发请求(新进程模拟:先写盘,再 require 新实例)', () => {
    // 第一个实例:拉接口落盘
    const first = loadModule();
    try {
      runNcm.mockReturnValue({ code: 200, data: [row('x')] });
      first.mod.fetchAlbumTracks('ALB2');
      expect(runNcm).toHaveBeenCalledTimes(1);
    } finally {
      // 暂不清理,把磁盘缓存内容先读出来
    }

    // 第二个实例:全新临时目录(内存缓存为空),把磁盘缓存文件搬过去
    const second = loadModule();
    try {
      fs.mkdirSync(second.albumDir, { recursive: true });
      fs.copyFileSync(path.join(first.albumDir, 'ALB2.json'), path.join(second.albumDir, 'ALB2.json'));

      const out = second.mod.fetchAlbumTracks('ALB2');
      expect(out.map(r => r.id)).toEqual(['x']);
      // 纯磁盘命中:本用例内不再发新请求(第一次调用来自第一个实例)
      expect(runNcm).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(second.root);
      cleanup(first.root);
    }
  });

  test('损坏的磁盘缓存被忽略,退回接口', () => {
    const { mod, root, albumDir } = loadModule();
    try {
      fs.mkdirSync(albumDir, { recursive: true });
      fs.writeFileSync(path.join(albumDir, 'ALB3.json'), '{broken');
      runNcm.mockReturnValue({ code: 200, data: [row('ok')] });

      const out = mod.fetchAlbumTracks('ALB3');
      expect(out.map(r => r.id)).toEqual(['ok']);
      expect(runNcm).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(root);
    }
  });

  test('旧格式缓存(纯 encId 字符串数组)被忽略,重新拉接口升级', () => {
    const { mod, root, albumDir } = loadModule();
    try {
      fs.mkdirSync(albumDir, { recursive: true });
      fs.writeFileSync(path.join(albumDir, 'ALB4.json'), JSON.stringify(['enc1', 'enc2']));
      runNcm.mockReturnValue({ code: 200, data: [row('n1')] });

      const out = mod.fetchAlbumTracks('ALB4');
      expect(out).toEqual([row('n1')]); // 不是旧字符串数组
      expect(runNcm).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(root);
    }
  });

  test('fetchAlbumTrackOrder 返回专辑内顺序(过滤无 id 行)', () => {
    const { mod, root } = loadModule();
    try {
      runNcm.mockReturnValue({
        code: 200,
        data: [row('a'), { name: 'no-id' }, row('b')],
      });
      expect(mod.fetchAlbumTrackOrder('ALB5')).toEqual(['a', 'b']);
    } finally {
      cleanup(root);
    }
  });

  test('cachePathForAlbum 对特殊字符做安全替换', () => {
    const { mod, root } = loadModule();
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
    const { mod, root, albumDir } = loadModule();
    try {
      // 先让 ALB1 进内存缓存
      runNcm.mockReturnValue({ code: 200, data: [row('m')] });
      mod.fetchAlbumTracks('ALB1');

      runNcmAsync
        .mockResolvedValueOnce({ code: 200, data: [row('p1')] })
        .mockResolvedValueOnce({ code: 200, data: [row('p2')] });

      const progress = [];
      const result = await mod.prefetchAlbums(['ALB1', 'ALB2', 'ALB3'], (d, t) => progress.push([d, t]), 2);
      expect(result).toEqual({ fetched: 2, failed: 0, cached: 1 });
      expect(runNcmAsync).toHaveBeenCalledTimes(2);
      // 拉到的写入磁盘
      expect(fs.existsSync(path.join(albumDir, 'ALB2.json'))).toBe(true);
      expect(fs.existsSync(path.join(albumDir, 'ALB3.json'))).toBe(true);
      // 之后同步路径全部内存命中
      expect(mod.fetchAlbumTrackOrder('ALB2')).toEqual(['p1']);
      expect(runNcm).toHaveBeenCalledTimes(1); // 只有最初的 ALB1
      // 进度回调覆盖全部
      expect(progress[progress.length - 1]).toEqual([3, 3]);
    } finally {
      cleanup(root);
    }
  });

  test('单张专辑失败不中断,计入 failed', async () => {
    const { mod, root } = loadModule();
    try {
      runNcmAsync
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
    const { mod, root } = loadModule();
    try {
      const result = await mod.prefetchAlbums([]);
      expect(result).toEqual({ fetched: 0, failed: 0, cached: 0 });
      expect(runNcmAsync).not.toHaveBeenCalled();
    } finally {
      cleanup(root);
    }
  });

  test('loadedAlbumCount 反映已加载专辑数', async () => {
    const { mod, root } = loadModule();
    try {
      expect(mod.loadedAlbumCount()).toBe(0);
      runNcmAsync.mockResolvedValue({ code: 200, data: [row('x')] });
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
    const { mod, root, albumDir } = loadModule();
    try {
      const cacheRoot = path.join(root, '.cache');
      fs.mkdirSync(cacheRoot, { recursive: true });
      fs.writeFileSync(path.join(cacheRoot, 'album-OLD1.json'), JSON.stringify([row('o1')]));
      runNcm.mockReturnValue({ code: 200, data: [row('fresh')] });

      // 触发迁移:访问任意专辑
      mod.fetchAlbumTracks('TRIGGER');

      expect(fs.existsSync(path.join(albumDir, 'OLD1.json'))).toBe(true);
      expect(fs.existsSync(path.join(cacheRoot, 'album-OLD1.json'))).toBe(false);
    } finally {
      cleanup(root);
    }
  });
});
