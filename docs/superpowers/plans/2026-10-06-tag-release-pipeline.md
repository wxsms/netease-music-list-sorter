# Tag 触发 npm 发布流程 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `.github/workflows/publish.yml`：push `v*` tag 后自动 lint+test、校验版本一致、Trusted Publishing 发布 npm、创建 GitHub Release。

**Architecture:** 单 workflow 单 job 顺序执行;版本守卫用 node 内联脚本比较 tag 与 package.json;OIDC 发布靠 `id-token: write` + npm ≥ 11.5.1,零 Secret。

**Tech Stack:** GitHub Actions、npm OIDC trusted publishing。

---

### Task 1: 新增 publish.yml workflow

**Files:**
- Create: `.github/workflows/publish.yml`

- [ ] **Step 1: 创建 workflow 文件**

```yaml
name: publish

on:
  push:
    tags:
      - 'v*'

permissions:
  id-token: write   # npm OIDC trusted publishing
  contents: write   # gh release create

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7.0.1
      - uses: actions/setup-node@v7.0.0
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm run lint
      - run: npm test
      # 版本守卫:tag v0.0.2 必须与 package.json version 一致,防止发错版本
      - name: Verify tag matches package.json version
        run: node -e "
          const pkg = require('./package.json');
          const tag = process.argv[1];
          if ('v' + pkg.version !== tag) {
            console.error('tag ' + tag + ' != package.json version v' + pkg.version);
            process.exit(1);
          }
          console.log('version check ok: v' + pkg.version);
        " "${{ github.ref_name }}"
      - run: npm publish
      - name: Create GitHub Release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh release create "${{ github.ref_name }}" --generate-notes --title "Release ${{ github.ref_name }}"
```

- [ ] **Step 2: 本地验证版本守卫逻辑**

Run:
```bash
node -e "
  const pkg = require('./package.json');
  const tag = 'v0.0.2';
  if ('v' + pkg.version !== tag) { console.error('mismatch ok'); process.exit(1); }
" ; echo "exit=$?"
```
Expected: 当前 version 是 0.0.1,与 v0.0.2 不一致,exit=1(守卫生效)。

再把 tag 换成 `v0.0.1` 跑一遍,Expected: exit=0。

- [ ] **Step 3: lint**

Run: `npm run lint`
Expected: 通过(workflow yml 不在 eslint 范围,但确认无误伤)。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/publish.yml docs/superpowers/specs/2026-10-06-tag-release-pipeline-design.md docs/superpowers/plans/2026-10-06-tag-release-pipeline.md
git commit -m "ci: tag 触发的 npm Trusted Publishing 发布流程"
```

---

### Task 2: README 补充 npm 安装方式

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 在"安装"章节补充**

现有安装章节(`git clone` 方式)之前插入:

```markdown
## 安装

要求 Node.js 18+。

```bash
npm install -g ncm-sorter
```

或免安装直接运行:

```bash
npx ncm-sorter
```

### 从源码运行

```bash
git clone https://github.com/wxsms/netease-music-list-sorter.git
cd netease-music-list-sorter
npm install
```
```

(以现有 README 实际结构为准微调。)

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README 补充 npm 安装方式"
```

---

### Task 3: 版本升至 0.0.2、合并、端到端验收

**Files:**
- Modify: `package.json`

- [ ] **Step 1: version 升 0.0.2**

package.json: `"version": "0.0.1"` → `"0.0.2"`。

- [ ] **Step 2: Commit + push + PR 合并(CI 全绿)**

```bash
git add package.json
git commit -m "chore: release v0.0.2"
git push -u origin <branch>
gh pr create ... # CI 全绿后 merge
```

- [ ] **Step 3: 打 tag 并推送**

```bash
git checkout master && git pull
git tag v0.0.2 && git push origin v0.0.2
```

- [ ] **Step 4: 观察 workflow**

Run: `gh run watch` 或 `gh run list`
Expected: publish workflow 全绿(lint/test/版本守卫/npm publish/Release 创建)。

- [ ] **Step 5: 验收 npm**

Run: `npm view ncm-sorter versions dist-tags --registry=https://registry.npmjs.org`
Expected: versions 含 `0.0.2`,dist-tags.latest 为 `0.0.2`。

- [ ] **Step 6: 验收 GitHub Release**

Run: `gh release view v0.0.2`
Expected: Release 存在,notes 自动生成。

- [ ] **Step 7: 验收安装**

Run: `npm install -g ncm-sorter@0.0.2 --registry=https://registry.npmjs.org && ncm-sorter --version && npm uninstall -g ncm-sorter`
Expected: 输出 `0.0.2`。

---

## Self-Review

- Spec 覆盖:workflow(Task 1)、README(顺带)、版本升级+发布+验收(Task 3)——闭环。
- 无占位符:workflow 与守卫脚本给出完整代码。
- 类型一致:`github.ref_name` 在版本守卫与 Release 步骤引用一致;权限块覆盖 id-token 与 contents。
- 已知约束:OIDC 只在 github-hosted runner 有效;npm 侧 Trusted Publisher 必须精确匹配 workflow 文件名 `publish.yml`。
