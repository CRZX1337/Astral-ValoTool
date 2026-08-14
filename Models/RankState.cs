namespace Astral.Models;

/// <summary>Everything the tracker view renders, in one snapshot.</summary>
public sealed record RankState(
    bool IsLoading,
    string? Error,
    RankSnapshot? Rank,
    SessionSummary? Session,
    IReadOnlyList<TrackedMatch> Matches,
    DateTimeOffset? UpdatedAt
)
{
    public static RankState Empty() => new(false, null, null, null, [], null);
}

/// <summary>
/// Where the account stands right now. <see cref="Tier"/> is Riot's numeric
/// tier; the name, icon and colour are resolved from valorant-api so a new rank
/// does not need a code change.
/// </summary>
public sealed record RankSnapshot(
    int Tier,
    string TierName,
    string? TierIcon,
    string? TierColor,
    int RankedRating
);

/// <summary>
/// Play since the session anchor -- app launch, or the last manual reset.
/// </summary>
public sealed record SessionSummary(
    DateTimeOffset StartedAt,
    int Wins,
    int Losses,
    int Draws,
    int NetRr,
    RankSnapshot? StartingRank
);

/// <summary>
/// One competitive match. <c>Result</c> is derived from the sign of the RR
/// change rather than from a scoreline -- the competitive-updates endpoint does
/// not carry one, and RR direction is what a rank tracker is actually about.
///
/// <c>TierColorAfter</c> is the resolved tier colour rather than the numeric
/// tier: the rank journey chart draws its tier bands from it, and letting the
/// service resolve it means the frontend never invents a palette.
///
/// <c>AgentId</c> is the agent actually played in that match, resolved from the
/// match-details endpoint (the player's <c>CharacterId</c> for this account).
/// It is <c>null</c> until that enrichment lands -- a match without an agent is
/// still a valid match -- and resolving the id into a name or portrait is a
/// client-side asset concern.
/// </summary>
public sealed record TrackedMatch(
    string MatchId,
    string MapName,
    DateTimeOffset? StartedAt,
    int RrChange,
    int RrAfter,
    int TierAfter,
    string TierNameAfter,
    string Result,
    string? TierColorAfter,
    string? AgentId = null
);
