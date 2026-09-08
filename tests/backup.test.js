'use strict';

/**
 * backup.js 纯函数单元测试(Jest)。
 *
 * 只测无 IO 的部分(snapshot / extractPlaylistIdFromFilename);
 * 落盘类函数(writeBackup/listBackups 等)会写真实 .cache/ 目录,不进单测。
 */

const { snapshot, extractPlaylistIdFromFilename } = require('../src/backup.js');

describe('snapshot', () => {
  test('映射 id/originalId/name/artist/album,缺失字段为 null', () => {
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
    expect(snapshot(tracks)).toEqual([
      { id: 'enc1', originalId: 101, name: '歌名', artist: '艺人', album: '专辑' },
      { id: 'enc2', originalId: undefined, name: '无元数据', artist: null, album: null },
    ]);
  });
});

describe('extractPlaylistIdFromFilename', () => {
  test('兼容新命名与 backup- 前缀', () => {
    expect(
      extractPlaylistIdFromFilename('A9C5C1462885EE859A4199D55BA2891F-20260706-151432.json'),
    ).toBe('A9C5C1462885EE859A4199D55BA2891F');
    expect(
      extractPlaylistIdFromFilename('backup-A9C5C146-20260706-151432.json'),
    ).toBe('A9C5C146');
  });

  test('无法解析返回 null', () => {
    expect(extractPlaylistIdFromFilename('new-order-A9C5.json')).toBe(null);
    expect(extractPlaylistIdFromFilename('random.json')).toBe(null);
    expect(extractPlaylistIdFromFilename('a9c5-20260706.json')).toBe(null); // 小写不匹配
  });
});
