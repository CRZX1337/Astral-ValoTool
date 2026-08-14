using Astral.Services;
using Xunit;

namespace Astral.Tests;

public sealed class UpdateAssetSelectionTests
{
    [Fact]
    public void Only_exact_executable_and_matching_checksum_assets_are_selected()
    {
        var release = new UpdateService.Release
        {
            Assets =
            [
                new UpdateService.ReleaseAsset { Name = "other.exe", BrowserDownloadUrl = "https://example/other" },
                new UpdateService.ReleaseAsset { Name = "Astral.exe", BrowserDownloadUrl = "https://example/astral" },
                new UpdateService.ReleaseAsset { Name = "Astral.exe.sha256", BrowserDownloadUrl = "https://example/hash" }
            ]
        };

        UpdateService.ReleaseDownload? selected = UpdateService.PickAsset(release);

        Assert.NotNull(selected);
        Assert.Equal("Astral.exe", selected.Executable.Name);
        Assert.Equal("Astral.exe.sha256", selected.Checksum.Name);
    }

    [Fact]
    public void Missing_expected_asset_or_checksum_is_rejected()
    {
        var executableOnly = new UpdateService.Release
        {
            Assets = [new UpdateService.ReleaseAsset { Name = "Astral.exe", BrowserDownloadUrl = "https://example/astral" }]
        };
        var wrongExecutable = new UpdateService.Release
        {
            Assets =
            [
                new UpdateService.ReleaseAsset { Name = "other.exe", BrowserDownloadUrl = "https://example/other" },
                new UpdateService.ReleaseAsset { Name = "Astral.exe.sha256", BrowserDownloadUrl = "https://example/hash" }
            ]
        };

        Assert.Null(UpdateService.PickAsset(executableOnly));
        Assert.Null(UpdateService.PickAsset(wrongExecutable));
    }
}
