'use strict';

/**
 * e2e 测试:通过 fake ncm-cli 走完整 CLI 链路(不碰网络)。
 *
 * 注入方式:
 * - NCM_SORTER_NCM_ENTRY → tests/e2e/fixtures/fake-ncm-cli.js
 *   (src/ncm.js 的 resolveNcmEntry 优先读该环境变量)
 * - NCM_SORTER_CACHE_HOME → 临时目录(备份/新顺序/专辑缓存落盘隔离)
 * - NCM_SORTER_FAKE_LOG → 调用记录文件(fake ncm-cli 每次被调都追加一行 JSON)
 *
 * 覆盖链路:CLI 参数解析 → 数据拉取(分页) → 专辑拉取 → 排序计算 →
 * 备份落盘 → 预览输出 → 提交参数拼装(reorder 的 trackIds 顺序) → 回滚。
 * 唯一不验证的:网易云服务端真的接受请求(fake 返回固定 200)。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'cli.js');
const FAKE_NCM = path.join(__dirname, 'fixtures', 'fake-ncm-cli.js');

/** 期望的排序结果(专辑优先 + 艺人首次出现,与 fixtures 数据集对应)。 */
const EXPECTED_ORDER = [
  // 歌手A(首次出现 #1):专辑一(3 首,专辑内顺序)→ 专辑四(2 首)
  'T01', 'T04', 'T09', 'T06', 'T11',
  // 歌手B(首次出现 #2):专辑二(4 首)
  'T02', 'T05', 'T08', 'T12',
  // 歌手C(首次出现 #3):专辑三(3 首)
  'T03', 'T07', 'T10',
];

/** 跑一次 CLI,注入 fake 环境。返回 { status, stdout, stderr }。 */
function runCli(args, { cacheHome, fakeLog }) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NCM_SORTER_NCM_ENTRY: FAKE_NCM,
      NCM_SORTER_CACHE_HOME: cacheHome,
      NCM_SORTER_FAKE_LOG: fakeLog,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  return res;
}

