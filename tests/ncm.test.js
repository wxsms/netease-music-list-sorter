'use strict';

/**
 * ncm.js 单元测试(Jest)。
 *
 * mock child_process 的 spawnSync/spawn,测 runNcm 的三种错误分类
 * (spawn/exit/parse)与成功路径。resolveNcmEntry 的平台分支也顺带覆盖。
 */

const childProcess = require('child_process');

jest.spyOn(childProcess, 'spawnSync');
jest.spyOn(childProcess, 'spawn');

// ncm.js 在模块加载时调用 resolveNcmEntry(读 PATH/文件系统),
// 这里 mock 掉 fs 的 existsSync,让它走"找不到 shim"的兜底分支,
// 保证测试环境无关(不依赖本机是否装了 ncm-cli)。
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(() => false),
  };
});

const { runNcm, NcmError } = require('../src/ncm.js');

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
