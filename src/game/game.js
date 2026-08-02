// The Game: owns the world, the player, the render loop, and the wiring between
// every subsystem.
//
// Simulation runs at a fixed 20 ticks per second (Minecraft's rate) with the
// renderer interpolating between ticks, so movement stays smooth and identical
// at any frame rate. Chunk streaming, meshing and lighting each get a slice of
// the remaining frame budget.

import { World, FLAG } from '../world/world.js';
import {
  Chunk, CHUNK_STATE, CHUNK_SIZE, MIN_Y, MAX_Y, SEA_LEVEL, SECTION_COUNT, chunkKey,
} from '../world/chunk.js';
import { T, blockOf, blocksByName, getProp, withProp, TOOL } from '../world/blocks.js';
import { Renderer } from '../render/renderer.js';
import { Environment } from '../render/environment.js';
import { Input } from '../core/input.js';
import { Player, GAMEMODE } from '../entity/player.js';
import { ItemStack, getItem, itemsByName, canHarvest, isCorrectTool } from './items.js';
import { Random, parseSeed } from '../core/rng.js';
import { installHooks } from './hooks.js';
import { FallbackInventoryScreen } from './ui/fallbackscreens.js';
import { clamp, lerp, AABB, FACES, yawToFacing } from '../core/math.js';

const TICK_RATE = 20;
const TICK_MS = 1000 / TICK_RATE;
const MAX_CATCHUP_TICKS = 5;

export class Game {
  constructor(opts) {
    this.canvas = opts.canvas;
    this.guiCanvas = opts.guiCanvas;
    this.modules = opts.modules;        // optional content modules, may hold nulls
    this.settings = {
      renderDistance: 10,
      simulationDistance: 8,
      fov: 70,
      sensitivity: 0.0022,
      guiScale: 0,          // 0 = auto
      masterVolume: 1,
      musicVolume: 0.35,
      smoothLighting: true,
      viewBobbing: true,
      clouds: true,
      particles: 2,
      maxFps: 0,
      renderScale: 1,
      ...(opts.settings || {}),
    };

    this.renderer = new Renderer(this.canvas, {
      fov: this.settings.fov,
      renderDistance: this.settings.renderDistance,
      renderScale: this.settings.renderScale,
    });
    this.gui = this.guiCanvas.getContext('2d');
    this.input = new Input(this.canvas, { sensitivity: this.settings.sensitivity });

    this.running = false;
    this.paused = false;
    this.accumulator = 0;
    this.lastFrame = 0;
    this.frameCount = 0;
    this.fps = 0;
    this.fpsAccum = 0;
    this.fpsTime = 0;
    this.tickTime = 0;
    this.elapsed = 0;

    this.screens = [];             // GUI screen stack
    this.chatLines = [];
    this.showDebug = false;
    this.targetHit = null;

    this.generators = new Map();
    this.worlds = new Map();
  }

  // -- Setup ---------------------------------------------------------------

  async createWorld(seedText, opts = {}) {
    const seed = parseSeed(seedText);
    this.seed = seed;
    const M = this.modules;

    const overworld = new World({
      seed, dimension: 'overworld', game: this, hasSkylight: true,
    });
    overworld.generator = M.generator
      ? new M.generator.OverworldGenerator(seed)
      : new FlatFallbackGenerator(seed);
    this.worlds.set('overworld', overworld);

    if (M.generator?.NetherGenerator) {
      const nether = new World({
        seed: seed ^ 0x4e455448, dimension: 'nether', game: this,
        hasSkylight: false, ambientLight: 0.1, ceiling: true,
      });
      nether.generator = new M.generator.NetherGenerator(seed);
      this.worlds.set('nether', nether);
    }
    if (M.generator?.EndGenerator) {
      const end = new World({
        seed: seed ^ 0x454e4421, dimension: 'end', game: this,
        hasSkylight: false, ambientLight: 0.12,
      });
      end.generator = new M.generator.EndGenerator(seed);
      this.worlds.set('end', end);
    }

    this.world = overworld;
    this.world.simulationDistance = this.settings.simulationDistance;
    this.environment = new Environment(this.world);
    if (M.biomes?.biomeById) this.environment.setBiomeTable(M.biomes.biomeById);

    this.loader = new ChunkStreamer(this);
    this.setupWorldEvents(this.world);

    // Find a safe spawn: the first column near origin with solid ground above
    // sea level, generating chunks as needed.
    const spawn = await this.findSpawn();
    this.player = new Player(this.world, {
      x: spawn.x, y: spawn.y, z: spawn.z,
      gamemode: opts.gamemode ?? GAMEMODE.SURVIVAL,
    });
    this.player.spawnPoint = { ...spawn };
    this.world.spawnPos = { ...spawn };
    this.world.addEntity(this.player);

    this.setupInventory();
    this.setupSubsystems();
    installHooks(this);
    return this;
  }

  setupInventory() {
    const M = this.modules;
    if (M.inventory?.PlayerInventory) {
      this.player.inventory = new M.inventory.PlayerInventory(this.player);
    } else {
      this.player.inventory = new SimpleInventory();
    }
    if (this.player.gamemode === GAMEMODE.CREATIVE) this.player.canFly = true;
  }

  setupSubsystems() {
    const M = this.modules;
    if (M.sound?.SoundEngine) {
      try {
        this.sound = new M.sound.SoundEngine({
          master: this.settings.masterVolume, music: this.settings.musicVolume,
        });
      } catch (e) { console.warn('audio unavailable:', e.message); }
    }
    if (M.particles?.ParticleSystem) {
      try { this.particles = new M.particles.ParticleSystem(this.renderer); }
      catch (e) { console.warn('particles unavailable:', e.message); }
    }
    if (M.weather?.WeatherRenderer) {
      try { this.weather = new M.weather.WeatherRenderer(this.renderer, this); }
      catch (e) { console.warn('weather unavailable:', e.message); }
    }
    if (M.hud?.Hud) {
      try { this.hud = new M.hud.Hud(this); } catch (e) { console.warn('hud:', e.message); }
    }
    if (!this.hud) this.hud = new FallbackHud(this);
    this.entityRenderer = M.entityRenderer?.EntityRenderer
      ? new M.entityRenderer.EntityRenderer(this.renderer, M.models, M.mobTextures)
      : null;
  }

  setupWorldEvents(world) {
    world.on('blockChange', (x, y, z) => {
      // Blocks adjacent to a change may need their model updated (fences,
      // redstone, stairs), and the section needs remeshing.
      const c = world.getChunkAt(x, z);
      if (c) this.loader.markDirtyAt(x, y, z);
    });
    world.on('sound', (name, x, y, z, o) => {
      this.sound?.playAt?.(name, x, y, z, o);
    });
    world.on('particle', (type, x, y, z, count, o) => {
      if (this.settings.particles === 0) return;
      this.particles?.emit?.(type, x, y, z, count, o);
    });
  }

