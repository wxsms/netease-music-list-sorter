# 交互式 API 凭证配置引导 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在交互式向导的预检环节检测到「API key 未设置」时，引导用户在工具内输入 appId/privateKey（并告知获取渠道），写盘后继续登录流程；凭证仍无效时循环重试。

**Architecture:** 在 `src/ncm.js` 新增 `isApiKeyMissing(NcmError)` 判别函数（基于已实测的错误特征：stderr 含「API key 未设置」且 kind=exit）；在 `src/interactive.js` 的 `precheck()` 里，检测到该错误后进入 clack 输入引导（`p.note` 说明获取渠道 + 两次 `p.text`），通过 spawnSync 调 `ncm-cli config set` 写盘，然后回到预检循环重试。凭证无效时再次触发引导，形成循环。

**Tech Stack:** Node.js (CommonJS)、@clack/prompts、Jest。

---

## 背景与已验证的事实

以下事实已在真实环境验证过（不需要再猜）：

1. 未配置 API key 时，`ncm-cli login --check` 行为：
   - 退出码 1
   - stderr 输出（多行）：`[错误] API key 未设置，请通过以下方式之一配置：` 及后续提示行
   - stdout 为空
2. `ncm-cli config set <key> <value>` 非交互写盘，成功时退出码 0，stdout 输出 `✓ 已设置 <key> = <value>`（不随 `--output json` 改变，是纯文本）
3. `ncm-cli config list` 输出纯文本（`appId: xxx (凭证文件)` 等），空配置时输出「尚未配置。...」
4. 凭证文件位置：`~/.config/ncm-cli/credentials.enc.json`（Windows 实测）；`config set` 一次只能设一个 key，appId 和 privateKey 需要调两次
5. 凭证获取渠道：网易云音乐开放平台入驻页 `https://developer.music.163.com/st/developer/apply/account?type=INDIVIDUAL`
6. `src/ncm.js` 现有结构：`runNcm()` 返回解析后的 JSON，失败抛 `NcmError(kind, message, detail)`，kind ∈ `'spawn' | 'exit' | 'parse'`；`NcmError.detail` 是 `(stderr || stdout).slice(0, 500)`
7. `src/interactive.js` 的 `precheck()` 是死循环：`fetchFavoritePlaylist()` 成功则返回；spawn 失败提示安装退出；其它错误（多为未登录）调 `loginInteractive()` 扫码，扫码进程正常结束回到循环顶重试验证
8. 本仓库测试模式：单元测试 mock `child_process.spawnSync`（见 `tests/ncm.test.js`）；e2e 用 `NCM_SORTER_NCM_ENTRY` 注入 fake ncm-cli（见 `tests/e2e/`）
9. clack 的 `p.text` 返回用户输入字符串；取消时 `p.isCancel(value)` 为 true；`p.note(body, title)` 渲染信息框

## 用户流程（设计确认过的行为）

```
npm start
  → precheck: fetchFavoritePlaylist 抛错
      ├─ 错误是「API key 未设置」
      │    → p.note 展示获取渠道(开放平台 URL + 两种凭证的含义)
      │    → p.text 输入 App ID
      │    → p.text 输入 Private Key
      │    → spawnSync ncm-cli config set appId <值> / config set privateKey <值>
      │    → 回到循环顶,重新 fetchFavoritePlaylist
      │        ├─ 成功 → 继续正常流程
      │        └─ 仍报 API key 错(凭证填错) → p.log.warn 提示凭证无效
      │              → 再次进入输入引导(循环,用户可 Ctrl+C 退出)
      ├─ 错误是其它 exit 错误(未登录/过期)
      │    → 现状:扫码登录(不变)
      └─ spawn 失败
           → 现状:提示安装并退出(不变)
```

取消处理：输入环节按 Ctrl+C → `guard()` → `bail()` → 退出码 0（与全工具约定一致）。

---

### Task 1: `src/ncm.js` 新增 `isApiKeyMissing()` 判别函数

