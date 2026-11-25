// JetKVM touch layer, added to the JetKVM page by the touch proxy.
//
// The JetKVM UI only reacts to desktop mouse events on its <video> element.
// This script catches finger gestures on that element before the UI sees
// them and replays them as the mouse events the UI already handles
// (mousemove, pointerdown/pointerup with a buttons mask, and wheel).
// A real mouse or trackpad on a computer is left alone.
//
// Requires the JetKVM mouse mode "Absolute" (the default).

(function () {
  "use strict";
  if (window.__jetkvmTouch) return;
  window.__jetkvmTouch = true;

  // ---- Tunables ---------------------------------------------------------
  var TAP_MAX_MS = 300; // a touch shorter than this, without moving, is a tap
  var TAP_SLOP_PX = 10; // finger movement allowed before a tap becomes a drag
  var DOUBLE_TAP_MS = 300; // second touch within this after a tap = hold/drag
  var DOUBLE_TAP_PX = 40;
  var LONG_PRESS_MS = 550; // hold still this long = right click
  var SCROLL_STEP_PX = 16; // two-finger movement per wheel notch
  var COMPAT_MOUSE_BLOCK_MS = 800; // ignore browser mouse emulation after touch
  var SPEEDS = [0.6, 1, 1.6, 2.4];
  var CURSOR_SHOW_MS = 600; // the position ring fades this long after the last move

  var BTN_LEFT = 1;
  var BTN_RIGHT = 2;
  var BTN_MIDDLE = 4;

  // ---- Settings ---------------------------------------------------------
  function load(key, fallback) {
    try {
      var v = window.localStorage.getItem("jetkvmTouch." + key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      window.localStorage.setItem("jetkvmTouch." + key, JSON.stringify(value));
    } catch (e) {
      /* private mode */
    }
  }

  var state = {
    mode: load("mode", "trackpad"), // "trackpad" | "direct"
    speedIndex: load("speedIndex", 1),
    invertScroll: load("invertScroll", false),
    collapsed: load("collapsed", false),
    showMarker: load("showMarker", true),
    nx: 0.5, // cursor position, 0..1 across the visible video picture
    ny: 0.5,
    buttons: 0,
    lastTouchAt: 0,
    lastMoveAt: 0,
    fadeTimer: null,
    lastTapAt: 0,
    lastTapX: 0,
    lastTapY: 0,
  };
  if (SPEEDS[state.speedIndex] === undefined) state.speedIndex = 1;

  var gesture = null;

  // ---- Geometry ---------------------------------------------------------
  function getVideo() {
    return document.querySelector("video");
  }

  // The picture inside the <video> element (object-fit: contain adds bars).
  function contentRect(video) {
    var r = video.getBoundingClientRect();
    var vw = video.videoWidth;
    var vh = video.videoHeight;
    var left = r.left;
    var top = r.top;
    var width = r.width;
    var height = r.height;
    if (vw && vh && r.width && r.height) {
      var elAspect = r.width / r.height;
      var vidAspect = vw / vh;
      if (elAspect > vidAspect) {
        width = r.height * vidAspect;
        left = r.left + (r.width - width) / 2;
      } else if (elAspect < vidAspect) {
        height = r.width / vidAspect;
        top = r.top + (r.height - height) / 2;
      }
    }
    return { left: left, top: top, width: width, height: height, el: r };
  }

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function setCursorFromClient(video, x, y) {
    var c = contentRect(video);
    if (!c.width || !c.height) return;
    state.nx = clamp01((x - c.left) / c.width);
    state.ny = clamp01((y - c.top) / c.height);
  }

  function cursorClient(video) {
    var c = contentRect(video);
    return { x: c.left + state.nx * c.width, y: c.top + state.ny * c.height, rect: c };
  }

  // ---- Sending mouse events to the JetKVM UI -----------------------------
  function withOffsets(ev, video, x, y) {
    // The UI reads offsetX/offsetY. Safari does not always compute them for
    // script-made events, so set them explicitly.
    var r = video.getBoundingClientRect();
    try {
      Object.defineProperty(ev, "offsetX", { value: x - r.left });
      Object.defineProperty(ev, "offsetY", { value: y - r.top });
    } catch (e) {
      /* read-only on this browser; the native value is used */
    }
    return ev;
  }

  function makePointerEvent(type, x, y, buttons, button) {
    var init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      buttons: buttons,
      button: button,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
    if (typeof window.PointerEvent === "function") return new PointerEvent(type, init);
    return new MouseEvent(type, init);
  }

  function sendMove() {
    var video = getVideo();
    if (!video) return;
    var p = cursorClient(video);
    var ev = new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: p.x,
      clientY: p.y,
      screenX: p.x,
      screenY: p.y,
      buttons: state.buttons,
    });
    video.dispatchEvent(withOffsets(ev, video, p.x, p.y));
    state.lastMoveAt = Date.now();
    drawCursor();
    clearTimeout(state.fadeTimer);
    state.fadeTimer = setTimeout(drawCursor, CURSOR_SHOW_MS + 20);
  }

  function buttonIndex(mask) {
    return mask === BTN_RIGHT ? 2 : mask === BTN_MIDDLE ? 1 : 0;
  }

  function press(mask) {
    var video = getVideo();
    if (!video) return;
    state.buttons |= mask;
    var p = cursorClient(video);
    video.dispatchEvent(
      withOffsets(makePointerEvent("pointerdown", p.x, p.y, state.buttons, buttonIndex(mask)), video, p.x, p.y),
    );
  }

  function release(mask) {
    var video = getVideo();
    if (!video) return;
    state.buttons &= ~mask;
    var p = cursorClient(video);
    video.dispatchEvent(
      withOffsets(makePointerEvent("pointerup", p.x, p.y, state.buttons, buttonIndex(mask)), video, p.x, p.y),
    );
  }

  function click(mask) {
    press(mask);
    setTimeout(function () {
      release(mask);
    }, 30);
  }

  function releaseAll() {
    if (state.buttons & BTN_LEFT) release(BTN_LEFT);
    if (state.buttons & BTN_RIGHT) release(BTN_RIGHT);
    if (state.buttons & BTN_MIDDLE) release(BTN_MIDDLE);
  }

  function wheel(dy, dx) {
    var video = getVideo();
    if (!video) return;
    var p = cursorClient(video);
    var ev = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: p.x,
      clientY: p.y,
      deltaX: dx,
      deltaY: dy,
      deltaMode: 0,
    });
    video.dispatchEvent(ev);
  }

  // ---- Gesture recognition ----------------------------------------------
  function centroid(touchList) {
    var x = 0;
    var y = 0;
    for (var i = 0; i < touchList.length; i++) {
      x += touchList[i].clientX;
      y += touchList[i].clientY;
    }
    return { x: x / touchList.length, y: y / touchList.length };
  }

  function cancelLongPress() {
    if (gesture && gesture.longPressTimer) {
      clearTimeout(gesture.longPressTimer);
      gesture.longPressTimer = null;
    }
  }

  function onTouchStart(e) {
    var video = getVideo();
    if (!video) return;
    if (!gesture) {
      if (e.target !== video) return;
      var t0 = e.changedTouches[0];
      var now = Date.now();
      gesture = {
        startAt: now,
        startX: t0.clientX,
        startY: t0.clientY,
        lastX: t0.clientX,
        lastY: t0.clientY,
        lastAt: now,
        maxFingers: 0,
        moved: false,
        held: false, // left button held for this gesture
        consumed: false, // already handled (long press fired)
        scrollX: 0,
        scrollY: 0,
        multiLast: null,
        longPressTimer: null,
      };

      if (state.mode === "direct") {
        setCursorFromClient(video, t0.clientX, t0.clientY);
        sendMove();
      }

      // A touch that lands right after a tap holds the left button, which
      // gives double click (tap twice) and drag (tap, then touch and move).
      var sinceTap = now - state.lastTapAt;
      var dist = Math.hypot(t0.clientX - state.lastTapX, t0.clientY - state.lastTapY);
      if (sinceTap < DOUBLE_TAP_MS && dist < DOUBLE_TAP_PX) {
        gesture.held = true;
        press(BTN_LEFT);
      } else {
        gesture.longPressTimer = setTimeout(function () {
          if (!gesture || gesture.moved || gesture.maxFingers > 1) return;
          gesture.consumed = true;
          click(BTN_RIGHT);
          if (navigator.vibrate) navigator.vibrate(10);
        }, LONG_PRESS_MS);
      }
    }

    gesture.maxFingers = Math.max(gesture.maxFingers, e.touches.length);
    if (e.touches.length > 1) {
      cancelLongPress();
      gesture.multiLast = centroid(e.touches);
    }
    state.lastTouchAt = Date.now();
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onTouchMove(e) {
    if (!gesture) return;
    var video = getVideo();
    e.preventDefault();
    e.stopImmediatePropagation();
    state.lastTouchAt = Date.now();
    if (!video) return;

    if (e.touches.length === 1 && gesture.maxFingers === 1) {
      var t = e.touches[0];
      if (!gesture.moved) {
        if (Math.hypot(t.clientX - gesture.startX, t.clientY - gesture.startY) <= TAP_SLOP_PX) return;
        gesture.moved = true;
        cancelLongPress();
        if (gesture.consumed) return;
        // Direct mode: dragging a finger drags with the left button, like a touchscreen.
        if (state.mode === "direct" && !gesture.held) {
          gesture.held = true;
          press(BTN_LEFT);
        }
      }
      if (gesture.consumed) return;

      var now = Date.now();
      if (state.mode === "direct") {
        setCursorFromClient(video, t.clientX, t.clientY);
      } else {
        var dx = t.clientX - gesture.lastX;
        var dy = t.clientY - gesture.lastY;
        var dt = Math.max(1, now - gesture.lastAt);
        var v = Math.hypot(dx, dy) / dt; // px per ms
        var accel = Math.min(2.5, 0.5 + v * 1.2);
        var factor = SPEEDS[state.speedIndex] * accel;
        // At 1x, sliding a finger across the picture's width moves the
        // cursor across the remote screen (more when moving fast).
        var c = contentRect(video);
        state.nx = clamp01(state.nx + (dx * factor) / Math.max(1, c.width));
        state.ny = clamp01(state.ny + (dy * factor) / Math.max(1, c.height));
      }
      gesture.lastX = t.clientX;
      gesture.lastY = t.clientY;
      gesture.lastAt = now;
      sendMove();
      return;
    }

    if (e.touches.length >= 2) {
      var m = centroid(e.touches);
      var last = gesture.multiLast || m;
      var mdx = m.x - last.x;
      var mdy = m.y - last.y;
      gesture.multiLast = m;
      if (!gesture.moved && Math.hypot(m.x - gesture.startX, m.y - gesture.startY) > TAP_SLOP_PX * 2) {
        gesture.moved = true;
      }
      if (!gesture.moved) return;
      // Natural scrolling: fingers up = page content moves up = scroll down.
      var sign = state.invertScroll ? 1 : -1;
      gesture.scrollY += mdy;
      gesture.scrollX += mdx;
      while (Math.abs(gesture.scrollY) >= SCROLL_STEP_PX) {
        var stepY = gesture.scrollY > 0 ? 1 : -1;
        wheel(sign * stepY, 0);
        gesture.scrollY -= stepY * SCROLL_STEP_PX;
      }
      while (Math.abs(gesture.scrollX) >= SCROLL_STEP_PX) {
        var stepX = gesture.scrollX > 0 ? 1 : -1;
        wheel(0, sign * stepX);
        gesture.scrollX -= stepX * SCROLL_STEP_PX;
      }
    }
  }

  function onTouchEnd(e) {
    if (!gesture) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    state.lastTouchAt = Date.now();
    if (e.touches.length > 0) {
      if (e.touches.length > 1) gesture.multiLast = centroid(e.touches);
      return;
    }

    var g = gesture;
    gesture = null;
    if (g.longPressTimer) clearTimeout(g.longPressTimer);
    var now = Date.now();
    var duration = now - g.startAt;

    if (e.type === "touchcancel") {
      releaseAll();
      return;
    }

    if (g.held) {
      release(BTN_LEFT);
      state.lastTapAt = 0;
      return;
    }
    if (g.consumed) return;

    if (g.maxFingers === 1 && !g.moved) {
      click(BTN_LEFT);
      state.lastTapAt = now;
      state.lastTapX = g.startX;
      state.lastTapY = g.startY;
      return;
    }
    if (g.maxFingers === 2 && !g.moved && duration < TAP_MAX_MS * 2) {
      click(BTN_RIGHT);
      return;
    }
    if (g.maxFingers >= 3 && !g.moved && duration < TAP_MAX_MS * 2) {
      click(BTN_MIDDLE);
    }
  }

  // Block the touch-generated pointer and mouse events the browser also fires,
  // so the UI does not see a second, conflicting copy of each touch.
  function blockTouchPointer(e) {
    if (!e.isTrusted) return;
    var video = getVideo();
    if (!video || e.target !== video) return;
    if (e.pointerType === "touch") {
      e.stopImmediatePropagation();
    }
  }

  function blockCompatMouse(e) {
    if (!e.isTrusted) return;
    var video = getVideo();
    if (!video || e.target !== video) return;
    if (gesture || Date.now() - state.lastTouchAt < COMPAT_MOUSE_BLOCK_MS) {
      e.stopImmediatePropagation();
      if (e.cancelable) e.preventDefault();
    }
  }

  var capture = { capture: true, passive: false };
  window.addEventListener("touchstart", onTouchStart, capture);
  window.addEventListener("touchmove", onTouchMove, capture);
  window.addEventListener("touchend", onTouchEnd, capture);
  window.addEventListener("touchcancel", onTouchEnd, capture);
  ["pointerdown", "pointermove", "pointerup", "pointercancel"].forEach(function (t) {
    window.addEventListener(t, blockTouchPointer, capture);
  });
  ["mousedown", "mousemove", "mouseup", "click", "dblclick", "contextmenu"].forEach(function (t) {
    window.addEventListener(t, blockCompatMouse, capture);
  });

  // Release held buttons if the page is hidden mid-gesture.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      gesture = null;
      releaseAll();
    }
  });

  // ---- Styles, cursor dot and toolbar -----------------------------------
  var isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;

  var style = document.createElement("style");
  style.textContent =
    "video{touch-action:none!important;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}" +
    "#jkt-cursor{position:fixed;left:0;top:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;box-sizing:border-box;" +
    "background:transparent;border:1.5px solid rgba(255,255,255,.9);box-shadow:0 0 0 1px rgba(0,0,0,.6);" +
    "pointer-events:none;z-index:2147483646;display:none;opacity:0;transition:opacity .3s}" +
    "#jkt-bar{position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom));z-index:2147483647;display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end;max-width:calc(100vw - 20px);" +
    "align-items:center;font:600 13px/1 -apple-system,system-ui,sans-serif;touch-action:manipulation;-webkit-user-select:none;user-select:none}" +
    "#jkt-bar button{appearance:none;border:0;border-radius:999px;padding:9px 11px;white-space:nowrap;background:rgba(17,24,39,.82);color:#fff;" +
    "font:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}" +
    "#jkt-bar button.jkt-on{background:rgba(37,99,235,.92)}" +
    "#jkt-bar .jkt-warn{background:rgba(185,28,28,.92);color:#fff;border-radius:8px;padding:8px 10px;max-width:220px;line-height:1.3}";
  (document.head || document.documentElement).appendChild(style);

  var cursorEl = null;
  var bar = null;

  function drawCursor() {
    if (!cursorEl) return;
    var video = getVideo();
    var show = state.showMarker && state.mode === "trackpad" && isTouchDevice && video && video.videoWidth > 0;
    if (!show) {
      cursorEl.style.display = "none";
      return;
    }
    var p = cursorClient(video);
    if (!p.rect.width) {
      cursorEl.style.display = "none";
      return;
    }
    cursorEl.style.display = "block";
    cursorEl.style.transform = "translate(" + p.x + "px," + p.y + "px)";
    // A hollow ring that only shows while you move, then fades so the real
    // remote pointer in the video stays visible.
    cursorEl.style.opacity = Date.now() - state.lastMoveAt < CURSOR_SHOW_MS ? "1" : "0";
  }

  function mouseModeIsRelative() {
    try {
      var s = JSON.parse(window.localStorage.getItem("settings") || "{}");
      return s && s.state && s.state.mouseMode === "relative";
    } catch (e) {
      return false;
    }
  }

  function button(label, title, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      onClick();
      renderBar();
    });
    return b;
  }

  function renderBar() {
    if (!bar) return;
    bar.textContent = "";
    if (state.collapsed) {
      bar.appendChild(
        button("Touch", "Show touch controls", function () {
          state.collapsed = false;
          save("collapsed", false);
        }),
      );
      return;
    }
    if (mouseModeIsRelative()) {
      var w = document.createElement("div");
      w.className = "jkt-warn";
      w.textContent = "Touch control needs Mouse mode set to Absolute in JetKVM settings.";
      bar.appendChild(w);
    }
    var modeBtn = button(state.mode === "trackpad" ? "Trackpad" : "Direct", "Switch touch mode", function () {
      state.mode = state.mode === "trackpad" ? "direct" : "trackpad";
      save("mode", state.mode);
      drawCursor();
    });
    modeBtn.className = "jkt-on";
    bar.appendChild(modeBtn);
    if (state.mode === "trackpad") {
      bar.appendChild(
        button(SPEEDS[state.speedIndex] + "x", "Trackpad speed", function () {
          state.speedIndex = (state.speedIndex + 1) % SPEEDS.length;
          save("speedIndex", state.speedIndex);
        }),
      );
    }
    if (state.mode === "trackpad") {
      bar.appendChild(
        button(state.showMarker ? "Ring on" : "Ring off", "Show or hide the cursor ring", function () {
          state.showMarker = !state.showMarker;
          save("showMarker", state.showMarker);
          drawCursor();
        }),
      );
    }
    var inv = button(state.invertScroll ? "Reverse scroll" : "Natural scroll", "Flip scroll direction", function () {
      state.invertScroll = !state.invertScroll;
      save("invertScroll", state.invertScroll);
    });
    bar.appendChild(inv);
    bar.appendChild(
      button("×", "Hide touch controls", function () {
        state.collapsed = true;
        save("collapsed", true);
      }),
    );
  }

  function mount() {
    if (!document.body) return;
    if (!cursorEl) {
      cursorEl = document.createElement("div");
      cursorEl.id = "jkt-cursor";
      document.body.appendChild(cursorEl);
    }
    if (!bar && isTouchDevice) {
      bar = document.createElement("div");
      bar.id = "jkt-bar";
      document.body.appendChild(bar);
      renderBar();
    }
    // Keep the toolbar above the app and only show it on the remote-control screen.
    if (bar) {
      if (!bar.isConnected) document.body.appendChild(bar);
      bar.style.display = getVideo() ? "flex" : "none";
    }
    if (cursorEl && !cursorEl.isConnected) document.body.appendChild(cursorEl);
    drawCursor();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
  setInterval(mount, 500);
  window.addEventListener("resize", drawCursor);
  window.addEventListener("orientationchange", drawCursor);

  // Exposed for debugging from the browser console.
  window.__jetkvmTouchState = state;
})();
