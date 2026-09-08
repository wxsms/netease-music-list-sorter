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

/**
 * 临时覆盖 process.platform(模块加载时读取它做平台分支),
 * 返回恢复函数。Object.defineProperty 因为 process.platform
 * 是 getter,直接赋值在部分 Node 版本会静默失败。
 */
function withPlatform(platform) {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  return () => Object.defineProperty(process, 'platform', orig);
}

describe('resolveCacheHome', () => {
  test('NCM_SORTER_CACHE_HOME 优先于一切平台默认', () => {
    const mod = loadModule({ NCM_SORTER_CACHE_HOME: '/custom/cache' });
    expect(mod.getCacheHome()).toBe('/custom/cache');
  });

  test('Windows: %LOCALAPPDATA%\\netease-music-list-sorter\\Cache', () => {
    const restore = withPlatform('win32');
    try {
      const mod = loadModule({ NCM_SORTER_CACHE_HOME: '', LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' });
      expect(mod.getCacheHome()).toBe(path.join('C:\\Users\\x\\AppData\\Local', 'netease-music-list-sorter', 'Cache'));
    } finally {
      restore();
    }
  });

  test('Windows: LOCALAPPDATA 缺失时回退 homedir', () => {
    const restore = withPlatform('win32');
    try {
      const mod = loadModule({ NCM_SORTER_CACHE_HOME: '', LOCALAPPDATA: '' });
      expect(mod.getCacheHome()).toBe(
        path.join(os.homedir(), 'AppData', 'Local', 'netease-music-list-sorter', 'Cache'),
      );
    } finally {
      restore();
    }
  });

  test('macOS: ~/Library/Caches/netease-music-list-sorter', () => {
    const restore = withPlatform('darwin');
    try {
      const mod = loadModule({ NCM_SORTER_CACHE_HOME: '' });
      expect(mod.getCacheHome()).toBe(
        path.join(os.homedir(), 'Library', 'Caches', 'netease-music-list-sorter'),
      );
    } finally {
      restore();
    }
  });

  test('Linux: $XDG_CACHE_HOME/netease-music-list-sorter', () => {
    const restore = withPlatform('linux');
    try {
      const mod = loadModule({ NCM_SORTER_CACHE_HOME: '', XDG_CACHE_HOME: '/xdg/cache' });
      expect(mod.getCacheHome()).toBe(path.join('/xdg/cache', 'netease-music-list-sorter'));
    } finally {
      restore();
    }
  });

  test('Linux: XDG_CACHE_HOME 缺失时回退 ~/.cache', () => {
    const restore = withPlatform('linux');
    try {
      const mod = loadModule({ NCM_SORTER_CACHE_HOME: '', XDG_CACHE_HOME: '' });
      expect(mod.getCacheHome()).toBe(
        path.join(os.homedir(), '.cache', 'netease-music-list-sorter'),
      );
    } finally {
      restore();
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
