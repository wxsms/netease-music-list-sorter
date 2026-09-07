'use strict';

/**
 * 交互式向导(@clack/prompts)。
 *
 * 流程: intro → 环境预检 → 主菜单(排序/回滚/退出)
 *   排序分支: 选来源(红心/我创建的) → 选歌单 → 拉曲目+计算 → 预览+汇总 → 确认循环 → 提交
 *   回滚分支: 选备份文件 → 摘要 → 确认 → 提交
 *
 * 约定:
 * - 任何 prompt 之后都检查 p.isCancel(),取消统一 p.cancel + exit(0),不发起写操作。
 * - 交互模式强制写备份(无关闭选项)。
 */

const p = require('@clack/prompts');
const { createRequire } = require('module');
const path = require('path');
const readline = require('readline');

const require_ = createRequire(__filename);
const pkg = require_('../package.json');

const { NcmError } = require('./ncm.js');
const {
  fetchFavoritePlaylist, fetchPlaylistTracks, fetchPlaylistList,
} = require('./playlist.js');
const { fetchAlbumTrackOrder, prefetchAlbums } = require('./album-cache.js');
const { computeNewOrder, collectAlbumIds, extractArtistBlocks, reorderByArtistBlocks, firstArtist, albumInfo } = require('./sort.js');
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

/**
 * 同步进度条:每次 update 直接用 \r 重绘当前行。
 *
 * 不用 @clack/prompts 的 progress/spinner:它们靠 setInterval 重绘,
 * 而 runNcm 是 spawnSync 同步阻塞事件循环,interval 永远不会触发,
 * 进度条一帧都画不出来。直写 stdout 才能在同步流程里实时刷新。
 */
function makeSyncProgress() {
  let lastLen = 0;
  let active = false;
  const WIDTH = 24;
  const isTTY = !!process.stdout.isTTY;

  return {
    /** 更新进度(current/total)与标签;非 TTY 下静默跳过渲染。 */
    update(current, total, label) {
      if (!isTTY) return;
      const ratio = total > 0 ? Math.min(1, current / total) : 1;
      const filled = Math.round(ratio * WIDTH);
      const bar = '█'.repeat(filled) + '░'.repeat(WIDTH - filled);
      const pct = String(Math.round(ratio * 100)).padStart(3) + '%';
      const line = `◆  ${bar} ${pct}  ${current}/${total}  ${label}`;
      process.stdout.write('\r' + ' '.repeat(lastLen) + '\r' + line);
      lastLen = line.length;
      active = true;
    },
    /** 清掉进度行并输出完成信息。 */
    finish(msg) {
      if (active && isTTY) {
        process.stdout.write('\r' + ' '.repeat(lastLen) + '\r');
        active = false;
        lastLen = 0;
      }
      if (msg) p.log.success(msg);
    },
  };
}

/**
 * 同步 spinner:帧动画直写 stdout(\r 重绘)。
 *
 * 与 makeSyncProgress 同理:clack 的 spinner 靠 setInterval 重绘,
 * 包同步操作(spawnSync)时一帧都动不了,只剩一条静止的 │ 线。
 * 这里在 start/step 显式推进帧,适合包在同步调用前后/回调里。
 */
