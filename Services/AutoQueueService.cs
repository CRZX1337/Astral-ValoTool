using System.Threading.Channels;
using RadiantConnect;
using RadiantConnect.Methods;
using RadiantConnect.Network.PartyEndpoints.DataTypes;
using Astral.Models;

// The endpoint class and its namespace share a name, so the type needs an alias
// to be nameable at all from inside this file.
using PartyApi = RadiantConnect.Network.PartyEndpoints.PartyEndpoints;

namespace Astral.Services;

/// <summary>
/// Requeues after a match and drives the queue picker.
///
/// Follows the same generation-counter shape as <see cref="InstalockerService"/>:
/// stopping retires the running generation, so a worker still unwinding inside
/// an await cannot publish over the run that replaced it.
/// </summary>
public sealed class AutoQueueService : IModuleStateSource
{
    /// <summary>Party states that mean the client is sitting in the menus.</summary>
    private static readonly HashSet<string> MenuStates =
        new(["DEFAULT"], StringComparer.OrdinalIgnoreCase);

    private readonly OptionsStore _optionsStore;
    private readonly ValorantConnection _connection;
    private readonly object _sync = new();

    private CancellationTokenSource? _runCts;
    private Channel<Trigger>? _signalQueue;
    private Task? _worker;
    private int _generation;
    private int _consecutiveRequeues;

    private AutoQueueState _state = NewState(false, "Idle.", null, null, null, [], 0, false);

    public AutoQueueService(OptionsStore optionsStore, ValorantConnection connection)
    {
        _optionsStore = optionsStore;
        _connection = connection;
    }

    public event Action<AutoQueueState>? StateChanged;

    public string ModuleId => "autoqueue";

    public object GetModuleState() => GetState();

    public IDisposable Subscribe(Action<object> onChanged)
    {
        void Handler(AutoQueueState state) => onChanged(state);

        StateChanged += Handler;
        return ModuleSubscription.Create(() => StateChanged -= Handler);
    }

    /// <summary>Queues this build knows how to enter, for the picker.</summary>
    public static IReadOnlyList<QueueOption> GetQueueOptions()
    {
        return Enum.GetValues<ValorantTables.QueueId>()
            .Select(queue => new QueueOption(queue.ToString(), PrettyQueueName(queue)))
            .ToArray();
    }

    public static bool TryResolveQueue(string? id, out ValorantTables.QueueId queue)
    {
        return Enum.TryParse(id?.Trim(), ignoreCase: true, out queue);
    }

    public AutoQueueState GetState()
    {
        lock (_sync)
        {
            return _state;
        }
    }

    public void Start()
    {
        Channel<Trigger> signalQueue;

        lock (_sync)
        {
            if (_worker is { IsCompleted: false })
            {
                return;
            }

            CancellationTokenSource cts = new();
            Channel<Trigger> queue = Channel.CreateUnbounded<Trigger>(new UnboundedChannelOptions
            {
                SingleReader = true,
                SingleWriter = false
            });

            int generation = ++_generation;
            _consecutiveRequeues = 0;
            _runCts = cts;
            _signalQueue = queue;
            signalQueue = queue;
            _worker = Task.Run(() => RunAsync(generation, cts.Token, queue));
        }

        Publish(Mutate(state => state with
        {
            IsRunning = true,
            Status = "Starting…",
            Error = null,
            ConsecutiveRequeues = 0,
            LimitReached = false,
            UpdatedAt = DateTimeOffset.UtcNow
        }));

        signalQueue.Writer.TryWrite(Trigger.Sync);
    }

    public void Stop(string message)
    {
        CancellationTokenSource? cts;
        Channel<Trigger>? signalQueue;
        AutoQueueState published;

        lock (_sync)
        {
            _generation++;
            cts = _runCts;
            signalQueue = _signalQueue;
            _runCts = null;
            _signalQueue = null;
            _worker = null;
            _consecutiveRequeues = 0;

            published = _state = _state with
            {
                IsRunning = false,
                Status = message,
                Error = null,
                ConsecutiveRequeues = 0,
                LimitReached = false,
                UpdatedAt = DateTimeOffset.UtcNow
            };
        }

        signalQueue?.Writer.TryComplete();
        cts?.Cancel();
        cts?.Dispose();
        Publish(published);
    }

