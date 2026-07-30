using System.Text.Json;
using RadiantConnect.Network.PVPEndpoints.DataTypes;
using Astral.Models;

namespace Astral.Services;

/// <summary>
/// Rank, RR and per-match RR deltas, plus a running session total.
///
/// Refreshes on demand only -- when the view opens and when the user asks.
/// These are account endpoints rather than local ones, and a tool that polls
/// them on a timer is both rude and conspicuous.
/// </summary>
public sealed class RankTrackerService : IModuleStateSource
{
    /// <summary>Riot's numeric tier for "no rank yet".</summary>
    private const int UnrankedTier = 0;

    private readonly ValorantConnection _connection;
    private readonly ValorantApiAssetService _assets;
    private readonly object _sync = new();

    /// <summary>One refresh at a time; a second click piggybacks on the first.</summary>
    private readonly SemaphoreSlim _refreshLock = new(1, 1);

    private RankState _state = RankState.Empty();
    private DateTimeOffset _sessionStart = DateTimeOffset.UtcNow;

    public RankTrackerService(ValorantConnection connection, ValorantApiAssetService assets)
    {
        _connection = connection;
        _assets = assets;
    }

    public event Action<RankState>? StateChanged;

    public string ModuleId => "tracker";

    public object GetModuleState() => GetState();

    public IDisposable Subscribe(Action<object> onChanged)
    {
        void Handler(RankState state) => onChanged(state);

        StateChanged += Handler;
        return ModuleSubscription.Create(() => StateChanged -= Handler);
    }

    public RankState GetState()
    {
        lock (_sync)
        {
            return _state;
        }
    }

    /// <summary>Re-anchors the session to now and recomputes from what is cached.</summary>
    public void ResetSession()
    {
        RankState published;

        lock (_sync)
        {
            _sessionStart = DateTimeOffset.UtcNow;
            published = _state = _state with
            {
                Session = Summarize(_state.Matches, _sessionStart, _state.Rank)
            };
        }

        Publish(published);
    }

