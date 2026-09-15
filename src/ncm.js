'use strict';

/**
 * ncm-cli 调用的唯一实现。
 *
 * 优先使用项目本地依赖(node_modules/@music163/ncm-cli,通过 require.resolve 解析),
 * 用户无需全局安装;找不到本地依赖时回退到全局安装的 ncm-cli。
 *
 * Windows 上 npm 全局装的是 ncm-cli.cmd shim,spawnSync 不带 shell 时 Node 不会
 * 自动找 .cmd 后缀(ENOENT); 带 shell:true 又会经过 cmd.exe,触发 8K 命令行限制。
 * 解决:直接用 node 启动 ncm-cli 的 dist/index.js,跟 .cmd 内部做的一样。
 */

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * 解析 ncm-cli 启动方式,返回 [executable, ...args_prefix] 数组。
 *
 * 查找顺序:
 * 0. 环境变量 NCM_SORTER_NCM_ENTRY(指向某个 JS 入口文件,用当前 node 启动)
 *    —— e2e 测试用它注入 fake ncm-cli,不碰真实依赖与网络
 * 1. 项目本地依赖 require.resolve('@music163/ncm-cli/dist/index.js')
 *    (package.json 已声明该依赖,正常 npm install 后必然存在)
 * 2. 全局安装的 ncm-cli(兼容旧用法,Windows 上定位 .cmd shim 背后的 dist/index.js)
 * 3. 兕底 'ncm-cli'(交给 PATH,非 Windows 全局安装场景)
 */
function resolveNcmEntry() {
  // 0. 环境变量显式指定入口(e2e 测试用)
  const envEntry = process.env.NCM_SORTER_NCM_ENTRY;
  if (envEntry) {
    return [process.execPath, envEntry];
  }

  // 1. 项目本地依赖
  try {
    const localIndex = require.resolve('@music163/ncm-cli/dist/index.js');
    return [process.execPath, localIndex];
  } catch {
    // 本地依赖不存在(未 npm install 或被裁剪),继续回退
  }

  if (process.platform !== 'win32') return ['ncm-cli'];

  // 2. 找全局安装的 ncm-cli.cmd 或 ncm-cli 所在目录
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

/**
 * 调 ncm-cli 子命令,返回解析后的 JSON。
 *
 * 失败时抛出 NcmError(带 kind 字段: 'spawn' | 'exit' | 'parse'),
 * 由调用方决定如何呈现给用户(脚本入口打日志退出,交互入口转成友好提示)。
 */
class NcmError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'NcmError';
    this.kind = kind; // 'spawn' | 'exit' | 'parse'
    this.detail = detail;
  }
}

function runNcm(args) {
  const fullArgs = [...NCM_CMD.slice(1), ...args, '--output', 'json'];
  const res = spawnSync(NCM_CMD[0], fullArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) {
    throw new NcmError(
      'spawn',
      `无法启动 ncm-cli: ${res.error.message}`,
      '请先在项目目录执行 npm install(本项目已内置 ncm-cli 依赖),或通过 npm install -g @music163/ncm-cli 全局安装。',
    );
  }
  if (res.status !== 0) {
    throw new NcmError(
      'exit',
      `ncm-cli 退出码 ${res.status}`,
      (res.stderr || res.stdout || '').slice(0, 500),
    );
  }
  try {
    return JSON.parse(res.stdout);
  } catch (e) {
    throw new NcmError(
      'parse',
      `解析 ncm-cli 输出为 JSON 失败: ${e.message}`,
      (res.stdout || '').slice(0, 500),
    );
  }
}

/**
 * runNcm 的异步版(spawn + Promise),不阻塞事件循环,可并发调用。
 * 错误语义与 runNcm 一致(NcmError)。
 */
function runNcmAsync(args) {
  return new Promise((resolve, reject) => {
    const fullArgs = [...NCM_CMD.slice(1), ...args, '--output', 'json'];
    const child = spawn(NCM_CMD[0], fullArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => {
      reject(new NcmError(
        'spawn',
        `无法启动 ncm-cli: ${err.message}`,
        '请先在项目目录执行 npm install(本项目已内置 ncm-cli 依赖),或通过 npm install -g @music163/ncm-cli 全局安装。',
      ));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new NcmError('exit', `ncm-cli 退出码 ${code}`, (stderr || stdout || '').slice(0, 500)));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new NcmError('parse', `解析 ncm-cli 输出为 JSON 失败: ${e.message}`, (stdout || '').slice(0, 500)));
      }
    });
  });
}

/**
 * 在工具内发起扫码登录:spawn 交互式 `ncm-cli login` 子进程,
 * 继承 stdio 让二维码直接渲染在当前终端,用户扫码完成后子进程退出。
 *
 * 返回 true 表示登录进程正常结束(退出码 0),false 表示无法启动登录进程。
 * 登录是否成功由调用方重新调 login --check / 业务命令验证。
 */
function loginInteractive() {
  const res = spawnSync(
    NCM_CMD[0],
    [...NCM_CMD.slice(1), 'login'],
    { stdio: 'inherit' },
  );
  return !res.error && res.status === 0;
}

/**
 * 检查登录状态,返回 ncm-cli `login --check` 的解析结果
 * ({ success: boolean, message: string })。失败时抛 NcmError。
 */
function checkLogin() {
  return runNcm(['login', '--check']);
}

module.exports = { runNcm, runNcmAsync, NcmError, resolveNcmEntry, loginInteractive, checkLogin };
