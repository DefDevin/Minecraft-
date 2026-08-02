// Keyboard, mouse and pointer-lock input.
//
// Keys are tracked both as a held set and as per-frame pressed/released edges,
// so gameplay code can ask "is forward held" and "was jump pressed this frame"
// without wiring its own listeners.

export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sneak: ['ShiftLeft', 'ShiftRight'],
  sprint: ['ControlLeft', 'ControlRight'],
  inventory: ['KeyE'],
  drop: ['KeyQ'],
  chat: ['KeyT'],
  command: ['Slash'],
  perspective: ['F5'],
  debug: ['F3'],
  screenshot: ['F2'],
  fullscreen: ['F11'],
  pause: ['Escape'],
  pickBlock: ['KeyF'],
  hotbar1: ['Digit1'], hotbar2: ['Digit2'], hotbar3: ['Digit3'],
  hotbar4: ['Digit4'], hotbar5: ['Digit5'], hotbar6: ['Digit6'],
  hotbar7: ['Digit7'], hotbar8: ['Digit8'], hotbar9: ['Digit9'],
  swapHands: ['KeyF'],
  advancements: ['KeyL'],
  toggleFly: ['KeyG'],
};

export class Input {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.bindings = { ...DEFAULT_BINDINGS, ...(opts.bindings || {}) };
    this.keys = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.repeat = new Set();
    this.mouse = {
      x: 0, y: 0, dx: 0, dy: 0, wheel: 0,
      buttons: new Set(), pressed: new Set(), released: new Set(),
    };
    this.pointerLocked = false;
    this.sensitivity = opts.sensitivity ?? 0.0022;
    this.invertY = false;
    this.enabled = true;
    /** When a GUI screen is open, movement keys are suppressed but UI keys pass. */
    this.guiMode = false;
    this.textTarget = null;
    this.listeners = { lockChange: [], key: [], text: [] };

    this.doubleTapWindow = 300;
    this._lastForwardTap = 0;
    this.sprintLatched = false;

    this.bind();
  }

  bind() {
    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      // Let the browser keep its reload/devtools shortcuts.
      if (e.ctrlKey && ['KeyR', 'KeyW', 'KeyT'].includes(e.code)) return;
      if (e.code === 'F5' && e.ctrlKey) return;
      if (e.code === 'F11' || e.code === 'F12') return;

      if (this.textTarget) {
        this.listeners.text.forEach((f) => f(e));
        if (!['F3', 'F11'].includes(e.code)) e.preventDefault();
        return;
      }
      if (!e.repeat) {
        this.pressed.add(e.code);
        this.keys.add(e.code);
        if (this.isBound('forward', e.code)) this.checkDoubleTapSprint();
      } else {
        this.repeat.add(e.code);
      }
      this.listeners.key.forEach((f) => f(e, true));
      if (SWALLOWED.has(e.code)) e.preventDefault();
    };

    this._onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.released.add(e.code);
      if (this.isBound('forward', e.code)) this.sprintLatched = false;
      this.listeners.key.forEach((f) => f(e, false));
    };

    this._onMouseMove = (e) => {
      if (this.pointerLocked) {
        this.mouse.dx += e.movementX || 0;
        this.mouse.dy += e.movementY || 0;
      }
      const r = this.canvas.getBoundingClientRect();
      this.mouse.x = e.clientX - r.left;
      this.mouse.y = e.clientY - r.top;
    };

    this._onMouseDown = (e) => {
      this.mouse.buttons.add(e.button);
      this.mouse.pressed.add(e.button);
    };

    this._onMouseUp = (e) => {
      this.mouse.buttons.delete(e.button);
      this.mouse.released.add(e.button);
    };

    this._onWheel = (e) => {
      this.mouse.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    };

    this._onLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      if (!this.pointerLocked) {
        // Releasing the pointer must not leave movement keys stuck down.
        this.keys.clear();
        this.mouse.buttons.clear();
      }
      this.listeners.lockChange.forEach((f) => f(this.pointerLocked));
    };

    this._onBlur = () => { this.keys.clear(); this.mouse.buttons.clear(); };
    this._onContextMenu = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('pointerlockchange', this._onLockChange);
    window.addEventListener('blur', this._onBlur);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    window.removeEventListener('blur', this._onBlur);
  }

  on(evt, fn) { this.listeners[evt].push(fn); return this; }

  requestLock() {
    if (!this.pointerLocked) {
      const p = this.canvas.requestPointerLock?.({ unadjustedMovement: true });
      // Chromium rejects unadjustedMovement on some platforms; fall back.
      if (p && typeof p.catch === 'function') {
        p.catch(() => this.canvas.requestPointerLock());
      }
    }
  }

  exitLock() { if (this.pointerLocked) document.exitPointerLock(); }

  isBound(action, code) {
    const b = this.bindings[action];
    return !!b && b.includes(code);
  }

  /** Is the action's key currently held? */
  down(action) {
    if (this.guiMode && !GUI_ALLOWED.has(action)) return false;
    const b = this.bindings[action];
    if (!b) return false;
    for (const c of b) if (this.keys.has(c)) return true;
    return false;
  }

  /** Was the action pressed since the last `endFrame()`? */
  justPressed(action) {
    const b = this.bindings[action];
    if (!b) return false;
    for (const c of b) if (this.pressed.has(c)) return true;
    return false;
  }

  justReleased(action) {
    const b = this.bindings[action];
    if (!b) return false;
    for (const c of b) if (this.released.has(c)) return true;
    return false;
  }

  keyDown(code) { return this.keys.has(code); }
  keyPressed(code) { return this.pressed.has(code); }

  mouseDown(button) {
    return !this.guiMode && this.mouse.buttons.has(button);
  }
  mousePressed(button) { return this.mouse.pressed.has(button); }
  mouseReleased(button) { return this.mouse.released.has(button); }

  /** Double-tapping forward starts a sprint, as in the real game. */
  checkDoubleTapSprint() {
    const now = performance.now();
    if (now - this._lastForwardTap < this.doubleTapWindow) this.sprintLatched = true;
    this._lastForwardTap = now;
  }

  /** Consume accumulated mouse motion, in radians of yaw/pitch. */
  takeLook() {
    const dx = this.mouse.dx * this.sensitivity;
    const dy = this.mouse.dy * this.sensitivity * (this.invertY ? -1 : 1);
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    return { yaw: -dx, pitch: -dy };
  }

  takeWheel() { const w = this.mouse.wheel; this.mouse.wheel = 0; return w; }

  /** Clear per-frame edges. Call once at the end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.repeat.clear();
    this.mouse.pressed.clear();
    this.mouse.released.clear();
  }
}

/** Keys the game consumes entirely, so the page never scrolls or scrubs. */
const SWALLOWED = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10',
]);

/** Actions that still work while a GUI screen has focus. */
const GUI_ALLOWED = new Set(['inventory', 'pause', 'debug', 'screenshot', 'fullscreen']);
