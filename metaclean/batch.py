"""File-system level processing: folders, output naming, overwrite, xattrs, watch folder."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

from .cleaner import CleanOptions, CleanResult, clean_bytes
from .containers import RAW_EXTS

IMAGE_EXTS = {".jpg", ".jpeg", ".jpe", ".jfif", ".png", ".webp", ".heic", ".heif", ".hif", ".avif",
              ".tif", ".tiff"} | RAW_EXTS


def iter_images(paths: Iterable[str | Path], recursive: bool = True) -> list[Path]:
    out = []
    for p in map(Path, paths):
        if p.is_dir():
            it = p.rglob("*") if recursive else p.glob("*")
            out += sorted(q for q in it if q.is_file() and q.suffix.lower() in IMAGE_EXTS
                          and not q.name.startswith("._"))
        elif p.is_file():
            out.append(p)
    return out


def output_path(src: Path, result_ext: str, *, overwrite: bool, out_dir: Path | None,
                suffix: str = "_clean", base: Path | None = None) -> Path:
    same_ext = src.suffix.lower() in (result_ext, ".jpeg" if result_ext == ".jpg" else result_ext,
                                      ".heif" if result_ext == ".heic" else result_ext,
                                      ".tiff" if result_ext == ".tif" else result_ext)
    if overwrite and same_ext:
        return src
    if out_dir:
        rel = src.relative_to(base) if base and src.is_relative_to(base) else Path(src.name)
        dest = out_dir / rel.parent / (src.stem + (src.suffix if same_ext else result_ext))
    else:
        dest = src.with_name(src.stem + suffix + (src.suffix if same_ext else result_ext))
    return dest


def strip_xattrs(path: Path) -> None:
    """Remove extended attributes like com.apple.metadata:kMDItemWhereFroms (download URL)."""
    try:
        if sys.platform == "darwin":
            subprocess.run(["xattr", "-c", str(path)], check=False, capture_output=True)
        elif hasattr(os, "listxattr"):
            for a in os.listxattr(path):
                os.removexattr(path, a)
    except Exception:
        pass


@dataclass
class FileOutcome:
    src: Path
    dest: Path | None
    result: CleanResult | None
    error: str | None = None


def process_file(src: Path, options: CleanOptions, *, overwrite=False, out_dir: Path | None = None,
                 suffix="_clean", base: Path | None = None, keep_timestamps=False,
                 dry_run=False) -> FileOutcome:
    try:
        data = src.read_bytes()
        res = clean_bytes(data, src.name, options)
    except Exception as e:
        return FileOutcome(src, None, None, f"{type(e).__name__}: {e}")
    dest = output_path(src, res.ext, overwrite=overwrite, out_dir=out_dir, suffix=suffix, base=base)
    if dry_run:
        return FileOutcome(src, dest, res)
    st = src.stat()
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".metaclean-tmp")
    tmp.write_bytes(res.data)
    os.replace(tmp, dest)  # atomic: never leaves a half-written original
    strip_xattrs(dest)
    if keep_timestamps:
        os.utime(dest, (st.st_atime, st.st_mtime))
    return FileOutcome(src, dest, res)


def process_many(paths: Iterable[str | Path], options: CleanOptions,
                 progress: Callable[[int, int, FileOutcome], None] | None = None, **kw) -> list[FileOutcome]:
    files = []
    for p in map(Path, paths):
        base = p if p.is_dir() else None
        files += [(f, base) for f in iter_images([p])]
    outcomes = []
    for i, (f, base) in enumerate(files, 1):
        o = process_file(f, options, base=base, **kw)
        outcomes.append(o)
        if progress:
            progress(i, len(files), o)
    return outcomes


def watch(folder: Path, options: CleanOptions, out_dir: Path | None, interval=2.0,
          on_event: Callable[[FileOutcome], None] | None = None, stop: Callable[[], bool] = lambda: False):
    """Poll a folder and clean new or changed images (no extra dependencies)."""
    seen: dict[Path, float] = {}
    for f in iter_images([folder]):
        seen[f] = f.stat().st_mtime
    while not stop():
        time.sleep(interval)
        for f in iter_images([folder]):
            if out_dir and out_dir in f.parents:
                continue
            if "_clean" in f.stem:
                continue
            m = f.stat().st_mtime
            if seen.get(f) == m:
                continue
            # wait until the file stops growing (still being copied)
            size = f.stat().st_size
            time.sleep(0.5)
            if f.stat().st_size != size:
                continue
            seen[f] = m
            o = process_file(f, options, out_dir=out_dir, base=folder)
            if o.dest:
                seen[o.dest] = o.dest.stat().st_mtime
            if on_event:
                on_event(o)
