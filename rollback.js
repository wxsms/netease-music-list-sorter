#!/usr/bin/env node
/**
 * 把歌单顺序回滚到 backup 文件里记录的顺序(脚本入口,薄壳)。
 *
 * 核心逻辑在 src/ 共享模块中,本文件只负责参数解析与输出呈现。
 *
 * 用法:
 *   node rollback.js <backup.json>
 *   node rollback.js <backup.json> --playlistId <enc>   # 文件名无法解析 ID 时手动指定
 *   node rollback.js <backup.json> --dry-run            # 只打印将提交的顺序,不提交
 *
 * backup 文件格式:数组,每条含 "id"(encId)、"name"、"artist"、"album" 等字段。
 */

'use strict';

const { readBackup, extractPlaylistIdFromFilename } = require('./src/backup.js');
const { rollbackFromBackup } = require('./src/reorder.js');
const path = require('path');

function parseArgs(argv) {
  const args = { dryRun: false, playlistId: null, backup: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--playlistId') {
      const v = argv[++i];
      if (!v) {
        console.error('[ERROR] --playlistId 需要一个值');
        process.exit(1);
      }
      args.playlistId = v;
    }
    else if (a.startsWith('--playlistId=')) args.playlistId = a.slice('--playlistId='.length);
    else if (!a.startsWith('--')) args.backup = a;
    else {
      console.error(`[ERROR] 未知参数: ${a}`);
      process.exit(1);
    }
  }
  if (!args.backup) {
    console.error('用法: node rollback.js <backup.json> [--playlistId <enc>] [--dry-run]');
    process.exit(1);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv);

  let data;
  try {
    data = readBackup(args.backup);
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    return 1;
  }
  const encIds = data.encIds;
  console.log(`backup 文件: ${data.path}`);
  console.log(`歌曲数: ${encIds.length}`);

  const playlistId = args.playlistId || extractPlaylistIdFromFilename(path.basename(data.path));
  if (!playlistId) {
    console.error('[ERROR] 无法从文件名解析 playlistId,请用 --playlistId 传入');
    return 1;
  }
  console.log(`目标歌单 ID: ${playlistId}`);

  console.log('前 5 首 / 后 5 首(将提交的顺序):');
  for (let i = 0; i < Math.min(5, data.tracks.length); i++) {
    console.log(`  ${i + 1}. ${data.tracks[i].name}  -  ${data.tracks[i].artist}  -  ${data.tracks[i].album}`);
  }
  console.log('  ...');
  for (let i = Math.max(0, data.tracks.length - 5); i < data.tracks.length; i++) {
    console.log(`  ${i + 1}. ${data.tracks[i].name}  -  ${data.tracks[i].artist}  -  ${data.tracks[i].album}`);
  }

  if (args.dryRun) {
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

process.exit(main());
