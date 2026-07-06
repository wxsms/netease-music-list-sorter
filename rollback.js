#!/usr/bin/env node
/**
 * 把歌单顺序回滚到 backup 文件里记录的顺序。
 *
 * 用法:
 *   node rollback.js <backup.json>
 *   node rollback.js <backup.json> --playlistId <enc>   # 文件名无法解析 ID 时手动指定
 *   node rollback.js <backup.json> --dry-run            # 只打印将提交的顺序,不提交
 *
 * backup 文件格式:数组,每条含 "id"(encId)、"name"、"artist"、"album" 等字段。
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveNcmEntry() {
  if (process.platform !== 'win32') return ['ncm-cli'];
  const exts = process.env.PATHEXT ? process.env.PATHEXT.split(';') : ['.CMD', '.cmd'];
  const paths = (process.env.PATH || '').split(';').filter(Boolean);
  let shimDir = null;
  for (const p of paths) {
    for (const ext of exts) {
      if (fs.existsSync(path.join(p, `ncm-cli${ext}`))) { shimDir = p; break; }
    }
    if (shimDir) break;
    if (fs.existsSync(path.join(p, 'ncm-cli'))) { shimDir = p; break; }
  }
  if (!shimDir) return ['ncm-cli'];
  const indexJs = path.join(shimDir, 'node_modules', '@music163', 'ncm-cli', 'dist', 'index.js');
  if (fs.existsSync(indexJs)) {
    const localNode = path.join(shimDir, 'node.exe');
    if (fs.existsSync(localNode)) return [localNode, indexJs];
    return ['node', indexJs];
  }
  return ['ncm-cli'];
}

const NCM_CMD = resolveNcmEntry();

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

function runNcm(args) {
  const fullArgs = [...NCM_CMD.slice(1), ...args, '--output', 'json'];
  const res = spawnSync(NCM_CMD[0], fullArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) {
    console.error(`[ERROR] 无法启动 ncm-cli: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`[ERROR] ncm-cli 退出码 ${res.status}`);
    if (res.stderr) console.error(res.stderr);
    process.exit(res.status || 1);
  }
  try {
    return JSON.parse(res.stdout);
  } catch (e) {
    console.error(`[ERROR] JSON 解析失败: ${e.message}`);
    console.error(res.stdout.slice(0, 500));
    process.exit(1);
  }
}

function extractPlaylistIdFromFilename(filename) {
  const m = filename.match(/backup-([A-F0-9]+)-/);
  return m ? m[1] : null;
}

function main() {
  const args = parseArgs(process.argv);

  const backupPath = path.resolve(args.backup);
  if (!fs.existsSync(backupPath)) {
    console.error(`[ERROR] 文件不存在: ${backupPath}`);
    return 1;
  }

  const data = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  if (!Array.isArray(data)) {
    console.error('[ERROR] backup 文件不是 JSON 数组');
    return 1;
  }

  const encIds = data.map(t => t.id).filter(Boolean);
  console.log(`backup 文件: ${backupPath}`);
  console.log(`歌曲数: ${encIds.length}`);

  const playlistId = args.playlistId || extractPlaylistIdFromFilename(path.basename(backupPath));
  if (!playlistId) {
    console.error('[ERROR] 无法从文件名解析 playlistId,请用 --playlistId 传入');
    return 1;
  }
  console.log(`目标歌单 ID: ${playlistId}`);

  console.log('前 5 首 / 后 5 首(将提交的顺序):');
  for (let i = 0; i < Math.min(5, data.length); i++) {
    console.log(`  ${i + 1}. ${data[i].name}  -  ${data[i].artist}  -  ${data[i].album}`);
  }
  console.log('  ...');
  for (let i = Math.max(0, data.length - 5); i < data.length; i++) {
    console.log(`  ${i + 1}. ${data[i].name}  -  ${data[i].artist}  -  ${data[i].album}`);
  }

  if (args.dryRun) {
    console.log('\n[--dry-run] 不提交。');
    return 0;
  }

  const payload = JSON.stringify(encIds);
  console.log('\n提交 reorder ...');
  const resp = runNcm([
    'playlist', 'reorder',
    '--playlistId', playlistId,
    '--trackIds', payload,
  ]);
  if (resp.code === 200) {
    console.log(`[OK] 回滚完成,共 ${encIds.length} 首。`);
  } else {
    console.error(`[ERROR] reorder 返回非 200: ${JSON.stringify(resp)}`);
    return 1;
  }
  return 0;
}

process.exit(main());
