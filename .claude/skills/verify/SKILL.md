---
name: verify
description: Verify a change to UnMeta end to end before committing - run every automated check, then boot the web app and drive a real clean of a photo, a video and a document in the browser (and Safari on iOS when the change touches UI or file handling). Use before every commit and when asked to "verify", "check it works" or "test the app".
---

# Verify UnMeta

Do every step that applies to the change. If a step fails, fix and repeat; after three failed rounds, stop and tell the user what is failing.

## 1. Automated checks (always)

```bash
scripts/verify.sh
```

It runs the Python suite, the engine suite (unit, real Apple files, property and fuzz tests), the engine typecheck, checks the browser bundle is current, builds the static site and checks every page's security headers.

## 2. Boot the app

Use the browser pane with the `metaclean` launch configuration (port 8765), or `.venv/bin/unmeta serve --port 8766`. Restart the server after changing any `.py` file; static files reload on refresh.

## 3. Drive a real clean (always for UI, engine or worker changes)

The page's security policy blocks `fetch`, so files are built in the page. Run in the page (javascript tool):

```js
// a PNG with an author and an AI prompt inside
const crcT=[...Array(256)].map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0});
const crc=b=>{let c=~0;for(const x of b)c=crcT[(c^x)&255]^(c>>>8);return (~c)>>>0};
const chunk=(t,txt)=>{const d=new TextEncoder().encode(t+txt);const o=new Uint8Array(8+d.length);const v=new DataView(o.buffer);v.setUint32(0,d.length-4);o.set(d,4);v.setUint32(4+d.length,crc(d));return o};
const c=document.createElement('canvas');c.width=400;c.height=300;c.getContext('2d').fillRect(0,0,400,300);
const png=new Uint8Array(await (await new Promise(r=>c.toBlob(r,'image/png'))).arrayBuffer());
const f=new File([png.slice(0,33),chunk('tEXt','Author\0Jane Doe'),chunk('tEXt','parameters\0a cat, Steps: 20, Seed: 1'),png.slice(33)],'IMG.png');
add([{file:f,path:'IMG.png'}]); await new Promise(r=>setTimeout(r,1500)); cleanAll(); await new Promise(r=>setTimeout(r,2000));
const t=new TextDecoder('latin1').decode(new Uint8Array(await state.items[0].out.blob.arrayBuffer()));
({verified: state.items[0].out.verified, leaked: ['Jane Doe','Steps: 20'].filter(s=>t.includes(s))})  // expect verified true, leaked []
```

For a video, record one with `MediaRecorder` on a canvas (`video/mp4;codecs=avc1`); for a PDF, build a minimal PDF with an `/Author` Info dictionary and a `/Annot` comment (see the README test notes). Expect: verified, nothing private left, MP4 same size, PDF same length, comment kept.

Then check with your eyes (screenshot): review screen, done screen (stamps, redaction bars, "kept as it is"), and the console has no errors.

## 4. Accessibility (UI changes)

Copy `axe-core/axe.min.js` to `metaclean/static/axe-tmp.js`, load it in the page, run `axe.run` for wcag2a/aa, 21aa, 22aa and best-practice on home, a landing page, review and done screens, in light and dark, at 390 px and desktop. Expect no violations. Delete `axe-tmp.js` afterwards (it is git-ignored).

## 5. Safari on iPhone (UI or file-handling changes)

Attach the iOS Simulator, open `http://localhost:8765/`, tap "Choose photos or videos" → Photo Library, pick sample photos, Clean, scroll the done screen. Expect previews, findings (a real iPhone sample has GPS), stamps, and the header never painted over.

## 6. Offline (service worker or caching changes)

Load the app, wait for the service worker to activate (19+ cached files), stop the server, reload, and clean a file.

## 7. Commit

Stamp the commit message with how it was verified, e.g.:

```
Verified: scripts/verify.sh (all passed); browser e2e photo+PDF; axe clean (home, review, done; light/dark; 390px).
```

Write `Verified: none` if it wasn't, and say why.