  async findSpawn() {
    const w = this.world;
    for (let r = 0; r < 12; r++) {
      for (let i = 0; i < (r === 0 ? 1 : r * 8); i++) {
        const a = (i / Math.max(1, r * 8)) * Math.PI * 2;
        const cx = Math.round(Math.cos(a) * r);
        const cz = Math.round(Math.sin(a) * r);
        this.loader.generateChunkNow(cx, cz);
        const chunk = w.getChunk(cx, cz);
        if (!chunk) continue;
        for (let lz = 2; lz < 14; lz += 3) {
          for (let lx = 2; lx < 14; lx += 3) {
            const h = chunk.surfaceHeight(lx, lz);
            if (h < SEA_LEVEL) continue;
            const above = w.getBlock(chunk.x0 + lx, h + 1, chunk.z0 + lz);
            if (T.fluid[above]) continue;
            if (T.solid[above]) continue;
            return { x: chunk.x0 + lx + 0.5, y: h + 1, z: chunk.z0 + lz + 0.5 };
          }
        }
      }
    }
    return { x: 0.5, y: 90, z: 0.5 };
  }

  // -- Loop ----------------------------------------------------------------

  start() {
    this.running = true;
    this.lastFrame = performance.now();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.input.on('lockChange', (locked) => {
      if (!locked && this.screens.length === 0 && !this.paused) this.openPause();
    });
    this.canvas.addEventListener('mousedown', () => {
      if (this.screens.length === 0 && !this.input.pointerLocked) {
        this.input.requestLock();
        this.sound?.resume?.();
      }
    });
    requestAnimationFrame(this.frame);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.resize(w, h);
    const scale = this.guiScale();
    this.guiCanvas.width = Math.max(1, Math.floor(w * (window.devicePixelRatio || 1)));
    this.guiCanvas.height = Math.max(1, Math.floor(h * (window.devicePixelRatio || 1)));
    this.guiCanvas.style.width = `${w}px`;
    this.guiCanvas.style.height = `${h}px`;
    this.gui.imageSmoothingEnabled = false;
    this.guiWidth = this.guiCanvas.width / scale;
    this.guiHeight = this.guiCanvas.height / scale;
    this.guiScaleFactor = scale;
  }

  guiScale() {
    const dpr = window.devicePixelRatio || 1;
    if (this.settings.guiScale > 0) return this.settings.guiScale * dpr;
    // Auto: pick the largest integer scale that keeps the GUI under ~430 units.
    const base = Math.max(1, Math.min(
      Math.floor(window.innerWidth / 340), Math.floor(window.innerHeight / 240), 4));
    return base * dpr;
  }

