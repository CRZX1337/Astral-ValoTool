using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Astral.Models;

namespace Astral.Services;

/// <summary>
/// Checks GitHub for a newer release, stages it, and swaps it in on restart.
///
/// Everything here is opt-in past the check: nothing is downloaded until the
/// user asks, and nothing is replaced until they ask again. Auto-applying an
/// update to a tool that talks to a game client is the kind of surprise that
/// should never happen without a click behind it.
/// </summary>
public sealed class UpdateService : IModuleStateSource, IDisposable
{
    /// <summary>GitHub rejects API calls with no User-Agent, so send a real one.</summary>
    private static readonly ProductInfoHeaderValue Agent = new("Astral", "1.0");

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// How long after launch the startup check runs. Late enough that it never
    /// competes with the agent catalogue for the first seconds of the window.
    /// </summary>
    private static readonly TimeSpan StartupDelay = TimeSpan.FromSeconds(6);

    private readonly IHttpClientFactory _httpFactory;
    private readonly OptionsStore _optionsStore;
    private readonly object _sync = new();

    /// <summary>The running build, parsed once. Null when it cannot be read.</summary>
    private readonly Version? _current;

    private readonly string _currentDisplay;

    private UpdateState _state;

    /// <summary>The asset picked out of the newest release, if it has one.</summary>
    private ReleaseDownload? _asset;

    /// <summary>Where a completed download landed, ready to be swapped in.</summary>
    private string? _staged;
    private byte[]? _expectedHash;

    private Task? _inFlight;
    private CancellationTokenSource? _download;
    private bool _disposed;

    public UpdateService(IHttpClientFactory httpFactory, OptionsStore optionsStore)
    {
        _httpFactory = httpFactory;
        _optionsStore = optionsStore;

        (_current, _currentDisplay) = ResolveCurrentVersion();
        _state = UpdateState.Idle(_currentDisplay);

        // A previous update left the outgoing binary beside the new one; it is
        // unlocked now that this process is a different image.
        SweepBackups();
    }

    /// <summary>
    /// Raised when the user has applied an update and the window has to close so
    /// the relaunched copy can take over. The host owns exiting -- this service
    /// has no way to close a WinForms message loop.
    /// </summary>
    public event Action? RestartRequested;

    public event Action<UpdateState>? StateChanged;

    public string ModuleId => "update";

    public object GetModuleState() => GetState();

    public IDisposable Subscribe(Action<object> onChanged)
    {
        void Handler(UpdateState state) => onChanged(state);

        StateChanged += Handler;
        return ModuleSubscription.Create(() => StateChanged -= Handler);
    }

    public UpdateState GetState()
    {
        lock (_sync)
        {
            return _state;
        }
    }

