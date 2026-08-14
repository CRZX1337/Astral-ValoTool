using System.Collections.Concurrent;
using System.Threading.Channels;
using RadiantConnect;
using RadiantConnect.Methods;
using RadiantConnect.Network.PreGameEndpoints.DataTypes;
using Astral.Models;

namespace Astral.Services;

public sealed class InstalockerService : IModuleStateSource
{
    private static readonly IReadOnlyDictionary<string, ValorantTables.Agent> AgentLookup = BuildAgentLookup();
    // AgentIds must be initialized before Agents: BuildAgents() reads it to
    // carry each agent's character uuid, and static fields run in declaration
    // order.
    private static readonly IReadOnlyDictionary<ValorantTables.Agent, string> AgentIds = BuildAgentIds();
    private static readonly IReadOnlyList<AgentOption> Agents = BuildAgents();
    private static readonly IReadOnlyList<string> MapNames = BuildMapNames();
    private static readonly IReadOnlyDictionary<string, string> MapNameLookup = BuildMapNameLookup();

    /// <summary>Shown when pre-game reports a map that cannot be identified at all.</summary>
    private const string UnknownMapName = "the current map";

    /// <summary>
    /// The character-selection state pre-game reports for a player who has
    /// committed to an agent, as opposed to merely hovering it.
    /// </summary>
    private const string LockedSelectionState = "locked";

    private readonly OptionsStore _optionsStore;
    private readonly ValorantConnection _connection;
    private readonly object _sync = new();

    private CancellationTokenSource? _runCts;
    private Channel<bool>? _signalQueue;
    private Task? _worker;

    /// <summary>
    /// The fallback chain, most-wanted first. Never empty while a run is armed:
    /// <see cref="StartOrUpdate"/> refuses a request that resolves to nothing.
    /// </summary>
    private List<ValorantTables.Agent> _selectedAgents = [];

    private LockState _state = NewState(false, false, null, [], "Waiting...", null);

    /// <summary>
    /// Identifies the current run. Bumped when a worker is started and when one
    /// is stopped, and carried by the worker for its whole life.
    ///
    /// Stopping cannot make a worker vanish -- it is somewhere inside an await
    /// on the game client -- so a stopped worker stays alive long enough to
    /// publish at least once more. Every publish is checked against this, which
    /// is what keeps a dying run from overwriting the state of the one that
    /// replaced it, or from resurrecting "monitoring" after Stop.
    /// </summary>
    private int _generation;

    public InstalockerService(OptionsStore optionsStore, ValorantConnection connection)
    {
        _optionsStore = optionsStore;
        _connection = connection;
    }

    public string ModuleId => "instalock";

    public object GetModuleState() => GetState();

    public IDisposable Subscribe(Action<object> onChanged)
    {
        void Handler(LockState state) => onChanged(state);

        StateChanged += Handler;
        return ModuleSubscription.Create(() => StateChanged -= Handler);
    }

    /// <summary>
    /// Raised after every state change, on whichever thread caused it -- the
    /// instalock worker for the most part. Handlers must not block; the
    /// stream endpoint queues into a bounded channel and the desktop window
    /// marshals onto its UI thread.
    /// </summary>
    public event Action<LockState>? StateChanged;

    public IReadOnlyList<AgentOption> GetAgents() => Agents;

    /// <summary>Distinct map display names, for validating and offering overrides.</summary>
    public static IReadOnlyList<string> GetMapNames() => MapNames;

    /// <summary>
    /// Canonical display name for an agent, or null when it cannot be resolved.
    /// Storing the canonical spelling keeps saved overrides comparable to the
    /// names the interface renders in its dropdowns.
    /// </summary>
    public static string? ResolveAgentNameExact(string name)
    {
        return TryResolveAgent(name, out ValorantTables.Agent agent) ? ToDisplayName(agent) : null;
    }

    /// <summary>Returns the canonically cased map name, or null when unknown.</summary>
    public static string? ResolveMapNameExact(string name)
    {
        return MapNames.FirstOrDefault(map => string.Equals(map, name?.Trim(), StringComparison.OrdinalIgnoreCase));
    }

