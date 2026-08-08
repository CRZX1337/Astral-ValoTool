using RadiantConnect;
using RadiantConnect.Methods;
using RadiantConnect.Network.PreGameEndpoints.DataTypes;
using RadiantConnect.Network.PVPEndpoints.DataTypes;
using Astral.Models;

// Both endpoint namespaces define a Player. Only the pre-game one is meant here.
using PreGamePlayer = RadiantConnect.Network.PreGameEndpoints.DataTypes.Player;

namespace Astral.Services;

/// <summary>
/// Reads the pre-game lobby and reports who is in it, what they are hovering or
/// have locked, and where they rank.
///
/// Everything here comes out of the pre-game payload your own client already
/// received. The service reads it; it does not query other accounts, and it
/// honours the incognito flag Riot sets on players who have asked not to be
/// named.
///
/// The watch is explicit rather than always-on: agent select lasts under a
/// minute, and polling the client around the clock for a view nobody is looking
/// at would hold a connection lease for no reason.
/// </summary>
public sealed class PreGameIntelService : IModuleStateSource
{
    /// <summary>uuid -> display name, for naming what a player has hovered.</summary>
    private static readonly IReadOnlyDictionary<string, string> AgentNamesById = BuildAgentNamesById();

    /// <summary>Selection states pre-game reports, lowercased.</summary>
    private const string LockedSelectionState = "locked";
    private const string NoSelectionState = "none";

    /// <summary>
    /// How often the lobby is re-read while agent select is open. Picks land
    /// over tens of seconds, so this is frequent enough to feel live without
    /// hammering a local endpoint.
    /// </summary>
    private static readonly TimeSpan ActivePollInterval = TimeSpan.FromSeconds(2);

    /// <summary>
    /// How often we look for a lobby that has not opened yet. Slower, because
    /// nothing is happening and the pre-game events wake us anyway.
    /// </summary>
    private static readonly TimeSpan IdlePollInterval = TimeSpan.FromSeconds(4);

    private readonly ValorantConnection _connection;
    private readonly ValorantApiAssetService _assets;
    private readonly object _sync = new();

    /// <summary>
    /// puuid -> resolved riot id, for the lobby currently being watched.
    /// Names do not change mid-select, so each player is looked up once and the
    /// map is dropped when the lobby does.
    /// </summary>
    private readonly Dictionary<string, string> _nameCache = new(StringComparer.OrdinalIgnoreCase);

    private CancellationTokenSource? _runCts;
    private Task? _worker;
    private LobbyIntel _state = LobbyIntel.Idle();

    /// <summary>
    /// Identifies the current watch, on the same rule as the instalocker: a
    /// worker that is somewhere inside an await when it gets stopped must not
    /// publish over the watch that replaced it.
    /// </summary>
    private int _generation;

    /// <summary>The match id whose roster the name cache belongs to.</summary>
    private string? _cachedForMatch;

    public PreGameIntelService(ValorantConnection connection, ValorantApiAssetService assets)
    {
        _connection = connection;
        _assets = assets;
    }

    public string ModuleId => "intel";

    public object GetModuleState() => GetState();

    public IDisposable Subscribe(Action<object> onChanged)
    {
        void Handler(LobbyIntel state) => onChanged(state);

        StateChanged += Handler;
        return ModuleSubscription.Create(() => StateChanged -= Handler);
    }

    /// <inheritdoc cref="InstalockerService.StateChanged"/>
    public event Action<LobbyIntel>? StateChanged;

    public LobbyIntel GetState()
    {
        lock (_sync)
        {
            return _state;
        }
    }

    /// <summary>Starts the watch loop, or does nothing if one is already up.</summary>
    public void StartWatching()
    {
        LobbyIntel published;

        lock (_sync)
        {
            if (_worker is { IsCompleted: false })
            {
                return;
            }

            CancellationTokenSource cts = new();
            int generation = ++_generation;

            _runCts = cts;
            _worker = Task.Run(() => RunAsync(generation, cts.Token));
            published = _state = LobbyIntel.Idle(isWatching: true);
        }

        Publish(published);
    }

    /// <summary>Stops the watch and clears the roster, which is now stale.</summary>
    public void StopWatching()
    {
        CancellationTokenSource? cts;
        LobbyIntel published;

        lock (_sync)
        {
            _generation++;
            cts = _runCts;
            _runCts = null;
            _worker = null;
            _nameCache.Clear();
            _cachedForMatch = null;
            published = _state = LobbyIntel.Idle(isWatching: false);
        }

        cts?.Cancel();
        cts?.Dispose();
        Publish(published);
    }