    /// <summary>
    /// Runs the launch check, if it is switched on. Fire-and-forget by design:
    /// the caller is startup, and a failed update check must never be something
    /// that delays or breaks the window opening.
    /// </summary>
    public void ScheduleStartupCheck(CancellationToken cancellationToken = default)
    {
        if (!_optionsStore.Current.Update.CheckOnStartup)
        {
            return;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(StartupDelay, cancellationToken).ConfigureAwait(false);
                await CheckAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // CheckAsync already published whatever went wrong.
            }
        }, cancellationToken);
    }

    /// <summary>
    /// Reads the newest release off GitHub. Concurrent callers share one round
    /// trip rather than each starting their own.
    /// </summary>
    public Task CheckAsync(CancellationToken cancellationToken = default)
    {
        lock (_sync)
        {
            // Never restart a check on top of a download in progress: that would
            // replace the asset the download is reading from underneath it.
            if (_state.Stage is UpdateStage.Downloading or UpdateStage.Restarting)
            {
                return Task.CompletedTask;
            }

            if (_inFlight is { IsCompleted: false } running)
            {
                return running;
            }

            _state = _state with
            {
                Stage = UpdateStage.Checking,
                Status = "Checking for updates…",
                Error = null
            };

            Task started = RunCheckAsync(cancellationToken);
            _inFlight = started;
            Publish(_state);
            return started;
        }
    }

    private void Publish(UpdateState state) => StateChanged?.Invoke(state);

    private UpdateState Mutate(Func<UpdateState, UpdateState> change)
    {
        UpdateState published;

        lock (_sync)
        {
            published = _state = change(_state);
        }

        Publish(published);
        return published;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _download?.Cancel();
        _download?.Dispose();
    }

    /// <summary>
    /// What version this build is, from the assembly's informational version.
    ///
    /// Read rather than stored so the binary is the single source of truth: a
    /// constant would be one more place to forget to bump, and an updater that
    /// misreports its own version compares against the wrong thing forever.
    /// </summary>
    private static (Version?, string) ResolveCurrentVersion()
    {
        Assembly assembly = typeof(UpdateService).Assembly;

        string? raw = assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion;

        // SourceLink appends "+<commit>" to the informational version, which is
        // not part of the version and does not parse.
        if (raw is not null)
        {
            int plus = raw.IndexOf('+');

            if (plus >= 0)
            {
                raw = raw[..plus];
            }
        }

        if (string.IsNullOrWhiteSpace(raw))
        {
            raw = assembly.GetName().Version?.ToString(3);
        }

        return TryParseVersion(raw, out Version? parsed)
            ? (parsed, Normalize(raw!))
            : (null, string.IsNullOrWhiteSpace(raw) ? "unknown" : Normalize(raw!));
    }

    /// <summary>Strips a leading "v" and any pre-release suffix, then parses.</summary>
    private static bool TryParseVersion(string? text, out Version? version)
    {
        version = null;

        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        string trimmed = Normalize(text);

        // Only the numeric core is comparable. "1.4.0-rc.1" parses as 1.4.0,
        // which deliberately makes a release candidate equal to its release --
        // erring towards "no update" rather than towards a pointless download.
        int dash = trimmed.IndexOf('-');

        if (dash >= 0)
        {
            trimmed = trimmed[..dash];
        }

        return Version.TryParse(trimmed, out version);
    }

    private static string Normalize(string text)
    {
        string trimmed = text.Trim();

        return trimmed.StartsWith('v') || trimmed.StartsWith('V') ? trimmed[1..] : trimmed;
    }

    private async Task RunCheckAsync(CancellationToken cancellationToken)
    {
        UpdateOptions options = _optionsStore.Current.Update;

        try
        {
            Release? release = await FetchReleaseAsync(options, cancellationToken).ConfigureAwait(false);

            if (release is null)
            {
                Mutate(state => state with
                {
                    Stage = UpdateStage.UpToDate,
                    Status = "No releases published yet.",
                    Error = null,
                    CheckedAt = DateTimeOffset.UtcNow
                });
                return;
            }

            ApplyRelease(release, options);
        }
        catch (OperationCanceledException)
        {
            // Shutting down, or the caller gave up. Nothing to report.
        }
        catch (Exception ex)
        {
            Mutate(state => state with
            {
                Stage = UpdateStage.Failed,
                Status = "Update check failed.",
                Error = Describe(ex),
                CheckedAt = DateTimeOffset.UtcNow
            });
        }
    }

    /// <summary>
    /// Turns a release into state. Split out from the request so the comparison
    /// rules sit in one place, away from the transport.
    /// </summary>
    private void ApplyRelease(Release release, UpdateOptions options)
    {
        bool parsed = TryParseVersion(release.TagName, out Version? latest);
        string display = Normalize(release.TagName ?? string.Empty);

        // An unparseable tag is treated as "nothing to offer" rather than as an
        // update: acting on a version we cannot compare is worse than sitting
        // still, and the release page is still one click away.
        bool newer = parsed && _current is not null && latest > _current;
        bool skipped = newer &&
                       !string.IsNullOrWhiteSpace(options.SkippedVersion) &&
                       string.Equals(options.SkippedVersion, display, StringComparison.OrdinalIgnoreCase);

        ReleaseDownload? asset = newer ? PickAsset(release) : null;

        lock (_sync)
        {
            _asset = asset;
            _staged = null;
            _expectedHash = null;
        }

        Mutate(state => state with
        {
            Stage = newer && !skipped ? UpdateStage.Available : UpdateStage.UpToDate,
            LatestVersion = display.Length == 0 ? null : display,
            IsUpdateAvailable = newer && !skipped,
            ReleaseName = release.Name,
            ReleaseNotes = Summarize(release.Body),
            ReleaseUrl = release.HtmlUrl,
            DownloadSize = asset?.Executable.Size,
            DownloadedBytes = 0,
            PublishedAt = release.PublishedAt,
            IsPrerelease = release.Prerelease,
            Status = DescribeAvailability(newer, skipped, display, asset),
            Error = null,
            CheckedAt = DateTimeOffset.UtcNow
        });
    }

    private string DescribeAvailability(bool newer, bool skipped, string display, ReleaseDownload? asset)
    {
        if (!newer)
        {
            return $"Astral {_currentDisplay} is up to date.";
        }

        if (skipped)
        {
            return $"Version {display} is available. You chose to skip it.";
        }

        return asset is null
            ? $"Version {display} is available, but this release has no downloadable build."
            : $"Version {display} is available.";
    }

    /// <summary>
    /// The newest release, honouring the pre-release preference. GitHub's
    /// <c>/latest</c> route skips pre-releases entirely, so including them means
    /// listing instead and taking the first entry.
    /// </summary>
    private async Task<Release?> FetchReleaseAsync(UpdateOptions options, CancellationToken cancellationToken)
    {
        string repository = options.Repository?.Trim().Trim('/') ?? string.Empty;

        if (repository.Length == 0)
        {
            throw new InvalidOperationException("No update repository is configured.");
        }

        using HttpClient client = CreateClient();
        string route = options.IncludePrereleases
            ? $"https://api.github.com/repos/{repository}/releases?per_page=10"
            : $"https://api.github.com/repos/{repository}/releases/latest";

        using HttpResponseMessage response = await client
            .GetAsync(route, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);

        // A repository with no releases answers 404 on /latest, which is a fact
        // about the repository rather than a failure worth reporting as one.
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        response.EnsureSuccessStatusCode();

        await using Stream body = await response.Content
            .ReadAsStreamAsync(cancellationToken)
            .ConfigureAwait(false);

        if (!options.IncludePrereleases)
        {
            return await JsonSerializer.DeserializeAsync<Release>(body, Json, cancellationToken)
                .ConfigureAwait(false);
        }

        List<Release>? all = await JsonSerializer
            .DeserializeAsync<List<Release>>(body, Json, cancellationToken)
            .ConfigureAwait(false);

        return all?.FirstOrDefault(release => !release.Draft);
    }

    /// <summary>
    /// Which attachment to download. A single-file build is the whole product,
    /// so the release must carry an exact <c>Astral.exe</c> together with its
    /// <c>Astral.exe.sha256</c> checksum; anything else means no update.
    /// </summary>
    internal static ReleaseDownload? PickAsset(Release release)
    {
        ReleaseAsset[] assets = release.Assets ?? [];

        ReleaseAsset? executable = assets.FirstOrDefault(asset =>
            string.Equals(asset.Name, "Astral.exe", StringComparison.OrdinalIgnoreCase) &&
            !string.IsNullOrWhiteSpace(asset.BrowserDownloadUrl));
        ReleaseAsset? checksum = assets.FirstOrDefault(asset =>
            string.Equals(asset.Name, "Astral.exe.sha256", StringComparison.OrdinalIgnoreCase) &&
            !string.IsNullOrWhiteSpace(asset.BrowserDownloadUrl));

        return executable is null || checksum is null ? null : new ReleaseDownload(executable, checksum);
    }

    /// <summary>
    /// Trims release notes to something a banner can hold. The full text is one
    /// click away on the release page, which the state also carries.
    /// </summary>
    private static string? Summarize(string? body)
    {
        if (string.IsNullOrWhiteSpace(body))
        {
            return null;
        }

        string collapsed = body.Replace("\r\n", "\n").Trim();

        return collapsed.Length <= 600 ? collapsed : collapsed[..600].TrimEnd() + "…";
    }

    private static string Describe(Exception ex) => ex switch
    {
        HttpRequestException => "Could not reach GitHub.",
        TaskCanceledException => "The request to GitHub timed out.",
        JsonException => "GitHub returned something unreadable.",
        UnauthorizedAccessException => "Astral is not allowed to write to its own folder.",
        IOException io => io.Message,
        _ => ex.Message
    };

    private HttpClient CreateClient()
    {
        HttpClient client = _httpFactory.CreateClient();
        client.Timeout = TimeSpan.FromSeconds(30);
        client.DefaultRequestHeaders.UserAgent.Add(Agent);
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/vnd.github+json"));
        return client;
    }

    /// <summary>Where staged downloads live: local, per-user, never roaming.</summary>
    private static string StagingFolder => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Astral",
        "updates");

    /// <summary>
    /// Downloads the release binary next to the running one, without touching it
    /// yet. Progress is published as it goes so the banner can show a bar.
    /// </summary>
    public async Task DownloadAsync(CancellationToken cancellationToken = default)
    {
        ReleaseDownload? asset;

        lock (_sync)
        {
            if (_state.Stage is UpdateStage.Downloading or UpdateStage.Restarting)
            {
                return;
            }

            if (!_state.IsUpdateAvailable || _asset is null)
            {
                return;
            }

            asset = _asset;
            _download?.Dispose();
            _download = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        }

        CancellationToken token = _download.Token;

        Mutate(state => state with
        {
            Stage = UpdateStage.Downloading,
            DownloadedBytes = 0,
            Status = "Downloading update…",
            Error = null
        });

        try
        {
            string path = await FetchAssetAsync(asset!.Executable, token).ConfigureAwait(false);
            byte[] expectedHash = await FetchAndParseChecksumAsync(asset.Checksum, token).ConfigureAwait(false);

            bool sha256Matches = await UpdateVerification.MatchesSha256Async(path, expectedHash, token).ConfigureAwait(false);
            UpdateOptions options = _optionsStore.Current.Update;
            bool hasValidAuthenticode = false;

            if (options.RequireAuthenticodeSignature)
            {
                hasValidAuthenticode = UpdateVerification.HasValidAuthenticode(path, options.RequiredSignerSubject);
            }

            if (!UpdateVerification.PassesIntegrityGate(sha256Matches, options.RequireAuthenticodeSignature, hasValidAuthenticode))
            {
                throw new InvalidDataException(
                    !sha256Matches
                        ? "The downloaded Astral.exe does not match Astral.exe.sha256."
                        : "The downloaded Astral.exe does not have a valid Authenticode signature.");
            }

            lock (_sync)
            {
                _staged = path;
                _expectedHash = expectedHash;
            }

            bool installable = path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase);

            Mutate(state => state with
            {
                Stage = UpdateStage.Ready,
                Status = installable
                    ? "Update ready. Astral will restart to apply it."
                    : "Downloaded. This release ships as an archive, so unpack it yourself.",
                Error = null
            });
        }
        catch (OperationCanceledException)
        {
            lock (_sync)
            {
                DeleteStagedFile(_staged ?? Path.Combine(StagingFolder, SafeName(asset?.Executable.Name)));
                _staged = null;
                _expectedHash = null;
            }

            Mutate(state => state with
            {
                Stage = UpdateStage.Available,
                DownloadedBytes = 0,
                Status = "Download cancelled.",
                Error = null
            });
        }
        catch (Exception ex)
        {
            lock (_sync)
            {
                DeleteStagedFile(_staged ?? Path.Combine(StagingFolder, SafeName(asset?.Executable.Name)));
                _staged = null;
                _expectedHash = null;
            }

            Mutate(state => state with
            {
                Stage = UpdateStage.Failed,
                Status = "Download failed.",
                Error = Describe(ex)
            });
        }
    }

    private async Task<string> FetchAssetAsync(ReleaseAsset asset, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(StagingFolder);

        string target = Path.Combine(StagingFolder, SafeName(asset.Name));
        string temporary = target + ".part";

        using HttpClient client = CreateClient();

        // The asset route answers with JSON metadata unless octet-stream is
        // asked for explicitly.
        using HttpRequestMessage request = new(HttpMethod.Get, asset.BrowserDownloadUrl);
        request.Headers.Accept.Clear();
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/octet-stream"));

        using HttpResponseMessage response = await client
            .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken)
            .ConfigureAwait(false);

        response.EnsureSuccessStatusCode();

        long? total = response.Content.Headers.ContentLength ?? asset.Size;

        if (total is not null)
        {
            Mutate(state => state with { DownloadSize = total });
        }

        await using (Stream source = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false))
        await using (FileStream destination = File.Create(temporary))
        {
            byte[] buffer = new byte[81920];
            long copied = 0;
            long lastPublished = 0;
            int read;

            while ((read = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0)
            {
                await destination.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
                copied += read;

                // Every 512 KB rather than every chunk: each publish fans out to
                // every open event-stream client, and sixty frames a second of
                // byte counts is noise on the wire.
                if (copied - lastPublished >= 512 * 1024)
                {
                    lastPublished = copied;
                    long snapshot = copied;
                    Mutate(state => state with { DownloadedBytes = snapshot });
                }
            }

            long final = copied;
            Mutate(state => state with { DownloadedBytes = final });
        }

        File.Move(temporary, target, overwrite: true);
        return target;
    }

    private async Task<byte[]> FetchAndParseChecksumAsync(ReleaseAsset asset, CancellationToken cancellationToken)
    {
        using HttpClient client = CreateClient();
        using HttpResponseMessage response = await client
            .GetAsync(asset.BrowserDownloadUrl, cancellationToken)
            .ConfigureAwait(false);
        response.EnsureSuccessStatusCode();

        string text = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);

        if (!UpdateVerification.TryParseSha256(text, out byte[] hash))
        {
            throw new InvalidDataException("Astral.exe.sha256 does not contain a valid SHA-256 hash.");
        }

        return hash;
    }

    private static void DeleteStagedFile(string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        try
        {
            File.Delete(path);
            File.Delete(path + ".part");
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>Keeps a release's own filename but refuses anything path-like.</summary>
    private static string SafeName(string? name)
    {
        string candidate = Path.GetFileName(name ?? string.Empty);

        return string.IsNullOrWhiteSpace(candidate) ? "Astral-update.exe" : candidate;
    }

    /// <summary>Cancels a download in progress. No-op if none is running.</summary>
    public void CancelDownload()
    {
        lock (_sync)
        {
            _download?.Cancel();
        }
    }

    /// <summary>
    /// Swaps the staged build in and asks the host to restart.
    ///
    /// Windows will not let a running image be overwritten, but it will let it
    /// be *renamed*. So the outgoing binary is moved aside, the new one takes
    /// its path, and the leftover is deleted on the next launch. That avoids
    /// the usual helper-batch-file dance and the console window that comes with
    /// it.
    /// </summary>
    public bool Apply()
    {
        string? staged;
        byte[]? expectedHash;

        lock (_sync)
        {
            if (_state.Stage != UpdateStage.Ready || _staged is null)
            {
                return false;
            }

            staged = _staged;
            expectedHash = _expectedHash;
        }

        string? running = Environment.ProcessPath;

        if (string.IsNullOrWhiteSpace(running) ||
            expectedHash is null ||
            !staged.EndsWith("Astral.exe", StringComparison.OrdinalIgnoreCase))
        {
            Mutate(state => state with
            {
                Stage = UpdateStage.Failed,
                Status = "Could not apply the update.",
                Error = "This build cannot replace itself. Install the download by hand."
            });
            return false;
        }

        string backup = running + ".old";
        string destination = running + "." + Guid.NewGuid().ToString("N") + ".new";
        bool backedUp = false;
        bool replaced = false;

        try
        {
            UpdateOptions options = _optionsStore.Current.Update;

            using (FileStream source = UpdateVerification.OpenControlledRead(staged))
            {
                bool stagedHasValidAuthenticode = false;

                if (options.RequireAuthenticodeSignature)
                {
                    stagedHasValidAuthenticode = UpdateVerification.HasValidAuthenticode(staged, options.RequiredSignerSubject);
                }

                if (!UpdateVerification.PassesIntegrityGate(
                        UpdateVerification.MatchesSha256(source, expectedHash),
                        options.RequireAuthenticodeSignature,
                        stagedHasValidAuthenticode))
                {
                    throw new InvalidDataException("The staged Astral.exe failed integrity or Authenticode verification.");
                }

                using FileStream copy = new(
                    destination,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.Read,
                    bufferSize: 81920,
                    options: FileOptions.SequentialScan);
                source.CopyTo(copy);
                copy.Flush(flushToDisk: true);
            }

            bool destinationHasValidAuthenticode = false;

            if (options.RequireAuthenticodeSignature)
            {
                destinationHasValidAuthenticode = UpdateVerification.HasValidAuthenticode(destination, options.RequiredSignerSubject);
            }

            if (!UpdateVerification.PassesIntegrityGate(
                    UpdateVerification.MatchesSha256(destination, expectedHash),
                    options.RequireAuthenticodeSignature,
                    destinationHasValidAuthenticode))
            {
                throw new InvalidDataException("The copied Astral.exe failed integrity or Authenticode verification.");
            }

            if (File.Exists(backup))
            {
                File.Delete(backup);
            }

            File.Move(running, backup);
            backedUp = true;

            try
            {
                File.Move(destination, running);
                replaced = true;
            }
            catch
            {
                RestorePreviousExecutable(running, backup);
                backedUp = false;
                throw;
            }

            try
            {
                Process.Start(new ProcessStartInfo(running) { UseShellExecute = true });
            }
            catch
            {
                RestorePreviousExecutable(running, backup);
                backedUp = false;
                replaced = false;
                throw;
            }
        }
        catch (Exception ex)
        {
            if (backedUp && !replaced)
            {
                RestorePreviousExecutable(running, backup);
            }

            TryDelete(destination);

            Mutate(state => state with
            {
                Stage = UpdateStage.Failed,
                Status = "Could not apply the update.",
                Error = Describe(ex)
            });
            return false;
        }

        TryDelete(destination);

        Mutate(state => state with
        {
            Stage = UpdateStage.Restarting,
            Status = "Restarting into the new version…",
            Error = null
        });

        RestartRequested?.Invoke();
        return true;
    }

    private static void RestorePreviousExecutable(string running, string backup)
    {
        try
        {
            if (File.Exists(running))
            {
                File.Delete(running);
            }

            if (File.Exists(backup))
            {
                File.Move(backup, running, overwrite: true);
            }
        }
        catch
        {
            // The original failure is reported by the caller. Restoration is
            // best effort because Windows may keep a replacement file locked.
        }
    }

    private static void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }

    /// <summary>
    /// Stops announcing one specific version. The next release after it is
    /// offered as normal, so this is "not now", not "never again".
    /// </summary>
    public async Task SkipAsync(string? version, CancellationToken cancellationToken = default)
    {
        string? target = version;

        if (string.IsNullOrWhiteSpace(target))
        {
            target = GetState().LatestVersion;
        }

        if (string.IsNullOrWhiteSpace(target))
        {
            return;
        }

        UpdateOptions current = _optionsStore.Current.Update;

        await _optionsStore.ApplyUpdateAsync(
            new UpdateOptions
            {
                Repository = current.Repository,
                CheckOnStartup = current.CheckOnStartup,
                IncludePrereleases = current.IncludePrereleases,
                RequireAuthenticodeSignature = current.RequireAuthenticodeSignature,
                RequiredSignerSubject = current.RequiredSignerSubject,
                SkippedVersion = Normalize(target)
            },
            cancellationToken).ConfigureAwait(false);

        Mutate(state => state with
        {
            Stage = UpdateStage.UpToDate,
            IsUpdateAvailable = false,
            Status = $"Version {Normalize(target)} skipped."
        });
    }

    /// <summary>
    /// Deletes the binary a previous update moved aside. Best-effort: if it is
    /// still locked the next launch tries again, and a leftover file next to the
    /// executable is not worth telling anyone about.
    /// </summary>
    private static void SweepBackups()
    {
        try
        {
            string? running = Environment.ProcessPath;

            if (string.IsNullOrWhiteSpace(running))
            {
                return;
            }

            string backup = running + ".old";

            if (File.Exists(backup))
            {
                File.Delete(backup);
            }
        }
        catch (Exception)
        {
            // See above.
        }
    }

    // --- GitHub's release payload, only the fields that are actually used -----

    internal sealed record Release
    {
        [JsonPropertyName("tag_name")]
        public string? TagName { get; init; }

        public string? Name { get; init; }

        public string? Body { get; init; }

        [JsonPropertyName("html_url")]
        public string? HtmlUrl { get; init; }

        public bool Draft { get; init; }

        public bool Prerelease { get; init; }

        [JsonPropertyName("published_at")]
        public DateTimeOffset? PublishedAt { get; init; }

        public ReleaseAsset[]? Assets { get; init; }
    }

    internal sealed record ReleaseAsset
    {
        public string? Name { get; init; }

        public long Size { get; init; }

        [JsonPropertyName("browser_download_url")]
        public string? BrowserDownloadUrl { get; init; }
    }

    internal sealed record ReleaseDownload(ReleaseAsset Executable, ReleaseAsset Checksum);
}
