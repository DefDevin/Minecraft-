// The colour table every block painter draws from.
//
// Painters get their *shapes* from code and their *hues* from here, which is
// what keeps a hundred-odd stone variants looking like they came out of the
// same tin of paint. Values are packed 0xRRGGBB and were picked to sit in the
// same families as vanilla Minecraft: the sixteen dyes, the stone greys, the
// wood browns, the ore minerals, the Nether reds and the End pale yellows.
//
// Two conventions matter for correctness rather than taste:
//
//  * Anything the shader multiplies by a biome colour (grass tops, foliage,
//    water) is stored *desaturated and light* — `grass.neutral` and
//    `foliage.neutral` below. Baking a saturated green into those and then
//    multiplying again gives the muddy over-saturated look that plagues
//    hand-made resource packs.
//  * Faces that vanilla tints with a separate overlay quad but we bake into the
//    base texture (the grass fringe on `grass_block_side`) use the *tinted*
//    colours — `grass.fringe` — because nothing multiplies them later.

// ---------------------------------------------------------------------------
// The sixteen dye colours
// ---------------------------------------------------------------------------

/** Canonical order, matching COLORS in world/blockdefs/data.js. */
export const DYE_ORDER = Object.freeze([
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
]);

/** The dye item colours — also the tint applied to leather, water and beacons. */
const dye = {
  white: 0xf9fffe, orange: 0xf9801d, magenta: 0xc74ebd, light_blue: 0x3ab3da,
  yellow: 0xfed83d, lime: 0x80c71f, pink: 0xf38baa, gray: 0x474f52,
  light_gray: 0x9d9d97, cyan: 0x169c9c, purple: 0x8932b8, blue: 0x3c44aa,
  brown: 0x835432, green: 0x5e7c16, red: 0xb02e26, black: 0x1d1d21,
};

/** Wool: the dye colour softened, since the fibres scatter light. */
const wool = {
  white: 0xe9ecec, orange: 0xf07613, magenta: 0xbd44b3, light_blue: 0x3aafd9,
  yellow: 0xf8c627, lime: 0x70b919, pink: 0xed8dac, gray: 0x3e4447,
  light_gray: 0x8e8e86, cyan: 0x158991, purple: 0x8932b8, blue: 0x3c44aa,
  brown: 0x835432, green: 0x5e7c16, red: 0xb02e26, black: 0x1d1d21,
};

/** Concrete: flat, hard and the most saturated of the three families. */
const concrete = {
  white: 0xcfd5d6, orange: 0xe06101, magenta: 0xa9309f, light_blue: 0x2489c7,
  yellow: 0xf1af15, lime: 0x5ea918, pink: 0xd6658f, gray: 0x36393d,
  light_gray: 0x7d7d73, cyan: 0x157788, purple: 0x64209c, blue: 0x2c2e8f,
  brown: 0x603c20, green: 0x495b24, red: 0x8e2121, black: 0x080a0f,
};

/** Concrete powder: the same pigment before it sets — lighter and chalkier. */
const concretePowder = {
  white: 0xe2e4e4, orange: 0xe3821e, magenta: 0xc154b6, light_blue: 0x4bacd6,
  yellow: 0xe5c21c, lime: 0x7ac81c, pink: 0xe3a0b6, gray: 0x4e5157,
  light_gray: 0x9b9b95, cyan: 0x24889b, purple: 0x7f30b0, blue: 0x3b3ea5,
  brown: 0x7a5232, green: 0x5f7327, red: 0xa72e2a, black: 0x191b20,
};

/** Stained terracotta: every hue dragged toward the same fired-clay brown. */
const terracotta = {
  white: 0xd1b1a1, orange: 0xa15325, magenta: 0x95576c, light_blue: 0x706c8a,
  yellow: 0xba8524, lime: 0x677535, pink: 0xa14e4e, gray: 0x392a24,
  light_gray: 0x876b62, cyan: 0x575b5b, purple: 0x764656, blue: 0x4a3b5b,
  brown: 0x4d3323, green: 0x4c522a, red: 0x8e3c2e, black: 0x251610,
};

