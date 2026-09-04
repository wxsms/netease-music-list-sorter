'use strict';

/**
 * 交互式向导(@clack/prompts)。
 *
 * 流程: intro → 环境预检 → 主菜单(排序/回滚/退出)
 *   排序分支: 选来源(红心/收藏/创建) → 选歌单 → 拉曲目+计算 → 预览+汇总 → 确认循环 → 提交
 *   回滚分支: 选备份文件 → 摘要 → 确认 → 提交
 *
 * 约定:
 * - 任何 prompt 之后都检查 p.isCancel(),取消统一 p.cancel + exit(0),不发起写操作。
 * - 交互模式强制写备份(无关闭选项)。
 */

const p = require('@clack/prompts');
const { createRequire } = require('module');
const path = require('path');

const require_ = createRequire(__filename);
const pkg = require_('../package.json');

const { runNcm, NcmError } = require('./ncm.js');
const {
  fetchFavoritePlaylist, fetchPlaylistTracks, fetchPlaylistList,
} = require('./playlist.js');
const { fetchAlbumTrackOrder, loadedAlbumCount } = require('./album-cache.js');
const { computeNewOrder, firstArtist, albumInfo } = require('./sort.js');
const { writeBackup, writeNewOrder, listBackups, readBackup } = require('./backup.js');
const { submitReorder, rollbackFromBackup } = require('./reorder.js');

/** 统一取消出口:显示信息并以 0 退出。 */
function bail(msg) {
  p.cancel(msg || '已取消');
  process.exit(0);
}

/** prompt 包装:取消即退出。 */
function guard(value, msg) {
  if (p.isCancel(value)) bail(msg);
  return value;
}

/** 把 NcmError 转成用户可读信息。 */
function ncmErrMsg(e) {
  if (e instanceof NcmError) {
    return e.detail ? `${e.message}\n${e.detail}` : e.message;
  }
  return e.message;
}

// ---------- 环境预检 ----------

/**
 * 一次 user favorite 调用同时验证"可执行"与"已登录"。
 * 返回红心歌单 { id, name, trackCount }(选红心来源时直接复用,省一次请求)。
 */
function precheck() {
  try {
    return fetchFavoritePlaylist();
  } catch (e) {
    if (e instanceof NcmError && e.kind === 'spawn') {
      p.note(
        [
          '未检测到 ncm-cli。请先安装并登录:',
          '',
          '  npm install -g @music163/ncm-cli',
          '  ncm-cli login',
        ].join('\n'),
        '❌ ncm-cli 不可用',
      );
    } else {
      p.note(
        [
          'ncm-cli 已安装,但调用失败(可能未登录或凭据失效)。',
          '',
          '  请先运行: ncm-cli login',
          '',
          ncmErrMsg(e).slice(0, 300),
        ].join('\n'),
        '❌ ncm-cli 未登录或调用失败',
      );
    }
    process.exit(1);
  }
}

// ---------- 歌单选择 ----------

/**
 * 选择目标歌单。返回 { id, name, trackCount }。
 * @param favorite 预检时拿到的红心歌单信息(复用,不重复请求)
 */