**Files:**
- Modify: `src/ncm.js`
- Test: `tests/ncm.test.js`

- [ ] **Step 1: 写失败测试**

在 `tests/ncm.test.js` 的 `describe('runNcm', ...)` 之后追加（顶层位置即可）：

```js
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
```

同时把文件顶部的 import 行改为：

```js
const { runNcm, NcmError, resolveNcmEntry, loginInteractive, checkLogin, isApiKeyMissing } = require('../src/ncm.js');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest tests/ncm.test.js -t "isApiKeyMissing"`
Expected: FAIL（`isApiKeyMissing is not a function` 或 undefined）

- [ ] **Step 3: 实现**

在 `src/ncm.js` 的 `checkLogin` 函数之后、`module.exports` 之前添加：

```js
/**
 * 判断错误是否为「API key 未配置」场景。
 *
 * ncm-cli 未配置 appId/privateKey 时,所有命令(含 login --check)以退出码 1
 * 结束并在 stderr 打印「API key 未设置」;detail 承载 (stderr||stdout).slice(0,500)。
 * 用文案匹配而非退出码区分,避免与其它 exit 错误(未登录/网络)混淆。
 */
function isApiKeyMissing(e) {
  return e instanceof NcmError
    && e.kind === 'exit'
    && typeof e.detail === 'string'
    && e.detail.includes('API key 未设置');
}
```

并把 `module.exports` 改为：

```js
module.exports = { runNcm, runNcmAsync, NcmError, resolveNcmEntry, loginInteractive, checkLogin, isApiKeyMissing };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest tests/ncm.test.js`
Expected: PASS（全部,含原有用例）

- [ ] **Step 5: Commit**

```bash
git add src/ncm.js tests/ncm.test.js
git commit -m "feat: 新增 isApiKeyMissing 判别 API key 未配置错误"
```

---

### Task 2: `src/ncm.js` 新增 `setConfig()` 写配置函数

**Files:**
- Modify: `src/ncm.js`
- Test: `tests/ncm.test.js`

- [ ] **Step 1: 写失败测试**

在 `tests/ncm.test.js` 追加：

```js
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
```

import 行追加 `setConfig`：

```js
const { runNcm, NcmError, resolveNcmEntry, loginInteractive, checkLogin, isApiKeyMissing, setConfig } = require('../src/ncm.js');
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx jest tests/ncm.test.js -t "setConfig"`
Expected: FAIL

- [ ] **Step 3: 实现**

在 `src/ncm.js` 的 `isApiKeyMissing` 之后添加：

```js
/**
 * 写入一条 ncm-cli 配置(`config set <key> <value>`)。
 * 返回是否成功;失败由调用方决定提示与流程。
 */
function setConfig(key, value) {
  const res = spawnSync(NCM_CMD[0], [...NCM_CMD.slice(1), 'config', 'set', key, String(value)], {
    encoding: 'utf8',
  });
  return res.error == null && res.status === 0;
}
```

`module.exports` 追加 `setConfig`：

```js
module.exports = { runNcm, runNcmAsync, NcmError, resolveNcmEntry, loginInteractive, checkLogin, isApiKeyMissing, setConfig };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx jest tests/ncm.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ncm.js tests/ncm.test.js
git commit -m "feat: 新增 setConfig 封装 ncm-cli config set"
```

---

### Task 3: `src/interactive.js` 预检环节接入凭证配置引导

**Files:**
- Modify: `src/interactive.js`（`precheck` 函数，约 158-200 行）
- Test: 手动验证为主（clack 交互难以单测，本任务以手动冒烟为准）

- [ ] **Step 1: 修改 import**

`src/interactive.js` 顶部：

```js
const { NcmError, loginInteractive, isApiKeyMissing, setConfig } = require('./ncm.js');
```

- [ ] **Step 2: 在 `precheck` 中插入 API key 引导**

把 `precheck` 的循环体中，spawn 检查之后、扫码登录之前的这一段：

