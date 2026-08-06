namespace Astral;

public sealed class AutoQueueOptions
{
    public const string SectionName = "AutoQueue";

    public const int MinDelayMs = 0;

    /// <summary>A minute is already far longer than the client needs to settle.</summary>
    public const int MaxDelayMs = 60000;

    public const int MinRequeues = 1;

    public const int MaxRequeues = 20;

    /// <summary>Re-enter the queue once a match ends and the client is back in the menus.</summary>
    public bool AutoRequeue { get; set; }

    /// <summary>
    /// Which queue to enter, as one of RadiantConnect's <c>QueueId</c> names
    /// ("competitive", "unrated", ...). Stored as a string so an unknown value
    /// from a newer build degrades to "unrecognised" instead of failing to load
    /// the whole settings file.
    /// </summary>
    public string QueueId { get; set; } = "competitive";

    /// <summary>Grace period after a match ends before requeueing.</summary>
    public int RequeueDelayMs { get; set; } = 5000;

    /// <summary>
    /// How many times in a row the tool may requeue on its own before stopping
    /// and saying so. The failure mode worth designing out is an unattended
    /// machine queueing all night, so this deliberately has a low default.
    /// </summary>
    public int MaxConsecutiveRequeues { get; set; } = 3;
}
