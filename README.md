# JetKVM touch proxy

A small Docker container that sits in front of your JetKVM and makes its web UI usable from an iPhone or iPad. It loads the normal JetKVM page from your device and adds a script that turns finger gestures into mouse input and lets you type with the phone's own keyboard. Nothing on the JetKVM changes, and you can keep its automatic updates on.

This is an unofficial community project. It is not made by or affiliated with JetKVM.

## Gestures

| Gesture | Trackpad mode (default) | Direct mode |
| --- | --- | --- |
| One-finger drag | Moves the cursor, like a laptop trackpad | Drags with the left button held, under your finger |
| Tap | Left click where the cursor is | Moves the cursor to your finger and left-clicks |
| Double tap | Double click | Double click |
| Tap, then touch again and drag | Drag with the left button held (select text, move windows) | Same |
| Two-finger tap | Right click | Right click |
| Long press | Right click | Right click |
| Two-finger drag | Scroll wheel (up/down and left/right) | Scroll wheel |
| Three-finger tap | Middle click | Middle click |
| Pinch | Zooms the picture in or out around your fingers | Same |

In trackpad mode a small hollow ring shows where the cursor is going while you move, then fades so the real pointer stays visible. When you zoom in, the picture pans to follow the cursor.

## Menu and keyboard

A round blue button in the bottom-right corner opens a menu:

- **Show keyboard** opens the iPhone keyboard. Whatever you type is sent to the remote computer. A bar above the keyboard adds the keys the phone lacks: Esc, Tab, arrows, Del, Home, End, Page Up/Down, F1 to F12 and Ctrl+Alt+Del. Ctrl, Alt, Win and Shift stay held for the next key you press, so Ctrl then C sends Ctrl+C. Tap "Done" to close the keyboard. If the keyboard covers the cursor, the picture moves up so you can see what you're typing into.
- **Touch mode** switches between Trackpad and Direct.
- **Trackpad speed** cycles from 0.6x to 2.4x.
- **Cursor ring** turns the position ring on or off.
- **Scrolling** flips the scroll direction.
- **Reset zoom** appears when you're zoomed in.

Settings are remembered per browser. Typed characters are sent as US keyboard keys, so set the remote computer's keyboard layout to US English for symbols to come out right.

A real mouse on a computer passes through untouched, so you can use the same address from a PC. To try the gestures on a PC, open Chrome DevTools and turn on device emulation.

## Run it

You need a machine on your home network that is always on and runs Docker (a NAS, a Raspberry Pi, a home server or a PC).

1. Clone this repository on that machine: `git clone https://github.com/koopertrooper/jetkvm-touch-proxy`
2. In `docker-compose.yml`, set `JETKVM_URL` to your JetKVM's address, for example `http://192.168.1.50`.
3. Run `docker compose up -d --build`.
4. On your iPhone, open `http://<docker-machine-ip>:8080` in Safari and log in as usual.

Without Compose, run:

```
docker build -t jetkvm-touch-proxy .
docker run -d --restart unless-stopped -p 8080:8080 -e JETKVM_URL=http://192.168.1.50 --name jetkvm-touch jetkvm-touch-proxy
```

Tip: in Safari, use Share, then "Add to Home Screen". It opens without Safari's address bar, which gives the video more room.

## Things to know

- **Mouse mode must be Absolute.** This is the JetKVM default. The toolbar shows a red warning if it is set to Relative.
- **Your phone still needs to reach the JetKVM itself.** Only the web page and login go through the proxy. The video stream connects directly from your phone to the JetKVM, so both must be on the same network. When you're away, use a VPN such as Tailscale that reaches both.
- **JetKVM Cloud (app.jetkvm.com) is not covered.** Open the proxy address instead.
- **HTTPS on the JetKVM.** If your JetKVM only serves HTTPS, use `JETKVM_URL=https://192.168.1.50`. Its self-signed certificate is accepted. To require a valid certificate, set `JETKVM_INSECURE_TLS=false`.
- **Security.** The proxy adds no login of its own, and your JetKVM password still applies. Keep it on your home network and don't expose port 8080 to the internet.
- **After a JetKVM update.** The script depends on how the JetKVM page handles mouse input today. If a future update breaks the gestures, the fix is usually a few lines in `touch.js`. Rebuild with `docker compose up -d --build`.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `JETKVM_URL` | (required) | Address of your JetKVM, such as `http://192.168.1.50` |
| `PORT` | `8080` | Port the proxy listens on inside the container |
| `JETKVM_INSECURE_TLS` | `true` | Accept the JetKVM's self-signed HTTPS certificate |

Health check: `http://<docker-machine-ip>:8080/__touch/health` returns `ok`.

## Files

- `server.js` is the proxy. It uses only Node's standard library. It forwards everything to the JetKVM, including the WebSocket used to set up video, and adds `<script src="/__touch/touch.js">` to HTML pages.
- `touch.js` is the gesture layer. Its tuning values (tap time, long-press time, scroll step, speeds) are at the top.
- `Dockerfile` and `docker-compose.yml` build and run the container.

## License

GPL-3.0. See [LICENSE](LICENSE).