```js
    // 多为未登录或凭据失效:直接进入扫码登录
    p.log.warn('未登录或登录已过期,请扫码登录');
```

替换为：

```js
    // API key 未配置:在工具内引导填写凭证(循环直到有效或用户取消)
    if (isApiKeyMissing(e)) {
      await configureCredentials(e);
      continue; // 回循环顶重新验证
    }

    // 多为未登录或凭据失效:直接进入扫码登录
    p.log.warn('未登录或登录已过期,请扫码登录');
```

- [ ] **Step 3: 在 `precheck` 之前新增 `configureCredentials` 函数**

```js
/**
 * API 凭证配置引导:告知获取渠道,收集 appId/privateKey 并写入 ncm-cli 配置。
 *
 * 由 precheck 在检测到「API key 未设置」时调用;写入后回到 precheck 循环
 * 重新验证——凭证填错会再次进入本函数,形成循环重试,用户可 Ctrl+C 退出。
 */
async function configureCredentials(err) {
  if (err) {
    p.log.warn('API 凭证无效或未配置,请(重新)填写');
  }
  p.note(
    [
      '本工具依赖网易云音乐开放平台 API,需要先配置凭证:',
      '',
      '  1. 前往开放平台入驻(个人类型即可):',
      '     https://developer.music.163.com/st/developer/apply/account?type=INDIVIDUAL',
      '  2. 入驻后在控制台获取 App ID 和 Private Key',
      '',
      '凭证只需配置一次,会保存到本机(~/.config/ncm-cli/)。',
    ].join('\n'),
    '🔑 首次使用需要配置 API 凭证',
  );

  const appId = guard(await p.text({
    message: '请输入 App ID',
    validate: v => (v && v.trim() ? undefined : 'App ID 不能为空'),
  }));
  const privateKey = guard(await p.text({
    message: '请输入 Private Key',
    validate: v => (v && v.trim() ? undefined : 'Private Key 不能为空'),
  }));

  const s = makeSyncSpinner();
  s.start('正在保存凭证...');
  const okApp = setConfig('appId', appId.trim());
  const okKey = setConfig('privateKey', privateKey.trim());
  if (!okApp || !okKey) {
    s.stop();
    p.log.error('凭证写入失败,请检查 ncm-cli 是否可用');
    process.exit(1);
  }
  s.stop('✅ 凭证已保存');
}
```

- [ ] **Step 4: 手动冒烟验证**

Run: `npm start`

Expected 行为：
1. 未配置凭证的机器上出现「🔑 首次使用需要配置 API 凭证」note，含开放平台 URL
2. 依次提示输入 App ID / Private Key，空输入会被拒绝
3. 输入后出现「✅ 凭证已保存」，随后继续登录验证（登录成功或进入扫码）
4. 输入错误凭证时：登录验证失败 → 再次出现 warn + 输入引导（循环）
5. 输入环节 Ctrl+C：退出码 0
6. `node node_modules/@music163/ncm-cli/dist/index.js config list` 能看到刚配置的值

（验证后可用 `config set appId ""` / `config set privateKey ""` 清空恢复未配置态。）

- [ ] **Step 5: lint + 全量测试**

Run: `npm run lint && npm test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add src/interactive.js
git commit -m "feat: 预检环节引导配置 API 凭证并循环重试"
```

---

### Task 4: e2e 覆盖「未配置 API key → 引导 → 成功」链路

**Files:**
- Modify: `tests/e2e/fixtures/fake-ncm-cli.js`
- Modify: `tests/e2e/cli.e2e.test.js`

e2e 走的是非交互 CLI（`cli.js sort`），不经过 clack 引导；本任务覆盖的是 **fake ncm-cli 在未配置凭证时的行为**，以及配置后恢复。由于交互式向导难以在 e2e 中模拟 stdin 交互，本任务做**最小可行覆盖**：fake ncm-cli 支持「凭证文件」状态模拟，验证 `cli.js sort` 在 fake 报「API key 未设置」时以非零退出并输出可读错误（非交互路径的兜底行为），保证错误不会被吞。

