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

    private readonly SemaphoreSlim _gate = new(1, 1);

    private Initiator? _initiator;
    private int _leases;

    /// <summary>True while at least one tool holds an open lease.</summary>
    public bool IsConnected => Volatile.Read(ref _leases) > 0 && _initiator is not null;

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
            if (_initiator is null)
            {
                if (!IsValorantRunning())
                {
                    throw new ValorantUnavailableException(
                        "Valorant is not running. Start the game, then try again.");
                }

                try
                {
                    _initiator = new Initiator();
                }
                catch (Exception ex)
                {
                    throw new ValorantUnavailableException($"Could not attach to Valorant: {ex.Message}");
                }
            }

            _leases++;
            return new ValorantLease(this, _initiator);
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
        _gate.Wait();

        try
        {
            Initiator? stale = _initiator;
            _initiator = null;
            _leases = 0;
            Dispose(stale);
        }
        finally
        {
            _gate.Release();
        }
    }

    internal void Release()
    {
        _gate.Wait();

        try
        {
            if (--_leases > 0)
            {
                return;
            }

            _leases = 0;
            Initiator? last = _initiator;
            _initiator = null;
            Dispose(last);
        }
        finally
        {
            _gate.Release();
        }
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
public sealed class ValorantLease(ValorantConnection owner, Initiator initiator) : IDisposable
{
    private int _disposed;

    public Initiator Initiator { get; } = initiator;

    /// <summary>The signed-in player's puuid, which most account endpoints want.</summary>
    public string UserId => Initiator.Client.UserId;

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 0)
        {
            owner.Release();
        }
    }
}
