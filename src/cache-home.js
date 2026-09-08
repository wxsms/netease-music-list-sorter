'use strict';

/**
 * 缓存目录管理(唯一的目录决策点)。
 *
 * 所有落盘数据(backups / new-order / albums)统一放在用户级缓存目录:
 * - Windows: %LOCALAPPDATA%\netease-music-list-sorter\Cache
 * - macOS:   ~/Library/Caches/netease-music-list-sorter
 * - Linux:   $XDG_CACHE_HOME/netease-music-list-sorter(默认 ~/.cache/...)
 *
 * 环境变量:
 * - NCM_SORTER_CACHE_HOME:整体覆盖缓存根目录(测试与高级用户用)
 *
 * 旧版数据(仓库内 .cache/ 与 output/)由 backup.js / album-cache.js
 * 在首次调用时自动迁移到新位置,本模块只负责目录解析,不负责迁移。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_NAME = 'netease-music-list-sorter';

/** 解析用户级缓存根目录(应用专属子目录)。 */
function resolveCacheHome() {
  if (process.env.NCM_SORTER_CACHE_HOME) {
    return process.env.NCM_SORTER_CACHE_HOME;
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
      || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, APP_NAME, 'Cache');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', APP_NAME);
  }
  const xdg = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(xdg, APP_NAME);
}

const CACHE_HOME = resolveCacheHome();

/** 确保某个子目录存在,返回其绝对路径。 */
function cacheDir(name) {
  const dir = path.join(CACHE_HOME, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 当前缓存根目录(不创建)。 */
function getCacheHome() {
  return CACHE_HOME;
}

module.exports = { cacheDir, getCacheHome, resolveCacheHome, APP_NAME };
