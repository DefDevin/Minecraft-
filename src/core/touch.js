// Touch controls.
//
// Phones have no pointer lock and no keyboard, so on a touch device the game
// grows a control layer instead: a virtual stick on the left for movement, a
// look-drag zone on the right, and a small set of buttons. It feeds the same
// `Input` object the desktop path uses, so gameplay code never learns there is
// a difference.
//
// Break and place both live on the look zone: a short tap places, a held press
// breaks. That mirrors Minecraft Pocket Edition closely enough to be familiar.

/** True when the device is primarily touch-driven. */
export function isTouchDevice() {
  if (typeof window === 'undefined') return false;
  if (navigator.maxTouchPoints > 1) return true;
  return window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
}

/** Hold this long on the look zone before it counts as "breaking". */
const HOLD_TO_BREAK_MS = 180;
/** A press shorter than this, with little movement, is a place/use tap. */
const TAP_MAX_MS = 250;
const TAP_MAX_MOVE = 14;

export class TouchControls {
  /**
   * @param {HTMLElement} container element to attach the overlay to
   * @param {Input} input the shared input object to drive
   */
  constructor(container, input) {
    this.container = container;
    this.input = input;
    this.enabled = false;

    // Movement stick state
    this.stickId = null;
    this.stickOx = 0; this.stickOy = 0;
    this.stickX = 0; this.stickY = 0;   // -1..1

    // Look drag state
    this.lookId = null;
    this.lookX = 0; this.lookY = 0;
    this.lookStartX = 0; this.lookStartY = 0;
    this.lookStartTime = 0;
    this.lookMoved = 0;

    this.buttons = new Map();   // name -> {el, held}
    this.sensitivity = 0.32;    // radians per 100px of drag
    this.build();
  }

  // -- Overlay -------------------------------------------------------------

  build() {
    const root = document.createElement('div');
    root.id = 'touch-controls';
    root.innerHTML = '';
    Object.assign(root.style, {
      position: 'fixed', inset: '0', zIndex: '5', display: 'none',
      touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none',
      WebkitTapHighlightColor: 'transparent',
    });

    // The two drag zones sit underneath the buttons and never draw anything
    // except the stick knob, so they do not obscure the world.
    this.moveZone = this.zone('0', '0', '45%', '100%');
    this.lookZone = this.zone('45%', '0', '55%', '100%');
    root.append(this.moveZone, this.lookZone);

    this.knobBase = document.createElement('div');
    Object.assign(this.knobBase.style, {
      position: 'absolute', width: '132px', height: '132px', marginLeft: '-66px',
      marginTop: '-66px', borderRadius: '50%', border: '2px solid rgba(255,255,255,.28)',
      background: 'rgba(0,0,0,.18)', display: 'none', pointerEvents: 'none',
    });
    this.knob = document.createElement('div');
    Object.assign(this.knob.style, {
      position: 'absolute', width: '56px', height: '56px', marginLeft: '-28px',
      marginTop: '-28px', borderRadius: '50%', background: 'rgba(255,255,255,.42)',
      border: '2px solid rgba(255,255,255,.6)', display: 'none', pointerEvents: 'none',
    });
    root.append(this.knobBase, this.knob);

    // Buttons. `action` is the Input binding they hold down.
    const mk = (label, action, css, opts = {}) =>
      root.appendChild(this.button(label, action, css, opts));
    mk('▲', 'jump', { right: '22px', bottom: '104px', width: '74px', height: '74px' });
    mk('▼', 'sneak', { right: '106px', bottom: '30px', width: '64px', height: '64px' },
      { toggle: true });
    mk('⛏', null, { right: '22px', bottom: '196px', width: '64px', height: '64px' },
      { onPress: () => this.onMineButton() });
    mk('☰', 'inventory', { right: '22px', top: '22px', width: '56px', height: '56px' },
      { tap: true });
    mk('⇅', 'perspective', { right: '88px', top: '22px', width: '56px', height: '56px' },
      { tap: true });
    mk('✈', 'toggleFly', { right: '154px', top: '22px', width: '56px', height: '56px' },
      { tap: true });

    // Hotbar arrows, since there are no number keys to press.
    mk('‹', null, { left: '18px', bottom: '30px', width: '54px', height: '54px' },
      { tap: true, onPress: () => this.cycleHotbar(-1) });
    mk('›', null, { left: '82px', bottom: '30px', width: '54px', height: '54px' },
      { tap: true, onPress: () => this.cycleHotbar(1) });

    this.root = root;
    this.container.appendChild(root);
    this.bind();
  }

