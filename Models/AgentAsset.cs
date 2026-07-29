namespace Astral.Models;

public sealed record AgentAsset(
    string Name,
    string Value,
    string? Role,
    string? Portrait,
    string? Background,
    string[] Gradient,
    bool IsRightFacing
);