    public LockState GetState()
    {
        lock (_sync)
        {
            return _state;
        }
    }

    /// <summary>
    /// Arms the worker with a fallback chain, most-wanted first, and starts one
    /// if none is running. Duplicates and unresolvable names are dropped; the
    /// request is refused only when nothing at all resolves.
    /// </summary>
    public bool StartOrUpdate(IReadOnlyList<string> agentNames)
    {
        List<ValorantTables.Agent> chain = ResolveChain(agentNames);

        if (chain.Count == 0)
        {
            return false;
        }

        Channel<bool>? signalQueue;
        LockState published;

        lock (_sync)
        {
            _selectedAgents = chain;
            published = _state = NewState(true, false, ToDisplayName(chain[0]), ToDisplayNames(chain), ArmedStatus(chain), null);

            if (_worker is { IsCompleted: false })
            {
                // Re-aiming a live run: same worker, same generation.
                signalQueue = _signalQueue;
            }
            else
            {
                // Held in locals and captured by value. Reading the fields from
                // inside the lambda would race a Stop that replaces them before
                // the scheduled task ever gets to run.
                CancellationTokenSource cts = new();
                Channel<bool> queue = Channel.CreateUnbounded<bool>(new UnboundedChannelOptions
                {
                    SingleReader = true,
                    SingleWriter = false
                });

                int generation = ++_generation;
                _runCts = cts;
                _signalQueue = queue;
                signalQueue = queue;
                _worker = Task.Run(() => RunAsync(generation, cts.Token, queue));
            }
        }

        signalQueue?.Writer.TryWrite(true);
        Publish(published);
        return true;
    }

    /// <summary>
    /// The armed status doubles as the interface's "not attached yet" marker, so
    /// a chain of one keeps the exact wording the single-agent build published.
    /// </summary>
    private static string ArmedStatus(IReadOnlyList<ValorantTables.Agent> chain)
    {
        return chain.Count > 1
            ? $"Waiting for pre-game. Falling back through {chain.Count - 1} more."
            : "Waiting for pre-game.";
    }

    /// <summary>
    /// Resolves names to agents, keeping the caller's order and dropping both
    /// unknown names and repeats -- a chain that names the same agent twice would
    /// spend a retry re-attempting something that has already failed.
    /// </summary>
    private static List<ValorantTables.Agent> ResolveChain(IReadOnlyList<string> agentNames)
    {
        List<ValorantTables.Agent> chain = [];

        foreach (string name in agentNames)
        {
            if (TryResolveAgent(name, out ValorantTables.Agent agent) && !chain.Contains(agent))
            {
                chain.Add(agent);
            }
        }

        return chain;
    }

    public void Stop(string message)
    {
        CancellationTokenSource? cts;
        Channel<bool>? signalQueue;
        IReadOnlyList<string> chain;
        LockState published;

        lock (_sync)
        {
            // Retires the running generation: anything the outgoing worker still
            // publishes on its way out is now stale and gets dropped.
            _generation++;

            cts = _runCts;
            signalQueue = _signalQueue;
            chain = ToDisplayNames(_selectedAgents);
            _runCts = null;
            _signalQueue = null;
            _worker = null;
            published = _state = NewState(false, false, chain.FirstOrDefault(), chain, message, null);
        }

        signalQueue?.Writer.TryComplete();
        cts?.Cancel();
        cts?.Dispose();
        Publish(published);
    }

