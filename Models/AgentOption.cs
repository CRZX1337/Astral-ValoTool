namespace Astral.Models;

/// <summary>
/// One selectable agent. <see cref="Uuid"/> is Riot's character id for the
/// agent, in lowercase -- it is how match history and pre-game identify a
/// pick, so carrying it here is what lets the UI resolve a match's agent
/// against this list.
/// </summary>
public sealed record AgentOption(string Name, string Value, string? Uuid = null);
