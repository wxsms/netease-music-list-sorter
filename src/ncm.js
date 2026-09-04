'use strict';

/**
 * ncm-cli 调用的唯一实现。
 *
 * Windows 上 npm 全局装的是 ncm-cli.cmd shim,spawnSync 不带 shell 时 Node 不会
 * 自动找 .cmd 后缀(ENOENT); 带 shell:true 又会经过 cmd.exe,触发 8K 命令行限制。
 * 解决:直接用 node 启动 ncm-cli 的 dist/index.js,跟 .cmd 内部做的一样。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * 解析 ncm-cli 启动方式,返回 [executable, ...args_prefix] 数组。
 */
function resolveNcmEntry() {
  if (process.platform !== 'win32') return ['ncm-cli'];

  // 找 ncm-cli.cmd 或 ncm-cli 所在目录
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
      '请确认 ncm-cli 已通过 npm install -g @music163/ncm-cli 安装并在 PATH 中。',
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

module.exports = { runNcm, NcmError, resolveNcmEntry };
