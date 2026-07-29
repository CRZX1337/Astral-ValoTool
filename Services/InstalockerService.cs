using System.Collections.Concurrent;
using System.Diagnostics;
using System.Threading.Channels;
using RadiantConnect;
using RadiantConnect.Methods;
using Astral.Models;

namespace Astral.Services;

public sealed class InstalockerService
{
    private static readonly string[] ValorantProcesses =
    [
        "VALORANT",
        "VALORANT-Win64-Shipping",
        "VALORANT-Win32-Shipping"
    ];

    private static readonly IReadOnlyDictionary<string, ValorantTables.Agent> AgentLookup = BuildAgentLookup();
    private static readonly IReadOnlyList<AgentOption> Agents = BuildAgents();
    private static readonly IReadOnlyList<string> MapNames = BuildMapNames();

    private readonly OptionsStore _optionsStore;
    private readonly object _sync = new();
    private readonly HashSet<string> _seenMatches = [];

    private CancellationTokenSource? _runCts;
    private Channel<bool>? _signalQueue;
    private Task? _worker;
    private ValorantTables.Agent? _selectedAgent;
    private LockState _state = NewState(false, false, null, "Waiting...", null);

    public InstalockerService(OptionsStore optionsStore)
    {
        _optionsStore = optionsStore;
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

    public bool StartOrUpdate(string agentName)
    {
        if (!TryResolveAgent(agentName, out ValorantTables.Agent agent))
        {
            return false;
        }

        Channel<bool>? signalQueue;
        LockState published;

        lock (_sync)
        {
            _selectedAgent = agent;
            published = _state = NewState(true, false, ToDisplayName(agent), "Waiting for pre-game.", null);

            if (_worker is { IsCompleted: false })
            {
                signalQueue = _signalQueue;
            }
            else
            {
                _seenMatches.Clear();
                _runCts = new CancellationTokenSource();
                _signalQueue = Channel.CreateUnbounded<bool>(new UnboundedChannelOptions
                {
                    SingleReader = true,
                    SingleWriter = false
                });
                signalQueue = _signalQueue;
                _worker = Task.Run(() => RunAsync(_runCts.Token, _signalQueue));
            }
        }

        signalQueue?.Writer.TryWrite(true);
        Publish(published);
        return true;
    }

    public void Stop(string message)
    {
        CancellationTokenSource? cts;
        Channel<bool>? signalQueue;
        string? selectedAgent;
        LockState published;

        lock (_sync)
        {
            cts = _runCts;
            signalQueue = _signalQueue;
            selectedAgent = _selectedAgent is { } agent ? ToDisplayName(agent) : null;
            _runCts = null;
            _signalQueue = null;
            _worker = null;
            published = _state = NewState(false, false, selectedAgent, message, null);
        }

        signalQueue?.Writer.TryComplete();
        cts?.Cancel();
        cts?.Dispose();
        Publish(published);
    }

    private async Task RunAsync(CancellationToken cancellationToken, Channel<bool> signalQueue)
    {
        if (!IsValorantRunning())
        {
            Fail("Valorant is not running. Start the game, then try again.");
            return;
        }

        try
        {
            using Initiator initiator = new();
            UpdateStatus("Connected to Valorant. Waiting for pre-game.");

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

                    await ProcessPreGameAsync(initiator, cancellationToken).ConfigureAwait(false);
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
        catch (Exception ex)
        {
            Fail($"Could not attach to Valorant: {ex.Message}");
        }
    }

    private async Task ProcessPreGameAsync(Initiator initiator, CancellationToken cancellationToken)
    {
        var match = await initiator.Endpoints.PreGameEndpoints.FetchPreGameMatchAsync().ConfigureAwait(false);

        if (match is null)
        {
            UpdateStatus("Waiting for pre-game.");
            return;
        }

        // The map decides which agent is used, so it has to be resolved first --
        // otherwise every status line would name the grid selection while a
        // different agent is actually locked.
        InstalockerOptions options = _optionsStore.Current;
        string mapName = ResolveMapName(match.MapId);
        ValorantTables.Agent agent = ResolveAgentForMap(mapName, options);
        string agentName = ToDisplayName(agent);

        if (_seenMatches.Contains(match.Id))
        {
            UpdateStatus($"Locked {agentName}. Monitoring for the next match.");
            return;
        }

        UpdateStatus($"Selecting {agentName} on {mapName}.");

        if (options.HoverDelayMs > 0)
        {
            await Task.Delay(options.HoverDelayMs, cancellationToken).ConfigureAwait(false);
        }

        await initiator.Endpoints.PreGameEndpoints.SelectCharacterAsync(agent).ConfigureAwait(false);

        if (options.LockDelayMs > 0)
        {
            await Task.Delay(options.LockDelayMs, cancellationToken).ConfigureAwait(false);
        }

        await initiator.Endpoints.PreGameEndpoints.LockCharacterAsync(agent).ConfigureAwait(false);
        _seenMatches.Add(match.Id);
        MarkLocked(agentName, mapName);

        if (options.PostLockDelayMs > 0)
        {
            await Task.Delay(options.PostLockDelayMs, cancellationToken).ConfigureAwait(false);
        }

        UpdateStatus($"Locked {agentName}. Monitoring for the next match.");
    }

    /// <summary>
    /// An override for the current map wins over the grid selection. An override
    /// naming an agent this build does not know falls back to the selection
    /// instead of throwing mid pre-game.
    /// </summary>
    private ValorantTables.Agent ResolveAgentForMap(string mapName, InstalockerOptions options)
    {
        if (options.MapAgentOverrides.TryGetValue(mapName, out string? overrideName) &&
            TryResolveAgent(overrideName, out ValorantTables.Agent overrideAgent))
        {
            return overrideAgent;
        }

        return GetSelectedAgent();
    }

    private void UpdateStatus(string status)
    {
        LockState published;

        lock (_sync)
        {
            string? selectedAgent = _selectedAgent is { } agent ? ToDisplayName(agent) : null;
            published = _state = NewState(true, false, selectedAgent, status, null);
        }

        Publish(published);
    }

    private void MarkLocked(string agentName, string mapName)
    {
        LockState published;

        lock (_sync)
        {
            published = _state = NewState(true, true, agentName, $"{agentName} selected and locked on {mapName}.", null);
        }

        Publish(published);
    }

    private void Fail(string error)
    {
        LockState published;

        lock (_sync)
        {
            _runCts?.Dispose();
            _runCts = null;
            _signalQueue = null;
            _worker = null;
            _seenMatches.Clear();
            string? selectedAgent = _selectedAgent is { } agent ? ToDisplayName(agent) : null;
            published = _state = NewState(false, false, selectedAgent, "Idle.", error);
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

    private ValorantTables.Agent GetSelectedAgent()
    {
        lock (_sync)
        {
            return _selectedAgent ?? ValorantTables.Agent.Jett;
        }
    }

    private static bool IsValorantRunning()
    {
        return ValorantProcesses.Any(name => Process.GetProcessesByName(name).Length > 0);
    }

    private static bool TryResolveAgent(string input, out ValorantTables.Agent agent)
    {
        return AgentLookup.TryGetValue(Normalize(input), out agent);
    }

    private static string ResolveMapName(string? mapId)
    {
        if (string.IsNullOrWhiteSpace(mapId))
        {
            return "the current map";
        }

        return ValorantTables.InternalMapNames.TryGetValue(mapId, out string? name) ? name : "the current map";
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
        // All agents in the RadiantConnect enum are selectable (including Veto & Miks)
        return Enum.GetValues<ValorantTables.Agent>()
            .Select(agent => new AgentOption(ToDisplayName(agent), Normalize(ToDisplayName(agent))))
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

    private static LockState NewState(bool isRunning, bool isLocked, string? selectedAgent, string status, string? error)
    {
        return new LockState(isRunning, isLocked, selectedAgent, status, error, DateTimeOffset.UtcNow);
    }
}