/** Glazed terracotta: a bright glaze over a pale slip, drawn as a pattern. */
const glaze = {
  white: 0xbcd4cd, orange: 0xe9a83a, magenta: 0xd06ec2, light_blue: 0x6a9fd4,
  yellow: 0xead67f, lime: 0xa6c34c, pink: 0xeaa2b7, gray: 0x545c5f,
  light_gray: 0xa8aca4, cyan: 0x35707c, purple: 0x8b52c4, blue: 0x3b4a9e,
  brown: 0x8a6a48, green: 0x7a8c4b, red: 0xa4453c, black: 0x37292c,
};

/** Stained glass: the dye at high value so light still reads through it. */
const stainedGlass = {
  white: 0xffffff, orange: 0xd87f33, magenta: 0xb24cd8, light_blue: 0x6699d8,
  yellow: 0xe5e533, lime: 0x7fcc19, pink: 0xf27fa5, gray: 0x4c4c4c,
  light_gray: 0x999999, cyan: 0x4c7f99, purple: 0x7f3fb2, blue: 0x334cb2,
  brown: 0x664c33, green: 0x667f33, red: 0x993333, black: 0x191919,
};

/** Shulker box shells: the dye lightened toward the undyed purple shell. */
const shulker = {
  white: 0xd8d8d8, orange: 0xd0761b, magenta: 0xa73da2, light_blue: 0x3d9bc4,
  yellow: 0xdfb427, lime: 0x66a521, pink: 0xd67f9c, gray: 0x3b4145,
  light_gray: 0x8b8b83, cyan: 0x1e7d84, purple: 0x77339e, blue: 0x363c92,
  brown: 0x6f4829, green: 0x53691a, red: 0x983029, black: 0x22222a,
};

// ---------------------------------------------------------------------------
// Stone and rock
// ---------------------------------------------------------------------------

const stone = {
  stone: 0x7a7a7a,
  smooth: 0x9a9a9a,
  cobble: 0x7d7d7d,
  cobbleDark: 0x5b5b5b,
  mortar: 0x4f4f4f,
  brick: 0x7b7b7b,
  gravel: 0x83807e,
  clay: 0xa4a8b8,
  bedrock: 0x565656,
  granite: 0x9a6650,
  granitePolished: 0xa77863,
  graniteFleck: 0xc09a86,
  diorite: 0xcfcfcf,
  dioritePolished: 0xd4d5d6,
  dioriteDark: 0x9a9a9a,
  andesite: 0x8b8b8d,
  andesitePolished: 0x999a9b,
  andesiteDark: 0x6e6f72,
  deepslate: 0x585859,
  deepslateDark: 0x3b3b40,
  cobbledDeepslate: 0x4e4e51,
  polishedDeepslate: 0x484849,
  deepslateBrick: 0x4a4a4d,
  deepslateTile: 0x36363a,
  tuff: 0x6d6f65,
  tuffDark: 0x4f5148,
  calcite: 0xdfe0db,
  dripstone: 0x866b5c,
  basalt: 0x51515c,
  basaltDark: 0x2e2e37,
  smoothBasalt: 0x48484e,
  blackstone: 0x2b2529,
  blackstoneDark: 0x18141a,
  obsidian: 0x120c1c,
  obsidianCry: 0x24135b,
  moss: 0x5b7a2e,
  mossDark: 0x3f5a20,
  sculk: 0x0f2c33,
  sculkVein: 0x143f47,
  sculkGlow: 0x28c1b7,
  reinforced: 0x3d3d40,
  amethyst: 0xa07de0,
  amethystDeep: 0x6b46a8,
  amethystBud: 0xc0a2f0,
  prismarine: 0x639a8f,
  prismarineDark: 0x35544f,
  prismarineBrick: 0x5b9e91,
  quartz: 0xeae5de,
  quartzDark: 0xd4cdc3,
};

// ---------------------------------------------------------------------------
// Soil, sand and the tinted surfaces
// ---------------------------------------------------------------------------

