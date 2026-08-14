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
        using FileStream stream = OpenControlledRead(path);
        return MatchesSha256(stream, expected);
    }

    internal static FileStream OpenControlledRead(string path)
    {
        return new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 81920,
            options: FileOptions.SequentialScan);
    }

    internal static bool MatchesSha256(Stream stream, byte[] expected)
    {
        if (stream.CanSeek)
        {
            stream.Position = 0;
        }

        byte[] actual = SHA256.HashData(stream);

        if (stream.CanSeek)
        {
            stream.Position = 0;
        }

        return actual.Length == expected.Length && CryptographicOperations.FixedTimeEquals(actual, expected);
    }

    /// <summary>
    /// The gate every update must pass. The SHA-256 check is always mandatory;
    /// Authenticode only counts when the user enabled it, and a valid signature
    /// never compensates for a hash mismatch.
    /// </summary>
    internal static bool PassesIntegrityGate(bool sha256Matches, bool requireAuthenticode, bool hasValidAuthenticode)
        => sha256Matches && (!requireAuthenticode || hasValidAuthenticode);

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
        IntPtr filePath = IntPtr.Zero;
        IntPtr filePtr = IntPtr.Zero;
        bool verifyCalled = false;
        WINTRUST_DATA data = default;

        try
        {
            filePath = Marshal.StringToCoTaskMemUni(path);
            WINTRUST_FILE_INFO file = new()
            {
                cbStruct = (uint)Marshal.SizeOf<WINTRUST_FILE_INFO>(),
                pcwszFilePath = filePath
            };

            filePtr = Marshal.AllocCoTaskMem(Marshal.SizeOf<WINTRUST_FILE_INFO>());
            Marshal.StructureToPtr(file, filePtr, false);

            data = new WINTRUST_DATA
            {
                cbStruct = (uint)Marshal.SizeOf<WINTRUST_DATA>(),
                dwUIChoice = WtdUiNone,
                fdwRevocationChecks = WtdRevokeWholeChain,
                dwUnionChoice = WtdChoiceFile,
                pFile = filePtr,
                // VERIFY creates provider state in hWVTStateData. CLOSE below
                // releases that state on both success and failure.
                dwStateAction = WtdStateActionVerify,
                dwProvFlags = WtdRevocationCheckChainExcludeRoot
            };

            verifyCalled = true;
            return WinVerifyTrust(IntPtr.Zero, ref action, ref data) == 0;
        }
        finally
        {
            if (verifyCalled && filePtr != IntPtr.Zero)
            {
                WINTRUST_DATA closeData = data;
                closeData.dwStateAction = WtdStateActionClose;

                try
                {
                    // The verification result is authoritative. Cleanup must not
                    // replace it, and WinTrust's CLOSE call has no useful result
                    // for this boolean API.
                    _ = WinVerifyTrust(IntPtr.Zero, ref action, ref closeData);
                }
                catch
                {
                    // Continue to release every allocation even if the native
                    // cleanup call itself cannot complete.
                }
            }

            if (filePtr != IntPtr.Zero)
            {
                Marshal.DestroyStructure<WINTRUST_FILE_INFO>(filePtr);
                Marshal.FreeCoTaskMem(filePtr);
            }

            if (filePath != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(filePath);
            }
        }
    }

    private const uint WtdUiNone = 2;
    private const uint WtdRevokeNone = 0;
    private const uint WtdRevokeWholeChain = 1;
    private const uint WtdChoiceFile = 1;
    private const uint WtdStateActionVerify = 1;
    private const uint WtdStateActionClose = 2;
    private const uint WtdRevocationCheckChainExcludeRoot = 0x00000080;

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
