"""Export inspection reports as JSON, CSV or PDF."""
from __future__ import annotations

import csv
import io
import json
from datetime import datetime


def _rows(reports: list[dict]):
    for r in reports:
        for key, g in r["groups"].items():
            for f in g["fields"]:
                yield {"file": r["filename"], "format": r["format"], "category": g["title"],
                       "field": f["label"], "id": f["id"], "source": f["source"], "risk": f["risk"],
                       "value": f["value"], "note": f["note"]}


def to_json(reports: list[dict]) -> bytes:
    payload = {"generator": "UnMeta", "created": datetime.now().isoformat(timespec="seconds"),
               "files": reports}
    return json.dumps(payload, indent=2, ensure_ascii=False, default=str).encode("utf-8")


def to_csv(reports: list[dict]) -> bytes:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=["file", "format", "category", "field", "id", "source", "risk",
                                        "value", "note"])
    w.writeheader()
    for row in _rows(reports):
        # values come from untrusted files: keep spreadsheet apps from running them as formulas
        w.writerow({k: ("'" + v if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r") else v) for k, v in row.items()})
    return buf.getvalue().encode("utf-8-sig")


RISK_COLOURS = {"high": "#c62828", "medium": "#ef6c00", "low": "#2e7d32", "none": "#757575"}


def to_pdf(reports: list[dict]) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
    from xml.sax.saxutils import escape

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm,
                            topMargin=14 * mm, bottomMargin=14 * mm, title="UnMeta report")
    ss = getSampleStyleSheet()
    small = ss["BodyText"].clone("small", fontSize=7.5, leading=9)
    story = [Paragraph("UnMeta metadata report", ss["Title"]),
             Paragraph(datetime.now().strftime("%Y-%m-%d %H:%M"), ss["Normal"]), Spacer(1, 6)]
    for r in reports:
        story.append(Paragraph(escape(f"{r['filename']}  ·  {r['format'].upper()}  ·  {r['width']}×{r['height']}"
                                      f"  ·  overall risk: {r['overall_risk'].upper()}"), ss["Heading2"]))
        if r.get("gps"):
            story.append(Paragraph(f"GPS position: {r['gps'][0]}, {r['gps'][1]}", ss["Normal"]))
        for s in r.get("ai_signals", []):
            story.append(Paragraph(escape(f"AI signal: {s['signal']}: {s['verdict']} ({s['detail']})"), small))
        data = [["Category", "Field", "Value", "Risk"]]
        styles = []
        for key, g in r["groups"].items():
            for f in g["fields"]:
                data.append([g["title"], Paragraph(escape(f["label"]), small),
                             Paragraph(escape(f["value"][:300]), small), f["risk"].upper()])
                styles.append(("TEXTCOLOR", (3, len(data) - 1), (3, len(data) - 1),
                               colors.HexColor(RISK_COLOURS[f["risk"]])))
        if len(data) == 1:
            story.append(Paragraph("No metadata found.", ss["Normal"]))
        else:
            t = Table(data, colWidths=[28 * mm, 42 * mm, 98 * mm, 14 * mm], repeatRows=1)
            t.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 7.5),
                                   ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#263238")),
                                   ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                                   ("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#cfd8dc")),
                                   ("VALIGN", (0, 0), (-1, -1), "TOP")] + styles))
            story.append(t)
        story.append(Spacer(1, 10))
    doc.build(story)
    return buf.getvalue()


def export(reports: list[dict], fmt: str) -> tuple[bytes, str]:
    fmt = fmt.lower()
    if fmt == "json":
        return to_json(reports), "application/json"
    if fmt == "csv":
        return to_csv(reports), "text/csv"
    if fmt == "pdf":
        return to_pdf(reports), "application/pdf"
    raise ValueError("format must be json, csv or pdf")