    /// <summary>
    /// Enters or leaves the queue right now, independent of the automation.
    /// Works whether or not the loop is running.
    /// </summary>
    public async Task<AutoQueueState> SetQueueingAsync(bool queueing, CancellationToken cancellationToken)
    {
        try
        {
            using ValorantLease lease = await _connection.AcquireAsync(cancellationToken).ConfigureAwait(false);
            PartyApi party = lease.Initiator.Endpoints.PartyEndpoints;

            if (queueing)
            {
                await ApplyPreferredQueueAsync(party, cancellationToken).ConfigureAwait(false);
                await party.EnterQueueAsync().ConfigureAwait(false);
            }
            else
            {
                await party.LeaveQueueAsync().ConfigureAwait(false);
            }

            AutoQueueState refreshed = await SyncPartyAsync(lease, queueing ? "Queue entered." : "Queue left.")
                .ConfigureAwait(false);
            Publish(refreshed);
            return refreshed;
        }
        catch (ValorantUnavailableException ex)
        {
            AutoQueueState failed = Mutate(state => state with { Error = ex.Message, UpdatedAt = DateTimeOffset.UtcNow });
            Publish(failed);
            return failed;
        }
        catch (Exception ex)
        {
            _connection.Invalidate();
            AutoQueueState failed = Mutate(state => state with
            {
                Error = $"Could not change the queue: {ex.Message}",
                UpdatedAt = DateTimeOffset.UtcNow
            });
            Publish(failed);
            return failed;
        }
    }

    /// <summary>Reads party state without changing anything, for the view opening.</summary>
    public async Task<AutoQueueState> RefreshAsync(CancellationToken cancellationToken)
    {
        try
        {
            using ValorantLease lease = await _connection.AcquireAsync(cancellationToken).ConfigureAwait(false);
            AutoQueueState refreshed = await SyncPartyAsync(lease, GetState().Status).ConfigureAwait(false);
            Publish(refreshed);
            return refreshed;
        }
        catch (ValorantUnavailableException ex)
        {
            AutoQueueState failed = Mutate(state => state with { Error = ex.Message, UpdatedAt = DateTimeOffset.UtcNow });
            Publish(failed);
            return failed;
        }
        catch (Exception ex)
        {
            _connection.Invalidate();
            AutoQueueState failed = Mutate(state => state with
            {
                Error = $"Could not read your party: {ex.Message}",
                UpdatedAt = DateTimeOffset.UtcNow
            });
            Publish(failed);
            return failed;
        }
    }

    private async Task RunAsync(int generation, CancellationToken cancellationToken, Channel<Trigger> signalQueue)
    {
        try
        {
            using ValorantLease lease = await _connection.AcquireAsync(cancellationToken).ConfigureAwait(false);
            Initiator initiator = lease.Initiator;

            UpdateStatus(generation, "Watching for the end of a match.");

            void OnMatchEnded(string _) => signalQueue.Writer.TryWrite(Trigger.MatchEnded);
            // The queue events are declared over a nullable string; the match and
            // party ones are not.
            void OnEnteredQueue(string? _) => signalQueue.Writer.TryWrite(Trigger.Sync);
            void OnLeftQueue(string? _) => signalQueue.Writer.TryWrite(Trigger.Sync);

            initiator.GameEvents.Match.OnMatchEnded += OnMatchEnded;
            initiator.GameEvents.Queue.OnEnteredQueue += OnEnteredQueue;
            initiator.GameEvents.Queue.OnLeftQueue += OnLeftQueue;

            try
            {
                signalQueue.Writer.TryWrite(Trigger.Sync);

                while (await signalQueue.Reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    while (signalQueue.Reader.TryRead(out Trigger trigger))
                    {
                        await HandleAsync(generation, lease, trigger, cancellationToken).ConfigureAwait(false);
                    }
                }
            }
            finally
            {
                initiator.GameEvents.Match.OnMatchEnded -= OnMatchEnded;
                initiator.GameEvents.Queue.OnEnteredQueue -= OnEnteredQueue;
                initiator.GameEvents.Queue.OnLeftQueue -= OnLeftQueue;
            }
        }
        catch (OperationCanceledException)
        {
        }
        catch (ValorantUnavailableException ex)
        {
            Fail(generation, ex.Message);
        }
        catch (Exception ex)
        {
            _connection.Invalidate();
            Fail(generation, $"Auto-queue stopped: {ex.Message}");
        }
    }

    private async Task HandleAsync(
        int generation,
        ValorantLease lease,
        Trigger trigger,
        CancellationToken cancellationToken)
    {
        AutoQueueOptions options = _optionsStore.Current.AutoQueue;
        PartyApi endpoints = lease.Initiator.Endpoints.PartyEndpoints;

        Party? party = await endpoints.FetchPartyAsync().ConfigureAwait(false);
        PublishParty(generation, party, null);

        if (trigger != Trigger.MatchEnded || !options.AutoRequeue)
        {
            return;
        }

        if (_consecutiveRequeues >= options.MaxConsecutiveRequeues)
        {
            PublishLimit(generation, options.MaxConsecutiveRequeues);
            return;
        }

        UpdateStatus(generation, $"Match over. Requeueing in {options.RequeueDelayMs} ms…");

        if (options.RequeueDelayMs > 0)
        {
            await Task.Delay(options.RequeueDelayMs, cancellationToken).ConfigureAwait(false);
        }

        cancellationToken.ThrowIfCancellationRequested();

        // Re-read rather than trusting the state from before the delay: the user
        // may have started something themselves while we waited.
        party = await endpoints.FetchPartyAsync().ConfigureAwait(false);

        if (!IsInMenus(party))
        {
            UpdateStatus(generation, "Not in the menus; leaving the queue alone.");
            return;
        }

        await ApplyPreferredQueueAsync(endpoints, cancellationToken).ConfigureAwait(false);
        await endpoints.EnterQueueAsync().ConfigureAwait(false);

        int count = Interlocked.Increment(ref _consecutiveRequeues);
        party = await endpoints.FetchPartyAsync().ConfigureAwait(false);
        PublishParty(generation, party, $"Requeued automatically ({count} of {options.MaxConsecutiveRequeues}).");
    }