    /// <summary>
    /// Polls the lobby for as long as the watch is on.
    ///
    /// A poll rather than pure event subscription, because pre-game raises an
    /// event when a player *loads*, not when they hover or lock. The events are
    /// still subscribed so that a lobby opening is picked up on the spot instead
    /// of up to one idle interval later.
    /// </summary>
    private async Task RunAsync(int generation, CancellationToken cancellationToken)
    {
        try
        {
            using ValorantLease lease = await _connection.AcquireAsync(cancellationToken).ConfigureAwait(false);
            Initiator initiator = lease.Initiator;

            // Signals a wake-up rather than carrying data: the poll re-reads
            // everything anyway, so nothing is lost by collapsing several.
            using SemaphoreSlim wake = new(0, 1);

            void Nudge(string _) => TryNudge(wake);

            initiator.GameEvents.PreGame.OnPreGameMatchLoaded += Nudge;
            initiator.GameEvents.PreGame.OnPreGamePlayerLoaded += Nudge;
            initiator.TcpEvents.OnGameStateChanged += Nudge;

            try
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    bool active = await PollAsync(generation, initiator, cancellationToken).ConfigureAwait(false);

                    // A retired generation means Stop already published the idle
                    // state. Returning rather than looping is what stops a
                    // stopped watch from holding its lease open.
                    if (!IsCurrent(generation))
                    {
                        return;
                    }

                    // Wait out the interval, but cut it short if the client says
                    // something happened.
                    await wake.WaitAsync(active ? ActivePollInterval : IdlePollInterval, cancellationToken)
                        .ConfigureAwait(false);
                }
            }
            finally
            {
                initiator.GameEvents.PreGame.OnPreGameMatchLoaded -= Nudge;
                initiator.GameEvents.PreGame.OnPreGamePlayerLoaded -= Nudge;
                initiator.TcpEvents.OnGameStateChanged -= Nudge;
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (ValorantUnavailableException ex)
        {
            // Already worded for a user by the connection.
            Fail(generation, ex.Message);
        }
        catch (Exception ex)
        {
            // The shared connection is suspect once an endpoint blows up on it;
            // drop it so the next tool to start gets a fresh one.
            _connection.Invalidate();
            Fail(generation, $"Could not read the lobby: {ex.Message}");
        }
    }

    /// <summary>
    /// Releases the wake handle unless it is already released. The count is
    /// capped at one, so a burst of client events must not throw.
    /// </summary>
    private static void TryNudge(SemaphoreSlim wake)
    {
        try
        {
            wake.Release();
        }
        catch (SemaphoreFullException)
        {
            // A wake-up is already pending, which is all one would have done.
        }
        catch (ObjectDisposedException)
        {
            // The watch ended between the event firing and this handler running.
        }
    }

    /// <summary>
    /// Reads the lobby once. Returns true while agent select is open, which is
    /// what decides how soon the next read happens.
    /// </summary>
    private async Task<bool> PollAsync(int generation, Initiator initiator, CancellationToken cancellationToken)
    {
        PreGameMatch? match = await initiator.Endpoints.PreGameEndpoints
            .FetchPreGameMatchAsync().ConfigureAwait(false);

        if (match?.AllyTeam?.Players is not { Count: > 0 } players)
        {
            // Between lobbies. The roster is dropped rather than kept, so the
            // view cannot show a finished lobby as if it were live.
            ForgetRoster();
            PublishIdle(generation, "Waiting for agent select.");
            return false;
        }

        IReadOnlyDictionary<string, string> names =
            await ResolveNamesAsync(initiator, match, players, cancellationToken).ConfigureAwait(false);

        IReadOnlyDictionary<int, CompetitiveTierAsset> tiers =
            await LoadTiersAsync(cancellationToken).ConfigureAwait(false);

        IReadOnlyDictionary<string, AgentAsset> agents =
            await LoadAgentAssetsAsync(cancellationToken).ConfigureAwait(false);

        string self = initiator.Client.UserId ?? string.Empty;
        List<LobbyPlayer> roster = [];

        for (int slot = 0; slot < players.Count; slot++)
        {
            roster.Add(ToLobbyPlayer(players[slot], slot, self, names, tiers, agents));
        }

        PublishRoster(generation, match, roster);
        return true;
    }

