using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Astral.Services;

/// <summary>
/// Owns the live options. `appsettings.json` supplies the defaults; a user file
/// under %APPDATA% is layered on top and is what edits are written to. The
/// shipped `appsettings.json` is deliberately never touched -- it may sit in a
/// read-only directory, and an update would overwrite it.
/// </summary>
public sealed class OptionsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly string _path;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private InstalockerOptions _current;

    public OptionsStore(IOptions<InstalockerOptions> defaults)
    {
        _path = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Astral",
            "settings.json");

        _current = Load(defaults.Value, _path);
    }

    /// <summary>
    /// A complete snapshot. Callers must treat it as read-only: writes swap the
    /// whole reference, which is what keeps the instalock worker from ever
    /// observing a half-updated override map.
    /// </summary>
    public InstalockerOptions Current => Volatile.Read(ref _current);

    public string SettingsPath => _path;

    /// <summary>
    /// Publishes <paramref name="next"/> immediately, then persists it. A failed
    /// write throws after the change is already live, so the caller can report
    /// "applied but not saved" rather than silently losing either half.
    /// </summary>
    public async Task ApplyAsync(InstalockerOptions next, CancellationToken cancellationToken = default)
    {
        InstalockerOptions normalized = Normalize(next);
        Volatile.Write(ref _current, normalized);
        await SaveAsync(normalized, cancellationToken).ConfigureAwait(false);
    }

    private async Task SaveAsync(InstalockerOptions options, CancellationToken cancellationToken)
    {
        await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);

            // Write beside the target and swap it in: a crash mid-write must not
            // leave a truncated settings file that fails to parse next start.
            string temporary = _path + ".tmp";
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(options, JsonOptions), cancellationToken)
                .ConfigureAwait(false);
            File.Move(temporary, _path, overwrite: true);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private static InstalockerOptions Load(InstalockerOptions defaults, string path)
    {
        try
        {
            if (File.Exists(path))
            {
                InstalockerOptions? saved = JsonSerializer.Deserialize<InstalockerOptions>(
                    File.ReadAllText(path),
                    JsonOptions);

                if (saved is not null)
                {
                    return Normalize(saved);
                }
            }
        }
        catch (Exception)
        {
            // A corrupt or unreadable user file falls back to the shipped
            // defaults rather than stopping the app from starting at all.
        }

        return Normalize(defaults);
    }

    /// <summary>
    /// Rebuilds the override map with a case-insensitive comparer. Neither the
    /// configuration binder nor the JSON deserializer preserves the comparer
    /// from the property initializer, so it has to be re-applied after loading.
    /// </summary>
    private static InstalockerOptions Normalize(InstalockerOptions source)
    {
        return new InstalockerOptions
        {
            HoverDelayMs = source.HoverDelayMs,
            LockDelayMs = source.LockDelayMs,
            PostLockDelayMs = source.PostLockDelayMs,
            MapAgentOverrides = new Dictionary<string, string>(
                source.MapAgentOverrides ?? [],
                StringComparer.OrdinalIgnoreCase)
        };
    }
}
