using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.HostFiltering;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.FileProviders;
using Astral.Models;
using Astral.Services;

namespace Astral;

internal static class Program
{
    /// <summary>Matches the camelCase the minimal API uses for every other route.</summary>
    private static readonly JsonSerializerOptions StreamJson = new(JsonSerializerDefaults.Web);

    /// <summary>How long the stream stays quiet before sending a keepalive comment.</summary>
    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(15);

    private static async Task Main(string[] args)
    {
        try
        {
            await RunAsync(args);
        }
        catch (Exception ex)
        {
            // Without a console subsystem there is nowhere for an unhandled
            // startup failure to surface, so say it out loud.
            MessageBox.Show(
                $"Astral could not start.{Environment.NewLine}{Environment.NewLine}{ex.Message}",
                "Astral",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private static async Task RunAsync(string[] args)
    {
        var builder = WebApplication.CreateBuilder(args);
        // Every interface, random port: the LAN companion must be reachable
        // from a phone, and the loopback-only bind the app used to have would
        // 404 the phone at the socket level. Nothing on the network is trusted
        // until the user flips the switch -- the LanGate middleware below
        // refuses every non-loopback /api request while it is off, and demands
        // the pairing token while it is on. The desktop window still talks to
        // 127.0.0.1, which is exempt, so the local experience is unchanged.
        builder.WebHost.UseUrls("http://0.0.0.0:0");

        builder.Services.Configure<InstalockerOptions>(
            builder.Configuration.GetSection(InstalockerOptions.SectionName));
        builder.Services.Configure<AutoQueueOptions>(
            builder.Configuration.GetSection(AutoQueueOptions.SectionName));
        builder.Services.Configure<UpdateOptions>(
            builder.Configuration.GetSection(UpdateOptions.SectionName));
        builder.Services.Configure<MobileOptions>(
            builder.Configuration.GetSection(MobileOptions.SectionName));
        builder.Services.AddSingleton<ValorantConnection>();
        builder.Services.AddSingleton<OptionsStore>();
        builder.Services.AddSingleton<InstalockerService>();
        builder.Services.AddSingleton<RankTrackerService>();
        builder.Services.AddSingleton<AutoQueueService>();
        builder.Services.AddSingleton<PreGameIntelService>();
        builder.Services.AddSingleton<UpdateService>();
        builder.Services.AddSingleton<LanCompanionService>();

        // Each tool is resolvable both by its own type (routes want the real
        // thing) and as a stream source (/api/events wants them all).
        builder.Services.AddSingleton<IModuleStateSource>(sp => sp.GetRequiredService<InstalockerService>());
        builder.Services.AddSingleton<IModuleStateSource>(sp => sp.GetRequiredService<RankTrackerService>());
        builder.Services.AddSingleton<IModuleStateSource>(sp => sp.GetRequiredService<AutoQueueService>());
        builder.Services.AddSingleton<IModuleStateSource>(sp => sp.GetRequiredService<PreGameIntelService>());
        builder.Services.AddSingleton<IModuleStateSource>(sp => sp.GetRequiredService<UpdateService>());

        // Host filtering is normally bound straight off the "AllowedHosts"
        // config key, which is how the app used to refuse every non-loopback
        // host before it ever reached a route. That list stays as the base and
        // the discovered LAN addresses are added on top of it here: without
        // this, a phone's Host header would still be 400'd even with the
        // pairing token in hand.
        builder.Services.AddOptions<HostFilteringOptions>()
            .Configure<LanCompanionService>((options, lan) =>
            {
                foreach (string host in lan.AllowedHosts)
                {
                    if (!options.AllowedHosts.Contains(host, StringComparer.OrdinalIgnoreCase))
                    {
                        options.AllowedHosts.Add(host);
                    }
                }
            });

        // Singleton, not AddHttpClient<T>: a typed client is registered
        // transient, which would give every request its own instance and throw
        // the asset cache away with it.
        builder.Services.AddHttpClient();
        builder.Services.AddSingleton<ValorantApiAssetService>();

        var app = builder.Build();
        ManifestEmbeddedFileProvider webFiles = new(typeof(Program).Assembly, "wwwroot");

        app.UseDefaultFiles(new DefaultFilesOptions
        {
            FileProvider = webFiles
        });
                app.UseStaticFiles(new StaticFileOptions
        {
            FileProvider = webFiles
        });

        // The LAN gate. Loopback is exempt so the desktop window and local
        // scripts keep working exactly as before. Anything else reaching /api
        // needs the LAN switch on AND the pairing token; while the switch is
        // off every non-loopback /api request is refused outright. Static
        // assets stay public -- they carry no data, and the token lives in the
        // mobile page's URL only after the switch is on.
        LanCompanionService lanCompanion = app.Services.GetRequiredService<LanCompanionService>();
        app.Use(async (context, next) =>
        {
            HttpRequest request = context.Request;

            if (context.Connection.RemoteIpAddress is { } remote &&
                !IPAddress.IsLoopback(remote) &&
                request.Path.StartsWithSegments("/api") &&
                (!lanCompanion.IsLanEnabled || !IsPaired(request, lanCompanion.Token)))
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                await context.Response.WriteAsJsonAsync(
                    new ErrorResponse("This endpoint is only reachable from this computer or a paired phone."));
                return;
            }

            await next(context);
        });

        app.MapGet("/api/agents", (InstalockerService service) => TypedResults.Ok(service.GetAgents()));
        app.MapGet("/api/agent-assets", async Task<IResult> (
            InstalockerService service,
            ValorantApiAssetService assetService,
            CancellationToken cancellationToken) =>
        {
            var localAgents = service.GetAgents();
            IReadOnlyDictionary<string, AgentAsset> remoteAssets;

            try
            {
                remoteAssets = await assetService.GetAssetsAsync(cancellationToken);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
            {
                // Deliberately still an error status rather than a degraded 200:
                // the interface keys its "Portraits unavailable" pill and its
                // fallback to /api/agents off this failing (wwwroot/js/api.js).
                return TypedResults.Json(
                    new ErrorResponse("Agent artwork is unavailable right now."),
                    statusCode: StatusCodes.Status503ServiceUnavailable);
            }

            var payload = localAgents.Select(agent =>
            {
                remoteAssets.TryGetValue(agent.Value, out AgentAsset? asset);
                return asset ?? new AgentAsset(agent.Name, agent.Value, null, null, null, [], false, null);
            });

            return TypedResults.Ok(payload);
        });
        app.MapGet("/api/state", (InstalockerService service) => TypedResults.Ok(service.GetState()));
        // Kept exactly as documented in the README: a bare LockState per frame,
        // instalocker only. Scripts written against it keep working.
        app.MapGet("/api/state/stream", (
            HttpContext context,
            InstalockerService service,
            CancellationToken cancellationToken) =>
            StreamAsync(context, [service], BareFrame, cancellationToken));

        // Everything, tagged by tool. This is what the interface listens to.
        app.MapGet("/api/events", (
            HttpContext context,
            IEnumerable<IModuleStateSource> sources,
            CancellationToken cancellationToken) =>
            StreamAsync(context, [.. sources], EnvelopeFrame, cancellationToken));
        app.MapPost("/api/lock", Results<Ok<LockState>, BadRequest<ErrorResponse>> (
            LockRequest request,
            InstalockerService service) =>
        {
            IReadOnlyList<string> chain = request.Chain;

            if (chain.Count == 0)
            {
                return TypedResults.BadRequest(new ErrorResponse("At least one agent name is required."));
            }

            return service.StartOrUpdate(chain)
                ? TypedResults.Ok(service.GetState())
                : TypedResults.BadRequest(new ErrorResponse("No agent name could be recognised."));
        }).AddEndpointFilter(RejectForeignOrigin);
        app.MapPost("/api/stop", (InstalockerService service) =>
        {
            service.Stop("Stopped by user.");
            return TypedResults.Ok(service.GetState());
        }).AddEndpointFilter(RejectForeignOrigin);

        app.MapGet("/api/tracker", (RankTrackerService tracker) => TypedResults.Ok(tracker.GetState()));
        app.MapPost("/api/tracker/refresh", async (RankTrackerService tracker, CancellationToken cancellationToken) =>
        {
            await tracker.RefreshAsync(cancellationToken);
            return TypedResults.Ok(tracker.GetState());
        }).AddEndpointFilter(RejectForeignOrigin);
        app.MapPost("/api/tracker/session/reset", async (RankTrackerService tracker, CancellationToken cancellationToken) =>
        {
            await tracker.ResetSessionAsync(cancellationToken);
            return TypedResults.Ok(tracker.GetState());
        }).AddEndpointFilter(RejectForeignOrigin);

        app.MapGet("/api/autoqueue", (AutoQueueService queue) => TypedResults.Ok(queue.GetState()));
        app.MapPost("/api/autoqueue/start", (AutoQueueService queue) =>
        {
            queue.Start();
            return TypedResults.Ok(queue.GetState());
        }).AddEndpointFilter(RejectForeignOrigin);
        app.MapPost("/api/autoqueue/stop", (AutoQueueService queue) =>
        {
            queue.Stop("Stopped by user.");
            return TypedResults.Ok(queue.GetState());
        }).AddEndpointFilter(RejectForeignOrigin);
        app.MapPost("/api/autoqueue/refresh", async (AutoQueueService queue, CancellationToken cancellationToken) =>
            TypedResults.Ok(await queue.RefreshAsync(cancellationToken)))
            .AddEndpointFilter(RejectForeignOrigin);
        app.MapPost("/api/autoqueue/queueing", async (
            QueueingRequest request,
            AutoQueueService queue,
            CancellationToken cancellationToken) =>
            TypedResults.Ok(await queue.SetQueueingAsync(request.Queueing, cancellationToken)))
            .AddEndpointFilter(RejectForeignOrigin);

        app.MapGet("/api/intel", (PreGameIntelService intel) => TypedResults.Ok(intel.GetState()));

        // The watch is a toggle rather than a start/stop pair because the
        // interface drives it from a view being open, which is one bit of state.
        app.MapPost("/api/intel/watch", (WatchRequest request, PreGameIntelService intel) =>
        {
            if (request.Watching)
            {
                intel.StartWatching();
            }
            else
            {
                intel.StopWatching();
            }

            return TypedResults.Ok(intel.GetState());
        }).AddEndpointFilter(RejectForeignOrigin);

        app.MapGet("/api/update", (UpdateService updater) => TypedResults.Ok(updater.GetState()));

        app.MapPost("/api/update/check", async (UpdateService updater, CancellationToken cancellationToken) =>
        {
            await updater.CheckAsync(cancellationToken);
            return TypedResults.Ok(updater.GetState());
        }).AddEndpointFilter(RejectForeignOrigin);

        // Returns as soon as the download starts rather than when it finishes:
        // a large release would otherwise sit on the request past any sane
        // client timeout, and progress is on /api/events anyway.
        app.MapPost("/api/update/download", (UpdateService updater) =>
        {
            _ = updater.DownloadAsync(CancellationToken.None);
            return TypedResults.Ok(updater.GetState());
        }).AddEndpointFilter(RejectForeignOrigin);

        app.MapPost("/api/update/cancel", (UpdateService updater) =>
        {
            updater.CancelDownload();
            return TypedResults.Ok(updater.GetState());
        }).AddEndpointFilter(RejectForeignOrigin);

        app.MapPost("/api/update/apply", Results<Ok<UpdateState>, BadRequest<ErrorResponse>> (UpdateService updater) =>
        {
            if (!updater.Apply())
            {
                return TypedResults.BadRequest(
                    new ErrorResponse(updater.GetState().Error ?? "No downloaded update is ready to apply."));
            }

            return TypedResults.Ok(updater.GetState());
        }).AddEndpointFilter(RejectForeignOrigin);

        app.MapPost("/api/update/skip", async (
            SkipUpdateRequest request,
            UpdateService updater,
            CancellationToken cancellationToken) =>
        {
            await updater.SkipAsync(request.Version, cancellationToken);
            return TypedResults.Ok(updater.GetState());
        }).AddEndpointFilter(RejectForeignOrigin);

        // The LAN companion's control surface. /api/lan/status carries the
        // pairing token so the desktop panel can build the phone URL and the
        // QR; it is gated like every other /api route, which keeps it
        // loopback-only in practice (a non-loopback client would need the very
        // token it is trying to read).
        app.MapGet("/api/lan/status", (LanCompanionService lan) => TypedResults.Ok(lan.GetStatus()));

        // Session-scoped by design: the switch returns to the configured
        // default on relaunch, so a phone URL from a previous run never
        // silently stays valid.
        app.MapPost("/api/lan/enable", (LanEnableRequest request, LanCompanionService lan) =>
        {
            lan.SetLanEnabled(request.Enabled);
            return TypedResults.Ok(lan.GetStatus());
        }).AddEndpointFilter(RejectForeignOrigin);

        app.MapPost("/api/lan/firewall", Results<Ok<LanStatus>, BadRequest<ErrorResponse>> (
            LanFirewallRequest request,
            LanCompanionService lan) =>
        {
            try
            {
                lan.ApplyFirewallRule(request.Add);
            }
            catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
            {
                return TypedResults.BadRequest(new ErrorResponse(
                    "The firewall rule was not changed. The elevated prompt may have been declined."));
            }

            return TypedResults.Ok(lan.GetStatus());
        }).AddEndpointFilter(RejectForeignOrigin);

        app.MapGet("/api/autoqueue/options", (OptionsStore store) =>
            TypedResults.Ok(ToAutoQueueResponse(store.Current.AutoQueue)));
        app.MapMethods("/api/autoqueue/options", ["PATCH"], async Task<Results<Ok<AutoQueueOptionsResponse>, BadRequest<ErrorResponse>>> (
            AutoQueuePatchRequest request,
            OptionsStore store,
            CancellationToken cancellationToken) =>
        {
            AutoQueueOptions current = store.Current.AutoQueue;

            if (request.RequeueDelayMs is { } delay &&
                delay is < AutoQueueOptions.MinDelayMs or > AutoQueueOptions.MaxDelayMs)
            {
                return TypedResults.BadRequest(new ErrorResponse(
                    $"Requeue delay must be between {AutoQueueOptions.MinDelayMs} and {AutoQueueOptions.MaxDelayMs} ms."));
            }

            if (request.MaxConsecutiveRequeues is { } limit &&
                limit is < AutoQueueOptions.MinRequeues or > AutoQueueOptions.MaxRequeues)
            {
                return TypedResults.BadRequest(new ErrorResponse(
                    $"Max consecutive requeues must be between {AutoQueueOptions.MinRequeues} and {AutoQueueOptions.MaxRequeues}."));
            }

            if (request.QueueId is not null && !AutoQueueService.TryResolveQueue(request.QueueId, out _))
            {
                return TypedResults.BadRequest(new ErrorResponse($"Unknown queue: {request.QueueId}."));
            }

            AutoQueueOptions next = new()
            {
                AutoRequeue = request.AutoRequeue ?? current.AutoRequeue,
                QueueId = request.QueueId ?? current.QueueId,
                RequeueDelayMs = request.RequeueDelayMs ?? current.RequeueDelayMs,
                MaxConsecutiveRequeues = request.MaxConsecutiveRequeues ?? current.MaxConsecutiveRequeues
            };

            try
            {
                await store.ApplyAutoQueueAsync(next, cancellationToken);
            }
            catch (Exception ex)
            {
                return TypedResults.BadRequest(new ErrorResponse(
                    $"Settings applied for this session but could not be saved: {ex.Message}"));
            }

            return TypedResults.Ok(ToAutoQueueResponse(store.Current.AutoQueue));
        }).AddEndpointFilter(RejectForeignOrigin);

        app.MapGet("/api/options", (OptionsStore store) => TypedResults.Ok(ToOptionsResponse(store.Current.Instalocker)));
        app.MapMethods("/api/options", ["PATCH"], async Task<Results<Ok<OptionsResponse>, BadRequest<ErrorResponse>>> (
            OptionsPatchRequest request,
            OptionsStore store,
            CancellationToken cancellationToken) =>
        {
            InstalockerOptions current = store.Current.Instalocker;

            if (!TryValidateDelay(request.HoverDelayMs, "Hover delay", out string? delayError) ||
                !TryValidateDelay(request.LockDelayMs, "Lock delay", out delayError) ||
                !TryValidateDelay(request.PostLockDelayMs, "Post-lock delay", out delayError))
            {
                return TypedResults.BadRequest(new ErrorResponse(delayError!));
            }

            Dictionary<string, string> overrides = current.MapAgentOverrides;

            if (request.MapAgentOverrides is not null &&
                !TryNormalizeOverrides(request.MapAgentOverrides, out overrides!, out string? overrideError))
            {
                return TypedResults.BadRequest(new ErrorResponse(overrideError!));
            }

            InstalockerOptions next = new()
            {
                HoverDelayMs = request.HoverDelayMs ?? current.HoverDelayMs,
                LockDelayMs = request.LockDelayMs ?? current.LockDelayMs,
                PostLockDelayMs = request.PostLockDelayMs ?? current.PostLockDelayMs,
                MapAgentOverrides = overrides
            };

            try
            {
                await store.ApplyInstalockerAsync(next, cancellationToken);
            }
            catch (Exception ex)
            {
                // The change is already live; only persistence failed. Say so
                // rather than pretending the whole request was rejected.
                return TypedResults.BadRequest(new ErrorResponse(
                    $"Settings applied for this session but could not be saved: {ex.Message}"));
            }

            return TypedResults.Ok(ToOptionsResponse(store.Current.Instalocker));
        }).AddEndpointFilter(RejectForeignOrigin);

        app.MapFallback(async context =>
        {
            // Without this an /api typo answers with the interface's HTML and a
            // 200, which is a baffling thing to hand a script.
            if (context.Request.Path.StartsWithSegments("/api"))
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                await context.Response.WriteAsJsonAsync(new ErrorResponse("Unknown endpoint."));
                return;
            }

            IFileInfo file = webFiles.GetFileInfo("index.html");
            if (!file.Exists)
            {
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }

            context.Response.ContentType = "text/html; charset=utf-8";
            context.Response.ContentLength = file.Length;

            await using Stream stream = file.CreateReadStream();
            await stream.CopyToAsync(context.Response.Body);
        });

        await app.StartAsync();

        // The bound address is a wildcard ("http://0.0.0.0:PORT"); the port is
        // real, the wildcard is not something a browser can navigate to. The
        // desktop window gets the loopback form of the same listener, and the
        // LAN companion learns the port so it can build the phone URLs.
        string boundUrl = app.Services
            .GetRequiredService<IServer>()
            .Features
            .Get<IServerAddressesFeature>()?
            .Addresses
            .FirstOrDefault()
            ?? "http://127.0.0.1:5000";

        int port = new Uri(boundUrl).Port;
        lanCompanion.SetPort(port);
        string url = $"http://127.0.0.1:{port}";

        try
        {
            UpdateService updater = app.Services.GetRequiredService<UpdateService>();
            updater.ScheduleStartupCheck();

            // Headless validation runs (the LAN network test suite) keep the
            // server up without a window owning its lifetime; the tests kill
            // the process when they are done.
            if (args.Contains("--no-window", StringComparer.OrdinalIgnoreCase))
            {
                await Task.Delay(Timeout.Infinite);
                return;
            }

            await RunDesktopWindowAsync(
                url,
                app.Services.GetRequiredService<InstalockerService>(),
                updater);
        }
        finally
        {
            await app.StopAsync();
            await app.DisposeAsync();
        }
    }

    /// <summary>
    /// Refuses a state-changing call that a browser made from another site.
    ///
    /// The service listens on loopback with no credentials of any kind, so any
    /// page the user has open can address it once it guesses the port. Locking
    /// and PATCHing already need a preflight that is never answered, but
    /// <c>POST /api/stop</c> carries no body and no custom header, which makes
    /// it a CORS "simple" request any site can fire blind.
    ///
    /// A missing Origin is allowed through on purpose: that is curl, PowerShell
    /// and everything else the README documents. Browsers always attach one to
    /// a cross-origin POST or PATCH, including a no-cors fire-and-forget.
    /// </summary>
    private static async ValueTask<object?> RejectForeignOrigin(
        EndpointFilterInvocationContext context,
        EndpointFilterDelegate next)
    {
        HttpRequest request = context.HttpContext.Request;
        string? origin = request.Headers.Origin;

        if (IsForeignOrigin(origin, request.Scheme, request.Host.ToString()))
        {
            return TypedResults.Json(
                new ErrorResponse("Cross-origin requests are not accepted."),
                statusCode: StatusCodes.Status403Forbidden);
        }

        return await next(context);
    }

    /// <summary>
    /// True when the request carries the LAN pairing token, however it was
    /// delivered: the <c>?k=</c> query the mobile page appends to every fetch
    /// and to the EventSource URL, the <c>X-Astral-Token</c> header for
    /// scripts, or the <c>astral_pair</c> cookie. Compared in constant time so
    /// a LAN snoop cannot learn the token a byte at a time.
    /// </summary>
    internal static bool IsForeignOrigin(string? origin, string scheme, string host)
    {
        return !string.IsNullOrEmpty(origin) &&
               !string.Equals(origin, $"{scheme}://{host}", StringComparison.OrdinalIgnoreCase);
    }

    internal static bool IsPaired(HttpRequest request, string token)
    {
        string? supplied =
            request.Query["k"].FirstOrDefault() ??
            request.Headers["X-Astral-Token"].FirstOrDefault() ??
            request.Cookies["astral_pair"];

        if (string.IsNullOrEmpty(supplied))
        {
            return false;
        }

        byte[] expected = Encoding.UTF8.GetBytes(token);
        byte[] actual = Encoding.UTF8.GetBytes(supplied);

        return expected.Length == actual.Length &&
            CryptographicOperations.FixedTimeEquals(expected, actual);
    }

    /// <summary>Legacy shape: the state on its own, with no tool tag.</summary>
    private static string BareFrame(string moduleId, object state)
    {
        return $"data: {JsonSerializer.Serialize(state, StreamJson)}\n\n";
    }

    private static string EnvelopeFrame(string moduleId, object state)
    {
        return $"data: {JsonSerializer.Serialize(new ModuleEnvelope(moduleId, state), StreamJson)}\n\n";
    }

    /// <summary>
    /// One server-sent-events loop, shared by both streams. The only difference
    /// between them is how a frame is formatted and how many tools feed it.
    /// </summary>
    private static async Task StreamAsync(
        HttpContext context,
        IReadOnlyList<IModuleStateSource> sources,
        Func<string, object, string> frame,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-cache";
        context.Response.ContentType = "text/event-stream";

        // Without this the events sit in Kestrel's write buffer and the
        // client sees nothing until the connection ends.
        context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

        // Bounded and dropping the oldest: a stalled client must not grow
        // memory, and only the newest state is worth delivering anyway. Sized
        // for several tools publishing at once rather than one.
        Channel<string> queue = Channel.CreateBounded<string>(new BoundedChannelOptions(32)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false
        });

        List<IDisposable> subscriptions = new(sources.Count);

        try
        {
            foreach (IModuleStateSource source in sources)
            {
                string moduleId = source.ModuleId;
                subscriptions.Add(source.Subscribe(state => queue.Writer.TryWrite(frame(moduleId, state))));
            }

            await WriteAsync(context.Response, "retry: 3000\n\n", cancellationToken);

            // Current state up front, so a client connecting mid-session paints
            // immediately instead of waiting for something to change.
            foreach (IModuleStateSource source in sources)
            {
                await WriteAsync(context.Response, frame(source.ModuleId, source.GetModuleState()), cancellationToken);
            }

            while (!cancellationToken.IsCancellationRequested)
            {
                using CancellationTokenSource heartbeat =
                    CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                heartbeat.CancelAfter(HeartbeatInterval);

                try
                {
                    string next = await queue.Reader.ReadAsync(heartbeat.Token);
                    await WriteAsync(context.Response, next, cancellationToken);
                }
                catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    // Idle: a comment keeps the connection warm and turns a
                    // dead socket into a write failure instead of silence.
                    await WriteAsync(context.Response, ": ping\n\n", cancellationToken);
                }
            }
        }
        catch (OperationCanceledException)
        {
            // The client went away.
        }
        finally
        {
            foreach (IDisposable subscription in subscriptions)
            {
                subscription.Dispose();
            }
        }
    }

