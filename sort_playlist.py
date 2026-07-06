#!/usr/bin/env python3
"""
按艺人首次出现顺序聚合网易云音乐歌单。

规则:
- 艺人之间:按"首次出现在原歌单的位置"排序。
- 同一艺人内部:按"所在专辑首次出现在该艺人组内的位置"分专辑。
- 同一专辑内的歌曲:按 ncm-cli album tracks 返回的顺序(对应当前网易云专辑页的曲目顺序)。
- 一首歌多艺人时,归到 artists[0]。

用法:
    python sort_playlist.py                      # 默认排红心歌单(自动查 user favorite)
    python sort_playlist.py --playlistId <enc>   # 排指定歌单
    python sort_playlist.py --dry-run            # 只算新顺序,不提交
    python sort_playlist.py --no-backup          # 不写备份文件(不推荐)

依赖:外部命令 ncm-cli 已登录并可在 PATH 中调用。仅使用 Python 标准库。
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

# Windows 控制台默认 cp936,统一改 utf-8
if os.name == "nt":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


REPO_ROOT = Path(__file__).resolve().parent
OUTPUT_DIR = REPO_ROOT / "output"
CACHE_DIR = REPO_ROOT / ".cache"


def _cache_path_for_album(album_id: str) -> Path:
    # 加密 ID 含字母数字,可直接做文件名;兜底替换不安全字符
    safe = "".join(c if c.isalnum() else "_" for c in album_id)
    return CACHE_DIR / f"album-{safe}.json"


def _resolve_ncm_cli() -> str:
    """解析 ncm-cli 可执行路径。Windows 下 npm 全局装的是 .cmd shim,subprocess 不带 shell 时找不到。"""
    found = shutil.which("ncm-cli") or shutil.which("ncm-cli.cmd")
    if found:
        return found
    # 兜底:返回名字,让 shell=True 去查
    return "ncm-cli"


NCM_BIN = _resolve_ncm_cli()


def run_ncm(args: list[str]) -> dict:
    """调 ncm-cli,返回解析后的 JSON。出错直接退出。"""
    cmd = [NCM_BIN, *args, "--output", "json"]
    # Windows 下 .cmd shim 必须走 shell;POSIX 直接 exec
    if os.name == "nt":
        # 把 list -> 字符串,安全引用
        cmd_str = subprocess.list2cmdline(cmd)
        proc = subprocess.run(
            cmd_str,
            capture_output=True,
            text=True,
            encoding="utf-8",
            shell=True,
        )
    else:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            shell=False,
        )
    if proc.returncode != 0:
        sys.stderr.write(f"[ERROR] ncm-cli 返回 {proc.returncode}\n")
        if proc.stderr:
            sys.stderr.write(proc.stderr + "\n")
        sys.exit(proc.returncode)
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        sys.stderr.write(f"[ERROR] 无法解析 ncm-cli 输出为 JSON: {e}\n")
        sys.stderr.write(proc.stdout[:500] + "\n")
        sys.exit(1)


def fetch_favorite_playlist_id() -> str:
    """跑 ncm-cli user favorite,取加密歌单 ID。"""
    print("[1/N] 查询红心歌单 ID ...")
    resp = run_ncm(["user", "favorite"])
    data = resp.get("data") or {}
    pid = data.get("id")
    if not pid:
        sys.stderr.write(f"[ERROR] user favorite 未返回 id,响应: {resp}\n")
        sys.exit(1)
    print(f"      红心歌单: {data.get('name')} ({data.get('trackCount')} 首),id = {pid}")
    return pid


def fetch_playlist_tracks(playlist_id: str) -> list[dict]:
    """拉取歌单全部曲目(单次最多 500)。"""
    print(f"[2/N] 拉取歌单曲目 ...")
    # 先查 trackCount
    meta = run_ncm(["playlist", "get", "--playlistId", playlist_id])
    total = (meta.get("data") or {}).get("trackCount") or 0
    if not total:
        # 直接拉 500 兜底
        total = 500
    limit = min(total, 500)
    resp = run_ncm([
        "playlist", "tracks",
        "--playlistId", playlist_id,
        "--limit", str(limit),
        "--offset", "0",
    ])
    tracks = resp.get("data") or []
    print(f"      拿到 {len(tracks)} 首")
    if len(tracks) < total:
        print(f"[WARN] 歌单共 {total} 首,只拿到 {len(tracks)} 首(接口单次上限 500)。大于 500 需要扩展分页逻辑。")
    return tracks


def fetch_album_tracks(album_id: str, cache: dict[str, list[dict]]) -> list[dict]:
    """拉某专辑的完整曲目列表(包含 name/artists/duration 等全部字段),按专辑内顺序返回。

    三级缓存:
    1. 进程内 dict `cache`(同一次运行内多次命中)
    2. 磁盘 .cache/album-<albumId>.json(跨次运行,跨功能复用)
    3. ncm-cli album tracks 接口

    缓存的是接口完整返回(已剥外层 code/message,只存 data 数组),其它功能可自由读取。
    """
    if album_id in cache:
        return cache[album_id]

    disk_path = _cache_path_for_album(album_id)
    if disk_path.exists():
        try:
            rows = json.loads(disk_path.read_text(encoding="utf-8"))
            # 必须是 list,且每个元素都是 dict(完整数据)。
            # 旧版本缓存只存了 encId 字符串列表,这里直接忽略,重新拉接口升级。
            if isinstance(rows, list) and all(isinstance(r, dict) for r in rows):
                cache[album_id] = rows
                return rows
        except (json.JSONDecodeError, OSError):
            pass  # 缓存损坏,继续走接口

    resp = run_ncm(["album", "tracks", "--albumId", album_id])
    rows = resp.get("data") or []
    cache[album_id] = rows

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    disk_path.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    return rows


def fetch_album_track_order(album_id: str, cache: dict[str, list[dict]]) -> list[str]:
    """基于 fetch_album_tracks 取 encId 顺序,等价于之前的接口。"""
    rows = fetch_album_tracks(album_id, cache)
    return [r["id"] for r in rows if r.get("id")]


def first_artist(track: dict) -> dict | None:
    artists = track.get("artists") or track.get("fullArtists") or []
    if not artists:
        return None
    return artists[0]


def album_info(track: dict) -> dict | None:
    return track.get("album") or None


def compute_new_order(tracks: list[dict], album_cache: dict[str, list[dict]]) -> list[dict]:
    """
    排序逻辑(专辑优先):

    1. 把每首歌按 albumId 分组。无专辑信息的归入 "__no_album__"。
    2. 每张专辑的"归属艺人" = 该专辑在原歌单里最早出现的那首歌的 first_artist。
    3. 艺人顺序 = 归属艺人在原歌单里的首次出现位置(升序)。
    4. 同一艺人名下的多张专辑,按"该专辑第一首歌在原歌单中的位置"升序排。
    5. 专辑内,按 album tracks 接口返回顺序排;不在该返回里的歌(边缘情况)按原歌单元位置追加在末尾。
    6. "__no_album__" 组按原顺序追加在最末尾,内部按 first_artist 再聚合(退化逻辑)。

    这样合辑专辑(例如"Joey Yung X Hacken Lee Concert 2015")不会被拆散:
    整张专辑归到它第一首歌的 first_artist 名下,内部保持专辑原顺序,
    即便专辑内某些歌的 first_artist 是其他人也不会被拆走。
    """
    # 1) 按专辑分组
    album_groups: dict[str, list[int]] = {}  # albumKey -> list of track indices (原歌单顺序)
    for i, t in enumerate(tracks):
        al = album_info(t)
        al_key = (al.get("id") if al else None) or "__no_album__"
        album_groups.setdefault(al_key, []).append(i)

    # 2) 计算每张专辑的"归属艺人"和"在原歌单中的首次位置"
    album_meta: dict[str, dict] = {}  # al_key -> {owner_artist_key, first_pos, owner_first_pos_in_playlist}
    for al_key, idxs in album_groups.items():
        first_idx = idxs[0]
        owner = first_artist(tracks[first_idx])
        if owner is None:
            owner_key = "__unknown__"
        else:
            owner_key = str(owner.get("originalId")) or owner.get("id") or f"enc:{owner.get('id')}"
        album_meta[al_key] = {
            "owner_artist_key": owner_key,
            "first_pos": first_idx,  # 该专辑在原歌单里最早出现的位置
        }

    # 3) 计算每个 owner 在原歌单里的首次出现位置(用于艺人之间排序)
    owner_first_pos: dict[str, int] = {}
    for i, t in enumerate(tracks):
        a = first_artist(t)
        if a is None:
            key = "__unknown__"
        else:
            key = str(a.get("originalId")) or a.get("id") or f"enc:{a.get('id')}"
        if key not in owner_first_pos:
            owner_first_pos[key] = i

    # 4) 把专辑归到 owner 名下
    owner_albums: dict[str, list[str]] = {}  # owner_key -> list of album_keys
    for al_key, meta in album_meta.items():
        owner_key = meta["owner_artist_key"]
        owner_albums.setdefault(owner_key, []).append(al_key)

    # owner 之间按 owner_first_pos 升序;__unknown__ 自然落到末尾(它没有 owner_first_pos)
    def owner_sort_key(k: str) -> int:
        return owner_first_pos.get(k, len(tracks) + 1)

    owner_order = sorted(owner_albums.keys(), key=owner_sort_key)

    new_tracks: list[dict] = []

    for owner_key in owner_order:
        album_keys = owner_albums[owner_key]
        # 同一 owner 的多张专辑,按 first_pos 升序
        album_keys.sort(key=lambda ak: album_meta[ak]["first_pos"])

        for al_key in album_keys:
            idx_list = album_groups[al_key]
            if al_key == "__no_album__":
                # 无专辑信息的歌,按原顺序追加
                for idx in idx_list:
                    new_tracks.append(tracks[idx])
                continue

            # 拉 album tracks 顺序
            try:
                album_order = fetch_album_track_order(al_key, album_cache)
            except SystemExit:
                raise
            except Exception as e:
                sys.stderr.write(f"[WARN] 拉专辑 {al_key} 顺序失败: {e},退化为原顺序\n")
                album_order = []

            in_album: list[int] = []
            out_album: list[int] = []
            for idx in idx_list:
                enc_id = tracks[idx].get("id")
                if enc_id in album_order:
                    in_album.append(idx)
                else:
                    out_album.append(idx)
            in_album.sort(key=lambda idx: album_order.index(tracks[idx]["id"]))
            for idx in in_album:
                new_tracks.append(tracks[idx])
            for idx in out_album:
                new_tracks.append(tracks[idx])

    return new_tracks


def write_backup(playlist_id: str, tracks: list[dict]) -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    path = OUTPUT_DIR / f"backup-{playlist_id}-{ts}.json"
    snapshot = _snapshot(tracks)
    path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def write_new_order(playlist_id: str, tracks: list[dict]) -> Path:
    """把排序后的顺序落盘,便于人工检查。文件名固定(覆盖写),便于对照。"""
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUTPUT_DIR / f"new-order-{playlist_id}.json"
    snapshot = _snapshot(tracks)
    path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def _snapshot(tracks: list[dict]) -> list[dict]:
    return [
        {
            "id": t.get("id"),
            "originalId": t.get("originalId"),
            "name": t.get("name"),
            "artist": (first_artist(t) or {}).get("name"),
            "album": (album_info(t) or {}).get("name"),
        }
        for t in tracks
    ]


def submit_reorder(playlist_id: str, new_tracks: list[dict]) -> None:
    enc_ids = [t["id"] for t in new_tracks if t.get("id")]
    payload = json.dumps(enc_ids, ensure_ascii=False)
    # 直接传 JSON 字符串给 --trackIds。CLI 文档示例是 ["a","b"]。
    resp = run_ncm([
        "playlist", "reorder",
        "--playlistId", playlist_id,
        "--trackIds", payload,
    ])
    code = resp.get("code")
    if code == 200:
        print(f"[OK] 已提交新顺序,共 {len(enc_ids)} 首。")
    else:
        sys.stderr.write(f"[ERROR] reorder 返回非 200: {resp}\n")
        sys.exit(1)


def print_diff_preview(old: list[dict], new: list[dict], n: int = 15) -> None:
    print("\n新顺序预览(前 {} 首):".format(n))
    print(f"{'#':>3}  {'歌名':<30}  {'艺人':<15}  {'专辑'}")
    for i, t in enumerate(new[:n], 1):
        name = (t.get("name") or "")[:30]
        artist = ((first_artist(t) or {}).get("name") or "")[:15]
        album = (album_info(t) or {}).get("name") or ""
        print(f"{i:>3}  {name:<30}  {artist:<15}  {album}")
    if len(new) > n:
        print(f"... 共 {len(new)} 首")

    moved = sum(1 for i, t in enumerate(new) if t.get("id") != (old[i].get("id") if i < len(old) else None))
    print(f"\n位置变动:{moved} / {len(new)}")


def main() -> int:
    parser = argparse.ArgumentParser(description="按艺人首次出现顺序聚合网易云歌单")
    parser.add_argument("--playlistId", help="加密歌单 ID;不传则默认红心歌单(自动查询)")
    parser.add_argument("--dry-run", action="store_true", help="只算新顺序并预览,不提交")
    parser.add_argument("--no-backup", action="store_true", help="不写备份文件(不推荐)")
    parser.add_argument("--save-new-order", action="store_true", help="把排序后的新顺序写到 output/new-order-<playlistId>.json,便于人工检查")
    args = parser.parse_args()

    playlist_id = args.playlistId or fetch_favorite_playlist_id()
    tracks = fetch_playlist_tracks(playlist_id)
    if not tracks:
        print("[WARN] 歌单为空,无需排序。")
        return 0

    if not args.no_backup:
        backup_path = write_backup(playlist_id, tracks)
        print(f"[backup] 原顺序已备份至 {backup_path}")

    album_cache: dict[str, list[dict]] = {}
    print("[3/N] 计算新顺序(可能需要拉取专辑信息)...")
    new_tracks = compute_new_order(tracks, album_cache)
    print(f"      完成。新顺序共 {len(new_tracks)} 首,共调用 album tracks {len(album_cache)} 次。")

    print_diff_preview(tracks, new_tracks)

    if args.save_new_order:
        new_path = write_new_order(playlist_id, new_tracks)
        print(f"[save] 新顺序已写入 {new_path}")

    if args.dry_run:
        print("\n[--dry-run] 不提交。如需提交,去掉 --dry-run 再跑一次。")
        return 0

    print("[4/N] 提交 reorder ...")
    submit_reorder(playlist_id, new_tracks)
    return 0


if __name__ == "__main__":
    sys.exit(main())
