using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
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
    public void Structurally_valid_unsigned_Astral_executable_is_rejected()
    {
        string path = Path.Combine(Path.GetDirectoryName(typeof(UpdateService).Assembly.Location)!, "Astral.exe");

        Assert.True(File.Exists(path), "The unsigned Astral.exe test artifact was not built.");
        Assert.True(IsPortableExecutable(path), "The Astral test artifact is not a valid PE executable.");
        Assert.False(UpdateVerification.HasValidAuthenticode(path, null));
    }

    [Fact]
    public void Trusted_Windows_binary_is_accepted_when_available()
    {
        string? path = FindTrustedWindowsBinary();
        Assert.True(path is not null, "No signed Windows PE candidate is available for Authenticode verification.");

        Assert.True(UpdateVerification.HasValidAuthenticode(path!, null));
    }

    [Fact]
    public void Tampering_with_a_trusted_Windows_binary_is_rejected()
    {
        string? source = FindTrustedWindowsBinary();
        Assert.True(source is not null, "No signed Windows PE candidate is available for Authenticode verification.");

        string directory = Path.Combine(Path.GetTempPath(), "AstralTests", Guid.NewGuid().ToString("N"));
        string path = Path.Combine(directory, "tampered.exe");
        Directory.CreateDirectory(directory);

        try
        {
            File.Copy(source!, path);
            using (FileStream stream = new(path, FileMode.Open, FileAccess.ReadWrite, FileShare.Read))
            {
                long coveredOffset = FindCoveredSectionOffset(stream);
                stream.Position = coveredOffset;
                int value = stream.ReadByte();
                Assert.NotEqual(-1, value);
                stream.Position = coveredOffset;
                stream.WriteByte((byte)(value ^ 0xA5));
            }

            Assert.False(UpdateVerification.HasValidAuthenticode(path, null));
        }
        finally
        {
            File.Delete(path);
            Directory.Delete(directory);
        }
    }

    [Fact]
    public void RequiredSignerSubject_must_match_the_trusted_signer()
    {
        string? path = FindTrustedWindowsBinary();
        Assert.True(path is not null, "No signed Windows PE candidate is available for Authenticode verification.");

#pragma warning disable SYSLIB0057
        using X509Certificate2 certificate = new(X509Certificate.CreateFromSignedFile(path!));
#pragma warning restore SYSLIB0057

        Assert.True(UpdateVerification.HasValidAuthenticode(path!, certificate.Subject));
        Assert.False(UpdateVerification.HasValidAuthenticode(path!, "CN=Definitely Not The Windows Signer"));
    }

    [Fact]
    public async Task Sha256_only_policy_proceeds_without_authenticode()
    {
        string path = Path.Combine(Path.GetDirectoryName(typeof(UpdateService).Assembly.Location)!, "Astral.exe");

        Assert.True(File.Exists(path), "The unsigned Astral.exe test artifact was not built.");

        byte[] expected;
        await using (FileStream stream = File.OpenRead(path))
        {
            expected = await SHA256.HashDataAsync(stream);
        }

        Assert.True(await UpdateVerification.MatchesSha256Async(path, expected));
        Assert.False(UpdateVerification.HasValidAuthenticode(path, null), "The unsigned Astral test artifact unexpectedly has a valid signature.");
        Assert.True(UpdateVerification.PassesIntegrityGate(sha256Matches: true, requireAuthenticode: false, hasValidAuthenticode: false));

        expected[0] ^= 0xff;
        Assert.False(await UpdateVerification.MatchesSha256Async(path, expected));
        Assert.False(UpdateVerification.PassesIntegrityGate(sha256Matches: false, requireAuthenticode: false, hasValidAuthenticode: true));
    }

    [Fact]
    public void Authenticode_policy_is_enforced_when_enabled()
    {
        Assert.False(UpdateVerification.PassesIntegrityGate(sha256Matches: true, requireAuthenticode: true, hasValidAuthenticode: false));
        Assert.True(UpdateVerification.PassesIntegrityGate(sha256Matches: true, requireAuthenticode: true, hasValidAuthenticode: true));
        Assert.False(UpdateVerification.PassesIntegrityGate(sha256Matches: false, requireAuthenticode: true, hasValidAuthenticode: true));
    }

    [Fact]
    public void Default_configuration_does_not_require_authenticode()
    {
        Assert.False(new UpdateOptions().RequireAuthenticodeSignature);

        string configPath = Path.Combine(Path.GetDirectoryName(typeof(UpdateOptions).Assembly.Location)!, "appsettings.json");
        Assert.True(File.Exists(configPath), "The appsettings.json test artifact was not copied.");
        using JsonDocument config = JsonDocument.Parse(File.ReadAllText(configPath));
        Assert.False(config.RootElement.GetProperty("Update").GetProperty("RequireAuthenticodeSignature").GetBoolean());
    }

    private static string? FindTrustedWindowsBinary()
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }

        string[] candidates =
        [
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "dotnet", "dotnet.exe"),
            Path.Combine(Environment.SystemDirectory, "notepad.exe"),
            Path.Combine(Environment.SystemDirectory, "where.exe"),
            Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe")
        ];

        foreach (string candidate in candidates.Where(File.Exists))
        {
            try
            {
#pragma warning disable SYSLIB0057
                using X509Certificate certificate = X509Certificate.CreateFromSignedFile(candidate);
#pragma warning restore SYSLIB0057
                return candidate;
            }
            catch (CryptographicException)
            {
                // Try the next shipped Windows binary. The test assertion below
                // verifies this candidate through Astral's real WinTrust path.
            }
        }

        return null;
    }

    private static bool IsPortableExecutable(string path)
    {
        using FileStream stream = File.OpenRead(path);
        return stream.Length >= 0x40 &&
               ReadUInt16(stream, 0) == 0x5A4D &&
               ReadUInt32(stream, 0x3C) is uint peOffset &&
               peOffset <= stream.Length - 4 &&
               ReadUInt32(stream, peOffset) == 0x00004550;
    }

    private static long FindCoveredSectionOffset(FileStream stream)
    {
        Assert.Equal((ushort)0x5A4D, ReadUInt16(stream, 0));
        uint peOffset = ReadUInt32(stream, 0x3C);
        Assert.Equal(0x00004550u, ReadUInt32(stream, peOffset));

        ushort sectionCount = ReadUInt16(stream, peOffset + 6);
        ushort optionalHeaderSize = ReadUInt16(stream, peOffset + 20);
        long sectionOffset = peOffset + 24L + optionalHeaderSize;

        for (int index = 0; index < sectionCount; index++)
        {
            long header = sectionOffset + index * 40L;
            uint rawSize = ReadUInt32(stream, header + 16);
            uint rawOffset = ReadUInt32(stream, header + 20);

            if (rawSize > 0 && rawOffset < stream.Length)
            {
                return rawOffset;
            }
        }

        throw new InvalidDataException("The signed Windows test binary has no raw PE section to modify.");
    }

    private static ushort ReadUInt16(Stream stream, long offset)
    {
        Span<byte> bytes = stackalloc byte[2];
        stream.Position = offset;
        stream.ReadExactly(bytes);
        return BitConverter.ToUInt16(bytes);
    }

    private static uint ReadUInt32(Stream stream, long offset)
    {
        Span<byte> bytes = stackalloc byte[4];
        stream.Position = offset;
        stream.ReadExactly(bytes);
        return BitConverter.ToUInt32(bytes);
    }

}
