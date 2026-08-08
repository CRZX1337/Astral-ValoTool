namespace Astral.Models;

/// <summary>
/// Who to lock, in order of preference.
///
/// <see cref="Agents"/> is the fallback chain: the first entry still free when
/// pre-game opens is the one that gets locked. <see cref="Agent"/> is the
/// original single-agent field and is still honoured on its own, so scripts
/// written against the documented <c>{"agent":"Jett"}</c> body keep working.
/// </summary>
public sealed record LockRequest(string? Agent, IReadOnlyList<string>? Agents)
{
    /// <summary>
    /// The requested chain, from whichever field carried it. <see cref="Agents"/>
    /// wins when both are sent; a lone <see cref="Agent"/> becomes a chain of
    /// one, which is exactly the old behaviour.
    /// </summary>
    public IReadOnlyList<string> Chain =>
        Agents is { Count: > 0 }
            ? Agents
            : string.IsNullOrWhiteSpace(Agent) ? [] : [Agent];
}
