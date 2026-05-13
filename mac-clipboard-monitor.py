#!/usr/bin/env python3
"""
Codex Terminal Pro Clipboard Image Monitor for macOS
Automatically uploads clipboard images to Codex Terminal Pro add-on

Usage:
    python3 mac-clipboard-monitor.py <ADDON_URL>

Example:
    python3 mac-clipboard-monitor.py http://homeassistant.local:8123
    # Or if using direct port access:
    python3 mac-clipboard-monitor.py http://raspberry-pi-ip:7680

Requirements:
    pip3 install pillow requests pasteboard
"""

import sys
import time
import hashlib
import requests
from pathlib import Path
from datetime import datetime
from io import BytesIO

try:
    from PIL import Image
    import pasteboard
except ImportError:
    print("Error: Required packages not installed")
    print("Please run: pip3 install pillow requests pasteboard")
    sys.exit(1)


class ClipboardMonitor:
    def __init__(self, addon_url):
        self.addon_url = addon_url.rstrip('/')
        self.upload_endpoint = f"{self.addon_url}/upload"
        self.last_image_hash = None

        # Test connection
        try:
            response = requests.get(f"{self.addon_url}/health", timeout=5)
            if response.status_code == 200:
                print(f"✓ Connected to Codex Terminal Pro at {self.addon_url}")
            else:
                print(f"⚠ Warning: Server responded with status {response.status_code}")
        except requests.exceptions.RequestException as e:
            print(f"⚠ Warning: Could not connect to {self.addon_url}")
            print(f"  Error: {e}")
            print("  The monitor will still run, but uploads may fail")

        print("\nClipboard monitor started. Press Ctrl+C to stop.")
        print("Monitoring clipboard for images...")
        print(f"Images will be uploaded to: {self.upload_endpoint}\n")

    def get_clipboard_image(self):
        """Get image from macOS clipboard"""
        pb = pasteboard.Pasteboard()
        image_data = pb.get_contents(type=pasteboard.PNG)

        if image_data:
            return image_data

        # Try TIFF format (common on macOS)
        image_data = pb.get_contents(type=pasteboard.TIFF)
        if image_data:
            # Convert TIFF to PNG
            img = Image.open(BytesIO(image_data))
            png_buffer = BytesIO()
            img.save(png_buffer, format='PNG')
            return png_buffer.getvalue()

        return None

    def calculate_hash(self, data):
        """Calculate MD5 hash of image data"""
        return hashlib.md5(data).hexdigest()

    def upload_image(self, image_data):
        """Upload image to Codex Terminal Pro"""
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3]
        filename = f"clipboard-{timestamp}.png"

        files = {
            'image': (filename, BytesIO(image_data), 'image/png')
        }

        try:
            response = requests.post(
                self.upload_endpoint,
                files=files,
                timeout=10
            )

            if response.status_code == 200:
                result = response.json()
                if result.get('success'):
                    path = result.get('path')
                    size_kb = result.get('size', 0) / 1024

                    # Copy path to clipboard for easy pasting
                    pb = pasteboard.Pasteboard()
                    pb.set_contents(path)

                    timestamp_str = datetime.now().strftime('%H:%M:%S')
                    print(f"[{timestamp_str}] ✓ Uploaded: {filename} ({size_kb:.1f} KB)")
                    print(f"    Path copied to clipboard: {path}")
                    print(f"    Ready to paste into Codex CLI!\n")
                    return True
                else:
                    print(f"✗ Upload failed: {result.get('error', 'Unknown error')}")
            else:
                print(f"✗ Upload failed: HTTP {response.status_code}")
                print(f"  Response: {response.text[:200]}")

        except requests.exceptions.RequestException as e:
            print(f"✗ Upload error: {e}")

        return False

    def monitor(self):
        """Main monitoring loop"""
        while True:
            try:
                time.sleep(0.5)  # Check every 500ms

                image_data = self.get_clipboard_image()

                if image_data:
                    image_hash = self.calculate_hash(image_data)

                    # Only upload if this is a new image
                    if image_hash != self.last_image_hash:
                        self.upload_image(image_data)
                        self.last_image_hash = image_hash

            except KeyboardInterrupt:
                print("\n\nMonitor stopped by user.")
                break
            except Exception as e:
                print(f"✗ Unexpected error: {e}")
                time.sleep(1)


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 mac-clipboard-monitor.py <ADDON_URL>")
        print("\nExamples:")
        print("  python3 mac-clipboard-monitor.py http://homeassistant.local:8123")
        print("  python3 mac-clipboard-monitor.py http://192.168.1.100:7680")
        print("\nNote: Use the direct port (7680) if accessing outside Home Assistant ingress")
        sys.exit(1)

    addon_url = sys.argv[1]
    monitor = ClipboardMonitor(addon_url)
    monitor.monitor()


if __name__ == "__main__":
    main()
