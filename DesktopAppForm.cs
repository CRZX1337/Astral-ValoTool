using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Astral.Models;
using Astral.Services;

namespace Astral;

public sealed class DesktopAppForm : Form
{
    private const string IconResourceName = "Astral.app.ico";

    /// <summary>NotifyIcon.Text is capped by the shell; longer values throw.</summary>
    private const int MaxTrayTextLength = 63;

    private static readonly string BrowserDataFolder = ResolveBrowserDataFolder();

    private readonly string _url;
    private readonly InstalockerService _service;
    private readonly UpdateService _updater;
    private readonly Icon? _appIcon = LoadAppIcon();
    private readonly NotifyIcon _tray;

    /// <summary>
    /// Only in the menu while the loop is actually running -- offering "Stop"
    /// when nothing was ever started is an action that cannot do anything.
    /// </summary>
    private readonly ToolStripMenuItem _stopItem = new("Stop locking") { Available = false };
    private readonly WebView2 _webView = new()
    {
        Dock = DockStyle.Fill,

        // Must be assigned before initialization begins.
        CreationProperties = new CoreWebView2CreationProperties
        {
            UserDataFolder = BrowserDataFolder
        }
    };

    private bool _exitRequested;
    private bool _announcedTray;

    public DesktopAppForm(string url, InstalockerService service, UpdateService updater)
    {
        _url = url;
        _service = service;
        _updater = updater;
        Text = "Astral";

        if (_appIcon is not null)
        {
            Icon = _appIcon;
        }

        StartPosition = FormStartPosition.CenterScreen;

        // Sized in ApplyFrameSizing once the handle exists and the monitor's DPI
        // is known. ClientSize cannot do it here: it runs through
        // AdjustWindowRectEx using CreateParams.Style, and that style still
        // carries WS_CAPTION, so it would reserve a caption's height that
        // WM_NCCALCSIZE then hands straight back to the page.

        // The caption is drawn by the page instead -- .topbar in wwwroot carries
        // app-region: drag, and WebView2 turns that into a real title bar.
        //
        // Borderless, but not styleless: CreateParams keeps the frame styles, so
        // Windows still owns resizing, Aero Snap and the window animations. Only
        // the caption's pixels are taken away (WM_NCCALCSIZE); the sizing strips
        // stay non-client, which is why the edges are still grabbable without any
        // hit-testing here. See the "Window frame" block below.
        FormBorderStyle = FormBorderStyle.None;
        MaximizeBox = true;
        MinimizeBox = true;
        BackColor = Color.FromArgb(11, 11, 15);

        _tray = CreateTray();
        ApplyTrayState(_service.GetState());
        _service.StateChanged += OnServiceStateChanged;
        _updater.RestartRequested += OnRestartRequested;

        Controls.Add(_webView);
        Shown += async (_, _) =>
        {
            await InitializeWebViewAsync();
        };
    }

    /* ------------------------------------------------------------------ *
     * Window frame
     *
     * The window has no caption and no border of its own -- wwwroot draws the
     * title bar. What is deliberately *not* reimplemented is everything DWM
     * already does, so the frame styles stay on the window (CreateParams) and
     * only their pixels are taken away (WM_NCCALCSIZE). That keeps Aero Snap,
     * Snap Layouts on the maximise button, the minimise/restore animations and
     * the drop shadow.
     *
     * WS_THICKFRAME also comes with three transparent strips beside the left,
     * right and bottom edges -- eight pixels at 100%, drawn and hit-tested by
     * DWM, and lying *outside* the visible window. That is what a normal window
     * is grabbed by. Handing the whole frame to the client area, which is what
     * returning 0 from WM_NCCALCSIZE does, pulls those three strips inside the
     * window and makes them visible: they showed up as a black band around the
     * page, because painting them is suddenly our job and BackColor is all there
     * is. So only the caption is taken (WM_NCCALCSIZE below), the sizing strips
     * are left where DWM put them, and resizing, the resize cursors and Aero
     * Snap keep working without a line of hit-testing here.
     *
     * The top edge is the exception: it has no invisible strip, so its grab zone
     * would have to come out of the visible window. It is synthesised from the
     * page instead -- the WebView2 child window would eat the mouse message long
     * before this form saw it -- via `window:resize:top` in OnWebMessage.
     * ------------------------------------------------------------------ */

    private const int WM_NCCALCSIZE = 0x0083;
    private const int WM_NCLBUTTONDOWN = 0x00A1;

    private const int WS_CAPTION = 0x00C00000;
    private const int WS_THICKFRAME = 0x00040000;
    private const int WS_SYSMENU = 0x00080000;
    private const int WS_MINIMIZEBOX = 0x00020000;
    private const int WS_MAXIMIZEBOX = 0x00010000;

