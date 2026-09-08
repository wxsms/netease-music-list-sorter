'use strict';

/**
 * backup.js 落盘类函数单元测试(Jest)。
 *
 * writeBackup/writeNewOrder/listBackups 会写真实目录,这里通过
 * NCM_SORTER_CACHE_HOME 环境变量把缓存目录(cache-home.js 解析)指到
 * os.tmpdir() 下的隔离目录,并用 jest.isolateModules 每次拿到干净的
 * 模块实例,避免污染用户真实缓存目录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** 在临时缓存目录下加载 backup 模块。 */
function loadModule() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncm-sorter-test-'));
  process.env.NCM_SORTER_CACHE_HOME = root;
  let mod;
  jest.isolateModules(() => {
    mod = require('../src/backup.js');
  });
  delete process.env.NCM_SORTER_CACHE_HOME;
  return {
    mod,
    root,
    backupDir: path.join(root, 'backups'),
    newOrderDir: path.join(root, 'new-order'),
  };
}

/** 递归删除临时目录。 */
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 造一首歌。 */
function track(id, name) {
  return { id, name: name || `song-${id}`, artists: [{ name: 'A' }], album: { name: 'AL' } };
}

// ---------- writeBackup / writeNewOrder ----------

describe('writeBackup / writeNewOrder', () => {
  test('writeBackup 写入 .cache/backups/<pid>-<ts>.json,内容为 snapshot', () => {
    const { mod, backupDir, root } = loadModule();
    try {
      const p = mod.writeBackup('ABC123', [track('e1', '歌1')]);
      expect(p).toMatch(/[\\/]ABC123-\d{8}-\d{6}\.json$/);
      expect(path.dirname(p)).toBe(backupDir);
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      expect(data).toEqual([
        { id: 'e1', originalId: undefined, name: '歌1', artist: 'A', album: 'AL' },
      ]);
    } finally {
      cleanup(root);
    }
  });

  test('writeNewOrder 固定文件名,覆盖写', () => {
    const { mod, newOrderDir, root } = loadModule();
    try {
      const p1 = mod.writeNewOrder('ABC123', [track('e1')]);
      const p2 = mod.writeNewOrder('ABC123', [track('e1'), track('e2')]);
      expect(p1).toBe(p2);
      expect(p2).toBe(path.join(newOrderDir, 'ABC123.json'));
      const data = JSON.parse(fs.readFileSync(p2, 'utf8'));
      expect(data).toHaveLength(2);
    } finally {
      cleanup(root);
    }
  });
});

// ---------- listBackups ----------

describe('listBackups', () => {
  test('按时间戳倒序,返回 path/playlistId/trackCount', () => {
    const { mod, backupDir, root } = loadModule();
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, 'AAA-20260101-000000.json'), JSON.stringify([{}, {}]));
      fs.writeFileSync(path.join(backupDir, 'AAA-20260202-000000.json'), JSON.stringify([{}]));
      fs.writeFileSync(path.join(backupDir, 'BBB-20260101-000000.json'), JSON.stringify([{}, {}, {}]));
      fs.writeFileSync(path.join(backupDir, 'not-a-backup.json'), '{}'); // 不匹配命名 → 跳过

      const out = mod.listBackups();
      // 文件名全串倒序:BBB-20260101 > AAA-20260202 > AAA-20260101(B 字母序更靠后)
      expect(out.map(b => b.playlistId)).toEqual(['BBB', 'AAA', 'AAA']);
      expect(out[0].trackCount).toBe(3);
      expect(out[1].trackCount).toBe(1); // AAA 内 20260202 在前
      expect(out[2].trackCount).toBe(2);
      expect(out.every(b => b.path.startsWith(backupDir))).toBe(true);
    } finally {
      cleanup(root);
    }
  });

  test('损坏的 JSON 仍列出,trackCount 为 null', () => {
    const { mod, backupDir, root } = loadModule();
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(path.join(backupDir, 'CCC-20260101-000000.json'), '{broken');
      const out = mod.listBackups();
      expect(out).toHaveLength(1);
      expect(out[0].trackCount).toBe(null);
    } finally {
      cleanup(root);
    }
  });

  test('目录不存在返回空数组', () => {
    const { mod, root } = loadModule();
    try {
      expect(mod.listBackups()).toEqual([]);
    } finally {
      cleanup(root);
    }
  });
});

// ---------- readBackup ----------

describe('readBackup', () => {
  test('返回 { tracks, encIds, path }', () => {
    const { mod, backupDir, root } = loadModule();
    try {
      const file = path.join(backupDir, 'x.json');
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify([{ id: 'a' }, { id: 'b' }, { name: 'no-id' }]));
      const out = mod.readBackup(file);
      expect(out.tracks).toHaveLength(3);
      expect(out.encIds).toEqual(['a', 'b']); // 无 id 的被过滤
    } finally {
      cleanup(root);
    }
  });

  test('文件不存在抛错', () => {
    const { mod, root } = loadModule();
    try {
      expect(() => mod.readBackup(path.join(root, 'nope.json'))).toThrow(/不存在/);
    } finally {
      cleanup(root);
    }
  });

  test('非 JSON 数组抛错', () => {
    const { mod, backupDir, root } = loadModule();
    try {
      const file = path.join(backupDir, 'x.json');
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(file, '{"a":1}');
      expect(() => mod.readBackup(file)).toThrow(/不是 JSON 数组/);
    } finally {
      cleanup(root);
    }
  });
});
