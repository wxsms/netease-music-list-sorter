'use strict';

/**
 * backup.js 纯函数单元测试(node:test)。
 *
 * 只测无 IO 的部分(snapshot / extractPlaylistIdFromFilename);
 * 落盘类函数(writeBackup/listBackups 等)会写真实 .cache/ 目录,不进单测。
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { snapshot, extractPlaylistIdFromFilename } = require('../src/backup.js');

test('snapshot: 映射 id/originalId/name/artist/album,缺失字段为 null', () => {
  const tracks = [
    {
      id: 'enc1',
      originalId: 101,
      name: '歌名',
      artists: [{ name: '艺人' }],
      album: { name: '专辑' },
    },
    { id: 'enc2', name: '无元数据' },
  ];
  assert.deepEqual(snapshot(tracks), [
    { id: 'enc1', originalId: 101, name: '歌名', artist: '艺人', album: '专辑' },
    { id: 'enc2', originalId: undefined, name: '无元数据', artist: null, album: null },
  ]);
});

test('extractPlaylistIdFromFilename: 兼容新命名与 backup- 前缀', () => {
  assert.equal(
    extractPlaylistIdFromFilename('A9C5C1462885EE859A4199D55BA2891F-20260706-151432.json'),
    'A9C5C1462885EE859A4199D55BA2891F',
  );
  assert.equal(
    extractPlaylistIdFromFilename('backup-A9C5C146-20260706-151432.json'),
    'A9C5C146',
  );
});

test('extractPlaylistIdFromFilename: 无法解析返回 null', () => {
  assert.equal(extractPlaylistIdFromFilename('new-order-A9C5.json'), null);
  assert.equal(extractPlaylistIdFromFilename('random.json'), null);
  assert.equal(extractPlaylistIdFromFilename('a9c5-20260706.json'), null); // 小写不匹配
});