    /// <summary>
    /// HTTOP, for the synthesised top resize edge. Passing this to
    /// WM_NCLBUTTONDOWN starts the system's own resize loop, so the drag itself,
    /// the cursor and the snap behaviour are all still the shell's.
    /// </summary>
    private const int HTTOP = 12;

    /// <summary>DWMWA_WINDOW_CORNER_PREFERENCE, and DWMWCP_ROUND for it.</summary>
    private const int DwmWindowCornerPreference = 33;
    private const int DwmCornerRound = 2;

    /// <summary>DWMWA_BORDER_COLOR, and the DWMWA_COLOR_NONE sentinel for it.</summary>
    private const int DwmBorderColor = 34;
    private const uint DwmColorNone = 0xFFFFFFFE;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

    /// <summary>
    /// Asked rather than read off WindowState: this is needed inside
    /// WM_NCCALCSIZE, which arrives mid-flight during the maximise, and
    /// Form.WindowState is a cached field that WinForms only refreshes once
    /// WM_WINDOWPOSCHANGED comes back. The style bit is already correct by then.
    /// </summary>
    [DllImport("user32.dll")]
    private static extern bool IsZoomed(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam);

    /// <summary>
    /// SM_CXSIZEFRAME / SM_CYSIZEFRAME plus SM_CXPADDEDBORDER is the width of one
    /// sizing strip. Needed because the strips are part of the window but not of
    /// the page, so the window has to be that much bigger than the size the
    /// layout was drawn for.
    /// </summary>
    private const int SmCxSizeFrame = 32;
    private const int SmCySizeFrame = 33;
    private const int SmCxPaddedBorder = 92;

    /// <summary>
    /// SM_CYCAPTION. Read per-DPI rather than from SystemInformation, which
    /// answers for the primary monitor's scale even when this window is on
    /// another one.
    /// </summary>
    private const int SmCyCaption = 4;

    [DllImport("user32.dll")]
    private static extern int GetSystemMetricsForDpi(int index, uint dpi);

