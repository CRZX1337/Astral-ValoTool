namespace Astral.Models;

/// <summary>
/// One frame of the multiplexed <c>/api/events</c> stream.
///
/// <see cref="State"/> is deliberately <c>object</c>: System.Text.Json
/// serialises an <c>object</c>-declared member using its runtime type, so each
/// tool's own state record comes out whole without the envelope having to know
/// about any of them.
/// </summary>
public sealed record ModuleEnvelope(string Module, object State);