async function selectPlaylist(favorite) {
  // 来源选择循环:空列表/失败时回到这里
  for (;;) {
    const source = guard(await p.select({
      message: '📋 选择歌单来源',
      options: [
        { value: 'favorite', label: `❤️ 红心歌单: ${favorite.name} (${favorite.trackCount} 首)`, hint: '默认' },
        { value: 'collected', label: '📥 我收藏的歌单' },
        { value: 'created', label: '🎤 我创建的歌单' },
      ],
    }));

    if (source === 'favorite') {
      p.log.info(`已选红心歌单: ${favorite.name} (ID ${favorite.id}, ${favorite.trackCount} 首)`);
      return favorite;
    }

    // collected / created:拉列表
    let playlists;
    const s = p.spinner();
    s.start('📡 正在拉取歌单列表...');
    try {
      playlists = fetchPlaylistList(source);
      s.stop(`✅ 拉到 ${playlists.length} 个歌单`);
    } catch (e) {
      s.stop('❌ 拉取歌单列表失败');
      const retry = guard(await p.select({
        message: `拉取失败: ${ncmErrMsg(e).slice(0, 200).split('\n')[0]}`,
        options: [
          { value: 'retry', label: '🔄 重试' },
          { value: 'back', label: '↩️ 返回重选来源' },
          { value: 'quit', label: '❌ 退出' },
        ],
      }));
      if (retry === 'retry') continue;
      if (retry === 'back') continue;
      bail();
    }

    if (!playlists.length) {
      p.log.warn('该来源下没有歌单');
      continue; // 返回来源选择
    }

    const chosen = guard(await p.select({
      message: `📋 选择要排序的歌单(共 ${playlists.length} 个)`,
      options: playlists.map(pl => ({
        value: pl,
        label: `${pl.name}`,
        hint: `${pl.trackCount} 首`,
      })),
    }));

    p.log.info(`已选歌单: ${chosen.name} (ID ${chosen.id}, ${chosen.trackCount} 首)`);
    return chosen;
  }
}

// ---------- 排序分支 ----------

function previewLines(oldTracks, newTracks, n = 15) {
  const lines = [];
  const limit = Math.min(n, newTracks.length);
  for (let i = 0; i < limit; i++) {
    const t = newTracks[i];
    const name = (t.name || '').slice(0, 30);
    const artist = ((firstArtist(t) || {}).name || '').slice(0, 15);
    const album = (albumInfo(t) || {}).name || '';
    lines.push(`${String(i + 1).padStart(3)}  ${name.padEnd(30)}  ${artist.padEnd(15)}  ${album}`);
  }
  if (newTracks.length > n) lines.push(`... 共 ${newTracks.length} 首`);

  let moved = 0;
  for (let i = 0; i < newTracks.length; i++) {
    const oldId = i < oldTracks.length ? oldTracks[i].id : null;
    if (newTracks[i].id !== oldId) moved++;
  }
  lines.push('');
  lines.push(`位置变动: ${moved} / ${newTracks.length}`);
  return lines;
}

async function sortFlow(favorite) {
  // 外层循环:换一个歌单时回到选歌单
  for (;;) {
    const playlist = await selectPlaylist(favorite);

    // 拉曲目 + 计算
    const s = p.spinner();
    s.start('📡 正在拉取歌单曲目...');
    let tracks;
    try {
      tracks = fetchPlaylistTracks(playlist.id);
      s.stop(`✅ 共 ${tracks.length} 首`);
    } catch (e) {
      s.stop('❌ 拉取歌单曲目失败');
      p.log.error(ncmErrMsg(e).split('\n')[0]);
      continue; // 换一个歌单
    }

    if (!tracks.length) {
      p.log.warn('歌单为空,无需排序');
      continue;
    }

    s.start('🔄 正在计算新顺序(可能需要拉取专辑信息)...');
    let newTracks;
    try {
      newTracks = computeNewOrder(tracks, fetchAlbumTrackOrder);
      s.stop(`✅ 计算完成,共 ${loadedAlbumCount()} 张专辑`);
    } catch (e) {
      s.stop('❌ 计算新顺序失败');
      p.log.error(e.message);
      continue;
    }

    // 可调选项
    let saveNewOrder = false;

    // 预览 + 汇总 + 确认循环
    for (;;) {
      p.note(
        [
          `歌单: ${playlist.name} (ID ${playlist.id})`,
          `歌曲数: ${newTracks.length}`,
          `备份: 提交前自动写入 output/`,
          `保存新顺序文件: ${saveNewOrder ? '是' : '否'}`,
          '',
          '新顺序预览(前 15 首):',
          ...previewLines(tracks, newTracks),
        ].join('\n'),
        '✅ 确认排序信息',
      );

      const action = guard(await p.select({
        message: '请确认',
        options: [
          { value: 'submit', label: '🚀 确认提交' },
          { value: 'toggle-save', label: `💾 保存新顺序文件: ${saveNewOrder ? '是' : '否'}` },
          { value: 'change', label: '📂 换一个歌单' },
          { value: 'cancel', label: '❌ 取消' },
        ],
      }));

      if (action === 'cancel') bail();
      if (action === 'change') break; // 回到选歌单

      if (action === 'toggle-save') {
        saveNewOrder = !saveNewOrder;
        continue;
      }

      // submit:强制备份 → 可选新顺序文件 → 提交
      const backupPath = writeBackup(playlist.id, tracks);
      if (saveNewOrder) {
        const newPath = writeNewOrder(playlist.id, newTracks);
        p.log.info(`新顺序已写入 ${newPath}`);
      }

      const s2 = p.spinner();
      s2.start('🚀 正在提交 reorder...');
      try {
        submitReorder(playlist.id, newTracks.map(t => t.id).filter(Boolean));
        s2.stop('✅ 提交成功');
      } catch (e) {
        s2.stop('❌ 提交失败');
        p.log.error(ncmErrMsg(e).split('\n')[0]);
        p.log.info(`原顺序备份在: ${backupPath}`);
        process.exit(1);
      }
      p.outro(`✅ 已提交新顺序(共 ${newTracks.length} 首),备份: ${backupPath}`);
      return;
    }
  }
}

