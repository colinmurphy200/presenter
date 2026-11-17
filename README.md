# Overlay Presenter

A browser-based Beamer PDF presenter, built on PDF.js 6.5.438:

- **Overlay cross-fade.** Pages that share a Beamer page label (the overlays of one frame) fade into each other, so only the newly revealed content appears to change. Between frames it cuts by default; both durations are adjustable in the menu.
- **PDF links.** Internal links (`\hyperlink`, `\ref`, navigation symbols), named actions and external URLs all work. Alt+← or the menu's Back button returns after a link jump.
- **Pinch-zoom.** Works with touch (iPad), trackpad (Firefox/Chrome send ctrl+wheel; Safari sends gesture events), and the +/− keys. Only the visible region is re-rendered, sharply, at screen resolution, so memory stays bounded at any zoom (up to 12×). Zoom is kept while you step through a frame's overlays and resets when the frame changes.

- **Apple Pencil annotations.** The Pencil writes, while fingers keep navigating and zooming; touches made while writing are ignored, which rejects your palm. There are red, blue and black pens, a highlighter, an eraser, undo and clear-slide. Ink drawn on one overlay step stays visible on the later steps of the same frame and tracks zoom. It is saved in the browser for each deck, so it survives a reload. On the Mac, press D to draw with the mouse or trackpad.
- **Save annotated PDF** (in the menu) writes the ink into a copy of the original PDF as vector strokes, keeping text and links. On the iPad it opens the share sheet (use "Save to Files"); on the Mac it downloads. This uses pdf-lib 1.17.1.

## Running it

Live at https://colinmurphy200.github.io/presenter/ (GitHub Pages).

Any static web server works, for example:

    cd overlay-presenter && python3 -m http.server 8000

Then open http://localhost:8000 in a browser. It can't be opened as file://, because browsers block ES modules and workers there.

To use it on the iPad, host the folder somewhere reachable over HTTPS (GitHub Pages is free). Open it in Safari, then use Share → Add to Home Screen to get a full-screen app without browser bars. The last deck you opened is kept in the browser, so "Resume" reopens it without going through Files.

## Controls

| Action | How |
|---|---|
| Next / previous | Tap the right / left quarter, swipe, click, → / ←, Space, PageDown/PageUp (clickers) |
| Skip overlays | Shift+→ / Shift+←, or ] / [ |
| Zoom | Pinch, + / −; drag (or two-finger scroll) to pan; Esc resets |
| Go to frame | Type the number, then Enter |
| Menu | Long-press the slide, or M |
| Blank screen | B (black), W (white) |
| Fullscreen | F |
| Draw with mouse / eraser / undo | D / E / U (or Cmd+Z) |

This copy loads PDF.js 6.5.438 and pdf-lib 1.17.1 from the jsDelivr CDN. To make it self-contained, add a `pdfjs/` folder (PDF.js's `build/pdf.min.mjs`, `build/pdf.worker.min.mjs`, `standard_fonts/` and `wasm/`) and `vendor/pdf-lib.min.js`; the app uses local copies when they exist.
