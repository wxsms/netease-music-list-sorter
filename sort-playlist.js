#!/usr/bin/env node
/**
 * 按专辑优先 + 艺人首次出现顺序重排网易云音乐歌单。
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

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = __dirname;
const OUTPUT_DIR = path.join(REPO_ROOT, 'output');
const CACHE_DIR = path.join(REPO_ROOT, '.cache');

/**
 * 解析 ncm-cli 启动方式,返回 [executable, ...args_prefix] 数组。
 *
 * Windows 上 npm 全局装的是 ncm-cli.cmd shim,spawnSync 不带 shell 时 Node 不会
 * 自动找 .cmd 后缀(ENOENT); 带 shell:true 又会经过 cmd.exe,触发 8K 命令行限制。
 * 解决:直接用 node 启动 ncm-cli 的 dist/index.js,跟 .cmd 内部做的一样。
 */
function resolveNcmEntry() {
  if (process.platform !== 'win32') return ['ncm-cli'];

  // 找 ncm-cli.cmd 或 ncm-cli 所在目录
  const exts = process.env.PATHEXT ? process.env.PATHEXT.split(';') : ['.CMD', '.cmd'];
  const paths = (process.env.PATH || '').split(';').filter(Boolean);
  let shimDir = null;
  for (const p of paths) {
    for (const ext of exts) {
      const candidate = path.join(p, `ncm-cli${ext}`);
      if (fs.existsSync(candidate)) {
        shimDir = p;
        break;
      }
    }
    if (shimDir) break;
    // 也试无后缀的 ncm-cli(shell 脚本,Unix)
    const plain = path.join(p, 'ncm-cli');
    if (fs.existsSync(plain)) {
      shimDir = p;
      break;
    }
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

// ---------- 调 ncm-cli ----------

function runNcm(args) {
  const fullArgs = [...NCM_CMD.slice(1), ...args, '--output', 'json'];
  const res = spawnSync(NCM_CMD[0], fullArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) {
    console.error(`[ERROR] 无法启动 ncm-cli: ${res.error.message}`);
    console.error('请确认 ncm-cli 已通过 npm install -g @music163/ncm-cli 安装并在 PATH 中。');
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
    console.error(`[ERROR] 解析 ncm-cli 输出为 JSON 失败: ${e.message}`);
    console.error(res.stdout.slice(0, 500));
    process.exit(1);
  }
}

// ---------- 拉歌单 ----------

function fetchFavoritePlaylistId() {
  console.log('[1/N] 查询红心歌单 ID ...');
  const resp = runNcm(['user', 'favorite']);
  const data = resp.data || {};
  const pid = data.id;
  if (!pid) {
    console.error(`[ERROR] user favorite 未返回 id,响应: ${JSON.stringify(resp)}`);
    process.exit(1);
  }
  console.log(`      红心歌单: ${data.name} (${data.trackCount} 首),id = ${pid}`);
  return pid;
}

function fetchPlaylistTracks(playlistId) {
  console.log('[2/N] 拉取歌单曲目 ...');
  const meta = runNcm(['playlist', 'get', '--playlistId', playlistId]);
  let total = (meta.data || {}).trackCount || 0;
  if (!total) total = 500;

  const PAGE = 500;
  const tracks = [];
  let offset = 0;
  while (offset < total) {
    const limit = Math.min(PAGE, total - offset);
    const resp = runNcm([
      'playlist', 'tracks',
      '--playlistId', playlistId,
      '--limit', String(limit),
      '--offset', String(offset),
    ]);
    const page = resp.data || [];
    if (!page.length) break;
    tracks.push(...page);
    offset += page.length;
    if (page.length < limit) break;
  }

  console.log(`      共 ${total} 首,实际拿到 ${tracks.length} 首`);
  if (tracks.length < total) {
    console.error(`[WARN] 期望 ${total} 首,只拿到 ${tracks.length} 首。可能是接口分页变化或部分歌曲已下架。`);
  }
  return tracks;
}

// ---------- 缓存 ----------

function cachePathForAlbum(albumId) {
  const safe = albumId.replace(/[^A-Za-z0-9]/g, '_');
  return path.join(CACHE_DIR, `album-${safe}.json`);
}

const albumCache = new Map(); // albumId -> list of track dicts

function fetchAlbumTracks(albumId) {
  if (albumCache.has(albumId)) return albumCache.get(albumId);

  const diskPath = cachePathForAlbum(albumId);
  if (fs.existsSync(diskPath)) {
    try {
      const rows = JSON.parse(fs.readFileSync(diskPath, 'utf8'));
      if (Array.isArray(rows) && rows.every(r => r && typeof r === 'object' && !Array.isArray(r))) {
        albumCache.set(albumId, rows);
        return rows;
      }
    } catch (e) {
      // 缓存损坏,继续走接口
    }
  }

  const resp = runNcm(['album', 'tracks', '--albumId', albumId]);
  const rows = resp.data || [];
  albumCache.set(albumId, rows);

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(diskPath, JSON.stringify(rows, null, 2), 'utf8');
  return rows;
}

function fetchAlbumTrackOrder(albumId) {
  return fetchAlbumTracks(albumId).map(r => r.id).filter(Boolean);
}

// ---------- 排序 ----------

function firstArtist(track) {
  const artists = track.artists || track.fullArtists || [];
  return artists[0] || null;
}

function albumInfo(track) {
  return track.album || null;
}

function artistKey(artist) {
  if (!artist) return '__unknown__';
  return String(artist.originalId || artist.id || `enc:${artist.id}`);
}

function computeNewOrder(tracks) {
  // 1) 按专辑分组
  const albumGroups = new Map(); // albumKey -> [trackIndex...]
  for (let i = 0; i < tracks.length; i++) {
    const al = albumInfo(tracks[i]);
    const alKey = (al && al.id) || '__no_album__';
    if (!albumGroups.has(alKey)) albumGroups.set(alKey, []);
    albumGroups.get(alKey).push(i);
  }

  // 2) 每张专辑的归属艺人 + 在原歌单中首次位置
  const albumMeta = new Map(); // alKey -> { ownerKey, firstPos }
  for (const [alKey, idxs] of albumGroups) {
    const firstIdx = idxs[0];
    const owner = firstArtist(tracks[firstIdx]);
    albumMeta.set(alKey, { ownerKey: artistKey(owner), firstPos: firstIdx });
  }

  // 3) 每个 owner 在原歌单里首次出现位置(用于艺人之间排序)
  const ownerFirstPos = new Map();
  for (let i = 0; i < tracks.length; i++) {
    const k = artistKey(firstArtist(tracks[i]));
    if (!ownerFirstPos.has(k)) ownerFirstPos.set(k, i);
  }

  // 4) 把专辑归到 owner 名下
  const ownerAlbums = new Map(); // ownerKey -> [albumKey...]
  for (const [alKey, meta] of albumMeta) {
    if (!ownerAlbums.has(meta.ownerKey)) ownerAlbums.set(meta.ownerKey, []);
    ownerAlbums.get(meta.ownerKey).push(alKey);
  }

  // owner 之间排序(__unknown__ 落到末尾)
  const ownerOrder = [...ownerAlbums.keys()].sort((a, b) => {
    const pa = ownerFirstPos.has(a) ? ownerFirstPos.get(a) : tracks.length + 1;
    const pb = ownerFirstPos.has(b) ? ownerFirstPos.get(b) : tracks.length + 1;
    return pa - pb;
  });

  const newTracks = [];
  for (const ownerKey of ownerOrder) {
    const albumKeys = ownerAlbums.get(ownerKey).sort((a, b) => albumMeta.get(a).firstPos - albumMeta.get(b).firstPos);

    for (const alKey of albumKeys) {
      const idxList = albumGroups.get(alKey);
      if (alKey === '__no_album__') {
        for (const idx of idxList) newTracks.push(tracks[idx]);
        continue;
      }

      let albumOrder;
      try {
        albumOrder = fetchAlbumTrackOrder(alKey);
      } catch (e) {
        console.error(`[WARN] 拉专辑 ${alKey} 顺序失败: ${e.message},退化为原顺序`);
        albumOrder = [];
      }

      const inAlbum = [];
      const outAlbum = [];
      for (const idx of idxList) {
        const encId = tracks[idx].id;
        if (albumOrder.includes(encId)) inAlbum.push(idx);
        else outAlbum.push(idx);
      }
      inAlbum.sort((ia, ib) => albumOrder.indexOf(tracks[ia].id) - albumOrder.indexOf(tracks[ib].id));
      for (const idx of inAlbum) newTracks.push(tracks[idx]);
      for (const idx of outAlbum) newTracks.push(tracks[idx]);
    }
  }
  return newTracks;
}

// ---------- 备份 / 新顺序落盘 ----------

function snapshot(tracks) {
  return tracks.map(t => ({
    id: t.id,
    originalId: t.originalId,
    name: t.name,
    artist: (firstArtist(t) || {}).name || null,
    album: (albumInfo(t) || {}).name || null,
  }));
}

function writeBackup(playlistId, tracks) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const path_ = path.join(OUTPUT_DIR, `backup-${playlistId}-${ts}.json`);
  fs.writeFileSync(path_, JSON.stringify(snapshot(tracks), null, 2), 'utf8');
  return path_;
}

function writeNewOrder(playlistId, tracks) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const path_ = path.join(OUTPUT_DIR, `new-order-${playlistId}.json`);
  fs.writeFileSync(path_, JSON.stringify(snapshot(tracks), null, 2), 'utf8');
  return path_;
}

