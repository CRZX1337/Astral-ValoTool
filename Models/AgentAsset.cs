namespace Astral.Models;

/// <summary>
/// Agent artwork from valorant-api.com, keyed by the display-name slug.
/// <see cref="Uuid"/> is Riot's character id for the agent (lowercase), the
/// same id match history carries, so the UI can resolve a match's agent
/// against the catalogue. Null only when the enriched source did not provide
/// one.
/// </summary>
public sealed record AgentAsset(
    string Name,
    string Value,
    string? Role,
    string? Portrait,
    string? Background,
    string[] Gradient,
    bool IsRightFacing,
    string? Uuid = null
);
