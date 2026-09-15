'use strict';

/**
 * ffprobe-static 的本地 stub。
 *
 * 本项目把 @music163/ncm-cli 声明为依赖,但只用它的歌单/专辑数据接口,
 * 不用播放功能。ncm-cli 的 ffprobe-static 依赖包含约 350MB 的静态二进制,
 * 通过 package.json 的 overrides 字段将其替换为本 stub,安装体积从 ~369MB
 * 降到 ~37MB。
 *
 * 注意:ncm-cli 启动时会探测 ffprobe 可用性来决定注册哪些命令。如果这里
 * 直接 throw,playlist/song/user/search 等命令会整体不注册。因此必须导出
 * 与原包相同的接口形状 { path },指向一个存在的占位文件;真正调用播放
 * 功能时才会失败,而本项目不调用。
 */

const path = require('path');

module.exports = { path: path.join(__dirname, 'ffprobe-dummy') };
