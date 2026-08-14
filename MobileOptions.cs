namespace Astral;

/// <summary>
/// Defaults for the LAN companion, read from the "Mobile" section of
/// appsettings.json. The enable/disable switch itself is session-scoped and
/// lives in memory (LanCompanionService), so flipping it from the "Open on
/// phone" panel needs no restart -- this section only says what the app
/// starts with.
/// </summary>
public sealed class MobileOptions
{
    public const string SectionName = "Mobile";

    /// <summary>
    /// Whether non-loopback clients may reach the API at all. Off by default:
    /// opening the server to the network is an explicit, deliberate act, and
    /// anything else would expose the tool to the coffee shop's Wi-Fi.
    /// </summary>
    public bool LanEnabled { get; set; }
}