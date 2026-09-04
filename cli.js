#!/usr/bin/env node
/**
 * CLI 入口:无参数 → 交互式向导;带参数 → 命令行模式。
 *
 * 用法:
 *   node cli.js                # 或 npm start —— 交互式向导
 *   node cli.js sort [选项]    # 排序歌单
 *   node cli.js rollback <backup.json> [选项]  # 回滚
 */

'use strict';

const { program } = require('commander');
const { createRequire } = require('module');
const path = require('path');

const require_ = createRequire(__filename);
const pkg = require_('./package.json');

const { interactive } = require('./src/interactive.js');
const {
  fetchFavoritePlaylist, fetchPlaylistTracks,
} = require('./src/playlist.js');
const { fetchAlbumTrackOrder, loadedAlbumCount } = require('./src/album-cache.js');
const { computeNewOrder, firstArtist, albumInfo } = require('./src/sort.js');
const { writeBackup, writeNewOrder, readBackup, extractPlaylistIdFromFilename } = require('./src/backup.js');
const { submitReorder, rollbackFromBackup } = require('./src/reorder.js');
const { NcmError } = require('./src/ncm.js');

function reportNcmError(e) {
  if (e instanceof NcmError) {
    console.error(`[ERROR] ${e.message}`);
    if (e.detail) console.error(e.detail);
    process.exit(1);
  }
  throw e;
}

function printDiffPreview(oldTracks, newTracks, n = 15) {
  console.log(`\n新顺序预览(前 ${n} 首):`);
  console.log(`${'#'.padStart(3)}  ${'歌名'.padEnd(30)}  ${'艺人'.padEnd(15)}  专辑`);
  const limit = Math.min(n, newTracks.length);
  for (let i = 0; i < limit; i++) {
    const t = newTracks[i];
    const name = (t.name || '').slice(0, 30);
    const artist = ((firstArtist(t) || {}).name || '').slice(0, 15);
    const album = (albumInfo(t) || {}).name || '';
    console.log(`${String(i + 1).padStart(3)}  ${name.padEnd(30)}  ${artist.padEnd(15)}  ${album}`);
  }
  if (newTracks.length > n) console.log(`... 共 ${newTracks.length} 首`);

  let moved = 0;
  for (let i = 0; i < newTracks.length; i++) {
    const oldId = i < oldTracks.length ? oldTracks[i].id : null;
    if (newTracks[i].id !== oldId) moved++;
  }
  console.log(`\n位置变动:${moved} / ${newTracks.length}`);
}

async function runSort(opts) {
  let playlistId;
  if (opts.playlistId) {
    playlistId = opts.playlistId;
  } else {
    console.log('[1/N] 查询红心歌单 ID ...');
    try {
      const fav = fetchFavoritePlaylist();
      playlistId = fav.id;
      console.log(`      红心歌单: ${fav.name} (${fav.trackCount} 首),id = ${playlistId}`);
    } catch (e) {
      reportNcmError(e);
    }
  }

  console.log('[2/N] 拉取歌单曲目 ...');
  let tracks;
  try {
    tracks = fetchPlaylistTracks(playlistId);
  } catch (e) {
    reportNcmError(e);
  }
  console.log(`      共 ${tracks.length} 首,实际拿到 ${tracks.length} 首`);
  if (!tracks.length) {
    console.log('[WARN] 歌单为空,无需排序。');
    return 0;
  }

  // commander 的 --no-backup 约定:设置 opts.backup = false(默认 true)
  if (opts.backup !== false) {
    const backupPath = writeBackup(playlistId, tracks);
    console.log(`[backup] 原顺序已备份至 ${backupPath}`);
  }

  console.log('[3/N] 计算新顺序(可能需要拉取专辑信息)...');
  const newTracks = computeNewOrder(tracks, fetchAlbumTrackOrder);
  console.log(`      完成。新顺序共 ${newTracks.length} 首,共调用 album tracks ${loadedAlbumCount()} 次。`);

  printDiffPreview(tracks, newTracks);

  if (opts.saveNewOrder) {
    const newPath = writeNewOrder(playlistId, newTracks);
    console.log(`[save] 新顺序已写入 ${newPath}`);
  }

  if (opts.dryRun) {
    console.log('\n[--dry-run] 不提交。如需提交,去掉 --dry-run 再跑一次。');
    return 0;
  }

  console.log('[4/N] 提交 reorder ...');
  try {
    submitReorder(playlistId, newTracks.map(t => t.id).filter(Boolean));
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    return 1;
  }
  console.log(`[OK] 已提交新顺序,共 ${newTracks.length} 首。`);
  return 0;
}

async function runRollback(backupFile, opts) {
  let data;
  try {
    data = readBackup(backupFile);
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    return 1;
  }
  const encIds = data.encIds;
  console.log(`backup 文件: ${data.path}`);
  console.log(`歌曲数: ${encIds.length}`);

  const playlistId = opts.playlistId || extractPlaylistIdFromFilename(path.basename(data.path));
  if (!playlistId) {
    console.error('[ERROR] 无法从文件名解析 playlistId,请用 --playlistId 传入');
    return 1;
  }
  console.log(`目标歌单 ID: ${playlistId}`);

  if (opts.dryRun) {
    console.log('\n[--dry-run] 不提交。');
    return 0;
  }

  console.log('\n提交 reorder ...');
  try {
    rollbackFromBackup(playlistId, encIds);
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    return 1;
  }
  console.log(`[OK] 回滚完成,共 ${encIds.length} 首。`);
  return 0;
}

// ---------- 入口判定 ----------

if (process.argv.length <= 2) {
  interactive();
} else {
  program
    .name('netease-music-list-sorter')
    .version(pkg.version)
    .description('按"专辑优先 + 艺人首次出现"规则重排网易云音乐歌单');

  program
    .command('sort')
    .description('排序歌单')
    .option('--playlistId <enc>', '加密歌单 ID;不传则默认红心歌单')
    .option('--dry-run', '只计算新顺序并预览,不提交')
    .option('--no-backup', '不写备份文件(不推荐,reorder 不可撤销)')
    .option('--save-new-order', '把排序后的新顺序写到 output/new-order-<playlistId>.json')
    .action(runSort);

  program
    .command('rollback <backupFile>')
    .description('回滚歌单顺序')
    .option('--playlistId <enc>', 'backup 文件名无法解析 ID 时手动指定')
    .option('--dry-run', '只打印将提交的顺序,不提交')
    .action(runRollback);

  program.parseAsync(process.argv).then(() => { /* 退出码由 action 返回值/异常决定 */ });
}
