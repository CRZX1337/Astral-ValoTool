using System.Text.Json;
using System.Text.Json.Serialization;
using Astral.Models;

namespace Astral.Services;

public sealed class ValorantApiAssetService(HttpClient httpClient)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly Lock _cacheLock = new();
    private IReadOnlyDictionary<string, AgentAsset>? _cachedAssets;
    private DateTimeOffset _cacheExpiresAt;

    public async Task<IReadOnlyDictionary<string, AgentAsset>> GetAssetsAsync(CancellationToken cancellationToken = default)
    {
        lock (_cacheLock)
        {
            if (_cachedAssets is not null && DateTimeOffset.UtcNow < _cacheExpiresAt)
            {
                return _cachedAssets;
            }
        }

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
                    agent.IsFullPortraitRightFacing),
                StringComparer.OrdinalIgnoreCase);

        lock (_cacheLock)
        {
            _cachedAssets = assets;
            _cacheExpiresAt = DateTimeOffset.UtcNow.AddHours(6);
            return _cachedAssets;
        }
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
}
