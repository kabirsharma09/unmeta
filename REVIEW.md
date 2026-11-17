# Review checklist

Check only the items whose trigger matches the diff. Each item exists because the mistake is easy to make here.
Findings are tagged **Important**, **Nit** or **Pre-existing**.

| # | Trigger (in the diff) | Check |
|---|---|---|
| 1 | Any `innerHTML`, template string or `insertAdjacentHTML` in `app.js` | Every value from a file (names, metadata, notes) goes through `esc()`. No raw file text reaches HTML. |
| 2 | New network API, URL built from data, `<link>`, `<img src>`, CSS `url()` | Nothing can carry file data off the page. `connect-src 'none'` stays in both the header and the meta tag. |
| 3 | `server.py` headers or CSP, `export()`, `_headers` | Page, worker and service worker each have exactly one policy. Static export has a rule for every page. |
| 4 | `_sw.js` | Caches only same-origin GETs of the app's own files; never `/api/`; handles no POSTs. |
| 5 | A parser in `engine/src/` reads a length or offset from the file | It is clamped to the data; loops always advance; sizes are capped; a fuzz case exists. |
| 6 | A cleaner removes something new | Removal happens everywhere that data can live (every copy, every revision); the post-clean scan would catch a leftover; a test asserts the bytes are gone. |
| 7 | A field is added to the "verified" decision | Nothing private can be reported clean. Informational fields (comments, tracked changes) never count as removed. |
| 8 | Cleaning code paths | Picture/frames/sound/document content stay byte-identical; idempotence property still holds. |
| 9 | Copy on pages, FAQ, `llms.txt`, manifest | Claims match what the code does (formats, limits, offline, "never uploaded"). Visible FAQ text matches its structured data. |
| 10 | New page in `pages.py` | Unique title (≤ 75 chars) and description; answer-first lead; FAQ honest about limits; linked from footer and sitemap. |
| 11 | Python `/api/*` | Still refused when a public URL is set; still requires `X-MetaClean` and same-origin. |
| 12 | Files downloaded or written back to a folder | Names are sanitised (no `..`, no absolute paths); originals change only after explicit confirmation. |
| 13 | UI | axe clean in light and dark at 390 px and desktop; works in Safari (sticky header, previews). |

Rules come from real misses in this project: shadowed helper names crashing the clean (`base`), a hidden second location copy in a damaged MOV reported clean, empty metadata keys left behind, Safari painting animated bars over the header, a cross-site guard that blocked links from search results.
