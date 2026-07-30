namespace Astral.Services;

/// <summary>
/// One tool, as the multiplexed <c>/api/events</c> stream sees it.
///
/// Subscription is a method returning a handle rather than an event, so a tool
/// can keep its own strongly typed event for its own callers while the stream
/// endpoint stays generic -- and so unsubscribing is a `using` instead of a
/// second delegate reference the endpoint has to hold onto.
/// </summary>
public interface IModuleStateSource
{
    /// <summary>Stable key this tool's frames are tagged with. Matches the frontend view id.</summary>
    string ModuleId { get; }

    object GetModuleState();

    IDisposable Subscribe(Action<object> onChanged);
}

public static class ModuleSubscription
{
    public static IDisposable Create(Action unsubscribe) => new Disposer(unsubscribe);

    /// <summary>Idempotent: the stream endpoint disposes from a finally that can run twice.</summary>
    private sealed class Disposer(Action unsubscribe) : IDisposable
    {
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                unsubscribe();
            }
        }
    }
}
