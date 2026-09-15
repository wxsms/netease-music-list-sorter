'use strict';

/**
 * `build` 包的本地 stub。
 *
 * ncm-cli 声明了 `build@^0.1.4`(2012 年的构建工具),但其发布产物
 * dist/index.js 已是构建完成的代码,运行时不会 require('build')。
 * 该包的依赖链(jxLoader → js-yaml 3.x、timespan、uglify-js 1.x)带
 * 2 critical + 3 high 漏洞,导致 npm audit 失败。
 *
 * 通过 package.json 的 overrides 将其替换为本 stub(与 ffprobe-static
 * 同思路),消除漏洞依赖链,不影响任何运行时功能。
 */

module.exports = {};
