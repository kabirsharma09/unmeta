# Platform test kit

Tests what each app really does to a photo's hidden details, so the guides can say "tested" with a date.

The test files carry made-up but realistic details: GPS for Trafalgar Square (51.5072, −0.1275), an iPhone 15 Pro with
a serial number, the owner "Jane Doe", dates, an AI label and an embedded thumbnail. Nothing in them is yours.

| File | What's inside |
|---|---|
| `unmeta-test-photo.jpg` | Location, device and serial, names and dates, AI label, hidden thumbnail |
| `unmeta-test-photo.heic` | The same, as an iPhone HEIC |
| `unmeta-test-video.mov` | Location, device, dates (an iPhone-style video) |

## How to test one app

1. Send or post the test file the way people normally do (see the table below). Use a private account, a chat with
   yourself, or a throwaway server.
2. Download the copy the app gives back, the way another person would get it.
3. Compare it with the original:

   ```bash
   node engine/tools/compare.ts testkit/unmeta-test-photo.jpg ~/Downloads/<downloaded file> "WhatsApp (as photo)"
   ```

   It prints what was kept or removed, and a Markdown row for the guide.
4. Paste the row into `testkit/results.md` with the date and the app version.

## What to test

| App | Send it | Get it back |
|---|---|---|
| WhatsApp | "Message yourself": once as a photo, once as a document | Save each from the chat |
| Telegram | "Saved Messages": once as a photo, once as a file | Save each |
| Discord | A private server: the photo, then the video | Open each, then "Save" or "Open in browser" and save |
| Instagram | A post on a private or test account | Settings → Your activity → Download your information (media) |
| Facebook | A post visible to "Only me" | Open the photo → ⋯ → Download |
| X | A post on a protected account | Open the image → save the original |
| iMessage / AirDrop | To your own device, once with Options → Location on, once off | Save from Messages or Files |
| Email | Attach to an email to yourself | Download the attachment |

Test the photo first. Repeat with the video for apps that take videos (WhatsApp, Telegram, Discord).

## After testing

Send me `testkit/results.md` and I'll update the guides (`which apps remove photo metadata`, Discord, Telegram,
WhatsApp, Instagram) with a "Tested on <date>" table.
