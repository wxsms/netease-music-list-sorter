'use strict';

/**
 * ncm.js 单元测试(Jest)。
 *
 * mock child_process 的 spawnSync/spawn,测 runNcm 的三种错误分类
 * (spawn/exit/parse)与成功路径。resolveNcmEntry 的优先级与回退分支
 * (本地依赖 → 全局 shim → 兕底 'ncm-cli')也顺带覆盖。
 */

const childProcess = require('child_process');

jest.spyOn(childProcess, 'spawnSync');
jest.spyOn(childProcess, 'spawn');

// ncm.js 在模块加载时调用 resolveNcmEntry(读 PATH/文件系统),
// 这里 mock 掉 fs 的 existsSync,让全局 shim 查找走"找不到"分支,
// 保证测试环境无关(不依赖本机是否全局装了 ncm-cli)。
// 注意:项目本地依赖(require.resolve)优先于全局查找,装了依赖的
// 开发环境会命中本地分支,未装时走全局分支,两者都合法。
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(() => false),
  };
});

const { runNcm, NcmError, resolveNcmEntry, loginInteractive, checkLogin, isApiKeyMissing, setConfig } = require('../src/ncm.js');

beforeEach(() => {
  childProcess.spawnSync.mockReset();
  childProcess.spawn.mockReset();
});

describe('runNcm', () => {
  test('成功:解析 stdout JSON 并追加 --output json 参数', () => {
    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: '{"code":200,"data":[]}',
      stderr: '',
    });
    const out = runNcm(['playlist', 'get', '--playlistId', 'P1']);
    expect(out).toEqual({ code: 200, data: [] });
    // 传给 spawnSync 的参数应包含 --output json
    const args = childProcess.spawnSync.mock.calls[0][1];
    expect(args).toContain('--output');
    expect(args).toContain('json');
    expect(args).toContain('playlist');
  });

  test('spawn 失败:抛 NcmError(kind=spawn),detail 提示安装', () => {
    childProcess.spawnSync.mockReturnValue({
      error: new Error('ENOENT'),
      status: null,
      stdout: '',
      stderr: '',
    });
    let err;
    try {
      runNcm(['x']);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NcmError);
    expect(err.kind).toBe('spawn');
    expect(err.message).toContain('无法启动 ncm-cli');
    expect(err.detail).toContain('npm install -g');
  });

  test('非零退出码:抛 NcmError(kind=exit),detail 截断到 500 字符', () => {
    childProcess.spawnSync.mockReturnValue({
      status: 1,
      stdout: '',
      stderr: 'x'.repeat(1000),
    });
    let err;
    try {
      runNcm(['x']);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NcmError);
    expect(err.kind).toBe('exit');
    expect(err.message).toBe('ncm-cli 退出码 1');
    expect(err.detail).toHaveLength(500);
  });

  test('stdout 非合法 JSON:抛 NcmError(kind=parse)', () => {
    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: 'not json at all',
      stderr: '',
    });
    let err;
    try {
      runNcm(['x']);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(NcmError);
    expect(err.kind).toBe('parse');
    expect(err.message).toContain('解析 ncm-cli 输出为 JSON 失败');
    expect(err.detail).toBe('not json at all');
  });

  test('NcmError 是 Error 子类,name 为 NcmError', () => {
    const e = new NcmError('spawn', 'msg', 'detail');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('NcmError');
    expect(e.message).toBe('msg');
    expect(e.detail).toBe('detail');
  });
});

describe('isApiKeyMissing', () => {
  test('exit 错误且 detail 含「API key 未设置」→ true', () => {
    const e = new NcmError('exit', 'ncm-cli 退出码 1', '[错误] API key 未设置，请通过以下方式之一配置：\n  - 运行 ncm-cli configure 进行交互式配置');
    expect(isApiKeyMissing(e)).toBe(true);
  });

  test('detail 为 stdout 场景(含相同文案)→ true', () => {
    // detail 是 (stderr || stdout).slice(0,500),两种来源都可能出现
    const e = new NcmError('exit', 'ncm-cli 退出码 1', 'API key 未设置');
    expect(isApiKeyMissing(e)).toBe(true);
  });

  test('exit 错误但 detail 是其它文案(未登录等)→ false', () => {
    const e = new NcmError('exit', 'ncm-cli 退出码 1', '登录已过期,请重新登录');
    expect(isApiKeyMissing(e)).toBe(false);
  });

  test('spawn / parse 错误 → false', () => {
    expect(isApiKeyMissing(new NcmError('spawn', '无法启动', ''))).toBe(false);
    expect(isApiKeyMissing(new NcmError('parse', '解析失败', 'API key 未设置'))).toBe(false);
  });

  test('非 NcmError → false', () => {
    expect(isApiKeyMissing(new Error('API key 未设置'))).toBe(false);
    expect(isApiKeyMissing(null)).toBe(false);
  });
});

