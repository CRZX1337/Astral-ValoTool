using System.Diagnostics;
using RadiantConnect;

namespace Astral.Services;

/// <summary>
/// Thrown when the game client cannot be reached. Carries a message that is
/// already fit to show a user, so callers do not have to translate it.
/// </summary>
public sealed class ValorantUnavailableException(string message) : Exception(message);

/// <summary>
/// Owns the single <see cref="Initiator"/> every tool shares.
///
/// Each tool used to build its own, which was fine while the instalocker was
/// the only one. Four tools doing that is four log tails and four socket
/// connections to the same client, so the connection is opened on the first
/// lease and closed when the last one is returned.
/// </summary>
public sealed class ValorantConnection
{
    private static readonly string[] ValorantProcesses =
    [
        "VALORANT",
        "VALORANT-Win64-Shipping",
        "VALORANT-Win32-Shipping"
    ];

    /// <summary>Serialises connection creation, which is the only slow step.</summary>
    private readonly SemaphoreSlim _gate = new(1, 1);

    /// <summary>Guards the fields below. Never held across anything that blocks.</summary>
    private readonly Lock _sync = new();

    private Initiator? _initiator;
    private int _leases;

    /// <summary>
    /// Identifies the current <see cref="Initiator"/> instance. Every lease
    /// carries the epoch it was issued under, and <see cref="Release"/> ignores
    /// a lease whose epoch has since been retired.
    ///
    /// Without this, returning a lease that <see cref="Invalidate"/> already
    /// discarded would decrement the lease count of whatever connection replaced
    /// it -- and take a live one down with it. That is reachable whenever one
    /// tool hits an error while another is working: every service calls
    /// Invalidate() from its catch block, and the tools run concurrently.
    /// </summary>
    private int _epoch;

    /// <summary>True while at least one tool holds an open lease.</summary>
    public bool IsConnected
    {
        get
        {
            lock (_sync)
            {
                return _leases > 0 && _initiator is not null;
            }
        }
    }

    /// <summary>
    /// Borrows the shared connection, opening it if this is the first caller.
    /// Dispose the lease when done -- the connection closes with the last one.
    /// </summary>
    /// <exception cref="ValorantUnavailableException">
    /// The game is not running, or the client could not be attached to.
    /// </exception>
    public async Task<ValorantLease> AcquireAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            lock (_sync)
            {
                if (_initiator is not null)
                {
                    _leases++;
                    return new ValorantLease(this, _initiator, _epoch);
                }
            }

            if (!IsValorantRunning())
            {
                throw new ValorantUnavailableException(
                    "Valorant is not running. Start the game, then try again.");
            }

            Initiator created;

            try
            {
                // Deliberately outside the lock: attaching to the client tails a
                // log and opens a socket, which is far too long to hold a monitor
                // that Dispose() on a lease also needs.
                created = new Initiator();
            }
            catch (Exception ex)
            {
                throw new ValorantUnavailableException($"Could not attach to Valorant: {ex.Message}");
            }

            Initiator? stale;

            lock (_sync)
            {
                // An Invalidate() that landed while we were attaching leaves this
                // instance as the newest either way, so it becomes the current
                // one and starts a fresh epoch. Leases from the old epoch are
                // already retired, which is why the count restarts at this one.
                stale = _initiator;
                _initiator = created;
                _epoch++;
                _leases = 1;
            }

            Dispose(stale);
            return new ValorantLease(this, created, _epoch);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Drops the shared connection even though leases are still out, so the next
    /// acquire builds a fresh one. For when the client has gone away underneath
    /// us: the endpoints keep throwing until someone rebuilds the Initiator.
    /// </summary>
    public void Invalidate()
    {
        Initiator? stale;

        lock (_sync)
        {
            stale = _initiator;
            _initiator = null;
            _leases = 0;
            _epoch++;
        }

        Dispose(stale);
    }

    /// <summary>
    /// Returns a lease. Called from <see cref="ValorantLease.Dispose"/>, which is
    /// synchronous and can run on any thread, so this only ever takes the cheap
    /// monitor -- never the acquire gate, which is held across an attach.
    /// </summary>
    internal void Release(int epoch)
    {
        Initiator? last;

        lock (_sync)
        {
            if (epoch != _epoch)
            {
                // A lease from a connection that has already been discarded.
                // Its accounting went with it.
                return;
            }

            if (--_leases > 0)
            {
                return;
            }

            _leases = 0;
            last = _initiator;
            _initiator = null;
            _epoch++;
        }

        Dispose(last);
    }

    /// <summary>
    /// Each returned <see cref="Process"/> holds an OS handle, so the array has
    /// to be disposed even though only its length is interesting here.
    /// </summary>
    public static bool IsValorantRunning()
    {
        foreach (string name in ValorantProcesses)
        {
            Process[] processes = Process.GetProcessesByName(name);

            try
            {
                if (processes.Length > 0)
                {
                    return true;
                }
            }
            finally
            {
                foreach (Process process in processes)
                {
                    process.Dispose();
                }
            }
        }

        return false;
    }

    /// <summary>
    /// A client that is already gone tends to throw on teardown; that must not
    /// escape into whichever tool happened to return the last lease.
    /// </summary>
    private static void Dispose(Initiator? initiator)
    {
        try
        {
            initiator?.Dispose();
        }
        catch
        {
            // Nothing useful to do -- the connection is being discarded anyway.
        }
    }
}

/// <summary>
/// A borrowed handle on the shared connection. Disposing it returns the lease;
/// disposing twice is a no-op so a `using` inside a retry loop stays safe.
/// </summary>
public sealed class ValorantLease(ValorantConnection owner, Initiator initiator, int epoch) : IDisposable
{
    private int _disposed;

    public Initiator Initiator { get; } = initiator;

    /// <summary>The signed-in player's puuid, which most account endpoints want.</summary>
    public string UserId => Initiator.Client.UserId;

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            owner.Release(epoch);
        }
    }
}