    private async Task RunAsync(int generation, CancellationToken cancellationToken, Channel<bool> signalQueue)
    {
        // Owned by this worker alone, so it needs no synchronisation and a
        // restart cannot clear it out from under a run that is still draining.
        HashSet<string> seenMatches = [];

        try
        {
            // Shared with every other tool; the connection closes when the last
            // lease goes back, not when this worker happens to finish.
            using ValorantLease lease = await _connection.AcquireAsync(cancellationToken).ConfigureAwait(false);
            Initiator initiator = lease.Initiator;
            UpdateStatus(generation, "Connected to Valorant. Waiting for pre-game.");

            void HandlePreGameSignal(string _) => signalQueue.Writer.TryWrite(true);
            void HandleGameStateChanged(string _) => signalQueue.Writer.TryWrite(true);

            initiator.GameEvents.PreGame.OnPreGamePlayerLoaded += HandlePreGameSignal;
            initiator.GameEvents.PreGame.OnPreGameMatchLoaded += HandlePreGameSignal;
            initiator.TcpEvents.OnGameStateChanged += HandleGameStateChanged;

            try
            {
                signalQueue.Writer.TryWrite(true);

                while (await signalQueue.Reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    while (signalQueue.Reader.TryRead(out _))
                    {
                    }

                    await ProcessPreGameAsync(generation, initiator, seenMatches, cancellationToken)
                        .ConfigureAwait(false);
                }
            }
            finally
            {
                initiator.GameEvents.PreGame.OnPreGamePlayerLoaded -= HandlePreGameSignal;
                initiator.GameEvents.PreGame.OnPreGameMatchLoaded -= HandlePreGameSignal;
                initiator.TcpEvents.OnGameStateChanged -= HandleGameStateChanged;
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
            Fail(generation, $"Could not attach to Valorant: {ex.Message}");
        }
    }

    private async Task ProcessPreGameAsync(
        int generation,
        Initiator initiator,
        HashSet<string> seenMatches,
        CancellationToken cancellationToken)
    {
        var match = await initiator.Endpoints.PreGameEndpoints.FetchPreGameMatchAsync().ConfigureAwait(false);

        if (match is null)
        {
            UpdateStatus(generation, "Waiting for pre-game.");
            return;
        }

        // The map decides which agent is tried first, so it has to be resolved
        // before anything is published -- otherwise every status line would name
        // the grid selection while a different agent is actually being locked.
        InstalockerOptions options = _optionsStore.Current.Instalocker;
        string mapName = ResolveMapName(match.MapId);
        List<ValorantTables.Agent> chain = BuildChainForMap(mapName, options);

        if (seenMatches.Contains(match.Id))
        {
            UpdateStatus(generation, "Monitoring for the next match.");
            return;
        }

        if (options.HoverDelayMs > 0)
        {
            await Task.Delay(options.HoverDelayMs, cancellationToken).ConfigureAwait(false);
        }

        for (int index = 0; index < chain.Count; index++)
        {
            ValorantTables.Agent agent = chain[index];
            string agentName = ToDisplayName(agent);

            UpdateStatus(generation, AttemptStatus(agentName, mapName, index, chain.Count));

            // Stop has to mean stop: neither client call takes a token, and with
            // the default delays of 0 there is no awaited gap between them to
            // cancel at. Checking on each boundary is what keeps an agent from
            // being taken after the user has already asked to stop.
            cancellationToken.ThrowIfCancellationRequested();

            if (await TryTakeAsync(initiator, agent, options, cancellationToken).ConfigureAwait(false))
            {
                seenMatches.Add(match.Id);
                MarkLocked(generation, agentName, mapName);

                if (options.PostLockDelayMs > 0)
                {
                    await Task.Delay(options.PostLockDelayMs, cancellationToken).ConfigureAwait(false);
                }

                UpdateStatus(generation, $"Locked {agentName}. Monitoring for the next match.");
                return;
            }
        }

        // Every candidate was taken. The match is recorded anyway: retrying the
        // same exhausted chain on the next pre-game signal would just replay the
        // whole sequence of failures a second or two later.
        seenMatches.Add(match.Id);
        UpdateStatus(generation, ExhaustedStatus(chain, mapName));
    }

    /// <summary>
    /// Hovers, locks, then reads back what pre-game thinks this account has.
    ///
    /// Neither client call reports failure -- an agent somebody else already took
    /// is accepted and quietly does nothing -- so the returned match is the only
    /// honest answer about whether the lock actually landed. Guessing instead
    /// would have the chain stop at its first candidate every time.
    /// </summary>
    private static async Task<bool> TryTakeAsync(
        Initiator initiator,
        ValorantTables.Agent agent,
        InstalockerOptions options,
        CancellationToken cancellationToken)
    {
        await initiator.Endpoints.PreGameEndpoints.SelectCharacterAsync(agent).ConfigureAwait(false);

        if (options.LockDelayMs > 0)
        {
            await Task.Delay(options.LockDelayMs, cancellationToken).ConfigureAwait(false);
        }

        cancellationToken.ThrowIfCancellationRequested();
        var locked = await initiator.Endpoints.PreGameEndpoints.LockCharacterAsync(agent).ConfigureAwait(false);

        return HasLocked(locked, agent);
    }

    /// <summary>
    /// True when the match says this account is locked onto <paramref name="agent"/>.
    ///
    /// The player is found by selection state rather than by puuid: pre-game
    /// hides ally identities behind <c>Incognito</c>, but only one player on the
    /// team can hold a given character, so a locked entry carrying that
    /// character id is proof enough that the request went through.
    /// </summary>
    private static bool HasLocked(PreGameMatch? match, ValorantTables.Agent agent)
    {
        if (match?.AllyTeam?.Players is not { } players || !AgentIds.TryGetValue(agent, out string? agentId))
        {
            // Nothing came back, or this build has no uuid for the agent. Treated
            // as failure so the chain moves on rather than reporting a lock it
            // cannot actually confirm.
            return false;
        }

        foreach (Player player in players)
        {
            if (string.Equals(player.CharacterId, agentId, StringComparison.OrdinalIgnoreCase) &&
                string.Equals(player.CharacterSelectionState, LockedSelectionState, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static string AttemptStatus(string agentName, string mapName, int index, int total)
    {
        if (total == 1)
        {
            return $"Selecting {agentName} on {mapName}.";
        }

        return index == 0
            ? $"Selecting {agentName} on {mapName}."
            : $"{agentName} next -- fallback {index} of {total - 1} on {mapName}.";
    }

    private static string ExhaustedStatus(IReadOnlyList<ValorantTables.Agent> chain, string mapName)
    {
        return chain.Count == 1
            ? $"{ToDisplayName(chain[0])} was already taken on {mapName}. Monitoring for the next match."
            : $"All {chain.Count} choices were taken on {mapName}. Monitoring for the next match.";
    }

    /// <summary>
    /// An override for the current map is tried first, then the rest of the
    /// chain. Pushing the override in front rather than replacing the chain is
    /// what makes an override recoverable: the fallbacks still apply when
    /// somebody else has the overridden agent.
    /// </summary>
    private List<ValorantTables.Agent> BuildChainForMap(string mapName, InstalockerOptions options)
    {
        List<ValorantTables.Agent> chain = GetSelectedAgents();

        // An override naming an agent this build does not know is ignored rather
        // than throwing mid pre-game.
        if (options.MapAgentOverrides.TryGetValue(mapName, out string? overrideName) &&
            TryResolveAgent(overrideName, out ValorantTables.Agent overrideAgent))
        {
            chain.Remove(overrideAgent);
            chain.Insert(0, overrideAgent);
        }

        return chain;
    }

    private void UpdateStatus(int generation, string status)
    {
        LockState published;

        lock (_sync)
        {
            if (_generation != generation)
            {
                return;
            }

            IReadOnlyList<string> chain = ToDisplayNames(_selectedAgents);
            published = _state = NewState(true, false, chain.FirstOrDefault(), chain, status, null);
        }

        Publish(published);
    }

    private void MarkLocked(int generation, string agentName, string mapName)
    {
        LockState published;

        lock (_sync)
        {
            if (_generation != generation)
            {
                return;
            }

            // SelectedAgent narrows to whoever was actually taken, which is not
            // necessarily the head of the chain once a fallback has been used.
            published = _state = NewState(
                true,
                true,
                agentName,
                ToDisplayNames(_selectedAgents),
                $"{agentName} selected and locked on {mapName}.",
                null);
        }

        Publish(published);
    }

    /// <summary>
    /// The generation check guards the teardown as much as the status: a worker
    /// failing on its way out must not null the fields of the run that has
    /// already replaced it.
    /// </summary>
    private void Fail(int generation, string error)
    {
        LockState published;

        lock (_sync)
        {
            if (_generation != generation)
            {
                return;
            }

            _runCts?.Dispose();
            _runCts = null;
            _signalQueue = null;
            _worker = null;
            IReadOnlyList<string> chain = ToDisplayNames(_selectedAgents);
            published = _state = NewState(false, false, chain.FirstOrDefault(), chain, "Idle.", error);
        }

        Publish(published);
    }

    /// <summary>
    /// Always called after the lock is released: a subscriber that blocks --
    /// or throws -- must not stall or kill the instalock loop.
    /// </summary>
    private void Publish(LockState state)
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
                ((Action<LockState>)handler)(state);
            }
            catch
            {
                // One faulty subscriber must not stop the others.
            }
        }
    }

    /// <summary>
    /// A private copy, so the caller can reorder it for a map override without
    /// mutating the armed chain.
    /// </summary>
    private List<ValorantTables.Agent> GetSelectedAgents()
    {
        lock (_sync)
        {
            return _selectedAgents.Count > 0 ? [.. _selectedAgents] : [ValorantTables.Agent.Jett];
        }
    }

    private static IReadOnlyList<string> ToDisplayNames(IReadOnlyList<ValorantTables.Agent> chain)
    {
        return [.. chain.Select(ToDisplayName)];
    }

    private static bool TryResolveAgent(string input, out ValorantTables.Agent agent)
    {
        return AgentLookup.TryGetValue(Normalize(input), out agent);
    }

    /// <summary>
    /// Turns whatever pre-game reports into a display name.
    ///
    /// Riot sends the map as a content path ("/Game/Maps/Ascent/Ascent"), while
    /// RadiantConnect's table is keyed by the bare codename ("Ascent", "Bonsai")
    /// and by uuid -- and its dictionary is case sensitive. A direct lookup of
    /// the raw value therefore misses, which silently defeated every map
    /// override. Try the value as sent, then its last path segment, against a
    /// case-insensitive copy of the table.
    /// </summary>
    public static string ResolveMapName(string? mapId)
    {
        if (string.IsNullOrWhiteSpace(mapId))
        {
            return UnknownMapName;
        }

        string trimmed = mapId.Trim();

        if (MapNameLookup.TryGetValue(trimmed, out string? direct))
        {
            return direct;
        }

        string segment = LastSegment(trimmed);

        if (segment.Length > 0 && MapNameLookup.TryGetValue(segment, out string? bySegment))
        {
            return bySegment;
        }

        // A map this build's table does not know yet: show the codename rather
        // than a generic placeholder, so an unmatched override is diagnosable.
        return segment.Length > 0 ? segment : UnknownMapName;
    }

    private static string LastSegment(string value)
    {
        int slash = value.LastIndexOf('/');
        return slash >= 0 ? value[(slash + 1)..] : value;
    }

    private static IReadOnlyDictionary<string, string> BuildMapNameLookup()
    {
        Dictionary<string, string> lookup = new(StringComparer.OrdinalIgnoreCase);

        foreach ((string key, string value) in ValorantTables.InternalMapNames)
        {
            if (!string.IsNullOrWhiteSpace(key) && !string.IsNullOrWhiteSpace(value))
            {
                lookup[key] = value;
            }
        }

        return lookup;
    }

    private static IReadOnlyList<string> BuildMapNames()
    {
        // InternalMapNames is keyed by both uuid and internal codename, so the
        // same map appears several times ("Bonsai" and a uuid both mean Split,
        // "The Range" shows up four times). Only the values are user facing.
        return ValorantTables.InternalMapNames.Values
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(name => name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static IReadOnlyList<AgentOption> BuildAgents()
    {
        // All agents in the RadiantConnect enum are selectable (including Veto & Miks).
        // Uuid rides along from the same table the lock loop uses, lowercased so
        // match-history lookups never fight over casing.
        return Enum.GetValues<ValorantTables.Agent>()
            .Select(agent => new AgentOption(
                ToDisplayName(agent),
                Normalize(ToDisplayName(agent)),
                AgentIds.TryGetValue(agent, out string? id) ? id.ToLowerInvariant() : null))
            .OrderBy(agent => agent.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    private static IReadOnlyDictionary<string, ValorantTables.Agent> BuildAgentLookup()
    {
        ConcurrentDictionary<string, ValorantTables.Agent> lookup = new(StringComparer.OrdinalIgnoreCase);

        foreach (ValorantTables.Agent agent in Enum.GetValues<ValorantTables.Agent>())
        {
            string displayName = ToDisplayName(agent);
            lookup[Normalize(displayName)] = agent;
            lookup[Normalize(agent.ToString())] = agent;
        }

        // Special alias overrides for agents with non-standard names
        lookup[Normalize("KAY/O")]  = ValorantTables.Agent.KAY_O;
        lookup[Normalize("KAYO")]   = ValorantTables.Agent.KAY_O;
        lookup[Normalize("kay o")] = ValorantTables.Agent.KAY_O;

        lookup[Normalize("ISO")]    = ValorantTables.Agent.ISO;

        lookup[Normalize("Tejo")]   = ValorantTables.Agent.Tejo;
        lookup[Normalize("TEJO")]   = ValorantTables.Agent.Tejo;

        lookup[Normalize("Waylay")] = ValorantTables.Agent.Waylay;
        lookup[Normalize("WAYLAY")] = ValorantTables.Agent.Waylay;

        lookup[Normalize("Veto")]   = ValorantTables.Agent.Veto;
        lookup[Normalize("VETO")]   = ValorantTables.Agent.Veto;

        lookup[Normalize("Miks")]   = ValorantTables.Agent.Miks;
        lookup[Normalize("MIKS")]   = ValorantTables.Agent.Miks;

        return lookup;
    }

    /// <summary>
    /// Agent to character uuid, which is how pre-game identifies a pick.
    ///
    /// Taken from RadiantConnect's own table rather than re-typed, and tolerant
    /// of a missing entry: a build whose enum has an agent the table does not is
    /// a chain that skips it, not a crash on the first lock.
    /// </summary>
    private static IReadOnlyDictionary<ValorantTables.Agent, string> BuildAgentIds()
    {
        Dictionary<ValorantTables.Agent, string> ids = [];

        foreach ((ValorantTables.Agent agent, string id) in ValorantTables.AgentToId)
        {
            if (!string.IsNullOrWhiteSpace(id))
            {
                ids[agent] = id;
            }
        }

        return ids;
    }

    private static string ToDisplayName(ValorantTables.Agent agent)
    {
        return agent switch
        {
            ValorantTables.Agent.KAY_O  => "KAY/O",
            ValorantTables.Agent.ISO    => "Iso",
            ValorantTables.Agent.Tejo   => "Tejo",
            ValorantTables.Agent.Waylay => "Waylay",
            ValorantTables.Agent.Veto   => "Veto",
            ValorantTables.Agent.Miks   => "Miks",
            _ => agent.ToString()
        };
    }

    private static string Normalize(string value)
    {
        return new string(value
            .Trim()
            .ToLowerInvariant()
            .Where(char.IsLetterOrDigit)
            .ToArray());
    }

    private static LockState NewState(
        bool isRunning,
        bool isLocked,
        string? selectedAgent,
        IReadOnlyList<string> selectedAgents,
        string status,
        string? error)
    {
        return new LockState(isRunning, isLocked, selectedAgent, selectedAgents, status, error, DateTimeOffset.UtcNow);
    }
}
