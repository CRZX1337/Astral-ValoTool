using System.Reflection;
using Astral.Models;
using Astral.Services;
using Microsoft.Extensions.Options;
using Xunit;

namespace Astral.Tests;

public sealed class AutoQueueGenerationTests
{
    [Fact]
    public void Stale_worker_cannot_publish_after_generation_changes()
    {
        string directory = Path.Combine(Path.GetTempPath(), "AstralTests", Guid.NewGuid().ToString("N"));

        try
        {
            var store = new OptionsStore(
                Options.Create(new InstalockerOptions()),
                Options.Create(new AutoQueueOptions()),
                Options.Create(new UpdateOptions()),
                Path.Combine(directory, "settings.json"));
            var service = new AutoQueueService(store, new ValorantConnection());
            FieldInfo generation = typeof(AutoQueueService).GetField("_generation", BindingFlags.Instance | BindingFlags.NonPublic)!;
            MethodInfo updateStatus = typeof(AutoQueueService).GetMethod("UpdateStatus", BindingFlags.Instance | BindingFlags.NonPublic)!;

            generation.SetValue(service, 2);
            AutoQueueState before = service.GetState();

            updateStatus.Invoke(service, [1, "stale"]);

            Assert.Same(before, service.GetState());

            updateStatus.Invoke(service, [2, "current"]);

            Assert.Equal("current", service.GetState().Status);
            Assert.True(service.GetState().IsRunning);
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
