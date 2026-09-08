'use strict';

/**
 * cache-home.js 单元测试(Jest)。
 *
 * 目录解析逻辑:NCM_SORTER_CACHE_HOME 覆盖 > 平台默认(LOCALAPPDATA /
 * ~/Library/Caches / XDG_CACHE_HOME)。用 jest.isolateModules 每次拿到
 * 绑定当前环境变量的干净实例。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 用给定环境变量加载 cache-home 模块,返回模块与清理函数。 */
function loadModule(env = {}) {
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  let mod;
  jest.isolateModules(() => {
    mod = require('../src/cache-home.js');
  });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return mod;
}

describe('resolveCacheHome', () => {
  test('NCM_SORTER_CACHE_HOME 优先于一切平台默认', () => {
    const mod = loadModule({ NCM_SORTER_CACHE_HOME: '/custom/cache' });
    expect(mod.getCacheHome()).toBe('/custom/cache');
  });

  test('Windows: %LOCALAPPDATA%\\netease-music-list-sorter\\Cache', () => {
    const mod = loadModule({ NCM_SORTER_CACHE_HOME: '', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' });
    expect(mod.getCacheHome()).toBe(path.join('C:\\Users\\x\\AppData\\Local', 'netease-music-list-sorter', 'Cache'));
  });

  test('Windows: LOCALAPPDATA 缺失时回退 homedir', () => {
    const mod = loadModule({ NCM_SORTER_CACHE_HOME: '', LOCALAPPDATA: '' });
    expect(mod.getCacheHome()).toBe(
      path.join(os.homedir(), 'AppData', 'Local', 'netease-music-list-sorter', 'Cache'),
    );
  });

  test('Linux: $XDG_CACHE_HOME/netease-music-list-sorter', () => {
    const mod = loadModule({ NCM_SORTER_CACHE_HOME: '', XDG_CACHE_HOME: '/xdg/cache' });
    // 平台分支取决于运行环境;非 win32/darwin 时走 XDG
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      expect(mod.getCacheHome()).toBe(path.join('/xdg/cache', 'netease-music-list-sorter'));
    } else {
      // 在 win/darwin 上该用例只验证不抛错
      expect(typeof mod.getCacheHome()).toBe('string');
    }
  });
});

describe('cacheDir', () => {
  test('创建并返回缓存根下的子目录', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncm-sorter-home-'));
    try {
      const mod = loadModule({ NCM_SORTER_CACHE_HOME: root });
      const dir = mod.cacheDir('albums');
      expect(dir).toBe(path.join(root, 'albums'));
      expect(fs.existsSync(dir)).toBe(true);
      // 幂等:再次调用不报错
      expect(mod.cacheDir('albums')).toBe(dir);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('多级子目录也能创建', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncm-sorter-home-'));
    try {
      const mod = loadModule({ NCM_SORTER_CACHE_HOME: root });
      const dir = mod.cacheDir(path.join('a', 'b'));
      expect(fs.existsSync(dir)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