const soil = {
  dirt: 0x866043,
  dirtLight: 0x9c744f,
  dirtDark: 0x66452f,
  coarse: 0x7c5a3e,
  rooted: 0x906a4c,
  root: 0xc0a074,
  podzol: 0x50331a,
  podzolTop: 0x6f4d22,
  podzolOrange: 0x8f5e21,
  mycelium: 0x6f6265,
  myceliumTop: 0x7b6b73,
  myceliumSpore: 0x9c8b93,
  path: 0x8f7a4a,
  farmland: 0x6f4c2c,
  farmlandWet: 0x462b16,
  mud: 0x3c3134,
  packedMud: 0x8f6b4e,
  mudBrick: 0x8a6244,
  sand: 0xdbd3a0,
  sandDark: 0xc5bb86,
  redSand: 0xbe6621,
  redSandDark: 0xa4551a,
  sandstone: 0xdbcf9c,
  sandstoneTop: 0xe6dcae,
  sandstoneDark: 0xb8a874,
  redSandstone: 0xb3601c,
  redSandstoneTop: 0xc2712c,
  redSandstoneDark: 0x954c14,
  snow: 0xf2fbfb,
  snowShade: 0xd6e5ec,
  ice: 0x91b8f2,
  iceLight: 0xb9d6fb,
  packedIce: 0x8fabf0,
  blueIce: 0x76a4f7,
  powderSnow: 0xf5fbff,
};

/**
 * Grass. `neutral` is what the shader multiplies by the biome colour, so it is
 * deliberately pale and barely green. `fringe` is already tinted and is used
 * where nothing multiplies afterwards (the baked side fringe).
 */
const grass = {
  neutral: 0xbcc6ac,
  neutralDark: 0xa2ac93,
  fringe: 0x74a842,
  fringeDark: 0x5b8a31,
  fringeLight: 0x8dbd58,
};

/** Foliage — leaves, vines, lily pads. Same neutral-multiply rule as grass. */
const foliage = {
  neutral: 0xa8b894,
  neutralDark: 0x8b9a78,
  neutralLight: 0xc0cda9,
  spruce: 0x4e6f3f,
  spruceDark: 0x3b5730,
  birch: 0x7f9f52,
  birchDark: 0x67853f,
  cherry: 0xecafc7,
  cherryDark: 0xd490ad,
  azalea: 0x5f8a3d,
  azaleaFlower: 0xd579b0,
  flowering: 0xc06fa8,
};

// ---------------------------------------------------------------------------
// Wood
// ---------------------------------------------------------------------------

/** planks / bark / barkDark / core (log end) / stripped, per species. */
const wood = {
  oak: { planks: 0xb08b56, bark: 0x6b5334, barkDark: 0x4a3821, core: 0xa9814e, stripped: 0xb59259 },
  spruce: { planks: 0x775a35, bark: 0x3b2c1a, barkDark: 0x261b0f, core: 0x6a4f30, stripped: 0x7a5c33 },
  birch: { planks: 0xd7c185, bark: 0xd3cfc4, barkDark: 0x4f4a3f, core: 0xc8b47c, stripped: 0xc8ac6a },
  jungle: { planks: 0xa8785a, bark: 0x574a2a, barkDark: 0x3a3018, core: 0x9c7b53, stripped: 0xb28459 },
  acacia: { planks: 0xba6337, bark: 0x6c6153, barkDark: 0x494036, core: 0xad5d32, stripped: 0xb1662b },
  dark_oak: { planks: 0x4b3418, bark: 0x3b2d1d, barkDark: 0x241a0f, core: 0x392710, stripped: 0x574122 },
  mangrove: { planks: 0x773932, bark: 0x54372a, barkDark: 0x33211a, core: 0x6d3229, stripped: 0x7a3a35 },
  cherry: { planks: 0xe0b6ab, bark: 0x3b2a2f, barkDark: 0x241a1e, core: 0xd6a09a, stripped: 0xd6a09a },
  crimson: { planks: 0x6a344b, bark: 0x7b3850, barkDark: 0x4d2438, core: 0x8c3a52, stripped: 0x883956 },
  warped: { planks: 0x2b7168, bark: 0x397b74, barkDark: 0x1f4f4c, core: 0x3a8e8c, stripped: 0x399a92 },
};

