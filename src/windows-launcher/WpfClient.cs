using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using WF = System.Windows.Forms;
using SD = System.Drawing;

internal static class Program
{
    internal const string AppName = "88FRP";
    internal const string Host = "127.0.0.1";
    internal const int Port = 8801;
    internal static readonly string BaseUrl = "http://" + Host + ":" + Port;
    internal static readonly string AppDataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "88frp-node");
    internal static readonly string FirstRunPath = Path.Combine(AppDataDir, "native-client-first-run.flag");

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
    private readonly List<Dictionary<string, object>> tunnels = new List<Dictionary<string, object>>();
    private readonly WF.NotifyIcon trayIcon = new WF.NotifyIcon();
    private string currentInstanceId = "";
    private bool exiting;
    private Button autoStartButton;
    private Button frpAccountButton;
    private TextBlock frpAccountStatus = new TextBlock();

    private static readonly Brush SidebarBrush = new SolidColorBrush(Color.FromRgb(20, 31, 48));
    private static readonly Brush AppBrush = new SolidColorBrush(Color.FromRgb(246, 248, 251));
    private static readonly Brush CardBrush = Brushes.White;
    private static readonly Brush TextBrush = new SolidColorBrush(Color.FromRgb(15, 23, 42));
    private static readonly Brush MutedBrush = new SolidColorBrush(Color.FromRgb(100, 116, 139));
    private static readonly Brush AccentBrush = new SolidColorBrush(Color.FromRgb(37, 99, 235));
    private static readonly Brush AccentGreenBrush = new SolidColorBrush(Color.FromRgb(20, 184, 166));
    private static readonly Brush UiBorderBrush = new SolidColorBrush(Color.FromRgb(226, 232, 240));

    public MainWindow(bool backgroundStart)
    {
        this.backgroundStart = backgroundStart;
        Title = "88FRP";
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

        Content = BuildRoot();
        BuildTray();

        Loaded += delegate
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
                if (backgroundStart) HideToTray();
            });
        };
        Closing += OnClosing;

        pollTimer.Interval = TimeSpan.FromSeconds(4);
        pollTimer.Tick += delegate { SafeSilent(delegate { RefreshInstances(true); }); };
        watchdogTimer.Interval = TimeSpan.FromSeconds(10);
        watchdogTimer.Tick += delegate { if (!client.IsBackendHealthy()) client.StartBackend(); };
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
        brandText.Children.Add(new TextBlock { Text = "Windows 隧道管理器", Foreground = new SolidColorBrush(Color.FromRgb(174, 190, 214)), FontSize = 13, Margin = new Thickness(0, 2, 0, 0) });

        Button create = PrimaryButton("+  新建实例", AccentGreenBrush);
        create.Height = 42;
        create.Margin = new Thickness(0, 0, 0, 22);
        create.Click += delegate { Safe(CreateInstance); };
        DockPanel.SetDock(create, Dock.Top);
        sideDock.Children.Add(create);

        TextBlock listTitle = new TextBlock { Text = "实例", Foreground = new SolidColorBrush(Color.FromRgb(203, 213, 225)), FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 8) };
        DockPanel.SetDock(listTitle, Dock.Top);
        sideDock.Children.Add(listTitle);

        instanceList.Background = SidebarBrush;
        instanceList.BorderThickness = new Thickness(0);
        instanceList.Foreground = Brushes.White;
        instanceList.FontSize = 15;
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
        Button sync = PrimaryButton("同步配置", AccentBrush);
        start.Click += delegate { Safe(delegate { RuntimeAction("start"); }); };
        stop.Click += delegate { Safe(delegate { RuntimeAction("stop"); }); };
        restart.Click += delegate { Safe(delegate { RuntimeAction("restart"); }); };
        sync.Click += delegate { Safe(SyncCurrent); };
        actions.Children.Add(start);
        actions.Children.Add(stop);
        actions.Children.Add(restart);
        actions.Children.Add(sync);
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
        autoStartButton = OutlineButton(NativeClient.IsAutoStartEnabled() ? "关闭开机自启" : "开启开机自启", AccentBrush);
        autoStartButton.Click += delegate { Safe(ToggleAutoStart); };
        panel.Children.Add(autoStartButton);
        frpAccountButton = OutlineButton("连接 88FRP", AccentBrush);
        frpAccountButton.Click += delegate { Safe(ManageFrpAccount); };
        panel.Children.Add(frpAccountButton);
        frpAccountStatus.Foreground = MutedBrush;
        frpAccountStatus.VerticalAlignment = VerticalAlignment.Center;
        frpAccountStatus.Margin = new Thickness(10, 0, 0, 0);
        panel.Children.Add(frpAccountStatus);
        return card;
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
            autoStartButton.Content = "关闭开机自启";
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
            InstanceListItem listItem = new InstanceListItem { Id = id, Text = name + "  ·  " + TranslateStatus(status) };
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
        if (string.IsNullOrEmpty(currentInstanceId)) return;
        Dictionary<string, object> data = client.GetDict("/api/instances/" + currentInstanceId + "/tunnels");
        object[] rows = NativeClient.AsArray(data.ContainsKey("tunnels") ? data["tunnels"] : null);
        foreach (object row in rows)
        {
            Dictionary<string, object> tunnel = NativeClient.AsDict(row);
            tunnels.Add(tunnel);
            string displayName = NativeClient.GetString(tunnel, "displayName");
            string title = displayName == "" ? NativeClient.GetString(tunnel, "name") : displayName + "  ·  " + NativeClient.GetString(tunnel, "name");
            CheckBox check = new CheckBox
            {
                IsChecked = NativeClient.GetBool(tunnel, "enabled"),
                Margin = new Thickness(0, 0, 0, 8),
                Padding = new Thickness(10),
                FontSize = 15,
                Content = title + "    " + NativeClient.GetString(tunnel, "type") + "    本地 " + NativeClient.GetString(tunnel, "localPort") + "  →  远程 " + NativeClient.GetString(tunnel, "remotePort")
            };
            tunnelPanel.Children.Add(check);
        }
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
        for (int i = 0; i < tunnels.Count; i++)
        {
            CheckBox check = tunnelPanel.Children[i] as CheckBox;
            selection[NativeClient.GetString(tunnels[i], "name")] = check != null && check.IsChecked == true;
        }
        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["selection"] = selection;
        client.PutDict("/api/instances/" + currentInstanceId + "/tunnels/selection", payload);
        MessageBox.Show("隧道选择已保存，重启实例后生效。", Program.AppName);
    }

    private void RuntimeAction(string action)
    {
        if (string.IsNullOrEmpty(currentInstanceId)) return;
        client.PostDict("/api/instances/" + currentInstanceId + "/" + action, new Dictionary<string, object>());
        Thread.Sleep(500);
        RefreshAll();
    }

    private void SyncCurrent()
    {
        if (string.IsNullOrEmpty(currentInstanceId)) return;
        Dictionary<string, object> info = new Dictionary<string, object>();
        info["secretKey"] = secretBox.Text.Trim();
        info["autoSyncEnabled"] = autoSyncBox.IsChecked == true;
        client.PutDict("/api/instances/" + currentInstanceId, info);
        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["restartOnChange"] = true;
        client.PostDict("/api/instances/" + currentInstanceId + "/sync", payload);
        RefreshAll();
        MessageBox.Show("同步完成。已保存的隧道选择会保留，新隧道默认关闭。", Program.AppName);
    }

    private void ToggleAutoStart()
    {
        if (NativeClient.IsAutoStartEnabled())
        {
            NativeClient.DisableAutoStart();
            autoStartButton.Content = "开启开机自启";
        }
        else
        {
            NativeClient.EnableAutoStart();
            autoStartButton.Content = "关闭开机自启";
        }
    }

    private void RefreshFrpAccountStatus()
    {
        if (frpAccountButton == null) return;
        Dictionary<string, object> account = client.GetDict("/api/88frp/account");
        bool connected = NativeClient.GetBool(account, "connected");
        string username = NativeClient.GetString(account, "username");
        bool autoLogin = NativeClient.GetBool(account, "autoLoginEnabled");
        frpAccountButton.Content = connected ? "管理 88FRP" : "连接 88FRP";
        frpAccountStatus.Text = connected ? (username + (autoLogin ? " · 自动登录" : " · 需手动登录")) : "未连接";
    }

    private void ManageFrpAccount()
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
        client.PostDict("/api/88frp/account/connect", payload);
        RefreshFrpAccountStatus();
        LoadTunnels();
        MessageBox.Show("88FRP 已连接。同步配置发生变化时会自动刷新隧道名称。", Program.AppName);
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

internal sealed class InstanceListItem
{
    public string Id;
    public string Text;
    public override string ToString() { return Text; }
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
        if (IsBackendHealthy()) return;
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

    public void StopBackend()
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
    }

    public void RestartBackend()
    {
        StopBackend();
        Thread.Sleep(700);
        StartBackend();
        WaitForBackend();
    }

    public bool IsBackendHealthy()
    {
        try
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Program.BaseUrl + "/api/health");
            request.Timeout = 900;
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
    public Dictionary<string, object> PostDict(string path, Dictionary<string, object> payload) { return AsDict(Request("POST", path, payload)); }
    public Dictionary<string, object> PutDict(string path, Dictionary<string, object> payload) { return AsDict(Request("PUT", path, payload)); }
    public Dictionary<string, object> DeleteDict(string path) { return AsDict(Request("DELETE", path, null)); }

    private object Request(string method, string path, Dictionary<string, object> payload)
    {
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(Program.BaseUrl + path);
        request.Method = method;
        request.Timeout = 12000;
        request.ContentType = "application/json";
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
