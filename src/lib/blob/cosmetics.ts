// Player-side cosmetic preferences. Pure visuals - none of this affects
// game physics, replay validation, or anything the node sees. Selections
// live in localStorage so they survive reloads; a tiny event bus lets the
// game loop pick up changes the moment the user clicks an option in the
// CosmeticsModal, without re-mounting the component or doing prop drilling.
//
// Each category has a registry of options exported from its own file
// (backgrounds, skins, obstacles). The cosmetics module itself only deals
// in IDs - the actual draw functions live next to the data.

export type CosmeticCategory = "background" | "skin" | "obstacles";

export type CosmeticSelection = {
  background: string;
  skin: string;
  obstacles: string;
};

const STORAGE_KEY = "blob.cosmetics.v1";

// Defaults match the IDs registered in the corresponding registries below.
// If a stored value points at a deleted/renamed option, we fall back to
// these so the game never crashes on a missing key.
const DEFAULTS: CosmeticSelection = {
  background: "obsidian",
  skin: "default",
  obstacles: "default",
};

let current: CosmeticSelection = { ...DEFAULTS };
let loaded = false;

function loadFromStorage(): CosmeticSelection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<CosmeticSelection>;
    return {
      background: typeof parsed.background === "string" ? parsed.background : DEFAULTS.background,
      skin:       typeof parsed.skin       === "string" ? parsed.skin       : DEFAULTS.skin,
      obstacles:  typeof parsed.obstacles  === "string" ? parsed.obstacles  : DEFAULTS.obstacles,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveToStorage(sel: CosmeticSelection) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sel));
  } catch { /* quota / private mode — ignore, runtime state still updates */ }
}

// Tiny pub-sub. Subscribers fire on any change so the game loop can re-fetch
// the active drawer functions without re-rendering React.
const listeners = new Set<(sel: CosmeticSelection) => void>();

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  current = loadFromStorage();
}

export function getCosmetics(): CosmeticSelection {
  ensureLoaded();
  return current;
}

export function setCosmetic<K extends CosmeticCategory>(key: K, value: string) {
  ensureLoaded();
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  saveToStorage(current);
  for (const fn of listeners) fn(current);
}

export function subscribeCosmetics(fn: (sel: CosmeticSelection) => void): () => void {
  ensureLoaded();
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