- [ ] **Step 1: fake ncm-cli 支持模拟未配置凭证**

在 `tests/e2e/fixtures/fake-ncm-cli.js` 的命令分发区（`user favorite` 判断之前）插入：

```js
// 模拟未配置 API key:环境变量 NCM_SORTER_FAKE_NO_KEY=1 时,
// user favorite 以退出码 1 + stderr 文案复现真实 ncm-cli 行为
if (process.env.NCM_SORTER_FAKE_NO_KEY === '1') {
  process.stderr.write('[错误] API key 未设置，请通过以下方式之一配置：\n  - 运行 ncm-cli configure 进行交互式配置\n');
  process.exit(1);
}
```

- [ ] **Step 2: 写失败测试**

在 `tests/e2e/cli.e2e.test.js` 的 `describe('e2e: 错误路径', ...)` 中追加：

```js
  test('未配置 API key:非零退出且错误信息透传给用户', () => {
    const cacheHome = path.join(tmpDir, 'cache');
    const fakeLog = path.join(tmpDir, 'calls.log');
    const res = spawnSync(process.execPath, [CLI, 'sort', '--dry-run'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NCM_SORTER_NCM_ENTRY: FAKE_NCM,
        NCM_SORTER_CACHE_HOME: cacheHome,
        NCM_SORTER_FAKE_NO_KEY: '1',
      },
    });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain('API key 未设置');
  });
```

- [ ] **Step 3: 跑测试确认通过**

Run: `npx jest tests/e2e/cli.e2e.test.js -t "API key"`
Expected: PASS

（说明：fake 的拦截在 `user favorite` 之前，真实 CLI 路径是 `runSort → fetchFavoritePlaylist → runNcm → NcmError(kind=exit, detail=stderr切片) → reportNcmError 打印 detail 退出 1`，stderr 透传链路真实存在，此测试验证的是这条透传链不被回归。）

- [ ] **Step 4: 全量测试 + lint**

Run: `npm test && npm run lint`
Expected: 全部通过

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/fixtures/fake-ncm-cli.js tests/e2e/cli.e2e.test.js
git commit -m "test: e2e 覆盖 API key 未配置错误透传"
```

---

### Task 5: README 补充凭证配置说明

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 查看现有 README 结构**

Run: `head -60 README.md`
确认「快速开始/使用」章节位置，在合适位置（使用前提附近）补充。

- [ ] **Step 2: 补充说明**

在 README 的使用说明之前（具体位置以 Step 1 的实际结构为准）加入：

```markdown
## 前置准备：配置 API 凭证

本工具基于网易云音乐开放平台 API，首次使用需要配置凭证：

1. 前往[网易云音乐开放平台](https://developer.music.163.com/st/developer/apply/account?type=INDIVIDUAL)入驻（个人类型即可）
2. 在控制台获取 **App ID** 和 **Private Key**
3. 运行 `npm start`，工具会在检测到未配置时引导你输入并保存（也可以手动执行 `npx @music163/ncm-cli configure`）

凭证只需配置一次，保存在本机 `~/.config/ncm-cli/`。
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README 补充 API 凭证配置说明"
```

---

## Self-Review 结论

- **Spec 覆盖**：检测（Task 1）→ 引导输入+告知渠道（Task 3）→ 写盘（Task 2+3）→ 循环重试（Task 3 的 precheck 循环 + configureCredentials 由 precheck 每轮调用）→ 错误透传兜底（Task 4）→ 文档（Task 5）。闭环完整。
- **无占位符**：所有代码步骤给出完整代码。
- **类型一致性**：`isApiKeyMissing(e)`、`setConfig(key, value)` 签名在 Task 1/2 定义，Task 3 的调用一致；`configureCredentials(err)` 参数为可空的 NcmError，precheck 传入 `e`。
- **已知取舍**：clack 交互流程无法在 Jest 中稳定单测（需伪 TTY），Task 3 以手动冒烟为准；e2e 只覆盖非交互错误透传链。
