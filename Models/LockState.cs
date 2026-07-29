namespace Astral.Models;

public sealed record LockState(
    bool IsRunning,
    bool IsLocked,
    string? SelectedAgent,
    string Status,
    string? Error,
    DateTimeOffset UpdatedAt
);
