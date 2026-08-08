namespace Astral;

public sealed class TrackerOptions
{
    public const string SectionName = "Tracker";

    /// <summary>
    /// How long a session may sit idle before it is treated as over.
    ///
    /// The session anchor is persisted so closing the app mid-session no longer
    /// throws the day's win/loss away. Without an expiry that cuts the other
    /// way, though: opening the app a week later would present a week of matches
    /// as "this session".
    /// </summary>
    public static readonly TimeSpan MaxSessionAge = TimeSpan.FromHours(12);

    /// <summary>
    /// When the current session was anchored. Null on a first run, and ignored
    /// once it is older than <see cref="MaxSessionAge"/>.
    /// </summary>
    public DateTimeOffset? SessionStartedAt { get; set; }
}
