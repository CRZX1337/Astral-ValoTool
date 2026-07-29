using System.Text.Json;
using System.Threading.Channels;
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
        builder.WebHost.UseUrls("http://127.0.0.1:0");

        builder.Services.Configure<InstalockerOptions>(
            builder.Configuration.GetSection(InstalockerOptions.SectionName));
        builder.Services.AddSingleton<OptionsStore>();
        builder.Services.AddSingleton<InstalockerService>();
        builder.Services.AddHttpClient<ValorantApiAssetService>();

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

        app.MapGet("/api/agents", (InstalockerService service) => TypedResults.Ok(service.GetAgents()));
        app.MapGet("/api/agent-assets", async (
            InstalockerService service,
            ValorantApiAssetService assetService,
            CancellationToken cancellationToken) =>
        {
            var localAgents = service.GetAgents();
            var remoteAssets = await assetService.GetAssetsAsync(cancellationToken);

            var payload = localAgents.Select(agent =>
            {
                remoteAssets.TryGetValue(agent.Value, out AgentAsset? asset);
                return asset ?? new AgentAsset(agent.Name, agent.Value, null, null, null, [], false);
            });

            return TypedResults.Ok(payload);
        });
        app.MapGet("/api/state", (InstalockerService service) => TypedResults.Ok(service.GetState()));
        app.MapGet("/api/state/stream", async (
            HttpContext context,
            InstalockerService service,
            CancellationToken cancellationToken) =>
        {
            context.Response.Headers.CacheControl = "no-cache";
            context.Response.ContentType = "text/event-stream";

            // Without this the events sit in Kestrel's write buffer and the
            // client sees nothing until the connection ends.
            context.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();

            // Bounded and dropping the oldest: a stalled client must not grow
            // memory, and only the newest state is worth delivering anyway.
            Channel<LockState> queue = Channel.CreateBounded<LockState>(new BoundedChannelOptions(8)
            {
                FullMode = BoundedChannelFullMode.DropOldest,
                SingleReader = true,
                SingleWriter = false
            });

            void OnStateChanged(LockState state) => queue.Writer.TryWrite(state);
            service.StateChanged += OnStateChanged;

            try
            {
                await WriteAsync(context.Response, "retry: 3000\n\n", cancellationToken);
                await WriteStateAsync(context.Response, service.GetState(), cancellationToken);

                while (!cancellationToken.IsCancellationRequested)
                {
                    using CancellationTokenSource heartbeat =
                        CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                    heartbeat.CancelAfter(HeartbeatInterval);

                    try
                    {
                        LockState next = await queue.Reader.ReadAsync(heartbeat.Token);
                        await WriteStateAsync(context.Response, next, cancellationToken);
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
                service.StateChanged -= OnStateChanged;
            }
        });
        app.MapPost("/api/lock", Results<Ok<LockState>, BadRequest<ErrorResponse>> (
            LockRequest request,
            InstalockerService service) =>
        {
            if (string.IsNullOrWhiteSpace(request.Agent))
            {
                return TypedResults.BadRequest(new ErrorResponse("An agent name is required."));
            }

            return service.StartOrUpdate(request.Agent)
                ? TypedResults.Ok(service.GetState())
                : TypedResults.BadRequest(new ErrorResponse("Unknown agent name."));
        });
        app.MapPost("/api/stop", (InstalockerService service) =>
        {
            service.Stop("Stopped by user.");
            return TypedResults.Ok(service.GetState());
        });

        app.MapGet("/api/options", (OptionsStore store) => TypedResults.Ok(ToOptionsResponse(store.Current)));
        app.MapMethods("/api/options", ["PATCH"], async Task<Results<Ok<OptionsResponse>, BadRequest<ErrorResponse>>> (
            OptionsPatchRequest request,
            OptionsStore store,
            CancellationToken cancellationToken) =>
        {
            InstalockerOptions current = store.Current;

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
                await store.ApplyAsync(next, cancellationToken);
            }
            catch (Exception ex)
            {
                // The change is already live; only persistence failed. Say so
                // rather than pretending the whole request was rejected.
                return TypedResults.BadRequest(new ErrorResponse(
                    $"Settings applied for this session but could not be saved: {ex.Message}"));
            }

            return TypedResults.Ok(ToOptionsResponse(store.Current));
        });

        app.MapFallback(async context =>
        {
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

        string url = app.Services
            .GetRequiredService<IServer>()
            .Features
            .Get<IServerAddressesFeature>()?
            .Addresses
            .FirstOrDefault()
            ?? "http://127.0.0.1:5000";

        try
        {
            await RunDesktopWindowAsync(url, app.Services.GetRequiredService<InstalockerService>());
        }
        finally
        {
            await app.StopAsync();
            await app.DisposeAsync();
        }
    }

    private static Task WriteStateAsync(HttpResponse response, LockState state, CancellationToken cancellationToken)
    {
        return WriteAsync(response, $"data: {JsonSerializer.Serialize(state, StreamJson)}\n\n", cancellationToken);
    }

    private static async Task WriteAsync(HttpResponse response, string payload, CancellationToken cancellationToken)
    {
        await response.WriteAsync(payload, cancellationToken);
        await response.Body.FlushAsync(cancellationToken);
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

    private static Task RunDesktopWindowAsync(string url, InstalockerService service)
    {
        TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);

        Thread uiThread = new(() =>
        {
            try
            {
                ApplicationConfiguration.Initialize();
                using var form = new DesktopAppForm(url, service);
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
