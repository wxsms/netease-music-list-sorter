#!/usr/bin/env python3
"""
把歌单顺序回滚到 backup 文件里记录的顺序。

用法:
    python rollback.py <backup.json>
    python rollback.py <backup.json> --playlistId <enc>   # 默认从 backup 文件名解析
    python rollback.py <backup.json> --dry-run            # 只打印将提交的顺序,不提交

backup 文件格式:数组,每条含 "id"(encId)、"name"、"artist"、"album" 等字段。
脚本会按数组顺序提取 encId,生成 JSON 数组提交给 ncm-cli playlist reorder。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

if os.name == "nt":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def resolve_ncm_entry() -> list[str]:
    """同 sort_playlist.py:Windows 上直接 node 调 dist/index.js,绕开 cmd.exe 8K 限制。"""
    if os.name != "nt":
        return ["ncm-cli"]
    shim = shutil.which("ncm-cli.cmd") or shutil.which("ncm-cli")
    if not shim:
        return ["ncm-cli"]
    shim_dir = Path(shim).resolve().parent
    index_js = shim_dir / "node_modules" / "@music163" / "ncm-cli" / "dist" / "index.js"
    if index_js.exists():
        local_node = shim_dir / "node.exe"
        if local_node.exists():
            return [str(local_node), str(index_js)]
        return ["node", str(index_js)]
    return [shim]


NCM_CMD = resolve_ncm_entry()


def run_ncm(args: list[str]) -> dict:
    cmd = [*NCM_CMD, *args, "--output", "json"]
    proc = subprocess.run(cmd, capture_output=True, shell=False)

    def _decode(b: bytes) -> str:
        if not b:
            return ""
        try:
            return b.decode("utf-8")
        except UnicodeDecodeError:
            for enc in ("gbk", "cp936", "latin-1"):
                try:
                    return b.decode(enc, errors="replace")
                except Exception:
                    continue
            return b.decode("utf-8", errors="replace")

    stdout, stderr = _decode(proc.stdout), _decode(proc.stderr)
    if proc.returncode != 0:
        sys.stderr.write(f"[ERROR] ncm-cli 返回 {proc.returncode}\n{stderr}\n")
        sys.exit(proc.returncode)
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"[ERROR] JSON 解析失败: {e}\n{stdout[:500]}\n")
        sys.exit(1)


def extract_playlist_id_from_filename(path: Path) -> str | None:
    m = re.search(r"backup-([A-F0-9]+)-", path.name)
    return m.group(1) if m else None


def main() -> int:
    parser = argparse.ArgumentParser(description="从 backup 文件回滚歌单顺序")
    parser.add_argument("backup", help="backup JSON 文件路径")
    parser.add_argument("--playlistId", help="加密歌单 ID;默认从文件名解析")
    parser.add_argument("--dry-run", action="store_true", help="只打印,不提交")
    args = parser.parse_args()

    backup_path = Path(args.backup)
    if not backup_path.exists():
        sys.stderr.write(f"[ERROR] 文件不存在: {backup_path}\n")
        return 1

    data = json.loads(backup_path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        sys.stderr.write(f"[ERROR] backup 文件不是 JSON 数组\n")
        return 1

    enc_ids = [t["id"] for t in data if t.get("id")]
    print(f"backup 文件: {backup_path}")
    print(f"歌曲数: {len(enc_ids)}")

    playlist_id = args.playlistId or extract_playlist_id_from_filename(backup_path)
    if not playlist_id:
        sys.stderr.write("[ERROR] 无法从文件名解析 playlistId,请用 --playlistId 传入\n")
        return 1
    print(f"目标歌单 ID: {playlist_id}")

    print("前 5 首 / 后 5 首(将提交的顺序):")
    for i, t in enumerate(data[:5], 1):
        print(f"  {i}. {t.get('name')}  -  {t.get('artist')}  -  {t.get('album')}")
    print("  ...")
    for i, t in enumerate(data[-5:], len(data) - 4):
        print(f"  {i}. {t.get('name')}  -  {t.get('artist')}  -  {t.get('album')}")

    if args.dry_run:
        print("\n[--dry-run] 不提交。")
        return 0

    payload = json.dumps(enc_ids, ensure_ascii=False)
    print("\n提交 reorder ...")
    resp = run_ncm([
        "playlist", "reorder",
        "--playlistId", playlist_id,
        "--trackIds", payload,
    ])
    if resp.get("code") == 200:
        print(f"[OK] 回滚完成,共 {len(enc_ids)} 首。")
    else:
        sys.stderr.write(f"[ERROR] reorder 返回非 200: {resp}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
