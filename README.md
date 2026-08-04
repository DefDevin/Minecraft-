# Minecraft

A voxel sandbox game written from scratch — no engine, no framework, no assets.
Every texture, sound and terrain feature is generated procedurally at runtime by
~56k lines of plain JavaScript talking directly to WebGL2 and Web Audio.

```
node scripts/serve.mjs
# open http://localhost:8080
```

No build step, no `npm install`. The browser loads the ES modules directly.

* `?seed=anything` — pick a world seed (text or a number)
* `?mode=creative` — start in creative mode

## Controls

| | |
|---|---|
| `W` `A` `S` `D` | move (double-tap `W` to sprint) |
| `Space` | jump — double-tap to fly in creative |
| `Shift` | sneak (you cannot walk off a ledge while sneaking) |
| `Ctrl` | sprint |
| Mouse | look; **left** breaks / attacks, **right** places / uses |
| `1`–`9`, wheel | select hotbar slot |
| `E` | inventory · `Q` drop (`Ctrl+Q` drops the stack) |
| `F` | pick block · `F5` cycle perspective |
| `F3` | debug overlay · `F11` fullscreen · `Esc` pause |

## On a phone or tablet

Touch is detected automatically: the game skips pointer lock, drops the render
distance and resolution to something a phone can push, and draws a control layer.

| | |
|---|---|
| Left half | drag anywhere for a virtual stick — push it to the edge to sprint |
| Right half | drag to look · **tap** to place/use · **hold** to mine |
| ▲ ▼ | jump · sneak (sneak toggles) |
| ⛏ | toggle continuous mining |
| ‹ › | previous / next hotbar slot |
| ☰ ⇅ ✈ | inventory · perspective · fly (creative) |

Your phone needs to reach the server, so start it on a computer on the same
network and browse to that machine's LAN address — `http://192.168.x.x:8080`,
not `localhost`. `scripts/serve.mjs` already listens on every interface.

## What is in it

**World.** Infinite terrain from a Minecraft 1.18-style noise stack:
continentalness, erosion and peaks-and-valleys noises run through splines to a
target height, then a 3D density function carves overhangs and cliffs. Caves
come in three flavours (cheese, spaghetti, noodle) with aquifers. Ores follow the
real y-distributions. The world runs from y=-64 to y=319 and streams in every
direction with no boundary.

**Biomes.** 63 of them, selected by a six-parameter multi-noise lookup, each
with its own surface rules, grass/foliage/water tints, mob spawn lists, features
and weather. Plus the Nether and the End as separate dimensions.

**Blocks.** 876 block types across 22,423 states, with real hardness, tool
requirements, blast resistance, light emission, flammability and sounds. States
are flattened to 16-bit ids exactly like modern Minecraft, so stairs know their
shape and redstone knows its connections.

**Items and crafting.** 1,213 items and 604 crafting recipes with tag
ingredients (one recipe covers all ten wood types), plus 90 smelting recipes
across furnace/blast furnace/smoker, stonecutting, netherite smithing and the
full brewing ingredient graph.

**Simulation.** Water and lava flow and interact; sand falls; fire spreads; crops
grow on hydrated farmland; leaves decay; grass spreads; ice forms and melts.
Redstone has dust with proper power decay, torches, repeaters with locking,
comparators, observers, pistons with the 12-block push limit, and a tick-ordered
update queue.

**Mobs.** 73 species with goal-based AI, A* pathfinding over the voxel grid,
natural spawning under Minecraft's real rules (pack spawning, light-level checks,
per-category caps, despawn distance), breeding, taming, shearing, milking and
trading — all rendered from box models whose skins are derived procedurally from
each model's own UV layout.

**Survival.** Health, hunger, saturation and exhaustion; armour with the real
damage-reduction formula; the full status-effect list; enchanting with bookshelf
power; anvils; brewing; experience; combat with attack cooldown, criticals,
sweep attacks and shields.

**Rendering.** Greedy-meshed chunks with baked ambient occlusion and per-vertex
light, a texture *array* (not an atlas, so there is no mip bleeding), a day/night
cycle with a moving sun and moon, moon phases, stars, drifting clouds, weather,
biome-blended fog, and a post pass for underwater tint, portal warp and vignette.

## Layout

```
src/core/       math, RNG, noise, input
src/world/      block registry, chunk storage, world, lighting,
                terrain generation, biomes, features, structures,
                redstone, fluids, block entities
src/render/     WebGL2 renderer, chunk mesher, shaders, procedural
                texture generation, particles, weather
src/entity/     entity system, physics, player, mob models and AI
src/game/       items, recipes, inventory, survival systems, UI, audio
scripts/        dev server and headless verification scripts
```

## Design notes

**Determinism.** Everything in world generation is derived by hashing
`(seed, x, y, z)` rather than drawing from a shared stream, so a chunk generates
identically whether you arrive from the north or the south, and structures never
depend on load order.

**Fixed timestep.** Simulation runs at 20 ticks per second — Minecraft's rate —
with the renderer interpolating between ticks. Movement feels identical at 30 fps
and 240 fps.

**No assets.** Textures are painted pixel by pixel into buffers at startup and
uploaded as a texture array. Sounds are synthesised from oscillators and noise
buffers. The entire game is the source code.

**Graceful degradation.** Content modules load independently. If one is missing,
or throws while registering, the game logs it once and runs with a reduced
feature set rather than failing to start — and a subsystem that throws during a
tick is disabled instead of failing twenty times a second.

## Known gaps

Honest accounting of what is not finished:

* **HUD and menus** run on the engine's built-in fallbacks — a working hotbar,
  hearts, hunger, chat and death screen, but not the full styled versions. The
  widget toolkit (`ui/screen.js`) and every container screen (`ui/containers.js`)
  are complete; the title screen, options screen and creative-inventory tabs are
  not wired up.
* **Weather rendering** (falling rain/snow geometry and lightning bolts) is
  missing. The weather *simulation* runs — rain and thunder cycles, sky and fog
  changes, `isRainingAt` — only the visual layer is absent.
* **Block textures** cover ~630 of the 697 names blocks reference. The Nether,
  End and redstone groups fall back to procedurally-derived colours, which look
  plausible but are not hand-pixelled.
* Terrain from the generator is noticeably terraced on slopes.

## Verification

Everything here runs offline; the browser tests drive a real headless Chromium.

```
node scripts/smoke.mjs        # boot the game, screenshot it, report fps/chunks/errors
node scripts/playtest.mjs     # drive the player through real gameplay and assert
node scripts/audit.mjs        # cross-check registries: missing textures, bad tools,
                              #   blocks with no model, unregistered drop items
node scripts/bench-mesher.mjs # time chunk meshing on synthetic terrain
node scripts/check-*.mjs      # per-subsystem unit tests
```

`playtest.mjs` is the acceptance suite: it walks, jumps, lands, breaks and places
blocks, checks that skylight reaches the surface and that caves are dark, spawns
and ticks mobs, runs power down a redstone line, emits particles, round-trips a
chunk through serialisation, and asserts the world actually changed each time.
