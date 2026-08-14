using Astral.Services;
using Microsoft.Extensions.Options;
using RadiantConnect.Methods;
using Xunit;

namespace Astral.Tests;

public sealed class InstalockerTests
{
    [Fact]
    public void Another_ally_lock_is_not_local_success()
    {
        Assert.False(InstalockerService.IsLocalPlayerLocked(
            "ally", "jett-id", "locked", "self", "jett-id"));
    }

    [Fact]
    public void Local_player_lock_is_success()
    {
        Assert.True(InstalockerService.IsLocalPlayerLocked(
            "self", "jett-id", "locked", "self", "jett-id"));
    }

    [Fact]
    public void Local_player_on_different_agent_is_not_success()
    {
        Assert.False(InstalockerService.IsLocalPlayerLocked(
            "self", "raze-id", "locked", "self", "jett-id"));
    }

    [Fact]
    public void Resolve_chain_deduplicates_and_preserves_order()
    {
        var chain = InstalockerService.ResolveChain(["Raze", "Jett", "Raze", "not-an-agent"]);

        Assert.Equal([ValorantTables.Agent.Raze, ValorantTables.Agent.Jett], chain);
    }

    [Fact]
    public void Map_override_moves_to_front_without_removing_fallbacks()
    {
        string directory = Path.Combine(Path.GetTempPath(), "AstralTests", Guid.NewGuid().ToString("N"));

        try
        {
            var store = new OptionsStore(
                Options.Create(new InstalockerOptions()),
                Options.Create(new AutoQueueOptions()),
                Options.Create(new UpdateOptions()),
                Path.Combine(directory, "settings.json"));
            var service = new InstalockerService(store, new ValorantConnection());
            Assert.True(service.StartOrUpdate(["Jett", "Raze"]));

            var chain = service.BuildChainForMap("Ascent", new InstalockerOptions
            {
                MapAgentOverrides = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
                {
                    ["Ascent"] = "Raze"
                }
            });

            Assert.Equal([ValorantTables.Agent.Raze, ValorantTables.Agent.Jett], chain);
            service.Stop("test complete");
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
