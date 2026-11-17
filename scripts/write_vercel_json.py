"""Write the root vercel.json (how Vercel builds and serves the site) from metaclean.server.vercel_config.

    .venv/bin/python scripts/write_vercel_json.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from metaclean.server import VERCEL_URL, vercel_config  # noqa: E402

(ROOT / "vercel.json").write_text(json.dumps(vercel_config(VERCEL_URL, build=True), indent=2) + "\n")
print("wrote vercel.json")
