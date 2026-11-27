using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using WF = System.Windows.Forms;
using SD = System.Drawing;

[assembly: AssemblyTitle("88FRP Windows")]
[assembly: AssemblyProduct("88FRP Windows")]
[assembly: AssemblyDescription("88FRP Windows 隧道控制台")]
[assembly: AssemblyCompany("88FRP Windows")]
[assembly: AssemblyVersion("3.7.1.0")]
[assembly: AssemblyFileVersion("3.7.1.0")]

internal static class Program
{
    internal const string AppName = "88FRP";
    internal const string AppVersion = "3.7.1";
    internal const string Host = "127.0.0.1";
    internal const int DefaultConsolePort = 8801;
    internal static int ConsolePort = DefaultConsolePort;
    internal static string BaseUrl { get { return "http://" + Host + ":" + ConsolePort; } }
    internal static readonly string AppDataDir = ResolveAppDataDir();
    private static string ResolveAppDataDir()
    {
        string settings = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "machine-config.json");
        if (File.Exists(settings))
        {
            var config = NativeClient.AsDict(new JavaScriptSerializer().DeserializeObject(File.ReadAllText(settings, Encoding.UTF8)));
            string root = NativeClient.GetString(config, "dataRoot");
            if (!Path.IsPathRooted(root)) throw new InvalidOperationException("后台数据目录无效，请重新安装 88FRP。");
            return root;
        }
        return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "88frp-node");
    }
    internal static readonly string FirstRunPath = Path.Combine(AppDataDir, "native-client-first-run.flag");
    internal static readonly string UpdateStatePath = Path.Combine(AppDataDir, "native-client-update-state.json");
    internal static readonly string ServicePortsPath = Path.Combine(AppDataDir, "native-client-service-ports.json");

    [STAThread]
    private static void Main(string[] args)
    {
        if (HasArg(args, "--backend-host"))
        {
            Directory.CreateDirectory(AppDataDir);
            LoadConsolePort();
            NativeClient.RunBackendHost();
            return;
        }
        DpiSupport.Enable();
        bool backgroundStart = HasArg(args, "--background");
        if (HasArg(args, "--uninstall"))
        {
            NativeClient.RunUninstall();
            return;
        }
        bool createdNew;
        Mutex mutex = new Mutex(true, "Global\\88FRP_Native_Client_Mutex", out createdNew);
        if (!createdNew)
        {
            if (!backgroundStart) NativeClient.SignalExistingInstance();
            return;
        }

        Directory.CreateDirectory(AppDataDir);
        LoadConsolePort();
        App app = new App();
        app.Run(new MainWindow(backgroundStart));
        GC.KeepAlive(mutex);
    }

    private static bool HasArg(string[] args, string expected)
    {
        foreach (string arg in args)
        {
            if (string.Equals(arg, expected, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    internal static void SaveConsolePort(int port)
    {
        if (port < 1 || port > 65535) throw new ArgumentOutOfRangeException("port");
        ConsolePort = port;
        Dictionary<string, object> state = new Dictionary<string, object>();
        state["consolePort"] = port;
        File.WriteAllText(ServicePortsPath, new JavaScriptSerializer().Serialize(state), Encoding.UTF8);
    }

    internal static void LoadConsolePort()
    {
        try
        {
            if (!File.Exists(ServicePortsPath)) return;
            Dictionary<string, object> state = NativeClient.AsDict(new JavaScriptSerializer().DeserializeObject(File.ReadAllText(ServicePortsPath, Encoding.UTF8)));
            int port = NativeClient.GetInt(state, "consolePort");
            if (port >= 1 && port <= 65535) ConsolePort = port;
        }
        catch { ConsolePort = DefaultConsolePort; }
    }
}

internal sealed class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += delegate(object sender, DispatcherUnhandledExceptionEventArgs args)
        {
            MessageBox.Show(args.Exception.Message, Program.AppName, MessageBoxButton.OK, MessageBoxImage.Warning);
            args.Handled = true;
        };
        AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs args)
        {
            Exception ex = args.ExceptionObject as Exception;
            MessageBox.Show(ex == null ? "程序发生未知错误。" : ex.Message, Program.AppName, MessageBoxButton.OK, MessageBoxImage.Warning);
        };
    }
}

internal sealed partial class MainWindow : Window
{
    private readonly NativeClient client = new NativeClient();
    private readonly bool backgroundStart;
    private readonly ListBox instanceList = new ListBox();
    private readonly TextBlock statusValue = new TextBlock();
    private readonly TextBlock pidValue = new TextBlock();
    private readonly TextBlock backendValue = new TextBlock();
    private readonly TextBox secretBox = new TextBox();
    private readonly CheckBox autoSyncBox = new CheckBox();
    private readonly TextBox configBox = new TextBox();
    private readonly StackPanel tunnelPanel = new StackPanel();
    private readonly TextBlock tunnelSelectionSummary = new TextBlock();
    private readonly TextBox logsBox = new TextBox();
    private readonly DispatcherTimer pollTimer = new DispatcherTimer();
    private readonly DispatcherTimer watchdogTimer = new DispatcherTimer();
    private readonly DispatcherTimer updateTimer = new DispatcherTimer();
    private readonly DispatcherTimer gatewayTimer = new DispatcherTimer();
    private readonly List<Dictionary<string, object>> tunnels = new List<Dictionary<string, object>>();
    private readonly Dictionary<string, CheckBox> tunnelChecks = new Dictionary<string, CheckBox>();
    private readonly Dictionary<string, TextBox> tunnelGroupInputs = new Dictionary<string, TextBox>();
    private readonly HashSet<string> collapsedTunnelGroups = new HashSet<string>(StringComparer.Ordinal);
    private readonly WF.NotifyIcon trayIcon = new WF.NotifyIcon();
    private string currentInstanceId = "";
    private bool refreshingInstanceList;
    private bool exiting;
    private Button autoStartButton;
    private Button syncButton;
    private Button frpAccountButton;
    private Button consoleSecurityButton;
    private Button managementHubButton;
    private Button gatewayHubButton;
    private Button checkUpdateButton;
    private Button openUpdateButton;
    private Border managementOverlay;
    private TextBlock frpAccountStatus = new TextBlock();
    private TextBlock updateStatus = new TextBlock();
    private TextBlock gatewayDomainStatus = new TextBlock();
    private TextBlock gatewayIpv6Status = new TextBlock();
    private TextBlock gatewayCaddyStatus = new TextBlock();
    private TextBlock gatewayFrpcStatus = new TextBlock();
    private int watchdogFailureCount;
    private int watchdogCheckRunning;
    private bool longOperationRunning;
    private int updateCheckRunning;
    private string lastNotifiedUpdateVersion = "";
    private string availableUpdateUrl = "";
    private static readonly string CollapsedTunnelGroupsPath = Path.Combine(Program.AppDataDir, "native-client-collapsed-tunnel-groups.json");

    private static readonly ClientThemePalette ClientTheme = new ClientThemePalette();
    private static readonly Brush SidebarBrush = ClientTheme.Brush("Card");
    private static readonly Brush AppBrush = ClientTheme.Brush("App");
    private static readonly Brush CardBrush = ClientTheme.Brush("Card");
    private static readonly Brush TextBrush = ClientTheme.Brush("Text");
    private static readonly Brush MutedBrush = ClientTheme.Brush("Muted");
    private static readonly Brush AccentBrush = ClientTheme.Brush("Accent");
    private static readonly Brush AccentTextBrush = ClientTheme.Brush("AccentText");
    private static readonly Brush SurfaceBrush = ClientTheme.Brush("Surface");
    private static readonly Brush AccentGreenBrush = ClientTheme.Brush("Success");
    private static readonly Brush DangerBrush = ClientTheme.Brush("Danger");
    private static readonly Brush UiBorderBrush = ClientTheme.Brush("Border");

    public MainWindow(bool backgroundStart)
    {
        this.backgroundStart = backgroundStart;
        ApplyClientTheme(ReadDarkTheme());
        Title = "88FRP v3.7.1";
        Width = Math.Min(1180, Math.Max(480, SystemParameters.WorkArea.Width - 24));
        Height = Math.Min(780, Math.Max(560, SystemParameters.WorkArea.Height - 24));
        MinWidth = 480;
        MinHeight = 600;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = AppBrush;
        FontFamily = ClientUiStyles.Font;
        Foreground = TextBrush;
        FontSize = 13;
        UseLayoutRounding = true;
        SnapsToDevicePixels = true;
        Icon = NativeClient.LoadIconImage();
        TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
        TextOptions.SetTextRenderingMode(this, TextRenderingMode.ClearType);
        LoadCollapsedTunnelGroups();
        LoadUpdateState();

        Content = BuildRoot();
        LoadGatewayOverviewCache();
        BuildTray();

        Loaded += async delegate
        {
            NativeClient.RegisterWindow(this);
            try
            {
                await Task.Run(delegate
                {
                    client.StartBackend();
                    client.WaitForBackend();
                });
            }
            catch
            {
                if (backendValue != null) backendValue.Text = "离线";
            }
            RefreshAll();
            // Startup preferences must never prevent existing instances/settings
            // from loading or stop recovery polling after an optional setup error.
            pollTimer.Start();
            watchdogTimer.Start();
            updateTimer.Start();
            gatewayTimer.Start();
            if (backgroundStart) HideToTray();
            Safe(RunFirstLaunchGuide);
            await CheckForUpdatesAsync(false);
        };
        Closing += OnClosing;

        pollTimer.Interval = TimeSpan.FromSeconds(4);
        pollTimer.Tick += delegate
        {
            if (gatewayInitialLoadPending) return;
            bool gatewayMode = NativeClient.GetBool(gatewayOverviewState, "initialized");
            bool legacyVisible = legacyWorkspaceRoot != null && legacyWorkspaceRoot.Visibility == Visibility.Visible;
            if (gatewayMode && !legacyVisible) return;
            SafeSilent(delegate { RefreshInstances(true); });
        };
        watchdogTimer.Interval = TimeSpan.FromSeconds(10);
        watchdogTimer.Tick += delegate { CheckBackendWatchdog(); };
        updateTimer.Interval = TimeSpan.FromHours(6);
        updateTimer.Tick += async delegate { await CheckForUpdatesAsync(false); };
        gatewayTimer.Interval = TimeSpan.FromSeconds(15);
        gatewayTimer.Tick += delegate { SafeSilent(RefreshGatewayStatus); };
    }

    private UIElement BuildRoot()
    {
        return BuildUnifiedShell();
    }

