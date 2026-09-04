#!/usr/bin/env node
/**
 * 按专辑优先 + 艺人首次出现顺序重排网易云音乐歌单(脚本入口,薄壳)。
 *
 * 核心逻辑在 src/ 共享模块中,本文件只负责参数解析与输出呈现。
 *
 * 规则:
 * 1. 专辑作为顶层聚合单位:每张专辑的所有歌连在一起,按 album tracks 接口返回顺序排,不被艺人拆散。
 * 2. 专辑归属艺人 = 该专辑在原歌单里最早出现那首歌的 artists[0]。
 * 3. 艺人之间:按归属艺人在原歌单里的首次出现位置升序。
 * 4. 同一艺人多张专辑:按各自第一首歌在原歌单中的位置升序。
 * 5. 无专辑信息的歌:按原顺序追加末尾。
 *
 * 用法:
 *   node sort-playlist.js                      # 默认排红心歌单(自动查 user favorite)
 *   node sort-playlist.js --playlistId <enc>   # 排指定歌单
 *   node sort-playlist.js --dry-run            # 只算新顺序,不提交
 *   node sort-playlist.js --no-backup          # 不写备份(不推荐)
 *   node sort-playlist.js --save-new-order     # 把新顺序写到 output/new-order-<id>.json
 *
 * 依赖:外部命令 ncm-cli 已登录并可在 PATH 中调用。仅使用 Node 标准库。
 */

'use strict';

const {
  fetchFavoritePlaylist, fetchPlaylistTracks,
} = require('./src/playlist.js');
const { fetchAlbumTrackOrder, loadedAlbumCount } = require('./src/album-cache.js');
const { computeNewOrder, firstArtist, albumInfo } = require('./src/sort.js');
const { writeBackup, writeNewOrder } = require('./src/backup.js');
const { submitReorder } = require('./src/reorder.js');
const { NcmError } = require('./src/ncm.js');

// ---------- 参数解析 ----------

function parseArgs(argv) {
  const args = { dryRun: false, noBackup: false, saveNewOrder: false, playlistId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-backup') args.noBackup = true;
    else if (a === '--save-new-order') args.saveNewOrder = true;
    else if (a === '--playlistId') {
      const v = argv[++i];
      if (!v) {
        console.error('[ERROR] --playlistId 需要一个值');
        process.exit(1);
      }
      args.playlistId = v;
    }
    else if (a.startsWith('--playlistId=')) args.playlistId = a.slice('--playlistId='.length);
    else {
      console.error(`[ERROR] 未知参数: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

// ---------- 预览 ----------

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

// ---------- 主流程 ----------

function main() {
  const args = parseArgs(process.argv);

  let playlistId;
  if (args.playlistId) {
    playlistId = args.playlistId;
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

  if (!args.noBackup) {
    const backupPath = writeBackup(playlistId, tracks);
    console.log(`[backup] 原顺序已备份至 ${backupPath}`);
  }

  console.log('[3/N] 计算新顺序(可能需要拉取专辑信息)...');
  const newTracks = computeNewOrder(tracks, fetchAlbumTrackOrder);
  console.log(`      完成。新顺序共 ${newTracks.length} 首,共调用 album tracks ${loadedAlbumCount()} 次。`);

  printDiffPreview(tracks, newTracks);

  if (args.saveNewOrder) {
    const newPath = writeNewOrder(playlistId, newTracks);
    console.log(`[save] 新顺序已写入 ${newPath}`);
  }

  if (args.dryRun) {
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

function reportNcmError(e) {
  if (e instanceof NcmError) {
    console.error(`[ERROR] ${e.message}`);
    if (e.detail) console.error(e.detail);
    process.exit(1);
  }
  throw e;
}

process.exit(main());
