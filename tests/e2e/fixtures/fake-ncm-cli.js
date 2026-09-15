#!/usr/bin/env node
'use strict';

/**
 * e2e 测试用的 fake ncm-cli。
 *
 * 通过环境变量 NCM_SORTER_NCM_ENTRY 指向本文件注入,替代真实 ncm-cli:
 * - 不碰网络,返回固定/可配置的 JSON 数据
 * - 把每次收到的调用参数追加记录到 NCM_SORTER_FAKE_LOG,
 *   供 e2e 断言"提交了什么"(reorder 的 trackIds 顺序等)
 *
 * 支持的命令与返回(模拟真实 ncm-cli 的 JSON 输出结构):
 * - user favorite          → 红心歌单(固定 ID)
 * - user info              → 用户信息
 * - playlist get           → 歌单元数据(trackCount)
 * - playlist tracks        → 歌单曲目(分页,每页 500)
 * - album tracks           → 专辑内曲目顺序
 * - playlist reorder       → 记录调用并返回 code 200
 * - 其它                   → code 200 空数据
 *
 * 曲目数据通过 NCM_SORTER_FAKE_TRACKS 传入(JSON 文件路径),
 * 未传时用内置的小型固定数据集。
 */

const fs = require('fs');

// ---------- 固定数据集 ----------

const ARTIST = (id, name) => ({ originalId: id, id: String(id), name });
const ALBUM = (id, name) => ({ id, name });

// 3 位歌手、4 张专辑、12 首歌;顺序故意打散(同专辑/同歌手的歌交错出现)
const DEFAULT_TRACKS = [
  { id: 'T01', originalId: 101, name: '歌A1', artists: [ARTIST(1, '歌手A')], album: ALBUM('ALB1', '专辑一') },
  { id: 'T02', originalId: 102, name: '歌B1', artists: [ARTIST(2, '歌手B')], album: ALBUM('ALB2', '专辑二') },
  { id: 'T03', originalId: 103, name: '歌C1', artists: [ARTIST(3, '歌手C')], album: ALBUM('ALB3', '专辑三') },
  { id: 'T04', originalId: 104, name: '歌A2', artists: [ARTIST(1, '歌手A')], album: ALBUM('ALB1', '专辑一') },
  { id: 'T05', originalId: 105, name: '歌B2', artists: [ARTIST(2, '歌手B')], album: ALBUM('ALB2', '专辑二') },
  { id: 'T06', originalId: 106, name: '歌A3', artists: [ARTIST(1, '歌手A')], album: ALBUM('ALB4', '专辑四') },
  { id: 'T07', originalId: 107, name: '歌C2', artists: [ARTIST(3, '歌手C')], album: ALBUM('ALB3', '专辑三') },
  { id: 'T08', originalId: 108, name: '歌B3', artists: [ARTIST(2, '歌手B')], album: ALBUM('ALB2', '专辑二') },
  { id: 'T09', originalId: 109, name: '歌A4', artists: [ARTIST(1, '歌手A')], album: ALBUM('ALB1', '专辑一') },
  { id: 'T10', originalId: 110, name: '歌C3', artists: [ARTIST(3, '歌手C')], album: ALBUM('ALB3', '专辑三') },
  { id: 'T11', originalId: 111, name: '歌A5', artists: [ARTIST(1, '歌手A')], album: ALBUM('ALB4', '专辑四') },
  { id: 'T12', originalId: 112, name: '歌B4', artists: [ARTIST(2, '歌手B')], album: ALBUM('ALB2', '专辑二') },
];

// 专辑内顺序:与歌单内出现顺序不同(验证按专辑内顺序重排)
const ALBUM_ORDERS = {
  ALB1: ['T01', 'T04', 'T09'],
  ALB2: ['T02', 'T05', 'T08', 'T12'],
  ALB3: ['T03', 'T07', 'T10'],
  ALB4: ['T06', 'T11'],
};

const FAVORITE = { id: 'ABC000000000000000000000000001', name: 'e2e红心歌单', trackCount: DEFAULT_TRACKS.length };

// ---------- 参数解析 ----------

// 真实 ncm-cli 的参数形如: <sub...> --output json [--k v ...]
// 本 fake 只关心子命令序列与少数键值对。
const argv = process.argv.slice(2);
const subcommands = [];
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  } else {
    subcommands.push(a);
  }
}

// ---------- 记录调用 ----------

const logFile = process.env.NCM_SORTER_FAKE_LOG;
if (logFile) {
  const entry = { subcommands, flags, pid: process.pid, time: Date.now() };
  fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8');
}

// ---------- 命令分发 ----------

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

const sub = subcommands.join(' ');

if (sub === 'user favorite') {
  out({ code: 200, data: FAVORITE });
}
if (sub === 'user info') {
  out({ code: 200, data: { nickname: 'e2e测试用户' } });
}
if (sub === 'playlist get') {
  out({ code: 200, data: { trackCount: DEFAULT_TRACKS.length } });
}
if (sub === 'playlist tracks') {
  // 分页:--limit/--offset(默认每页 500)
  const limit = Number(flags.limit) || 500;
  const offset = Number(flags.offset) || 0;
  const page = DEFAULT_TRACKS.slice(offset, offset + limit);
  out({ code: 200, data: page });
}
if (sub === 'album tracks') {
  const albumId = flags.albumId;
  const order = ALBUM_ORDERS[albumId] || [];
  // 模拟真实返回:完整曲目对象列表(取 DEFAULT_TRACKS 中对应曲目)
  const rows = order.map(id => DEFAULT_TRACKS.find(t => t.id === id)).filter(Boolean);
  out({ code: 200, data: rows });
}
if (sub === 'playlist reorder') {
  // 校验 trackIds 必填,返回成功
  if (!flags.playlistId || !flags.trackIds) {
    process.stderr.write('fake ncm-cli: reorder 缺少 playlistId/trackIds');
    process.exit(1);
  }
  out({ code: 200, data: { success: true } });
}

// 未知命令:模拟真实 ncm-cli 的报错行为(非零退出 + stderr)
process.stderr.write(`fake ncm-cli: unknown command '${sub}'`);
process.exit(1);
