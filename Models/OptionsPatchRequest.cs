namespace Astral.Models;

/// <summary>
/// Every field is optional: <c>null</c> means "not supplied" and leaves the
/// current value untouched. Sending <c>mapAgentOverrides</c> replaces the whole
/// map, which is what lets the interface delete a rule.
/// </summary>
public sealed record OptionsPatchRequest(
    int? HoverDelayMs,
    int? LockDelayMs,
    int? PostLockDelayMs,
    Dictionary<string, string>? MapAgentOverrides
);