// ---------------------------------------------------------------------------
// Ores and minerals
// ---------------------------------------------------------------------------

/** Each mineral gets a mid, a highlight and a shadow so blobs read as lumps. */
const ore = {
  coal: { mid: 0x1a1a1a, light: 0x3d3d3d, dark: 0x000000 },
  iron: { mid: 0xd8af93, light: 0xf0d0b8, dark: 0xa07a62 },
  copper: { mid: 0xe07a3f, light: 0xf4a566, dark: 0xa5522a },
  gold: { mid: 0xfcee4b, light: 0xfff9a8, dark: 0xc9a51c },
  redstone: { mid: 0xc21c1c, light: 0xff4b3a, dark: 0x7a0d0d },
  lapis: { mid: 0x2e5cc4, light: 0x5f8ce8, dark: 0x1a3782 },
  diamond: { mid: 0x4fe6e0, light: 0xa8f7f4, dark: 0x2b9c98 },
  emerald: { mid: 0x17c65b, light: 0x62f299, dark: 0x0c8a3c },
  quartz: { mid: 0xeae5de, light: 0xfffaf3, dark: 0xb8b0a4 },
  netherGold: { mid: 0xfcd94b, light: 0xfff2a0, dark: 0xc79c15 },
  debris: { mid: 0x6a4d43, light: 0x8d6a5c, dark: 0x3f2b26 },
};

/** Solid mineral blocks. */
const metal = {
  iron: 0xdcdcdc,
  ironDark: 0xa8a8a8,
  gold: 0xf9ec4e,
  goldDark: 0xcbb922,
  diamond: 0x63e6e0,
  diamondDark: 0x35a9a4,
  emerald: 0x2ed163,
  emeraldDark: 0x189343,
  lapis: 0x2c53b7,
  lapisDark: 0x1a3480,
  redstone: 0xab1c1c,
  redstoneDark: 0x730f0f,
  coal: 0x111111,
  coalDark: 0x040404,
  netherite: 0x413a3c,
  netheriteDark: 0x282124,
  copper: 0xc06a3a,
  copperCut: 0xc1663a,
  exposed: 0xa07c62,
  exposedCut: 0x9b7a62,
  weathered: 0x6f9772,
  weatheredCut: 0x6d9673,
  oxidized: 0x4e9e7c,
  oxidizedCut: 0x53a081,
  patina: 0x54a586,
  rawIron: 0xbb8a63,
  rawGold: 0xdb9f36,
  rawCopper: 0xa9613a,
};

// ---------------------------------------------------------------------------
// The Nether
// ---------------------------------------------------------------------------

const nether = {
  netherrack: 0x7a3b39,
  netherrackDark: 0x5a2626,
  netherrackLight: 0x944a46,
  brick: 0x2e161a,
  brickLight: 0x3d2026,
  brickMortar: 0x1c0d10,
  redBrick: 0x460709,
  redBrickLight: 0x5d0d10,
  soulSand: 0x53423a,
  soulSoil: 0x4a3931,
  soulFace: 0x33241d,
  soulFire: 0x2ad3e6,
  soulFireDeep: 0x0b6fa0,
  magma: 0x8e3a12,
  magmaHot: 0xf59b28,
  glowstone: 0xd0a55a,
  glowstoneHot: 0xffe9a8,
  shroomlight: 0xf0873a,
  shroomlightHot: 0xffd28a,
  crimsonNylium: 0x8f2222,
  crimsonNyliumTop: 0xa32a2a,
  warpedNylium: 0x1f7168,
  warpedNyliumTop: 0x2c8a7f,
  wartBlock: 0x71090a,
  wartBlockLight: 0x9c1a17,
  warpedWart: 0x167e86,
  warpedWartLight: 0x22a3a0,
  netherWart: 0x8c1b1b,
  portal: 0x8b34d6,
  portalDeep: 0x3a0d63,
  fire: 0xf5a623,
  fireHot: 0xffe38a,
  fireDeep: 0xc32d0c,
  gilded: 0xe4b83a,
  ancientDebris: 0x5a3f38,
};

