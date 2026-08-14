using System.Text.Json;
using Astral.Services;
using Microsoft.Extensions.Options;
using Xunit;

namespace Astral.Tests;

public sealed class OptionsStoreTests
{
    [Fact]
    public async Task Concurrent_section_updates_do_not_overwrite_each_other()
    {
        string directory = Path.Combine(Path.GetTempPath(), "AstralTests", Guid.NewGuid().ToString("N"));
        string path = Path.Combine(directory, "settings.json");

        try
        {
            var store = new OptionsStore(
                Options.Create(new InstalockerOptions()),
                Options.Create(new AutoQueueOptions()),
                Options.Create(new UpdateOptions()),
                path);

            await Task.WhenAll(
                store.ApplyInstalockerAsync(new InstalockerOptions { HoverDelayMs = 111 }),
                store.ApplyAutoQueueAsync(new AutoQueueOptions { QueueId = "unrated", RequeueDelayMs = 222 }),
                store.ApplyTrackerAsync(new TrackerOptions { SessionStartedAt = DateTimeOffset.UtcNow }));

            Assert.Equal(111, store.Current.Instalocker.HoverDelayMs);
            Assert.Equal("unrated", store.Current.AutoQueue.QueueId);
            Assert.Equal(222, store.Current.AutoQueue.RequeueDelayMs);
            Assert.NotNull(store.Current.Tracker.SessionStartedAt);

            using JsonDocument document = JsonDocument.Parse(await File.ReadAllTextAsync(path));
            Assert.Equal(111, document.RootElement.GetProperty("instalocker").GetProperty("hoverDelayMs").GetInt32());
            Assert.Equal("unrated", document.RootElement.GetProperty("autoQueue").GetProperty("queueId").GetString());
            Assert.Equal(222, document.RootElement.GetProperty("autoQueue").GetProperty("requeueDelayMs").GetInt32());
            Assert.True(document.RootElement.GetProperty("tracker").GetProperty("sessionStartedAt").ValueKind != JsonValueKind.Null);
        }
        finally
        {
            if (Directory.Exists(directory))
            {
                Directory.Delete(directory, recursive: true);
            }
        }
    }
}
