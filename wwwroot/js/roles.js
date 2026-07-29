/**
 * Role vocabulary shared by the grid, the filter bar and the control panel.
 *
 * `slug` is what ends up in a `data-role` attribute. styles.css defines one
 * accent trio per slug, so a new role means one more token block there -- no
 * extra selectors anywhere else.
 */

export const UNKNOWN_ROLE = "unknown";

const ROLE_ORDER = ["duelist", "initiator", "controller", "sentinel", UNKNOWN_ROLE];

const KNOWN_ROLES = new Set(ROLE_ORDER);

/** Agents the remote asset API does not know yet come back with `role: null`. */
export const UNKNOWN_ROLE_LABEL = "Unlisted";

export function roleSlug(role) {
  const slug = String(role ?? "").trim().toLowerCase();
  return KNOWN_ROLES.has(slug) ? slug : UNKNOWN_ROLE;
}

export function roleLabel(role) {
  const label = String(role ?? "").trim();
  return label.length > 0 ? label : UNKNOWN_ROLE_LABEL;
}

/** Keeps filter chips in the canonical Valorant order instead of load order. */
export function sortRoles(slugs) {
  return [...slugs].sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
}

/**
 * Initials for the fallback tile: "KAY/O" -> "KO", "Brimstone" -> "BR".
 */
export function monogram(name) {
  const parts = String(name ?? "")
    .split(/[\s/_-]+/)
    .filter(Boolean);

  if (parts.length > 1) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  return (parts[0] ?? "?").slice(0, 2).toUpperCase();
}

/**
 * valorant-api hands out gradients as 8 digit `RRGGBBAA` strings. Parsed into
 * channels so callers can dial in their own alpha.
 */
export function parseGradient(gradient) {
  if (!Array.isArray(gradient)) {
    return [];
  }

  return gradient.map(parseHexColor).filter(Boolean);
}

export function rgba(color, alpha = color.a) {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alpha.toFixed(3)})`;
}

function parseHexColor(value) {
  const hex = String(value ?? "").replace(/^#/, "").trim();

  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) {
    return null;
  }

  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
  };
}
