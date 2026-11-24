// Material presets (0.2.0). Densities in kg/m³ internally (the 0.1.x unit); g/cc = kg/m³ / 1000.
// Tungsten heavy alloy (W–Ni–Fe / W–Ni–Cu): 90–97 % W grades span about 17.0–18.5 g/cc.
export const MATERIALS = [
  { id: 'steel', name: 'Steel 7.85', rho: 7850 },
  { id: 'wha170', name: 'Tungsten heavy alloy 17.0', rho: 17000 },
  { id: 'wha176', name: 'Tungsten heavy alloy 17.6', rho: 17600 },
  { id: 'wha180', name: 'Tungsten heavy alloy 18.0', rho: 18000 },
  { id: 'wha185', name: 'Tungsten heavy alloy 18.5', rho: 18500 },
];
export const CUSTOM = 'custom';
export const preset = id => MATERIALS.find(m => m.id === id) || null;
export const gcc = rho => rho / 1000;
export const kgm3 = g => g * 1000;
// Preset whose density equals rho (kg/m³, to 1e-9), else 'custom'.
export const materialId = rho => MATERIALS.find(m => Math.abs(m.rho - rho) <= 1e-9 * m.rho)?.id ?? CUSTOM;
export const materialName = (id, rho) => preset(id)?.name ?? `Custom ${+gcc(rho).toPrecision(6)}`;
export const validRho = rho => Number.isFinite(rho) && rho > 0 && rho < 1e5;
// Apply a material choice to a body: a preset sets its density; 'custom' keeps (or sets) the typed density.
export function applyMaterial(b, id, rho = b.rho) {
  if (id === CUSTOM) { if (!validRho(rho)) return false; b.mat = CUSTOM; b.rho = rho; b.src = 'user'; return true; }
  const p = preset(id); if (!p) return false;
  b.mat = p.id; b.rho = p.rho; b.src = 'user'; return true;
}
// Added counterweight material: { mode: 'hub' | preset id | 'custom', rho? }. 'hub' (default) follows the
// hub body's material. Returns { rho, name } or null when it follows a hub that is not set.
export const ADDED_DEFAULT = Object.freeze({ mode: 'hub', rho: null });
export function addedMaterial(added, hub) {
  const a = added || ADDED_DEFAULT;
  if (a.mode === 'hub') return hub ? { rho: hub.rho, name: `${materialName(hub.mat ?? materialId(hub.rho), hub.rho)} (hub)`, follows: true } : null;
  if (a.mode === CUSTOM) return validRho(a.rho) ? { rho: a.rho, name: materialName(CUSTOM, a.rho), follows: false } : null;
  const p = preset(a.mode); return p ? { rho: p.rho, name: p.name, follows: false } : null;
}
export function normalizeAdded(a) {
  if (!a || typeof a !== 'object') return { ...ADDED_DEFAULT };
  if (a.mode === 'hub' || preset(a.mode)) return { mode: a.mode, rho: null };
  if (a.mode === CUSTOM && validRho(+a.rho)) return { mode: CUSTOM, rho: +a.rho };
  return { ...ADDED_DEFAULT };
}