  frame = (now) => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);

    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (dt > 0.25) dt = 0.25;     // a long stall must not fast-forward the world
    this.elapsed += dt;

    this.fpsAccum++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = this.fpsAccum / this.fpsTime;
      this.fpsAccum = 0; this.fpsTime = 0;
    }

    this.handleInput(dt);

    if (!this.paused) {
      this.accumulator += dt * 1000;
      let ticks = 0;
      const t0 = performance.now();
      while (this.accumulator >= TICK_MS && ticks < MAX_CATCHUP_TICKS) {
        this.accumulator -= TICK_MS;
        this.tick();
        ticks++;
      }
      if (ticks === MAX_CATCHUP_TICKS) this.accumulator = 0;
      this.tickTime = performance.now() - t0;
    }

    const alpha = clamp(this.accumulator / TICK_MS, 0, 1);
    this.render(alpha, dt);
    this.input.endFrame();
    this.frameCount++;
  };

  tick() {
    const world = this.world;
    const player = this.player;

    world.tick();
    this.loader.tick();

    const cmd = this.buildMoveCommand();
    player.tick(cmd);

    // Entities
    for (let i = world.entities.length - 1; i >= 0; i--) {
      const e = world.entities[i];
      if (e === player) continue;
      if (e.removed) { world.entities.splice(i, 1); continue; }
      try {
        e.tick?.(world);
      } catch (err) {
        // One misbehaving entity must not stop the world; drop it and log once.
        this.reportOnce(`entity:${e.type ?? e.constructor?.name}`, err);
        world.removeEntity(e);
      }
    }

    this.safe('blockEntities', () => this.modules.blockEntity?.tickBlockEntities?.(world));
    this.safe('redstone', () => this.modules.redstone?.tickRedstone?.(world));
    this.safe('fluids', () => this.modules.fluids?.tick?.(world));
    if (this.modules.survival) {
      this.safe('survival', () => this.modules.survival.tickPlayer(player, world));
    } else {
      this.tickHungerFallback(player);
    }
    if (world.tickCount % 20 === 0) {
      this.safe('mobSpawning', () => this.modules.mobs?.trySpawnMobs?.(world, player));
    }
    this.safe('farming', () => this.modules.farming?.tick?.(world));
    this.safe('weather', () => this.weather?.tick?.(world));
    // Autosave. The manager is built on the first tick — by then the world and
    // the player exist — and only ever queues work here; the writes themselves
    // happen from an idle callback.
    this.safe('autosave', () => {
      if (this.save === undefined) this.save = this.makeSaveManager();
      this.save?.tick();
    });
  }

  /**
   * Run a subsystem tick, logging the first failure per subsystem and then
   * disabling it, rather than throwing twenty times a second.
   */
  safe(name, fn) {
    if (this.brokenSystems?.has(name)) return;
    try {
      fn();
    } catch (e) {
      (this.brokenSystems ??= new Set()).add(name);
      console.error(`[${name}] disabled after an error:`, e);
      this.chat(`${name} disabled after an error (see console)`);
    }
  }

  reportOnce(key, err) {
    (this.reported ??= new Set());
    if (this.reported.has(key)) return;
    this.reported.add(key);
    console.error(`[${key}]`, err);
  }

  /** Minimal hunger/regen so survival works before survival.js is wired in. */
  tickHungerFallback(p) {
    if (p.gamemode !== GAMEMODE.SURVIVAL || p.dead) return;
    if (this.world.tickCount % 80 === 0) {
      if (p.food >= 18 && p.health < p.maxHealth) {
        p.heal(1); p.addExhaustion(6);
      } else if (p.food === 0 && p.health > 1) {
        p.hurt(1, 'starve');
      }
    }
  }

  buildMoveCommand() {
    const i = this.input;
    if (this.screens.length > 0 || this.paused || this.player.dead) {
      return { forward: 0, strafe: 0, jump: false, sneak: false, sprint: false };
    }
    return {
      forward: (i.down('forward') ? 1 : 0) - (i.down('back') ? 1 : 0),
      strafe: (i.down('right') ? 1 : 0) - (i.down('left') ? 1 : 0),
      jump: i.down('jump'),
      sneak: i.down('sneak'),
      sprint: i.down('sprint') || i.sprintLatched,
    };
  }

  // -- Input ---------------------------------------------------------------

  handleInput(dt) {
    const i = this.input;
    i.guiMode = this.screens.length > 0 || this.paused;

    if (i.justPressed('debug')) this.showDebug = !this.showDebug;
    if (i.justPressed('fullscreen')) this.toggleFullscreen();

    if (i.justPressed('pause')) {
      if (this.screens.length > 0) this.closeScreen();
      else if (this.paused) this.resume();
      else this.openPause();
      return;
    }

    if (this.screens.length > 0) { this.handleScreenInput(); return; }
    if (this.paused || this.player.dead) return;

    // Look
    if (i.pointerLocked) {
      const look = i.takeLook();
      this.player.applyLook(look.yaw, look.pitch);
    }

    // Hotbar
    const wheel = i.takeWheel();
    if (wheel !== 0) {
      this.player.selectedSlot = (this.player.selectedSlot + wheel + 9) % 9;
      this.player.inventory.selected = this.player.selectedSlot;
    }
    for (let n = 1; n <= 9; n++) {
      if (i.justPressed(`hotbar${n}`)) {
        this.player.selectedSlot = n - 1;
        this.player.inventory.selected = n - 1;
      }
    }

    if (i.justPressed('inventory')) { this.openInventory(); return; }
    if (i.justPressed('drop')) this.dropSelected(i.keyDown('ControlLeft'));
    if (i.justPressed('perspective')) {
      this.player.perspective = (this.player.perspective + 1) % 3;
    }
    if (i.justPressed('toggleFly') && this.player.gamemode === GAMEMODE.CREATIVE) {
      this.player.flying = !this.player.flying;
    }
    // Double-tapping jump toggles flight in creative, as in the real game.
    if (i.justPressed('jump') && this.player.canFly) {
      const now = performance.now();
      if (now - (this._lastJumpTap || 0) < 300) {
        this.player.flying = !this.player.flying;
        this.player.vy = 0;
      }
      this._lastJumpTap = now;
    }

    this.updateTarget();
    this.handleInteraction(dt);
  }

  handleScreenInput() {
    const s = this.screens[this.screens.length - 1];
    const scale = this.guiScaleFactor / (window.devicePixelRatio || 1);
    const mx = this.input.mouse.x / (this.guiScaleFactor / (window.devicePixelRatio || 1));
    const my = this.input.mouse.y / (this.guiScaleFactor / (window.devicePixelRatio || 1));
    if (this.input.mousePressed(0)) s.mouseDown?.(mx, my, 0);
    if (this.input.mousePressed(2)) s.mouseDown?.(mx, my, 1);
    if (this.input.mouseReleased(0)) s.mouseUp?.(mx, my, 0);
    if (this.input.mouseReleased(2)) s.mouseUp?.(mx, my, 1);
    s.mouseMove?.(mx, my);
    const w = this.input.takeWheel();
    if (w !== 0) s.wheel?.(w);
    if (this.input.justPressed('inventory') && s.closeOnInventoryKey !== false) {
      this.closeScreen();
    }
  }

  updateTarget() {
    const p = this.player;
    const eye = { x: p.eyeX, y: p.eyeY, z: p.eyeZ };
    const dir = p.lookVector();
    const reach = p.gamemode === GAMEMODE.CREATIVE ? 5 : 4.5;
    this.targetHit = this.world.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, reach);
    this.targetEntity = this.raycastEntity(eye, dir, reach);
  }

  raycastEntity(eye, dir, reach) {
    let best = null, bestT = this.targetHit ? this.targetHit.dist : reach;
    const box = new AABB();
    for (const e of this.world.entities) {
      if (e === this.player || e.removed || e.noHit) continue;
      const dx = e.x - eye.x, dy = e.y - eye.y, dz = e.z - eye.z;
      if (dx * dx + dy * dy + dz * dz > (reach + 3) * (reach + 3)) continue;
      box.copyFrom(e.aabb).grow(0.1, 0.1, 0.1, box);
      const hit = box.rayIntersect(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, bestT);
      if (hit && hit.t < bestT) { bestT = hit.t; best = e; }
    }
    return best;
  }

  handleInteraction(dt) {
    const i = this.input;
    const p = this.player;

    // Left button: break blocks / attack
    if (i.mouseDown(0)) {
      if (this.targetEntity && !this._attackedThisPress) {
        this.attack(this.targetEntity);
        this._attackedThisPress = true;
      } else if (this.targetHit) {
        p.updateBreaking(this.targetHit, dt);
        p.swing();
        if (p.breaking && p.breaking.progress >= 1) this.breakBlock();
      } else {
        p.breaking = null;
        if (i.mousePressed(0)) p.swing();
      }
    } else {
      p.breaking = null;
      this._attackedThisPress = false;
    }

    // Right button: use item / place block
    if (i.mousePressed(2) || (i.mouseDown(2) && p.placeCooldown === 0)) {
      this.useItem();
    }
    if (i.justPressed('pickBlock')) this.pickBlock();
  }

  breakBlock() {
    const hit = this.player.breaking;
    if (!hit) return;
    const state = this.world.getBlock(hit.x, hit.y, hit.z);
    if (state === 0) { this.player.breaking = null; return; }
    const def = blockOf(state);
    const tool = this.player.heldItem();
    const creative = this.player.gamemode === GAMEMODE.CREATIVE;

    this.world.emit('particle', 'block_break', hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, 16,
      { state });
    this.world.playSound(`break.${def?.sound || 'stone'}`, hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
    if (def?.onBreak) def.onBreak(this.world, hit.x, hit.y, hit.z, state);
    this.world.setBlock(hit.x, hit.y, hit.z, 0, FLAG.DEFAULT);

    if (!creative) {
      this.dropBlockLoot(this.world, hit.x, hit.y, hit.z, state, tool);
      if (tool && tool.item.tool) {
        if (tool.damageBy(1, this.world.random)) {
          this.world.playSound('item.break', this.player.x, this.player.y, this.player.z);
          this.player.inventory.setSelected?.(null);
        }
      }
      this.player.addExhaustion(0.005);
    }
    this.player.breaking = null;
    this.player.breakCooldown = 5;
  }

  /** Spawn the drops for a broken block, honouring silk touch and fortune. */
  dropBlockLoot(world, x, y, z, state, tool) {
    const def = blockOf(state);
    if (!def) return;
    const silk = (tool?.getEnchantLevel?.('silk_touch') ?? 0) > 0;
    const fortune = tool?.getEnchantLevel?.('fortune') ?? 0;
    if (!canHarvest(def, tool)) return;

    let drops;
    if (def.getDrops) {
      drops = def.getDrops(world, x, y, z, state, tool, world.random) || [];
    } else if (def.item) {
      drops = [{ item: def.item, count: 1 }];
    } else {
      drops = [];
    }
    for (const d of drops) {
      const item = itemsByName.get(d.item);
      if (!item || d.count <= 0) continue;
      this.spawnItem(world, x + 0.5, y + 0.5, z + 0.5,
        new ItemStack(item, d.count, d.damage || 0, d.tag || null));
    }
    const xp = def.xpDrop ? def.xpDrop(state, silk, world.random) : 0;
    if (xp > 0) this.modules.experience?.spawnOrbs?.(world, x + 0.5, y + 0.5, z + 0.5, xp);
  }

  spawnItem(world, x, y, z, stack) {
    const M = this.modules;
    if (M.itemEntity?.ItemEntity) {
      const e = new M.itemEntity.ItemEntity(world, x, y, z, stack);
      world.addEntity(e);
      return e;
    }
    // Without the item-entity module, drops go straight to the inventory so
    // the game is still playable.
    this.player.inventory.addItem?.(stack);
    return null;
  }

  useItem() {
    const p = this.player;
    const stack = p.heldItem();
    const hit = this.targetHit;
    p.placeCooldown = 4;

    // Entity interaction first (shearing, breeding, trading, saddling).
    if (this.targetEntity?.interact) {
      if (this.targetEntity.interact(p, stack)) { p.swing(); return; }
    }

    if (hit) {
      const state = this.world.getBlock(hit.x, hit.y, hit.z);
      const def = blockOf(state);
      // Sneaking suppresses block interaction so you can place against a chest.
      if (def?.onUse && !p.sneaking) {
        const used = def.onUse(this.world, hit.x, hit.y, hit.z, state, p, stack, hit);
        if (used) { p.swing(); return; }
      }
    }

    if (!stack || stack.empty) return;
    const item = stack.item;

    if (item.onUseOnBlock && hit) {
      if (item.onUseOnBlock(this.world, p, stack, hit)) { p.swing(); return; }
    }
    if (item.block && hit) { this.placeBlock(hit, stack); return; }
    if (item.food) { this.startEating(stack); return; }
    if (item.onUse) { item.onUse(this.world, p, stack, hit); p.swing(); }
  }

  placeBlock(hit, stack) {
    const world = this.world;
    const p = this.player;
    const d = FACES[hit.face];
    let x = hit.x, y = hit.y, z = hit.z;
    const target = world.getBlock(x, y, z);
    // Replaceable blocks (grass, snow layers, water) are built into directly.
    if (!T.replaceable[target]) { x += d.dx; y += d.dy; z += d.dz; }
    if (y < MIN_Y || y > MAX_Y) return;
    if (!T.replaceable[world.getBlock(x, y, z)] && world.getBlock(x, y, z) !== 0) return;

    const def = blocksByName.get(stack.item.block);
    if (!def) return;

    let state = def.defaultState;
    if (def.stateForPlacement) {
      state = def.stateForPlacement(world, x, y, z, {
        face: hit.face, facing: yawToFacing(p.yaw), player: p,
        yaw: p.yaw, pitch: p.pitch,
        hitX: hit.px - x, hitY: hit.py - y, hitZ: hit.pz - z,
        sneaking: p.sneaking, stack,
      });
      if (state == null) return;
    }
    if (def.canSurvive && !def.canSurvive(world, x, y, z, state)) return;

    // Never place a block inside the player or another solid entity.
    const boxes = def.collisionFor(state);
    for (const b of boxes) {
      TEST_BOX.set(x + b.minX, y + b.minY, z + b.minZ, x + b.maxX, y + b.maxY, z + b.maxZ);
      if (TEST_BOX.intersects(p.aabb)) return;
      for (const e of world.entities) {
        if (e === p || !e.blocksPlacement) continue;
        if (TEST_BOX.intersects(e.aabb)) return;
      }
    }

    world.setBlock(x, y, z, state, FLAG.DEFAULT);
    if (def.onPlace) def.onPlace(world, x, y, z, state, p);
    world.playSound(`place.${def.sound}`, x + 0.5, y + 0.5, z + 0.5);
    p.swing();
    if (p.gamemode !== GAMEMODE.CREATIVE) {
      stack.count--;
      if (stack.count <= 0) p.inventory.setSelected?.(null);
    }
  }

  startEating(stack) {
    const p = this.player;
    const food = stack.item.food;
    if (!food) return;
    if (p.food >= 20 && !food.alwaysEdible) return;
    p.usingItem = stack;
    p.useTicks = stack.item.useDuration || 32;
    // Without the survival module the effect applies immediately.
    if (!this.modules.survival) {
      p.food = Math.min(20, p.food + food.hunger);
      p.saturation = Math.min(p.food, p.saturation + food.saturation);
      stack.count--;
      if (stack.count <= 0) p.inventory.setSelected?.(null);
      this.world.playSound('player.burp', p.x, p.y, p.z);
      p.usingItem = null;
    }
  }

  attack(entity) {
    const p = this.player;
    p.swing();
    if (this.modules.combat?.playerAttack) {
      this.modules.combat.playerAttack(p, entity, this.world);
    } else if (entity.hurt) {
      const stack = p.heldItem();
      entity.hurt(stack?.item?.attackDamage ?? 1, 'player', p);
    }
    p.attackCooldown = 0;
    p.addExhaustion(0.1);
  }

  pickBlock() {
    if (!this.targetHit) return;
    const def = blockOf(this.targetHit.state);
    if (!def?.item) return;
    const inv = this.player.inventory;
    if (this.player.gamemode === GAMEMODE.CREATIVE) {
      inv.setSelected?.(new ItemStack(def.item, 1));
    } else {
      inv.selectExisting?.(def.item);
    }
  }

  dropSelected(all) {
    const inv = this.player.inventory;
    const stack = inv.getSelected?.();
    if (!stack || stack.empty) return;
    const drop = all ? stack.split(stack.count) : stack.split(1);
    if (stack.count <= 0) inv.setSelected?.(null);
    const p = this.player;
    const dir = p.lookVector();
    const e = this.spawnItem(this.world, p.eyeX + dir.x * 0.5,
      p.eyeY - 0.3, p.eyeZ + dir.z * 0.5, drop);
    if (e) { e.vx = dir.x * 0.3; e.vy = dir.y * 0.3 + 0.1; e.vz = dir.z * 0.3; e.pickupDelay = 40; }
  }

  createBlockEntity(def, x, y, z, state) {
    return this.modules.blockEntity?.createBlockEntity?.(def, x, y, z, state) ?? null;
  }

  // -- Persistence ---------------------------------------------------------
  //
  // `game.save` is the SaveManager itself — the streamer calls straight into
  // it — so the verbs here are `saveGame` / `loadGame`. Both are safe to call
  // when save.js failed to load: they resolve to false.

  /** Build the save manager once, or null when the module is unavailable. */
  makeSaveManager() {
    const SaveManager = this.modules.save?.SaveManager;
    if (!SaveManager) return null;
    try {
      return new SaveManager(this, {
        id: this.saveId, name: this.saveName, seed: this.world?.seed,
      });
    } catch (e) {
      console.warn('[save] unavailable:', e.message);
      return null;
    }
  }

  /** Persist the world, the player and every changed chunk. */
  async saveGame() {
    if (this.save === undefined) this.save = this.makeSaveManager();
    if (!this.save) return false;
    const ok = await this.save.save();
    if (ok) this.chat('Saved');
    return ok;
  }

  /** Restore world metadata, the player and their inventory from disk. */
  async loadGame() {
    if (this.save === undefined) this.save = this.makeSaveManager();
    if (!this.save) return false;
    const ok = await this.save.load();
    if (ok) {
      // Everything already streamed in was generated, not loaded — drop it so
      // the streamer picks the saved copies up on its next pass.
      this.loader.lastCenter = { cx: Infinity, cz: Infinity };
    }
    return ok;
  }

  // -- Dimensions ----------------------------------------------------------

  /**
   * Move the player to another dimension, building a return portal if one is
   * not already nearby. Overworld <-> Nether coordinates scale by 8, as in the
   * real game, so a short walk in the Nether covers a long overworld distance.
   */
  travelToDimension(entity, target) {
    const dest = this.worlds.get(target);
    if (!dest || dest === this.world) return false;
    const from = this.world;
    const scale = (from.dimension === 'overworld' && target === 'nether') ? 1 / 8
      : (from.dimension === 'nether' && target === 'overworld') ? 8 : 1;

    let x = Math.floor(entity.x * scale);
    let z = Math.floor(entity.z * scale);
    let y = Math.floor(entity.y);
    if (target === 'end') { x = 100; y = 50; z = 0; }

    // Make sure the destination chunks exist before we look for ground.
    const prevWorld = this.world;
    this.world = dest;
    this.loader.world = dest;
    this.loader.lastCenter = { cx: Infinity, cz: Infinity };
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        this.loader.generateChunkNow((x >> 4) + dx, (z >> 4) + dz);
      }
    }

    const spot = this.findPortalSpot(dest, x, y, z) ?? { x: x + 0.5, y: y + 1, z: z + 0.5 };

    prevWorld.removeEntity(entity, true);
    entity.removed = false;
    entity.world = dest;
    entity.x = spot.x; entity.y = spot.y; entity.z = spot.z;
    entity.prevX = spot.x; entity.prevY = spot.y; entity.prevZ = spot.z;
    entity.vx = entity.vy = entity.vz = 0;
    entity.fallDistance = 0;
    entity.portalTime = 0;
    entity.updateBounds?.();
    dest.addEntity(entity);

    this.environment = new Environment(dest);
    if (this.modules.biomes?.biomeById) {
      this.environment.setBiomeTable(this.modules.biomes.biomeById);
    }
    this.setupWorldEvents(dest);
    dest.simulationDistance = this.settings.simulationDistance;
    this.chat(`Travelled to the ${target}`);
    return true;
  }

  /** A safe standing spot near (x,y,z), carving one out if the area is solid. */
  findPortalSpot(world, x, y, z) {
    for (let r = 0; r <= 6; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cx = x + dx, cz = z + dz;
          // Search downward from the ceiling for a two-block-tall gap.
          const top = world.ceiling ? 120 : MAX_Y - 1;
          for (let cy = Math.min(top, y + 24); cy > MIN_Y + 2; cy--) {
            if (!T.solid[world.getBlock(cx, cy - 1, cz)]) continue;
            if (T.fluid[world.getBlock(cx, cy, cz)]) continue;
            if (T.solid[world.getBlock(cx, cy, cz)]) continue;
            if (T.solid[world.getBlock(cx, cy + 1, cz)]) continue;
            return { x: cx + 0.5, y: cy, z: cz + 0.5 };
          }
        }
      }
    }
    // Nowhere safe: hollow out a small platform rather than suffocating.
    const stone = blocksByName.get('obsidian')?.defaultState ?? 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        world.setBlock(x + dx, y - 1, z + dz, stone);
        world.setBlock(x + dx, y, z + dz, 0);
        world.setBlock(x + dx, y + 1, z + dz, 0);
      }
    }
    return { x: x + 0.5, y, z: z + 0.5 };
  }

  // -- Screens -------------------------------------------------------------

  pushScreen(screen) {
    this.screens.push(screen);
    this.input.exitLock();
    screen.game = this;
    screen.onOpen?.();
  }

  closeScreen() {
    const s = this.screens.pop();
    s?.onClose?.();
    if (this.screens.length === 0 && !this.paused) this.input.requestLock();
  }

  openInventory() {
    const M = this.modules;
    const Screen = this.player.gamemode === GAMEMODE.CREATIVE
      ? M.menus?.CreativeInventoryScreen
      : M.inventoryScreen?.InventoryScreen;
    this.pushScreen(Screen ? new Screen(this) : new FallbackInventoryScreen(this, 2));
  }

  openPause() {
    this.paused = true;
    this.input.exitLock();
    const S = this.modules.menus?.PauseScreen;
    if (S) this.pushScreen(new S(this));
  }

  resume() {
    this.paused = false;
    while (this.screens.length) this.screens.pop();
    this.input.requestLock();
  }

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  }

  chat(text) {
    this.chatLines.push({ text, time: this.elapsed });
    if (this.chatLines.length > 100) this.chatLines.shift();
  }

  // -- Render --------------------------------------------------------------

  render(alpha, dt) {
    const r = this.renderer;
    const p = this.player;

    r.renderDistance = this.settings.renderDistance;
    r.cloudsEnabled = this.settings.clouds;

    const eye = p.renderEye(alpha, EYE_SCRATCH);
    const yaw = lerp(p.prevYaw, p.yaw, alpha);
    const pitch = lerp(p.prevPitch, p.pitch, alpha);

    // View bobbing while walking, and the sprint FOV stretch.
    let bobX = 0, bobY = 0, roll = 0;
    if (this.settings.viewBobbing && p.perspective === 0) {
      const dist = lerp(p.prevWalkDist, p.walkDist, alpha);
      const t = dist * 8;
      const amp = Math.min(0.09, Math.hypot(p.vx, p.vz) * 1.4);
      bobX = Math.sin(t) * amp * 0.5;
      bobY = -Math.abs(Math.cos(t)) * amp;
      roll = Math.sin(t) * amp * 0.6;
    }
    const targetFov = this.settings.fov * (p.sprinting ? 1.12 : 1) *
      (p.inWater ? 0.93 : 1);
    p.tiltFov = lerp(p.tiltFov || targetFov, targetFov, 1 - Math.pow(0.001, dt));

    let camX = eye.x + bobX, camY = eye.y + bobY, camZ = eye.z;
    if (p.perspective !== 0) {
      // Third person: pull the camera back along the look ray until it hits.
      const dir = { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch),
        z: Math.cos(yaw) * Math.cos(pitch) };
      const sign = p.perspective === 1 ? -1 : 1;
      const hit = this.world.raycast(eye.x, eye.y, eye.z,
        dir.x * sign, dir.y * sign, dir.z * sign, 4, { collision: true });
      const dist = hit ? Math.max(0.4, hit.dist - 0.3) : 4;
      camX = eye.x + dir.x * sign * dist;
      camY = eye.y + dir.y * sign * dist;
      camZ = eye.z + dir.z * sign * dist;
    }

    r.setCamera(camX, camY, camZ,
      p.perspective === 2 ? yaw + Math.PI : yaw,
      p.perspective === 2 ? -pitch : pitch,
      p.tiltFov);

    this.environment.update(r, {
      x: camX, y: camY, z: camZ,
      submergedIn: p.submergedIn,
      inPortal: p.inPortal, portalTime: p.portalTime,
      lowHealth: p.health <= 6,
      nightVision: p.effects.has('night_vision') ? 1 : 0,
      blindness: p.effects.has('blindness'),
      fireResistance: p.effects.has('fire_resistance'),
      waterBreathing: p.effects.has('water_breathing'),
    }, dt);
    r.hurtFlash = Math.max(0, p.hurtTime / 10);
    r.nausea = p.portalTime * 0.6 + (p.effects.has('nausea') ? 0.6 : 0);

    // Streaming and meshing share whatever is left of the frame. When the mesh
    // backlog grows, generation yields time to it — terrain the player can
    // actually see matters more than terrain queued behind it.
    r.updateAnimations(this.world.tickCount);
    const backlog = r.stats.meshQueue;
    const meshBudget = backlog > 400 ? 10 : backlog > 120 ? 8 : 5;
    const loadBudget = backlog > 400 ? 2 : backlog > 120 ? 4 : 7;
    this.loader.update(loadBudget);
    r.processMeshQueue(this.world, meshBudget);

    r.beginFrame();
    r.renderSky(this.elapsed);
    r.renderClouds(this.elapsed);
    const visible = r.renderTerrain(this.world, this.elapsed);
    this.entityRenderer?.render(this.world, alpha, this.elapsed);
    r.renderTranslucent(visible);

    if (this.particles) {
      this.particles.update(dt, this.world);
      this.particles.render?.(r);
    }
    this.weather?.render?.(r, this.world, dt);

    if (this.targetHit && p.gamemode !== GAMEMODE.SPECTATOR) {
      const def = blockOf(this.targetHit.state);
      if (def) {
        r.renderSelection(this.targetHit.x, this.targetHit.y, this.targetHit.z,
          def.selectionFor(this.targetHit.state));
      }
      if (p.breakStage >= 0) {
        r.renderBreakOverlay(this.targetHit.x, this.targetHit.y, this.targetHit.z,
          p.breakStage);
      }
    }

    // The held item draws last with the depth buffer cleared, so it is never
    // clipped by geometry the player is standing against.
    this.entityRenderer?.renderHand(p, alpha, this.elapsed);

    r.endFrame();
    this.renderGui(dt);
  }

  renderGui(dt) {
    const ctx = this.gui;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.guiCanvas.width, this.guiCanvas.height);
    ctx.save();
    ctx.scale(this.guiScaleFactor, this.guiScaleFactor);
    ctx.imageSmoothingEnabled = false;
    const w = this.guiWidth, h = this.guiHeight;

    this.hud?.render(ctx, w, h, dt);
    for (const s of this.screens) s.render?.(ctx, w, h, this.input.mouse);
    if (this.showDebug) this.renderDebug(ctx, w, h);
    ctx.restore();
  }

  renderDebug(ctx, w, h) {
    const p = this.player;
    const r = this.renderer;
    const biomeId = this.world.getSurfaceBiomeAt(Math.floor(p.x), Math.floor(p.z));
    const biome = this.modules.biomes?.biomeById?.[biomeId];
    const facingNames = ['north', 'east', 'south', 'west'];
    const lines = [
      `Minecraft (voxel engine)  ${this.fps.toFixed(0)} fps  T:${this.tickTime.toFixed(1)}ms  GPU:${r.stats.gpuMs.toFixed(1)}ms`,
      `XYZ: ${p.x.toFixed(3)} / ${p.y.toFixed(3)} / ${p.z.toFixed(3)}`,
      `Block: ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}   Chunk: ${p.x >> 4} ${p.z >> 4}`,
      `Facing: ${facingNames[yawToFacing(p.yaw)]}  (${(p.yaw * 180 / Math.PI).toFixed(1)} / ${(p.pitch * 180 / Math.PI).toFixed(1)})`,
      `Biome: ${biome?.name ?? biomeId}   Dimension: ${this.world.dimension}`,
      `Light: sky ${this.world.getSkyLight(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))} block ${this.world.getBlockLight(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))}`,
      `Chunks: ${this.world.chunks.size} loaded, ${r.stats.drawnSections}/${r.stats.sections} sections drawn`,
      `Tris: ${(r.stats.triangles / 1000).toFixed(1)}k  Draws: ${r.stats.drawCalls}  MeshQ: ${r.stats.meshQueue}`,
      `Entities: ${this.world.entities.length}   Time: ${this.world.time % 24000} (${this.world.isDay() ? 'day' : 'night'})`,
      `Weather: ${this.world.raining ? 'rain' : 'clear'}${this.world.thundering ? ' + thunder' : ''}  rainLevel ${this.world.rainLevel.toFixed(2)}`,
      this.targetHit
        ? `Targeted: ${blockOf(this.targetHit.state)?.name} at ${this.targetHit.x} ${this.targetHit.y} ${this.targetHit.z}`
        : 'Targeted: none',
    ];
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'top';
    let y = 4;
    for (const line of lines) {
      const tw = ctx.measureText(line).width;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(2, y - 1, tw + 4, 12);
      ctx.fillStyle = '#e8e8e8';
      ctx.fillText(line, 4, y);
      y += 12;
    }
    if (performance.memory) {
      const mb = performance.memory.usedJSHeapSize / 1048576;
      const line = `Heap: ${mb.toFixed(0)} MB`;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(2, y - 1, ctx.measureText(line).width + 4, 12);
      ctx.fillStyle = '#e8e8e8';
      ctx.fillText(line, 4, y);
    }
  }
}

