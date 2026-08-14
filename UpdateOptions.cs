namespace Astral;

public sealed class UpdateOptions
{
    public const string SectionName = "Update";

    /// <summary>
    /// The repository releases are published to, <c>owner/name</c>. Configurable
    /// so a fork updates from its own releases rather than from upstream.
    /// </summary>
    public string Repository { get; set; } = "CRZX1337/Astral-ValoTool";

    /// <summary>
    /// Look for a newer release shortly after launch. The check is one anonymous
    /// GET against the GitHub API and carries nothing about the machine, but it
    /// is still a network call the user did not ask for, so it is switchable.
    /// </summary>
    public bool CheckOnStartup { get; set; } = true;

    /// <summary>Whether pre-releases count as updates. Off: only full releases.</summary>
    public bool IncludePrereleases { get; set; }

    /// <summary>Reject downloaded executables without a valid Authenticode signature.</summary>
    public bool RequireAuthenticodeSignature { get; set; } = true;

    /// <summary>Optional exact certificate subject to require after signature validation.</summary>
    public string? RequiredSignerSubject { get; set; }

    /// <summary>
    /// A version the user dismissed. Suppresses the banner for that release only
    /// -- the next one is announced normally, so dismissing once does not opt out
    /// of updates for good.
    /// </summary>
    public string? SkippedVersion { get; set; }
}
