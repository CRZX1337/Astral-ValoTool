using System.Text.Json.Serialization;

namespace Astral.Models;

/// <summary>
/// One player in the pre-game lobby, as far as your own client can see them.
///
/// Every field here comes out of the pre-game payload Riot already sent to your
/// machine. Nothing is looked up against another account.
/// </summary>
public sealed record LobbyPlayer(
    int Slot,
    bool IsSelf,
    bool IsCaptain,
    string? Name,
    bool IsIncognito,
    string? AgentName,
    string? AgentPortrait,
    string? AgentRole,
    LobbyPickState PickState,
    int Tier,
    string TierName,
    string? TierIcon,
    string? TierColor
);

/// <summary>
/// How far through picking an agent a player has got.
///
/// Serialised by name rather than by ordinal, so the wire format says
/// <c>"Locked"</c> and stays readable if a state is ever inserted in the middle.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<LobbyPickState>))]
public enum LobbyPickState
{
    /// <summary>No agent hovered yet.</summary>
    None,

    /// <summary>Hovering an agent, still able to change their mind.</summary>
    Hovering,

    /// <summary>Locked in.</summary>
    Locked
}

/// <summary>
/// A snapshot of the pre-game lobby.
///
/// <see cref="IsActive"/> separates "we looked and there is no pre-game" from
/// "we could not look", which is what <see cref="Error"/> is for. The UI needs
/// to tell those apart to avoid showing a stale roster as if it were live.
/// </summary>
public sealed record LobbyIntel(
    bool IsWatching,
    bool IsActive,
    string? MapName,
    string? MapId,
    IReadOnlyList<LobbyPlayer> Players,
    int LockedCount,
    double? SecondsRemaining,
    string Status,
    string? Error,
    DateTimeOffset? UpdatedAt
)
{
    /// <summary>The idle snapshot, before anything has been read.</summary>
    public static LobbyIntel Idle(bool isWatching = false) => new(
        isWatching,
        IsActive: false,
        MapName: null,
        MapId: null,
        Players: [],
        LockedCount: 0,
        SecondsRemaining: null,
        Status: isWatching ? "Waiting for agent select." : "Not watching.",
        Error: null,
        UpdatedAt: null);
}

/// <summary>Turn the lobby watch on or off.</summary>
public sealed record WatchRequest(bool Watching);