// ---------- 提交 reorder ----------

function submitReorder(playlistId, newTracks) {
  const encIds = newTracks.map(t => t.id).filter(Boolean);
  const payload = JSON.stringify(encIds);
  const resp = runNcm([
    'playlist', 'reorder',
    '--playlistId', playlistId,
    '--trackIds', payload,
  ]);
  if (resp.code === 200) {
    console.log(`[OK] 已提交新顺序,共 ${encIds.length} 首。`);
  } else {
    console.error(`[ERROR] reorder 返回非 200: ${JSON.stringify(resp)}`);
    process.exit(1);
  }
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

  const playlistId = args.playlistId || fetchFavoritePlaylistId();
  const tracks = fetchPlaylistTracks(playlistId);
  if (!tracks.length) {
    console.log('[WARN] 歌单为空,无需排序。');
    return 0;
  }

  if (!args.noBackup) {
    const backupPath = writeBackup(playlistId, tracks);
    console.log(`[backup] 原顺序已备份至 ${backupPath}`);
  }

  console.log('[3/N] 计算新顺序(可能需要拉取专辑信息)...');
  const newTracks = computeNewOrder(tracks);
  console.log(`      完成。新顺序共 ${newTracks.length} 首,共调用 album tracks ${albumCache.size} 次。`);

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
  submitReorder(playlistId, newTracks);
  return 0;
}

process.exit(main());
