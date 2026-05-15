# Image Paste Support

Codex Terminal Pro includes a lightweight image upload service on port `7680`
with the ttyd terminal proxied underneath it.

## What It Does

- Accepts pasted, dragged, or selected image files in the browser, including
  paste events that happen while the terminal prompt has focus.
- Stores images in `/data/images`, which persists across add-on restarts.
- Inserts the saved full file path directly into the Codex prompt.
- Keeps images local to your Home Assistant system unless you explicitly give
  the path to Codex in a prompt.

## Usage

1. Open the add-on web UI.
2. Paste an image at the Codex prompt, drag an image onto the page, or use the
   upload button.
3. The saved path is inserted into the prompt, for example:

   ```text
   /data/images/pasted-123456.png
   ```

4. Add the rest of your prompt and send it.

On iOS and Android, browser clipboard image paste support varies. Long-press
paste is handled when the browser exposes the image to the page; otherwise use
the upload button, which opens the device photo picker and inserts the uploaded
path into the prompt.

Example:

```text
Please inspect this Home Assistant dashboard screenshot and identify unavailable entities: /data/images/pasted-123456.png
```

## Storage And Limits

- Upload directory: `/data/images`
- Max file size: 10 MB
- Accepted types: JPEG, PNG, GIF, WebP, SVG, HEIC, HEIF
- Files survive container restarts because they live under `/data`

## Ports

- `7680`: image upload service and web UI
- `7681`: ttyd terminal proxied by the web UI

## Troubleshooting

- If the upload succeeds but Codex cannot read the file, confirm the path starts
  with `/data/images/`.
- If the page loads but the terminal does not, restart the add-on and check the
  add-on logs.
- If mobile paste does not expose an image to the browser, use the upload button
  to pick a photo. The path is still inserted into the Codex prompt.
