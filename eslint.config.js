'use strict';

/**
 * ESLint 扁平配置(ESLint 9+)。
 *
 * 只做正确性检查(未用变量、未定义引用等),不做格式化约束——
 * 代码风格由现有约定(2 空格缩进、单引号、分号)保持,避免全量格式化 churn。
 */

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/', '.cache/', 'output/', 'coverage/'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },
];