    private static async Task WriteAsync(HttpResponse response, string payload, CancellationToken cancellationToken)
    {
        await response.WriteAsync(payload, cancellationToken);
        await response.Body.FlushAsync(cancellationToken);
    }

    private static AutoQueueOptionsResponse ToAutoQueueResponse(AutoQueueOptions options)
    {
        return new AutoQueueOptionsResponse(
            options.AutoRequeue,
            options.QueueId,
            options.RequeueDelayMs,
            options.MaxConsecutiveRequeues,
            AutoQueueService.GetQueueOptions());
    }

    private static OptionsResponse ToOptionsResponse(InstalockerOptions options)
    {
        return new OptionsResponse(
            options.HoverDelayMs,
            options.LockDelayMs,
            options.PostLockDelayMs,
            options.MapAgentOverrides,
            InstalockerService.GetMapNames());
    }

    private static bool TryValidateDelay(int? value, string label, out string? error)
    {
        error = null;

        if (value is null or (>= InstalockerOptions.MinDelayMs and <= InstalockerOptions.MaxDelayMs))
        {
            return true;
        }

        error = $"{label} must be between {InstalockerOptions.MinDelayMs} and {InstalockerOptions.MaxDelayMs} ms.";
        return false;
    }

    /// <summary>
    /// Rewrites the submitted overrides with canonical map spelling so a rule
    /// saved as "ascent" still matches what pre-game reports.
    /// </summary>
    private static bool TryNormalizeOverrides(
        Dictionary<string, string> submitted,
        out Dictionary<string, string>? normalized,
        out string? error)
    {
        normalized = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        error = null;

        foreach ((string map, string agent) in submitted)
        {
            if (string.IsNullOrWhiteSpace(map) || string.IsNullOrWhiteSpace(agent))
            {
                continue;
            }

            string? canonicalMap = InstalockerService.ResolveMapNameExact(map);

            if (canonicalMap is null)
            {
                normalized = null;
                error = $"Unknown map name: {map}.";
                return false;
            }

            string? canonicalAgent = InstalockerService.ResolveAgentNameExact(agent);

            if (canonicalAgent is null)
            {
                normalized = null;
                error = $"Unknown agent name: {agent}.";
                return false;
            }

            normalized[canonicalMap] = canonicalAgent;
        }

        return true;
    }

    private static Task RunDesktopWindowAsync(string url, InstalockerService service, UpdateService updater)
    {
        TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);

        Thread uiThread = new(() =>
        {
            try
            {
                ApplicationConfiguration.Initialize();
                using var form = new DesktopAppForm(url, service, updater);
                form.FormClosed += (_, _) => completion.TrySetResult();
                Application.Run(form);
                completion.TrySetResult();
            }
            catch (Exception ex)
            {
                completion.TrySetException(ex);
            }
        });

        uiThread.SetApartmentState(ApartmentState.STA);
        uiThread.IsBackground = false;
        uiThread.Start();

        return completion.Task;
    }
}
