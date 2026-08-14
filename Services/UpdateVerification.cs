using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Astral.Services;

internal static class UpdateVerification
{
    internal static bool TryParseSha256(string? text, out byte[] hash)
    {
        hash = [];

        string token = text?
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .FirstOrDefault() ?? string.Empty;

        if (token.Length != 64)
        {
            return false;
        }

        try
        {
            hash = Convert.FromHexString(token);
            return hash.Length == 32;
        }
        catch (FormatException)
        {
            hash = [];
            return false;
        }
    }

    internal static async Task<bool> MatchesSha256Async(
        string path,
        byte[] expected,
        CancellationToken cancellationToken = default)
    {
        await using FileStream stream = File.OpenRead(path);
        byte[] actual = await SHA256.HashDataAsync(stream, cancellationToken).ConfigureAwait(false);
        return actual.Length == expected.Length && CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    internal static bool MatchesSha256(string path, byte[] expected)
    {
        using FileStream stream = File.OpenRead(path);
        byte[] actual = SHA256.HashData(stream);
        return actual.Length == expected.Length && CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    internal static bool HasValidAuthenticode(string path, string? requiredSubject)
    {
        if (!OperatingSystem.IsWindows() || !WinVerifyTrust(path))
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(requiredSubject))
        {
            return true;
        }

        try
        {
#pragma warning disable SYSLIB0057
            using X509Certificate2 certificate = new(X509Certificate.CreateFromSignedFile(path));
#pragma warning restore SYSLIB0057
            return string.Equals(certificate.Subject, requiredSubject.Trim(), StringComparison.OrdinalIgnoreCase);
        }
        catch (CryptographicException)
        {
            return false;
        }
    }

    private static bool WinVerifyTrust(string path)
    {
        Guid action = WinTrustActionGenericVerifyV2;
        WINTRUST_FILE_INFO file = new()
        {
            cbStruct = (uint)Marshal.SizeOf<WINTRUST_FILE_INFO>(),
            pcwszFilePath = Marshal.StringToCoTaskMemUni(path)
        };

        IntPtr filePtr = Marshal.AllocCoTaskMem(Marshal.SizeOf<WINTRUST_FILE_INFO>());
        Marshal.StructureToPtr(file, filePtr, false);

        WINTRUST_DATA data = new()
        {
            cbStruct = (uint)Marshal.SizeOf<WINTRUST_DATA>(),
            dwUIChoice = WtdUiNone,
            fdwRevocationChecks = WtdRevokeNone,
            dwUnionChoice = WtdChoiceFile,
            pFile = filePtr,
            dwStateAction = WtdStateActionIgnore,
            dwProvFlags = WtdRevocationCheckNone
        };

        try
        {
            return WinVerifyTrust(IntPtr.Zero, ref action, ref data) == 0;
        }
        finally
        {
            Marshal.DestroyStructure<WINTRUST_FILE_INFO>(filePtr);
            Marshal.FreeCoTaskMem(filePtr);
            Marshal.FreeCoTaskMem(file.pcwszFilePath);
        }
    }

    private const uint WtdUiNone = 2;
    private const uint WtdRevokeNone = 0;
    private const uint WtdChoiceFile = 1;
    private const uint WtdStateActionIgnore = 0;
    private const uint WtdRevocationCheckNone = 0x00000010;

    private static readonly Guid WinTrustActionGenericVerifyV2 = new("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");

    [DllImport("wintrust.dll", ExactSpelling = true, PreserveSig = true)]
    private static extern int WinVerifyTrust(
        IntPtr hwnd,
        ref Guid pgActionID,
        ref WINTRUST_DATA pWtd);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WINTRUST_FILE_INFO
    {
        public uint cbStruct;
        public IntPtr pcwszFilePath;
        public IntPtr hFile;
        public IntPtr pgKnownSubject;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WINTRUST_DATA
    {
        public uint cbStruct;
        public IntPtr pPolicyCallbackData;
        public IntPtr pSIPClientData;
        public uint dwUIChoice;
        public uint fdwRevocationChecks;
        public uint dwUnionChoice;
        public IntPtr pFile;
        public uint dwStateAction;
        public IntPtr hWVTStateData;
        public IntPtr pwszURLReference;
        public uint dwProvFlags;
        public uint dwUIContext;
        public IntPtr pSignatureSettings;
    }
}