// ---------- 回滚分支 ----------

async function rollbackFlow() {
  const backups = listBackups();

  if (!backups.length) {
    p.log.warn('output/ 目录下没有可用的备份文件');
    return; // 回主菜单
  }

  const chosen = guard(await p.select({
    message: `⏪ 选择要回滚到的备份(共 ${backups.length} 个,最新在前)`,
    options: backups.map(b => ({
      value: b,
      label: path.basename(b.path),
      hint: b.trackCount != null ? `${b.trackCount} 首` : '歌曲数未知',
    })),
  }));

  p.note(
    [
      `备份文件: ${path.basename(chosen.path)}`,
      `歌曲数: ${chosen.trackCount != null ? chosen.trackCount : '未知'}`,
      `目标歌单 ID: ${chosen.playlistId}`,
    ].join('\n'),
    '回滚信息',
  );

  const go = guard(await p.confirm({
    message: '确认按该备份回滚歌单顺序?',
    initialValue: false,
  }));
  if (!go) bail();

  const s = p.spinner();
  s.start('🚀 正在提交回滚 reorder...');
  try {
    const { encIds } = readBackup(chosen.path);
    rollbackFromBackup(chosen.playlistId, encIds);
    s.stop('✅ 回滚完成');
  } catch (e) {
    s.stop('❌ 回滚失败');
    p.log.error(ncmErrMsg(e).split('\n')[0]);
    process.exit(1);
  }
  p.outro(`✅ 歌单顺序已回滚(共 ${chosen.trackCount ?? '?'} 首)`);
}

// ---------- 主入口 ----------

async function interactive() {
  p.intro(`🎵 网易云歌单排序 v${pkg.version}`);

  const favorite = precheck();
  p.log.success(`✅ ncm-cli 可用,已登录(红心歌单: ${favorite.name}, ${favorite.trackCount} 首)`);

  for (;;) {
    const action = guard(await p.select({
      message: '想做什么?',
      options: [
        { value: 'sort', label: '🎵 排序歌单' },
        { value: 'rollback', label: '⏪ 回滚歌单顺序' },
        { value: 'quit', label: '👋 退出' },
      ],
    }));

    if (action === 'quit') {
      p.outro('再见 👋');
      return;
    }
    if (action === 'sort') {
      await sortFlow(favorite);
      return;
    }
    if (action === 'rollback') {
      await rollbackFlow();
      // 回滚分支结束后回主菜单(空备份场景);正常完成回滚时 rollbackFlow 已 outro 并退出
    }
  }
}

module.exports = { interactive };
