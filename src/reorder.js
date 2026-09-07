'use strict';

/**
 * reorder 提交:排序提交与回滚提交共用同一底层调用。
 */

const { runNcm } = require('./ncm.js');

/**
 * 提交歌单新顺序。成功返回 true,接口返回非 200 时抛错。
 */
function submitReorder(playlistId, encIds) {
  const payload = JSON.stringify(encIds);
  const resp = runNcm([
    'playlist', 'reorder',
    '--playlistId', playlistId,
    '--trackIds', payload,
  ]);
  if (resp.code === 200) {
    return true;
  }
  throw new Error(`reorder 返回非 200: ${JSON.stringify(resp)}`);
}

/**
 * 从 backup 文件回滚歌单顺序(等价于按 backup 里的 encIds 提交一次 reorder)。
 */
function rollbackFromBackup(playlistId, encIds) {
  return submitReorder(playlistId, encIds);
}

module.exports = { submitReorder, rollbackFromBackup };
