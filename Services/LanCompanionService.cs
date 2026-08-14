using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using Microsoft.Extensions.Options;
using Astral.Models;

namespace Astral.Services;

/// <summary>
/// Owns everything the LAN companion needs: the per-launch pairing token, the
/// discovered LAN addresses, the enable/disable switch, and (read-only, plus
/// an explicitly requested rule) the Windows Firewall story.
///
/// Security model: the server binds every interface so a phone on the same
/// network can reach it, but nothing on the network is trusted until the user
/// turns the switch on. While it is off, every non-loopback /api request gets
/// a 403. Once it is on, non-loopback /api requests must carry the pairing
/// token (a random 32-hex string minted at launch, embedded in the phone URL
/// and QR). Loopback requests are exempt -- the desktop window and local
/// scripts keep working exactly as before, with or without the token.
///
/// The token rotates on every launch. The phone URL dies with the app, which
/// is the point: a token that is never reused cannot be replayed later.
/// </summary>
public sealed class LanCompanionService
{
    /// <summary>The firewall rule name, shared with the shell's netsh calls.</summary>
    public const string FirewallRuleName = "Astral LAN Companion";

    /// <summary>The token as hex characters: 16 bytes of entropy, 128 bits.</summary>
    private const int TokenHexLength = 32;
    private const int PortUnknown = -1;

    /// <summary>Adapter-name fragments that mark a virtual interface, not a real network.</summary>
    private static readonly string[] VirtualAdapterMarks =
    [
        "hyper-v", "hyperv", "docker", "vethernet", "vswitch", "tap", "tun",
        "wireguard", "tailscale", "zerotier", "wsl", "vbox", "vmware",
        "virtual", "loopback", "vpn", "nordvpn", "proton vpn", "openvpn"
    ];

    private readonly object _sync = new();
    private bool _lanEnabled;
    private int _port = PortUnknown;

    public LanCompanionService(IOptions<MobileOptions> options)
    {
        _lanEnabled = options.Value.LanEnabled;
        Token = RandomNumberGenerator.GetHexString(TokenHexLength);
        LanIps = DiscoverLanIps();
        AllowedHosts = ["127.0.0.1", "localhost", "[::1]", .. LanIps];
    }

    /// <summary>Read-only: a fresh 32-hex token per launch.</summary>
    public string Token { get; }

    /// <summary>The machine's reachable LAN addresses, discovered once at startup.</summary>
    public IReadOnlyList<string> LanIps { get; }

    /// <summary>
    /// The hosts that may reach the server, for the host-filtering middleware:
    /// loopback plus every discovered LAN address. Set from code because the
    /// config default of "127.0.0.1;localhost" would 400 every phone.
    /// </summary>
    public string[] AllowedHosts { get; }

    public bool IsLanEnabled
    {
        get
        {
            lock (_sync)
            {
                return _lanEnabled;
            }
        }
    }

    /// <summary>Session-scoped on purpose: a restart returns to the configured default.</summary>
    public void SetLanEnabled(bool enabled)
    {
        lock (_sync)
        {
            _lanEnabled = enabled;
        }
    }

    /// <summary>Called once the random port is known (after the server starts).</summary>
    public void SetPort(int port)
    {
        lock (_sync)
        {
            _port = port;
        }
    }

    public int Port
    {
        get
        {
            lock (_sync)
            {
                return _port;
            }
        }
    }

    /// <summary>
    /// One URL per LAN address, with the pairing token embedded. These are what
    /// the phone scans or types. Deliberately only the mobile page: the QR must
    /// not carry a raw API path, because then opening it on a computer would
    /// hand out the token with no mobile UI attached.
    /// </summary>
    public IReadOnlyList<string> MobileUrls
    {
        get
        {
            int port = Port;

            if (port == PortUnknown || LanIps.Count == 0)
            {
                return [];
            }

            string[] urls = new string[LanIps.Count];

            for (int i = 0; i < LanIps.Count; i++)
            {
                urls[i] = $"http://{LanIps[i]}:{port}/mobile.html?k={Token}";
            }

            return urls;
        }
    }

    /// <summary>
    /// Whether our own firewall rule exists, read straight from the shell.
    /// Best effort: netsh is localised and its output is not guaranteed; an
    /// unreadable answer reads as "no rule", which is the safe direction.
    /// </summary>
    public bool FirewallRuleExists => RunNetsh(
        $"advfirewall firewall show rule name=\"{FirewallRuleName}\""
    )?.Contains(FirewallRuleName, StringComparison.OrdinalIgnoreCase) == true;

    /// <summary>
    /// True when the private profile's firewall is on (the default). Read via
    /// the Windows Firewall COM API rather than netsh: netsh's output is
    /// localised, while the COM enum is language-independent.
    /// </summary>
    public bool FirewallPrivateProfileOn
    {
        get
        {
            try
            {
                // NET_FW_PROFILE2_PRIVATE = 1.
                dynamic policy = Activator.CreateInstance(
                    Type.GetTypeFromProgID("HNetCfg.FwPolicy2")
                    ?? throw new PlatformNotSupportedException())!;
                return policy.FirewallProfiles[1].Enabled == true;
            }
            catch (Exception)
            {
                // Unreadable (old shell, blocked COM) reads as "unknown", and
                // the panel's wording treats unknown as "assume it is on".
                return true;
            }
        }
    }

