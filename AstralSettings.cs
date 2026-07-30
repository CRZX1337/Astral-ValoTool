namespace Astral;

/// <summary>
/// Everything persisted to <c>%APPDATA%\Astral\settings.json</c>, one section
/// per tool.
/// </summary>
public sealed class AstralSettings
{
    public InstalockerOptions Instalocker { get; set; } = new();

    public AutoQueueOptions AutoQueue { get; set; } = new();
}
