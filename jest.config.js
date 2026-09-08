'use strict';

/**
 * Jest 配置。
 *
 * - testEnvironment: node(CLI 项目,无 DOM)
 * - coverage: 只统计 src/,产出 lcov + 文本报告(供 codecov 上传)
 * - roots: 测试都在 tests/ 下
 */

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  coverageDirectory: 'coverage',
  collectCoverageFrom: ['src/**/*.js'],
  coverageReporters: ['text', 'lcov'],
};