const EYE_SCRATCH = {};
const TEST_BOX = new AABB();

/** The four cardinal chunk offsets, used for border relighting and remeshing. */
const NEIGHBOR_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// ---------------------------------------------------------------------------
// Chunk streaming
//
// Generation, decoration, lighting and meshing each advance one stage per
// visit, so a chunk becomes visible only once its neighbours exist and features
// that cross borders have been placed.
// ---------------------------------------------------------------------------

class ChunkStreamer {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.queue = [];
    this.queued = new Set();
    this.lastCenter = { cx: Infinity, cz: Infinity };
    this.decorateQueue = [];
    this.stats = { generated: 0, decorated: 0, lit: 0 };
  }

  get renderDistance() { return this.game.settings.renderDistance; }

  markDirtyAt(x, y, z) {
    const world = this.world;
    const c = world.getChunkAt(x, z);
    if (!c) return;
    const sy = (y - MIN_Y) >> 4;
    if (c.status >= CHUNK_STATE.READY) this.game.renderer.queueMesh(c, sy, 10);
  }

  /** Rebuild the wanted-chunk list when the player crosses a chunk boundary. */
  refresh(cx, cz) {
    this.lastCenter = { cx, cz };
    const R = this.renderDistance;
    this.queue.length = 0;
    this.queued.clear();
    // Generate one ring beyond the render distance so edge chunks can decorate.
    for (let dz = -R - 1; dz <= R + 1; dz++) {
      for (let dx = -R - 1; dx <= R + 1; dx++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > (R + 1) * (R + 1)) continue;
        const key = chunkKey(cx + dx, cz + dz);
        const c = this.world.chunks.get(key);
        if (c && c.status >= CHUNK_STATE.READY) continue;
        this.queue.push({ cx: cx + dx, cz: cz + dz, d2 });
        this.queued.add(key);
      }
    }
    this.queue.sort((a, b) => a.d2 - b.d2);
    this.unloadFar(cx, cz, R + 3);
  }

  unloadFar(cx, cz, maxR) {
    const max2 = maxR * maxR;
    for (const [key, chunk] of this.world.chunks) {
      const dx = chunk.cx - cx, dz = chunk.cz - cz;
      if (dx * dx + dz * dz <= max2) continue;
      // Anything the player changed is handed to the save manager before the
      // chunk goes; it keeps the reference and packs it off the render path.
      if (chunk.needsSave) this.game.save?.saveChunk?.(chunk, this.world.dimension);
      chunk.dispose(this.game.renderer);
      this.world.unloadChunk(chunk.cx, chunk.cz);
    }
  }

  tick() {
    const p = this.game.player;
    if (!p) return;
    const cx = Math.floor(p.x) >> 4, cz = Math.floor(p.z) >> 4;
    if (cx !== this.lastCenter.cx || cz !== this.lastCenter.cz) this.refresh(cx, cz);
    this.world.simulationDistance = this.game.settings.simulationDistance;
  }

  /** Advance chunk loading within a time budget. */
  update(budgetMs) {
    const t0 = performance.now();
    while (this.queue.length > 0 && performance.now() - t0 < budgetMs) {
      const job = this.queue[0];
      const advanced = this.advance(job.cx, job.cz);
      if (!advanced) this.queue.shift();
    }
  }

  /** Move one chunk one step along its lifecycle. Returns false when READY. */
  advance(cx, cz) {
    const world = this.world;
    let chunk = world.getChunk(cx, cz);
    if (!chunk) chunk = world.createChunk(cx, cz);

    switch (chunk.status) {
      case CHUNK_STATE.EMPTY:
        this.generate(chunk);
        return true;
      case CHUNK_STATE.TERRAIN: {
        // Decoration needs all eight neighbours to have terrain so trees and
        // structures can spill across borders.
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dz === 0) continue;
            const n = world.getChunk(cx + dx, cz + dz);
            if (!n || n.status < CHUNK_STATE.TERRAIN) {
              const nc = n || world.createChunk(cx + dx, cz + dz);
              if (nc.status === CHUNK_STATE.EMPTY) this.generate(nc);
              return true;
            }
          }
        }
        this.decorate(chunk);
        return true;
      }
      case CHUNK_STATE.DECORATED:
        world.light.initialiseChunkLight(chunk);
        // The neighbours' flood fills already drained, so light that should
        // spill into this chunk (a torch by the border, skylight under an
        // overhang) needs its seeds re-queued from their facing edges.
        for (const [dx, dz] of NEIGHBOR_DIRS) {
          const n = world.getChunk(chunk.cx + dx, chunk.cz + dz);
          if (n && n.status >= CHUNK_STATE.LIT) world.light.relightBorder(n, -dx, -dz);
        }
        chunk.status = CHUNK_STATE.LIT;
        this.stats.lit++;
        return true;
      case CHUNK_STATE.LIT:
        this.mesh(chunk);
        chunk.status = CHUNK_STATE.READY;
        world.emit('chunkLoad', chunk);
        return true;
      default:
        return false;
    }
  }

  generate(chunk) {
    // A saved chunk beats a generated one. The save manager streams buffers in
    // ahead of this queue, so the lookup is a cache hit or nothing. Restored
    // chunks are already decorated — running features over them again would
    // duplicate their trees and structures — so they rejoin the pipeline at the
    // lighting stage.
    if (this.game.save?.loadChunkSync?.(chunk.cx, chunk.cz)) {
      chunk.status = CHUNK_STATE.DECORATED;
      this.stats.generated++;
      return;
    }
    try {
      this.world.generator.generateChunk(chunk);
    } catch (e) {
      console.error('chunk generation failed', chunk.cx, chunk.cz, e);
    }
    chunk.recomputeHeightmaps();
    chunk.status = CHUNK_STATE.TERRAIN;
    this.stats.generated++;
  }

  decorate(chunk) {
    const M = this.game.modules;
    try {
      const rng = new Random((this.world.seed ^ (chunk.cx * 341873128712) ^
        (chunk.cz * 132897987541)) | 0);
      M.structures?.placeStructures?.(this.world, chunk, this.world.generator, rng);
      M.features?.decorateChunk?.(this.world, chunk, this.world.generator, rng);
      this.world.generator.decorate?.(this.world, chunk, rng);
    } catch (e) {
      console.error('decoration failed', chunk.cx, chunk.cz, e);
    }
    chunk.recomputeHeightmaps();
    chunk.status = CHUNK_STATE.DECORATED;
    this.stats.decorated++;
    // Trees and structures routinely spill across borders. Any neighbour that
    // is already meshed has to be rebuilt, and its heightmaps recomputed.
    for (const [dx, dz] of NEIGHBOR_DIRS) {
      const n = this.world.getChunk(chunk.cx + dx, chunk.cz + dz);
      if (!n || n.status < CHUNK_STATE.READY) continue;
      n.recomputeHeightmaps();
      for (let sy = 0; sy < SECTION_COUNT; sy++) {
        if (n.sections[sy] && !n.sections[sy].empty) this.game.renderer.queueMesh(n, sy);
      }
    }
  }

  mesh(chunk) {
    for (let sy = 0; sy < SECTION_COUNT; sy++) {
      const s = chunk.sections[sy];
      if (s && !s.empty) this.game.renderer.queueMesh(chunk, sy);
    }
    // Neighbours need remeshing so the shared faces resolve correctly.
    for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const n = this.world.getChunk(chunk.cx + dx, chunk.cz + dz);
      if (!n || n.status < CHUNK_STATE.READY) continue;
      for (let sy = 0; sy < SECTION_COUNT; sy++) {
        if (n.sections[sy] && !n.sections[sy].empty) this.game.renderer.queueMesh(n, sy);
      }
    }
  }

  /** Force a chunk all the way to LIT, used when locating the spawn point. */
  generateChunkNow(cx, cz) {
    let guard = 0;
    while (guard++ < 64) {
      const chunk = this.world.getChunk(cx, cz);
      if (chunk && chunk.status >= CHUNK_STATE.LIT) return chunk;
      if (!this.advance(cx, cz)) return chunk;
    }
    return this.world.getChunk(cx, cz);
  }
}

