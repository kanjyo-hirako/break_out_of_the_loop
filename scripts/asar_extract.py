"""asar 归档提取工具（开发辅助）。

用于从 DSH 安装目录的 app.asar 中精确提取单个文件，
供插件开发时参考官方接口文档与参考实现（如 repeat-tool-reminder）。

用法:
    python scripts/asar_extract.py list   <asar> <path-prefix>
    python scripts/asar_extract.py extract <asar> <inner-path> <out-path>
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path


def load_header(asar_path: Path):
    # asar 头部: [uint32=4][uint32=第二段大小][uint32=pickle负载长度][uint32=JSON长度][JSON][文件数据...]
    with asar_path.open("rb") as f:
        prefix = f.read(16)
        _magic, second_size, _payload, json_len = struct.unpack("<IIII", prefix)
        header = json.loads(f.read(json_len))
    return header, 8 + second_size


def walk(node, prefix=""):
    for name, child in node.get("files", {}).items():
        p = f"{prefix}/{name}" if prefix else name
        if "files" in child:
            yield from walk(child, p)
        elif "link" in child or "offset" not in child:
            continue  # 符号链接或 unpacked 条目，不参与提取
        else:
            yield p, int(child["size"]), int(child["offset"])


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    cmd, asar = argv[1], Path(argv[2])
    header, data_start = load_header(asar)

    if cmd == "list":
        prefix = argv[3] if len(argv) > 3 else ""
        for p, size, _off in walk(header):
            if p.startswith(prefix):
                print(f"{size:>10}  {p}")
        return 0

    if cmd == "extract":
        if len(argv) < 5:
            print("extract needs <inner-path> <out-path>")
            return 2
        want, out = argv[3], Path(argv[4])
        for p, size, off in walk(header):
            if p == want:
                with asar.open("rb") as f:
                    f.seek(data_start + off)
                    data = f.read(size)
                out.parent.mkdir(parents=True, exist_ok=True)
                out.write_bytes(data)
                print(f"extracted {p} -> {out} ({size} bytes)")
                return 0
        print(f"not found: {want}")
        return 1

    print(f"unknown command: {cmd}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