// ---------------------------------------------------------------------------
// The End
// ---------------------------------------------------------------------------

const end = {
  stone: 0xdbdd9e,
  stoneDark: 0xb9bb79,
  brick: 0xd8dd9d,
  brickMortar: 0xa8ad72,
  purpur: 0xa974a9,
  purpurLight: 0xc196c1,
  purpurDark: 0x83568a,
  chorus: 0x8b658b,
  chorusFlower: 0xd2c9d2,
  dragonEgg: 0x0d0d12,
  dragonEggEdge: 0x2a1a3a,
  portal: 0x0b0b1a,
  portalStar: 0xb9f5ea,
  rod: 0xe9e6d8,
  rodGlow: 0xd8b8f0,
};

// ---------------------------------------------------------------------------
// Plants, fluids and everything else
// ---------------------------------------------------------------------------

const plant = {
  stem: 0x5d8f38,
  stemDark: 0x44692a,
  wheat: 0xdcbb65,
  wheatYoung: 0x6f9c3c,
  carrotTop: 0x2f7a2a,
  carrot: 0xff8c1a,
  potatoTop: 0x3d8a33,
  potato: 0xd8c06a,
  beetTop: 0x4a8a34,
  beet: 0xa32424,
  cactus: 0x4a7a2c,
  cactusTop: 0x5c8f37,
  cactusSpine: 0xd8e6c0,
  sugarCane: 0x94c17a,
  bamboo: 0x7fa93a,
  bambooDark: 0x5d7f28,
  kelp: 0x3f6b2a,
  kelpDark: 0x2c4d1d,
  driedKelp: 0x35462c,
  seagrass: 0x3f8a3a,
  lilyPad: 0xa8c880,
  vine: 0x9ab87a,
  melonSkin: 0x3d7a1e,
  melonStripe: 0x6f9c34,
  melonFlesh: 0xd94f4f,
  pumpkin: 0xc4741a,
  pumpkinDark: 0x8f4f10,
  pumpkinStem: 0x6d5028,
  jackFlame: 0xffd76b,
  hay: 0xc2a02a,
  hayDark: 0x8f7418,
  mushroomBrown: 0x9c7050,
  mushroomRed: 0xc23a30,
  mushroomStem: 0xcfc9b8,
  mushroomPore: 0xc39a72,
  berry: 0xd42a2a,
  berryLeaf: 0x4a7a2c,
  cocoa: 0x8f5a24,
  sponge: 0xc2b845,
  spongeWet: 0x8f8a35,
  slime: 0x76c05a,
  honey: 0xf0a81f,
  honeycomb: 0xd8862a,
  cobweb: 0xdcdcdc,
  deadBush: 0x94663a,
  dripleaf: 0x6f9c3f,
  dripleafStem: 0x5c7f34,
  glowLichen: 0x7fa796,
  glowBerry: 0xffb648,
  sporeBlossom: 0xd45f9c,
  root: 0xa07a52,
};

const flower = {
  dandelion: 0xf6e32c, dandelionStem: 0x4d8a2c,
  poppy: 0xd52b2b,
  blueOrchid: 0x2fb0d8,
  allium: 0xb475e0,
  azureBluet: 0xf0f0f0, azureBluetCore: 0xe8d84a,
  redTulip: 0xd42a2a, orangeTulip: 0xe07a1a, whiteTulip: 0xecf2ec, pinkTulip: 0xeaa8cf,
  oxeye: 0xf2f2e8, oxeyeCore: 0xf0e04a,
  cornflower: 0x4f6fd8,
  lilyOfTheValley: 0xf4f8f4,
  witherRose: 0x231f22, witherRoseStem: 0x2f2a2c,
  torchflower: 0xf07a2a, torchflowerCore: 0xffd45c,
  sunflower: 0xf5d32a, sunflowerCore: 0xd8901a,
  lilac: 0xd0a8dc,
  roseBush: 0xcf3a3a,
  peony: 0xe8c0e8,
  pitcher: 0x8f5ec4,
};

