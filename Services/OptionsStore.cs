using System.Text.Json;
using Microsoft.Extensions.Options;

namespace Astral.Services;

/// <summary>
/// Owns the live settings for every tool. `appsettings.json` supplies the
/// defaults; a user file under %APPDATA% is layered on top and is what edits are
/// written to. The shipped `appsettings.json` is deliberately never touched --
/// it may sit in a read-only directory, and an update would overwrite it.
/// </summary>
public sealed class OptionsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true
    };

    private readonly string _path;
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private AstralSettings _current;

    public OptionsStore(IOptions<InstalockerOptions> instalockerDefaults, IOptions<AutoQueueOptions> autoQueueDefaults)
    {
        _path = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Astral",
            "settings.json");

        AstralSettings defaults = new()
        {
            Instalocker = instalockerDefaults.Value,
            AutoQueue = autoQueueDefaults.Value
        };

        _current = Load(defaults, _path);
    }

    /// <summary>
    /// A complete snapshot. Callers must treat it as read-only: writes swap the
    /// whole reference, which is what keeps the tool workers from ever observing
    /// a half-updated section.
    /// </summary>
    public AstralSettings Current => Volatile.Read(ref _current);

    /// <summary>
    /// Publishes <paramref name="next"/> immediately, then persists it. A failed
    /// write throws after the change is already live, so the caller can report
    /// "applied but not saved" rather than silently losing either half.
    /// </summary>
    public async Task ApplyAsync(AstralSettings next, CancellationToken cancellationToken = default)
    {
        AstralSettings normalized = Normalize(next);
        Volatile.Write(ref _current, normalized);
        await SaveAsync(normalized, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Replaces one section and leaves the rest of the file alone.</summary>
    public Task ApplyInstalockerAsync(InstalockerOptions next, CancellationToken cancellationToken = default)
    {
        return ApplyAsync(new AstralSettings { Instalocker = next, AutoQueue = Current.AutoQueue }, cancellationToken);
    }

    public Task ApplyAutoQueueAsync(AutoQueueOptions next, CancellationToken cancellationToken = default)
    {
        return ApplyAsync(new AstralSettings { Instalocker = Current.Instalocker, AutoQueue = next }, cancellationToken);
    }

    private async Task SaveAsync(AstralSettings settings, CancellationToken cancellationToken)
    {
        await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);

            // Write beside the target and swap it in: a crash mid-write must not
            // leave a truncated settings file that fails to parse next start.
            string temporary = _path + ".tmp";
            await File.WriteAllTextAsync(temporary, JsonSerializer.Serialize(settings, JsonOptions), cancellationToken)
                .ConfigureAwait(false);
            File.Move(temporary, _path, overwrite: true);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private static AstralSettings Load(AstralSettings defaults, string path)
    {
        try
        {
            if (File.Exists(path))
            {
                string json = File.ReadAllText(path);
                AstralSettings? saved = Parse(json, defaults);

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
    /// Reads either shape of settings file.
    ///
    /// Before the multitool the file *was* the instalocker options, flat at the
    /// root. Those files are still out there and still hold someone's tuned
    /// delays, so a document with no "instalocker" section is read as one rather
    /// than being thrown away for the defaults.
    /// </summary>
    private static AstralSettings? Parse(string json, AstralSettings defaults)
    {
        using JsonDocument document = JsonDocument.Parse(json);

        if (document.RootElement.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        bool sectioned = document.RootElement.TryGetProperty("instalocker", out _) ||
                         document.RootElement.TryGetProperty("autoQueue", out _);

        if (sectioned)
        {
            return JsonSerializer.Deserialize<AstralSettings>(json, JsonOptions);
        }

        InstalockerOptions? legacy = JsonSerializer.Deserialize<InstalockerOptions>(json, JsonOptions);

        return legacy is null
            ? null
            : new AstralSettings { Instalocker = legacy, AutoQueue = defaults.AutoQueue };
    }

    /// <summary>
    /// Rebuilds the override map with a case-insensitive comparer. Neither the
    /// configuration binder nor the JSON deserializer preserves the comparer
    /// from the property initializer, so it has to be re-applied after loading.
    /// </summary>
    private static AstralSettings Normalize(AstralSettings source)
    {
        InstalockerOptions instalocker = source.Instalocker ?? new InstalockerOptions();
        AutoQueueOptions autoQueue = source.AutoQueue ?? new AutoQueueOptions();

        return new AstralSettings
        {
            Instalocker = new InstalockerOptions
            {
                HoverDelayMs = instalocker.HoverDelayMs,
                LockDelayMs = instalocker.LockDelayMs,
                PostLockDelayMs = instalocker.PostLockDelayMs,
                MapAgentOverrides = new Dictionary<string, string>(
                    instalocker.MapAgentOverrides ?? [],
                    StringComparer.OrdinalIgnoreCase)
            },
            AutoQueue = new AutoQueueOptions
            {
                AutoRequeue = autoQueue.AutoRequeue,
                AutoReadyUp = autoQueue.AutoReadyUp,
                QueueId = string.IsNullOrWhiteSpace(autoQueue.QueueId) ? "competitive" : autoQueue.QueueId.Trim(),
                RequeueDelayMs = autoQueue.RequeueDelayMs,
                MaxConsecutiveRequeues = autoQueue.MaxConsecutiveRequeues
            }
        };
    }
}