// ---------------------------------------------------------------------------
// Fallbacks used when an optional content module failed to load
// ---------------------------------------------------------------------------

/** Flat land so the engine is still explorable without a terrain generator. */
class FlatFallbackGenerator {
  constructor(seed) { this.seed = seed; }
  generateChunk(chunk) {
    const stone = blocksByName.get('stone')?.defaultState ?? 1;
    const dirt = blocksByName.get('dirt')?.defaultState ?? stone;
    const grass = blocksByName.get('grass_block')?.defaultState ?? dirt;
    const bedrock = blocksByName.get('bedrock')?.defaultState ?? stone;
    for (let lz = 0; lz < 16; lz++) {
      for (let lx = 0; lx < 16; lx++) {
        chunk.setBlock(lx, MIN_Y, lz, bedrock);
        for (let y = MIN_Y + 1; y < 60; y++) chunk.setBlock(lx, y, lz, stone);
        for (let y = 60; y < 63; y++) chunk.setBlock(lx, y, lz, dirt);
        chunk.setBlock(lx, 63, lz, grass);
      }
    }
  }
}

/** A 40-slot inventory with just enough behaviour to play. */
class SimpleInventory {
  constructor() {
    this.slots = new Array(36).fill(null);
    this.armorSlots = new Array(4).fill(null);
    this.offhand = null;
    this.selected = 0;
  }
  getSelected() { return this.slots[this.selected]; }
  setSelected(stack) { this.slots[this.selected] = stack; }
  getOffhand() { return this.offhand; }
  getArmor(i) { return this.armorSlots[i]; }
  addItem(stack) {
    if (!stack || stack.empty) return true;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (s && s.matches(stack) && s.count < s.maxStack) {
        const move = Math.min(stack.count, s.maxStack - s.count);
        s.count += move;
        stack.count -= move;
        if (stack.count <= 0) return true;
      }
    }
    for (let i = 0; i < this.slots.length; i++) {
      if (!this.slots[i]) { this.slots[i] = stack; return true; }
    }
    return false;
  }
  selectExisting(itemName) {
    for (let i = 0; i < 9; i++) {
      if (this.slots[i]?.item.name === itemName) { this.selected = i; return true; }
    }
    return false;
  }
}

