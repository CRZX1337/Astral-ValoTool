/* Self-refining download CTA.

   The markup already points at /releases/latest, which works with no scripting
   at all. This asks GitHub for the current release and, if it carries an .exe,
   rewrites the button to link the asset directly and name its version and
   size. A new release is picked up with no commit here.

   Everything fails closed: any error, timeout or rate-limit leaves the
   authored CTA exactly as it shipped. */

const API = "https://api.github.com/repos/CRZX1337/Astral-ValoTool/releases/latest";
const CACHE_KEY = "astral:release";
const TIMEOUT = 3000;

function formatSize(bytes) {
  const mb = bytes / 1024 / 1024;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

function upgrade(release) {
  const asset = release.assets?.find((item) => item.name?.toLowerCase().endsWith(".exe"));
  if (!asset?.browser_download_url) return;

  for (const cta of document.querySelectorAll("[data-release-cta]")) {
    const label = cta.querySelector("[data-release-label]") ?? cta;
    const parts = ["Download Astral.exe"];
    if (release.tag_name) parts.push(release.tag_name);
    if (asset.size) parts.push(formatSize(asset.size));

    label.textContent = parts.join(" · ");
    cta.href = asset.browser_download_url;
  }
}

export async function initRelease() {
  if (!document.querySelector("[data-release-cta]")) return;

  /* Cached for the session so navigating around doesn't spend rate limit. */
  const cached = sessionStorage.getItem(CACHE_KEY);
  if (cached) {
    try {
      return upgrade(JSON.parse(cached));
    } catch {
      sessionStorage.removeItem(CACHE_KEY);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    /* No token, ever -- anything shipped here is public. Unauthenticated is
       60 requests/hour/IP, and exhausting it simply leaves the CTA alone. */
    const response = await fetch(API, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });

    /* 404 is the expected answer while the repo has no releases. */
    if (!response.ok) return;

    const release = await response.json();
    if (release.draft || release.prerelease) return;

    sessionStorage.setItem(CACHE_KEY, JSON.stringify(release));
    upgrade(release);
  } catch {
    /* Offline, blocked, aborted, rate-limited: keep the authored CTA. */
  } finally {
    clearTimeout(timer);
  }
}
