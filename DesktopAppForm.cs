using Microsoft.Web.WebView2.WinForms;
using Astral.Models;
using Astral.Services;

namespace Astral;

public sealed class DesktopAppForm : Form
{
    private const string IconResourceName = "Astral.app.ico";

    /// <summary>NotifyIcon.Text is capped by the shell; longer values throw.</summary>
    private const int MaxTrayTextLength = 63;

    private readonly string _url;
    private readonly InstalockerService _service;
    private readonly Icon? _appIcon = LoadAppIcon();
    private readonly NotifyIcon _tray;
    private readonly WebView2 _webView = new()
    {
        Dock = DockStyle.Fill
    };

    private bool _exitRequested;
    private bool _announcedTray;

    public DesktopAppForm(string url, InstalockerService service)
    {
        _url = url;
        _service = service;
        Text = "Astral";

        if (_appIcon is not null)
        {
            Icon = _appIcon;
        }

        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1000, 550);
        MinimumSize = new Size(1000, 550);
        FormBorderStyle = FormBorderStyle.Sizable;
        MaximizeBox = true;
        MinimizeBox = true;
        BackColor = Color.FromArgb(11, 11, 15);

        _tray = CreateTray();
        ApplyTrayText(_service.GetState());
        _service.StateChanged += OnServiceStateChanged;

        Controls.Add(_webView);
        Shown += async (_, _) =>
        {
            await InitializeWebViewAsync();
        };
    }

    /// <summary>
    /// Closing the window parks the app in the tray so a configured lock loop
    /// survives an accidental close. Only a user closing the window is caught:
    /// Windows shutting down, or our own Exit item, must be allowed through or
    /// the machine cannot shut down.
    /// </summary>
    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing && !_exitRequested)
        {
            e.Cancel = true;
            HideToTray();
            return;
        }

        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _service.StateChanged -= OnServiceStateChanged;

            // Hide before disposing: an icon that is only removed on dispose can
            // linger in the notification area until the pointer passes over it.
            _tray.Visible = false;
            _tray.ContextMenuStrip?.Dispose();
            _tray.Dispose();

            _appIcon?.Dispose();
        }

        base.Dispose(disposing);
    }

    private NotifyIcon CreateTray()
    {
        ContextMenuStrip menu = new()
        {
            Renderer = new DarkMenuRenderer(),
            BackColor = Color.FromArgb(18, 20, 27)
        };

        menu.Items.Add("Open", null, (_, _) => RestoreWindow());
        menu.Items.Add("Stop locking", null, (_, _) => _service.Stop("Stopped from the tray."));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitApplication());

        NotifyIcon tray = new()
        {
            Icon = _appIcon ?? SystemIcons.Application,
            Text = "Astral",
            ContextMenuStrip = menu,
            Visible = true
        };

        tray.DoubleClick += (_, _) => RestoreWindow();
        return tray;
    }

    private void HideToTray()
    {
        Hide();

        if (_announcedTray)
        {
            return;
        }

        _announcedTray = true;
        _tray.ShowBalloonTip(
            4000,
            "Still running",
            "Astral keeps monitoring from here. Right-click the icon to stop or exit.",
            ToolTipIcon.Info);
    }

    private void RestoreWindow()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void ExitApplication()
    {
        _exitRequested = true;
        _tray.Visible = false;
        Close();
    }

    /// <summary>
    /// Raised from the instalock worker thread, so it has to hop onto the UI
    /// thread before touching the tray icon.
    /// </summary>
    private void OnServiceStateChanged(LockState state)
    {
        if (IsDisposed || !IsHandleCreated)
        {
            return;
        }

        BeginInvoke(() => ApplyTrayText(state));
    }

    private void ApplyTrayText(LockState state)
    {
        string status = state.Error ?? state.Status;
        string text = $"Astral — {status}";

        _tray.Text = text.Length <= MaxTrayTextLength
            ? text
            : string.Concat(text.AsSpan(0, MaxTrayTextLength - 1), "…");
    }

    private static Icon? LoadAppIcon()
    {
        using Stream? stream = typeof(DesktopAppForm).Assembly.GetManifestResourceStream(IconResourceName);
        return stream is null ? null : new Icon(stream);
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            await _webView.EnsureCoreWebView2Async();
            _webView.Source = new Uri(_url);
        }
        catch (Exception ex)
        {
            _webView.Visible = false;
            ShowInitializationError(ex);
        }
    }

    private void ShowInitializationError(Exception ex)
    {
        Label message = new()
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(28),
            ForeColor = Color.Gainsboro,
            BackColor = Color.FromArgb(11, 11, 15),
            Font = new Font("Segoe UI", 11F, FontStyle.Regular, GraphicsUnit.Point),
            Text = "The desktop window could not start WebView2.\r\n\r\n" +
                   "Install or repair the Microsoft Edge WebView2 Runtime, then restart the app.\r\n\r\n" +
                   $"Error: {ex.Message}"
        };

        Controls.Add(message);
        message.BringToFront();
    }

    /// <summary>
    /// WinForms menus do not follow the system dark theme, so a stock context
    /// menu would flash bright white out of an otherwise dark app.
    /// </summary>
    private sealed class DarkMenuRenderer : ToolStripProfessionalRenderer
    {
        public DarkMenuRenderer() : base(new DarkColorTable())
        {
        }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item?.Enabled == true
                ? Color.FromArgb(241, 242, 246)
                : Color.FromArgb(120, 126, 140);

            base.OnRenderItemText(e);
        }

        private sealed class DarkColorTable : ProfessionalColorTable
        {
            private static readonly Color Surface = Color.FromArgb(18, 20, 27);
            private static readonly Color Highlight = Color.FromArgb(38, 41, 52);
            private static readonly Color Line = Color.FromArgb(52, 56, 68);

            public override Color ToolStripDropDownBackground => Surface;
            public override Color ImageMarginGradientBegin => Surface;
            public override Color ImageMarginGradientMiddle => Surface;
            public override Color ImageMarginGradientEnd => Surface;
            public override Color MenuItemSelected => Highlight;
            public override Color MenuItemSelectedGradientBegin => Highlight;
            public override Color MenuItemSelectedGradientEnd => Highlight;
            public override Color MenuItemBorder => Line;
            public override Color MenuBorder => Line;
            public override Color SeparatorDark => Line;
            public override Color SeparatorLight => Line;
        }
    }
}
