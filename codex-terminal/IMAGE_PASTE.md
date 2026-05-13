# Image Paste Support

Codex Terminal Pro includes a lightweight image upload service on port `7680`
with the ttyd terminal proxied underneath it.

## What It Does

- Accepts pasted, dragged, or selected image files in the browser.
- Stores images in `/data/images`, which persists across add-on restarts.
- Returns a full file path you can paste into Codex.
- Keeps images local to your Home Assistant system unless you explicitly give
  the path to Codex in a prompt.

## Usage

1. Open the add-on web UI.
2. Paste an image, drag an image onto the page, or use the upload button.
3. Copy the returned path, for example:

   ```text
   /data/images/pasted-123456.png
   ```

4. Paste the path into Codex and ask what you want inspected.

Example:

```text
Please inspect this Home Assistant dashboard screenshot and identify unavailable entities: /data/images/pasted-123456.png
```

## Storage And Limits

- Upload directory: `/data/images`
- Max file size: 10 MB
- Accepted types: JPEG, PNG, GIF, WebP, SVG
- Files survive container restarts because they live under `/data`

## Ports

- `7680`: image upload service and web UI
- `7681`: ttyd terminal proxied by the web UI

## Troubleshooting

- If the upload succeeds but Codex cannot read the file, confirm the path starts
  with `/data/images/`.
- If the page loads but the terminal does not, restart the add-on and check the
  add-on logs.
- If paste does not work in the browser, use drag-drop or the upload button.