/** A minimal crosshair + hotbar so the game is playable without ui/hud.js. */
class FallbackHud {
  constructor(game) { this.game = game; }
  render(ctx, w, h) {
    const p = this.game.player;
    ctx.save();
    // Crosshair
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#fff';
    ctx.fillRect(w / 2 - 5, h / 2 - 0.5, 10, 1);
    ctx.fillRect(w / 2 - 0.5, h / 2 - 5, 1, 10);
    ctx.globalCompositeOperation = 'source-over';

    // Hotbar
    const slot = 20, n = 9;
    const x0 = (w - slot * n) / 2, y0 = h - slot - 4;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x0 - 1, y0 - 1, slot * n + 2, slot + 2);
    for (let i = 0; i < n; i++) {
      ctx.strokeStyle = i === p.selectedSlot ? '#fff' : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = i === p.selectedSlot ? 2 : 1;
      ctx.strokeRect(x0 + i * slot + 0.5, y0 + 0.5, slot - 1, slot - 1);
      const st = p.inventory.slots?.[i];
      if (st) {
        ctx.fillStyle = '#fff';
        ctx.font = '7px sans-serif';
        ctx.textAlign = 'center';
        const label = st.item.displayName.split(' ').map((s) => s[0]).join('').slice(0, 3);
        ctx.fillText(label, x0 + i * slot + slot / 2, y0 + slot / 2 + 2);
        if (st.count > 1) {
          ctx.textAlign = 'right';
          ctx.fillText(String(st.count), x0 + i * slot + slot - 2, y0 + slot - 2);
        }
      }
    }
    ctx.textAlign = 'left';

