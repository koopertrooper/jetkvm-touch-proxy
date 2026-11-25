// JetKVM touch layer, added to the JetKVM page by the touch proxy.
//
// The JetKVM UI only reacts to desktop mouse and keyboard events. This script
// catches finger gestures on its <video> element before the UI sees them and
// replays them as the events the UI already handles (mousemove,
// pointerdown/pointerup with a buttons mask, wheel, keydown/keyup).
// A real mouse, trackpad or keyboard on a computer is left alone.
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
  var PINCH_START_RATIO = 0.12; // finger spread change that starts a pinch
  var MAX_ZOOM = 5;
  var EDGE_MARGIN_PX = 30; // keep the cursor this far inside the visible area
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
    showMarker: load("showMarker", true),
    bars: load("bars", "auto"), // JetKVM's own top and bottom bars: "auto" | "shown" | "hidden"
    nx: 0.5, // cursor position, 0..1 across the remote screen
    ny: 0.5,
    buttons: 0,
    lastTouchAt: 0,
    lastMoveAt: 0,
    fadeTimer: null,
    lastTapAt: 0,
    lastTapX: 0,
    lastTapY: 0,
    // Local zoom of the video: translate(tx, ty) scale(zoom), origin top-left.
    zoom: 1,
    tx: 0,
    ty: 0,
    keyboardOpen: false,
    sticky: { ControlLeft: false, AltLeft: false, MetaLeft: false, ShiftLeft: false },
  };
  if (SPEEDS[state.speedIndex] === undefined) state.speedIndex = 1;

  var gesture = null;
  var isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;

  // ---- Geometry ---------------------------------------------------------
  function getVideo() {
    return document.querySelector("video");
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }
  function clamp01(v) {
    return clamp(v, 0, 1);
  }

  // The picture inside a box of the given size (object-fit: contain adds bars).
  function containBox(w, h, vw, vh) {
    var box = { x: 0, y: 0, w: w, h: h };
    if (vw && vh && w && h) {
      var elAspect = w / h;
      var vidAspect = vw / vh;
      if (elAspect > vidAspect) {
        box.w = h * vidAspect;
        box.x = (w - box.w) / 2;
      } else if (elAspect < vidAspect) {
        box.h = w / vidAspect;
        box.y = (h - box.h) / 2;
      }
    }
    return box;
  }

  // The picture on screen, in client coordinates (includes the zoom).
  function contentRect(video) {
    var r = video.getBoundingClientRect();
    var b = containBox(r.width, r.height, video.videoWidth, video.videoHeight);
    return { left: r.left + b.x, top: r.top + b.y, width: b.w, height: b.h };
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
  function withOffsets(ev, video) {
    // The UI reads offsetX/offsetY in the video's own (unzoomed) layout
    // coordinates. Set them from the cursor position so zoom never shifts clicks.
    var b = containBox(video.clientWidth, video.clientHeight, video.videoWidth, video.videoHeight);
    try {
      Object.defineProperty(ev, "offsetX", { value: b.x + state.nx * b.w });
      Object.defineProperty(ev, "offsetY", { value: b.y + state.ny * b.h });
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
    video.dispatchEvent(withOffsets(ev, video));
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
    video.dispatchEvent(withOffsets(makePointerEvent("pointerdown", p.x, p.y, state.buttons, buttonIndex(mask)), video));
  }

  function release(mask) {
    var video = getVideo();
    if (!video) return;
    state.buttons &= ~mask;
    var p = cursorClient(video);
    video.dispatchEvent(withOffsets(makePointerEvent("pointerup", p.x, p.y, state.buttons, buttonIndex(mask)), video));
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
    video.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: p.x,
        clientY: p.y,
        deltaX: dx,
        deltaY: dy,
        deltaMode: 0,
      }),
    );
  }

  // ---- Zoom and pan -----------------------------------------------------
  // The video's parent is scaled, so the picture and JetKVM's own overlays
  // zoom together. Its parent clips the overflow.
  var zoomEl = null;

  function getZoomEl() {
    var video = getVideo();
    var el = video ? video.parentElement : null;
    if (el !== zoomEl) {
      if (zoomEl) zoomEl.style.transform = "";
      zoomEl = el;
      if (zoomEl) {
        zoomEl.style.transformOrigin = "0 0";
        zoomEl.style.willChange = "transform";
      }
      applyZoom();
    }
    return zoomEl;
  }

  // Bottom of what you can see, in client coordinates (above the iOS
  // keyboard and our key bar).
  function visibleBottom() {
    var vv = window.visualViewport;
    var b = vv ? vv.offsetTop + vv.height : window.innerHeight;
    if (state.keyboardOpen && keyBar) b -= keyBar.offsetHeight;
    return b;
  }

  function clampPan() {
    var el = zoomEl;
    if (!el) return;
    var w = el.offsetWidth;
    var h = el.offsetHeight;
    var r = el.getBoundingClientRect();
    var originY = r.top - state.ty;
    // When the keyboard covers the bottom of the picture, allow panning it up into view.
    var covered = Math.max(0, originY + h - visibleBottom());
    state.tx = clamp(state.tx, w - state.zoom * w, 0);
    state.ty = clamp(state.ty, h - state.zoom * h - covered, 0);
  }

  function applyZoom() {
    if (!zoomEl) return;
    clampPan();
    if (state.zoom === 1 && state.tx === 0 && state.ty === 0) {
      zoomEl.style.transform = "";
    } else {
      zoomEl.style.transform =
        "translate(" + state.tx + "px," + state.ty + "px) scale(" + state.zoom + ")";
    }
    drawCursor();
  }

  function resetZoom() {
    state.zoom = 1;
    state.tx = 0;
    state.ty = 0;
    applyZoom();
    ensureCursorVisible();
  }

  // Pan so the cursor stays inside the visible part of the picture.
  function ensureCursorVisible() {
    var video = getVideo();
    var el = getZoomEl();
    if (!video || !el || !el.parentElement) return;
    var clip = el.parentElement.getBoundingClientRect();
    var top = Math.max(clip.top, window.visualViewport ? window.visualViewport.offsetTop : 0);
    var bottom = Math.min(clip.bottom, visibleBottom());
    var p = cursorClient(video);
    var m = EDGE_MARGIN_PX;
    if (p.x < clip.left + m) state.tx += clip.left + m - p.x;
    if (p.x > clip.right - m) state.tx -= p.x - (clip.right - m);
    if (p.y < top + m) state.ty += top + m - p.y;
    if (p.y > bottom - m) state.ty -= p.y - (bottom - m);
    applyZoom();
  }

  function pinchStart(touches) {
    var el = getZoomEl();
    if (!el) return null;
    var a = touches[0];
    var b = touches[1];
    var c = centroid(touches);
    var r = el.getBoundingClientRect();
    return {
      dist: Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)),
      zoom: state.zoom,
      // The point of the unzoomed picture that sits under the fingers.
      localX: (c.x - r.left) / state.zoom,
      localY: (c.y - r.top) / state.zoom,
      originX: r.left - state.tx,
      originY: r.top - state.ty,
    };
  }

  function pinchMove(p, touches) {
    var a = touches[0];
    var b = touches[1];
    var c = centroid(touches);
    var dist = Math.max(1, Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY));
    state.zoom = clamp((p.zoom * dist) / p.dist, 1, MAX_ZOOM);
    // Keep the same picture point under the fingers while zooming and moving.
    state.tx = c.x - p.originX - state.zoom * p.localX;
    state.ty = c.y - p.originY - state.zoom * p.localY;
    applyZoom();
  }

  // ---- JetKVM's own bars ------------------------------------------------
  // On a phone in landscape, JetKVM's header, action bar and status bar take
  // a third of the height. Hide them so the remote screen gets the room.
  var hiddenBars = [];

  function barsShouldHide() {
    if (state.bars === "hidden") return true;
    if (state.bars === "shown") return false;
    return isTouchDevice && window.innerWidth > window.innerHeight && window.innerHeight < 600;
  }

  // Grid ancestors of the video: the one with [action bar, video, status bar]
  // and the one with [header, body].
  function findBars(video) {
    var found = [];
    var n = video.parentElement;
    var depth = 0;
    while (n && n !== document.body && depth < 20 && found.length < 2) {
      var parent = n.parentElement;
      if (parent && getComputedStyle(parent).display === "grid") {
        var kids = Array.prototype.slice.call(parent.children);
        var idx = kids.indexOf(n);
        if (kids.length === 3 && idx === 1) found.push({ grid: parent, bars: [kids[0], kids[2]] });
        else if (kids.length === 2 && idx === 1 && found.length === 1) found.push({ grid: parent, bars: [kids[0]] });
      }
      n = parent;
      depth++;
    }
    return found;
  }

  function restoreBars() {
    hiddenBars.forEach(function (h) {
      if (h.rows !== undefined) h.el.style.gridTemplateRows = h.rows;
      else h.el.style.display = h.display;
    });
    hiddenBars = [];
  }

  function applyBars() {
    var video = getVideo();
    var hide = video && barsShouldHide();
    if (!hide) {
      if (hiddenBars.length) {
        restoreBars();
        setTimeout(onViewportChange, 50);
      }
      return;
    }
    var changed = false;
    findBars(video).forEach(function (g) {
      g.bars.forEach(function (b) {
        if (b.style.display === "none") return;
        hiddenBars.push({ el: b, display: b.style.display });
        b.style.display = "none";
        changed = true;
      });
      if (g.grid.style.gridTemplateRows !== "minmax(0px, 1fr)") {
        hiddenBars.push({ el: g.grid, display: g.grid.style.display, rows: g.grid.style.gridTemplateRows });
        g.grid.style.gridTemplateRows = "minmax(0px, 1fr)";
        changed = true;
      }
    });
    if (changed) setTimeout(onViewportChange, 50);
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
        multi: null, // "scroll" | "pinch" once a two-finger gesture is recognised
        multiStart: null,
        pinch: null,
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
      if (e.touches.length === 2 && !gesture.multi) {
        gesture.multiStart = gesture.multiLast;
        gesture.pinch = pinchStart(e.touches);
      }
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
        // cursor across the remote screen. Zooming in gives finer control.
        var c = contentRect(video);
        state.nx = clamp01(state.nx + (dx * factor) / Math.max(1, c.width));
        state.ny = clamp01(state.ny + (dy * factor) / Math.max(1, c.height));
      }
      gesture.lastX = t.clientX;
      gesture.lastY = t.clientY;
      gesture.lastAt = now;
      sendMove();
      if (state.mode === "trackpad") ensureCursorVisible();
      return;
    }

    if (e.touches.length >= 2) {
      var m = centroid(e.touches);
      var last = gesture.multiLast || m;
      var mdx = m.x - last.x;
      var mdy = m.y - last.y;
      gesture.multiLast = m;

      // Decide once per gesture: fingers spreading/closing = zoom, moving together = scroll.
      if (!gesture.multi && gesture.pinch && e.touches.length === 2) {
        var a = e.touches[0];
        var b = e.touches[1];
        var d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        var start = gesture.multiStart || m;
        if (Math.abs(d / gesture.pinch.dist - 1) > PINCH_START_RATIO) {
          gesture.multi = "pinch";
          gesture.pinch = pinchStart(e.touches);
        } else if (Math.hypot(m.x - start.x, m.y - start.y) > TAP_SLOP_PX * 2) {
          gesture.multi = "scroll";
        }
      }
      if (!gesture.multi) return;
      gesture.moved = true;

      if (gesture.multi === "pinch") {
        if (e.touches.length === 2) pinchMove(gesture.pinch, e.touches);
        return;
      }

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
      gesture.multiLast = centroid(e.touches);
      // Lifting one finger of a pinch ends the zoom part of the gesture.
      if (gesture.multi === "pinch" && e.touches.length < 2) gesture.pinch = null;
      return;
    }

    var g = gesture;
    gesture = null;
    if (g.longPressTimer) clearTimeout(g.longPressTimer);
    var now = Date.now();
    var duration = now - g.startAt;

    if (g.multi === "pinch" && state.zoom < 1.05) resetZoom();

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
    if (e.pointerType === "touch") e.stopImmediatePropagation();
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

  // ---- Keyboard ---------------------------------------------------------
  // The phone keyboard types into a hidden text field. Each character is
  // replayed as US-layout key presses, which the JetKVM page sends on as a
  // USB keyboard (the same as a physical keyboard on a computer would).
  var US_KEYS = {
    " ": ["Space", false],
    "\n": ["Enter", false],
    "\t": ["Tab", false],
    "`": ["Backquote", false],
    "~": ["Backquote", true],
    "-": ["Minus", false],
    _: ["Minus", true],
    "=": ["Equal", false],
    "+": ["Equal", true],
    "[": ["BracketLeft", false],
    "{": ["BracketLeft", true],
    "]": ["BracketRight", false],
    "}": ["BracketRight", true],
    "\\": ["Backslash", false],
    "|": ["Backslash", true],
    ";": ["Semicolon", false],
    ":": ["Semicolon", true],
    "'": ["Quote", false],
    '"': ["Quote", true],
    ",": ["Comma", false],
    "<": ["Comma", true],
    ".": ["Period", false],
    ">": ["Period", true],
    "/": ["Slash", false],
    "?": ["Slash", true],
  };
  var SHIFTED_DIGITS = ")!@#$%^&*(";
  // iOS "smart punctuation" swaps in typographic characters; send the plain ones.
  var SMART = { "‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "...", " ": " " };

  function keyFor(ch) {
    if (/^[a-z]$/.test(ch)) return ["Key" + ch.toUpperCase(), false];
    if (/^[A-Z]$/.test(ch)) return ["Key" + ch, true];
    if (/^[0-9]$/.test(ch)) return ["Digit" + ch, false];
    var i = SHIFTED_DIGITS.indexOf(ch);
    if (i >= 0) return ["Digit" + i, true];
    return US_KEYS[ch] || null;
  }

  var MOD_KEYS = { ControlLeft: "Control", AltLeft: "Alt", MetaLeft: "Meta", ShiftLeft: "Shift" };

  function keyEvent(type, code, key) {
    document.dispatchEvent(
      new KeyboardEvent(type, { code: code, key: key, bubbles: true, cancelable: true, composed: true }),
    );
  }

  // Press a key with the sticky modifiers (and Shift if needed) held around it.
  function tapKey(code, key, shift) {
    var mods = [];
    Object.keys(state.sticky).forEach(function (m) {
      if (state.sticky[m]) mods.push(m);
    });
    if (shift && mods.indexOf("ShiftLeft") < 0) mods.push("ShiftLeft");
    mods.forEach(function (m) {
      keyEvent("keydown", m, MOD_KEYS[m]);
    });
    keyEvent("keydown", code, key);
    keyEvent("keyup", code, key);
    mods.reverse().forEach(function (m) {
      keyEvent("keyup", m, MOD_KEYS[m]);
    });
    clearStickyModifiers();
  }

  function typeText(text) {
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var plain = SMART[ch];
      if (plain) {
        typeText(plain);
        continue;
      }
      if (ch === "\r") continue;
      var k = keyFor(ch);
      if (k) tapKey(k[0], ch, k[1]);
    }
  }

  function clearStickyModifiers() {
    var changed = false;
    Object.keys(state.sticky).forEach(function (m) {
      if (state.sticky[m]) changed = true;
      state.sticky[m] = false;
    });
    if (changed) renderKeyBar();
  }

  var input = null;
  var SENTINEL = "  "; // keeps the field non-empty so Backspace always fires

  function resetInput() {
    if (!input) return;
    input.value = SENTINEL;
    try {
      input.setSelectionRange(SENTINEL.length, SENTINEL.length);
    } catch (e) {
      /* ignore */
    }
  }

  function createInput() {
    input = document.createElement("textarea");
    input.id = "jkt-input";
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("enterkeyhint", "enter");
    input.setAttribute("aria-label", "Remote keyboard input");
    resetInput();

    // The JetKVM page keeps a focus trap on its video area that pulls focus
    // back as soon as anything else gets it, which closed the keyboard at
    // once. Window capture listeners run before the trap's document
    // listeners, so stop the field's focus and key events there. This also
    // keeps its key events away from the page, which would cancel them
    // before the text arrives.
    window.addEventListener(
      "focusin",
      function (e) {
        if (e.target === input) e.stopImmediatePropagation();
      },
      true,
    );
    ["keydown", "keyup", "keypress"].forEach(function (t) {
      window.addEventListener(
        t,
        function (e) {
          if (e.target !== input) return;
          e.stopImmediatePropagation();
          // Hardware keyboards and some iOS keys arrive only as keydown.
          if (t === "keydown" && e.isTrusted) {
            var special = { Tab: 1, Escape: 1, ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1 };
            if (special[e.key]) {
              e.preventDefault();
              tapKey(e.key, e.key, false);
            }
          }
        },
        true,
      );
    });

    input.addEventListener("beforeinput", function (e) {
      var type = e.inputType || "";
      if (type === "insertCompositionText") return; // handled on compositionend
      e.preventDefault();
      if (type === "insertText" || type === "insertReplacementText" || type === "insertFromPaste") {
        var text = e.data;
        if (text == null && e.dataTransfer) text = e.dataTransfer.getData("text/plain");
        if (type === "insertReplacementText") {
          // Autocorrect replacing a word: the field is always empty, so just type it.
        }
        if (text) typeText(text);
      } else if (type === "insertLineBreak" || type === "insertParagraph") {
        tapKey("Enter", "Enter", false);
      } else if (type.indexOf("deleteContentBackward") === 0 || type.indexOf("deleteWordBackward") === 0) {
        tapKey("Backspace", "Backspace", false);
      } else if (type.indexOf("deleteContentForward") === 0 || type.indexOf("deleteWordForward") === 0) {
        tapKey("Delete", "Delete", false);
      }
      resetInput();
    });
    input.addEventListener("compositionend", function (e) {
      if (e.data) typeText(e.data);
      setTimeout(resetInput, 0);
    });
    // Fallback for browsers without beforeinput: diff against the sentinel.
    input.addEventListener("input", function () {
      var v = input.value;
      if (v === SENTINEL) return;
      if (v.length < SENTINEL.length) tapKey("Backspace", "Backspace", false);
      else if (v.indexOf(SENTINEL) === 0) typeText(v.slice(SENTINEL.length));
      resetInput();
    });
    input.addEventListener("focus", function () {
      if (sheet && sheet.style.display !== "none") closeSheet();
      parkInput();
      state.keyboardOpen = true;
      renderKeyBar();
      setTimeout(onViewportChange, 300);
    });
    input.addEventListener("blur", function () {
      state.keyboardOpen = false;
      clearStickyModifiers();
      renderKeyBar();
      setTimeout(onViewportChange, 300);
    });
    document.body.appendChild(input);
  }

  function parkInput() {
    if (!input) return;
    input.style.left = "0px";
    input.style.top = "0px";
    input.style.width = "1px";
    input.style.height = "1px";
    input.style.pointerEvents = "none";
  }

  function overlayInputOn(target) {
    if (!input || !target) return;
    var r = target.getBoundingClientRect();
    input.style.left = r.left + "px";
    input.style.top = r.top + "px";
    input.style.width = r.width + "px";
    input.style.height = r.height + "px";
    input.style.pointerEvents = "auto";
  }

  // Fallback for browsers that allow opening the keyboard from script.
  function showKeyboard() {
    if (!input) return;
    resetInput();
    input.focus({ preventScroll: true });
  }
  function hideKeyboard() {
    if (input) input.blur();
  }

  // ---- Styles -----------------------------------------------------------
  var style = document.createElement("style");
  style.textContent = [
    "video{touch-action:none!important;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}",
    "#jkt-cursor{position:fixed;left:0;top:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;box-sizing:border-box;",
    "background:transparent;border:1.5px solid rgba(255,255,255,.9);box-shadow:0 0 0 1px rgba(0,0,0,.6);",
    "pointer-events:none;z-index:2147483644;display:none;opacity:0;transition:opacity .3s}",
    // Hidden text field: 16px font stops iOS from zooming the page when it gets focus.
    // iOS only opens its keyboard reliably when the user taps a text field
    // directly, so while the menu is open the field sits over "Show keyboard".
    "#jkt-input{position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;font-size:16px;border:0;padding:0;margin:0;",
    "resize:none;background:transparent;color:transparent;caret-color:transparent;z-index:2147483647;pointer-events:none;",
    "-webkit-user-select:text;user-select:text;outline:none;-webkit-tap-highlight-color:transparent}",
    // The button, menu and key bar are placed by script inside the visible
    // area (window.visualViewport), which differs from the page size on iOS.
    "#jkt-fab{position:fixed;left:0;top:0;width:48px;height:48px;border-radius:50%;",
    "border:0;background:#2563eb;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.35);z-index:2147483645;display:none;",
    "align-items:center;justify-content:center;touch-action:manipulation;-webkit-tap-highlight-color:transparent;cursor:pointer;padding:0}",
    "#jkt-fab svg{width:24px;height:24px}",
    "#jkt-sheet{position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483646;display:none;background:rgba(0,0,0,.35);",
    "font:400 19px/1.2 -apple-system,system-ui,sans-serif;touch-action:manipulation;-webkit-user-select:none;user-select:none}",
    "#jkt-sheet .jkt-panel{position:absolute;left:8px;right:8px;bottom:8px;max-width:480px;margin:0 auto;",
    "max-height:calc(100% - 16px);overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}",
    "#jkt-sheet.jkt-compact{font-size:16px}",
    "#jkt-sheet.jkt-compact button{padding:10px 12px}",
    "#jkt-sheet.jkt-compact .jkt-group{margin-top:6px}",
    "#jkt-sheet .jkt-group{background:rgba(44,44,46,.96);border-radius:14px;overflow:hidden;margin-top:8px}",
    "#jkt-sheet button{display:block;width:100%;border:0;background:transparent;color:#3b82f6;font:inherit;padding:16px 12px;",
    "text-align:center;-webkit-tap-highlight-color:transparent;cursor:pointer}",
    "#jkt-sheet button+button{border-top:1px solid rgba(255,255,255,.12)}",
    "#jkt-sheet button .jkt-val{color:rgba(255,255,255,.55)}",
    "#jkt-sheet .jkt-cancel{font-weight:600}",
    "#jkt-sheet .jkt-warn{color:#fca5a5;font-size:14px;padding:12px;text-align:center;line-height:1.35}",
    // One row of keys that always fits the width; a "more" key flips pages.
    "#jkt-keys{position:fixed;left:0;top:0;width:100%;box-sizing:border-box;z-index:2147483645;display:none;gap:4px;padding:5px 4px;",
    "background:rgba(28,28,30,.97);font:500 14px/1 -apple-system,system-ui,sans-serif;touch-action:none;",
    "-webkit-user-select:none;user-select:none}",
    "#jkt-keys button{flex:1 1 0;min-width:0;height:38px;border:0;border-radius:6px;background:#48484a;color:#fff;font:inherit;",
    "padding:0 1px;white-space:nowrap;overflow:hidden;-webkit-tap-highlight-color:transparent;cursor:pointer}",
    "#jkt-keys button.jkt-aux{background:#2c2c2e}",
    "#jkt-keys button.jkt-on{background:#2563eb}",
  ].join("");
  (document.head || document.documentElement).appendChild(style);

  // ---- Cursor ring --------------------------------------------------------
  var cursorEl = null;

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

  // ---- Menu button and action sheet --------------------------------------
  var fab = null;
  var sheet = null;
  var keyBar = null;

  function mouseModeIsRelative() {
    try {
      var s = JSON.parse(window.localStorage.getItem("settings") || "{}");
      return s && s.state && s.state.mouseMode === "relative";
    } catch (e) {
      return false;
    }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function sheetButton(label, value, onTap, cls) {
    var b = el("button", cls || "");
    b.type = "button";
    b.appendChild(document.createTextNode(label));
    if (value) {
      b.appendChild(document.createTextNode(": "));
      b.appendChild(el("span", "jkt-val", value));
    }
    b.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      onTap();
    });
    return b;
  }

  var showKeyboardBtn = null;

  function closeSheet() {
    if (sheet) sheet.style.display = "none";
    if (!state.keyboardOpen) parkInput();
  }

  function openSheet() {
    sheet.style.display = "block";
    layoutOverlays();
    renderSheet();
  }

  function renderSheet() {
    sheet.textContent = "";
    var panel = el("div", "jkt-panel");
    var g1 = el("div", "jkt-group");
    if (mouseModeIsRelative()) {
      g1.appendChild(el("div", "jkt-warn", "Touch control needs Mouse mode set to Absolute in the JetKVM settings."));
    }
    showKeyboardBtn = sheetButton(state.keyboardOpen ? "Hide keyboard" : "Show keyboard", null, function () {
      closeSheet();
      if (state.keyboardOpen) hideKeyboard();
      else showKeyboard();
    });
    g1.appendChild(showKeyboardBtn);
    g1.appendChild(
      sheetButton("Touch mode", state.mode === "trackpad" ? "Trackpad" : "Direct", function () {
        state.mode = state.mode === "trackpad" ? "direct" : "trackpad";
        save("mode", state.mode);
        drawCursor();
        renderSheet();
      }),
    );
    if (state.mode === "trackpad") {
      g1.appendChild(
        sheetButton("Trackpad speed", SPEEDS[state.speedIndex] + "x", function () {
          state.speedIndex = (state.speedIndex + 1) % SPEEDS.length;
          save("speedIndex", state.speedIndex);
          renderSheet();
        }),
      );
      g1.appendChild(
        sheetButton("Cursor ring", state.showMarker ? "On" : "Off", function () {
          state.showMarker = !state.showMarker;
          save("showMarker", state.showMarker);
          drawCursor();
          renderSheet();
        }),
      );
    }
    g1.appendChild(
      sheetButton("Scrolling", state.invertScroll ? "Reversed" : "Natural", function () {
        state.invertScroll = !state.invertScroll;
        save("invertScroll", state.invertScroll);
        renderSheet();
      }),
    );
    var BAR_LABELS = { auto: "Hide in landscape", hidden: "Always hide", shown: "Always show" };
    var BAR_NEXT = { auto: "hidden", hidden: "shown", shown: "auto" };
    g1.appendChild(
      sheetButton("JetKVM toolbars", BAR_LABELS[state.bars] || BAR_LABELS.auto, function () {
        state.bars = BAR_NEXT[state.bars] || "hidden";
        save("bars", state.bars);
        applyBars();
        renderSheet();
      }),
    );
    if (state.zoom > 1 || state.tx || state.ty) {
      g1.appendChild(
        sheetButton("Reset zoom", null, function () {
          closeSheet();
          resetZoom();
        }),
      );
    }
    var g2 = el("div", "jkt-group");
    g2.appendChild(sheetButton("Cancel", null, closeSheet, "jkt-cancel"));
    panel.appendChild(g1);
    panel.appendChild(g2);
    sheet.appendChild(panel);
    panel.addEventListener("scroll", function () {
      if (!state.keyboardOpen) overlayInputOn(showKeyboardBtn);
    });
    // Put the hidden text field right over "Show keyboard", so the tap itself
    // focuses it and iOS opens the keyboard.
    if (!state.keyboardOpen && sheet.style.display !== "none") overlayInputOn(showKeyboardBtn);
    else parkInput();
  }

  // Keys the iPhone keyboard lacks, shown just above it while it is open.
  // Each page fits one row on the narrowest iPhones; "•••" flips pages and
  // "⌄" closes the keyboard.
  var KEY_PAGES = [
    [
      { label: "Esc", code: "Escape" },
      { label: "Tab", code: "Tab" },
      { label: "Ctrl", mod: "ControlLeft" },
      { label: "Alt", mod: "AltLeft" },
      { label: "\u2190", code: "ArrowLeft" },
      { label: "\u2191", code: "ArrowUp" },
      { label: "\u2193", code: "ArrowDown" },
      { label: "\u2192", code: "ArrowRight" },
    ],
    [
      { label: "Win", mod: "MetaLeft" },
      { label: "Shift", mod: "ShiftLeft" },
      { label: "Del", code: "Delete" },
      { label: "Home", code: "Home" },
      { label: "End", code: "End" },
      { label: "PgUp", code: "PageUp" },
      { label: "PgDn", code: "PageDown" },
      { label: "C-A-Del", combo: ["ControlLeft", "AltLeft", "Delete"] },
    ],
    [
      { label: "F1", code: "F1" },
      { label: "F2", code: "F2" },
      { label: "F3", code: "F3" },
      { label: "F4", code: "F4" },
      { label: "F5", code: "F5" },
      { label: "F6", code: "F6" },
    ],
    [
      { label: "F7", code: "F7" },
      { label: "F8", code: "F8" },
      { label: "F9", code: "F9" },
      { label: "F10", code: "F10" },
      { label: "F11", code: "F11" },
      { label: "F12", code: "F12" },
    ],
  ];
  var keyPage = 0;

  function renderKeyBar() {
    if (!keyBar) return;
    keyBar.style.display = state.keyboardOpen ? "flex" : "none";
    if (!state.keyboardOpen) return;
    keyBar.textContent = "";
    var keys = KEY_PAGES[keyPage].concat([
      { label: "\u2022\u2022\u2022", page: true, aux: true },
      { label: "\u2304", hide: true, aux: true },
    ]);
    keys.forEach(function (k) {
      var b = el("button", k.mod && state.sticky[k.mod] ? "jkt-on" : k.aux ? "jkt-aux" : "", k.label);
      if (k.page) b.setAttribute("aria-label", "More keys");
      if (k.hide) b.setAttribute("aria-label", "Hide keyboard");
      b.type = "button";
      // Act on touchend and cancel the default, so the tap never takes focus
      // from the text field (which would close the keyboard).
      var touchedAt = 0;
      b.addEventListener("touchstart", function (ev) {
        ev.preventDefault();
      }, { passive: false });
      b.addEventListener("touchend", function (ev) {
        ev.preventDefault();
        touchedAt = Date.now();
        act();
      }, { passive: false });
      b.addEventListener("mousedown", function (ev) {
        ev.preventDefault();
      });
      b.addEventListener("click", function (ev) {
        ev.preventDefault();
        if (Date.now() - touchedAt < 800) return;
        act();
      });
      function act() {
        if (k.hide) return hideKeyboard();
        if (k.page) {
          keyPage = (keyPage + 1) % KEY_PAGES.length;
          renderKeyBar();
          return;
        }
        if (k.mod) {
          state.sticky[k.mod] = !state.sticky[k.mod];
          renderKeyBar();
          return;
        }
        if (k.combo) {
          k.combo.forEach(function (c) {
            keyEvent("keydown", c, c);
          });
          k.combo.slice().reverse().forEach(function (c) {
            keyEvent("keyup", c, c);
          });
          return;
        }
        tapKey(k.code, k.code, false);
      }
      keyBar.appendChild(b);
    });
    positionKeyBar();
  }

  // The part of the page you can actually see. On iOS this can be smaller
  // than, and offset from, the page itself (browser bars, keyboard, zoom).
  function visibleRect() {
    var vv = window.visualViewport;
    if (vv) return { left: vv.offsetLeft, top: vv.offsetTop, width: vv.width, height: vv.height };
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }

  function layoutOverlays() {
    var v = visibleRect();
    var bottom = v.top + v.height;
    if (keyBar && state.keyboardOpen) {
      keyBar.style.left = v.left + "px";
      keyBar.style.width = v.width + "px";
      var h = keyBar.offsetHeight || 48;
      keyBar.style.top = bottom - h + "px";
      bottom -= h;
    }
    if (fab) {
      // Always sit above the key bar, inside the visible area.
      fab.style.left = v.left + v.width - 48 - 12 + "px";
      fab.style.top = bottom - 48 - 12 + "px";
    }
    if (sheet && sheet.style.display !== "none") {
      sheet.style.left = v.left + "px";
      sheet.style.top = v.top + "px";
      sheet.style.width = v.width + "px";
      sheet.style.height = v.height + "px";
      sheet.classList.toggle("jkt-compact", v.height < 560);
    }
  }

  function positionKeyBar() {
    layoutOverlays();
  }

  function onViewportChange() {
    layoutOverlays();
    if (sheet && sheet.style.display !== "none" && !state.keyboardOpen) overlayInputOn(showKeyboardBtn);
    if (zoomEl) applyZoom();
    if (state.keyboardOpen) ensureCursorVisible();
    drawCursor();
  }

  var MENU_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">' +
    '<path d="M5 7h14M5 12h14M5 17h14"/></svg>';

  function mount() {
    if (!document.body) return;
    if (!cursorEl) {
      cursorEl = el("div");
      cursorEl.id = "jkt-cursor";
      document.body.appendChild(cursorEl);
    }
    if (isTouchDevice && !fab) {
      fab = el("button");
      fab.id = "jkt-fab";
      fab.type = "button";
      fab.setAttribute("aria-label", "Touch menu");
      fab.innerHTML = MENU_ICON; // fixed markup, no user data
      fab.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        openSheet();
      });
      sheet = el("div");
      sheet.id = "jkt-sheet";
      sheet.addEventListener("click", function (ev) {
        if (ev.target === sheet) closeSheet();
      });
      keyBar = el("div");
      keyBar.id = "jkt-keys";
      createInput();
      document.body.appendChild(fab);
      document.body.appendChild(sheet);
      document.body.appendChild(keyBar);
    }
    // Keep our elements attached and only show the menu on the remote-control screen.
    [cursorEl, fab, sheet, keyBar, input].forEach(function (n) {
      if (n && !n.isConnected) document.body.appendChild(n);
    });
    var video = getVideo();
    if (fab) fab.style.display = video ? "flex" : "none";
    if (!video && state.keyboardOpen) hideKeyboard();
    applyBars();
    getZoomEl();
    layoutOverlays();
    drawCursor();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
  setInterval(mount, 500);
  window.addEventListener("resize", function () {
    applyBars();
    onViewportChange();
  });
  window.addEventListener("orientationchange", function () {
    setTimeout(onViewportChange, 300);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", onViewportChange);
    window.visualViewport.addEventListener("scroll", onViewportChange);
  }

  // Exposed for debugging from the browser console.
  window.__jetkvmTouchState = state;
})();