    private LobbyPlayer ToLobbyPlayer(
        PreGamePlayer player,
        int slot,
        string self,
        IReadOnlyDictionary<string, string> names,
        IReadOnlyDictionary<int, CompetitiveTierAsset> tiers,
        IReadOnlyDictionary<string, AgentAsset> agents)
    {
        bool isSelf = !string.IsNullOrEmpty(self) &&
                      string.Equals(player.Subject, self, StringComparison.OrdinalIgnoreCase);

        // Riot sets Incognito on players who have asked not to be named, and the
        // game itself honours it. So does this: the name is dropped rather than
        // resolved, except for you, who obviously already know who you are.
        bool incognito = player.PlayerIdentity?.Incognito == true && !isSelf;

        string? name = incognito
            ? null
            : names.TryGetValue(player.Subject ?? string.Empty, out string? resolved) ? resolved : null;

        AgentAsset? agent = ResolveAgent(player.CharacterId, agents);
        int tier = (int)player.CompetitiveTier;
        tiers.TryGetValue(tier, out CompetitiveTierAsset? tierAsset);

        return new LobbyPlayer(
            slot,
            isSelf,
            player.IsCaptain,
            name,
            incognito,
            agent?.Name,
            agent?.Portrait,
            agent?.Role,
            ToPickState(player.CharacterSelectionState, player.CharacterId),
            tier,
            tierAsset?.Name ?? (tier == 0 ? "Unranked" : $"Tier {tier}"),
            tierAsset?.Icon,
            tierAsset?.Color);
    }

    /// <summary>
    /// An empty or missing character id means nothing is hovered, whatever the
    /// selection state says -- pre-game reports "none" and an empty id together,
    /// but a hovered agent with a blank state has also been seen.
    /// </summary>
    private static LobbyPickState ToPickState(string? selectionState, string? characterId)
    {
        if (string.IsNullOrWhiteSpace(characterId))
        {
            return LobbyPickState.None;
        }

        if (string.Equals(selectionState, LockedSelectionState, StringComparison.OrdinalIgnoreCase))
        {
            return LobbyPickState.Locked;
        }

        return string.Equals(selectionState, NoSelectionState, StringComparison.OrdinalIgnoreCase)
            ? LobbyPickState.None
            : LobbyPickState.Hovering;
    }

    /// <summary>
    /// Character uuid to the asset the interface renders. The uuid is turned into
    /// a display name through RadiantConnect's table, then matched against the
    /// valorant-api assets the agent grid already uses, so a lobby portrait is
    /// the same image as the grid's.
    /// </summary>
    private static AgentAsset? ResolveAgent(string? characterId, IReadOnlyDictionary<string, AgentAsset> agents)
    {
        if (string.IsNullOrWhiteSpace(characterId) ||
            !AgentNamesById.TryGetValue(characterId.Trim(), out string? displayName))
        {
            return null;
        }

        return agents.TryGetValue(Normalize(displayName), out AgentAsset? asset)
            ? asset
            : new AgentAsset(displayName, Normalize(displayName), null, null, null, [], false);
    }

