using System.Security.Cryptography;
using Astral.Services;
using Xunit;

namespace Astral.Tests;

public sealed class UpdateApplyTests
{
    [Fact]
    public async Task Controlled_staged_handle_blocks_write_and_delete_until_released()
    {
        string directory = Path.Combine(Path.GetTempPath(), "AstralTests", Guid.NewGuid().ToString("N"));
        string path = Path.Combine(directory, "Astral.exe");
        Directory.CreateDirectory(directory);

        try
        {
            await File.WriteAllBytesAsync(path, [1, 2, 3, 4]);

            using (FileStream controlled = UpdateVerification.OpenControlledRead(path))
            {
                Assert.ThrowsAny<IOException>(() =>
                {
                    using FileStream _ = new(path, FileMode.Open, FileAccess.Write, FileShare.Read);
                });

                Assert.ThrowsAny<IOException>(() => File.Delete(path));

                byte[] expected;
                controlled.Position = 0;
                using (SHA256 sha = SHA256.Create())
                {
                    expected = sha.ComputeHash(controlled);
                }

                Assert.True(UpdateVerification.MatchesSha256(controlled, expected));
            }

            File.Delete(path);
            Assert.False(File.Exists(path));
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
