namespace Astral.Models;

/// <summary>
/// Current settings plus the map list they can refer to. The reference data
/// travels with the settings so the interface renders its panel from a single
/// request.
/// </summary>
public sealed record OptionsResponse(
    int HoverDelayMs,
    int LockDelayMs,
    int PostLockDelayMs,
    IReadOnlyDictionary<string, string> MapAgentOverrides,
    IReadOnlyList<string> Maps
);
