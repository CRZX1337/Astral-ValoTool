namespace Astral.Models;

/// <summary>
/// Partial update, same contract as <see cref="OptionsPatchRequest"/>:
/// <c>null</c> means "not supplied" and leaves the current value alone.
/// </summary>
public sealed record AutoQueuePatchRequest(
    bool? AutoRequeue,
    string? QueueId,
    int? RequeueDelayMs,
    int? MaxConsecutiveRequeues
);

/// <summary>Enter or leave the queue right now, independent of the automation.</summary>
public sealed record QueueingRequest(bool Queueing);

/// <summary>Auto-queue settings plus the reference data the picker needs.</summary>
public sealed record AutoQueueOptionsResponse(
    bool AutoRequeue,
    string QueueId,
    int RequeueDelayMs,
    int MaxConsecutiveRequeues,
    IReadOnlyList<QueueOption> Queues
);