    // Recent chat / system messages, fading out after ten seconds.
    const now = this.game.elapsed;
    ctx.font = '7px ui-monospace, Menlo, Consolas, monospace';
    ctx.textBaseline = 'bottom';
    let cy = y0 - 26;
    for (let i = this.game.chatLines.length - 1; i >= 0 && cy > 8; i--) {
      const line = this.game.chatLines[i];
      const age = now - line.time;
      if (age > 10) break;
      const a = age > 8 ? 1 - (age - 8) / 2 : 1;
      ctx.globalAlpha = a;
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(4, cy - 8, ctx.measureText(line.text).width + 4, 9);
      ctx.fillStyle = '#fff';
      ctx.fillText(line.text, 6, cy);
      ctx.globalAlpha = 1;
      cy -= 10;
    }
    ctx.textBaseline = 'alphabetic';

    // Health and hunger
    if (p.gamemode === 0) {
      ctx.fillStyle = '#e33';
      for (let i = 0; i < Math.ceil(p.health / 2); i++) {
        ctx.fillRect(x0 + i * 9, y0 - 12, 7, 7);
      }
      ctx.fillStyle = '#c86';
      for (let i = 0; i < Math.ceil(p.food / 2); i++) {
        ctx.fillRect(x0 + slot * n - 7 - i * 9, y0 - 12, 7, 7);
      }
    }
    ctx.restore();
  }
}

export { ChunkStreamer, SimpleInventory };
