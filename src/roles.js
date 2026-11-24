// Body roles for the counterweight problem (0.2.0). One Hub and one Boundary at most; any number of existing
// Counterweight bodies; Ignore leaves a body out of the balance problem. '' (Part) is the 0.1.x behaviour:
// the body is just part of the assembly residuals.
//   hub      – the fixed rotating part to be balanced (exactly one is needed for the static readout)
//   boundary – the region the added counterweight must stay inside (one body; the hub is excluded from it)
//   cw       – existing counterweight geometry to check (check mode)
//   ignore   – not part of the balance problem (can still be picked as the orbiting load)
// Boundary and Ignore bodies are left out of the section-2 residuals (a boundary is a region, not material).
export const ROLES = [
  { id: '', label: 'Part', short: '', title: 'Part of the assembly residuals (no balance role)' },
  { id: 'hub', label: 'Hub', short: 'HUB', title: 'Fixed hub to balance (one)' },
  { id: 'boundary', label: 'Boundary', short: 'BND', title: 'Counterweight must stay inside this body (one); the hub is excluded' },
  { id: 'cw', label: 'Counterweight (existing)', short: 'CW', title: 'Existing counterweight to check (one or more)' },
  { id: 'ignore', label: 'Ignore', short: 'IGN', title: 'Left out of the balance problem' },
];
export const ROLE_IDS = new Set(ROLES.map(r => r.id));
export const SINGLE = new Set(['hub', 'boundary']);
export const roleOf = b => ROLE_IDS.has(b?.role) ? b.role : '';
// Set body i's role. A single-instance role (hub, boundary) is cleared from any other body that had it.
// Returns the indexes whose role was cleared.
export function setRole(bodies, i, role) {
  if (!ROLE_IDS.has(role)) throw new Error(`unknown role '${role}'`);
  const cleared = [];
  if (SINGLE.has(role)) bodies.forEach((b, j) => { if (j !== i && b.role === role) { b.role = ''; cleared.push(j); } });
  bodies[i].role = role;
  return cleared;
}
// After a session restore or an import: unknown roles → '', and only the first hub / boundary is kept.
export function normalizeRoles(bodies) {
  const seen = new Set(), notes = [];
  bodies.forEach((b, i) => {
    if (b.role != null && !ROLE_IDS.has(b.role)) { notes.push(`unknown role '${b.role}' on ${b.name} ignored`); b.role = ''; }
    b.role ??= '';
    if (SINGLE.has(b.role)) { if (seen.has(b.role)) { notes.push(`second ${b.role} (${b.name}) cleared`); b.role = ''; } else seen.add(b.role); }
  });
  return notes;
}
export function roleIndex(bodies) {
  const r = { hub: -1, boundary: -1, cw: [], ignore: [] };
  bodies.forEach((b, i) => { const k = roleOf(b); if (k === 'hub' || k === 'boundary') r[k] = i; else if (k) r[k].push(i); });
  return r;
}
// Bodies that count as material in the section-2 residuals.
export const inResiduals = b => b.on && roleOf(b) !== 'boundary' && roleOf(b) !== 'ignore';