    public async Task RefreshAsync(CancellationToken cancellationToken = default)
    {
        Publish(Mutate(state => state with { IsLoading = true, Error = null }));

        await _refreshLock.WaitAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            using ValorantLease lease = await _connection.AcquireAsync(cancellationToken).ConfigureAwait(false);

            string puuid = lease.UserId;

            if (string.IsNullOrWhiteSpace(puuid))
            {
                throw new ValorantUnavailableException("The local client did not report a signed-in account.");
            }

            // Nullable on purpose: RadiantConnect is not annotated, and both of
            // these come back null for an account that has never played comp.
            PlayerMMR? mmr = await lease.Initiator.Endpoints.PvpEndpoints
                .FetchPlayerMMRAsync(puuid).ConfigureAwait(false);
            CompetitiveUpdate? updates = await lease.Initiator.Endpoints.PvpEndpoints
                .FetchCompetitveUpdatesAsync(puuid).ConfigureAwait(false);

            IReadOnlyDictionary<int, CompetitiveTierAsset> tiers = await LoadTiersAsync(cancellationToken)
                .ConfigureAwait(false);

            RankSnapshot? rank = ToSnapshot(
                mmr?.LatestCompetitiveUpdate?.TierAfterUpdate,
                mmr?.LatestCompetitiveUpdate?.RankedRatingAfterUpdate,
                tiers);

            List<TrackedMatch> matches = (updates?.Matches ?? [])
                .Select(match => ToTrackedMatch(match, tiers))
                .Where(match => match is not null)
                .Select(match => match!)
                .OrderByDescending(match => match.StartedAt ?? DateTimeOffset.MinValue)
                .ToList();

            RankState published;

            lock (_sync)
            {
                published = _state = new RankState(
                    false,
                    null,
                    rank,
                    Summarize(matches, _sessionStart, rank),
                    matches,
                    DateTimeOffset.UtcNow);
            }

            Publish(published);
        }
        catch (OperationCanceledException)
        {
            Publish(Mutate(state => state with { IsLoading = false }));
        }
        catch (ValorantUnavailableException ex)
        {
            Publish(Mutate(state => state with { IsLoading = false, Error = ex.Message }));
        }
        catch (Exception ex)
        {
            _connection.Invalidate();
            Publish(Mutate(state => state with { IsLoading = false, Error = $"Could not read your rank: {ex.Message}" }));
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    /// <summary>
    /// Artwork is a nicety, not the point -- a valorant-api outage should cost
    /// icons and pretty names, not the RR numbers themselves.
    /// </summary>
    private async Task<IReadOnlyDictionary<int, CompetitiveTierAsset>> LoadTiersAsync(CancellationToken cancellationToken)
    {
        try
        {
            return await _assets.GetCompetitiveTiersAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception)
        {
            return new Dictionary<int, CompetitiveTierAsset>();
        }
    }

    private static RankSnapshot? ToSnapshot(
        long? tier,
        long? rankedRating,
        IReadOnlyDictionary<int, CompetitiveTierAsset> tiers)
    {
        if (tier is null)
        {
            return null;
        }

        int value = (int)tier.Value;
        tiers.TryGetValue(value, out CompetitiveTierAsset? asset);

        return new RankSnapshot(
            value,
            asset?.Name ?? (value == UnrankedTier ? "Unranked" : $"Tier {value}"),
            asset?.Icon,
            asset?.Color,
            (int)(rankedRating ?? 0));
    }

    private static TrackedMatch? ToTrackedMatch(Match match, IReadOnlyDictionary<int, CompetitiveTierAsset> tiers)
    {
        if (string.IsNullOrWhiteSpace(match.MatchId))
        {
            return null;
        }

        int change = (int)(match.RankedRatingEarned ?? 0);
        int tierAfter = (int)(match.TierAfterUpdate ?? 0);
        tiers.TryGetValue(tierAfter, out CompetitiveTierAsset? asset);

        return new TrackedMatch(
            match.MatchId!,
            InstalockerService.ResolveMapName(match.MapId),
            ToTimestamp(match.MatchStartTime),
            change,
            (int)(match.RankedRatingAfterUpdate ?? 0),
            tierAfter,
            asset?.Name ?? (tierAfter == UnrankedTier ? "Unranked" : $"Tier {tierAfter}"),
            change > 0 ? "win" : change < 0 ? "loss" : "draw");
    }

    private static SessionSummary Summarize(
        IReadOnlyList<TrackedMatch> matches,
        DateTimeOffset sessionStart,
        RankSnapshot? currentRank)
    {
        List<TrackedMatch> inSession = matches
            .Where(match => match.StartedAt is { } started && started >= sessionStart)
            .OrderBy(match => match.StartedAt)
            .ToList();

        // Where the session began: the standing *before* its first match, which
        // is that match's after-value minus what it earned.
        RankSnapshot? startingRank = null;

        if (inSession.Count > 0)
        {
            TrackedMatch first = inSession[0];
            startingRank = new RankSnapshot(
                first.TierAfter,
                first.TierNameAfter,
                null,
                null,
                Math.Max(first.RrAfter - first.RrChange, 0));
        }

        return new SessionSummary(
            sessionStart,
            inSession.Count(match => match.Result == "win"),
            inSession.Count(match => match.Result == "loss"),
            inSession.Count(match => match.Result == "draw"),
            inSession.Sum(match => match.RrChange),
            startingRank ?? currentRank);
    }

    /// <summary>
    /// <c>Match.MatchStartTime</c> is declared <c>object</c> by RadiantConnect
    /// and arrives as whatever the JSON held, so every plausible carrier for
    /// epoch milliseconds is accepted rather than assuming one.
    /// </summary>
    private static DateTimeOffset? ToTimestamp(object? value)
    {
        long? milliseconds = value switch
        {
            long number => number,
            int number => number,
            double number => (long)number,
            string text when long.TryParse(text, out long parsed) => parsed,
            JsonElement { ValueKind: JsonValueKind.Number } element when element.TryGetInt64(out long parsed) => parsed,
            JsonElement { ValueKind: JsonValueKind.String } element when long.TryParse(element.GetString(), out long parsed) => parsed,
            _ => null
        };

        if (milliseconds is null or <= 0)
        {
            return null;
        }

        try
        {
            return DateTimeOffset.FromUnixTimeMilliseconds(milliseconds.Value);
        }
        catch (ArgumentOutOfRangeException)
        {
            return null;
        }
    }

    private RankState Mutate(Func<RankState, RankState> change)
    {
        lock (_sync)
        {
            return _state = change(_state);
        }
    }

    /// <summary>
    /// Always called outside the lock: a subscriber that blocks -- or throws --
    /// must not stall or kill the caller.
    /// </summary>
    private void Publish(RankState state)
    {
        Delegate[]? handlers = StateChanged?.GetInvocationList();

        if (handlers is null)
        {
            return;
        }

        foreach (Delegate handler in handlers)
        {
            try
            {
                ((Action<RankState>)handler)(state);
            }
            catch
            {
                // One faulty subscriber must not stop the others.
            }
        }
    }
}