    private UIElement BuildHeader()
    {
        Grid header = new Grid { Margin = new Thickness(0, 0, 0, 20) };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        StackPanel title = new StackPanel();
        title.Children.Add(new TextBlock { Text = "历史实例", Foreground = TextBrush, FontSize = 26, FontWeight = FontWeights.SemiBold });
        title.Children.Add(new TextBlock { Text = "只读查看旧版隧道和历史配置；日常请从服务入口访问。", Foreground = MutedBrush, FontSize = 13, Margin = new Thickness(0, 6, 0, 0) });
        header.Children.Add(title);

        StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top };
        Grid.SetColumn(actions, 1);
        header.Children.Add(actions);
        Button openGateway = PrimaryButton("返回服务入口", AccentGreenBrush);
        openGateway.Margin = new Thickness(0, 0, 8, 0);
        openGateway.ToolTip = "返回桌面端的单设备服务导航页";
        openGateway.Click += delegate { ShowGatewayWorkspace("portal"); };
        actions.Children.Add(openGateway);
        Button start = PrimaryButton("启动", AccentBrush);
        Button stop = OutlineButton("停止", DangerBrush);
        Button restart = OutlineButton("重启", TextBrush);
        start.Click += delegate { Safe(delegate { RuntimeAction("start"); }); };
        stop.Click += delegate { Safe(delegate { RuntimeAction("stop"); }); };
        restart.Click += delegate { Safe(delegate { RuntimeAction("restart"); }); };
        actions.Children.Add(start);
        actions.Children.Add(stop);
        actions.Children.Add(restart);
        return header;
    }

    private UIElement BuildGatewayStatusBar()
    {
        Border card = Card();
        card.Margin = new Thickness(0, 0, 0, 16);
        card.Padding = new Thickness(18, 12, 18, 12);
        Grid grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        AddGatewayStatusCell(grid, 0, "设备域名", gatewayDomainStatus, "未初始化");
        AddGatewayStatusCell(grid, 1, "公网 IPv6", gatewayIpv6Status, "检测中");
        AddGatewayStatusCell(grid, 2, "网页访问", gatewayCaddyStatus, "未启动");
        AddGatewayStatusCell(grid, 3, "备用通道", gatewayFrpcStatus, "未启动");
        card.Child = grid;
        return card;
    }

    private void AddGatewayStatusCell(Grid grid, int column, string title, TextBlock value, string initial)
    {
        value.Text = initial;
        value.Foreground = TextBrush;
        value.FontSize = 13;
        value.FontWeight = FontWeights.SemiBold;
        value.TextTrimming = TextTrimming.CharacterEllipsis;
        value.Margin = new Thickness(0, 4, 16, 0);
        value.Cursor = Cursors.Hand;
        value.MouseLeftButtonUp += delegate { Safe(delegate { ShowGatewayWorkspace("portal"); }); };
        StackPanel panel = new StackPanel { Margin = new Thickness(column == 0 ? 0 : 14, 0, 0, 0) };
        panel.Children.Add(new TextBlock { Text = title, Foreground = MutedBrush, FontSize = 11 });
        panel.Children.Add(value);
        Grid.SetColumn(panel, column);
        grid.Children.Add(panel);
    }

    private UIElement BuildStatusCards()
    {
        Grid grid = new Grid { Margin = new Thickness(0, 0, 0, 16) };
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        grid.ColumnDefinitions.Add(new ColumnDefinition());
        statusValue.Text = "-";
        pidValue.Text = "-";
        backendValue.Text = "检查中";
        AddStatusCard(grid, 0, "实例状态", statusValue, AccentGreenBrush);
        AddStatusCard(grid, 1, "进程编号", pidValue, AccentBrush);
        AddStatusCard(grid, 2, "后台核心", backendValue, AccentGreenBrush);
        return grid;
    }

    private void AddStatusCard(Grid grid, int column, string title, TextBlock value, Brush dot)
    {
        Border card = Card();
        card.Margin = new Thickness(column == 0 ? 0 : 8, 0, column == 2 ? 0 : 8, 0);
        StackPanel panel = new StackPanel { Margin = new Thickness(18, 14, 18, 14) };
        card.Child = panel;
        StackPanel row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(new Border { Background = dot, Width = 10, Height = 10, CornerRadius = new CornerRadius(2), Margin = new Thickness(0, 5, 8, 0) });
        row.Children.Add(new TextBlock { Text = title, Foreground = MutedBrush, FontSize = 12 });
        panel.Children.Add(row);
        value.Foreground = TextBrush;
        value.FontSize = 22;
        value.FontWeight = FontWeights.SemiBold;
        value.Margin = new Thickness(0, 8, 0, 0);
        value.TextTrimming = TextTrimming.CharacterEllipsis;
        panel.Children.Add(value);
        Grid.SetColumn(card, column);
        grid.Children.Add(card);
    }

    private UIElement BuildSettingsBar()
    {
        Border card = Card();
        card.Margin = new Thickness(0, 0, 0, 16);
        card.Padding = new Thickness(18, 10, 18, 10);
        StackPanel heading = new StackPanel { Orientation = Orientation.Horizontal };
        heading.Children.Add(new TextBlock { Text = "配置同步", Foreground = TextBrush, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
        heading.Children.Add(new TextBlock { Text = "密钥与自动同步", Foreground = MutedBrush, FontSize = 12, Margin = new Thickness(12, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center });
        Grid panel = new Grid();
        panel.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        panel.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        panel.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        secretBox.Height = 36;
        secretBox.FontSize = 13;
        secretBox.VerticalContentAlignment = VerticalAlignment.Center;
        secretBox.ToolTip = "88FRP 同步密钥";
        panel.Children.Add(secretBox);
        autoSyncBox.Content = "自动同步";
        autoSyncBox.Margin = new Thickness(18, 0, 18, 0);
        autoSyncBox.VerticalAlignment = VerticalAlignment.Center;
        Grid.SetColumn(autoSyncBox, 1);
        panel.Children.Add(autoSyncBox);
        syncButton = PrimaryButton("同步配置", AccentBrush);
        syncButton.Click += async delegate { await SyncCurrentAsync(); };
        Grid.SetColumn(syncButton, 2);
        panel.Children.Add(syncButton);
        card.Child = new Expander { Header = heading, Content = panel, IsExpanded = false };
        return card;
    }

    private UIElement BuildManagementOverlay()
    {
        managementOverlay = new Border { Visibility = Visibility.Collapsed };
        Grid.SetColumn(managementOverlay, 1);
        Grid layer = new Grid();
        managementOverlay.Child = layer;

        Border scrim = new Border { Background = new SolidColorBrush(Color.FromArgb(82, 15, 23, 42)) };
        scrim.MouseDown += delegate { CloseManagementDrawer(); };
        layer.Children.Add(scrim);

        Border drawer = new Border
        {
            Width = 420,
            Background = CardBrush,
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(1, 0, 0, 0),
            HorizontalAlignment = HorizontalAlignment.Right,
            VerticalAlignment = VerticalAlignment.Stretch,
            Padding = new Thickness(24, 26, 24, 24)
        };
        layer.Children.Add(drawer);
        DockPanel dock = new DockPanel { LastChildFill = true };
        drawer.Child = dock;

        Grid header = new Grid { Margin = new Thickness(0, 0, 0, 22) };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        StackPanel heading = new StackPanel();
        heading.Children.Add(new TextBlock { Text = "账户与偏好", Foreground = TextBrush, FontSize = 22, FontWeight = FontWeights.SemiBold });
        heading.Children.Add(new TextBlock { Text = "外观、账号、安全与版本信息", Foreground = MutedBrush, Margin = new Thickness(0, 4, 0, 0) });
        header.Children.Add(heading);
        Button close = OutlineButton("关闭", AccentTextBrush);
        close.MinWidth = 68;
        close.Margin = new Thickness(12, 0, 0, 0);
        close.Click += delegate { CloseManagementDrawer(); };
        Grid.SetColumn(close, 1);
        header.Children.Add(close);
        DockPanel.SetDock(header, Dock.Top);
        dock.Children.Add(header);

        ScrollViewer scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        DockPanel.SetDock(scroll, Dock.Top);
        dock.Children.Add(scroll);
        StackPanel content = new StackPanel();
        scroll.Content = content;

        content.Children.Add(DrawerSectionLabel("外观"));
        Button themeButton = DrawerActionButton("切换明亮 / 深色模式");
        themeButton.Click += delegate {
            bool dark = !ClientTheme.IsDark;
            ApplyClientTheme(dark);
            File.WriteAllText(Path.Combine(Program.AppDataDir, "native-client-theme.txt"), dark ? "dark" : "light");
        };
        content.Children.Add(themeButton);
        content.Children.Add(DrawerSectionLabel("88FRP 账号"));
        frpAccountButton = DrawerActionButton("连接 88FRP 账号");
        frpAccountButton.Click += async delegate { await ManageFrpAccountAsync(); };
        content.Children.Add(frpAccountButton);
        frpAccountStatus.Foreground = MutedBrush;
        frpAccountStatus.FontSize = 12;
        frpAccountStatus.TextWrapping = TextWrapping.Wrap;
        frpAccountStatus.TextTrimming = TextTrimming.None;
        frpAccountStatus.Margin = new Thickness(12, 5, 12, 10);
        content.Children.Add(frpAccountStatus);
        content.Children.Add(DrawerSectionLabel("后台运行"));
        autoStartButton = DrawerActionButton(NativeClient.IsAutoStartEnabled() ? "开机自启：已开启" : "开机自启：未开启");
        autoStartButton.Click += delegate { Safe(ToggleAutoStart); };
        content.Children.Add(autoStartButton);
        content.Children.Add(new TextBlock { Text = "开机后后台自动运行，无需登录 Windows。\n登录后启动桌面界面，关闭窗口仍在托盘运行。", Foreground = MutedBrush, FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 4, 0, 10), LineHeight = 21 });

        content.Children.Add(DrawerSectionLabel("控制台安全"));
        consoleSecurityButton = DrawerActionButton("设置网页管理登录保护");
        consoleSecurityButton.Click += async delegate { await ManageConsoleSecurityAsync(); };
        content.Children.Add(consoleSecurityButton);
        content.Children.Add(new TextBlock
        {
            Text = "网页控制台使用独立管理员账号；修改设置后可撤销已记住的浏览器。",
            Foreground = MutedBrush,
            FontSize = 12,
            TextWrapping = TextWrapping.Wrap,
            LineHeight = 18,
            Margin = new Thickness(12, 6, 12, 0)
        });

        content.Children.Add(DrawerSectionLabel("关于"));
        StackPanel aboutRow = new StackPanel { Orientation = Orientation.Horizontal };
        checkUpdateButton = DrawerCompactActionButton("检查更新");
        checkUpdateButton.Margin = new Thickness(0, 0, 8, 6);
        checkUpdateButton.Click += async delegate { await CheckForUpdatesAsync(true); };
        openUpdateButton = DrawerCompactActionButton("打开下载页");
        openUpdateButton.Visibility = Visibility.Collapsed;
        openUpdateButton.Click += delegate { OpenAvailableUpdate(); };
        aboutRow.Children.Add(checkUpdateButton);
        aboutRow.Children.Add(openUpdateButton);
        content.Children.Add(aboutRow);
        updateStatus.Text = "88FRP v" + Program.AppVersion + " · Windows";
        updateStatus.Foreground = MutedBrush;
        updateStatus.FontSize = 12;
        updateStatus.TextWrapping = TextWrapping.Wrap;
        updateStatus.Margin = new Thickness(12, 2, 12, 12);
        content.Children.Add(updateStatus);
        return managementOverlay;
    }

    private void ShowManagementDrawer()
    {
        if (managementOverlay == null) return;
        if (unifiedShellRoot != null && !unifiedShellRoot.Children.Contains(managementOverlay))
        {
            Grid.SetColumn(managementOverlay, 1);
            unifiedShellRoot.Children.Add(managementOverlay);
        }
        RefreshFrpAccountStatus();
        managementOverlay.Visibility = Visibility.Visible;
    }

    private void CloseManagementDrawer()
    {
        if (managementOverlay == null) return;
        managementOverlay.Visibility = Visibility.Collapsed;
        if (unifiedShellRoot != null && unifiedShellRoot.Children.Contains(managementOverlay))
            unifiedShellRoot.Children.Remove(managementOverlay);
    }

    private async Task CheckForUpdatesAsync(bool manual)
    {
        if (Interlocked.Exchange(ref updateCheckRunning, 1) != 0) return;
        if (manual && checkUpdateButton != null)
        {
            checkUpdateButton.IsEnabled = false;
            updateStatus.Text = "正在检查 GitHub Release...";
        }
        try
        {
            ReleaseUpdateInfo update = await Task.Run(delegate { return FetchLatestRelease(); });
            if (update == null)
            {
                availableUpdateUrl = "";
                if (openUpdateButton != null) openUpdateButton.Visibility = Visibility.Collapsed;
                updateStatus.Text = "当前已是最新版本 v" + Program.AppVersion + "。";
                return;
            }
            availableUpdateUrl = update.Url;
            updateStatus.Text = "发现新版本 v" + update.Version + "，可打开下载页安装。";
            if (openUpdateButton != null) openUpdateButton.Visibility = Visibility.Visible;
            if (!string.Equals(lastNotifiedUpdateVersion, update.Version, StringComparison.Ordinal))
            {
                lastNotifiedUpdateVersion = update.Version;
                SaveUpdateState();
                trayIcon.ShowBalloonTip(5000, "88FRP 有新版本", "发现 v" + update.Version + "，可在全局设置中打开下载页。", WF.ToolTipIcon.Info);
            }
        }
        catch
        {
            if (manual) updateStatus.Text = "暂时无法检查更新，请稍后再试。";
        }
        finally
        {
            if (checkUpdateButton != null) checkUpdateButton.IsEnabled = true;
            Interlocked.Exchange(ref updateCheckRunning, 0);
        }
    }

    private ReleaseUpdateInfo FetchLatestRelease()
    {
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create("https://api.github.com/repos/2909272751/88FRP-Windows--/releases/latest");
        request.Method = "GET";
        request.Timeout = 8000;
        request.ReadWriteTimeout = 8000;
        request.UserAgent = "88FRP-Windows/" + Program.AppVersion;
        request.Accept = "application/vnd.github+json";
        using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
        using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
        {
            Dictionary<string, object> release = NativeClient.AsDict(new JavaScriptSerializer().DeserializeObject(reader.ReadToEnd()));
            if (NativeClient.GetBool(release, "draft") || NativeClient.GetBool(release, "prerelease")) return null;
            string version = NativeClient.GetString(release, "tag_name").Trim();
            if (version.StartsWith("v", StringComparison.OrdinalIgnoreCase)) version = version.Substring(1);
            Version latest;
            if (!Version.TryParse(version, out latest) || latest.CompareTo(new Version(Program.AppVersion)) <= 0) return null;
            string url = NativeClient.GetString(release, "html_url");
            return string.IsNullOrWhiteSpace(url) ? null : new ReleaseUpdateInfo { Version = version, Url = url };
        }
    }

    private void OpenAvailableUpdate()
    {
        if (string.IsNullOrWhiteSpace(availableUpdateUrl)) return;
        try { Process.Start(new ProcessStartInfo { FileName = availableUpdateUrl, UseShellExecute = true }); } catch { }
    }

    private void LoadUpdateState()
    {
        try
        {
            if (!File.Exists(Program.UpdateStatePath)) return;
            Dictionary<string, object> state = NativeClient.AsDict(new JavaScriptSerializer().DeserializeObject(File.ReadAllText(Program.UpdateStatePath, Encoding.UTF8)));
            lastNotifiedUpdateVersion = NativeClient.GetString(state, "lastNotifiedVersion");
        }
        catch { }
    }

    private void SaveUpdateState()
    {
        try
        {
            Directory.CreateDirectory(Program.AppDataDir);
            Dictionary<string, object> state = new Dictionary<string, object>();
            state["lastNotifiedVersion"] = lastNotifiedUpdateVersion;
            File.WriteAllText(Program.UpdateStatePath, new JavaScriptSerializer().Serialize(state), Encoding.UTF8);
        }
        catch { }
    }

    private UIElement BuildTabs()
    {
        TabControl tabs = new TabControl { FontSize = 13 };
        tabs.Items.Add(BuildTunnelTab());
        tabs.Items.Add(BuildConfigTab());
        tabs.Items.Add(BuildDomainTab());
        tabs.Items.Add(BuildLogsTab());
        domainTabs = tabs;
        tabs.SelectionChanged += delegate(object sender, SelectionChangedEventArgs e) {
            if (e.Source == tabs && tabs.SelectedIndex == 2) Safe(delegate { LoadDomainBinding(); });
        };
        return tabs;
    }

    private TabControl domainTabs;


    private TabItem BuildConfigTab()
    {
        TabItem tab = new TabItem { Header = "配置文件" };
        DockPanel dock = new DockPanel { Background = CardBrush };
        StackPanel footer = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(20, 12, 20, 16) };
        Button save = PrimaryButton("保存配置", AccentBrush);
        save.Click += delegate { Safe(SaveConfig); };
        footer.Children.Add(save);
        DockPanel.SetDock(footer, Dock.Bottom);
        dock.Children.Add(footer);
        TextBlock hint = new TextBlock { Text = "配置文件", Foreground = TextBrush, FontWeight = FontWeights.SemiBold, FontSize = 16, Margin = new Thickness(20, 18, 20, 14) };
        DockPanel.SetDock(hint, Dock.Top); dock.Children.Add(hint);
        configBox.FontFamily = new FontFamily("Consolas, Microsoft YaHei UI");
        configBox.FontSize = 13;
        configBox.AcceptsReturn = true;
        configBox.AcceptsTab = true;
        configBox.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        configBox.HorizontalScrollBarVisibility = ScrollBarVisibility.Auto;
        configBox.TextWrapping = TextWrapping.Wrap;
        configBox.Padding = new Thickness(20, 8, 20, 8);
        configBox.BorderThickness = new Thickness(0);
        dock.Children.Add(configBox);
        tab.Content = dock;
        return tab;
    }

    private TabItem BuildTunnelTab()
    {
        TabItem tab = new TabItem { Header = "隧道" };
        DockPanel dock = new DockPanel { Background = CardBrush };
        TextBlock heading = new TextBlock { Text = "隧道管理", Foreground = TextBrush, FontSize = 16, FontWeight = FontWeights.SemiBold, Margin = new Thickness(20, 18, 20, 4) };
        DockPanel.SetDock(heading, Dock.Top); dock.Children.Add(heading);
        TextBlock hint = new TextBlock
        {
            Text = "选择要运行的隧道，新同步的隧道默认关闭。更改后请保存。",
            Foreground = MutedBrush,
            FontSize = 12,
            Margin = new Thickness(20, 0, 20, 18)
        };
        DockPanel.SetDock(hint, Dock.Top);
        dock.Children.Add(hint);
        DockPanel footer = new DockPanel { LastChildFill = false, Margin = new Thickness(20, 12, 20, 16) };
        Button save = PrimaryButton("保存更改", AccentBrush);
        save.Click += delegate { Safe(SaveTunnels); };
        DockPanel.SetDock(save, Dock.Right); footer.Children.Add(save);
        tunnelSelectionSummary.Foreground = MutedBrush;
        tunnelSelectionSummary.FontSize = 12;
        tunnelSelectionSummary.VerticalAlignment = VerticalAlignment.Center;
        footer.Children.Add(tunnelSelectionSummary);
        DockPanel.SetDock(footer, Dock.Bottom);
        dock.Children.Add(footer);
        ScrollViewer scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        tunnelPanel.Margin = new Thickness(20, 0, 20, 0);
        scroll.Content = tunnelPanel;
        dock.Children.Add(scroll);
        tab.Content = dock;
        return tab;
    }

    private TabItem BuildLogsTab()
    {
        TabItem tab = new TabItem { Header = "运行日志" };
        DockPanel dock = new DockPanel { Background = CardBrush };
        Button refresh = PrimaryButton("刷新日志", AccentBrush);
        refresh.HorizontalAlignment = HorizontalAlignment.Right;
        refresh.Margin = new Thickness(20, 12, 20, 16);
        refresh.Click += delegate { Safe(LoadLogs); };
        DockPanel.SetDock(refresh, Dock.Bottom);
        dock.Children.Add(refresh);
        logsBox.FontFamily = new FontFamily("Consolas, Microsoft YaHei UI");
        logsBox.FontSize = 13;
        logsBox.AcceptsReturn = true;
        logsBox.IsReadOnly = true;
        logsBox.TextWrapping = TextWrapping.Wrap;
        logsBox.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        logsBox.HorizontalScrollBarVisibility = ScrollBarVisibility.Auto;
        logsBox.Background = CardBrush;
        logsBox.Foreground = TextBrush;
        logsBox.BorderThickness = new Thickness(0);
        logsBox.Padding = new Thickness(14);
        dock.Children.Add(logsBox);
        tab.Content = dock;
        return tab;
    }

    private static bool ReadDarkTheme()
    {
        string file = Path.Combine(Program.AppDataDir, "native-client-theme.txt");
        if (File.Exists(file)) return File.ReadAllText(file).Trim() == "dark";
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
            return key != null && Convert.ToInt32(key.GetValue("AppsUseLightTheme", 1)) == 0;
    }
    private void ApplyClientTheme(bool dark)
    {
        ClientTheme.Apply(dark);
        ResourceDictionary resources = Application.Current == null ? Resources : Application.Current.Resources;
        foreach (string name in new string[] { "App", "Card", "Text", "Muted", "Border", "Accent", "AccentText", "Surface", "PrimarySoft" })
            resources["Client" + name] = ClientTheme.Brush(name);
        if (!resources.Contains("ClientFont")) ClientUiStyles.Install(resources);
    }

    private Border Card()
    {
        return new Border
        {
            Background = CardBrush,
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10)
        };
    }

    private Button PrimaryButton(string text, Brush background)
    {
        Button button = new Button
        {
            Content = text,
            Height = 36,
            MinWidth = 88,
            Margin = new Thickness(8, 0, 0, 0),
            Padding = new Thickness(16, 0, 16, 0),
            FontSize = 13,
            Background = background,
            Foreground = Brushes.White,
            BorderBrush = background,
            BorderThickness = new Thickness(1),
            Cursor = Cursors.Hand
        };
        return button;
    }

    private Button OutlineButton(string text, Brush foreground)
    {
        Button button = PrimaryButton(text, CardBrush);
        button.Foreground = foreground;
        button.BorderBrush = UiBorderBrush;
        return button;
    }

    private TextBlock SidebarSectionLabel(string text, Thickness margin)
    {
        return new TextBlock
        {
            Text = text,
            Foreground = MutedBrush,
            FontWeight = FontWeights.SemiBold,
            FontSize = 12,
            Margin = margin
        };
    }

    private Button SidebarNavButton(string title, string description)
    {
        bool hasDescription = !string.IsNullOrWhiteSpace(description);
        StackPanel content = new StackPanel { Margin = new Thickness(12, hasDescription ? 8 : 0, 12, hasDescription ? 8 : 0), VerticalAlignment = VerticalAlignment.Center };
        content.Children.Add(new TextBlock { Text = title, Foreground = TextBrush, FontWeight = FontWeights.SemiBold, FontSize = 13 });
        if (hasDescription) content.Children.Add(new TextBlock
        {
            Text = description,
            Foreground = MutedBrush,
            FontSize = 12,
            Margin = new Thickness(0, 2, 0, 0),
            TextWrapping = TextWrapping.Wrap
        });
        return new Button
        {
            Content = content,
            Height = hasDescription ? 52 : 42,
            Margin = new Thickness(0, 0, 0, 4),
            Padding = new Thickness(0),
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            HorizontalAlignment = HorizontalAlignment.Stretch,
            Background = SurfaceBrush,
            Foreground = TextBrush,
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(1),
            Cursor = Cursors.Hand
        };
    }

    private Button SidebarFooterSettingsButton()
    {
        DockPanel content = new DockPanel { Margin = new Thickness(10, 0, 10, 0) };
        TextBlock chevron = new TextBlock
        {
            Text = ">",
            Foreground = new SolidColorBrush(Color.FromRgb(148, 163, 184)),
            VerticalAlignment = VerticalAlignment.Center,
            FontSize = 16
        };
        DockPanel.SetDock(chevron, Dock.Right);
        content.Children.Add(chevron);
        Border dot = new Border
        {
            Background = AccentGreenBrush,
            Width = 7,
            Height = 7,
            CornerRadius = new CornerRadius(4),
            VerticalAlignment = VerticalAlignment.Center,
            Margin = new Thickness(2, 0, 9, 0)
        };
        DockPanel.SetDock(dot, Dock.Left);
        content.Children.Add(dot);
        content.Children.Add(new TextBlock
        {
            Text = "设置",
            Foreground = new SolidColorBrush(Color.FromRgb(226, 232, 240)),
            VerticalAlignment = VerticalAlignment.Center,
            FontSize = 13,
            FontWeight = FontWeights.SemiBold
        });
        return new Button
        {
            Content = content,
            Height = 42,
            Padding = new Thickness(0),
            HorizontalContentAlignment = HorizontalAlignment.Stretch,
            Background = Brushes.Transparent,
            BorderBrush = new SolidColorBrush(Color.FromRgb(49, 65, 89)),
            BorderThickness = new Thickness(0, 1, 0, 0),
            Cursor = Cursors.Hand
        };
    }

    private TextBlock DrawerSectionLabel(string text)
    {
        return new TextBlock
        {
            Text = text,
            Foreground = MutedBrush,
            FontSize = 12,
            FontWeight = FontWeights.SemiBold,
            Margin = new Thickness(0, 22, 0, 8)
        };
    }

    private Button DrawerActionButton(string text)
    {
        return new Button
        {
            Content = text,
            Height = 42,
            Margin = new Thickness(0, 0, 0, 6),
            Padding = new Thickness(12, 0, 12, 0),
            HorizontalContentAlignment = HorizontalAlignment.Left,
            Background = SurfaceBrush,
            Foreground = TextBrush,
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(1),
            Cursor = Cursors.Hand
        };
    }

    private Button DrawerCompactActionButton(string text)
    {
        return new Button
        {
            Content = text,
            Height = 42,
            MinWidth = 94,
            Margin = new Thickness(8, 0, 0, 6),
            Padding = new Thickness(10, 0, 10, 0),
            Background = CardBrush,
            Foreground = AccentTextBrush,
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(1),
            Cursor = Cursors.Hand
        };
    }

    private DataTemplate BuildInstanceItemTemplate()
    {
        DataTemplate template = new DataTemplate(typeof(InstanceListItem));
        FrameworkElementFactory row = new FrameworkElementFactory(typeof(DockPanel));
        row.SetValue(FrameworkElement.MarginProperty, new Thickness(2, 0, 2, 0));

        FrameworkElementFactory menuButton = new FrameworkElementFactory(typeof(Button));
        menuButton.SetValue(DockPanel.DockProperty, Dock.Right);
        menuButton.SetValue(Button.ContentProperty, "⋮");
        menuButton.SetValue(FrameworkElement.WidthProperty, 36.0);
        menuButton.SetValue(FrameworkElement.HeightProperty, 30.0);
        menuButton.SetValue(Control.PaddingProperty, new Thickness(0));
        menuButton.SetValue(Control.BackgroundProperty, Brushes.Transparent);
        menuButton.SetValue(Control.ForegroundProperty, TextBrush);
        menuButton.SetValue(Control.BorderThicknessProperty, new Thickness(0));
        menuButton.SetValue(FrameworkElement.CursorProperty, Cursors.Hand);
        menuButton.SetValue(FrameworkElement.ToolTipProperty, "更多操作");
        menuButton.SetBinding(FrameworkElement.TagProperty, new Binding("Id"));
        menuButton.AddHandler(Button.ClickEvent, new RoutedEventHandler(InstanceMenuButtonClick));
        row.AppendChild(menuButton);

        FrameworkElementFactory label = new FrameworkElementFactory(typeof(TextBlock));
        label.SetValue(TextBlock.VerticalAlignmentProperty, VerticalAlignment.Center);
        label.SetValue(TextBlock.TextTrimmingProperty, TextTrimming.CharacterEllipsis);
        label.SetValue(FrameworkElement.MarginProperty, new Thickness(8, 0, 4, 0));
        label.SetBinding(TextBlock.TextProperty, new Binding("Text"));
        row.AppendChild(label);

        template.VisualTree = row;
        return template;
    }

    private void InstanceMenuButtonClick(object sender, RoutedEventArgs e)
    {
        e.Handled = true;
        Button button = sender as Button;
        if (button == null) return;
        string instanceId = button.Tag as string;
        InstanceListItem item = FindInstanceItem(instanceId);
        if (item == null) return;
        instanceList.SelectedItem = item;

        ContextMenu menu = new ContextMenu();
        MenuItem delete = new MenuItem { Header = "删除实例", Foreground = DangerBrush };
        delete.Click += delegate { Safe(delegate { DeleteInstance(item); }); };
        menu.Items.Add(delete);
        menu.PlacementTarget = button;
        menu.Placement = System.Windows.Controls.Primitives.PlacementMode.Bottom;
        menu.IsOpen = true;
    }

    private InstanceListItem FindInstanceItem(string instanceId)
    {
        foreach (object entry in instanceList.Items)
        {
            InstanceListItem item = entry as InstanceListItem;
            if (item != null && item.Id == instanceId) return item;
        }
        return null;
    }

    private void BuildTray()
    {
        WF.ContextMenuStrip menu = new WF.ContextMenuStrip();
        menu.Items.Add("打开 88FRP", null, delegate { ShowFromTray(); });
        menu.Items.Add("打开服务入口", null, delegate { ShowFromTray(); ShowGatewayWorkspace("portal"); });
        menu.Items.Add("重启后台", null, delegate { Safe(delegate { client.RestartBackend(); RefreshAll(); }); });
        menu.Items.Add(new WF.ToolStripSeparator());
        menu.Items.Add("退出", null, delegate { exiting = true; trayIcon.Visible = false; client.StopBackend(true); Close(); });
        trayIcon.Icon = NativeClient.LoadAppIcon();
        trayIcon.Text = "88FRP 正在后台运行";
        trayIcon.Visible = true;
        trayIcon.ContextMenuStrip = menu;
        trayIcon.DoubleClick += delegate { ShowFromTray(); };
    }

    private void OnClosing(object sender, System.ComponentModel.CancelEventArgs e)
    {
        if (!exiting)
        {
            e.Cancel = true;
            HideToTray();
        }
    }

    private void HideToTray()
    {
        Hide();
        trayIcon.ShowBalloonTip(1600, "88FRP", "已保持后台运行，可从托盘图标重新打开。", WF.ToolTipIcon.Info);
    }

    private void ShowFromTray()
    {
        Show();
        WindowState = WindowState.Normal;
        Activate();
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        HwndSource source = HwndSource.FromHwnd(new WindowInteropHelper(this).Handle);
        if (source != null) source.AddHook(WndProc);
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == NativeClient.ExitWindowMessage)
        {
            exiting = true;
            trayIcon.Visible = false;
            client.StopBackend(true);
            Close();
            handled = true;
            return IntPtr.Zero;
        }
        if (msg == NativeClient.ShowWindowMessage)
        {
            ShowFromTray();
            handled = true;
        }
        return IntPtr.Zero;
    }

    private void RunFirstLaunchGuide()
    {
        if (backgroundStart) return;
        if (NativeClient.IsAutoStartEnabled())
        {
            File.WriteAllText(Program.FirstRunPath, "enabled", Encoding.UTF8);
            return;
        }
        if (File.Exists(Program.FirstRunPath))
        {
            string state = File.ReadAllText(Program.FirstRunPath, Encoding.UTF8).Trim();
            if (string.Equals(state, "declined", StringComparison.OrdinalIgnoreCase)
                || string.Equals(state, "enabled", StringComparison.OrdinalIgnoreCase)) return;
        }
        MessageBoxResult result = MessageBox.Show(
            "是否开启开机自启动并保持后台运行？\n\n开启后，后台会在开机后自动运行，无需登录 Windows；登录后显示托盘入口。",
            "88FRP 首次启动设置",
            MessageBoxButton.YesNo,
            MessageBoxImage.Question
        );
        if (result == MessageBoxResult.Yes)
        {
            NativeClient.EnableAutoStart();
            autoStartButton.Content = "开机自启：已开启";
            File.WriteAllText(Program.FirstRunPath, "enabled", Encoding.UTF8);
        }
        else
        {
            File.WriteAllText(Program.FirstRunPath, "declined", Encoding.UTF8);
        }
    }

    private void RefreshAll()
    {
        Task ignored = RefreshAllAsync();
    }

    private async Task RefreshAllAsync()
    {
        try
        {
            bool healthy = await Task.Run(delegate { return client.IsBackendHealthy(); });
            if (backendValue != null) backendValue.Text = healthy ? "正常" : "离线";
            await RefreshGatewayStatusAsync(true);
            if (NativeClient.GetBool(gatewayOverviewState, "initialized")) return;
            RefreshFrpAccountStatus();
            RefreshInstances(true);
            if (!string.IsNullOrEmpty(currentInstanceId)) LoadCurrentDetails();
        }
        catch (Exception ex)
        {
            if (backendValue != null) backendValue.Text = "离线";
            ApplyGatewayOverview(null, ex.Message);
        }
    }

    private void RefreshGatewayStatus()
    {
        Task ignored = RefreshGatewayStatusAsync(false);
    }

    private void RefreshGatewayStatusInteractive()
    {
        Task ignored = RefreshGatewayStatusAsync(true);
    }

    private async Task RefreshGatewayStatusAsync(bool interactive)
    {
        if (gatewayRefreshRunning) return;
        gatewayRefreshRunning = true;
        if (interactive)
        {
            if (gatewayRefreshButton != null) gatewayRefreshButton.IsEnabled = false;
            ShowGatewayMessage("正在刷新设备状态…", false, false);
        }
        try
        {
            Dictionary<string, object> gateway = await Task.Run(delegate
            {
                return client.GetDict("/api/gateway", 15000);
            });
            ApplyGatewayOverview(gateway, "");
            SaveGatewayOverviewCache();
            if (!NativeClient.GetBool(gateway, "initialized"))
            {
                gatewayDomainStatus.Text = "未初始化";
                gatewayIpv6Status.Text = "待初始化";
                gatewayCaddyStatus.Text = "未启动";
                gatewayFrpcStatus.Text = "未启动";
                if (interactive) ShowGatewayMessage("状态已更新。", false, true);
                return;
            }
            Dictionary<string, object> device = NativeClient.AsDict(gateway.ContainsKey("device") ? gateway["device"] : null);
            Dictionary<string, object> ipv6 = NativeClient.AsDict(device.ContainsKey("ipv6Detected") ? device["ipv6Detected"] : null);
            Dictionary<string, object> runtime = NativeClient.AsDict(gateway.ContainsKey("runtime") ? gateway["runtime"] : null);
            string domain = NativeClient.GetString(device, "domain");
            string address = NativeClient.GetString(ipv6, "address");
            string caddy = NativeClient.GetNestedString(runtime, "caddy", "status");
            string frpc = NativeClient.GetNestedString(runtime, "frpc", "status");
            int relayCount = NativeClient.AsArray(runtime.ContainsKey("relays") ? runtime["relays"] : null).Length;
            gatewayDomainStatus.Text = domain == "" ? "尚未设置域名" : domain;
            gatewayIpv6Status.Text = address == "" ? "未检测到公网 IPv6" : address;
            gatewayCaddyStatus.Text = TranslateStatus(caddy);
            gatewayFrpcStatus.Text = TranslateStatus(frpc) + (relayCount > 0 ? " · " + relayCount + " 个中继" : "");
            gatewayDomainStatus.ToolTip = domain == "" ? "" : "https://" + domain + ":" + NativeClient.GetInt(device, "gatewayPort");
            gatewayIpv6Status.ToolTip = NativeClient.GetString(ipv6, "interfaceName");
            if (interactive) ShowGatewayMessage("状态已更新。", false, true);
        }
        catch (Exception ex)
        {
            ApplyGatewayOverview(null, ex.Message);
            gatewayDomainStatus.Text = "后台未连接";
            gatewayIpv6Status.Text = "-";
            gatewayCaddyStatus.Text = "-";
            gatewayFrpcStatus.Text = "-";
        }
        finally
        {
            gatewayRefreshRunning = false;
            if (gatewayRefreshButton != null) gatewayRefreshButton.IsEnabled = true;
        }
    }

    private void RefreshInstances(bool keepSelection)
    {
        object[] rows = client.GetArray("/api/instances");
        string selectedId = keepSelection ? currentInstanceId : "";
        InstanceListItem previous = instanceList.SelectedItem as InstanceListItem;
        string previousId = previous == null ? "" : previous.Id;
        Dictionary<string, object> selectedData = null;
        refreshingInstanceList = true;
        try
        {
            instanceList.Items.Clear();
            foreach (object row in rows)
            {
                Dictionary<string, object> item = NativeClient.AsDict(row);
                string id = NativeClient.GetString(item, "id");
                string name = NativeClient.GetString(item, "name");
                string status = NativeClient.GetNestedString(item, "runtime", "status");
                InstanceListItem listItem = new InstanceListItem { Id = id, Name = name, Status = status, Text = name + "  ·  " + TranslateStatus(status) };
                instanceList.Items.Add(listItem);
                if (id == selectedId) { instanceList.SelectedItem = listItem; selectedData = item; }
            }
            if (instanceList.SelectedIndex < 0 && instanceList.Items.Count > 0) instanceList.SelectedIndex = 0;
        }
        finally { refreshingInstanceList = false; }
        InstanceListItem selected = instanceList.SelectedItem as InstanceListItem;
        if (selected == null) { ClearCurrentDetails(); return; }
        // Polling updates runtime only. Re-selecting a rebuilt list item used to
        // recreate every editor each four seconds, discarding typing and focus.
        if (!keepSelection || selected.Id != previousId || selected.Id != currentInstanceId)
            SelectCurrentInstance();
        else if (selectedData != null)
        {
            statusValue.Text = TranslateStatus(NativeClient.GetNestedString(selectedData, "runtime", "status"));
            string pid = NativeClient.GetNestedString(selectedData, "runtime", "pid");
            pidValue.Text = pid == "" ? "-" : pid;
            backendValue.Text = "正常";
            if (domainTabs != null && domainTabs.SelectedIndex == 3) LoadLogs();
            if (domainTabs != null && domainTabs.SelectedIndex == 2) LoadDomainBinding();
        }
    }

    private void SelectCurrentInstance()
    {
        InstanceListItem item = instanceList.SelectedItem as InstanceListItem;
        if (item == null) return;
        currentInstanceId = item.Id;
        LoadCurrentDetails();
    }

    private void LoadCurrentDetails()
    {
        if (string.IsNullOrEmpty(currentInstanceId)) return;
        Dictionary<string, object> instance = client.GetDict("/api/instances/" + currentInstanceId);
        secretBox.Text = NativeClient.GetString(instance, "secretKey");
        autoSyncBox.IsChecked = NativeClient.GetBool(instance, "autoSyncEnabled");
        string status = NativeClient.GetNestedString(instance, "runtime", "status");
        string pid = NativeClient.GetNestedString(instance, "runtime", "pid");
        statusValue.Text = TranslateStatus(status);
        pidValue.Text = pid == "" ? "-" : pid;
        Dictionary<string, object> config = client.GetDict("/api/instances/" + currentInstanceId + "/config");
        configBox.Text = NativeClient.GetString(config, "configText");
        LoadTunnels();
        LoadLogs();
        if (domainTabs != null && domainTabs.SelectedIndex == 2) LoadDomainBinding();
    }

    private void LoadTunnels()
    {
        tunnels.Clear();
        tunnelPanel.Children.Clear();
        tunnelChecks.Clear();
        tunnelGroupInputs.Clear();
        if (string.IsNullOrEmpty(currentInstanceId)) return;
        Dictionary<string, object> data = client.GetDict("/api/instances/" + currentInstanceId + "/tunnels");
        object[] rows = NativeClient.AsArray(data.ContainsKey("tunnels") ? data["tunnels"] : null);
        foreach (object row in rows)
        {
            Dictionary<string, object> tunnel = NativeClient.AsDict(row);
            tunnels.Add(tunnel);
        }

        Dictionary<string, List<Dictionary<string, object>>> groups = new Dictionary<string, List<Dictionary<string, object>>>();
        List<string> groupOrder = new List<string>();
        foreach (Dictionary<string, object> tunnel in tunnels)
        {
            string group = NativeClient.GetString(tunnel, "group");
            if (group == "") group = "未分组";
            if (!groups.ContainsKey(group))
            {
                groups[group] = new List<Dictionary<string, object>>();
                groupOrder.Add(group);
            }
            groups[group].Add(tunnel);
        }
        groupOrder.Sort(delegate(string left, string right)
        {
            if (left == "未分组") return 1;
            if (right == "未分组") return -1;
            return string.Compare(left, right, StringComparison.CurrentCulture);
        });

        foreach (string group in groupOrder)
        {
            List<Dictionary<string, object>> groupTunnels = groups[group];
            string groupKey = currentInstanceId + "\n" + group;
            bool collapsed = collapsedTunnelGroups.Contains(groupKey);
            Border groupCard = new Border
            {
                BorderBrush = UiBorderBrush,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(8),
                Background = CardBrush,
                Margin = new Thickness(0, 0, 0, 10)
            };
            StackPanel groupPanel = new StackPanel();
            groupCard.Child = groupPanel;
            DockPanel groupHeader = new DockPanel
            {
                Background = SurfaceBrush,
                MinHeight = 42,
                LastChildFill = true
            };
            groupPanel.Children.Add(groupHeader);
            TextBlock tunnelCount = new TextBlock
            {
                Text = groupTunnels.Count + " 条隧道",
                Foreground = MutedBrush,
                FontSize = 12,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(9, 0, 12, 0)
            };
            DockPanel.SetDock(tunnelCount, Dock.Right);
            groupHeader.Children.Add(tunnelCount);
            CheckBox groupToggle = new CheckBox
            {
                IsThreeState = true,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(3, 0, 6, 0),
                ToolTip = "启用或停用该分组的全部隧道"
            };
            DockPanel.SetDock(groupToggle, Dock.Right);
            groupHeader.Children.Add(groupToggle);
            StackPanel groupTitle = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 0, 0, 0) };
            groupHeader.Children.Add(groupTitle);
            groupTitle.Children.Add(new TextBlock { Text = group, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
            Button collapseButton = new Button
            {
                Content = collapsed ? "⌄" : "⌃",
                Width = 36,
                Height = 34,
                Margin = new Thickness(3, 1, 0, 1),
                Padding = new Thickness(0),
                Background = Brushes.Transparent,
                Foreground = MutedBrush,
                BorderThickness = new Thickness(0),
                Cursor = Cursors.Hand,
                ToolTip = collapsed ? "展开分组" : "收起分组"
            };
            groupTitle.Children.Add(collapseButton);
            StackPanel groupRows = new StackPanel { Visibility = collapsed ? Visibility.Collapsed : Visibility.Visible };
            groupPanel.Children.Add(groupRows);
            collapseButton.Click += delegate
            {
                bool nextCollapsed = groupRows.Visibility != Visibility.Collapsed;
                groupRows.Visibility = nextCollapsed ? Visibility.Collapsed : Visibility.Visible;
                collapseButton.Content = nextCollapsed ? "⌄" : "⌃";
                collapseButton.ToolTip = nextCollapsed ? "展开分组" : "收起分组";
                if (nextCollapsed) collapsedTunnelGroups.Add(groupKey); else collapsedTunnelGroups.Remove(groupKey);
                SaveCollapsedTunnelGroups();
            };
            List<CheckBox> groupChecks = new List<CheckBox>();
            bool updatingGroup = false;
            Action refreshGroupToggle = delegate
            {
                int enabledCount = 0;
                foreach (CheckBox item in groupChecks) if (item.IsChecked == true) enabledCount += 1;
                updatingGroup = true;
                groupToggle.IsChecked = enabledCount == groupChecks.Count ? (bool?)true : enabledCount == 0 ? (bool?)false : null;
                updatingGroup = false;
                UpdateTunnelSelectionSummary();
            };
            RoutedEventHandler toggleGroup = delegate(object sender, RoutedEventArgs args)
            {
                if (updatingGroup) return;
                bool enabled = groupToggle.IsChecked == true;
                updatingGroup = true;
                foreach (CheckBox item in groupChecks) item.IsChecked = enabled;
                updatingGroup = false;
                refreshGroupToggle();
            };
            groupToggle.Checked += toggleGroup;
            groupToggle.Unchecked += toggleGroup;

            foreach (Dictionary<string, object> tunnel in groupTunnels)
            {
                string tunnelName = NativeClient.GetString(tunnel, "name");
                string displayName = NativeClient.GetString(tunnel, "displayName");
                string title = displayName == "" ? tunnelName : displayName;
                Grid row = new Grid { Margin = new Thickness(12, 10, 12, 10) };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(148) });
                StackPanel copy = new StackPanel();
                copy.Children.Add(new TextBlock { Text = title, FontSize = 13, Foreground = TextBrush, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis, ToolTip = title + "\n" + tunnelName });
                copy.Children.Add(new TextBlock { Text = NativeClient.GetString(tunnel, "type").ToUpperInvariant() + "   " + NativeClient.GetString(tunnel, "localPort") + "  →  " + NativeClient.GetString(tunnel, "remotePort"), Foreground = MutedBrush, FontSize = 12, Margin = new Thickness(0, 4, 0, 0) });
                CheckBox check = new CheckBox
                {
                    IsChecked = NativeClient.GetBool(tunnel, "enabled"),
                    HorizontalContentAlignment = HorizontalAlignment.Stretch,
                    VerticalAlignment = VerticalAlignment.Center,
                    Margin = new Thickness(0, 0, 16, 0),
                    FontSize = 13,
                    Content = copy
                };
                check.Checked += delegate { if (!updatingGroup) refreshGroupToggle(); };
                check.Unchecked += delegate { if (!updatingGroup) refreshGroupToggle(); };
                Grid.SetColumn(check, 0);
                row.Children.Add(check);
                tunnelChecks[tunnelName] = check;
                groupChecks.Add(check);

                StackPanel groupEditor = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
                TextBox groupInput = new TextBox
                {
                    Height = 34,
                    Width = 148,
                    Text = NativeClient.GetString(tunnel, "groupOverride"),
                    ToolTip = "自定义分组；留空会继续自动归入“" + group + "”。"
                };
                groupEditor.Children.Add(groupInput);
                Grid.SetColumn(groupEditor, 1);
                row.Children.Add(groupEditor);
                tunnelGroupInputs[tunnelName] = groupInput;
                groupRows.Children.Add(row);
            }
            refreshGroupToggle();
            tunnelPanel.Children.Add(groupCard);
        }
        UpdateTunnelSelectionSummary();
    }

    private void UpdateTunnelSelectionSummary()
    {
        int count = 0;
        foreach (CheckBox check in tunnelChecks.Values) if (check.IsChecked == true) count++;
        tunnelSelectionSummary.Text = "共 " + tunnelChecks.Count + " 条隧道 · 已选择 " + count + " 条";
    }

    private void LoadCollapsedTunnelGroups()
    {
        try
        {
            if (!File.Exists(CollapsedTunnelGroupsPath)) return;
            object[] values = NativeClient.AsArray(new JavaScriptSerializer().DeserializeObject(File.ReadAllText(CollapsedTunnelGroupsPath, Encoding.UTF8)));
            foreach (object value in values)
            {
                string key = Convert.ToString(value) ?? "";
                if (key != "") collapsedTunnelGroups.Add(key);
            }
        }
        catch { }
    }

    private void SaveCollapsedTunnelGroups()
    {
        try
        {
            Directory.CreateDirectory(Program.AppDataDir);
            File.WriteAllText(CollapsedTunnelGroupsPath, new JavaScriptSerializer().Serialize(new List<string>(collapsedTunnelGroups)), Encoding.UTF8);
        }
        catch { }
    }

    private void LoadLogs()
    {
        if (string.IsNullOrEmpty(currentInstanceId)) return;
        Dictionary<string, object> data = client.GetDict("/api/instances/" + currentInstanceId + "/logs?tail=300");
        logsBox.Text = NativeClient.GetString(data, "content");
    }

    private void CreateInstance()
    {
        CreateInstanceWindow dialog = new CreateInstanceWindow { Owner = this };
        if (dialog.ShowDialog() != true) return;
        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["name"] = dialog.InstanceName;
        payload["secretKey"] = dialog.SecretKey;
        payload["autoSyncEnabled"] = dialog.AutoSync;
        Dictionary<string, object> created = client.PostDict("/api/instances", payload);
        currentInstanceId = NativeClient.GetString(created, "id");
        RefreshInstances(true);
    }

    private void DeleteInstance(InstanceListItem item)
    {
        if (item == null) return;
        string runningNotice = item.Status == "running" ? "\n\n该实例正在运行，删除时会先停止后台隧道。" : "";
        MessageBoxResult result = MessageBox.Show(
            "确定删除实例「" + item.Name + "」吗？" + runningNotice + "\n\n此操作无法撤销。",
            "删除实例",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning
        );
        if (result != MessageBoxResult.Yes) return;

        int index = instanceList.Items.IndexOf(item);
        string fallbackId = "";
        if (instanceList.Items.Count > 1)
        {
            int fallbackIndex = index < instanceList.Items.Count - 1 ? index + 1 : index - 1;
            InstanceListItem fallback = instanceList.Items[fallbackIndex] as InstanceListItem;
            if (fallback != null) fallbackId = fallback.Id;
        }

        client.DeleteDict("/api/instances/" + item.Id);
        currentInstanceId = fallbackId;
        RefreshInstances(true);
        if (instanceList.Items.Count == 0) ClearCurrentDetails();
        MessageBox.Show("实例「" + item.Name + "」已删除。", Program.AppName, MessageBoxButton.OK, MessageBoxImage.Information);
    }

    private void ClearCurrentDetails()
    {
        currentInstanceId = "";
        statusValue.Text = "-";
        pidValue.Text = "-";
        secretBox.Text = "";
        autoSyncBox.IsChecked = false;
        configBox.Text = "";
        tunnelPanel.Children.Clear();
        tunnels.Clear();
        tunnelChecks.Clear();
        tunnelGroupInputs.Clear();
        logsBox.Text = "";
    }

    private void SaveConfig()
    {
        if (string.IsNullOrEmpty(currentInstanceId)) return;
        Dictionary<string, object> info = new Dictionary<string, object>();
        info["secretKey"] = secretBox.Text.Trim();
        info["autoSyncEnabled"] = autoSyncBox.IsChecked == true;
        client.PutDict("/api/instances/" + currentInstanceId, info);
        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["configText"] = configBox.Text;
        client.PutDict("/api/instances/" + currentInstanceId + "/config", payload);
        LoadTunnels();
        MessageBox.Show("配置已保存。新隧道默认关闭，请到“隧道选择”里勾选。", Program.AppName);
    }

    private void SaveTunnels()
    {
        if (string.IsNullOrEmpty(currentInstanceId)) return;
        Dictionary<string, object> selection = new Dictionary<string, object>();
        Dictionary<string, object> groupOverrides = new Dictionary<string, object>();
        foreach (Dictionary<string, object> tunnel in tunnels)
        {
            string tunnelName = NativeClient.GetString(tunnel, "name");
            CheckBox check = tunnelChecks.ContainsKey(tunnelName) ? tunnelChecks[tunnelName] : null;
            TextBox groupInput = tunnelGroupInputs.ContainsKey(tunnelName) ? tunnelGroupInputs[tunnelName] : null;
            selection[tunnelName] = check != null && check.IsChecked == true;
            groupOverrides[tunnelName] = groupInput == null ? "" : groupInput.Text.Trim();
        }
        Dictionary<string, object> groupPayload = new Dictionary<string, object>();
        groupPayload["groupOverrides"] = groupOverrides;
        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["selection"] = selection;
        client.PutDict("/api/instances/" + currentInstanceId + "/tunnels/groups", groupPayload);
        client.PutDict("/api/instances/" + currentInstanceId + "/tunnels/selection", payload);
        LoadTunnels();
        MessageBox.Show("隧道选择和分组已保存，重启实例后生效。", Program.AppName);
    }

    private void RuntimeAction(string action)
    {
        if (string.IsNullOrEmpty(currentInstanceId)) return;
        client.PostDict("/api/instances/" + currentInstanceId + "/" + action, new Dictionary<string, object>());
        Thread.Sleep(500);
        RefreshAll();
    }

    private async Task SyncCurrentAsync()
    {
        if (string.IsNullOrEmpty(currentInstanceId)) return;
        string instanceId = currentInstanceId;
        Dictionary<string, object> info = new Dictionary<string, object>();
        info["secretKey"] = secretBox.Text.Trim();
        info["autoSyncEnabled"] = autoSyncBox.IsChecked == true;
        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["restartOnChange"] = true;
        bool completed = await RunLongOperationAsync("同步中", delegate
        {
            client.PutDict("/api/instances/" + instanceId, info);
            client.PostDict("/api/instances/" + instanceId + "/sync", payload, 90000);
        });
        if (!completed) return;
        Safe(RefreshAll);
        MessageBox.Show("同步完成。已保存的隧道选择会保留，新隧道默认关闭。", Program.AppName);
    }

    private void ToggleAutoStart()
    {
        if (NativeClient.IsAutoStartEnabled())
        {
            NativeClient.DisableAutoStart();
            autoStartButton.Content = "开机自启：未开启";
        }
        else
        {
            NativeClient.EnableAutoStart();
            autoStartButton.Content = "开机自启：已开启";
        }
    }

    private void RefreshFrpAccountStatus()
    {
        if (frpAccountButton == null) return;
        Dictionary<string, object> account = client.GetDict("/api/88frp/account");
        bool connected = NativeClient.GetBool(account, "connected");
        string username = NativeClient.GetString(account, "username");
        bool autoLogin = NativeClient.GetBool(account, "autoLoginEnabled");
        frpAccountButton.Content = connected ? "管理 88FRP 账号" : "连接 88FRP 账号";
        frpAccountStatus.Text = connected ? (username + (autoLogin ? " · 自动登录" : " · 需手动登录")) : "未连接";
    }

    private async Task ManageConsoleSecurityAsync()
    {
        try
        {
            Dictionary<string, object> status = client.GetDict("/api/console-auth/status");
            ConsoleSecurityWindow dialog = new ConsoleSecurityWindow(NativeClient.GetString(status, "username")) { Owner = this };
            if (dialog.ShowDialog() != true) return;
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["username"] = dialog.Username;
            payload["password"] = dialog.Password;
            bool completed = await RunLongOperationAsync("保存控制台安全设置", delegate { client.PutDict("/api/console-auth", payload, 30000); });
            if (!completed) return;
            if (dialog.RevokeDevices) client.PostDict("/api/console-auth/revoke-sessions", new Dictionary<string, object>());
            MessageBox.Show("控制台账号已保存。普通浏览器登录 24 小时有效；勾选记住设备后会持续登录，直到在此撤销。", Program.AppName, MessageBoxButton.OK, MessageBoxImage.Information);
        }
        catch (Exception ex) { MessageBox.Show(FriendlyError(ex), Program.AppName, MessageBoxButton.OK, MessageBoxImage.Warning); }
    }

    private async Task ManageFrpAccountAsync()
    {
        try
        {
            Dictionary<string, object> account = client.GetDict("/api/88frp/account");
            if (NativeClient.GetBool(account, "connected"))
            {
                MessageBoxResult result = MessageBox.Show(
                    "断开后会删除本机保存的 88FRP 登录令牌和密码，已缓存的隧道名称会保留。\n\n是否断开？",
                    Program.AppName,
                    MessageBoxButton.YesNo,
                    MessageBoxImage.Question
                );
                if (result != MessageBoxResult.Yes) return;
                client.DeleteDict("/api/88frp/account");
                RefreshFrpAccountStatus();
                MessageBox.Show("88FRP 账号已断开。", Program.AppName);
                return;
            }

            FrpAccountWindow dialog = new FrpAccountWindow { Owner = this };
            if (dialog.ShowDialog() != true) return;
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["username"] = dialog.Username;
            payload["password"] = dialog.Password;
            payload["autoLoginEnabled"] = dialog.AutoLoginEnabled;
            bool completed = await RunLongOperationAsync("登录中", delegate
            {
                client.PostDict("/api/88frp/account/connect", payload, 90000);
            });
            if (!completed) return;
            RefreshFrpAccountStatus();
            LoadTunnels();
            MessageBox.Show("88FRP 已连接。同步配置发生变化时会自动刷新隧道名称。", Program.AppName);
        }
        catch (Exception ex)
        {
            backendValue.Text = client.IsBackendHealthy() ? "正常" : "离线";
            MessageBox.Show(FriendlyError(ex), Program.AppName, MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private async Task<bool> RunLongOperationAsync(string statusText, Action operation)
    {
        if (longOperationRunning) return false;
        longOperationRunning = true;
        if (syncButton != null) syncButton.IsEnabled = false;
        if (frpAccountButton != null) frpAccountButton.IsEnabled = false;
        backendValue.Text = statusText;
        try
        {
            await Task.Run(operation);
            backendValue.Text = "正常";
            return true;
        }
        catch (Exception ex)
        {
            backendValue.Text = "错误";
            MessageBox.Show(FriendlyError(ex), Program.AppName, MessageBoxButton.OK, MessageBoxImage.Warning);
            return false;
        }
        finally
        {
            longOperationRunning = false;
            if (syncButton != null) syncButton.IsEnabled = true;
            if (frpAccountButton != null) frpAccountButton.IsEnabled = true;
        }
    }

    private void CheckBackendWatchdog()
    {
        if (Interlocked.CompareExchange(ref watchdogCheckRunning, 1, 0) != 0) return;
        ThreadPool.QueueUserWorkItem(delegate
        {
            bool healthy = client.IsBackendHealthy(2000);
            if (healthy)
            {
                Interlocked.Exchange(ref watchdogFailureCount, 0);
            }
            else if (Interlocked.Increment(ref watchdogFailureCount) >= 3)
            {
                try
                {
                    client.RestartBackend();
                    healthy = client.IsBackendHealthy(2000);
                }
                catch
                {
                    healthy = false;
                }
                Interlocked.Exchange(ref watchdogFailureCount, 0);
            }

            Interlocked.Exchange(ref watchdogCheckRunning, 0);
            Dispatcher.BeginInvoke(new Action(delegate
            {
                if (!longOperationRunning)
                {
                    backendValue.Text = healthy ? "正常" : "检查中";
                }
            }));
        });
    }

    private void Safe(Action action)
    {
        try { action(); }
        catch (Exception ex)
        {
            backendValue.Text = client.IsBackendHealthy() ? "正常" : "离线";
            try { File.AppendAllText(Path.Combine(Program.AppDataDir, "native-client-errors.log"), DateTime.Now.ToString("s") + " " + ex.Message + Environment.NewLine); } catch { }
            MessageBox.Show(FriendlyError(ex), Program.AppName, MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void SafeSilent(Action action)
    {
        try { action(); } catch { }
    }

    private string FriendlyError(Exception ex)
    {
        string message = ex.Message;
        if (message.IndexOf("HTTP 500", StringComparison.OrdinalIgnoreCase) >= 0 || message.IndexOf("(500)", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            return "操作失败：远程配置接口返回 500。\n\n通常是密钥不正确、远程服务临时异常，或 88FRP 平台没有返回有效配置。\n请检查密钥后再同步。";
        }
        if (message.IndexOf("HTTP 401", StringComparison.OrdinalIgnoreCase) >= 0 || message.IndexOf("HTTP 403", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            return "操作失败：密钥无效或没有权限。\n请检查密钥是否正确。";
        }
        return message;
    }

    private static string TranslateStatus(string status)
    {
        if (status == "running") return "运行中";
        if (status == "stopped") return "已停止";
        if (status == "starting") return "启动中";
        if (status == "stopping") return "停止中";
        if (status == "reconnecting") return "重连中";
        if (status == "restarting") return "恢复中";
        if (status == "error") return "异常";
        return "未知";
    }
}

internal sealed class CreateInstanceWindow : Window
{
    private readonly TextBox nameBox = new TextBox();
    private readonly TextBox secretBox = new TextBox();
    private readonly CheckBox autoSyncBox = new CheckBox { Content = "创建后自动同步" };
    public string InstanceName { get { return nameBox.Text.Trim(); } }
    public string SecretKey { get { return secretBox.Text.Trim(); } }
    public bool AutoSync { get { return autoSyncBox.IsChecked == true; } }

    public CreateInstanceWindow()
    {
        Title = "创建实例";
        Width = 430;
        Height = 230;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        ClientUiStyles.ConfigureWindow(this);
        Icon = NativeClient.LoadIconImage();
        Grid grid = new Grid { Margin = new Thickness(18) };
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(70) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        Content = grid;
        AddLabel(grid, "名称", 0);
        nameBox.Height = 30;
        Grid.SetRow(nameBox, 0); Grid.SetColumn(nameBox, 1); grid.Children.Add(nameBox);
        AddLabel(grid, "密钥", 1);
        secretBox.Height = 30;
        secretBox.Margin = new Thickness(0, 10, 0, 0);
        Grid.SetRow(secretBox, 1); Grid.SetColumn(secretBox, 1); grid.Children.Add(secretBox);
        autoSyncBox.Margin = new Thickness(0, 12, 0, 0);
        Grid.SetRow(autoSyncBox, 2); Grid.SetColumn(autoSyncBox, 1); grid.Children.Add(autoSyncBox);
        StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom };
        Button cancel = new Button { Content = "取消", Width = 86, Height = 32, Margin = new Thickness(8, 0, 0, 0) };
        Button ok = new Button { Content = "创建", Width = 86, Height = 32, Margin = new Thickness(8, 0, 0, 0), IsDefault = true };
        cancel.Click += delegate { DialogResult = false; };
        ok.Click += delegate
        {
            if (InstanceName == "")
            {
                MessageBox.Show("请输入实例名称。");
                return;
            }
            DialogResult = true;
        };
        actions.Children.Add(cancel);
        actions.Children.Add(ok);
        Grid.SetRow(actions, 3);
        Grid.SetColumnSpan(actions, 2);
        grid.Children.Add(actions);
    }

    private void AddLabel(Grid grid, string text, int row)
    {
        TextBlock label = new TextBlock { Text = text, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, row == 0 ? 0 : 10, 12, 0) };
        Grid.SetRow(label, row);
        Grid.SetColumn(label, 0);
        grid.Children.Add(label);
    }
}

internal sealed class FrpAccountWindow : Window
{
    private readonly TextBox usernameBox = new TextBox();
    private readonly PasswordBox passwordBox = new PasswordBox();
    private readonly CheckBox autoLoginBox = new CheckBox { Content = "保存密码并在登录失效时自动重新登录", IsChecked = true };
    public string Username { get { return usernameBox.Text.Trim(); } }
    public string Password { get { return passwordBox.Password; } }
    public bool AutoLoginEnabled { get { return autoLoginBox.IsChecked == true; } }

    public FrpAccountWindow()
    {
        Title = "连接 88FRP 账号";
        Width = 480;
        Height = 280;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        ClientUiStyles.ConfigureWindow(this);
        Icon = NativeClient.LoadIconImage();
        Grid grid = new Grid { Margin = new Thickness(20) };
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(74) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        Content = grid;
        AddLabel(grid, "账号", 0);
        usernameBox.Height = 31;
        usernameBox.VerticalContentAlignment = VerticalAlignment.Center;
        Grid.SetRow(usernameBox, 0); Grid.SetColumn(usernameBox, 1); grid.Children.Add(usernameBox);
        AddLabel(grid, "密码", 1);
        passwordBox.Height = 31;
        passwordBox.Margin = new Thickness(0, 12, 0, 0);
        Grid.SetRow(passwordBox, 1); Grid.SetColumn(passwordBox, 1); grid.Children.Add(passwordBox);
        autoLoginBox.Margin = new Thickness(0, 14, 0, 0);
        autoLoginBox.ToolTip = "仅在当前 Windows 用户下加密保存，不写入日志或配置导出。";
        Grid.SetRow(autoLoginBox, 2); Grid.SetColumn(autoLoginBox, 1); grid.Children.Add(autoLoginBox);
        StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom };
        Button cancel = new Button { Content = "取消", Width = 86, Height = 32, Margin = new Thickness(8, 0, 0, 0) };
        Button ok = new Button { Content = "连接", Width = 86, Height = 32, Margin = new Thickness(8, 0, 0, 0), IsDefault = true };
        cancel.Click += delegate { DialogResult = false; };
        ok.Click += delegate
        {
            if (Username == "" || Password == "")
            {
                MessageBox.Show("请输入 88FRP 账号和密码。", Program.AppName);
                return;
            }
            DialogResult = true;
        };
        actions.Children.Add(cancel);
        actions.Children.Add(ok);
        Grid.SetRow(actions, 3); Grid.SetColumnSpan(actions, 2); grid.Children.Add(actions);
    }

    private void AddLabel(Grid grid, string text, int row)
    {
        TextBlock label = new TextBlock { Text = text, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, row == 0 ? 0 : 12, 12, 0) };
        Grid.SetRow(label, row); Grid.SetColumn(label, 0); grid.Children.Add(label);
    }
}

internal sealed class InstanceListItem
{
    public string Id { get; set; }
    public string Name { get; set; }
    public string Status { get; set; }
    public string Text { get; set; }
    public override string ToString() { return Text; }
}

internal sealed class ReleaseUpdateInfo
{
    public string Version { get; set; }
    public string Url { get; set; }
}

internal static class DpiSupport
{
    private enum ProcessDpiAwareness { ProcessDpiUnaware = 0, ProcessSystemDpiAware = 1, ProcessPerMonitorDpiAware = 2 }
    [DllImport("Shcore.dll")] private static extern int SetProcessDpiAwareness(ProcessDpiAwareness awareness);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    internal static void Enable()
    {
        try { SetProcessDpiAwareness(ProcessDpiAwareness.ProcessPerMonitorDpiAware); return; } catch { }
        try { SetProcessDPIAware(); } catch { }
    }
}

internal sealed class NativeClient
{
    internal static readonly int ShowWindowMessage = RegisterWindowMessage("88FRP_SHOW_NATIVE_WINDOW");
    internal static readonly int ExitWindowMessage = RegisterWindowMessage("88FRP_EXIT_NATIVE_WINDOW");
    private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
    private readonly object backendLifecycleLock = new object();
    private Process backendProcess;

    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern int RegisterWindowMessage(string lpString);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    internal static void SignalExistingInstance()
    {
        PostMessage(new IntPtr(0xffff), ShowWindowMessage, IntPtr.Zero, IntPtr.Zero);
    }

    internal static void RegisterWindow(Window window)
    {
        // Window hook is registered in MainWindow.OnSourceInitialized.
    }

    public static string AppFile(string name)
    {
        return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, name);
    }

    public static SD.Icon LoadAppIcon()
    {
        string path = AppFile("88frp-logo.ico");
        if (File.Exists(path)) return new SD.Icon(path);
        return SD.SystemIcons.Application;
    }

    public static ImageSource LoadIconImage()
    {
        string path = AppFile("88frp-logo.ico");
        if (File.Exists(path)) return BitmapFrame.Create(new Uri(path));
        return null;
    }

    public static ImageSource LoadLogoImage()
    {
        string path = AppFile("88frp-logo.png");
        if (File.Exists(path)) return new BitmapImage(new Uri(path));
        return null;
    }

    public void StartBackend()
    {
        lock (backendLifecycleLock)
        {
            string backendPath = AppFile("88frp-web.exe");
            if (backendProcess != null && !backendProcess.HasExited) return;
            if (File.Exists(backendPath) && ShouldPreferLocalBackend(backendPath))
            {
                if (IsBackendHealthy() && IsBackendProcessRunning(backendPath)) return;
                if (IsBackendHealthy()) StopBackend(false);
                StartLocalBackend(backendPath);
                return;
            }
            if (IsBackendHealthy()) return;
            if (IsAutoStartEnabled())
            {
                RunHidden("schtasks.exe", "/Run /TN \"88FRP Backend\"");
                WaitForBackend();
                if (!IsBackendHealthy()) throw new InvalidOperationException("开机后台尚未就绪，请稍后重试或查看后台日志。");
                return;
            }
            if (!File.Exists(backendPath))
            {
                MessageBox.Show("没有找到后台核心文件：" + backendPath, Program.AppName, MessageBoxButton.OK, MessageBoxImage.Error);
                Environment.Exit(1);
            }
            StartLocalBackend(backendPath);
        }
    }

    private static bool ShouldPreferLocalBackend(string localPath)
    {
        string installedPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
            "88FRP",
            "88frp-web.exe");
        bool samePath = string.Equals(
            Path.GetFullPath(localPath),
            Path.GetFullPath(installedPath),
            StringComparison.OrdinalIgnoreCase);
        // Installed layout: keep the SYSTEM boot task authoritative so SSH/RDP
        // stay available before login. Portable or side-by-side newer core:
        // run that core directly and replace the stale installed core.
        if (samePath) return !IsAutoStartEnabled();
        if (!File.Exists(installedPath)) return true;
        return File.GetLastWriteTimeUtc(localPath) > File.GetLastWriteTimeUtc(installedPath).AddSeconds(2);
    }

    private static bool IsBackendProcessRunning(string path)
    {
        foreach (Process process in Process.GetProcessesByName("88frp-web"))
        {
            try
            {
                if (string.Equals(process.MainModule.FileName, path, StringComparison.OrdinalIgnoreCase)) return true;
            }
            catch
            {
                // SYSTEM-owned processes hide their path from a standard user.
            }
        }
        return false;
    }

    private void StartLocalBackend(string backendPath)
    {
        Thread.Sleep(500);
        ProcessStartInfo info = new ProcessStartInfo();
        info.FileName = backendPath;
        info.WorkingDirectory = Path.GetDirectoryName(backendPath);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.WindowStyle = ProcessWindowStyle.Hidden;
        info.EnvironmentVariables["HOST"] = Program.Host;
        info.EnvironmentVariables["PORT"] = Program.ConsolePort.ToString();
        info.EnvironmentVariables["APP_BASE_DIR"] = Program.AppDataDir;
        info.EnvironmentVariables["INSTANCE_AUTO_START_ON_BOOT"] = "1";
        backendProcess = Process.Start(info);
    }

    public void StopBackend(bool stopInstances = true)
    {
        lock (backendLifecycleLock)
        {
            bool gracefulRequested = false;
            try
            {
                if (IsBackendHealthy(1200))
                {
                    RequestBackendShutdown(stopInstances);
                    gracefulRequested = true;
                }
            }
            catch { }

            if (gracefulRequested)
            {
                DateTime deadline = DateTime.Now.AddSeconds(15);
                while (DateTime.Now < deadline && IsBackendHealthy(350)) Thread.Sleep(150);
            }

            try
            {
                if (backendProcess != null && !backendProcess.HasExited)
                {
                    backendProcess.Kill();
                    backendProcess.WaitForExit(2500);
                }
            }
            catch { }
            backendProcess = null;
        }
    }

    private void RequestBackendShutdown(bool stopInstances)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Program.BaseUrl + "/api/system/shutdown");
        request.Method = "POST";
        request.Timeout = 2500;
        request.ReadWriteTimeout = 2500;
        request.ContentType = "application/json; charset=utf-8";
        request.Headers["X-88FRP-Desktop"] = "1";
        byte[] body = Encoding.UTF8.GetBytes("{\"stopInstances\":" + (stopInstances ? "true" : "false") + "}");
        request.ContentLength = body.Length;
        using (Stream stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
        using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
        {
            if (response.StatusCode != HttpStatusCode.OK) throw new WebException("后台核心拒绝安全停止请求。");
        }
    }

    public void RestartBackend()
    {
        StopBackend(false);
        Thread.Sleep(700);
        StartBackend();
        WaitForBackend();
    }

    internal static void RunUninstall()
    {
        bool createdNew;
        using (Mutex mutex = new Mutex(true, "Global\\88FRP_Native_Client_Mutex", out createdNew))
        {
            if (!createdNew)
            {
                // 已有桌面实例在运行：请其安全退出（它内部会停止后台核心及其 FRPC 子进程）。
                PostMessage(new IntPtr(0xffff), ExitWindowMessage, IntPtr.Zero, IntPtr.Zero);
                DateTime deadline = DateTime.Now.AddSeconds(25);
                while (DateTime.Now < deadline)
                {
                    Thread.Sleep(200);
                    try
                    {
                        if (mutex.WaitOne(0)) break;
                    }
                    catch (AbandonedMutexException) { break; }
                }
            }

            // 移除自动启动项（Run 值 + 88FRP Background 计划任务）及遗留 88frp 计划任务。
            DisableAutoStart();
            RunHidden("schtasks.exe", "/Delete /TN \"88frp\" /F");

            // 兜底安全停止后台核心及其管理的 FRPC 子进程。
            SafeStopBackendForUninstall();
        }
    }

    private static void SafeStopBackendForUninstall()
    {
        try
        {
            Directory.CreateDirectory(Program.AppDataDir);
            Program.LoadConsolePort();
            NativeClient helper = new NativeClient();
            if (helper.IsBackendHealthy(1500))
            {
                helper.StopBackend(true);
            }
        }
        catch { }
    }

    public bool IsBackendHealthy(int timeoutMs = 900)
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Program.BaseUrl + "/api/health");
            request.Timeout = timeoutMs;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) return response.StatusCode == HttpStatusCode.OK;
        }
        catch { return false; }
    }

    public void WaitForBackend()
    {
        DateTime deadline = DateTime.Now.AddSeconds(12);
        while (DateTime.Now < deadline)
        {
            if (IsBackendHealthy()) return;
            Thread.Sleep(400);
        }
    }

    public object[] GetArray(string path) { return AsArray(Request("GET", path, null)); }
    public Dictionary<string, object> GetDict(string path, int timeoutMs) { return AsDict(Request("GET", path, null, timeoutMs)); }
    public Dictionary<string, object> GetDict(string path) { return AsDict(Request("GET", path, null)); }
    public Dictionary<string, object> PostDict(string path, Dictionary<string, object> payload) { return AsDict(Request("POST", path, payload, 12000)); }
    public Dictionary<string, object> PostDict(string path, Dictionary<string, object> payload, int timeoutMs) { return AsDict(Request("POST", path, payload, timeoutMs)); }
    public Dictionary<string, object> PutDict(string path, Dictionary<string, object> payload) { return AsDict(Request("PUT", path, payload)); }
    public Dictionary<string, object> PutDict(string path, Dictionary<string, object> payload, int timeoutMs) { return AsDict(Request("PUT", path, payload, timeoutMs)); }
    public Dictionary<string, object> DeleteDict(string path) { return AsDict(Request("DELETE", path, null)); }

    private object Request(string method, string path, Dictionary<string, object> payload, int timeoutMs = 12000)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Program.BaseUrl + path);
        request.Method = method;
        request.Timeout = timeoutMs;
        request.ReadWriteTimeout = timeoutMs;
        request.ContentType = "application/json";
        request.Headers["X-88FRP-Desktop"] = "1";
        if (payload != null)
        {
            byte[] body = Encoding.UTF8.GetBytes(serializer.Serialize(payload));
            request.ContentLength = body.Length;
            using (Stream stream = request.GetRequestStream()) stream.Write(body, 0, body.Length);
        }
        try
        {
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                return ReadEnvelope(reader.ReadToEnd());
            }
        }
        catch (WebException ex)
        {
            if (ex.Status == WebExceptionStatus.Timeout)
            {
                throw new Exception("操作超时，后台可能仍在处理。请稍后刷新状态，不要重复点击。");
            }
            string body = "";
            if (ex.Response != null)
            {
                using (StreamReader reader = new StreamReader(ex.Response.GetResponseStream(), Encoding.UTF8)) body = reader.ReadToEnd();
            }
            if (!string.IsNullOrEmpty(body)) return ReadEnvelope(body);
            throw new Exception(ex.Message);
        }
    }

    private object ReadEnvelope(string raw)
    {
        Dictionary<string, object> envelope = AsDict(serializer.DeserializeObject(raw));
        if (!GetBool(envelope, "success"))
        {
            string message = GetString(envelope, "message");
            if (message == "") message = "请求失败。";
            throw new Exception(message);
        }
        return envelope.ContainsKey("data") ? envelope["data"] : null;
    }

    public static Dictionary<string, object> AsDict(object value) { return value as Dictionary<string, object> ?? new Dictionary<string, object>(); }
    public static object[] AsArray(object value) { return value as object[] ?? new object[0]; }
    public static string GetString(Dictionary<string, object> dict, string key)
    {
        if (dict == null || !dict.ContainsKey(key) || dict[key] == null) return "";
        return Convert.ToString(dict[key]);
    }
    public static bool GetBool(Dictionary<string, object> dict, string key)
    {
        if (dict == null || !dict.ContainsKey(key) || dict[key] == null) return false;
        try { return Convert.ToBoolean(dict[key]); } catch { return false; }
    }
    public static int GetInt(Dictionary<string, object> dict, string key)
    {
        if (dict == null || !dict.ContainsKey(key) || dict[key] == null) return 0;
        try { return Convert.ToInt32(dict[key]); } catch { return 0; }
    }
    public static string GetNestedString(Dictionary<string, object> dict, string parent, string child)
    {
        if (dict == null || !dict.ContainsKey(parent)) return "";
        return GetString(AsDict(dict[parent]), child);
    }
    public static void OpenConsoleFallback()
    {
        OpenGatewayConsole();
    }
    public static void OpenGatewayConsole()
    {
        try { Process.Start(new ProcessStartInfo { FileName = Program.BaseUrl + "/gateway", UseShellExecute = true }); } catch { }
    }
    public static void OpenLegacyConsole()
    {
        try { Process.Start(new ProcessStartInfo { FileName = Program.BaseUrl + "/legacy", UseShellExecute = true }); } catch { }
    }
    private static void ConfigureStartup(string mode)
    {
        string script = AppFile("configure-startup.ps1");
        if (!File.Exists(script)) throw new FileNotFoundException("缺少自启动配置组件，请重新安装。", script);
        var info = new ProcessStartInfo {
            FileName = "powershell.exe",
            Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\" -Mode " + mode + " -AppDir \"" + AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\') + "\" -DataRoot \"" + Program.AppDataDir + "\" -UserSid \"" + System.Security.Principal.WindowsIdentity.GetCurrent().User.Value + "\"",
            UseShellExecute = true, Verb = new System.Security.Principal.WindowsPrincipal(System.Security.Principal.WindowsIdentity.GetCurrent()).IsInRole(System.Security.Principal.WindowsBuiltInRole.Administrator) ? "" : "runas", WindowStyle = ProcessWindowStyle.Hidden
        };
        NativeClient helper = new NativeClient();
        if (mode == "Enable") helper.StopBackend(false);
        try {
            using (Process process = Process.Start(info)) {
                process.WaitForExit();
                if (process.ExitCode != 0) throw new InvalidOperationException("自启动配置失败，原有数据已保留。请查看数据目录中的 startup-config.log。");
            }
        } finally { if (mode == "Enable" && !helper.IsBackendHealthy()) helper.StartBackend(); }
    }
    public static void EnableAutoStart() { ConfigureStartup("Enable"); }
    public static void DisableAutoStart()
    {
        ConfigureStartup("Disable");
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true))
            if (key != null) key.DeleteValue(Program.AppName, false);
    }
    public static bool IsAutoStartEnabled()
    {
        // Query the actual task state; a stale registry value is not evidence of boot startup.
        try {
            var service = Activator.CreateInstance(Type.GetTypeFromProgID("Schedule.Service"));
            dynamic scheduler = service;
            scheduler.Connect();
            return scheduler.GetFolder("\\").GetTask("88FRP Backend").Enabled;
        } catch { return false; }
    }

    public static void RunBackendHost()
    {
        try {
            var info = new ProcessStartInfo { FileName = AppFile("88frp-web.exe"), WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory,
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
            info.EnvironmentVariables["HOST"] = Program.Host;
            info.EnvironmentVariables["PORT"] = Program.ConsolePort.ToString();
            info.EnvironmentVariables["APP_BASE_DIR"] = Program.AppDataDir;
            info.EnvironmentVariables["INSTANCE_AUTO_START_ON_BOOT"] = "1";
            using (Process backend = Process.Start(info)) { backend.WaitForExit(); Environment.ExitCode = backend.ExitCode; }
        } catch (Exception ex) {
            File.AppendAllText(Path.Combine(Program.AppDataDir, "backend-host.log"), DateTime.Now.ToString("s") + " " + ex.Message + Environment.NewLine);
            Environment.ExitCode = 1;
        }
    }
    public static bool IsTcpPortAvailable(int port)
    {
        try
        {
            foreach (IPEndPoint endpoint in IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners())
            {
                if (endpoint.Port == port) return false;
            }
            return true;
        }
        catch { return false; }
    }
    private static void RunHidden(string fileName, string args)
    {
        try
        {
            ProcessStartInfo info = new ProcessStartInfo { FileName = fileName, Arguments = args, UseShellExecute = false, CreateNoWindow = true };
            using (Process process = Process.Start(info)) process.WaitForExit(3000);
        }
        catch { }
    }
}