  zone(left, top, width, height) {
    const el = document.createElement('div');
    Object.assign(el.style, { position: 'absolute', left, top, width, height });
    return el;
  }

  button(label, action, css, opts) {
    const el = document.createElement('div');
    el.textContent = label;
    Object.assign(el.style, {
      position: 'absolute', display: 'flex', alignItems: 'center',
      justifyContent: 'center', borderRadius: '12px',
      background: 'rgba(0,0,0,.32)', border: '2px solid rgba(255,255,255,.35)',
      color: 'rgba(255,255,255,.9)', font: '600 22px/1 system-ui, sans-serif',
      touchAction: 'none', ...css,
    });
    const rec = { el, action, held: false, ...opts };
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture?.(e.pointerId);
      el.style.background = 'rgba(255,255,255,.3)';
      if (opts.onPress) opts.onPress();
      if (!action) return;
      if (opts.toggle) {
        rec.held = !rec.held;
        this.setAction(action, rec.held);
      } else if (opts.tap) {
        this.tapAction(action);
      } else {
        rec.held = true;
        this.setAction(action, true);
      }
    });
    const release = (e) => {
      e?.preventDefault();
      el.style.background = rec.held && opts.toggle
        ? 'rgba(255,255,255,.28)' : 'rgba(0,0,0,.32)';
      if (action && !opts.toggle && !opts.tap && rec.held) {
        rec.held = false;
        this.setAction(action, false);
      }
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
    this.buttons.set(label, rec);
    return el;
  }

  // -- Feeding the Input object --------------------------------------------

  /**
   * Hold or release the first key bound to an action, so `Input.down()` and
   * `Input.justPressed()` behave exactly as they do for a real keyboard.
   */
  setAction(action, down) {
    const code = this.input.bindings[action]?.[0];
    if (!code) return;
    if (down) {
      if (!this.input.keys.has(code)) this.input.pressed.add(code);
      this.input.keys.add(code);
    } else {
      this.input.keys.delete(code);
      this.input.released.add(code);
    }
  }

  /** A one-frame press, for actions that only read `justPressed`. */
  tapAction(action) {
    const code = this.input.bindings[action]?.[0];
    if (!code) return;
    this.input.pressed.add(code);
    this.pendingRelease.push(code);
  }

  pendingRelease = [];

  cycleHotbar(dir) { this.input.mouse.wheel += dir; }

  onMineButton() {
    // A dedicated mine button for when the look zone is busy aiming.
    this.mineLatch = !this.mineLatch;
    if (this.mineLatch) this.input.mouse.buttons.add(0);
    else this.input.mouse.buttons.delete(0);
  }

  // -- Gestures ------------------------------------------------------------

  bind() {
    this.moveZone.addEventListener('pointerdown', (e) => {
      if (this.stickId !== null) return;
      e.preventDefault();
      this.moveZone.setPointerCapture(e.pointerId);
      this.stickId = e.pointerId;
      this.stickOx = e.clientX; this.stickOy = e.clientY;
      this.knobBase.style.left = `${e.clientX}px`;
      this.knobBase.style.top = `${e.clientY}px`;
      this.knobBase.style.display = 'block';
      this.knob.style.left = `${e.clientX}px`;
      this.knob.style.top = `${e.clientY}px`;
      this.knob.style.display = 'block';
    });
    this.moveZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stickId) return;
      e.preventDefault();
      const dx = e.clientX - this.stickOx, dy = e.clientY - this.stickOy;
      const max = 62;
      const len = Math.hypot(dx, dy);
      const cx = len > max ? dx / len * max : dx;
      const cy = len > max ? dy / len * max : dy;
      this.knob.style.left = `${this.stickOx + cx}px`;
      this.knob.style.top = `${this.stickOy + cy}px`;
      // A small dead zone stops a resting thumb from drifting the player.
      this.stickX = Math.abs(cx) < 8 ? 0 : cx / max;
      this.stickY = Math.abs(cy) < 8 ? 0 : cy / max;
    });
    const endStick = (e) => {
      if (e.pointerId !== this.stickId) return;
      this.stickId = null;
      this.stickX = 0; this.stickY = 0;
      this.knobBase.style.display = 'none';
      this.knob.style.display = 'none';
    };
    this.moveZone.addEventListener('pointerup', endStick);
    this.moveZone.addEventListener('pointercancel', endStick);

    this.lookZone.addEventListener('pointerdown', (e) => {
      if (this.lookId !== null) return;
      e.preventDefault();
      this.lookZone.setPointerCapture(e.pointerId);
      this.lookId = e.pointerId;
      this.lookX = this.lookStartX = e.clientX;
      this.lookY = this.lookStartY = e.clientY;
      this.lookStartTime = performance.now();
      this.lookMoved = 0;
    });
    this.lookZone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.lookId) return;
      e.preventDefault();
      const dx = e.clientX - this.lookX, dy = e.clientY - this.lookY;
      this.lookX = e.clientX; this.lookY = e.clientY;
      this.lookMoved += Math.abs(dx) + Math.abs(dy);
      // Feed the same accumulator the mouse uses, so `takeLook()` just works.
      this.input.mouse.dx += dx * this.sensitivity / this.input.sensitivity / 100;
      this.input.mouse.dy += dy * this.sensitivity / this.input.sensitivity / 100;

      // Once the finger has been down a while without much travel, the player
      // is aiming at a block and wants to mine it.
      if (!this.breaking && this.lookMoved < TAP_MAX_MOVE &&
        performance.now() - this.lookStartTime > HOLD_TO_BREAK_MS) {
        this.breaking = true;
        this.input.mouse.buttons.add(0);
      }
    });
    const endLook = (e) => {
      if (e.pointerId !== this.lookId) return;
      const heldMs = performance.now() - this.lookStartTime;
      this.lookId = null;
      if (this.breaking) {
        this.breaking = false;
        this.input.mouse.buttons.delete(0);
        this.input.mouse.released.add(0);
      } else if (heldMs < TAP_MAX_MS && this.lookMoved < TAP_MAX_MOVE) {
        // A quick tap places a block / uses the held item.
        this.input.mouse.pressed.add(2);
        this.pendingRelease.push('mouse2');
      }
    };
    this.lookZone.addEventListener('pointerup', endLook);
    this.lookZone.addEventListener('pointercancel', endLook);

    // A long press with no movement, held past the break threshold, keeps
    // mining even if the finger stops sending move events.
    this.holdTimer = setInterval(() => {
      if (this.lookId === null || this.breaking) return;
      if (this.lookMoved >= TAP_MAX_MOVE) return;
      if (performance.now() - this.lookStartTime > HOLD_TO_BREAK_MS) {
        this.breaking = true;
        this.input.mouse.buttons.add(0);
      }
    }, 60);
  }

  // -- Per-frame -----------------------------------------------------------

  show() { this.enabled = true; this.root.style.display = 'block'; }
  hide() { this.enabled = false; this.root.style.display = 'none'; }

  /** Movement axes for the frame, in the same shape the game's command uses. */
  axes() {
    return { forward: -this.stickY, strafe: this.stickX };
  }

  /** Release one-frame taps. Call after the game's `input.endFrame()`. */
  endFrame() {
    for (const code of this.pendingRelease) {
      if (code === 'mouse2') this.input.mouse.released.add(2);
      else { this.input.keys.delete(code); this.input.released.add(code); }
    }
    this.pendingRelease.length = 0;
  }

  dispose() {
    clearInterval(this.holdTimer);
    this.root.remove();
  }
}