/** 读取 fake 调用记录。 */
function readFakeLog(fakeLog) {
  if (!fs.existsSync(fakeLog)) return [];
  return fs.readFileSync(fakeLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/** 找到 reorder 调用记录。 */
function findReorderCall(calls) {
  return calls.find(c => c.subcommands.join(' ') === 'playlist reorder');
}

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncm-sorter-e2e-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('e2e: cli.js sort(默认红心歌单)', () => {
  test('--dry-run:全链路跑通,预览输出正确,不提交', () => {
    const cacheHome = path.join(tmpDir, 'cache');
    const fakeLog = path.join(tmpDir, 'calls.log');
    const res = runCli(['sort', '--dry-run'], { cacheHome, fakeLog });

    expect(res.status).toBe(0);
    // 1. 拉到红心歌单(fake 数据)
    expect(res.stdout).toContain('e2e红心歌单');
    expect(res.stdout).toContain('共拿到 12 首');
    // 2. 排序计算完成
    expect(res.stdout).toContain('新顺序共 12 首');
    // 3. 预览含位置变动统计
    expect(res.stdout).toContain('位置变动');
    // 4. dry-run 不提交
    expect(res.stdout).toContain('--dry-run] 不提交');
    const calls = readFakeLog(fakeLog);
    expect(findReorderCall(calls)).toBeUndefined();
    // 5. 备份已落盘
    const backupDir = path.join(cacheHome, 'backups');
    const backups = fs.existsSync(backupDir) ? fs.readdirSync(backupDir) : [];
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^ABC000000000000000000000000001-\d{8}-\d{6}\.json$/);
  });

  test('实际提交:reorder 收到完整且顺序正确的 trackIds', () => {
    const cacheHome = path.join(tmpDir, 'cache');
    const fakeLog = path.join(tmpDir, 'calls.log');
    const res = runCli(['sort'], { cacheHome, fakeLog });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('[OK] 已提交新顺序,共 12 首。');

    const reorder = findReorderCall(readFakeLog(fakeLog));
    expect(reorder).toBeDefined();
    expect(reorder.flags.playlistId).toBe('ABC000000000000000000000000001');
    // trackIds 是 JSON 数组字符串,顺序必须等于期望排序
    expect(JSON.parse(reorder.flags.trackIds)).toEqual(EXPECTED_ORDER);
  });

  test('--save-new-order:新顺序文件落盘且内容正确', () => {
    const cacheHome = path.join(tmpDir, 'cache');
    const fakeLog = path.join(tmpDir, 'calls.log');
    const res = runCli(['sort', '--dry-run', '--save-new-order'], { cacheHome, fakeLog });

    expect(res.status).toBe(0);
    const newPath = path.join(cacheHome, 'new-order', 'ABC000000000000000000000000001.json');
    expect(fs.existsSync(newPath)).toBe(true);
    const rows = JSON.parse(fs.readFileSync(newPath, 'utf8'));
    expect(rows.map(r => r.id)).toEqual(EXPECTED_ORDER);
  });

  test('--no-backup:不写备份文件', () => {
    const cacheHome = path.join(tmpDir, 'cache');
    const fakeLog = path.join(tmpDir, 'calls.log');
    const res = runCli(['sort', '--dry-run', '--no-backup'], { cacheHome, fakeLog });

    expect(res.status).toBe(0);
    expect(res.stdout).not.toContain('[backup]');
    const backupDir = path.join(cacheHome, 'backups');
    expect(fs.existsSync(backupDir)).toBe(false);
  });

  test('专辑缓存落盘:第二次运行不再拉专辑接口', () => {
    const cacheHome = path.join(tmpDir, 'cache');
    const fakeLog1 = path.join(tmpDir, 'calls1.log');
    const fakeLog2 = path.join(tmpDir, 'calls2.log');

    const r1 = runCli(['sort', '--dry-run'], { cacheHome, fakeLog: fakeLog1 });
    expect(r1.status).toBe(0);
    const albumCalls1 = readFakeLog(fakeLog1).filter(c => c.subcommands.join(' ') === 'album tracks');
    expect(albumCalls1).toHaveLength(4); // ALB1~ALB4

    const r2 = runCli(['sort', '--dry-run'], { cacheHome, fakeLog: fakeLog2 });
    expect(r2.status).toBe(0);
    const albumCalls2 = readFakeLog(fakeLog2).filter(c => c.subcommands.join(' ') === 'album tracks');
    expect(albumCalls2).toHaveLength(0); // 全部磁盘缓存命中
  });
});

describe('e2e: cli.js rollback', () => {
  test('从备份回滚:reorder 收到备份中的原始顺序', () => {
    const cacheHome = path.join(tmpDir, 'cache');
    const fakeLog = path.join(tmpDir, 'calls.log');

    // 先跑一次 sort 生成备份
    const sortRes = runCli(['sort', '--dry-run'], { cacheHome, fakeLog });
    expect(sortRes.status).toBe(0);
    const backupDir = path.join(cacheHome, 'backups');
    const backupFile = path.join(backupDir, fs.readdirSync(backupDir)[0]);

    // 回滚(实际提交)
    const rollbackLog = path.join(tmpDir, 'rollback.log');
    const res = runCli(['rollback', backupFile], { cacheHome, fakeLog: rollbackLog });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('[OK] 回滚完成,共 12 首。');

    const reorder = findReorderCall(readFakeLog(rollbackLog));
    expect(reorder).toBeDefined();
    // 回滚 = 按备份里的原始顺序提交;备份记录的是 fake 数据集的原始顺序
    expect(JSON.parse(reorder.flags.trackIds)).toEqual([
      'T01', 'T02', 'T03', 'T04', 'T05', 'T06',
      'T07', 'T08', 'T09', 'T10', 'T11', 'T12',
    ]);
  });

  test('rollback --dry-run:不提交', () => {
    const cacheHome = path.join(tmpDir, 'cache');
    const fakeLog = path.join(tmpDir, 'calls.log');

    const sortRes = runCli(['sort', '--dry-run'], { cacheHome, fakeLog });
    expect(sortRes.status).toBe(0);
    const backupDir = path.join(cacheHome, 'backups');
    const backupFile = path.join(backupDir, fs.readdirSync(backupDir)[0]);

    const rollbackLog = path.join(tmpDir, 'rollback.log');
    const res = runCli(['rollback', backupFile, '--dry-run'], { cacheHome, fakeLog: rollbackLog });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('--dry-run] 不提交');
    expect(findReorderCall(readFakeLog(rollbackLog))).toBeUndefined();
  });

  test('备份文件不存在:非零退出', () => {
    const cacheHome = path.join(tmpDir, 'cache');
    const fakeLog = path.join(tmpDir, 'calls.log');
    const res = runCli(['rollback', path.join(tmpDir, 'no-such-file.json')], { cacheHome, fakeLog });

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('[ERROR]');
  });
});

describe('e2e: 错误路径', () => {
  test('fake ncm-cli 报未知命令时 CLI 以非零退出', () => {
    const cacheHome = path.join(tmpDir, 'cache');
    const fakeLog = path.join(tmpDir, 'calls.log');
    // 不带子命令直接跑 sort 会先调 user favorite;这里用不存在的入口脚本模拟 spawn 失败
    const res = runCli(['sort', '--dry-run'], { cacheHome, fakeLog });
    expect(res.status).toBe(0); // 正常路径对照

    // 入口指向不存在的文件 → spawn 报错 → CLI 退出码 1
    const badEnv = {
      ...process.env,
      NCM_SORTER_NCM_ENTRY: path.join(tmpDir, 'not-exist.js'),
      NCM_SORTER_CACHE_HOME: cacheHome,
    };
    const res2 = spawnSync(process.execPath, [CLI, 'sort', '--dry-run'], {
      encoding: 'utf8',
      env: badEnv,
    });
    expect(res2.status).not.toBe(0);
  });
});