    /// <summary>
    /// Riot ids for everyone in the lobby who has not asked to be hidden.
    ///
    /// Resolved once per lobby and cached: names do not change mid-select, and
    /// the name service is a network call that would otherwise run on every
    /// two-second poll. Failure is not fatal -- an unresolved lobby still shows
    /// picks and ranks, just with slots instead of names.
    /// </summary>
    private async Task<IReadOnlyDictionary<string, string>> ResolveNamesAsync(
        Initiator initiator,
        PreGameMatch match,
        IReadOnlyList<PreGamePlayer> players,
        CancellationToken cancellationToken)
    {
        string[] wanted;

        lock (_sync)
        {
            if (!string.Equals(_cachedForMatch, match.Id, StringComparison.OrdinalIgnoreCase))
            {
                _nameCache.Clear();
                _cachedForMatch = match.Id;
            }

            wanted = players
                .Where(player => player.PlayerIdentity?.Incognito != true)
                .Select(player => player.Subject)
                .Where(subject => !string.IsNullOrWhiteSpace(subject) && !_nameCache.ContainsKey(subject!))
                .Select(subject => subject!)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        if (wanted.Length > 0)
        {
            try
            {
                List<NameService>? resolved = await initiator.Endpoints.PvpEndpoints
                    .FetchNameServiceReturn(wanted).ConfigureAwait(false);

                lock (_sync)
                {
                    foreach (NameService entry in resolved ?? [])
                    {
                        if (!string.IsNullOrWhiteSpace(entry.Subject) && Format(entry) is { } formatted)
                        {
                            _nameCache[entry.Subject] = formatted;
                        }
                    }
                }
            }
            catch (Exception) when (!cancellationToken.IsCancellationRequested)
            {
                // Names are the one part of this view that is nice-to-have.
                // Everything else in the snapshot came from the pre-game payload
                // and is still worth publishing.
            }
        }

        lock (_sync)
        {
            return new Dictionary<string, string>(_nameCache, StringComparer.OrdinalIgnoreCase);
        }
    }

    private static string? Format(NameService entry)
    {
        if (!string.IsNullOrWhiteSpace(entry.GameName))
        {
            return string.IsNullOrWhiteSpace(entry.TagLine)
                ? entry.GameName
                : $"{entry.GameName}#{entry.TagLine}";
        }

        return string.IsNullOrWhiteSpace(entry.DisplayName) ? null : entry.DisplayName;
    }

    private async Task<IReadOnlyDictionary<int, CompetitiveTierAsset>> LoadTiersAsync(
        CancellationToken cancellationToken)
    {
        try
        {
            return await _assets.GetCompetitiveTiersAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            // Tier numbers still render without the badge art.
            return new Dictionary<int, CompetitiveTierAsset>();
        }
    }

    private async Task<IReadOnlyDictionary<string, AgentAsset>> LoadAgentAssetsAsync(
        CancellationToken cancellationToken)
    {
        try
        {
            return await _assets.GetAssetsAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            // Agent names still resolve from the local table without portraits.
            return new Dictionary<string, AgentAsset>(StringComparer.OrdinalIgnoreCase);
        }
    }

    private bool IsCurrent(int generation)
    {
        lock (_sync)
        {
            return _generation == generation;
        }
    }

    private void ForgetRoster()
    {
        lock (_sync)
        {
            _nameCache.Clear();
            _cachedForMatch = null;
        }
    }

    private void PublishIdle(int generation, string status)
    {
        LobbyIntel published;

        lock (_sync)
        {
            if (_generation != generation)
            {
                return;
            }

            published = _state = LobbyIntel.Idle(isWatching: true) with
            {
                Status = status,
                UpdatedAt = DateTimeOffset.UtcNow
            };
        }

        Publish(published);
    }

    private void PublishRoster(int generation, PreGameMatch match, IReadOnlyList<LobbyPlayer> roster)
    {
        LobbyIntel published;
        int locked = roster.Count(player => player.PickState == LobbyPickState.Locked);
        string mapName = InstalockerService.ResolveMapName(match.MapId);

        lock (_sync)
        {
            if (_generation != generation)
            {
                return;
            }

            published = _state = new LobbyIntel(
                IsWatching: true,
                IsActive: true,
                MapName: mapName,
                MapId: match.MapId,
                Players: roster,
                LockedCount: locked,
                SecondsRemaining: ToSeconds(match.PhaseTimeRemainingNS),
                Status: $"Agent select on {mapName}. {locked} of {roster.Count} locked.",
                Error: null,
                UpdatedAt: DateTimeOffset.UtcNow);
        }

        Publish(published);
    }

    /// <summary>
    /// Pre-game counts the phase down in nanoseconds. Negative values happen at
    /// the very end of the phase and are reported as zero rather than as time
    /// running backwards.
    /// </summary>
    private static double? ToSeconds(long nanoseconds)
    {
        return nanoseconds <= 0 ? null : Math.Round(nanoseconds / 1_000_000_000d, 1);
    }

    private void Fail(int generation, string error)
    {
        LobbyIntel published;

        lock (_sync)
        {
            if (_generation != generation)
            {
                return;
            }

            _runCts?.Dispose();
            _runCts = null;
            _worker = null;
            _nameCache.Clear();
            _cachedForMatch = null;
            published = _state = LobbyIntel.Idle(isWatching: false) with
            {
                Status = "Not watching.",
                Error = error,
                UpdatedAt = DateTimeOffset.UtcNow
            };
        }

        Publish(published);
    }

    /// <inheritdoc cref="InstalockerService.Publish"/>
    private void Publish(LobbyIntel state)
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
                ((Action<LobbyIntel>)handler)(state);
            }
            catch
            {
                // One faulty subscriber must not stop the others.
            }
        }
    }

    /// <summary>
    /// Character uuid -> agent display name.
    ///
    /// Built by inverting RadiantConnect's own agent table, so a build whose
    /// table gains an agent gains it here too. Duplicate uuids -- if the table
    /// ever carries one -- keep the first entry rather than throwing at startup.
    /// </summary>
    private static IReadOnlyDictionary<string, string> BuildAgentNamesById()
    {
        Dictionary<string, string> names = new(StringComparer.OrdinalIgnoreCase);

        foreach ((ValorantTables.Agent agent, string id) in ValorantTables.AgentToId)
        {
            if (!string.IsNullOrWhiteSpace(id))
            {
                names.TryAdd(id.Trim(), InstalockerService.ResolveAgentNameExact(agent.ToString()) ?? agent.ToString());
            }
        }

        return names;
    }

    private static string Normalize(string value)
    {
        return new string(value
            .Trim()
            .ToLowerInvariant()
            .Where(char.IsLetterOrDigit)
            .ToArray());
    }
}