function makeSyncSpinner() {
  const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frame = 0;
  let lastLen = 0;
  let active = false;
  const isTTY = !!process.stdout.isTTY;

  return {
    /** 开始/更新:显示带帧动画的消息。 */
    start(msg) {
      if (!isTTY) return;
      const line = `${FRAMES[frame]}  ${msg}`;
      process.stdout.write('\r' + ' '.repeat(lastLen) + '\r' + line);
      lastLen = line.length;
      frame = (frame + 1) % FRAMES.length;
      active = true;
    },
    /** 清掉 spinner 行并输出完成信息(成功/失败由调用方决定文案)。 */
    stop(msg) {
      if (active && isTTY) {
        process.stdout.write('\r' + ' '.repeat(lastLen) + '\r');
        active = false;
        lastLen = 0;
      }
      if (msg) p.log.success(msg);
    },
  };
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
        { value: 'created', label: '🎤 我创建的歌单' },
      ],
    }));

    if (source === 'favorite') {
      p.log.info(`已选红心歌单: ${favorite.name} (ID ${favorite.id}, ${favorite.trackCount} 首)`);
      return favorite;
    }

    // created:拉列表(收藏的歌单是别人创建的,服务端只允许创建者 reorder,不提供该来源)
    let playlists;
    const s = makeSyncSpinner();
    s.start('📡 正在拉取歌单列表...');
    try {
      playlists = fetchPlaylistList(source);
      s.stop(`✅ 拉到 ${playlists.length} 个歌单`);
    } catch (e) {
      s.stop();
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

// ---------- 歌手顺序调整 ----------

/**
 * 歌手顺序调整界面:抓取式键盘交互(直接接管 stdin 自绘列表)。
 *
 * 交互模型:
 * - ↑/↓(或 PgUp/PgDn 翻 10 位):未抓取时移动光标;抓取时移动该歌手(可连续)
 * - Space:抓取/放下光标所在歌手
 * - Enter:确认整个调整结果(返回 artistKey 顺序)
 * - Esc:放弃调整(返回 null,调用方保持原顺序)
 * - Ctrl+C:退出向导(与其它步骤的取消语义一致)
 *
 * clack 没有可重排的列表组件,这里用 readline keypress + ANSI 转义自绘。
 */
async function reorderArtistsPrompt(blocks) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== 'function') {
      p.log.warn('当前终端不支持键盘交互,跳过调整');
      resolve(null);
      return;
    }

    const order = blocks.map(b => b.artistKey);
    const byKey = new Map(blocks.map(b => [b.artistKey, b]));
    const HEIGHT = 12; // 列表可见行数(不含头部提示)
    let cursor = 0;
    let grabbed = false;
    let lastLines = 0;
    let settled = false;

    const CYAN = s => `\x1b[36m${s}\x1b[0m`;
    const MAGENTA = s => `\x1b[35m${s}\x1b[0m`;
    const DIM = s => `\x1b[2m${s}\x1b[0m`;

    function eraseFrame() {
      if (lastLines > 0) {
        stdout.write(`\x1b[${lastLines}A\x1b[J`);
        lastLines = 0;
      }
    }

    function render() {
      eraseFrame();
      const lines = [];
      if (grabbed) {
        const cur = byKey.get(order[cursor]);
        lines.push(MAGENTA(`🎚️ 已抓取「${cur.displayName}」: ↑/↓ 移动 · Space 放下 · Enter 完成`));
      } else {
        lines.push(CYAN('🎚️ ↑/↓ 选择 · Space 抓取移动 · PgUp/PgDn 翻页 · Enter 完成 · Esc 放弃'));
      }
      lines.push('');
      const half = Math.floor((HEIGHT - 1) / 2);
      const start = Math.max(0, Math.min(cursor - half, Math.max(0, order.length - HEIGHT)));
      const end = Math.min(order.length, start + HEIGHT);
      if (start > 0) lines.push(DIM('   ⋮'));
      for (let i = start; i < end; i++) {
        const b = byKey.get(order[i]);
        const marker = i === cursor ? (grabbed ? '↕ ' : '▶ ') : '  ';
        const text = `${marker}${String(i + 1).padStart(3)}. ${b.displayName} (${b.tracks.length} 首)`;
        lines.push(i === cursor ? (grabbed ? MAGENTA(text) : CYAN(text)) : text);
      }
      if (end < order.length) lines.push(DIM('   ⋮'));
      stdout.write(lines.join('\n') + '\n');
      lastLines = lines.length;
    }

    function finish(result, exitWizard) {
      if (settled) return;
      settled = true;
      stdin.removeListener('keypress', onKey);
      try { stdin.setRawMode(false); } catch { /* 已恢复则忽略 */ }
      stdin.resume();
      eraseFrame();
      if (exitWizard) bail(); // process.exit(0),无云端请求
      resolve(result);
    }

    function step(dir, count) {
      count = count || 1;
      if (grabbed) {
        const target = Math.max(0, Math.min(order.length - 1, cursor + dir * count));
        if (target === cursor) { render(); return; } // 边界不动
        const item = order.splice(cursor, 1)[0];
        order.splice(target, 0, item);
        cursor = target;
      } else {
        cursor = Math.max(0, Math.min(order.length - 1, cursor + dir * count));
      }
      render();
    }

    function onKey(str, key) {
      const name = key && key.name;
      if (key && key.ctrl && (name === 'c' || name === 'd')) { finish(null, true); return; }
      if (name === 'up') step(-1);
      else if (name === 'down') step(1);
      else if (name === 'pageup') step(-1, 10);
      else if (name === 'pagedown') step(1, 10);
      else if (name === 'space' || str === ' ') { grabbed = !grabbed; render(); }
      else if (name === 'return' || str === '\r' || str === '\n') { finish(order.slice(), false); }
      else if (name === 'escape') { finish(null, false); }
    }

    readline.emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('keypress', onKey);
    render();
  });
}

// ---------- 排序分支 ----------

/**
 * 排序策略注册表:当前只有默认策略,为将来扩展(如按发行年份、按专辑名)预留。
 * 每个策略:label 用于选择列表,describe 用于确认环节展示,compute(tracks, getAlbumTrackOrder) 返回新顺序。
 */