describe('setConfig', () => {
  test('调用 ncm-cli config set <key> <value> 且不追加 --output json', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: '✓ 已设置 appId = x', stderr: '' });
    setConfig('appId', 'my-app-id');
    const [cmd, args] = childProcess.spawnSync.mock.calls[0];
    expect(cmd).toBeTruthy();
    expect(args).toContain('config');
    expect(args).toContain('set');
    expect(args).toContain('appId');
    expect(args).toContain('my-app-id');
    expect(args).not.toContain('--output'); // config set 是纯文本输出,不解析 JSON
  });

  test('成功(退出码 0)返回 true', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0, stdout: '✓ 已设置', stderr: '' });
    expect(setConfig('privateKey', 'key123')).toBe(true);
  });

  test('失败(非零退出码)返回 false', () => {
    childProcess.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });
    expect(setConfig('appId', 'x')).toBe(false);
  });
});

describe('resolveNcmEntry', () => {
  test('项目本地依赖存在时优先返回 [node, 本地 dist/index.js]', () => {
    const entry = resolveNcmEntry();
    // 开发/CI 环境 npm install 后本地依赖必然存在
    const hasLocal = (() => {
      try {
        require.resolve('@music163/ncm-cli/dist/index.js');
        return true;
      } catch {
        return false;
      }
    })();
    if (hasLocal) {
      expect(entry[0]).toBe(process.execPath);
      expect(entry[1]).toMatch(/[\\/]@music163[\\/]ncm-cli[\\/]dist[\\/]index\.js$/);
    } else {
      // 未装本地依赖时兑底到 'ncm-cli'(existsSync 已 mock 为 false)
      expect(entry).toEqual(['ncm-cli']);
    }
  });
});

describe('loginInteractive', () => {
  test('登录进程正常结束(退出码 0)返回 true', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0, error: null });
    expect(loginInteractive()).toBe(true);
    const [cmd, args, opts] = childProcess.spawnSync.mock.calls[0];
    expect(args).toContain('login');
    expect(opts.stdio).toBe('inherit');
    expect(cmd).toBeTruthy();
  });

  test('登录进程失败(非零退出码或 spawn 错误)返回 false', () => {
    childProcess.spawnSync.mockReturnValue({ status: 1, error: null });
    expect(loginInteractive()).toBe(false);
    childProcess.spawnSync.mockReturnValue({ status: null, error: new Error('ENOENT') });
    expect(loginInteractive()).toBe(false);
  });
});

describe('checkLogin', () => {
  test('返回 login --check 的解析结果', () => {
    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: '{"success":true,"message":"已登录实名账号"}',
      stderr: '',
    });
    expect(checkLogin()).toEqual({ success: true, message: '已登录实名账号' });
    const args = childProcess.spawnSync.mock.calls[0][1];
    expect(args).toContain('login');
    expect(args).toContain('--check');
  });
});

describe('resolveNcmEntry', () => {
  test('项目本地依赖存在时优先返回 [node, 本地 dist/index.js]', () => {
    const entry = resolveNcmEntry();
    // 开发/CI 环境 npm install 后本地依赖必然存在
    const hasLocal = (() => {
      try {
        require.resolve('@music163/ncm-cli/dist/index.js');
        return true;
      } catch {
        return false;
      }
    })();
    if (hasLocal) {
      expect(entry[0]).toBe(process.execPath);
      expect(entry[1]).toMatch(/[\\/]@music163[\\/]ncm-cli[\\/]dist[\\/]index\.js$/);
    } else {
      // 未装本地依赖时兑底到 'ncm-cli'(existsSync 已 mock 为 false)
      expect(entry).toEqual(['ncm-cli']);
    }
  });
});

describe('loginInteractive', () => {
  test('登录进程正常结束(退出码 0)返回 true', () => {
    childProcess.spawnSync.mockReturnValue({ status: 0, error: null });
    expect(loginInteractive()).toBe(true);
    const [cmd, args, opts] = childProcess.spawnSync.mock.calls[0];
    expect(args).toContain('login');
    expect(opts.stdio).toBe('inherit');
    expect(cmd).toBeTruthy();
  });

  test('登录进程失败(非零退出码或 spawn 错误)返回 false', () => {
    childProcess.spawnSync.mockReturnValue({ status: 1, error: null });
    expect(loginInteractive()).toBe(false);
    childProcess.spawnSync.mockReturnValue({ status: null, error: new Error('ENOENT') });
    expect(loginInteractive()).toBe(false);
  });
});

describe('checkLogin', () => {
  test('返回 login --check 的解析结果', () => {
    childProcess.spawnSync.mockReturnValue({
      status: 0,
      stdout: '{"success":true,"message":"已登录实名账号"}',
      stderr: '',
    });
    expect(checkLogin()).toEqual({ success: true, message: '已登录实名账号' });
    const args = childProcess.spawnSync.mock.calls[0][1];
    expect(args).toContain('login');
    expect(args).toContain('--check');
  });
});
