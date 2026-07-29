namespace Astral;

public sealed class InstalockerOptions
{
    public const string SectionName = "Instalocker";

    /// <summary>Smallest and largest accepted value for every delay, in milliseconds.</summary>
    public const int MinDelayMs = 0;

    public const int MaxDelayMs = 10000;

    public int PostLockDelayMs { get; set; } = 5000;

    public int HoverDelayMs { get; set; }

    public int LockDelayMs { get; set; }

    /// <summary>
    /// Agent to lock per map, keyed by map <em>display</em> name ("Ascent").
    /// RadiantConnect exposes roughly 40 map ids that collapse onto far fewer
    /// names -- a uuid plus an internal codename such as "Bonsai" for Split --
    /// and which of them pre-game reports is not guaranteed, so the display
    /// name is the only stable key.
    /// </summary>
    public Dictionary<string, string> MapAgentOverrides { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}
