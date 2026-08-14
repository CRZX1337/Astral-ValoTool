using System.Text.Json;
using System.Text.Json.Serialization;
using Astral.Models;

namespace Astral.Services;

/// <summary>
/// Agent artwork from valorant-api.com, cached in memory.
///
/// Registered as a singleton on purpose. The obvious
/// <c>AddHttpClient&lt;ValorantApiAssetService&gt;()</c> registers a typed client
/// as <em>transient</em>, which hands every request a brand new instance and an
/// empty cache -- the TTL below then never expires anything because nothing
/// lives long enough to reach it.
/// </summary>
public sealed class ValorantApiAssetService(IHttpClientFactory httpClientFactory)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan CacheLifetime = TimeSpan.FromHours(6);

    private readonly Lock _cacheLock = new();

    /// <summary>Serialises misses so a burst of requests makes one call, not one each.</summary>
    private readonly SemaphoreSlim _fetchLock = new(1, 1);

    private readonly SemaphoreSlim _tierFetchLock = new(1, 1);

    private IReadOnlyDictionary<string, AgentAsset>? _cachedAssets;
    private DateTimeOffset _cacheExpiresAt;

    private IReadOnlyDictionary<int, CompetitiveTierAsset>? _cachedTiers;
    private DateTimeOffset _tierCacheExpiresAt;

    public async Task<IReadOnlyDictionary<string, AgentAsset>> GetAssetsAsync(CancellationToken cancellationToken = default)
    {
        if (TryReadCache(out IReadOnlyDictionary<string, AgentAsset>? cached))
        {
            return cached;
        }

        await _fetchLock.WaitAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            // Whoever was ahead in the queue may have filled it already.
            if (TryReadCache(out cached))
            {
                return cached;
            }

            return await FetchAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _fetchLock.Release();
        }
    }

    private bool TryReadCache(out IReadOnlyDictionary<string, AgentAsset> assets)
    {
        lock (_cacheLock)
        {
            if (_cachedAssets is not null && DateTimeOffset.UtcNow < _cacheExpiresAt)
            {
                assets = _cachedAssets;
                return true;
            }
        }

        assets = null!;
        return false;
    }

    private async Task<IReadOnlyDictionary<string, AgentAsset>> FetchAsync(CancellationToken cancellationToken)
    {
        using HttpClient httpClient = httpClientFactory.CreateClient(nameof(ValorantApiAssetService));

        using HttpResponseMessage response = await httpClient.GetAsync(
            "https://valorant-api.com/v1/agents?isPlayableCharacter=true",
            cancellationToken).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        AgentApiResponse? payload = await JsonSerializer.DeserializeAsync<AgentApiResponse>(
            stream,
            JsonOptions,
            cancellationToken).ConfigureAwait(false);

        IReadOnlyDictionary<string, AgentAsset> assets = (payload?.Data ?? [])
            .Where(agent => !string.IsNullOrWhiteSpace(agent.DisplayName))
            .ToDictionary(
                agent => Normalize(agent.DisplayName!),
                agent => new AgentAsset(
                    agent.DisplayName!,
                    Normalize(agent.DisplayName!),
                    agent.Role?.DisplayName,
                    agent.FullPortraitV2 ?? agent.FullPortrait ?? agent.BustPortrait ?? agent.DisplayIcon,
                    agent.Background,
                    agent.BackgroundGradientColors?.Where(color => !string.IsNullOrWhiteSpace(color)).ToArray() ?? [],
                    agent.IsFullPortraitRightFacing,
                    // valorant-api's uuid is Riot's character id, the same one
                    // match history reports; lowercased so lookups never fight
                    // over casing (match-details already sends it lowercase).
                    agent.Uuid?.ToLowerInvariant()),
                StringComparer.OrdinalIgnoreCase);

        lock (_cacheLock)
        {
            _cachedAssets = assets;
            _cacheExpiresAt = DateTimeOffset.UtcNow.Add(CacheLifetime);
            return _cachedAssets;
        }
    }

    /// <summary>
    /// Rank tier number -> name, icon and colour.
    ///
    /// The endpoint returns one tier table per episode; only the newest is
    /// current, so the others are discarded rather than merged -- older tables
    /// still contain the retired tier numbering.
    /// </summary>
    public async Task<IReadOnlyDictionary<int, CompetitiveTierAsset>> GetCompetitiveTiersAsync(
        CancellationToken cancellationToken = default)
    {
        if (TryReadTierCache(out IReadOnlyDictionary<int, CompetitiveTierAsset>? cached))
        {
            return cached;
        }

        await _tierFetchLock.WaitAsync(cancellationToken).ConfigureAwait(false);

        try
        {
            if (TryReadTierCache(out cached))
            {
                return cached;
            }

            using HttpClient httpClient = httpClientFactory.CreateClient(nameof(ValorantApiAssetService));

            using HttpResponseMessage response = await httpClient.GetAsync(
                "https://valorant-api.com/v1/competitivetiers",
                cancellationToken).ConfigureAwait(false);
            response.EnsureSuccessStatusCode();

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
            TierApiResponse? payload = await JsonSerializer.DeserializeAsync<TierApiResponse>(
                stream,
                JsonOptions,
                cancellationToken).ConfigureAwait(false);

            TierApiTable? current = payload?.Data?.LastOrDefault();

            Dictionary<int, CompetitiveTierAsset> tiers = (current?.Tiers ?? [])
                .Where(tier => tier.Tier is not null)
                .ToDictionary(
                    tier => tier.Tier!.Value,
                    tier => new CompetitiveTierAsset(
                        tier.Tier!.Value,
                        string.IsNullOrWhiteSpace(tier.TierName) ? "Unranked" : Titlecase(tier.TierName!),
                        tier.LargeIcon ?? tier.SmallIcon,
                        tier.Color is { Length: >= 6 } color ? $"#{color[..6]}" : null));

            lock (_cacheLock)
            {
                _cachedTiers = tiers;
                _tierCacheExpiresAt = DateTimeOffset.UtcNow.Add(CacheLifetime);
                return _cachedTiers;
            }
        }
        finally
        {
            _tierFetchLock.Release();
        }
    }

    private bool TryReadTierCache(out IReadOnlyDictionary<int, CompetitiveTierAsset> tiers)
    {
        lock (_cacheLock)
        {
            if (_cachedTiers is not null && DateTimeOffset.UtcNow < _tierCacheExpiresAt)
            {
                tiers = _cachedTiers;
                return true;
            }
        }

        tiers = null!;
        return false;
    }

    /// <summary>valorant-api shouts its tier names ("IMMORTAL 2"); the UI does not.</summary>
    private static string Titlecase(string value)
    {
        return string.Join(' ', value
            .Trim()
            .Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Select(word => word.Length == 1
                ? word.ToUpperInvariant()
                : char.ToUpperInvariant(word[0]) + word[1..].ToLowerInvariant()));
    }

    private static string Normalize(string value)
    {
        return new string(value
            .Trim()
            .ToLowerInvariant()
            .Where(char.IsLetterOrDigit)
            .ToArray());
    }

    private sealed record AgentApiResponse(
        [property: JsonPropertyName("data")] AgentApiAgent[]? Data);

    private sealed record AgentApiAgent(
        [property: JsonPropertyName("uuid")] string? Uuid,
        [property: JsonPropertyName("displayName")] string? DisplayName,
        [property: JsonPropertyName("displayIcon")] string? DisplayIcon,
        [property: JsonPropertyName("bustPortrait")] string? BustPortrait,
        [property: JsonPropertyName("fullPortrait")] string? FullPortrait,
        [property: JsonPropertyName("fullPortraitV2")] string? FullPortraitV2,
        [property: JsonPropertyName("background")] string? Background,
        [property: JsonPropertyName("backgroundGradientColors")] string[]? BackgroundGradientColors,
        [property: JsonPropertyName("isFullPortraitRightFacing")] bool IsFullPortraitRightFacing,
        [property: JsonPropertyName("role")] AgentApiRole? Role);

    private sealed record AgentApiRole(
        [property: JsonPropertyName("displayName")] string? DisplayName);

    private sealed record TierApiResponse(
        [property: JsonPropertyName("data")] TierApiTable[]? Data);

    private sealed record TierApiTable(
        [property: JsonPropertyName("tiers")] TierApiTier[]? Tiers);

    private sealed record TierApiTier(
        [property: JsonPropertyName("tier")] int? Tier,
        [property: JsonPropertyName("tierName")] string? TierName,
        [property: JsonPropertyName("color")] string? Color,
        [property: JsonPropertyName("largeIcon")] string? LargeIcon,
        [property: JsonPropertyName("smallIcon")] string? SmallIcon);
}