const SORT_STRATEGIES = [
  {
    id: 'album-first',
    label: '🧩 专辑优先 + 艺人首次出现(默认)',
    hint: '同专辑连排,艺人按首次出现顺序',
    describe: '专辑优先 + 艺人首次出现',
    compute: (tracks, getAlbumTrackOrder) => computeNewOrder(tracks, getAlbumTrackOrder),
  },
];

/**
 * 选择排序策略。返回策略对象;取消走 bail。
 */
async function selectSortStrategy() {
  return guard(await p.select({
    message: '🧮 选择排序策略',
    options: SORT_STRATEGIES.map(s => ({
      value: s,
      label: s.label,
      hint: s.hint,
    })),
  }));
}

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

    // 选排序策略(当前只有默认策略,为将来扩展预留)
    const strategy = await selectSortStrategy();

    // 拉曲目 + 计算
    // 拉取全程反馈:开始(0/total)就有 spinner 帧,分页推进进度条,结束出结果
    const trackProg = makeSyncProgress();
    let tracks;
    try {
      tracks = fetchPlaylistTracks(playlist.id, (loaded, total) => {
        if (loaded === 0) {
          // 开始阶段:总数已知但还没拉到,进度条 0% + spinner 帧
          trackProg.update(0, total, '拉取歌单曲目');
        } else {
          trackProg.update(loaded, total, '拉取歌单曲目');
        }
      });
      trackProg.finish(`✅ 共 ${tracks.length} 首`);
    } catch (e) {
      trackProg.finish();
      p.log.error(ncmErrMsg(e).split('\n')[0]);
      continue; // 换一个歌单
    }

    if (!tracks.length) {
      p.log.warn('歌单为空,无需排序');
      continue;
    }

    // 计算新顺序:先并发预取专辑数据(缓存命中跳过),再纯内存计算
    const albumIds = collectAlbumIds(tracks);
    const prog = makeSyncProgress();
    let newTracks;
    try {
      const { fetched, failed, cached } = await prefetchAlbums(albumIds, (done, total) => {
        prog.update(done, total, '拉取专辑信息(并发)');
      });
      prog.finish(`✅ 专辑数据就绪:缓存 ${cached} 张,新拉 ${fetched} 张${failed ? `,失败 ${failed} 张(退化为原顺序)` : ''}`);
    } catch (e) {
      prog.finish();
      p.log.error(e.message);
      continue;
    }

    try {
      newTracks = strategy.compute(tracks, fetchAlbumTrackOrder);
      if (albumIds.length > 0) p.log.success(`✅ 计算完成(${strategy.describe}),共 ${albumIds.length} 张专辑`);
      else p.log.success(`✅ 计算完成(${strategy.describe},无专辑信息,按原顺序)`);
    } catch (e) {
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
          `排序策略: ${strategy.describe}`,
          `歌曲数: ${newTracks.length}`,
          `备份: 提交前自动写入 .cache/backups/`,
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
          { value: 'adjust', label: '🎚️ 调整歌手顺序' },
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

      if (action === 'adjust') {
        const blocks = extractArtistBlocks(newTracks);
        const adjustedOrder = await reorderArtistsPrompt(blocks);
        if (adjustedOrder) {
          newTracks = reorderByArtistBlocks(newTracks, adjustedOrder);
          p.log.success(`✅ 已按新歌手顺序重排(共 ${adjustedOrder.length} 位歌手)`);
        } else {
          p.log.info('已放弃调整,保持原顺序');
        }
        continue; // 回确认环节,预览自动刷新
      }

      // submit:二次确认(reorder 不可撤销) → 强制备份 → 可选新顺序文件 → 提交
      const confirmed = guard(await p.confirm({
        message: `⚠️  即将提交 ${newTracks.length} 首的新顺序到「${playlist.name}」,云端不可撤销。确认提交?`,
        initialValue: false,
      }));
      if (!confirmed) {
        p.log.info('已取消提交,回到确认环节');
        continue;
      }

      const backupPath = writeBackup(playlist.id, tracks);
      if (saveNewOrder) {
        const newPath = writeNewOrder(playlist.id, newTracks);
        p.log.info(`新顺序已写入 ${newPath}`);
      }

      const s2 = makeSyncSpinner();
      s2.start('🚀 正在提交 reorder...');
      try {
        submitReorder(playlist.id, newTracks.map(t => t.id).filter(Boolean));
        s2.stop('✅ 提交成功');
      } catch (e) {
        s2.stop();
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
    p.log.warn('.cache/backups/ 目录下没有可用的备份文件');
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

  const s = makeSyncSpinner();
  s.start('🚀 正在提交回滚 reorder...');
  try {
    const { encIds } = readBackup(chosen.path);
    rollbackFromBackup(chosen.playlistId, encIds);
    s.stop('✅ 回滚完成');
  } catch (e) {
    s.stop();
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

module.exports = { interactive, reorderArtistsPrompt };