    private async Task ApplyPreferredQueueAsync(PartyApi endpoints, CancellationToken cancellationToken)
    {
        AutoQueueOptions options = _optionsStore.Current.AutoQueue;

        if (!TryResolveQueue(options.QueueId, out ValorantTables.QueueId queue))
        {
            return;
        }

        cancellationToken.ThrowIfCancellationRequested();
        await endpoints.ChangeQueueAsync(queue).ConfigureAwait(false);
    }

    private async Task<AutoQueueState> SyncPartyAsync(ValorantLease lease, string status)
    {
        Party? party = await lease.Initiator.Endpoints.PartyEndpoints.FetchPartyAsync().ConfigureAwait(false);

        return Mutate(state => state with
        {
            Status = status,
            Error = null,
            PartyState = party?.State,
            CurrentQueueId = party?.MatchmakingData?.QueueId,
            EligibleQueues = party?.EligibleQueues?.ToArray() ?? [],
            UpdatedAt = DateTimeOffset.UtcNow
        });
    }

    private static bool IsInMenus(Party? party)
    {
        return party?.State is { } state && MenuStates.Contains(state);
    }

    private static string PrettyQueueName(ValorantTables.QueueId queue)
    {
        return queue switch
        {
            ValorantTables.QueueId.ggteam => "Escalation",
            ValorantTables.QueueId.hurm => "Team Deathmatch",
            ValorantTables.QueueId.spikerush => "Spike Rush",
            ValorantTables.QueueId.swiftplay => "Swiftplay",
            _ => char.ToUpperInvariant(queue.ToString()[0]) + queue.ToString()[1..]
        };
    }

    private void PublishParty(int generation, Party? party, string? status)
    {
        AutoQueueState published;

        lock (_sync)
        {
            if (_generation != generation)
            {
                return;
            }

            published = _state = _state with
            {
                IsRunning = true,
                Status = status ?? _state.Status,
                PartyState = party?.State,
                CurrentQueueId = party?.MatchmakingData?.QueueId,
                EligibleQueues = party?.EligibleQueues?.ToArray() ?? [],
                ConsecutiveRequeues = _consecutiveRequeues,
                UpdatedAt = DateTimeOffset.UtcNow
            };
        }

        Publish(published);
    }

    private void PublishLimit(int generation, int limit)
    {
        AutoQueueState published;

        lock (_sync)
        {
            if (_generation != generation)
            {
                return;
            }

            published = _state = _state with
            {
                IsRunning = true,
                Status = $"Stopped requeueing after {limit} in a row. Start again when you're ready.",
                LimitReached = true,
                ConsecutiveRequeues = _consecutiveRequeues,
                UpdatedAt = DateTimeOffset.UtcNow
            };
        }

        Publish(published);
    }

    private void UpdateStatus(int generation, string status)
    {
        AutoQueueState published;

        lock (_sync)
        {
            if (_generation != generation)
            {
                return;
            }

            published = _state = _state with
            {
                IsRunning = true,
                Status = status,
                ConsecutiveRequeues = _consecutiveRequeues,
                UpdatedAt = DateTimeOffset.UtcNow
            };
        }

        Publish(published);
    }

    private void Fail(int generation, string error)
    {
        AutoQueueState published;

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

            published = _state = _state with
            {
                IsRunning = false,
                Status = "Idle.",
                Error = error,
                UpdatedAt = DateTimeOffset.UtcNow
            };
        }

        Publish(published);
    }

    private AutoQueueState Mutate(Func<AutoQueueState, AutoQueueState> change)
    {
        lock (_sync)
        {
            return _state = change(_state);
        }
    }

    private void Publish(AutoQueueState state)
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
                ((Action<AutoQueueState>)handler)(state);
            }
            catch
            {
                // One faulty subscriber must not stop the others.
            }
        }
    }

    private static AutoQueueState NewState(
        bool isRunning,
        string status,
        string? error,
        string? partyState,
        string? queueId,
        IReadOnlyList<string> eligibleQueues,
        int consecutiveRequeues,
        bool limitReached)
    {
        return new AutoQueueState(
            isRunning,
            status,
            error,
            partyState,
            queueId,
            eligibleQueues,
            consecutiveRequeues,
            limitReached,
            DateTimeOffset.UtcNow);
    }

    private enum Trigger
    {
        Sync,
        MatchEnded
    }
}
