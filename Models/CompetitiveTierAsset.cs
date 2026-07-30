namespace Astral.Models;

/// <summary>One rank tier as valorant-api describes it.</summary>
public sealed record CompetitiveTierAsset(int Tier, string Name, string? Icon, string? Color);
