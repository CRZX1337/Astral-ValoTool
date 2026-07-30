namespace Astral.Models;

/// <summary>What the auto-queue tool is doing, and what it is allowed to do.</summary>
public sealed record AutoQueueState(
    bool IsRunning,
    string Status,
    string? Error,
    string? PartyState,
    string? CurrentQueueId,
    IReadOnlyList<string> EligibleQueues,
    int ConsecutiveRequeues,
    bool LimitReached,
    DateTimeOffset UpdatedAt
);

/// <summary>The queue list the picker renders, with the currently selected one flagged.</summary>
public sealed record QueueOption(string Id, string Name);