    /// <summary>
    /// Adds or removes the inbound rule for the current port. Only ever called
    /// from an explicit click, and elevated -- the UAC prompt is the consent.
    /// The rule is scoped to the private profile so public networks stay
    /// blocked even when the machine moves to one. Throws Win32Exception when
    /// the user declines the elevation, which the caller reports as-is.
    /// </summary>
    public void ApplyFirewallRule(bool add)
    {
        string rule = add
            ? $"advfirewall firewall add rule name=\"{FirewallRuleName}\" dir=in action=allow " +
              $"protocol=TCP localport={Port} profile=private"
            : $"advfirewall firewall delete rule name=\"{FirewallRuleName}\"";

        RunNetshElevated(rule);
    }

    /// <summary>
    /// The whole status snapshot the "Open on phone" panel renders. The token
    /// travels inside this response: it is the desktop's own screen, reached
    /// over loopback, and it is what lets the panel build the URL and the QR.
    /// </summary>
    public LanStatus GetStatus()
    {
        IReadOnlyList<string> urls = IsLanEnabled ? MobileUrls : [];

        return new LanStatus(
            Enabled: IsLanEnabled,
            Port: Port,
            Token: Token,
            Ips: LanIps,
            Urls: urls,
            FirewallRuleExists: FirewallRuleExists,
            FirewallPrivateProfileOn: FirewallPrivateProfileOn);
    }

    /// <summary>
    /// Every Up IPv4 interface that actually looks like a route to the LAN:
    /// not loopback, not link-local, and it must carry a default gateway --
    /// the phone has to be able to reach the address, which a gateway-less
    /// interface usually cannot. Virtual adapters (Docker, Hyper-V, VPNs, ...)
    /// are skipped by name so the panel does not offer a dozen bogus URLs.
    /// </summary>
    private static IReadOnlyList<string> DiscoverLanIps()
    {
        List<(string Address, bool Private)> candidates = [];

        try
        {
            foreach (NetworkInterface nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                if (nic.OperationalStatus != OperationalStatus.Up ||
                    nic.NetworkInterfaceType == NetworkInterfaceType.Loopback)
                {
                    continue;
                }

                string name = nic.Name ?? "";
                string description = nic.Description ?? "";
                string haystack = (name + " " + description).ToLowerInvariant();

                if (VirtualAdapterMarks.Any(mark => haystack.Contains(mark, StringComparison.OrdinalIgnoreCase)))
                {
                    continue;
                }

                IPInterfaceProperties properties = nic.GetIPProperties();
                bool hasGateway = properties.GatewayAddresses.Count > 0;

                foreach (UnicastIPAddressInformation address in properties.UnicastAddresses)
                {
                    IPAddress ip = address.Address;

                    if (ip.AddressFamily != AddressFamily.InterNetwork ||
                        IPAddress.IsLoopback(ip))
                    {
                        continue;
                    }

                    byte[] bytes = ip.GetAddressBytes();

                    // Link-local (169.254.x) is Windows' "no DHCP answer" fallback.
                    if (bytes[0] == 169 && bytes[1] == 254)
                    {
                        continue;
                    }

                    if (!hasGateway)
                    {
                        continue;
                    }

                    // Private ranges first: those are the ones a phone on the
                    // home Wi-Fi can actually reach.
                    bool privateRange =
                        bytes[0] == 10 ||
                        (bytes[0] == 172 && bytes[1] is >= 16 and <= 31) ||
                        (bytes[0] == 192 && bytes[1] == 168);

                    candidates.Add((ip.ToString(), privateRange));
                }
            }
        }
        catch (Exception)
        {
            // No usable NICs: the panel shows "no addresses" and the app still
            // runs for the desktop alone.
        }

        return candidates
            .OrderByDescending(entry => entry.Private)
            .Select(entry => entry.Address)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    private static string? RunNetsh(string arguments)
    {
        try
        {
            Process? started = Process.Start(new ProcessStartInfo("netsh", arguments)
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            });

            if (started is null)
            {
                return null;
            }

            using Process process = started;

            string output = process.StandardOutput.ReadToEnd() ?? "";
            process.WaitForExit(5000);

            if (!process.HasExited)
            {
                process.Kill();
                return null;
            }

            return output;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>Runs netsh elevated. The UAC prompt is the point; declining it throws.</summary>
    private static void RunNetshElevated(string arguments)
    {
        ProcessStartInfo info = new("netsh", arguments)
        {
            UseShellExecute = true,
            Verb = "runas",
            CreateNoWindow = true
        };

        using Process process = Process.Start(info)
            ?? throw new InvalidOperationException("Could not start an elevated shell.");
        process.WaitForExit(60000);
    }
}
