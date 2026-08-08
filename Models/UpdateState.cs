using System.Text.Json.Serialization;

namespace Astral.Models;

/// <summary>
/// How far through the update flow we are.
///
/// Serialised by name so the wire format says <c>"Downloading"</c>, matching the
/// other enums on the API.
/// </summary>
[JsonConverter(typeof(JsonStringEnumConverter<UpdateStage>))]
public enum UpdateStage
{
    /// <summary>Nothing looked up yet this run.</summary>
    Idle,

    /// <summary>A check is in flight.</summary>
    Checking,

    /// <summary>Checked, and this build is the latest.</summary>
    UpToDate,

    /// <summary>A newer release exists and has not been fetched yet.</summary>
    Available,

    /// <summary>Pulling the release binary down.</summary>
    Downloading,

    /// <summary>Downloaded and staged. Applying is one restart away.</summary>
    Ready,

    /// <summary>The swap is done; the app is about to relaunch.</summary>
    Restarting,

    /// <summary>Something went wrong. <see cref="UpdateState.Error"/> says what.</summary>
    Failed
}

/// <summary>
/// What the updater knows right now.
///
/// <see cref="CurrentVersion"/> is read from the running assembly rather than
/// stored, so a build can never disagree with itself about which version it is.
/// </summary>
public sealed record UpdateState(
    UpdateStage Stage,
    string CurrentVersion,
    string? LatestVersion,
    bool IsUpdateAvailable,
    string? ReleaseName,
    string? ReleaseNotes,
    string? ReleaseUrl,
    long? DownloadSize,
    long DownloadedBytes,
    DateTimeOffset? PublishedAt,
    bool IsPrerelease,
    string Status,
    string? Error,
    DateTimeOffset? CheckedAt
)
{
    /// <summary>Progress as a 0-1 fraction, or null when the size is unknown.</summary>
    public double? Progress => DownloadSize is > 0
        ? Math.Clamp(DownloadedBytes / (double)DownloadSize.Value, 0, 1)
        : null;

    /// <summary>Nothing checked yet, which is where every run starts.</summary>
    public static UpdateState Idle(string currentVersion) => new(
        UpdateStage.Idle,
        currentVersion,
        LatestVersion: null,
        IsUpdateAvailable: false,
        ReleaseName: null,
        ReleaseNotes: null,
        ReleaseUrl: null,
        DownloadSize: null,
        DownloadedBytes: 0,
        PublishedAt: null,
        IsPrerelease: false,
        Status: $"Astral {currentVersion}.",
        Error: null,
        CheckedAt: null);
}

/// <summary>Dismiss the banner for one specific version.</summary>
public sealed record SkipUpdateRequest(string? Version);
