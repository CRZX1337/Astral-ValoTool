namespace Astral.Models;

/// <summary>
/// What the instalocker is doing right now.
///
/// <see cref="SelectedAgent"/> is the head of <see cref="SelectedAgents"/> while
/// the chain is merely armed, and the agent that actually got locked once one
/// has. It stays its own field because the documented <c>/api/state</c> shape has
/// always carried it.
/// </summary>
public sealed record LockState(
    bool IsRunning,
    bool IsLocked,
    string? SelectedAgent,
    IReadOnlyList<string> SelectedAgents,
    string Status,
    string? Error,
    DateTimeOffset UpdatedAt
);
