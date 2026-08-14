using System.Security.Cryptography;
using Astral.Services;
using Xunit;

namespace Astral.Tests;

public sealed class UpdateVerificationTests
{
    [Fact]
    public void Checksum_parser_accepts_common_sha256_formats()
    {
        const string hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

        Assert.True(UpdateVerification.TryParseSha256(hash, out byte[] bare));
        Assert.Equal(32, bare.Length);
        Assert.True(UpdateVerification.TryParseSha256(hash + "  Astral.exe", out byte[] named));
        Assert.Equal(bare, named);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-hash")]
    [InlineData("0123456789abcdef")]
    [InlineData("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")]
    public void Invalid_or_missing_checksum_is_rejected(string checksum)
    {
        Assert.False(UpdateVerification.TryParseSha256(checksum, out _));
    }

    [Fact]
    public async Task Sha256_verification_accepts_matching_file_and_rejects_mismatch()
    {
        string directory = Path.Combine(Path.GetTempPath(), "AstralTests", Guid.NewGuid().ToString("N"));
        string path = Path.Combine(directory, "payload.bin");
        Directory.CreateDirectory(directory);

        try
        {
            await File.WriteAllTextAsync(path, "Astral test payload");
            byte[] expected;

            await using (FileStream stream = File.OpenRead(path))
            {
                expected = await SHA256.HashDataAsync(stream);
            }

            Assert.True(await UpdateVerification.MatchesSha256Async(path, expected));
            expected[0] ^= 0xff;
            Assert.False(await UpdateVerification.MatchesSha256Async(path, expected));
        }
        finally
        {
            File.Delete(path);
            Directory.Delete(directory);
        }
    }

    [Fact]
    public void Unsigned_file_is_rejected_when_signature_is_required()
    {
        string directory = Path.Combine(Path.GetTempPath(), "AstralTests", Guid.NewGuid().ToString("N"));
        string path = Path.Combine(directory, "payload.exe");
        Directory.CreateDirectory(directory);

        try
        {
            File.WriteAllBytes(path, [0, 1, 2, 3]);
            Assert.False(UpdateVerification.HasValidAuthenticode(path, null));
        }
        finally
        {
            File.Delete(path);
            Directory.Delete(directory);
        }
    }
}