    /// <summary>First member of NCCALCSIZE_PARAMS: rgrc[0].</summary>
    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    /// <summary>
    /// FormBorderStyle.None strips the window down to WS_POPUP, and with it every
    /// window-management behaviour the shell hangs off these style bits. Putting
    /// them back costs nothing visually once WM_NCCALCSIZE zeroes the frame.
    ///
    /// WS_CAPTION is the one that is easy to get wrong. It looks redundant on a
    /// window that draws no caption, but DWM keys the minimise, restore and
    /// maximise animations off it -- without the bit the window simply appears
    /// and disappears. WS_THICKFRAME carries resizing and Aero Snap, WS_SYSMENU
    /// the system menu and the taskbar's minimise-on-click, and the two box
    /// styles decide whether Snap Layouts offers anything at all.
    /// </summary>
    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams cp = base.CreateParams;
            cp.Style |= WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX;
            return cp;
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);

        // Windows 11 rounds a framed window on its own, but not one whose
        // non-client area has been removed. Older shells fail the call, which is
        // why the HRESULT is dropped rather than checked.
        int preference = DwmCornerRound;
        _ = DwmSetWindowAttribute(Handle, DwmWindowCornerPreference, ref preference, sizeof(int));

        // The pale hairline DWM draws around every WS_THICKFRAME window. It is
        // the visible remains of a frame whose pixels WM_NCCALCSIZE already gave
        // to the client area, so it lands *on top of* the page -- brightest while
        // the window has focus, which is why it reads as an alt-tab artefact.
        // DWMWA_COLOR_NONE removes it outright (Windows 11 22000+; older shells
        // fail the call and keep the line).
        int border = unchecked((int)DwmColorNone);
        _ = DwmSetWindowAttribute(Handle, DwmBorderColor, ref border, sizeof(int));

        ApplyFrameSizing();
        DpiChanged += (_, _) => ApplyFrameSizing();
    }

    /// <summary>
    /// The page is laid out for 1000x550, and the sizing strips are window pixels
    /// the page never sees, so the window is asked for that much more. Only the
    /// left, right and bottom strips exist -- the top edge of the window is the
    /// top edge of the page.
    /// </summary>
    private void ApplyFrameSizing()
    {
        uint dpi = (uint)DeviceDpi;
        int padded = GetSystemMetricsForDpi(SmCxPaddedBorder, dpi);
        int stripX = GetSystemMetricsForDpi(SmCxSizeFrame, dpi) + padded;
        int stripY = GetSystemMetricsForDpi(SmCySizeFrame, dpi) + padded;

        Size wanted = new(
            LogicalToDeviceUnits(1000) + stripX * 2,
            LogicalToDeviceUnits(550) + stripY);

        // Order matters: a MinimumSize larger than the current Size resizes the
        // window on the spot, and setting Size first would then be undone.
        MinimumSize = wanted;

        if (WindowState == FormWindowState.Normal)
        {
            Size = wanted;
        }
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        PostWindowState();
    }

    protected override void OnActivated(EventArgs e)
    {
        base.OnActivated(e);
        PostFocusState(true);
    }

    protected override void OnDeactivate(EventArgs e)
    {
        base.OnDeactivate(e);
        PostFocusState(false);
    }

    protected override void WndProc(ref Message m)
    {
        switch (m.Msg)
        {
            case WM_NCCALCSIZE when m.WParam != IntPtr.Zero:
            {
                // Let the shell propose its frame first, then take only the top
                // edge of it. That single line is the caption; the left, right and
                // bottom sides it leaves alone are the transparent sizing strips
                // DWM owns, and they have to stay non-client or they become
                // visible page area -- which is exactly the black band that
                // returning 0 here produced.
                base.WndProc(ref m);

                NativeRect frame = Marshal.PtrToStructure<NativeRect>(m.LParam);
                uint dpi = (uint)DeviceDpi;

                // The caption goes in both states -- the page draws its own.
                frame.Top -= GetSystemMetricsForDpi(SmCyCaption, dpi);

                // The sizing strip along the top only goes when the window is
                // restored, where the top edge of the page should be the top edge of
                // the window. Maximised, the shell has already inset every side by
                // one strip so that the client area lands exactly on the work area;
                // taking that inset away as well would push the page an edge's worth
                // off every side of the screen.
                if (!IsZoomed(Handle))
                {
                    frame.Top -= GetSystemMetricsForDpi(SmCySizeFrame, dpi)
                        + GetSystemMetricsForDpi(SmCxPaddedBorder, dpi);
                }

                Marshal.StructureToPtr(frame, m.LParam, false);
                return;
            }

            // WM_NCHITTEST is not handled. Every edge except the top is a real
            // non-client sizing strip again, so DefWindowProc answers correctly on
            // its own -- including the corners, and including the part of the grab
            // zone that lies outside the visible window.
            //
            // The top edge is the page's job: see WM_NCLBUTTONDOWN below.

            case WM_NCLBUTTONDOWN when m.WParam == new IntPtr(HTTOP):
            {
                // Posted from the page (`window:resize:top`) rather than arriving
                // from the shell: there is no non-client strip along the top for a
                // real WM_NCHITTEST to land in, and the WebView2 child window would
                // swallow the press long before this form saw it. Handing HTTOP to
                // DefWindowProc from here starts the shell's own resize loop, so the
                // drag, the cursor and the snap-to-edge behaviour are unchanged.
                break;
            }
        }

        base.WndProc(ref m);
    }

    /// <summary>
    /// Starts the shell's resize loop on the top edge, which is the one edge with
    /// no non-client strip of its own. ReleaseCapture first: the page has already
    /// captured the pointer for the press, and the loop cannot take over while
    /// something else holds capture.
    /// </summary>
    private void BeginTopResize()
    {
        if (WindowState != FormWindowState.Normal)
        {
            return;
        }

        _ = ReleaseCapture();
        _ = SendMessage(Handle, WM_NCLBUTTONDOWN, new IntPtr(HTTOP), IntPtr.Zero);
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
            _updater.RestartRequested -= OnRestartRequested;

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

        _stopItem.Click += (_, _) => _service.Stop("Stopped from the tray.");

        menu.Items.Add("Open", null, (_, _) => RestoreWindow());
        menu.Items.Add(_stopItem);
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

        BeginInvoke(() => ApplyTrayState(state));
    }

    /// <summary>
    /// The updater has already swapped the binary and launched the replacement,
    /// so this window has to go -- including out of the tray, which normally
    /// survives a close. Two copies of Astral fighting over the same client is
    /// exactly what the restart is meant to avoid.
    /// </summary>
    private void OnRestartRequested()
    {
        if (IsDisposed || !IsHandleCreated)
        {
            return;
        }

        BeginInvoke(ExitApplication);
    }

    private void ApplyTrayState(LockState state)
    {
        _stopItem.Available = state.IsRunning;

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

    /// <summary>
    /// Where the embedded browser keeps its profile. Left unset, WebView2 puts
    /// "{executable}.WebView2" next to the binary -- clutter beside a portable
    /// build, and an outright startup failure when that directory is not
    /// writable, such as a copy under Program Files.
    ///
    /// Deliberately local rather than roaming: a browser cache must not
    /// synchronise with a domain profile the way the small settings file may.
    /// </summary>
    private static string ResolveBrowserDataFolder()
    {
        string root = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);

        if (string.IsNullOrWhiteSpace(root))
        {
            root = Path.GetTempPath();
        }

        return Path.Combine(root, "Astral", "WebView2");
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            // Inside the try on purpose: an unwritable profile location should
            // land on the error screen, not abort construction of the window.
            Directory.CreateDirectory(BrowserDataFolder);

            await _webView.EnsureCoreWebView2Async();
            HardenBrowser(_webView.CoreWebView2.Settings);
            _webView.CoreWebView2.WebMessageReceived += OnWebMessage;

            // The page mounts after this navigation, so its first read of the
            // maximise glyph comes from the handshake in OnNavigationCompleted
            // rather than from here.
            _webView.CoreWebView2.NavigationCompleted += (_, _) => PostWindowState();
            _webView.Source = new Uri(_url);
        }
        catch (Exception ex)
        {
            _webView.Visible = false;
            ShowInitializationError(ex);
        }
    }

    /// <summary>
    /// Turns WebView2 from a browser back into an application shell.
    ///
    /// Left alone it brings its whole chrome along: right-click opens Back /
    /// Reload / Save as / Print / Inspect, and F5, Ctrl+R, Ctrl+P and F12 all
    /// work. None of that means anything in a window with no address bar, and
    /// Reload in particular just drops whatever the user was doing.
    ///
    /// Text selection is handled in CSS rather than here -- it has to stay
    /// available inside the input fields.
    /// </summary>
    private static void HardenBrowser(CoreWebView2Settings settings)
    {
        settings.AreDefaultContextMenusEnabled = false;
        settings.AreBrowserAcceleratorKeysEnabled = false;
        settings.AreDevToolsEnabled = false;
        settings.IsZoomControlEnabled = false;
        settings.IsStatusBarEnabled = false;

        // Lets the page act as the title bar through `app-region: drag`. Windows
        // then handles the parts a script cannot do well: dragging without lag,
        // double-click to maximise, the system menu on right-click, and Snap
        // Layouts when the pointer rests on the maximise button.
        //
        // Only applies from the next navigation, so this has to stay ahead of the
        // Source assignment in InitializeWebViewAsync.
        settings.IsNonClientRegionSupportEnabled = true;
    }

    /// <summary>
    /// The three caption buttons. Deliberately thin: the page says what was
    /// pressed and this decides what it means, so Close still goes through
    /// OnFormClosing and parks in the tray rather than exiting.
    /// </summary>
    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string message;

        try
        {
            message = e.TryGetWebMessageAsString();
        }
        catch (ArgumentException)
        {
            // Not a string payload -- not ours.
            return;
        }

        switch (message)
        {
            case "window:minimize":
                WindowState = FormWindowState.Minimized;
                break;

            case "window:maximize":
                WindowState = WindowState == FormWindowState.Maximized
                    ? FormWindowState.Normal
                    : FormWindowState.Maximized;
                break;

            case "window:close":
                Close();
                break;

            case "window:resize:top":
                BeginTopResize();
                break;
        }
    }

    /// <summary>
    /// Keeps the maximise button's glyph honest. Sent on every resize because
    /// the state also changes by way of Aero Snap, a double-click on the drag
    /// region and the system menu -- none of which come through OnWebMessage.
    /// </summary>
    private void PostWindowState()
    {
        if (_webView.CoreWebView2 is null)
        {
            return;
        }

        _webView.CoreWebView2.PostWebMessageAsString(
            WindowState == FormWindowState.Maximized
                ? "window:state:maximized"
                : "window:state:normal");
    }

    /// <summary>
    /// Drives the idle flag in js/ui/perf.js, which parks every endless
    /// decoration while nobody is looking at the window.
    ///
    /// The page listens for its own focus/blur as well, but those cannot be
    /// relied on here: a full-screen game taking the foreground deactivates this
    /// form without necessarily reaching the WebView2's document, and that is
    /// exactly the case the idle pause exists for. This form always hears about
    /// it, so it says so directly. Both paths set the same flag and agree, so
    /// whichever arrives is fine.
    /// </summary>
    private void PostFocusState(bool active)
    {
        if (_webView.CoreWebView2 is null)
        {
            return;
        }

        _webView.CoreWebView2.PostWebMessageAsString(
            active ? "window:focus:active" : "window:focus:idle");
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
