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
    private readonly OptionsStore _optionsStore;
    private readonly object _sync = new();

    /// <summary>
    /// The refresh currently in flight, if any. A second caller awaits it rather
    /// than starting its own -- these are account endpoints, and two clicks in a
    /// row should not mean two rounds of calls to Riot.
    /// </summary>
    private Task? _inFlight;

    /// <summary>
    /// The agent enrichment currently in flight, if any. Same sharing rule as
    /// <see cref="_inFlight"/>: one round of match-details calls at a time.
    /// </summary>
    private Task? _enrichInFlight;

    /// <summary>
    /// Match ids whose match-details request is currently running. Guards the
    /// "at most one request per match" rule even when the refresh replaces the
    /// match list underneath the enrichment.
    /// </summary>
    private readonly HashSet<string> _enriching = new(StringComparer.Ordinal);

    /// <summary>
    /// Resolved agent ids, keyed by match id. Kept out of the refresh path so a
    /// refresh rebuilds <see cref="TrackedMatch"/> rows without losing what an
    /// earlier enrichment found -- competitive updates do not carry the agent.
    /// </summary>
    private readonly Dictionary<string, string> _agentByMatchId = new(StringComparer.Ordinal);

    /// <summary>
    /// Pacing between match-details calls. A refresh can surface a whole
    /// evening of new matches at once; stepping through them keeps an
    /// uncontrolled burst from reaching Riot's match-details endpoint.
    /// </summary>
    private static readonly TimeSpan EnrichmentDelay = TimeSpan.FromMilliseconds(250);

    private RankState _state = RankState.Empty();
    private DateTimeOffset _sessionStart;

    public RankTrackerService(
        ValorantConnection connection,
        ValorantApiAssetService assets,
        OptionsStore optionsStore)
    {
        _connection = connection;
        _assets = assets;
        _optionsStore = optionsStore;

        // Resuming a saved anchor is what keeps closing the app from wiping the
        // day's win/loss. OptionsStore has already discarded one that is too old
        // to still mean "this session".
        DateTimeOffset? saved = optionsStore.Current.Tracker.SessionStartedAt;
        _sessionStart = saved ?? DateTimeOffset.UtcNow;

        // A fresh anchor is only worth saving once there is something to resume,
        // so the first refresh writes it rather than the constructor.
        _anchorSaved = saved is not null;
    }

    private bool _anchorSaved;

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
    public async Task ResetSessionAsync(CancellationToken cancellationToken = default)
    {
        RankState published;
        DateTimeOffset anchor;

        lock (_sync)
        {
            anchor = _sessionStart = DateTimeOffset.UtcNow;
            published = _state = _state with
            {
                Session = Summarize(_state.Matches, _sessionStart, _state.Rank)
            };
        }

        Publish(published);
        await PersistAnchorAsync(anchor, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>
    /// Writes the session anchor to settings so a restart resumes it. Failing to
    /// save is not worth surfacing -- the session still works for this run, and
    /// the tracker has nothing to say about a disk problem.
    /// </summary>
    private async Task PersistAnchorAsync(DateTimeOffset anchor, CancellationToken cancellationToken)
    {
        try
        {
            await _optionsStore
                .ApplyTrackerAsync(new TrackerOptions { SessionStartedAt = anchor }, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception)
        {
            // Ignored on purpose; see above.
        }
    }

    /// <summary>
    /// Re-reads rank and match history. Concurrent callers share one round of
    /// requests: whoever arrives while a refresh is running awaits that one.
    /// </summary>
    public Task RefreshAsync(CancellationToken cancellationToken = default)
    {
        lock (_sync)
        {
            if (_inFlight is { IsCompleted: false })
            {
                return _inFlight;
            }

            // Assigned inside the lock so a caller arriving between the start of
            // the run and the assignment cannot slip past and start a second.
            return _inFlight = RunRefreshAsync(cancellationToken);
        }
    }

    private async Task RunRefreshAsync(CancellationToken cancellationToken)
    {
        Publish(Mutate(state => state with { IsLoading = true, Error = null }));

        DateTimeOffset? anchorToSave = null;

        lock (_sync)
        {
            if (!_anchorSaved)
            {
                _anchorSaved = true;
                anchorToSave = _sessionStart;
            }
        }

        if (anchorToSave is { } anchor)
        {
            await PersistAnchorAsync(anchor, cancellationToken).ConfigureAwait(false);
        }

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

            List<TrackedMatch> matches;
            RankState published;

            lock (_sync)
            {
                matches = (updates?.Matches ?? [])
                    .Select(match => ToTrackedMatch(match, tiers))
                    .Where(match => match is not null)
                    .Select(match => match!)
                    .OrderByDescending(match => match.StartedAt ?? DateTimeOffset.MinValue)
                    .ToList();

                // Match ids that left the competitive-updates window no longer
                // need their agent kept alive; forgetting them bounds the map.
                if (_agentByMatchId.Count > 0)
                {
                    HashSet<string> current = new(matches.Select(match => match.MatchId), StringComparer.Ordinal);

                    foreach (string stale in _agentByMatchId.Keys.Where(key => !current.Contains(key)).ToList())
                    {
                        _agentByMatchId.Remove(stale);
                    }
                }

                published = _state = new RankState(
                    false,
                    null,
                    rank,
                    Summarize(matches, _sessionStart, rank),
                    matches,
                    DateTimeOffset.UtcNow);
            }

            Publish(published);
            StartAgentEnrichment(puuid);
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
            lock (_sync)
            {
                _inFlight = null;
            }
        }
    }

    /// <summary>
    /// Kicks off the background agent enrichment after a refresh. The refresh
    /// itself never waits on it: competitive updates are the tracker's truth,
    /// and a match whose agent cannot be resolved stays valid without one.
    ///
    /// Like the refresh, concurrent triggers share one round -- enrichment is
    /// paced (one match-details call at a time) precisely so that Riot is not
    /// hit with a burst whenever several refreshes land close together.
    /// </summary>
    private void StartAgentEnrichment(string puuid)
    {
        lock (_sync)
        {
            if (_enrichInFlight is { IsCompleted: false })
            {
                return;
            }

            _enrichInFlight = EnrichAgentsAsync(puuid);
        }
    }

    /// <summary>
    /// Resolves the played agent for every match that still lacks one, then
    /// publishes the updated state. Failures are quietly left for the next
    /// refresh to retry -- enrichment is supplemental, so it never surfaces an
    /// error to the view.
    /// </summary>
    private async Task EnrichAgentsAsync(string puuid)
    {
        try
        {
            using ValorantLease lease = await _connection.AcquireAsync().ConfigureAwait(false);

            List<TrackedMatch> pending;

            lock (_sync)
            {
                pending = _state.Matches
                    .Where(match => match.AgentId is null && _enriching.Add(match.MatchId))
                    .ToList();
            }

            try
            {
                foreach (TrackedMatch match in pending)
                {
                    string? agentId = await FetchAgentIdAsync(lease, match.MatchId, puuid).ConfigureAwait(false);

                    if (!string.IsNullOrWhiteSpace(agentId))
                    {
                        ApplyAgent(match.MatchId, agentId);
                    }

                    await Task.Delay(EnrichmentDelay).ConfigureAwait(false);
                }
            }
            finally
            {
                lock (_sync)
                {
                    foreach (TrackedMatch match in pending)
                    {
                        _enriching.Remove(match.MatchId);
                    }
                }
            }
        }
        catch
        {
            // Enrichment is a nicety: the tracker must stay fully functional
            // without it, so nothing here may surface to the view.
        }
        finally
        {
            lock (_sync)
            {
                _enrichInFlight = null;
            }
        }
    }

    /// <summary>
    /// One match-details round trip: the player's own entry in the match, then
    /// the agent they actually played. <c>null</c> when the match does not
    /// (yet) exist or the account cannot be found in it.
    /// </summary>
    private async Task<string?> FetchAgentIdAsync(ValorantLease lease, string matchId, string puuid)
    {
        try
        {
            MatchInfo? info = await lease.Initiator.Endpoints.PvpEndpoints
                .FetchMatchInfoAsync(matchId).ConfigureAwait(false);

            return info?.Players
                .FirstOrDefault(player => string.Equals(player.Subject, puuid, StringComparison.OrdinalIgnoreCase))
                ?.CharacterId;
        }
        catch (Exception)
        {
            // Whatever went wrong -- the match is too fresh, the endpoint
            // throttled, the client went away -- the next refresh retries.
            return null;
        }
    }

    /// <summary>
    /// Records a resolved agent and republishes the state so the view picks it
    /// up without waiting for the next refresh.
    /// </summary>
    private void ApplyAgent(string matchId, string agentId)
    {
        RankState published;

        lock (_sync)
        {
            _agentByMatchId[matchId] = agentId;

            IReadOnlyList<TrackedMatch> updated = _state.Matches
                .Select(match => match.MatchId == matchId ? match with { AgentId = agentId } : match)
                .ToList();

            published = _state = _state with { Matches = updated };
        }

        Publish(published);
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

    private TrackedMatch? ToTrackedMatch(Match match, IReadOnlyDictionary<int, CompetitiveTierAsset> tiers)
    {
        if (string.IsNullOrWhiteSpace(match.MatchId))
        {
            return null;
        }

        int change = (int)(match.RankedRatingEarned ?? 0);
        int tierAfter = (int)(match.TierAfterUpdate ?? 0);
        tiers.TryGetValue(tierAfter, out CompetitiveTierAsset? asset);

        string? agentId;

        lock (_sync)
        {
            _agentByMatchId.TryGetValue(match.MatchId!, out agentId);
        }

        return new TrackedMatch(
            match.MatchId!,
            InstalockerService.ResolveMapName(match.MapId),
            ToTimestamp(match.MatchStartTime),
            change,
            (int)(match.RankedRatingAfterUpdate ?? 0),
            tierAfter,
            asset?.Name ?? (tierAfter == UnrankedTier ? "Unranked" : $"Tier {tierAfter}"),
            change > 0 ? "win" : change < 0 ? "loss" : "draw",
            asset?.Color,
            agentId);
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
