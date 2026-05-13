# Mac Clipboard Monitor for Codex Terminal Pro

This optional helper watches your Mac clipboard for images and uploads them to
the Codex Terminal Pro image service. It then copies the uploaded `/data/images`
path back to your clipboard so you can paste it into Codex.

## Usage

```bash
python3 mac-clipboard-monitor.py http://homeassistant.local:8123
```

Paste the returned path into Codex, for example:

```text
Please inspect this screenshot: /data/images/clipboard-123.png
```

## LaunchAgent Example

Create `~/Library/LaunchAgents/com.codex-terminal.clipboard-monitor.plist` with
paths adjusted for your checkout:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codex-terminal.clipboard-monitor</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/python3</string>
        <string>/path/to/codex-terminal-pro/mac-clipboard-monitor.py</string>
        <string>http://homeassistant.local:8123</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/codex-terminal-clipboard-monitor.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/codex-terminal-clipboard-monitor.error.log</string>
</dict>
</plist>
```

Load it with:

```bash
launchctl load ~/Library/LaunchAgents/com.codex-terminal.clipboard-monitor.plist
```

Images are stored locally on Home Assistant under `/data/images` until you choose
to reference them in a Codex prompt.
