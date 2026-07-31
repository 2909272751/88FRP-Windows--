using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
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
[assembly: AssemblyVersion("3.0.0.0")]
[assembly: AssemblyFileVersion("3.0.0.0")]

internal static class Program
{
    internal const string AppName = "88FRP";
    internal const string AppVersion = "3.0.0";
    internal const string Host = "127.0.0.1";
    internal const int Port = 8801;
    internal static readonly string BaseUrl = "http://" + Host + ":" + Port;
    internal static readonly string AppDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "88frp-node");
    internal static readonly string FirstRunPath = Path.Combine(AppDataDir, "native-client-first-run.flag");
    internal static readonly string UpdateStatePath = Path.Combine(AppDataDir, "native-client-update-state.json");

    [STAThread]
    private static void Main(string[] args)
    {
        DpiSupport.Enable();
        bool backgroundStart = HasArg(args, "--background");
        bool createdNew;
        Mutex mutex = new Mutex(true, "Global\\88FRP_Native_Client_Mutex", out createdNew);
        if (!createdNew)
        {
            if (!backgroundStart) NativeClient.SignalExistingInstance();
            return;
        }

        Directory.CreateDirectory(AppDataDir);
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

internal sealed class MainWindow : Window
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
    private readonly TextBox logsBox = new TextBox();
    private readonly DispatcherTimer pollTimer = new DispatcherTimer();
    private readonly DispatcherTimer watchdogTimer = new DispatcherTimer();
    private readonly DispatcherTimer updateTimer = new DispatcherTimer();
    private readonly List<Dictionary<string, object>> tunnels = new List<Dictionary<string, object>>();
    private readonly Dictionary<string, CheckBox> tunnelChecks = new Dictionary<string, CheckBox>();
    private readonly Dictionary<string, TextBox> tunnelGroupInputs = new Dictionary<string, TextBox>();
    private readonly HashSet<string> collapsedTunnelGroups = new HashSet<string>(StringComparer.Ordinal);
    private readonly WF.NotifyIcon trayIcon = new WF.NotifyIcon();
    private string currentInstanceId = "";
    private bool exiting;
    private Button autoStartButton;
    private Button syncButton;
    private Button frpAccountButton;
    private Button frpNameSyncButton;
    private Button consoleSecurityButton;
    private Button accessCenterButton;
    private Button managementHubButton;
    private Button checkUpdateButton;
    private Button openUpdateButton;
    private Border managementOverlay;
    private TextBlock frpAccountStatus = new TextBlock();
    private TextBlock accessCenterStatus = new TextBlock();
    private TextBlock updateStatus = new TextBlock();
    private int watchdogFailureCount;
    private int watchdogCheckRunning;
    private bool longOperationRunning;
    private int updateCheckRunning;
    private string lastNotifiedUpdateVersion = "";
    private string availableUpdateUrl = "";
    private static readonly string CollapsedTunnelGroupsPath = Path.Combine(Program.AppDataDir, "native-client-collapsed-tunnel-groups.json");

    private static readonly Brush SidebarBrush = new SolidColorBrush(Color.FromRgb(20, 31, 48));
    private static readonly Brush AppBrush = new SolidColorBrush(Color.FromRgb(246, 248, 251));
    private static readonly Brush CardBrush = Brushes.White;
    private static readonly Brush TextBrush = new SolidColorBrush(Color.FromRgb(15, 23, 42));
    private static readonly Brush MutedBrush = new SolidColorBrush(Color.FromRgb(100, 116, 139));
    private static readonly Brush AccentBrush = new SolidColorBrush(Color.FromRgb(37, 99, 235));
    private static readonly Brush AccentGreenBrush = new SolidColorBrush(Color.FromRgb(20, 184, 166));
    private static readonly Brush DangerBrush = new SolidColorBrush(Color.FromRgb(220, 38, 38));
    private static readonly Brush UiBorderBrush = new SolidColorBrush(Color.FromRgb(226, 232, 240));

    public MainWindow(bool backgroundStart)
    {
        this.backgroundStart = backgroundStart;
        Title = "88FRP v3.0.0";
        Width = 1220;
        Height = 780;
        MinWidth = 1040;
        MinHeight = 660;
        WindowStartupLocation = WindowStartupLocation.CenterScreen;
        Background = AppBrush;
        FontFamily = new FontFamily("Microsoft YaHei UI");
        FontSize = 14;
        Icon = NativeClient.LoadIconImage();
        TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
        TextOptions.SetTextRenderingMode(this, TextRenderingMode.ClearType);
        LoadCollapsedTunnelGroups();
        LoadUpdateState();

        Content = BuildRoot();
        BuildTray();

        Loaded += async delegate
        {
            NativeClient.RegisterWindow(this);
            Safe(delegate
            {
                client.StartBackend();
                client.WaitForBackend();
                RunFirstLaunchGuide();
                RefreshAll();
                pollTimer.Start();
                watchdogTimer.Start();
                updateTimer.Start();
                if (backgroundStart) HideToTray();
            });
            await CheckForUpdatesAsync(false);
        };
        Closing += OnClosing;

        pollTimer.Interval = TimeSpan.FromSeconds(4);
        pollTimer.Tick += delegate { SafeSilent(delegate { RefreshInstances(true); }); };
        watchdogTimer.Interval = TimeSpan.FromSeconds(10);
        watchdogTimer.Tick += delegate { CheckBackendWatchdog(); };
        updateTimer.Interval = TimeSpan.FromHours(6);
        updateTimer.Tick += async delegate { await CheckForUpdatesAsync(false); };
    }

    private UIElement BuildRoot()
    {
        Grid root = new Grid();
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(286) });
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        Border sidebar = new Border { Background = SidebarBrush, Padding = new Thickness(22, 26, 20, 22) };
        Grid.SetColumn(sidebar, 0);
        root.Children.Add(sidebar);

        DockPanel sideDock = new DockPanel { LastChildFill = true };
        sidebar.Child = sideDock;

        StackPanel brand = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 0, 0, 24) };
        DockPanel.SetDock(brand, Dock.Top);
        sideDock.Children.Add(brand);
        brand.Children.Add(new Image { Source = NativeClient.LoadLogoImage(), Width = 58, Height = 58, Stretch = Stretch.UniformToFill });
        StackPanel brandText = new StackPanel { Margin = new Thickness(14, 4, 0, 0) };
        brand.Children.Add(brandText);
        brandText.Children.Add(new TextBlock { Text = "88FRP", Foreground = Brushes.White, FontSize = 26, FontWeight = FontWeights.Bold });
        brandText.Children.Add(new TextBlock { Text = "Windows 隧道管理器 · v3.0.0", Foreground = new SolidColorBrush(Color.FromRgb(174, 190, 214)), FontSize = 13, Margin = new Thickness(0, 2, 0, 0) });

        Button create = PrimaryButton("+  新建实例", AccentGreenBrush);
        create.Height = 42;
        create.Margin = new Thickness(0, 0, 0, 22);
        create.Click += delegate { Safe(CreateInstance); };
        DockPanel.SetDock(create, Dock.Top);
        sideDock.Children.Add(create);

        TextBlock settingsTitle = SidebarSectionLabel("设置", new Thickness(0, 0, 0, 8));
        DockPanel.SetDock(settingsTitle, Dock.Top);
        sideDock.Children.Add(settingsTitle);
        managementHubButton = SidebarNavButton("全局设置", "");
        managementHubButton.Click += delegate { ShowManagementDrawer(); };
        DockPanel.SetDock(managementHubButton, Dock.Top);
        sideDock.Children.Add(managementHubButton);

        TextBlock listTitle = SidebarSectionLabel("实例", new Thickness(0, 0, 0, 8));
        DockPanel.SetDock(listTitle, Dock.Top);
        sideDock.Children.Add(listTitle);

        instanceList.Background = SidebarBrush;
        instanceList.BorderThickness = new Thickness(0);
        instanceList.Foreground = Brushes.White;
        instanceList.FontSize = 15;
        instanceList.HorizontalContentAlignment = HorizontalAlignment.Stretch;
        instanceList.ItemTemplate = BuildInstanceItemTemplate();
        instanceList.SelectionChanged += delegate { Safe(SelectCurrentInstance); };
        sideDock.Children.Add(instanceList);

        Grid main = new Grid { Margin = new Thickness(30, 28, 30, 30) };
        Grid.SetColumn(main, 1);
        root.Children.Add(main);
        main.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        main.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        main.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        main.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        main.Children.Add(BuildHeader());
        UIElement cards = BuildStatusCards();
        Grid.SetRow(cards, 1);
        main.Children.Add(cards);
        UIElement settings = BuildSettingsBar();
        Grid.SetRow(settings, 2);
        main.Children.Add(settings);
        UIElement tabs = BuildTabs();
        Grid.SetRow(tabs, 3);
        main.Children.Add(tabs);
        root.Children.Add(BuildManagementOverlay());
        return root;
    }

    private UIElement BuildHeader()
    {
        Grid header = new Grid { Margin = new Thickness(0, 0, 0, 20) };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        StackPanel title = new StackPanel();
        title.Children.Add(new TextBlock { Text = "控制台", Foreground = TextBrush, FontSize = 32, FontWeight = FontWeights.Bold });
        title.Children.Add(new TextBlock { Text = "只运行你选择的隧道，同步后也会记住选择。", Foreground = MutedBrush, FontSize = 15, Margin = new Thickness(2, 4, 0, 0) });
        header.Children.Add(title);

        StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Top };
        Grid.SetColumn(actions, 1);
        header.Children.Add(actions);
        Button start = PrimaryButton("启动", new SolidColorBrush(Color.FromRgb(22, 163, 74)));
        Button stop = OutlineButton("停止", new SolidColorBrush(Color.FromRgb(185, 28, 28)));
        Button restart = PrimaryButton("重启", new SolidColorBrush(Color.FromRgb(79, 70, 229)));
        start.Click += delegate { Safe(delegate { RuntimeAction("start"); }); };
        stop.Click += delegate { Safe(delegate { RuntimeAction("stop"); }); };
        restart.Click += delegate { Safe(delegate { RuntimeAction("restart"); }); };
        actions.Children.Add(start);
        actions.Children.Add(stop);
        actions.Children.Add(restart);
        return header;
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
        AddStatusCard(grid, 1, "进程 PID", pidValue, AccentBrush);
        AddStatusCard(grid, 2, "后台核心", backendValue, new SolidColorBrush(Color.FromRgb(245, 158, 11)));
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
        row.Children.Add(new TextBlock { Text = title, Foreground = MutedBrush, FontSize = 14 });
        panel.Children.Add(row);
        value.Foreground = TextBrush;
        value.FontSize = 27;
        value.FontWeight = FontWeights.Bold;
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
        DockPanel panel = new DockPanel { Margin = new Thickness(18, 12, 18, 12), LastChildFill = false };
        card.Child = panel;
        panel.Children.Add(new TextBlock { Text = "同步设置", Foreground = TextBrush, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 18, 0) });
        panel.Children.Add(new TextBlock { Text = "密钥", Foreground = MutedBrush, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 10, 0) });
        secretBox.Width = 260;
        secretBox.Height = 32;
        secretBox.FontSize = 15;
        secretBox.VerticalContentAlignment = VerticalAlignment.Center;
        panel.Children.Add(secretBox);
        autoSyncBox.Content = "自动同步";
        autoSyncBox.Margin = new Thickness(18, 0, 18, 0);
        autoSyncBox.VerticalAlignment = VerticalAlignment.Center;
        panel.Children.Add(autoSyncBox);
        syncButton = PrimaryButton("同步配置", AccentBrush);
        syncButton.Click += async delegate { await SyncCurrentAsync(); };
        panel.Children.Add(syncButton);
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
            Width = 356,
            Background = Brushes.White,
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(0, 0, 1, 0),
            HorizontalAlignment = HorizontalAlignment.Left,
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
        heading.Children.Add(new TextBlock { Text = "管理与设置", Foreground = TextBrush, FontSize = 22, FontWeight = FontWeights.Bold });
        heading.Children.Add(new TextBlock { Text = "账号、安全与后台运行", Foreground = MutedBrush, Margin = new Thickness(0, 4, 0, 0) });
        header.Children.Add(heading);
        Button close = OutlineButton("关闭", AccentBrush);
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

        content.Children.Add(DrawerSectionLabel("访问中心"));
        accessCenterButton = DrawerActionButton("配置访问中心");
        accessCenterButton.Click += async delegate { await ManageAccessCenterAsync(); };
        content.Children.Add(accessCenterButton);
        accessCenterStatus.Foreground = MutedBrush;
        accessCenterStatus.FontSize = 12;
        accessCenterStatus.TextWrapping = TextWrapping.Wrap;
        accessCenterStatus.TextTrimming = TextTrimming.None;
        accessCenterStatus.ToolTip = "独立 FRP 访问中心：只展示已同步的隧道名称和地址。";
        accessCenterStatus.Margin = new Thickness(12, 5, 12, 10);
        content.Children.Add(accessCenterStatus);

        content.Children.Add(DrawerSectionLabel("88FRP 账号"));
        Grid accountActions = new Grid();
        accountActions.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        accountActions.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        frpAccountButton = DrawerActionButton("连接 88FRP 账号");
        frpAccountButton.Click += async delegate { await ManageFrpAccountAsync(); };
        accountActions.Children.Add(frpAccountButton);
        frpNameSyncButton = DrawerCompactActionButton("同步名称");
        frpNameSyncButton.Visibility = Visibility.Collapsed;
        frpNameSyncButton.Click += async delegate { await RefreshFrpTunnelNamesAsync(); };
        Grid.SetColumn(frpNameSyncButton, 1);
        accountActions.Children.Add(frpNameSyncButton);
        content.Children.Add(accountActions);
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

        content.Children.Add(DrawerSectionLabel("软件更新"));
        Grid updateActions = new Grid();
        updateActions.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        updateActions.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        checkUpdateButton = DrawerActionButton("检查更新");
        checkUpdateButton.Click += async delegate { await CheckForUpdatesAsync(true); };
        updateActions.Children.Add(checkUpdateButton);
        openUpdateButton = DrawerCompactActionButton("打开下载页");
        openUpdateButton.Visibility = Visibility.Collapsed;
        openUpdateButton.Click += delegate { OpenAvailableUpdate(); };
        Grid.SetColumn(openUpdateButton, 1);
        updateActions.Children.Add(openUpdateButton);
        content.Children.Add(updateActions);
        updateStatus.Foreground = MutedBrush;
        updateStatus.FontSize = 12;
        updateStatus.Text = "自动检测已开启：发现新版本会在后台通知。";
        updateStatus.TextWrapping = TextWrapping.Wrap;
        updateStatus.TextTrimming = TextTrimming.None;
        updateStatus.Margin = new Thickness(12, 5, 12, 10);
        content.Children.Add(updateStatus);

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
        return managementOverlay;
    }

    private void ShowManagementDrawer()
    {
        if (managementOverlay == null) return;
        RefreshFrpAccountStatus();
        managementOverlay.Visibility = Visibility.Visible;
    }

    private void CloseManagementDrawer()
    {
        if (managementOverlay != null) managementOverlay.Visibility = Visibility.Collapsed;
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
        TabControl tabs = new TabControl { FontSize = 15 };
        tabs.Items.Add(BuildConfigTab());
        tabs.Items.Add(BuildTunnelTab());
        tabs.Items.Add(BuildLogsTab());
        return tabs;
    }

    private TabItem BuildConfigTab()
    {
        TabItem tab = new TabItem { Header = "配置文件" };
        DockPanel dock = new DockPanel { Background = Brushes.White };
        Button save = PrimaryButton("保存配置", AccentBrush);
        save.Height = 44;
        save.Margin = new Thickness(0);
        save.Click += delegate { Safe(SaveConfig); };
        DockPanel.SetDock(save, Dock.Bottom);
        dock.Children.Add(save);
        configBox.FontFamily = new FontFamily("Consolas");
        configBox.FontSize = 15;
        configBox.AcceptsReturn = true;
        configBox.AcceptsTab = true;
        configBox.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        configBox.HorizontalScrollBarVisibility = ScrollBarVisibility.Auto;
        configBox.TextWrapping = TextWrapping.Wrap;
        configBox.Padding = new Thickness(12);
        configBox.BorderThickness = new Thickness(0);
        dock.Children.Add(configBox);
        tab.Content = dock;
        return tab;
    }

    private TabItem BuildTunnelTab()
    {
        TabItem tab = new TabItem { Header = "隧道选择" };
        DockPanel dock = new DockPanel { Background = Brushes.White };
        TextBlock hint = new TextBlock
        {
            Text = "勾选要运行的隧道；未勾选的会保留配置但不会启动。新同步隧道默认关闭。",
            Foreground = MutedBrush,
            Margin = new Thickness(14, 12, 14, 10)
        };
        DockPanel.SetDock(hint, Dock.Top);
        dock.Children.Add(hint);
        Button save = PrimaryButton("保存隧道选择", AccentBrush);
        save.Height = 44;
        save.Margin = new Thickness(0);
        save.Click += delegate { Safe(SaveTunnels); };
        DockPanel.SetDock(save, Dock.Bottom);
        dock.Children.Add(save);
        ScrollViewer scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        tunnelPanel.Margin = new Thickness(14, 0, 14, 14);
        scroll.Content = tunnelPanel;
        dock.Children.Add(scroll);
        tab.Content = dock;
        return tab;
    }

    private TabItem BuildLogsTab()
    {
        TabItem tab = new TabItem { Header = "运行日志" };
        DockPanel dock = new DockPanel { Background = new SolidColorBrush(Color.FromRgb(15, 23, 42)) };
        Button refresh = PrimaryButton("刷新日志", AccentBrush);
        refresh.Height = 44;
        refresh.Margin = new Thickness(0);
        refresh.Click += delegate { Safe(LoadLogs); };
        DockPanel.SetDock(refresh, Dock.Bottom);
        dock.Children.Add(refresh);
        logsBox.FontFamily = new FontFamily("Consolas");
        logsBox.FontSize = 14;
        logsBox.AcceptsReturn = true;
        logsBox.IsReadOnly = true;
        logsBox.TextWrapping = TextWrapping.Wrap;
        logsBox.VerticalScrollBarVisibility = ScrollBarVisibility.Auto;
        logsBox.HorizontalScrollBarVisibility = ScrollBarVisibility.Auto;
        logsBox.Background = new SolidColorBrush(Color.FromRgb(15, 23, 42));
        logsBox.Foreground = new SolidColorBrush(Color.FromRgb(226, 232, 240));
        logsBox.BorderThickness = new Thickness(0);
        logsBox.Padding = new Thickness(14);
        dock.Children.Add(logsBox);
        tab.Content = dock;
        return tab;
    }

    private Border Card()
    {
        return new Border
        {
            Background = CardBrush,
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(4)
        };
    }

    private Button PrimaryButton(string text, Brush background)
    {
        Button button = new Button
        {
            Content = text,
            Height = 34,
            MinWidth = 104,
            Margin = new Thickness(8, 0, 0, 0),
            Padding = new Thickness(16, 0, 16, 0),
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
        Button button = PrimaryButton(text, Brushes.White);
        button.Foreground = foreground;
        button.BorderBrush = UiBorderBrush;
        return button;
    }

    private TextBlock SidebarSectionLabel(string text, Thickness margin)
    {
        return new TextBlock
        {
            Text = text,
            Foreground = new SolidColorBrush(Color.FromRgb(203, 213, 225)),
            FontWeight = FontWeights.SemiBold,
            FontSize = 12,
            Margin = margin
        };
    }

    private Button SidebarNavButton(string title, string description)
    {
        bool hasDescription = !string.IsNullOrWhiteSpace(description);
        StackPanel content = new StackPanel { Margin = new Thickness(12, hasDescription ? 8 : 0, 12, hasDescription ? 8 : 0), VerticalAlignment = VerticalAlignment.Center };
        content.Children.Add(new TextBlock { Text = title, Foreground = Brushes.White, FontWeight = FontWeights.SemiBold, FontSize = 14 });
        if (hasDescription) content.Children.Add(new TextBlock
        {
            Text = description,
            Foreground = new SolidColorBrush(Color.FromRgb(174, 190, 214)),
            FontSize = 11,
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
            Background = new SolidColorBrush(Color.FromRgb(29, 45, 68)),
            Foreground = Brushes.White,
            BorderBrush = new SolidColorBrush(Color.FromRgb(49, 65, 89)),
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
            Background = new SolidColorBrush(Color.FromRgb(248, 250, 252)),
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
            Background = Brushes.White,
            Foreground = AccentBrush,
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
        menuButton.SetValue(Control.ForegroundProperty, Brushes.White);
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
        menu.Items.Add("打开网页控制台", null, delegate { NativeClient.OpenConsoleFallback(); });
        menu.Items.Add("重启后台", null, delegate { Safe(delegate { client.RestartBackend(); RefreshAll(); }); });
        menu.Items.Add(new WF.ToolStripSeparator());
        menu.Items.Add("退出", null, delegate { exiting = true; trayIcon.Visible = false; client.StopBackend(); Close(); });
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
            if (string.Equals(state, "declined", StringComparison.OrdinalIgnoreCase)) return;
        }
        MessageBoxResult result = MessageBox.Show(
            "是否开启开机自启动并保持后台运行？\n\n开启后，登录 Windows 后会自动启动 88FRP，并恢复之前启用的实例和已选择隧道。",
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
        backendValue.Text = client.IsBackendHealthy() ? "正常" : "离线";
        RefreshFrpAccountStatus();
        RefreshAccessCenterStatus();
        RefreshInstances(true);
        if (!string.IsNullOrEmpty(currentInstanceId)) LoadCurrentDetails();
    }

    private void RefreshInstances(bool keepSelection)
    {
        object[] rows = client.GetArray("/api/instances");
        string selectedId = keepSelection ? currentInstanceId : "";
        instanceList.Items.Clear();
        foreach (object row in rows)
        {
            Dictionary<string, object> item = NativeClient.AsDict(row);
            string id = NativeClient.GetString(item, "id");
            string name = NativeClient.GetString(item, "name");
            string status = NativeClient.GetNestedString(item, "runtime", "status");
            InstanceListItem listItem = new InstanceListItem { Id = id, Name = name, Status = status, Text = name + "  ·  " + TranslateStatus(status) };
            instanceList.Items.Add(listItem);
            if (id == selectedId) instanceList.SelectedItem = listItem;
        }
        if (instanceList.SelectedIndex < 0 && instanceList.Items.Count > 0) instanceList.SelectedIndex = 0;
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
                CornerRadius = new CornerRadius(5),
                Background = new SolidColorBrush(Color.FromRgb(250, 252, 255)),
                Margin = new Thickness(0, 0, 0, 10)
            };
            StackPanel groupPanel = new StackPanel();
            groupCard.Child = groupPanel;
            DockPanel groupHeader = new DockPanel
            {
                Background = new SolidColorBrush(Color.FromRgb(241, 245, 249)),
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
                string title = displayName == "" ? tunnelName : displayName + "  ·  " + tunnelName;
                Grid row = new Grid { Margin = new Thickness(10, 2, 10, 6) };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(170) });
                CheckBox check = new CheckBox
                {
                    IsChecked = NativeClient.GetBool(tunnel, "enabled"),
                    Padding = new Thickness(4),
                    FontSize = 14,
                    Content = title + "    " + NativeClient.GetString(tunnel, "type") + "    本地 " + NativeClient.GetString(tunnel, "localPort") + "  →  远程 " + NativeClient.GetString(tunnel, "remotePort")
                };
                check.Checked += delegate { if (!updatingGroup) refreshGroupToggle(); };
                check.Unchecked += delegate { if (!updatingGroup) refreshGroupToggle(); };
                Grid.SetColumn(check, 0);
                row.Children.Add(check);
                tunnelChecks[tunnelName] = check;
                groupChecks.Add(check);

                StackPanel groupEditor = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
                groupEditor.Children.Add(new TextBlock { Text = "分组", Foreground = MutedBrush, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 7, 0) });
                TextBox groupInput = new TextBox
                {
                    Height = 29,
                    Width = 132,
                    Text = NativeClient.GetString(tunnel, "groupOverride"),
                    ToolTip = "留空会继续自动归入“" + group + "”。"
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
        if (frpNameSyncButton != null) frpNameSyncButton.Visibility = connected ? Visibility.Visible : Visibility.Collapsed;
        frpAccountStatus.Text = connected ? (username + (autoLogin ? " · 自动登录" : " · 需手动登录")) : "未连接";
    }

    private async Task RefreshFrpTunnelNamesAsync()
    {
        if (frpNameSyncButton == null || !frpNameSyncButton.IsEnabled) return;
        frpNameSyncButton.IsEnabled = false;
        frpNameSyncButton.Content = "同步中…";
        try
        {
            await Task.Run(delegate
            {
                client.PostDict("/api/88frp/account/refresh-labels", new Dictionary<string, object>(), 90000);
            });
            RefreshFrpAccountStatus();
            LoadTunnels();
            frpAccountStatus.Text = frpAccountStatus.Text + "  ·  名称已同步";
        }
        catch (Exception ex)
        {
            frpAccountStatus.Text = "名称同步失败：" + FriendlyError(ex);
            frpAccountStatus.ToolTip = FriendlyError(ex);
        }
        finally
        {
            frpNameSyncButton.Content = "同步名称";
            frpNameSyncButton.IsEnabled = true;
        }
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
            backendValue.Text = "错误";
            MessageBox.Show(FriendlyError(ex), Program.AppName, MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void RefreshAccessCenterStatus()
    {
        if (accessCenterButton == null) return;
        Dictionary<string, object> status = client.GetDict("/api/access-center");
        bool configured = NativeClient.GetBool(status, "configured");
        bool enabled = NativeClient.GetBool(status, "enabled");
        string runtimeStatus = NativeClient.GetNestedString(status, "runtime", "status");
        string publicUrl = NativeClient.GetString(status, "publicUrl");
        string lastError = NativeClient.GetNestedString(status, "runtime", "lastError");
        accessCenterButton.Content = configured ? "管理访问中心" : "配置访问中心";
        if (!configured)
        {
            accessCenterStatus.Text = "未配置固定访问地址";
            accessCenterStatus.ToolTip = "独立 FRP 访问中心：只展示已同步的隧道名称和地址。";
        }
        else if (!enabled)
        {
            accessCenterStatus.Text = "已配置，当前已停止";
            accessCenterStatus.ToolTip = publicUrl;
        }
        else if (runtimeStatus == "running")
        {
            accessCenterStatus.Text = publicUrl + "  ·  公开只读";
            accessCenterStatus.ToolTip = publicUrl + "\n访问中心不设密码，知道地址的人可以查看和打开隧道链接。";
        }
        else
        {
            accessCenterStatus.Text = lastError == "" ? "连接中…" : "访问中心异常";
            accessCenterStatus.ToolTip = lastError == "" ? "访问中心正在连接。" : lastError;
        }
    }

    private async Task ManageAccessCenterAsync()
    {
        try
        {
            Dictionary<string, object> status = client.GetDict("/api/access-center");
            AccessCenterWindow dialog = new AccessCenterWindow(status) { Owner = this };
            if (dialog.ShowDialog() != true) return;

            if (dialog.DisableRequested)
            {
                client.DeleteDict("/api/access-center");
                RefreshAccessCenterStatus();
                MessageBox.Show("访问中心已停止。连接信息仍会加密保留，之后可随时重新启用。", Program.AppName, MessageBoxButton.OK, MessageBoxImage.Information);
                return;
            }

            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["name"] = dialog.CenterName;
            payload["serverAddr"] = dialog.ServerAddress;
            payload["serverPort"] = dialog.ServerPort;
            payload["remotePort"] = dialog.RemotePort;
            payload["localPort"] = dialog.LocalPort;
            payload["frpToken"] = dialog.FrpToken;
            payload["enabled"] = true;
            bool completed = await RunLongOperationAsync("连接访问中心", delegate
            {
                client.PutDict("/api/access-center", payload, 30000);
            });
            if (!completed) return;
            RefreshAccessCenterStatus();
            Dictionary<string, object> updated = client.GetDict("/api/access-center");
            string publicUrl = NativeClient.GetString(updated, "publicUrl");
            string runtimeStatus = NativeClient.GetNestedString(updated, "runtime", "status");
            if (runtimeStatus == "running")
            {
                string accessNotice = "当前为公开只读模式。知道地址的人可以查看和打开链接，但不能从公网修改链接设置。";
                MessageBox.Show("访问中心已启动。\n\n固定地址：\n" + publicUrl + "\n\n" + accessNotice, Program.AppName, MessageBoxButton.OK, MessageBoxImage.Information);
            }
            else
            {
                MessageBox.Show("配置已保存，但访问中心尚未正常运行。\n\n" + NativeClient.GetNestedString(updated, "runtime", "lastError"), Program.AppName, MessageBoxButton.OK, MessageBoxImage.Warning);
            }
        }
        catch (Exception ex)
        {
            backendValue.Text = "错误";
            MessageBox.Show(FriendlyError(ex), Program.AppName, MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private async Task<bool> RunLongOperationAsync(string statusText, Action operation)
    {
        if (longOperationRunning) return false;
        longOperationRunning = true;
        if (syncButton != null) syncButton.IsEnabled = false;
        if (frpAccountButton != null) frpAccountButton.IsEnabled = false;
        if (accessCenterButton != null) accessCenterButton.IsEnabled = false;
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
            if (accessCenterButton != null) accessCenterButton.IsEnabled = true;
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
            backendValue.Text = "错误";
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
        FontFamily = new FontFamily("Microsoft YaHei UI");
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
        FontFamily = new FontFamily("Microsoft YaHei UI");
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

internal sealed class AccessCenterWindow : Window
{
    private readonly TextBox nameBox = new TextBox();
    private readonly TextBox serverAddressBox = new TextBox();
    private readonly TextBox serverPortBox = new TextBox();
    private readonly TextBox remotePortBox = new TextBox();
    private readonly TextBox localPortBox = new TextBox();
    private readonly PasswordBox frpTokenBox = new PasswordBox();
    private readonly CheckBox enabledBox = new CheckBox { Content = "启动独立访问中心", IsChecked = true };
    private readonly bool configured;

    public string CenterName { get { return nameBox.Text.Trim(); } }
    public string ServerAddress { get { return serverAddressBox.Text.Trim(); } }
    public string ServerPort { get { return serverPortBox.Text.Trim(); } }
    public string RemotePort { get { return remotePortBox.Text.Trim(); } }
    public string LocalPort { get { return localPortBox.Text.Trim(); } }
    public string FrpToken { get { return frpTokenBox.Password; } }
    public bool DisableRequested { get { return configured && enabledBox.IsChecked != true; } }

    public AccessCenterWindow(Dictionary<string, object> status)
    {
        configured = NativeClient.GetBool(status, "configured");
        Title = configured ? "管理访问中心" : "配置访问中心";
        Width = 540;
        Height = 670;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.NoResize;
        FontFamily = new FontFamily("Microsoft YaHei UI");
        Icon = NativeClient.LoadIconImage();

        Grid grid = new Grid { Margin = new Thickness(22) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(92) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        for (int index = 0; index < 11; index += 1) grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        Content = grid;

        AddLabel(grid, "名称", 0);
        nameBox.Height = 31;
        nameBox.Text = NativeClient.GetString(status, "name");
        Grid.SetRow(nameBox, 0); Grid.SetColumn(nameBox, 1); grid.Children.Add(nameBox);

        AddLabel(grid, "服务地址", 1);
        serverAddressBox.Height = 31;
        serverAddressBox.Margin = new Thickness(0, 12, 0, 0);
        serverAddressBox.Text = NativeClient.GetString(status, "serverAddr");
        serverAddressBox.ToolTip = "仅填写域名或 IP，不包含 http:// 和端口。";
        Grid.SetRow(serverAddressBox, 1); Grid.SetColumn(serverAddressBox, 1); grid.Children.Add(serverAddressBox);

        AddLabel(grid, "服务端口", 2);
        serverPortBox.Height = 31;
        serverPortBox.Margin = new Thickness(0, 12, 0, 0);
        serverPortBox.Text = NativeClient.GetString(status, "serverPort");
        Grid.SetRow(serverPortBox, 2); Grid.SetColumn(serverPortBox, 1); grid.Children.Add(serverPortBox);

        AddLabel(grid, "公网端口", 3);
        remotePortBox.Height = 31;
        remotePortBox.Margin = new Thickness(0, 12, 0, 0);
        remotePortBox.Text = NativeClient.GetString(status, "remotePort");
        remotePortBox.ToolTip = "FRP 服务端允许映射的公网端口。";
        Grid.SetRow(remotePortBox, 3); Grid.SetColumn(remotePortBox, 1); grid.Children.Add(remotePortBox);

        AddLabel(grid, "本地端口", 4);
        localPortBox.Height = 31;
        localPortBox.Margin = new Thickness(0, 12, 0, 0);
        localPortBox.Text = NativeClient.GetString(status, "localPort");
        if (localPortBox.Text == "") localPortBox.Text = "8802";
        localPortBox.ToolTip = "访问中心仅在本机 127.0.0.1 监听。";
        Grid.SetRow(localPortBox, 4); Grid.SetColumn(localPortBox, 1); grid.Children.Add(localPortBox);

        AddLabel(grid, "FRP Token", 5);
        frpTokenBox.Height = 31;
        frpTokenBox.Margin = new Thickness(0, 12, 0, 0);
        frpTokenBox.ToolTip = NativeClient.GetBool(status, "frpTokenConfigured") ? "已安全保存；留空可继续使用已保存的 Token。" : "首次配置必须填写。";
        Grid.SetRow(frpTokenBox, 5); Grid.SetColumn(frpTokenBox, 1); grid.Children.Add(frpTokenBox);

        enabledBox.Margin = new Thickness(0, 14, 0, 0);
        enabledBox.IsChecked = !configured || NativeClient.GetBool(status, "enabled");
        Grid.SetRow(enabledBox, 6); Grid.SetColumn(enabledBox, 1); grid.Children.Add(enabledBox);

        TextBlock hint = new TextBlock
        {
            Text = configured
                ? "Token 只在当前 Windows 用户下加密保存。外网入口始终公开只读，链接设置只能在本客户端修改。"
                : "此连接只用于访问中心，不会替换或修改当前 88FRP 同步隧道。访问中心始终为公开只读入口。",
            Foreground = new SolidColorBrush(Color.FromRgb(100, 116, 139)),
            TextWrapping = TextWrapping.Wrap,
            Margin = new Thickness(0, 12, 0, 0)
        };
        Grid.SetRow(hint, 7); Grid.SetColumn(hint, 1); grid.Children.Add(hint);

        StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Bottom };
        Button cancel = new Button { Content = "取消", Width = 92, Height = 32, Margin = new Thickness(8, 0, 0, 0) };
        Button ok = new Button { Content = configured ? "保存" : "启用", Width = 92, Height = 32, Margin = new Thickness(8, 0, 0, 0), IsDefault = true };
        cancel.Click += delegate { DialogResult = false; };
        ok.Click += delegate
        {
            if (DisableRequested)
            {
                DialogResult = true;
                return;
            }
            if (ServerAddress == "" || ServerPort == "" || RemotePort == "" || LocalPort == "")
            {
                MessageBox.Show("请填写服务地址、服务端口、公网端口和本地端口。", Program.AppName);
                return;
            }
            if (!configured && FrpToken == "")
            {
                MessageBox.Show("首次启用需要填写 FRP Token。", Program.AppName);
                return;
            }
            DialogResult = true;
        };
        actions.Children.Add(cancel);
        actions.Children.Add(ok);
        Grid.SetRow(actions, 11); Grid.SetColumnSpan(actions, 2); grid.Children.Add(actions);
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
            if (IsBackendHealthy()) return;
            if (backendProcess != null && !backendProcess.HasExited) return;
            string backendPath = AppFile("88frp-web.exe");
            if (!File.Exists(backendPath))
            {
                MessageBox.Show("没有找到后台核心文件：" + backendPath, Program.AppName, MessageBoxButton.OK, MessageBoxImage.Error);
                Environment.Exit(1);
            }
            ProcessStartInfo info = new ProcessStartInfo();
            info.FileName = backendPath;
            info.WorkingDirectory = Path.GetDirectoryName(backendPath);
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            info.EnvironmentVariables["HOST"] = Program.Host;
            info.EnvironmentVariables["PORT"] = Program.Port.ToString();
            info.EnvironmentVariables["APP_BASE_DIR"] = Program.AppDataDir;
            info.EnvironmentVariables["INSTANCE_AUTO_START_ON_BOOT"] = "1";
            backendProcess = Process.Start(info);
        }
    }

    public void StopBackend()
    {
        lock (backendLifecycleLock)
        {
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

    public void RestartBackend()
    {
        StopBackend();
        Thread.Sleep(700);
        StartBackend();
        WaitForBackend();
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
    public static string GetNestedString(Dictionary<string, object> dict, string parent, string child)
    {
        if (dict == null || !dict.ContainsKey(parent)) return "";
        return GetString(AsDict(dict[parent]), child);
    }
    public static void OpenConsoleFallback()
    {
        try { Process.Start(new ProcessStartInfo { FileName = Program.BaseUrl, UseShellExecute = true }); } catch { }
    }
    public static void EnableAutoStart()
    {
        string command = "\"" + Process.GetCurrentProcess().MainModule.FileName + "\" --background";
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)) key.SetValue(Program.AppName, command);
        RunHidden("schtasks.exe", "/Create /TN \"88FRP Background\" /SC ONLOGON /RL LIMITED /F /TR \"" + command.Replace("\"", "\\\"") + "\"");
    }
    public static void DisableAutoStart()
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)) key.DeleteValue(Program.AppName, false);
        RunHidden("schtasks.exe", "/Delete /TN \"88FRP Background\" /F");
    }
    public static bool IsAutoStartEnabled()
    {
        using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", false)) return key != null && key.GetValue(Program.AppName) != null;
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
