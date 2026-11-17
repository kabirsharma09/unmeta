"""Command-line interface:  unmeta inspect|clean|watch|serve|export|presets|demo"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import presets as PR
from . import reports
from .batch import iter_images, process_many, watch
from .cleaner import CleanOptions
from .inspector import inspect_bytes
from .taxonomy import CATEGORIES

RISK_ICON = {"high": "\033[31m● HIGH\033[0m", "medium": "\033[33m● MED \033[0m",
             "low": "\033[32m● LOW \033[0m", "none": "\033[90m○     \033[0m"}


def _icon(r: str) -> str:
    return RISK_ICON[r] if sys.stdout.isatty() else f"[{r.upper()}]"


def build_options(a) -> CleanOptions:
    base = PR.resolve(a.preset) if a.preset else PR.BUILTIN["social_share"]["options"]
    d = json.loads(json.dumps(base))
    if a.keep is not None:
        d["keep_categories"] = [c.strip() for c in a.keep.split(",") if c.strip()]
    if a.keep_field:
        d["keep_fields"] = list(set(d.get("keep_fields", [])) | set(a.keep_field))
    if a.drop_field:
        d["drop_fields"] = list(set(d.get("drop_fields", [])) | set(a.drop_field))
    if a.orientation:
        d["orientation"] = a.orientation
    if a.quality:
        d["quality"] = a.quality
    if a.format:
        d["output_format"] = a.format
    if a.icc is not None:
        d["keep_icc"] = a.icc == "keep"
    edits = {}
    for kv in a.set or []:
        k, _, v = kv.partition("=")
        edits[k.strip()] = v
    if edits:
        d["edits"] = edits
    return CleanOptions.from_dict(d)


def cmd_inspect(a) -> int:
    reps = []
    for p in iter_images(a.paths):
        inv = inspect_bytes(p.read_bytes(), p.name)
        r = inv.report()
        r["path"] = str(p)
        reps.append(r)
        if a.json:
            continue
        print(f"\n{p}  ({r['format'].upper()} {r['width']}×{r['height']}, {r['size_bytes']:,} bytes)  "
              f"overall {_icon(r['overall_risk'])}")
        if r["gps"]:
            print(f"   📍 GPS {r['gps'][0]}, {r['gps'][1]}")
        for s in r["ai_signals"]:
            print(f"   🤖 {s['signal']}: {s['verdict']}  ({s['detail'][:70]})")
        for key, g in r["groups"].items():
            if not g["count"]:
                continue
            print(f"   {g['title']} ({g['count']}) {_icon(g['risk'])}")
            if a.verbose:
                for f in g["fields"]:
                    print(f"      {_icon(f['risk'])} {f['label']}: {f['value'][:90]}")
        for e in r["errors"]:
            print(f"   ⚠ {e}")
    if a.json:
        print(reports.to_json(reps).decode())
    if a.report:
        data, _ = reports.export(reps, Path(a.report).suffix.lstrip("."))
        Path(a.report).write_bytes(data)
        print(f"\nReport written to {a.report}", file=sys.stderr)
    return 0


def cmd_clean(a) -> int:
    opts = build_options(a)
    failures = 0
    reps = []

    def progress(i, n, o):
        nonlocal failures
        if o.error:
            failures += 1
            print(f"[{i}/{n}] ✗ {o.src}: {o.error}")
            return
        s = o.result.summary()
        mark = "✓" if s["verified"] else "!"
        tag = "lossless" if s["lossless"] else "re-encoded"
        verb = "would write" if a.dry_run else "→"
        print(f"[{i}/{n}] {mark} {o.src} {verb} {o.dest}  removed {s['removed']}, kept {s['kept']}"
              f"{', edited ' + str(s['changed']) if s['changed'] else ''} ({tag})")
        for w in s["warnings"]:
            print(f"        ⚠ {w}")
        for r in s["residual"]:
            print(f"        ! still present: {r['label']} = {r['value'][:60]}")
        reps.append({**o.result.after.report(), "path": str(o.dest)})

    outs = process_many(a.paths, opts, progress=progress, overwrite=a.overwrite,
                        out_dir=Path(a.out) if a.out else None, suffix=a.suffix,
                        keep_timestamps=a.keep_timestamps, dry_run=a.dry_run)
    if not outs:
        print("No images found.")
        return 1
    if a.report:
        data, _ = reports.export(reps, Path(a.report).suffix.lstrip("."))
        Path(a.report).write_bytes(data)
    ok = sum(1 for o in outs if o.result and o.result.verified)
    print(f"\nDone: {len(outs)} file(s), {ok} verified clean, {failures} failed.")
    return 1 if failures else 0


def cmd_watch(a) -> int:
    opts = build_options(a)
    folder = Path(a.folder)
    out = Path(a.out) if a.out else folder / "cleaned"
    print(f"Watching {folder} → {out}  (Ctrl+C to stop)")

    def ev(o):
        print(("✓ " if o.result and o.result.verified else "! ") + f"{o.src.name} → {o.dest}" if o.dest
              else f"✗ {o.src.name}: {o.error}")
    try:
        watch(folder, opts, out, interval=a.interval, on_event=ev)
    except KeyboardInterrupt:
        pass
    return 0


def cmd_export(a) -> int:
    from .server import export
    files = export(a.out, a.public_url)
    print(f"Wrote {len(files)} files to {a.out}. Upload that folder to any static host over HTTPS.")
    return 0


def cmd_serve(a) -> int:
    if a.public_url:
        import os
        os.environ["METACLEAN_PUBLIC_URL"] = a.public_url
    from .server import run
    run(port=a.port, open_browser=not a.no_browser)
    return 0


def cmd_presets(a) -> int:
    if a.action == "list":
        for k, p in PR.all_presets().items():
            print(f"{k:20} {p['name']:28} {'(built-in)' if p['builtin'] else '(yours)'}\n{'':20} {p['description']}")
    elif a.action == "save":
        opts = build_options(a)
        PR.save_user(a.key, a.name or a.key, {
            "keep_categories": sorted(opts.keep_categories), "keep_fields": sorted(opts.keep_fields),
            "drop_fields": sorted(opts.drop_fields), "orientation": opts.orientation,
            "keep_icc": opts.keep_icc, "quality": opts.quality, "edits": opts.edits})
        print(f"Saved preset '{a.key}'")
    elif a.action == "delete":
        PR.delete_user(a.key)
        print(f"Deleted '{a.key}'")
    return 0


def cmd_demo(a) -> int:
    from .samples import write_samples
    for p in write_samples(Path(a.folder)):
        print(p)
    return 0


def _add_clean_flags(p):
    p.add_argument("--preset", help="preset key or name (default: social_share)")
    p.add_argument("--keep", help=f"comma-separated categories to keep: {', '.join(CATEGORIES)}")
    p.add_argument("--keep-field", action="append", help="field id to keep (see inspect --json)")
    p.add_argument("--drop-field", action="append", help="field id to always drop")
    p.add_argument("--orientation", choices=["keep", "bake", "drop"])
    p.add_argument("--icc", choices=["keep", "drop"], default=None, help="colour profile")
    p.add_argument("--quality", type=int, help="quality when re-encoding (1-100)")
    p.add_argument("--format", choices=["same", "jpeg", "png", "webp"], help="convert output format")
    p.add_argument("--set", action="append", metavar="KEY=VALUE",
                   help="write a field: artist, copyright, description, title, keywords, "
                        "datetime_original, software, or exif:<TagName>")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="unmeta", description="UnMeta: see and remove hidden details from photos, locally.")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("inspect", help="show what metadata images contain")
    p.add_argument("paths", nargs="+")
    p.add_argument("-v", "--verbose", action="store_true", help="list every field")
    p.add_argument("--json", action="store_true")
    p.add_argument("--report", help="write report to .json, .csv or .pdf")
    p.set_defaults(fn=cmd_inspect)

    p = sub.add_parser("clean", help="remove metadata")
    p.add_argument("paths", nargs="+")
    _add_clean_flags(p)
    p.add_argument("--overwrite", action="store_true", help="replace originals in place")
    p.add_argument("--out", help="write cleaned copies to this folder (keeps sub-folders)")
    p.add_argument("--suffix", default="_clean", help="suffix for cleaned copies (default _clean)")
    p.add_argument("--keep-timestamps", action="store_true", help="preserve file modification time")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--report", help="write post-clean report (.json/.csv/.pdf)")
    p.set_defaults(fn=cmd_clean)

    p = sub.add_parser("watch", help="clean new images dropped into a folder")
    p.add_argument("folder")
    p.add_argument("--out", help="output folder (default: <folder>/cleaned)")
    p.add_argument("--interval", type=float, default=2.0)
    _add_clean_flags(p)
    p.set_defaults(fn=cmd_watch)

    p = sub.add_parser("export", help="build a static copy of the web app for any static host")
    p.add_argument("out", help="folder to write (it is replaced)")
    p.add_argument("--public-url", default="", help="public https address (turns on search indexing, sitemap and HSTS)")
    p.set_defaults(fn=cmd_export)
    p = sub.add_parser("serve", help="open the local web app (127.0.0.1 only)")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-browser", action="store_true")
    p.add_argument("--public-url", help="public address when hosted (turns on search indexing and the sitemap)")
    p.set_defaults(fn=cmd_serve)

    p = sub.add_parser("presets", help="list / save / delete presets")
    p.add_argument("action", choices=["list", "save", "delete"])
    p.add_argument("key", nargs="?")
    p.add_argument("--name")
    _add_clean_flags(p)
    p.set_defaults(fn=cmd_presets)

    p = sub.add_parser("demo", help="write sample images full of metadata")
    p.add_argument("folder", nargs="?", default="unmeta-samples")
    p.set_defaults(fn=cmd_demo)

    a = ap.parse_args(argv)
    try:
        return a.fn(a)
    except KeyError as e:
        print(e.args[0], file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
