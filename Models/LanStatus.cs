namespace Astral.Models;

/// <summary>
/// The /api/lan/status snapshot the "Open on phone" panel renders. `Token`
/// travels inside this response on purpose: the panel is the desktop's own
/// screen, reached over loopback, and the token is what lets it build the
/// phone URL and the QR. Loopback requests are never gated, so this stays a
/// trusted channel.
/// </summary>
public sealed record LanStatus(
    bool Enabled,
    int Port,
    string Token,
    IReadOnlyList<string> Ips,
    IReadOnlyList<string> Urls,
    bool FirewallRuleExists,
    bool FirewallPrivateProfileOn);

/// <summary>Turns LAN access on or off for this session.</summary>
public sealed record LanEnableRequest(bool Enabled);

/// <summary>
/// Adds or removes the inbound firewall rule. Only ever driven by an explicit
/// click in the panel, and the shell is asked to elevate, so the UAC prompt is
/// the consent for touching the firewall.
/// </summary>
public sealed record LanFirewallRequest(bool Add);