const liquid = {
  // Water is multiplied by the biome water colour, so keep it near-neutral.
  water: 0xb6c8f0,
  waterDeep: 0x8fa6dc,
  waterFoam: 0xdfe8ff,
  lava: 0xd45a12,
  lavaHot: 0xffcc4a,
  lavaCool: 0x8f2f08,
};

const misc = {
  glass: 0xd8f0ff,
  glassEdge: 0xf4fdff,
  tintedGlass: 0x3a3038,
  torchWood: 0x8f6a3a,
  torchFlame: 0xffe07a,
  torchGlow: 0xf5a623,
  soulTorchFlame: 0x53e2f2,
  redstoneOn: 0xf03030,
  redstoneOff: 0x6a1010,
  iron: 0xbcbcbc,
  ironDark: 0x8a8a8a,
  ironLight: 0xdedede,
  chestWood: 0xa06a2c,
  chestDark: 0x6f4718,
  chestLatch: 0xd8c05a,
  enderChest: 0x1e2e2e,
  enderPearl: 0x2ad4c0,
  spawner: 0x2a2f38,
  spawnerDark: 0x171b21,
  bookRed: 0xa03a2a, bookGreen: 0x3a7a3a, bookBlue: 0x3a4f9c, bookYellow: 0xc9a72a,
  paper: 0xe8e0c8,
  leather: 0x8f6a3a,
  tnt: 0xd83a2a,
  tntBand: 0xe8e8e8,
  noteBlock: 0x5a3a24,
  noteDot: 0x2a1a10,
  jukebox: 0x4d3722,
  jukeboxTop: 0x9a6a3a,
  piston: 0xb99a5e,
  pistonSticky: 0x8fa83f,
  pistonBody: 0x9a9a9a,
  furnaceStone: 0x7a7a7a,
  furnaceMouth: 0x2e2e2e,
  furnaceFire: 0xf0921a,
  target: 0xe8e0d0,
  targetRing: 0xd83a2a,
  beacon: 0x69dbd0,
  beaconGlass: 0x8ff0ea,
  seaLantern: 0xafd3c8,
  seaLanternGlow: 0xe4f5ef,
  conduit: 0x9f8a6a,
  conduitEye: 0xf5b02a,
  enchant: 0x2e2434,
  enchantCloth: 0xa02a2a,
  enchantGem: 0xd8f0f5,
  bone: 0xe0ddc8,
  boneDark: 0xb5b09a,
  scaffold: 0xc7a866,
  scaffoldRope: 0x8f7a3a,
  lantern: 0xd8952a,
  chain: 0x494f56,
  anvil: 0x4a4a4a,
  anvilDark: 0x333333,
  grindstone: 0x8a8a8a,
  composter: 0x6a4b28,
  compost: 0x5f7a2c,
  cake: 0xf2ecd8,
  cakeTop: 0xf9f4e2,
  cakeInner: 0xe8b0b0,
  cakeBerry: 0xc23a3a,
  flowerPot: 0xa5583a,
  honeyBlock: 0xf0a81f,
  smithing: 0x3a3a42,
  loomThread: 0xd8c9a0,
  lodestone: 0x8a8f96,
  respawnAnchor: 0x2b2440,
  respawnAnchorGlow: 0xd35bf5,
  frostedIce: 0xa8cdfb,
  rail: 0xa08050,
  railMetal: 0xa8a8a8,
  railPowered: 0xd8a52a,
  railDetector: 0xc0c0c0,
  railActivator: 0x8a8a8a,
  tripwire: 0xd0d0d0,
  crack: 0x000000,
};

// ---------------------------------------------------------------------------

/**
 * The whole table. Grouped rather than flat so a painter can pull a family
 * (`PALETTE.wood.birch`) and stay coherent across the six faces of a block.
 */
export const PALETTE = Object.freeze({
  dye, wool, concrete, concretePowder, terracotta, glaze, stainedGlass, shulker,
  stone, soil, grass, foliage, wood, ore, metal, nether, end,
  plant, flower, liquid, misc,
});

/** Look up a dyed family by colour name, e.g. `dyed('wool', 'red')`. */
export const dyed = (family, color) => PALETTE[family][color];

export default PALETTE;
