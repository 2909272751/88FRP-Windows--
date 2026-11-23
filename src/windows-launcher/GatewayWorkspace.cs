using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;

internal sealed partial class MainWindow
{
    private static readonly Brush AccentSoftBrush = ClientTheme.Brush("PrimarySoft");
    private static readonly Dictionary<string, string[]> GatewayServiceMetadata =
        new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            { "xps", new[] { "香港楼市终端", "行情终端", "香港与广州楼市行情、租售比与买房判断" } },
            { "xps-cd2", new[] { "CloudDrive2", "云盘", "挂载云盘与统一文件管理" } },
            { "xps-codex", new[] { "Codex", "开发", "本机 Codex 工作区与任务入口" } },
            { "xps-deepseek", new[] { "DeepSeek Harness", "AI", "DeepSeek 调试与运行面板" } },
            { "xps-alist", new[] { "AList 文件", "文件", "统一浏览与挂载网盘文件" } },
        };

    private readonly Dictionary<string, Button> gatewayNavButtons = new Dictionary<string, Button>(StringComparer.Ordinal);
    private readonly Dictionary<string, Grid> gatewayPages = new Dictionary<string, Grid>(StringComparer.Ordinal);

    private Grid gatewayWorkspaceRoot;
    private Grid gatewayOverviewHost;
    private Grid legacyWorkspaceRoot;
    private Grid unifiedShellRoot;
    private Border gatewaySidebar;
    private ColumnDefinition gatewaySidebarColumn;
    private StackPanel gatewayBrandText;
    private Border gatewayDeviceCard;
    private TextBlock gatewayNavHeading;
    private Grid gatewayPageHost;
    private Border gatewayBusyBar;
    private TextBlock gatewayBusyText;
    private ProgressBar gatewayBusyProgress;
    private TextBlock gatewayPageTitle;
    private TextBlock gatewayPageSubtitle;
    private TextBlock gatewayHeaderStatusText;
    private Button gatewayOpenPortalButton;
    private Button gatewayRefreshButton;
    private TextBlock gatewayRailDeviceName;
    private TextBlock gatewayRailDomain;
    private TextBlock gatewayRailStatus;
    private Border gatewayRailStatusDot;

    private StackPanel gatewayOnboardingView;
    private StackPanel gatewayPortalView;
    private Border gatewayLoadingView;
    private TextBlock gatewayLoadingTitle;
    private TextBlock gatewayLoadingDetail;
    private Button gatewayLoadingRetryButton;
    private TextBlock gatewayHeroName;
    private TextBlock gatewayHeroDomain;
    private TextBlock gatewayHeroDescription;
    private Button gatewayHeroOpenButton;
    private Button gatewayHeroAdminButton;
    private Border gatewayHeroConnectionPill;
    private TextBlock gatewayHeroConnectionText;
    private Border gatewayHeroIpv6Pill;
    private TextBlock gatewayHeroIpv6Text;
    private Border gatewayHeroRuntimePill;
    private TextBlock gatewayHeroRuntimeText;
    private TextBox gatewayWebV6Box;
    private TextBox gatewayWebV4Box;
    private UniformGrid gatewayPortalGrid;
    private StackPanel gatewayPortalRoot;
    private Border gatewayPortalEmpty;
    private TextBlock gatewayPortalServiceCount;
    private TextBlock gatewayPortalHint;

    private ComboBox migrateInstanceCombo;
    private TextBox migrateNameInput;
    private TextBox migrateDomainInput;
    private TextBox migratePortInput;
    private CheckBox migrateImportServicesCheck;
    private Button migrateButton;
    private TextBlock migrateMessage;
    private string gatewayMigrationSignature = "";

    private TextBox bootstrapNameInput;
    private PasswordBox bootstrapSecretInput;
    private TextBox bootstrapRemoteInput;
    private TextBox bootstrapDomainInput;
    private TextBox bootstrapPortInput;
    private TextBlock bootstrapMessage;

    private TextBlock gatewayServiceAddressText;
    private StackPanel gatewayServiceList;

    private TextBox gatewayDeviceNameInput;
    private TextBox gatewayDeviceDomainInput;
    private TextBox gatewayDevicePortInput;
    private ComboBox gatewayIpv6ModeCombo;
    private TextBox gatewayManualIpv6Input;
    private FrameworkElement gatewayManualIpv6Field;
    private CheckBox gatewayAutoStartCheck;
    private TextBlock gatewayDeviceStatusText;
    private TextBlock gatewayCloudflareStatusText;
    private TextBlock gatewayCloudflareDetailText;
    private PasswordBox gatewayCloudflareTokenInput;
    private TextBlock gatewayDnsStatusText;
    private StackPanel gatewayDnsRecordPanel;
    private bool gatewayDeviceFormHydrated;

    private CheckBox gatewaySshEnabledCheck;
    private TextBox gatewaySshHostInput;
    private TextBox gatewaySshPortInput;
    private TextBox gatewaySshRemotePortInput;
    private TextBlock gatewaySshStatusText;
    private TextBlock gatewaySshEndpointText;
    private TextBlock gatewaySshRelayText;
    private TextBox gatewaySshAutoBox;
    private TextBox gatewaySshV6Box;
    private TextBox gatewaySshV4Box;
    private TextBox gatewayRdpDomainBox;
    private TextBox gatewayRdpCommandBox;
    private TextBox gatewayRdpCommandV4Box;
    private TextBlock gatewayFirewallStatusText;
    private TextBlock gatewayFirewallDetailText;
    private Border gatewayFirewallPill;
    private TextBlock gatewayFirewallPillText;
    private StackPanel gatewayRelayPanel;
    private bool gatewaySshFormHydrated;

    private TextBlock gatewayCaddyStatusText;
    private TextBlock gatewayCaddyDetailText;
    private TextBlock gatewayFrpcStatusText;
    private TextBlock gatewayFrpcDetailText;
    private TextBlock gatewaySourceStatusText;
    private TextBlock gatewaySourceDetailText;
    private ComboBox gatewayLogTypeCombo;
    private TextBox gatewayLogsBox;
    private Dictionary<string, object> gatewayLogsCache = new Dictionary<string, object>();

    private Dictionary<string, object> gatewayOverviewState = new Dictionary<string, object>();
    private string currentGatewayView = "portal";
    private bool gatewayActionRunning;
    private bool gatewayRefreshRunning;
    private bool gatewayInitialLoadPending = true;
    private bool gatewayHasUsableData;
    private DateTime gatewayLastSuccessAt;
    private string gatewayStructureSignature = "";
    private DateTime gatewayLastCacheWrite;
    private static readonly string GatewayOverviewCachePath = Path.Combine(Program.AppDataDir, "native-client-gateway-cache.json");

    private UIElement BuildUnifiedShell()
    {
        Grid root = new Grid();
        unifiedShellRoot = root;
        gatewaySidebarColumn = new ColumnDefinition { Width = new GridLength(208) };
        root.ColumnDefinitions.Add(gatewaySidebarColumn);
        root.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        gatewaySidebar = new Border
        {
            Background = SidebarBrush,
            Padding = new Thickness(12, 20, 12, 16),
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(0, 0, 1, 0)
        };
        Grid.SetColumn(gatewaySidebar, 0);
        root.Children.Add(gatewaySidebar);

        DockPanel sideDock = new DockPanel { LastChildFill = true };
        gatewaySidebar.Child = sideDock;

        StackPanel brand = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(4, 0, 0, 24) };
        DockPanel.SetDock(brand, Dock.Top);
        sideDock.Children.Add(brand);
        brand.Children.Add(new Image { Source = NativeClient.LoadLogoImage(), Width = 34, Height = 34, Stretch = Stretch.Uniform });
        gatewayBrandText = new StackPanel { Margin = new Thickness(10, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        brand.Children.Add(gatewayBrandText);
        gatewayBrandText.Children.Add(new TextBlock { Text = "88FRP", Foreground = TextBrush, FontSize = 19, FontWeight = FontWeights.SemiBold });
        gatewayBrandText.Children.Add(new TextBlock { Text = "远程入口", Foreground = MutedBrush, FontSize = 11, Margin = new Thickness(0, 2, 0, 0) });

        // The device identity now lives in the page header. Keep these visual fields
        // for the existing overview renderer, but do not repeat them in the sidebar.
        gatewayDeviceCard = new Border { Visibility = Visibility.Collapsed };
        gatewayRailStatusDot = new Border { Width = 8, Height = 8, CornerRadius = new CornerRadius(4), Background = MutedBrush };
        gatewayRailStatus = new TextBlock { Text = "正在读取" };
        gatewayRailDeviceName = new TextBlock { Text = "本机设备" };
        gatewayRailDomain = new TextBlock { Text = "" };

        StackPanel bottomNavigation = new StackPanel();
        DockPanel.SetDock(bottomNavigation, Dock.Bottom);
        sideDock.Children.Add(bottomNavigation);
        managementHubButton = SidebarNavButton("账户与安全", "");
        managementHubButton.Height = 38;
        managementHubButton.Click += delegate { ShowManagementDrawer(); };
        bottomNavigation.Children.Add(managementHubButton);

        gatewayNavHeading = SidebarSectionLabel("导航", new Thickness(9, 0, 0, 9));
        DockPanel.SetDock(gatewayNavHeading, Dock.Top);
        sideDock.Children.Add(gatewayNavHeading);

        StackPanel navigation = new StackPanel();
        DockPanel.SetDock(navigation, Dock.Top);
        sideDock.Children.Add(navigation);
        gatewayHubButton = AddGatewayNavigation(navigation, "portal", "概览");
        AddGatewayNavigation(navigation, "services", "服务");
        AddGatewayNavigation(navigation, "remote", "远程访问");
        AddGatewayNavigation(navigation, "domain", "设置");

        gatewayWorkspaceRoot = BuildGatewayWorkspace();
        Grid.SetColumn(gatewayWorkspaceRoot, 1);
        root.Children.Add(gatewayWorkspaceRoot);

        legacyWorkspaceRoot = BuildLegacyWorkspace();
        Grid.SetColumn(legacyWorkspaceRoot, 1);
        legacyWorkspaceRoot.Visibility = Visibility.Collapsed;
        BuildManagementOverlay();
        ShowGatewayWorkspace("portal");
        SizeChanged += delegate { ApplyGatewayResponsiveLayout(); };
        ApplyGatewayResponsiveLayout();
        return root;
    }

    private void ApplyGatewayResponsiveLayout()
    {
        if (gatewaySidebarColumn == null) return;
        bool compact = ActualWidth > 0 && ActualWidth < 1120;
        gatewaySidebarColumn.Width = new GridLength(compact ? 68 : 208);
        gatewaySidebar.Padding = compact ? new Thickness(7, 18, 7, 14) : new Thickness(12, 20, 12, 16);
        if (gatewayBrandText != null) gatewayBrandText.Visibility = compact ? Visibility.Collapsed : Visibility.Visible;
        if (gatewayDeviceCard != null) gatewayDeviceCard.Visibility = Visibility.Collapsed;
        if (gatewayNavHeading != null) gatewayNavHeading.Visibility = compact ? Visibility.Collapsed : Visibility.Visible;
        if (managementHubButton != null) managementHubButton.Content = compact ? "账户" : "账户与安全";
        if (gatewayPageTitle != null) gatewayPageTitle.FontSize = compact ? 23 : 26;
        if (gatewayPageSubtitle != null) gatewayPageSubtitle.FontSize = compact ? 11 : 12;
        if (gatewayOpenPortalButton != null)
        {
            gatewayOpenPortalButton.Content = compact ? "导航" : "打开导航页";
            gatewayOpenPortalButton.MinWidth = compact ? 58 : 88;
        }
        foreach (KeyValuePair<string, Button> entry in gatewayNavButtons)
        {
            string title = Convert.ToString(entry.Value.Tag);
            if (string.IsNullOrWhiteSpace(title)) title = Convert.ToString(entry.Value.Content);
            entry.Value.Tag = title;
            entry.Value.Content = compact ? CompactGatewayNavTitle(title) : title;
            entry.Value.FontSize = compact ? 10 : 13;
            entry.Value.Padding = compact ? new Thickness(0) : new Thickness(10, 0, 10, 0);
        }
        if (gatewayWorkspaceRoot != null)
            gatewayWorkspaceRoot.Margin = compact ? new Thickness(12, 12, 12, 12) : new Thickness(22, 18, 22, 18);
    }

    private static string CompactGatewayNavTitle(string title)
    {
        if (title == "远程") return "远程";
        return title;
    }

    private Button AddGatewayNavigation(StackPanel parent, string key, string title)
    {
        Button button = SidebarNavButton(title, "");
        button.Tag = title;
        button.Height = 38;
        button.Click += delegate { ShowGatewayWorkspace(key); };
        parent.Children.Add(button);
        gatewayNavButtons[key] = button;
        return button;
    }

    private Grid BuildLegacyWorkspace()
    {
        Grid view = new Grid { Margin = new Thickness(26, 22, 26, 22), Visibility = Visibility.Collapsed };
        view.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        view.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        view.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        view.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        view.Children.Add(BuildHeader());
        UIElement cards = BuildStatusCards();
        Grid.SetRow(cards, 1);
        view.Children.Add(cards);
        UIElement settings = BuildSettingsBar();
        Grid.SetRow(settings, 2);
        view.Children.Add(settings);

        Grid body = new Grid();
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(235) });
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        Grid.SetRow(body, 3);
        view.Children.Add(body);

        Border instanceCard = Card();
        instanceCard.Margin = new Thickness(0, 0, 14, 0);
        instanceCard.Padding = new Thickness(14);
        body.Children.Add(instanceCard);
        DockPanel instanceDock = new DockPanel { LastChildFill = true };
        instanceCard.Child = instanceDock;
        TextBlock instanceTitle = new TextBlock { Text = "历史实例", Foreground = TextBrush, FontSize = 16, FontWeight = FontWeights.SemiBold, Margin = new Thickness(2, 0, 0, 10) };
        DockPanel.SetDock(instanceTitle, Dock.Top);
        instanceDock.Children.Add(instanceTitle);
        Button create = PrimaryButton("+  新建实例", AccentBrush);
        create.Margin = new Thickness(0, 0, 0, 12);
        create.HorizontalAlignment = HorizontalAlignment.Stretch;
        create.Click += delegate { Safe(CreateInstance); };
        DockPanel.SetDock(create, Dock.Top);
        instanceDock.Children.Add(create);
        instanceList.Background = CardBrush;
        instanceList.BorderThickness = new Thickness(0);
        instanceList.Foreground = TextBrush;
        instanceList.FontSize = 13;
        ScrollViewer.SetHorizontalScrollBarVisibility(instanceList, ScrollBarVisibility.Disabled);
        instanceList.HorizontalContentAlignment = HorizontalAlignment.Stretch;
        instanceList.ItemTemplate = BuildInstanceItemTemplate();
        instanceList.SelectionChanged += delegate { if (!refreshingInstanceList) Safe(SelectCurrentInstance); };
        instanceDock.Children.Add(instanceList);

        UIElement tabs = BuildTabs();
        Grid.SetColumn(tabs, 1);
        body.Children.Add(tabs);
        return view;
    }

    private Grid BuildGatewayWorkspace()
    {
        Grid view = new Grid { Margin = new Thickness(22, 18, 22, 18), Visibility = Visibility.Visible };
        view.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        view.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        view.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        view.Children.Add(BuildGatewayHeader());

        gatewayBusyBar = new Border
        {
            Background = AccentSoftBrush,
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(14, 10, 14, 10),
            Margin = new Thickness(0, 0, 0, 14),
            Visibility = Visibility.Collapsed
        };
        Grid busyContent = new Grid();
        busyContent.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        busyContent.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        gatewayBusyText = new TextBlock { Text = "", Foreground = AccentTextBrush, FontSize = 12, TextWrapping = TextWrapping.Wrap };
        busyContent.Children.Add(gatewayBusyText);
        gatewayBusyProgress = new ProgressBar
        {
            Height = 3,
            Margin = new Thickness(0, 8, 0, 0),
            IsIndeterminate = true,
            Foreground = AccentBrush,
            Background = SurfaceBrush,
            BorderThickness = new Thickness(0)
        };
        Grid.SetRow(gatewayBusyProgress, 1);
        busyContent.Children.Add(gatewayBusyProgress);
        gatewayBusyBar.Child = busyContent;
        Grid.SetRow(gatewayBusyBar, 1);
        view.Children.Add(gatewayBusyBar);

        gatewayPageHost = new Grid();
        Grid.SetRow(gatewayPageHost, 2);
        view.Children.Add(gatewayPageHost);

        AddGatewayPage("portal", BuildGatewayPortalPage());
        AddGatewayPage("services", BuildGatewayServicesPage());
        AddGatewayPage("domain", BuildGatewayDomainPage());
        AddGatewayPage("remote", BuildGatewayRemotePage());
        AddGatewayPage("runtime", BuildGatewayRuntimePage());
        SetGatewayPageVisible("portal");
        return view;
    }

    private void AddGatewayPage(string key, UIElement content)
    {
        Grid page = new Grid { Visibility = Visibility.Collapsed };
        page.Children.Add(content);
        gatewayPageHost.Children.Add(page);
        gatewayPages[key] = page;
    }

    private UIElement BuildGatewayHeader()
    {
        Grid header = new Grid { Margin = new Thickness(0, 0, 0, 14) };
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

        StackPanel title = new StackPanel();
        header.Children.Add(title);
        gatewayPageTitle = new TextBlock { Text = "首页", Foreground = TextBrush, FontSize = 26, FontWeight = FontWeights.SemiBold };
        title.Children.Add(gatewayPageTitle);
        gatewayPageSubtitle = new TextBlock { Text = "这台设备的服务入口和运行状态，一屏掌握。", Foreground = MutedBrush, FontSize = 12, Margin = new Thickness(0, 5, 0, 0), TextWrapping = TextWrapping.Wrap };
        title.Children.Add(gatewayPageSubtitle);
        gatewayHeaderStatusText = new TextBlock { Text = "", Foreground = MutedBrush, FontSize = 11, Margin = new Thickness(0, 3, 0, 0), TextTrimming = TextTrimming.CharacterEllipsis };
        title.Children.Add(gatewayHeaderStatusText);

        StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Top };
        Grid.SetColumn(actions, 1);
        header.Children.Add(actions);
        gatewayOpenPortalButton = PrimaryButton("打开导航页", AccentGreenBrush);
        gatewayOpenPortalButton.IsEnabled = false;
        gatewayOpenPortalButton.Click += delegate { OpenGatewayPortal(); };
        actions.Children.Add(gatewayOpenPortalButton);
        gatewayRefreshButton = OutlineButton("刷新", TextBrush);
        gatewayRefreshButton.Click += delegate { RefreshGatewayStatusInteractive(); };
        actions.Children.Add(gatewayRefreshButton);
        return header;
    }

    private UIElement GatewayPageScroll(UIElement content)
    {
        return new ScrollViewer
        {
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Content = content,
            Focusable = false
        };
    }

    private UIElement BuildGatewayPortalPage()
    {
        gatewayOverviewHost = new Grid();
        gatewayLoadingView = BuildGatewayLoadingView();
        gatewayOnboardingView = BuildGatewayOnboarding();
        gatewayOnboardingView.Visibility = Visibility.Collapsed;
        gatewayPortalView = BuildGatewayPortalContent();
        gatewayPortalView.Visibility = Visibility.Collapsed;
        SetGatewayOverviewState("loading");
        return GatewayPageScroll(gatewayOverviewHost);
    }

    private Border BuildGatewayLoadingView()
    {
        Border card = Card();
        card.Padding = new Thickness(36, 46, 36, 46);
        card.Margin = new Thickness(0, 0, 0, 14);
        StackPanel content = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center, MaxWidth = 460 };
        card.Child = content;
        gatewayLoadingTitle = new TextBlock
        {
            Text = "正在读取设备状态",
            Foreground = TextBrush,
            FontSize = 21,
            FontWeight = FontWeights.SemiBold,
            HorizontalAlignment = HorizontalAlignment.Center
        };
        content.Children.Add(gatewayLoadingTitle);
        gatewayLoadingDetail = new TextBlock
        {
            Text = "正在连接本机后台并汇总服务状态…",
            Foreground = MutedBrush,
            FontSize = 12,
            Margin = new Thickness(0, 8, 0, 18),
            TextAlignment = TextAlignment.Center,
            TextWrapping = TextWrapping.Wrap
        };
        content.Children.Add(gatewayLoadingDetail);
        ProgressBar progress = new ProgressBar
        {
            Width = 220,
            Height = 4,
            IsIndeterminate = true,
            Foreground = AccentBrush,
            Background = SurfaceBrush,
            BorderThickness = new Thickness(0),
            HorizontalAlignment = HorizontalAlignment.Center
        };
        content.Children.Add(progress);
        gatewayLoadingRetryButton = OutlineButton("重新读取", TextBrush);
        gatewayLoadingRetryButton.Margin = new Thickness(0, 16, 0, 0);
        gatewayLoadingRetryButton.HorizontalAlignment = HorizontalAlignment.Center;
        gatewayLoadingRetryButton.Visibility = Visibility.Collapsed;
        gatewayLoadingRetryButton.Click += delegate { RefreshGatewayStatusInteractive(); };
        content.Children.Add(gatewayLoadingRetryButton);
        return card;
    }

    private StackPanel BuildGatewayPortalContent()
    {
        StackPanel root = new StackPanel();
        gatewayPortalRoot = root;

        Border hero = Card();
        hero.Background = CardBrush;
        hero.BorderBrush = UiBorderBrush;
        hero.CornerRadius = new CornerRadius(14);
        hero.Padding = new Thickness(20, 18, 20, 18);
        hero.Margin = new Thickness(0, 0, 0, 14);
        root.Children.Add(hero);
        StackPanel copy = new StackPanel();
        hero.Child = copy;
        gatewayHeroName = new TextBlock { Text = "公开访问地址", Foreground = TextBrush, FontSize = 18, FontWeight = FontWeights.SemiBold };
        copy.Children.Add(gatewayHeroName);
        gatewayHeroDescription = new TextBlock { Text = "把这一个地址发给需要访问的人，线路会自动选择。", Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, LineHeight = 18, Margin = new Thickness(0, 4, 0, 0) };
        copy.Children.Add(gatewayHeroDescription);
        Border urlChrome = new Border
        {
            Background = SurfaceBrush,
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(8),
            Padding = new Thickness(12, 10, 12, 10),
            Margin = new Thickness(0, 13, 0, 0)
        };
        gatewayHeroDomain = new TextBlock
        {
            Text = "尚未设置域名",
            Foreground = AccentTextBrush,
            FontSize = 15,
            FontFamily = new FontFamily("Consolas, Microsoft YaHei UI"),
            FontWeight = FontWeights.SemiBold,
            TextWrapping = TextWrapping.Wrap
        };
        urlChrome.Child = gatewayHeroDomain;
        copy.Children.Add(urlChrome);
        WrapPanel heroActions = new WrapPanel { Margin = new Thickness(0, 13, 0, 0) };
        copy.Children.Add(heroActions);
        gatewayHeroOpenButton = PrimaryButton("打开导航页", AccentBrush);
        gatewayHeroOpenButton.Margin = new Thickness(0, 0, 8, 0);
        gatewayHeroOpenButton.IsEnabled = false;
        gatewayHeroOpenButton.Click += delegate { OpenGatewayPortal(); };
        heroActions.Children.Add(gatewayHeroOpenButton);
        Button copyLink = OutlineButton("复制链接", TextBrush);
        copyLink.Margin = new Thickness(0, 0, 8, 0);
        copyLink.Click += delegate { CopyGatewayText(GatewayPublicRootUrl(), "公网入口已复制。"); };
        heroActions.Children.Add(copyLink);
        gatewayHeroAdminButton = OutlineButton("管理后台", TextBrush);
        gatewayHeroAdminButton.IsEnabled = false;
        gatewayHeroAdminButton.Click += delegate { OpenGatewayAdmin(); };
        heroActions.Children.Add(gatewayHeroAdminButton);

        WrapPanel status = new WrapPanel { Margin = new Thickness(0, 12, 0, 0) };
        copy.Children.Add(status);
        GatewayChip(status, out gatewayHeroConnectionPill, out gatewayHeroConnectionText, "本机");
        GatewayChip(status, out gatewayHeroIpv6Pill, out gatewayHeroIpv6Text, "IPv6 检测中");
        GatewayChip(status, out gatewayHeroRuntimePill, out gatewayHeroRuntimeText, "服务状态读取中");

        Expander webLines = new Expander
        {
            Header = "手动切换网页线路",
            Foreground = TextBrush,
            Margin = new Thickness(0, 12, 0, 0),
            IsExpanded = false
        };
        StackPanel webLineContent = new StackPanel { Margin = new Thickness(0, 8, 0, 0), MaxWidth = 660 };
        webLines.Content = webLineContent;
        copy.Children.Add(webLines);
        gatewayWebV6Box = GatewayEndpointRow(webLineContent, "IPv6 专用", "强制从 IPv6 网络打开网页入口", "IPv6 网页入口已复制。");
        gatewayWebV4Box = GatewayEndpointRow(webLineContent, "IPv4 专用", "无 IPv6 时使用的 88FRP 网页入口", "IPv4 网页入口已复制。");

        Grid toolbar = new Grid { Margin = new Thickness(2, 6, 2, 12) };
        toolbar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        toolbar.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        StackPanel toolbarText = new StackPanel { Orientation = Orientation.Horizontal };
        toolbar.Children.Add(toolbarText);
        toolbarText.Children.Add(new TextBlock { Text = "常用服务", Foreground = TextBrush, FontSize = 16, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
        gatewayPortalServiceCount = new TextBlock { Text = "0 个入口", Foreground = MutedBrush, FontSize = 12, Margin = new Thickness(10, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        toolbarText.Children.Add(gatewayPortalServiceCount);
        gatewayPortalHint = new TextBlock { Text = "一个地址打开全部网页服务", Foreground = MutedBrush, FontSize = 11, VerticalAlignment = VerticalAlignment.Center };
        Grid.SetColumn(gatewayPortalHint, 1);
        toolbar.Children.Add(gatewayPortalHint);
        root.Children.Add(toolbar);

        gatewayPortalGrid = new UniformGrid { Columns = 2 };
        gatewayPortalGrid.SizeChanged += delegate
        {
            if (gatewayPortalGrid == null) return;
            gatewayPortalGrid.Columns = gatewayPortalGrid.ActualWidth < 760 ? 1 : 2;
        };
        root.Children.Add(gatewayPortalGrid);

        gatewayPortalEmpty = new Border
        {
            Background = SurfaceBrush,
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(12),
            Padding = new Thickness(30, 42, 30, 42),
            Margin = new Thickness(0, 0, 0, 12),
            Visibility = Visibility.Collapsed
        };
        StackPanel empty = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center };
        gatewayPortalEmpty.Child = empty;
        empty.Children.Add(new TextBlock { Text = "还没有添加服务", Foreground = TextBrush, FontSize = 17, FontWeight = FontWeights.SemiBold, HorizontalAlignment = HorizontalAlignment.Center });
        empty.Children.Add(new TextBlock { Text = "添加网页服务后，这里会像手机导航页一样出现一键入口。", Foreground = MutedBrush, FontSize = 12, Margin = new Thickness(0, 8, 0, 14), TextAlignment = TextAlignment.Center, TextWrapping = TextWrapping.Wrap });
        Button add = PrimaryButton("添加第一个服务", AccentBrush);
        add.HorizontalAlignment = HorizontalAlignment.Center;
        add.Click += delegate { ShowGatewayWorkspace("services"); };
        empty.Children.Add(add);
        root.Children.Add(gatewayPortalEmpty);

        return root;
    }

    private StackPanel BuildGatewayOnboarding()
    {
        StackPanel root = new StackPanel { Visibility = Visibility.Visible };

        Border migrateCard = Card();
        migrateCard.Padding = new Thickness(24, 22, 24, 22);
        migrateCard.Margin = new Thickness(0, 0, 0, 14);
        root.Children.Add(migrateCard);
        StackPanel migrateContent = new StackPanel();
        migrateCard.Child = migrateContent;
        migrateContent.Children.Add(new TextBlock { Text = "从旧实例迁移（推荐）", Foreground = TextBrush, FontSize = 18, FontWeight = FontWeights.SemiBold });
        migrateContent.Children.Add(new TextBlock { Text = "保留现有 FRP 来源与域名授权，并把已启用隧道整理成网页服务。", Foreground = MutedBrush, FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 6, 0, 16) });

        migrateContent.Children.Add(GatewayFieldLabel("旧实例"));
        migrateInstanceCombo = new ComboBox { Height = 36, Margin = new Thickness(0, 0, 0, 12) };
        migrateInstanceCombo.SelectionChanged += delegate { Safe(HydrateMigrationDefaults); };
        migrateContent.Children.Add(migrateInstanceCombo);

        Grid deviceFields = new Grid { Margin = new Thickness(0, 0, 0, 2) };
        deviceFields.ColumnDefinitions.Add(new ColumnDefinition());
        deviceFields.ColumnDefinitions.Add(new ColumnDefinition());
        StackPanel nameField = GatewayFieldBlock("设备名称", "这台电脑在导航页上的名称");
        migrateNameInput = GatewayTextBox("");
        nameField.Children.Add(migrateNameInput);
        deviceFields.Children.Add(nameField);
        StackPanel domainField = GatewayFieldBlock("设备主域名", "例如 xps.example.com");
        migrateDomainInput = GatewayTextBox("");
        domainField.Children.Add(migrateDomainInput);
        Grid.SetColumn(domainField, 1);
        domainField.Margin = new Thickness(12, 0, 0, 0);
        deviceFields.Children.Add(domainField);
        migrateContent.Children.Add(deviceFields);

        Grid portRow = new Grid { Margin = new Thickness(0, 10, 0, 0) };
        portRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(190) });
        portRow.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        StackPanel portField = GatewayFieldBlock("统一入口端口", "网页服务共用一个端口");
        migratePortInput = GatewayTextBox("7777");
        portField.Children.Add(migratePortInput);
        portRow.Children.Add(portField);
        StackPanel importField = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Bottom, Margin = new Thickness(18, 0, 0, 8) };
        Grid.SetColumn(importField, 1);
        portRow.Children.Add(importField);
        migrateImportServicesCheck = new CheckBox { Content = "把已启用的旧隧道导入为服务", IsChecked = true, Foreground = TextBrush };
        importField.Children.Add(migrateImportServicesCheck);
        migrateContent.Children.Add(portRow);

        Border warning = new Border { Background = SurfaceBrush, BorderBrush = UiBorderBrush, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(8), Padding = new Thickness(13, 10, 13, 10), Margin = new Thickness(0, 15, 0, 0) };
        warning.Child = new TextBlock
        {
            Text = "切换会停止旧版实例并启用服务入口；原配置和历史仍会保留。",
            Foreground = MutedBrush,
            FontSize = 12,
            TextWrapping = TextWrapping.Wrap
        };
        migrateContent.Children.Add(warning);

        Grid migrateFooter = new Grid { Margin = new Thickness(0, 16, 0, 0) };
        migrateFooter.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        migrateFooter.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        migrateContent.Children.Add(migrateFooter);
        migrateMessage = new TextBlock { Text = "", Foreground = MutedBrush, FontSize = 12, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 16, 0) };
        migrateFooter.Children.Add(migrateMessage);
        migrateButton = PrimaryButton("迁移并进入服务入口", AccentBrush);
        Grid.SetColumn(migrateButton, 1);
        migrateButton.Click += async delegate { await MigrateGatewayAsync(); };
        migrateFooter.Children.Add(migrateButton);

        Border bootstrapCard = Card();
        bootstrapCard.Padding = new Thickness(20, 16, 20, 16);
        root.Children.Add(bootstrapCard);
        StackPanel bootstrap = new StackPanel();
        bootstrapCard.Child = bootstrap;
        TextBlock bootstrapTitle = new TextBlock { Text = "没有旧实例？用 88FRP 密钥新建来源", Foreground = TextBrush, FontWeight = FontWeights.SemiBold };
        Expander bootstrapExpander = new Expander { Header = bootstrapTitle, Content = new StackPanel() };
        bootstrap.Children.Add(bootstrapExpander);
        StackPanel bootstrapFields = (StackPanel)bootstrapExpander.Content;
        bootstrapFields.Margin = new Thickness(0, 2, 0, 0);
        Grid bootstrapRow1 = new Grid { Margin = new Thickness(0, 0, 0, 10) };
        bootstrapRow1.ColumnDefinitions.Add(new ColumnDefinition());
        bootstrapRow1.ColumnDefinitions.Add(new ColumnDefinition());
        StackPanel bootstrapNameField = GatewayFieldBlock("设备名称", "");
        bootstrapNameInput = GatewayTextBox("");
        bootstrapNameField.Children.Add(bootstrapNameInput);
        bootstrapRow1.Children.Add(bootstrapNameField);
        StackPanel bootstrapSecretField = GatewayFieldBlock("88FRP 同步密钥", "只保存在本机");
        bootstrapSecretField.Margin = new Thickness(12, 0, 0, 0);
        bootstrapSecretInput = new PasswordBox { Height = 36 };
        bootstrapSecretField.Children.Add(bootstrapSecretInput);
        Grid.SetColumn(bootstrapSecretField, 1);
        bootstrapRow1.Children.Add(bootstrapSecretField);
        bootstrapFields.Children.Add(bootstrapRow1);
        Grid bootstrapRow2 = new Grid { Margin = new Thickness(0, 0, 0, 10) };
        bootstrapRow2.ColumnDefinitions.Add(new ColumnDefinition());
        bootstrapRow2.ColumnDefinitions.Add(new ColumnDefinition());
        StackPanel bootstrapRemoteField = GatewayFieldBlock("远程服务地址", "留空使用 88FRP 默认节点");
        bootstrapRemoteInput = GatewayTextBox("");
        bootstrapRemoteField.Children.Add(bootstrapRemoteInput);
        bootstrapRow2.Children.Add(bootstrapRemoteField);
        StackPanel bootstrapDomainField = GatewayFieldBlock("设备主域名", "例如 xps.example.com");
        bootstrapDomainField.Margin = new Thickness(12, 0, 0, 0);
        bootstrapDomainInput = GatewayTextBox("");
        bootstrapDomainField.Children.Add(bootstrapDomainInput);
        Grid.SetColumn(bootstrapDomainField, 1);
        bootstrapRow2.Children.Add(bootstrapDomainField);
        bootstrapFields.Children.Add(bootstrapRow2);
        StackPanel bootstrapFooter = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right };
        bootstrapFields.Children.Add(bootstrapFooter);
        bootstrapMessage = new TextBlock { Foreground = MutedBrush, FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 14, 0), VerticalAlignment = VerticalAlignment.Center };
        bootstrapFooter.Children.Add(bootstrapMessage);
        TextBlock portLabel = new TextBlock { Text = "端口", Foreground = MutedBrush, FontSize = 12, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(0, 0, 7, 0) };
        bootstrapFooter.Children.Add(portLabel);
        bootstrapPortInput = GatewayTextBox("7777");
        bootstrapPortInput.Width = 78;
        bootstrapPortInput.Margin = new Thickness(0, 0, 10, 0);
        bootstrapFooter.Children.Add(bootstrapPortInput);
        Button bootstrapButton = PrimaryButton("创建来源", AccentBrush);
        bootstrapButton.Click += async delegate { await BootstrapGatewayAsync(); };
        bootstrapFooter.Children.Add(bootstrapButton);
        return root;
    }

    private static Border GatewayChip(Panel parent, out Border pill, out TextBlock text, string initial)
    {
        pill = new Border
        {
            Background = SurfaceBrush,
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(16),
            Padding = new Thickness(11, 7, 11, 7),
            Margin = new Thickness(0, 0, 7, 7),
            HorizontalAlignment = HorizontalAlignment.Left
        };
        text = new TextBlock { Text = initial, Foreground = MutedBrush, FontSize = 11, TextTrimming = TextTrimming.CharacterEllipsis };
        pill.Child = text;
        parent.Children.Add(pill);
        return pill;
    }

    private static TextBlock GatewayFieldLabel(string label)
    {
        return new TextBlock { Text = label, Foreground = MutedBrush, FontSize = 11, FontWeight = FontWeights.SemiBold, Margin = new Thickness(1, 0, 0, 6) };
    }

    private StackPanel GatewayFieldBlock(string label, string hint)
    {
        StackPanel panel = new StackPanel();
        panel.Children.Add(GatewayFieldLabel(label));
        if (!string.IsNullOrWhiteSpace(hint))
        {
            panel.Children.Add(new TextBlock { Text = hint, Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(1, -2, 0, 6) });
        }
        return panel;
    }

    private static TextBox GatewayTextBox(string text)
    {
        return new TextBox { Text = text ?? "", Height = 36, VerticalContentAlignment = VerticalAlignment.Center };
    }

    private TextBox GatewayEndpointRow(StackPanel parent, string label, string hint, string copySuccess)
    {
        StackPanel field = GatewayFieldBlock(label, hint);
        field.Margin = new Thickness(0, 0, 0, 10);
        parent.Children.Add(field);
        Grid row = new Grid();
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        TextBox box = new TextBox
        {
            IsReadOnly = true,
            Height = 34,
            FontFamily = new FontFamily("Consolas, Microsoft YaHei UI"),
            FontSize = 11,
            VerticalContentAlignment = VerticalAlignment.Center
        };
        row.Children.Add(box);
        Button copy = OutlineButton("复制", TextBrush);
        copy.Margin = new Thickness(8, 0, 0, 0);
        copy.Click += delegate { CopyGatewayText(box.Text, copySuccess); };
        Grid.SetColumn(copy, 1);
        row.Children.Add(copy);
        field.Children.Add(row);
        return box;
    }

    private void ShowGatewayWorkspace(string view)
    {
        if (gatewayWorkspaceRoot == null) return;
        string target = gatewayPages.ContainsKey(view) ? view : "portal";
        if (target != "portal" && !NativeClient.GetBool(gatewayOverviewState, "initialized"))
        {
            target = "portal";
            ShowGatewayMessage("请先完成一次迁移，再管理服务、域名和远程访问。", false, false);
        }
        currentGatewayView = target;
        gatewayWorkspaceRoot.Visibility = Visibility.Visible;
        if (legacyWorkspaceRoot != null)
        {
            legacyWorkspaceRoot.Visibility = Visibility.Collapsed;
            if (unifiedShellRoot != null && unifiedShellRoot.Children.Contains(legacyWorkspaceRoot))
                unifiedShellRoot.Children.Remove(legacyWorkspaceRoot);
        }
        SetGatewayPageVisible(target);
        UpdateGatewayHeaderForView(target);
        foreach (KeyValuePair<string, Button> entry in gatewayNavButtons)
        {
            bool active = string.Equals(entry.Key, target, StringComparison.Ordinal);
            entry.Value.Background = active ? AccentSoftBrush : SurfaceBrush;
            entry.Value.BorderBrush = active ? AccentBrush : UiBorderBrush;
        }
        if (target == "services") RenderGatewayServices();
        if (target == "runtime")
        {
            RenderGatewayRuntime();
            Task ignored = RefreshGatewayLogsAsync();
        }
    }

    private void SetGatewayNavigationEnabled(bool initialized)
    {
        foreach (KeyValuePair<string, Button> entry in gatewayNavButtons)
        {
            entry.Value.IsEnabled = initialized || string.Equals(entry.Key, "portal", StringComparison.Ordinal);
        }
    }

    private void ShowLegacyWorkspace()
    {
        if (legacyWorkspaceRoot == null) return;
        if (unifiedShellRoot != null && !unifiedShellRoot.Children.Contains(legacyWorkspaceRoot))
        {
            Grid.SetColumn(legacyWorkspaceRoot, 1);
            unifiedShellRoot.Children.Add(legacyWorkspaceRoot);
        }
        gatewayWorkspaceRoot.Visibility = Visibility.Collapsed;
        legacyWorkspaceRoot.Visibility = Visibility.Visible;
        foreach (Button button in gatewayNavButtons.Values)
        {
            button.Background = SurfaceBrush;
            button.BorderBrush = UiBorderBrush;
        }
    }

    private void SetGatewayPageVisible(string key)
    {
        Grid active;
        if (gatewayPageHost == null || !gatewayPages.TryGetValue(key, out active)) return;
        foreach (KeyValuePair<string, Grid> entry in gatewayPages)
        {
            entry.Value.Visibility = string.Equals(entry.Key, key, StringComparison.Ordinal) ? Visibility.Visible : Visibility.Collapsed;
        }
        gatewayPageHost.Children.Clear();
        gatewayPageHost.Children.Add(active);
    }

    private void SetGatewayOverviewState(string state)
    {
        if (gatewayOverviewHost == null) return;
        UIElement content;
        if (state == "onboarding") content = gatewayOnboardingView;
        else if (state == "ready") content = gatewayPortalView;
        else content = gatewayLoadingView;
        if (content == null || gatewayOverviewHost.Children.Contains(content)) return;
        gatewayOverviewHost.Children.Clear();
        gatewayOverviewHost.Children.Add(content);
    }

    private void UpdateGatewayHeaderForView(string view)
    {
        if (gatewayPageTitle == null) return;
        if (view == "services")
        {
            gatewayPageTitle.Text = "服务";
            gatewayPageSubtitle.Text = "添加、编辑和启停这台设备上的网页服务。";
        }
        else if (view == "domain")
        {
            gatewayPageTitle.Text = "设置";
            gatewayPageSubtitle.Text = "设备名称、公网地址和连接方式。";
        }
        else if (view == "remote")
        {
            gatewayPageTitle.Text = "远程访问";
            gatewayPageSubtitle.Text = "远程桌面与 SSH 都提供自动、IPv6 专用、IPv4 专用三条线路。";
        }
        else if (view == "runtime")
        {
            gatewayPageTitle.Text = "运行状态";
            gatewayPageSubtitle.Text = "入口健康、最近活动和高级诊断。";
        }
        else
        {
            Dictionary<string, object> device = NativeClient.AsDict(gatewayOverviewState.ContainsKey("device") ? gatewayOverviewState["device"] : null);
            string displayName = GatewayDeviceDisplayName(NativeClient.GetString(device, "name"));
            gatewayPageTitle.Text = displayName == "这台设备" ? "概览" : displayName;
            gatewayPageSubtitle.Text = "所有服务都从这里打开；自动线路优先使用 IPv6。";
        }
    }

    private string CurrentGatewayDomain()
    {
        Dictionary<string, object> device = NativeClient.AsDict(gatewayOverviewState.ContainsKey("device") ? gatewayOverviewState["device"] : null);
        return NativeClient.GetString(device, "domain");
    }

    private static string GatewayDeviceDisplayName(string name)
    {
        string value = (name ?? "").Trim();
        if (value == "") return "这台设备";
        int ignored;
        return int.TryParse(value, out ignored) ? "XPS 主机" : value;
    }

    private int CurrentGatewayPort()
    {
        Dictionary<string, object> device = NativeClient.AsDict(gatewayOverviewState.ContainsKey("device") ? gatewayOverviewState["device"] : null);
        int port = NativeClient.GetInt(device, "gatewayPort");
        return port > 0 ? port : 7777;
    }

    private string GatewayPublicRootUrl()
    {
        Dictionary<string, object> device = NativeClient.AsDict(gatewayOverviewState.ContainsKey("device") ? gatewayOverviewState["device"] : null);
        string url = NativeClient.GetString(device, "publicRootUrl");
        string domain = NativeClient.GetString(device, "domain");
        if (url == "" && domain != "")
        {
            int port = NativeClient.GetInt(device, "gatewayPort");
            url = "https://" + domain + (port == 443 ? "" : ":" + port) + "/";
        }
        return url;
    }

    private void OpenGatewayPortal()
    {
        string url = GatewayPublicRootUrl();
        if (url == "") url = Program.BaseUrl + "/portal";
        OpenGatewayUrl(url);
    }

    private void OpenGatewayAdmin()
    {
        string domain = CurrentGatewayDomain();
        if (domain == "")
        {
            ShowGatewayWorkspace("domain");
            return;
        }
        int port = CurrentGatewayPort();
        OpenGatewayUrl("https://admin." + domain + (port == 443 ? "" : ":" + port) + "/");
    }

    private void OpenGatewayUrl(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return;
        try { Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true }); }
        catch (Exception ex) { ShowGatewayMessage("无法打开链接：" + ex.Message, true, false); }
    }

    private void CopyGatewayText(string text, string success)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        try
        {
            Clipboard.SetText(text);
            ShowGatewayMessage(success, false, true);
        }
        catch (Exception ex)
        {
            ShowGatewayMessage("复制失败：" + ex.Message, true, false);
        }
    }

    private void ShowGatewayMessage(string message, bool error, bool transient)
    {
        if (gatewayBusyBar == null || gatewayBusyText == null) return;
        gatewayBusyText.Text = message ?? "";
        gatewayBusyText.Foreground = error ? DangerBrush : AccentTextBrush;
        gatewayBusyBar.Background = error ? SurfaceBrush : AccentSoftBrush;
        gatewayBusyBar.BorderBrush = error ? DangerBrush : UiBorderBrush;
        gatewayBusyBar.Visibility = string.IsNullOrWhiteSpace(message) ? Visibility.Collapsed : Visibility.Visible;
        if (transient && !string.IsNullOrWhiteSpace(message)) HideGatewayMessageLater(message);
    }

    private async void HideGatewayMessageLater(string original)
    {
        await Task.Delay(3200);
        if (gatewayBusyText != null && string.Equals(gatewayBusyText.Text, original, StringComparison.Ordinal) && !gatewayActionRunning)
        {
            gatewayBusyBar.Visibility = Visibility.Collapsed;
        }
    }

    private async Task<bool> RunGatewayActionAsync(string busyMessage, Func<Dictionary<string, object>> operation, string successMessage)
    {
        if (gatewayActionRunning) return false;
        gatewayActionRunning = true;
        ShowGatewayMessage(busyMessage, false, false);
        Mouse.OverrideCursor = Cursors.Wait;
        try
        {
            await Task.Run(operation);
            await RefreshGatewayStatusAsync(false);
            ShowGatewayMessage(successMessage, false, true);
            return true;
        }
        catch (Exception ex)
        {
            ShowGatewayMessage(ex.Message, true, false);
            return false;
        }
        finally
        {
            gatewayActionRunning = false;
            Mouse.OverrideCursor = null;
        }
    }

    private void LoadGatewayOverviewCache()
    {
        try
        {
            if (!File.Exists(GatewayOverviewCachePath)) return;
            Dictionary<string, object> envelope = NativeClient.AsDict(
                new JavaScriptSerializer().DeserializeObject(File.ReadAllText(GatewayOverviewCachePath, Encoding.UTF8))
            );
            Dictionary<string, object> cached = NativeClient.AsDict(envelope.ContainsKey("overview") ? envelope["overview"] : null);
            if (cached.Count == 0 || !NativeClient.GetBool(cached, "initialized")) return;
            ApplyGatewayOverview(cached, "");
            if (gatewayHeaderStatusText != null)
            {
                string cachedAt = NativeClient.GetString(envelope, "cachedAt");
                DateTime parsed;
                string label = DateTime.TryParse(cachedAt, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out parsed)
                    ? parsed.ToLocalTime().ToString("HH:mm")
                    : File.GetLastWriteTime(GatewayOverviewCachePath).ToString("HH:mm");
                gatewayHeaderStatusText.Text = "上次状态 · " + label;
            }
        }
        catch { }
    }

    private void SaveGatewayOverviewCache()
    {
        try
        {
            if (gatewayOverviewState == null || gatewayOverviewState.Count == 0) return;
            if (gatewayLastCacheWrite != DateTime.MinValue && (DateTime.Now - gatewayLastCacheWrite).TotalSeconds < 30) return;
            Dictionary<string, object> envelope = new Dictionary<string, object>();
            envelope["cachedAt"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            envelope["overview"] = gatewayOverviewState;
            string text = new JavaScriptSerializer().Serialize(envelope);
            string temp = GatewayOverviewCachePath + ".tmp";
            Directory.CreateDirectory(Path.GetDirectoryName(GatewayOverviewCachePath));
            File.WriteAllText(temp, text, Encoding.UTF8);
            if (File.Exists(GatewayOverviewCachePath)) File.Replace(temp, GatewayOverviewCachePath, null);
            else File.Move(temp, GatewayOverviewCachePath);
            gatewayLastCacheWrite = DateTime.Now;
        }
        catch
        {
            try
            {
                string temp = GatewayOverviewCachePath + ".tmp";
                if (File.Exists(temp)) File.Delete(temp);
            }
            catch { }
        }
    }

    private void ApplyGatewayOverview(Dictionary<string, object> overview, string error)
    {
        if (gatewayRailDeviceName == null) return;
        if (!string.IsNullOrWhiteSpace(error))
        {
            gatewayInitialLoadPending = false;
            if (gatewayHasUsableData)
            {
                gatewayRailStatus.Text = "状态更新中";
                gatewayRailStatusDot.Background = AccentBrush;
                SetGatewayOverviewState("ready");
                if (gatewayLoadingView != null) gatewayLoadingView.Visibility = Visibility.Collapsed;
                if (gatewayRefreshButton != null) gatewayRefreshButton.IsEnabled = true;
                if (!gatewayActionRunning) ShowGatewayMessage("暂时没拿到最新状态，先显示上次结果，稍后会自动重试。", false, true);
                return;
            }
            gatewayRailStatus.Text = "暂时未连接";
            gatewayRailStatusDot.Background = DangerBrush;
            SetGatewayOverviewState("loading");
            if (gatewayLoadingView != null) gatewayLoadingView.Visibility = Visibility.Visible;
            if (gatewayLoadingTitle != null) gatewayLoadingTitle.Text = "暂时无法连接后台";
            if (gatewayLoadingDetail != null) gatewayLoadingDetail.Text = "后台可能正在启动或处理其他操作。稍等几秒后重试即可。";
            if (gatewayLoadingRetryButton != null) gatewayLoadingRetryButton.Visibility = Visibility.Visible;
            SetGatewayNavigationEnabled(false);
            if (gatewayOpenPortalButton != null) gatewayOpenPortalButton.IsEnabled = false;
            if (gatewayHeroOpenButton != null) gatewayHeroOpenButton.IsEnabled = false;
            if (gatewayHeroAdminButton != null) gatewayHeroAdminButton.IsEnabled = false;
            if (gatewayRefreshButton != null) gatewayRefreshButton.IsEnabled = true;
            if (!gatewayActionRunning) ShowGatewayMessage("后台暂时没有响应，请稍后重试。", true, false);
            return;
        }

        gatewayOverviewState = overview ?? new Dictionary<string, object>();
        gatewayHasUsableData = true;
        gatewayLastSuccessAt = DateTime.Now;
        gatewayInitialLoadPending = false;
        if (gatewayLoadingView != null) gatewayLoadingView.Visibility = Visibility.Collapsed;
        if (gatewayHeaderStatusText != null) gatewayHeaderStatusText.Text = "本机后台已连接 · " + gatewayLastSuccessAt.ToString("HH:mm:ss");
        bool initialized = NativeClient.GetBool(gatewayOverviewState, "initialized");
        Dictionary<string, object> device = NativeClient.AsDict(gatewayOverviewState.ContainsKey("device") ? gatewayOverviewState["device"] : null);
        Dictionary<string, object> runtime = NativeClient.AsDict(gatewayOverviewState.ContainsKey("runtime") ? gatewayOverviewState["runtime"] : null);
        string caddy = NativeClient.GetNestedString(runtime, "caddy", "status");
        string frpc = NativeClient.GetNestedString(runtime, "frpc", "status");
        string name = NativeClient.GetString(device, "name");
        string domain = NativeClient.GetString(device, "domain");
        int port = NativeClient.GetInt(device, "gatewayPort");
        if (port <= 0) port = 7777;
        if (string.Equals(currentGatewayView, "portal", StringComparison.Ordinal))
        {
            string displayName = GatewayDeviceDisplayName(name);
            gatewayPageTitle.Text = displayName == "这台设备" ? "概览" : displayName;
        }

        gatewayRailDeviceName.Text = GatewayDeviceDisplayName(name);
        gatewayRailDomain.Text = domain == "" ? "尚未设置设备域名" : domain;
        if (!initialized)
        {
            gatewayRailStatus.Text = "待初始化";
            gatewayRailStatusDot.Background = MutedBrush;
            SetGatewayNavigationEnabled(false);
            if (gatewayOpenPortalButton != null) gatewayOpenPortalButton.IsEnabled = false;
            if (gatewayRefreshButton != null) gatewayRefreshButton.IsEnabled = true;
        }
        else if (caddy == "running" && frpc == "running")
        {
            gatewayRailStatus.Text = "入口运行中";
            gatewayRailStatusDot.Background = AccentGreenBrush;
            SetGatewayNavigationEnabled(true);
        }
        else
        {
            gatewayRailStatus.Text = "需要检查";
            gatewayRailStatusDot.Background = DangerBrush;
            SetGatewayNavigationEnabled(true);
        }

        if (gatewayOnboardingView != null) gatewayOnboardingView.Visibility = initialized ? Visibility.Collapsed : Visibility.Visible;
        if (gatewayPortalView != null) gatewayPortalView.Visibility = initialized ? Visibility.Visible : Visibility.Collapsed;
        SetGatewayOverviewState(initialized ? "ready" : "onboarding");
        if (!initialized)
        {
            PopulateGatewayMigration(overview);
            return;
        }

        Dictionary<string, object> ipv6 = NativeClient.AsDict(device.ContainsKey("ipv6Detected") ? device["ipv6Detected"] : null);
        string ipv6Address = NativeClient.GetString(ipv6, "address");
        string connectionLabel = NativeClient.GetNestedString(gatewayOverviewState, "connection", "label");
        if (connectionLabel == "") connectionLabel = "本机";
        string runtimeLabel = caddy == "running" && frpc == "running"
            ? "统一入口已就绪"
            : "运行状态待检查";
        gatewayHeroName.Text = "公开访问地址";
        gatewayHeroDomain.Text = domain == "" ? "尚未设置设备域名" : "https://" + domain + (port == 443 ? "" : ":" + port) + "/";
        Dictionary<string, object> webEndpoints = NativeClient.AsDict(device.ContainsKey("publicEndpoints") ? device["publicEndpoints"] : null);
        string webV6 = NativeClient.GetString(webEndpoints, "ipv6");
        string webV4 = NativeClient.GetString(webEndpoints, "ipv4");
        if (webV6 == "" && domain != "") webV6 = "https://v6." + domain + (port == 443 ? "" : ":" + port);
        if (webV4 == "" && domain != "") webV4 = "https://v4." + domain + (port == 443 ? "" : ":" + port);
        webV6 = GatewayWebUrl(webV6);
        webV4 = GatewayWebUrl(webV4);
        if (gatewayWebV6Box != null) gatewayWebV6Box.Text = domain == "" ? "等待设置域名" : webV6;
        if (gatewayWebV4Box != null) gatewayWebV4Box.Text = domain == "" ? "等待设置域名" : webV4;
        gatewayHeroDescription.Text = domain == ""
            ? "先在「域名与证书」中设置主域名，才能从公网通过 HTTPS 打开服务。"
            : "把这一个地址发给需要访问的人；网络会自动选择 IPv6 或 IPv4，需要排障时可展开手动线路。";
        gatewayHeroConnectionText.Text = connectionLabel;
        gatewayHeroIpv6Text.Text = ipv6Address == "" ? "暂未检测到公网 IPv6" : "IPv6 " + ipv6Address;
        gatewayHeroRuntimeText.Text = runtimeLabel;
        gatewayHeroIpv6Pill.Background = SurfaceBrush;
        gatewayHeroRuntimePill.Background = caddy == "running" && frpc == "running" ? AccentSoftBrush : SurfaceBrush;
        gatewayHeroRuntimeText.Foreground = caddy == "running" && frpc == "running" ? AccentGreenBrush : DangerBrush;
        gatewayHeroOpenButton.IsEnabled = domain != "";
        gatewayHeroAdminButton.IsEnabled = domain != "";
        if (gatewayOpenPortalButton != null) gatewayOpenPortalButton.IsEnabled = domain != "";
        if (gatewayRefreshButton != null) gatewayRefreshButton.IsEnabled = true;

        int serviceCount = 0;
        foreach (object row in NativeClient.AsArray(gatewayOverviewState.ContainsKey("services") ? gatewayOverviewState["services"] : null))
        {
            Dictionary<string, object> service = NativeClient.AsDict(row);
            if (NativeClient.GetString(service, "kind") == "http" && NativeClient.GetBool(service, "enabled")) serviceCount++;
        }
        gatewayPortalServiceCount.Text = serviceCount + " 个入口";
        gatewayPortalHint.Text = domain == "" ? "等待域名与证书" : "一个地址打开全部网页服务";
        string structureSignature = BuildGatewayStructureSignature();
        if (!string.Equals(structureSignature, gatewayStructureSignature, StringComparison.Ordinal))
        {
            gatewayStructureSignature = structureSignature;
            RenderGatewayPortalServices();
            RenderGatewayServices();
            HydrateGatewayDeviceForm(device);
            RenderGatewayCloudflareAndDns(device, ipv6);
            RenderGatewayRemote();
        }
        RenderGatewayRuntime();
        if (!gatewayActionRunning && gatewayBusyBar.Visibility == Visibility.Visible && gatewayBusyText.Foreground == DangerBrush)
        {
            gatewayBusyBar.Visibility = Visibility.Collapsed;
        }
    }

    private string BuildGatewayStructureSignature()
    {
        Dictionary<string, object> snapshot = new Dictionary<string, object>(gatewayOverviewState);
        snapshot.Remove("runtime");
        snapshot.Remove("connection");
        snapshot.Remove("nextSteps");
        Dictionary<string, object> cloudflare = new Dictionary<string, object>(
            NativeClient.AsDict(snapshot.ContainsKey("cloudflare") ? snapshot["cloudflare"] : null)
        );
        cloudflare.Remove("lastCheckAt");
        cloudflare.Remove("lastSyncAt");
        snapshot["cloudflare"] = cloudflare;
        return new JavaScriptSerializer().Serialize(snapshot);
    }

    private void PopulateGatewayMigration(Dictionary<string, object> overview)
    {
        object[] rows = NativeClient.AsArray(overview != null && overview.ContainsKey("legacyInstances") ? overview["legacyInstances"] : null);
        StringBuilder signature = new StringBuilder();
        string selectedId = GetSelectedTag(migrateInstanceCombo);
        foreach (object row in rows)
        {
            Dictionary<string, object> item = NativeClient.AsDict(row);
            signature.Append(NativeClient.GetString(item, "id")).Append('|').Append(NativeClient.GetString(item, "name")).Append(';');
        }
        if (string.Equals(signature.ToString(), gatewayMigrationSignature, StringComparison.Ordinal)) return;
        gatewayMigrationSignature = signature.ToString();
        migrateInstanceCombo.Items.Clear();
        foreach (object row in rows)
        {
            Dictionary<string, object> item = NativeClient.AsDict(row);
            string id = NativeClient.GetString(item, "id");
            string itemName = NativeClient.GetString(item, "name");
            string status = TranslateStatus(NativeClient.GetString(item, "runtimeStatus"));
            ComboBoxItem option = new ComboBoxItem
            {
                Content = itemName + " · " + status + (NativeClient.GetBool(item, "hasConfig") ? "" : " · 缺少配置"),
                Tag = id
            };
            migrateInstanceCombo.Items.Add(option);
            if (id == selectedId) migrateInstanceCombo.SelectedItem = option;
        }
        migrateButton.IsEnabled = rows.Length > 0;
        if (rows.Length == 0)
        {
            ComboBoxItem empty = new ComboBoxItem { Content = "没有可迁移的旧实例", Tag = "" };
            migrateInstanceCombo.Items.Add(empty);
            migrateInstanceCombo.SelectedItem = empty;
        }
        else if (migrateInstanceCombo.SelectedItem == null)
        {
            migrateInstanceCombo.SelectedIndex = 0;
        }
        HydrateMigrationDefaults();
    }

    private void HydrateMigrationDefaults()
    {
        ComboBoxItem item = migrateInstanceCombo == null ? null : migrateInstanceCombo.SelectedItem as ComboBoxItem;
        if (item == null) return;
        string content = Convert.ToString(item.Content);
        int marker = content.IndexOf(" · ", StringComparison.Ordinal);
        string suggested = marker > 0 ? content.Substring(0, marker) : content;
        if (migrateNameInput != null && string.IsNullOrWhiteSpace(migrateNameInput.Text)) migrateNameInput.Text = suggested;
        if (migrateDomainInput != null && string.IsNullOrWhiteSpace(migrateDomainInput.Text))
        {
            migrateDomainInput.Text = "";
        }
    }

    private async Task MigrateGatewayAsync()
    {
        string instanceId = GetSelectedTag(migrateInstanceCombo);
        if (instanceId == "")
        {
            ShowGatewayMessage("请选择一个带有配置的旧实例。", true, false);
            return;
        }
        int port;
        if (!int.TryParse(migratePortInput.Text.Trim(), out port) || port < 1 || port > 65535)
        {
            ShowGatewayMessage("统一入口端口必须是 1 到 65535。", true, false);
            return;
        }
        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["instanceId"] = instanceId;
        payload["name"] = migrateNameInput.Text.Trim();
        payload["domain"] = migrateDomainInput.Text.Trim();
        payload["gatewayPort"] = port;
        payload["importServices"] = migrateImportServicesCheck.IsChecked == true;
        migrateMessage.Text = "正在迁移旧实例并启动统一入口…";
        bool success = await RunGatewayActionAsync(
            "正在迁移旧实例并启动统一入口，期间现有连接会短暂中断…",
            delegate { return client.PostDict("/api/gateway/migrate", payload, 120000); },
            "迁移完成，首页已经切换为服务入口。"
        );
        migrateMessage.Text = success ? "迁移完成。" : "迁移未完成，请查看上方提示。";
    }

    private async Task BootstrapGatewayAsync()
    {
        int port;
        if (!int.TryParse(bootstrapPortInput.Text.Trim(), out port) || port < 1 || port > 65535)
        {
            bootstrapMessage.Text = "端口必须是 1 到 65535。";
            return;
        }
        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["name"] = bootstrapNameInput.Text.Trim();
        payload["secretKey"] = bootstrapSecretInput.Password.Trim();
        string remote = bootstrapRemoteInput.Text.Trim();
        if (remote != "") payload["remoteUrl"] = remote;
        payload["domain"] = bootstrapDomainInput.Text.Trim();
        payload["gatewayPort"] = port;
        bootstrapMessage.Text = "正在创建连接来源…";
        bool success = await RunGatewayActionAsync(
            "正在创建新的 88FRP 连接来源并初始化统一入口…",
            delegate { return client.PostDict("/api/gateway/bootstrap", payload, 120000); },
            "统一入口已创建。"
        );
        if (success)
        {
            bootstrapSecretInput.Password = "";
            bootstrapMessage.Text = "创建完成。";
        }
        else
        {
            bootstrapMessage.Text = "创建未完成，请查看上方提示。";
        }
    }

    private UIElement BuildGatewayServicesPage()
    {
        StackPanel root = new StackPanel { Margin = new Thickness(0, 0, 6, 12) };

        Border intro = Card();
        intro.Padding = new Thickness(18, 15, 18, 15);
        intro.Margin = new Thickness(0, 0, 0, 14);
        root.Children.Add(intro);
        Grid introGrid = new Grid();
        introGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        introGrid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        intro.Child = introGrid;
        StackPanel introCopy = new StackPanel();
        introGrid.Children.Add(introCopy);
        introCopy.Children.Add(new TextBlock { Text = "所有网页服务共用一个入口", Foreground = TextBrush, FontSize = 15, FontWeight = FontWeights.SemiBold });
        gatewayServiceAddressText = new TextBlock { Text = "统一入口地址正在读取…", Foreground = AccentTextBrush, FontSize = 11, FontFamily = new FontFamily("Consolas, Microsoft YaHei UI"), TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 6, 16, 0), LineHeight = 18 };
        introCopy.Children.Add(gatewayServiceAddressText);
        introCopy.Children.Add(new TextBlock { Text = "新增网页服务时只需填写本机端口，域名和 HTTPS 会自动配置。", Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 5, 16, 0) });
        Button add = PrimaryButton("+  添加服务", AccentBrush);
        Grid.SetColumn(add, 1);
        add.VerticalAlignment = VerticalAlignment.Center;
        add.Click += async delegate { await EditGatewayServiceAsync(null); };
        introGrid.Children.Add(add);

        gatewayServiceList = new StackPanel();
        root.Children.Add(gatewayServiceList);
        return GatewayPageScroll(root);
    }

    private void RenderGatewayPortalServices()
    {
        if (gatewayPortalGrid == null) return;
        gatewayPortalGrid.Children.Clear();
        int count = 0;
        int index = 0;
        foreach (object row in NativeClient.AsArray(gatewayOverviewState.ContainsKey("services") ? gatewayOverviewState["services"] : null))
        {
            Dictionary<string, object> service = NativeClient.AsDict(row);
            if (NativeClient.GetString(service, "kind") != "http" || !NativeClient.GetBool(service, "enabled")) continue;
            gatewayPortalGrid.Children.Add(BuildPortalServiceCard(service, index));
            index++;
            count++;
        }
        gatewayPortalGrid.Visibility = count > 0 ? Visibility.Visible : Visibility.Collapsed;
        if (count > 0)
        {
            if (gatewayPortalRoot != null && gatewayPortalRoot.Children.Contains(gatewayPortalEmpty))
            {
                gatewayPortalRoot.Children.Remove(gatewayPortalEmpty);
            }
        }
        else
        {
            gatewayPortalEmpty.Visibility = Visibility.Visible;
            if (gatewayPortalRoot != null && !gatewayPortalRoot.Children.Contains(gatewayPortalEmpty))
            {
                int gridIndex = gatewayPortalRoot.Children.IndexOf(gatewayPortalGrid);
                if (gridIndex >= 0) gatewayPortalRoot.Children.Insert(gridIndex + 1, gatewayPortalEmpty);
                else gatewayPortalRoot.Children.Add(gatewayPortalEmpty);
            }
        }
    }

    private Border BuildPortalServiceCard(Dictionary<string, object> service, int index)
    {
        string title = GatewayDisplayTitle(service);
        string url = NativeClient.GetString(service, "url");
        string tag = GatewayDisplayTag(service);
        string description = GatewayDisplayDescription(service);
        bool offline = GatewayServiceOffline(service);
        bool online = GatewayServiceOnline(service);
        // Public HTTPS availability is independent from the local health probe.
        // A temporarily stopped local app must not turn a valid public link into a dead button.
        bool canOpen = GatewayUrlUsable(url);

        Border card = Card();
        card.Margin = new Thickness(0, 0, 7, 14);
        card.Padding = new Thickness(18, 17, 18, 16);
        card.Background = SurfaceBrush;
        Grid grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(43) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        card.Child = grid;
        Border icon = new Border { Width = 40, Height = 40, CornerRadius = new CornerRadius(10), Background = AccentSoftBrush, VerticalAlignment = VerticalAlignment.Top };
        icon.Child = new TextBlock { Text = "↗", Foreground = AccentTextBrush, FontSize = 21, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        grid.Children.Add(icon);
        StackPanel copy = new StackPanel { Margin = new Thickness(12, 0, 0, 0) };
        Grid.SetColumn(copy, 1);
        grid.Children.Add(copy);
        Grid heading = new Grid();
        heading.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        heading.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        copy.Children.Add(heading);
        TextBlock titleText = new TextBlock { Text = title, Foreground = TextBrush, FontSize = 16, FontWeight = FontWeights.SemiBold, TextTrimming = TextTrimming.CharacterEllipsis, Margin = new Thickness(0, 0, 8, 0) };
        heading.Children.Add(titleText);
        Border state = new Border { Background = online ? AccentSoftBrush : SurfaceBrush, BorderBrush = UiBorderBrush, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(10), Padding = new Thickness(7, 2, 7, 2) };
        TextBlock stateText = new TextBlock
        {
            Text = offline ? "本机未响应" : online ? "在线" : "待检查",
            Foreground = offline ? DangerBrush : online ? AccentGreenBrush : MutedBrush,
            FontSize = 11
        };
        state.Child = stateText;
        Grid.SetColumn(state, 1);
        heading.Children.Add(state);
        copy.Children.Add(new TextBlock { Text = tag, Foreground = MutedBrush, FontSize = 11, Margin = new Thickness(0, 3, 0, 0) });
        if (!string.IsNullOrWhiteSpace(description))
        {
            copy.Children.Add(new TextBlock { Text = description, Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, MaxHeight = 34, TextTrimming = TextTrimming.CharacterEllipsis, Margin = new Thickness(0, 5, 0, 0) });
        }
        TextBlock address = new TextBlock
        {
            Text = string.IsNullOrWhiteSpace(url) ? "链接尚未生成" : url,
            Foreground = canOpen ? AccentTextBrush : MutedBrush,
            FontSize = 11,
            TextTrimming = TextTrimming.CharacterEllipsis,
            Cursor = canOpen ? Cursors.Hand : Cursors.Arrow,
            Margin = new Thickness(0, 8, 0, 10),
            ToolTip = string.IsNullOrWhiteSpace(url) ? "" : url
        };
        if (canOpen) address.MouseLeftButtonUp += delegate { OpenGatewayUrl(url); };
        copy.Children.Add(address);
        StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal };
        copy.Children.Add(actions);
        Button open = PrimaryButton("打开", AccentBrush);
        open.MinWidth = 66;
        open.Height = 31;
        open.Padding = new Thickness(12, 0, 12, 0);
        open.Margin = new Thickness(0, 0, 6, 0);
        open.IsEnabled = canOpen;
        open.ToolTip = canOpen ? (offline ? "本机服务当前未响应，仍可尝试打开公网链接。" : "") : "服务链接尚未就绪。";
        open.Click += delegate { OpenGatewayUrl(url); };
        actions.Children.Add(open);
        Button copyUrl = OutlineButton("复制", TextBrush);
        copyUrl.MinWidth = 58;
        copyUrl.Height = 31;
        copyUrl.Padding = new Thickness(10, 0, 10, 0);
        copyUrl.Margin = new Thickness(0);
        copyUrl.IsEnabled = !string.IsNullOrWhiteSpace(url);
        copyUrl.Click += delegate { CopyGatewayText(url, "服务链接已复制。"); };
        actions.Children.Add(copyUrl);
        return card;
    }

    private void RenderGatewayServices()
    {
        if (gatewayServiceList == null) return;
        gatewayServiceList.Children.Clear();
        Dictionary<string, object> device = NativeClient.AsDict(gatewayOverviewState.ContainsKey("device") ? gatewayOverviewState["device"] : null);
        string domain = NativeClient.GetString(device, "domain");
        int port = NativeClient.GetInt(device, "gatewayPort");
        if (port <= 0) port = 7777;
        if (gatewayServiceAddressText != null)
        {
            gatewayServiceAddressText.Text = domain == ""
                ? "尚未设置设备域名。服务会先写在本机，设置域名后再从公网访问。"
                : "所有网页服务统一从 https://" + domain + (port == 443 ? "" : ":" + port) + "/ 打开，新增服务会自动加入导航页。";
        }
        object[] services = NativeClient.AsArray(gatewayOverviewState.ContainsKey("services") ? gatewayOverviewState["services"] : null);
        if (services.Length == 0)
        {
            Border empty = Card();
            empty.Padding = new Thickness(24, 30, 24, 30);
            StackPanel emptyContent = new StackPanel { HorizontalAlignment = HorizontalAlignment.Center };
            empty.Child = emptyContent;
            emptyContent.Children.Add(new TextBlock { Text = "还没有服务", Foreground = TextBrush, FontSize = 17, FontWeight = FontWeights.SemiBold, HorizontalAlignment = HorizontalAlignment.Center });
            emptyContent.Children.Add(new TextBlock { Text = "网页服务使用子域名；远程桌面等直连服务使用独立端口。", Foreground = MutedBrush, FontSize = 12, Margin = new Thickness(0, 6, 0, 14), TextWrapping = TextWrapping.Wrap, TextAlignment = TextAlignment.Center });
            Button add = PrimaryButton("添加服务", AccentBrush);
            add.HorizontalAlignment = HorizontalAlignment.Center;
            add.Click += async delegate { await EditGatewayServiceAsync(null); };
            emptyContent.Children.Add(add);
            gatewayServiceList.Children.Add(empty);
            return;
        }
        List<Dictionary<string, object>> webServices = new List<Dictionary<string, object>>();
        List<Dictionary<string, object>> directServices = new List<Dictionary<string, object>>();
        List<Dictionary<string, object>> disabledServices = new List<Dictionary<string, object>>();
        foreach (object row in services)
        {
            Dictionary<string, object> service = NativeClient.AsDict(row);
            if (!NativeClient.GetBool(service, "enabled")) disabledServices.Add(service);
            else if (NativeClient.GetString(service, "kind") == "http") webServices.Add(service);
            else directServices.Add(service);
        }
        if (webServices.Count > 0)
        {
            AddGatewayServiceSection("网页服务", webServices.Count + " 个入口");
            foreach (Dictionary<string, object> service in webServices) gatewayServiceList.Children.Add(BuildManagedServiceCard(service));
        }
        if (directServices.Count > 0)
        {
            AddGatewayServiceSection("直连服务", directServices.Count + " 个独立端口");
            foreach (Dictionary<string, object> service in directServices) gatewayServiceList.Children.Add(BuildManagedServiceCard(service));
        }
        if (disabledServices.Count > 0)
        {
            AddGatewayServiceSection("未发布", disabledServices.Count + " 个服务保留配置，不生成公网入口");
            foreach (Dictionary<string, object> service in disabledServices) gatewayServiceList.Children.Add(BuildManagedServiceCard(service));
        }
    }

    private void AddGatewayServiceSection(string title, string subtitle)
    {
        Grid heading = new Grid { Margin = new Thickness(2, gatewayServiceList.Children.Count == 0 ? 0 : 10, 2, 9) };
        heading.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        heading.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        TextBlock titleText = new TextBlock { Text = title, Foreground = TextBrush, FontSize = 16, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center };
        heading.Children.Add(titleText);
        TextBlock subtitleText = new TextBlock { Text = subtitle, Foreground = MutedBrush, FontSize = 12, Margin = new Thickness(10, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis };
        Grid.SetColumn(subtitleText, 1);
        heading.Children.Add(subtitleText);
        gatewayServiceList.Children.Add(heading);
    }

    private Border BuildManagedServiceCard(Dictionary<string, object> service)
    {
        bool enabled = NativeClient.GetBool(service, "enabled");
        bool isUdp = NativeClient.GetString(service, "kind") == "udp";
        bool isTcp = NativeClient.GetString(service, "kind") == "tcp";
        bool direct = isUdp || isTcp;
        string title = GatewayDisplayTitle(service);
        string url = NativeClient.GetString(service, isTcp ? "tcpEndpoint" : isUdp ? "endpoint" : "url");
        string tag = GatewayDisplayTag(service);
        string name = NativeClient.GetString(service, "name");
        string description = GatewayDisplayDescription(service);
        bool offline = GatewayServiceOffline(service);
        bool online = GatewayServiceOnline(service);
        // The public URL remains a valid browser target even when the local probe is slow or fails.
        bool canOpen = enabled && !direct && GatewayUrlUsable(url);
        bool canCopy = enabled && !string.IsNullOrWhiteSpace(url);

        Border card = Card();
        card.Padding = new Thickness(18, 15, 18, 15);
        card.Margin = new Thickness(0, 0, 0, 10);
        card.Background = enabled ? SurfaceBrush : CardBrush;
        Grid grid = new Grid();
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        card.Child = grid;
        StackPanel copy = new StackPanel();
        grid.Children.Add(copy);
        StackPanel titleRow = new StackPanel { Orientation = Orientation.Horizontal };
        copy.Children.Add(titleRow);
        titleRow.Children.Add(new TextBlock { Text = title, Foreground = TextBrush, FontSize = 15, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
        Border kindPill = new Border { Background = AccentSoftBrush, CornerRadius = new CornerRadius(9), Padding = new Thickness(7, 2, 7, 2), Margin = new Thickness(8, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        kindPill.Child = new TextBlock { Text = direct ? "直连" : "网页", Foreground = AccentTextBrush, FontSize = 11 };
        titleRow.Children.Add(kindPill);
        if (!enabled)
        {
            Border disabledPill = new Border { Background = SurfaceBrush, BorderBrush = UiBorderBrush, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(9), Padding = new Thickness(7, 2, 7, 2), Margin = new Thickness(6, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            disabledPill.Child = new TextBlock { Text = "已停用", Foreground = MutedBrush, FontSize = 11 };
            titleRow.Children.Add(disabledPill);
        }
        else if (!direct)
        {
            Border statePill = new Border { Background = online ? AccentSoftBrush : SurfaceBrush, BorderBrush = UiBorderBrush, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(9), Padding = new Thickness(7, 2, 7, 2), Margin = new Thickness(6, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
            statePill.Child = new TextBlock { Text = offline ? "本机未响应" : online ? "在线" : "待检查", Foreground = offline ? DangerBrush : online ? AccentGreenBrush : MutedBrush, FontSize = 11 };
            titleRow.Children.Add(statePill);
        }
        string meta = direct
            ? "公网端口 " + NativeClient.GetInt(service, "remotePort")
            : "访问地址 " + name + "." + (CurrentGatewayDomain() == "" ? "设备域名" : CurrentGatewayDomain());
        copy.Children.Add(new TextBlock { Text = meta, Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 5, 0, 0) });
        if (!string.IsNullOrWhiteSpace(description)) copy.Children.Add(new TextBlock { Text = description, Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 3, 0, 0) });
        if (!string.IsNullOrWhiteSpace(url))
        {
            TextBlock address = new TextBlock { Text = url, Foreground = canOpen ? AccentTextBrush : MutedBrush, FontSize = 11, TextTrimming = TextTrimming.CharacterEllipsis, Margin = new Thickness(0, 6, 20, 0), Cursor = canOpen ? Cursors.Hand : Cursors.Arrow };
            if (canOpen) address.MouseLeftButtonUp += delegate { OpenGatewayUrl(url); };
            copy.Children.Add(address);
        }
        StackPanel actions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 9, 0, 0) };
        Grid.SetRow(actions, 1);
        grid.Children.Add(actions);
        if (!direct && enabled)
        {
            Button open = OutlineButton("打开", TextBrush);
            open.Height = 31;
            open.MinWidth = 58;
            open.Margin = new Thickness(0, 0, 5, 0);
            open.IsEnabled = canOpen;
            open.ToolTip = canOpen ? (offline ? "本机服务当前未响应，仍可尝试打开公网链接。" : "") : !enabled ? "服务尚未发布。" : "服务链接尚未就绪。";
            open.Click += delegate { OpenGatewayUrl(url); };
            actions.Children.Add(open);
        }
        else if (direct && enabled)
        {
            Button copyEndpoint = OutlineButton("复制地址", TextBrush);
            copyEndpoint.Height = 31;
            copyEndpoint.Margin = new Thickness(0, 0, 5, 0);
            copyEndpoint.IsEnabled = canCopy;
        copyEndpoint.Click += delegate { CopyGatewayText(url, "连接地址已复制。"); };
            actions.Children.Add(copyEndpoint);
        }
        Button edit = OutlineButton("编辑", TextBrush);
        edit.Height = 31;
        edit.MinWidth = 58;
        edit.Margin = new Thickness(0, 0, 5, 0);
        edit.Click += async delegate { await EditGatewayServiceAsync(service); };
        actions.Children.Add(edit);
        Button toggle = OutlineButton(enabled ? "停用" : "启用", enabled ? DangerBrush : AccentGreenBrush);
        toggle.Height = 31;
        toggle.MinWidth = 58;
        toggle.Margin = new Thickness(0);
        toggle.Click += async delegate { await ToggleGatewayServiceAsync(service); };
        actions.Children.Add(toggle);
        return card;
    }

    private static string GatewayDisplayTitle(Dictionary<string, object> service)
    {
        string name = NativeClient.GetString(service, "name");
        string[] metadata;
        if (GatewayServiceMetadata.TryGetValue(name, out metadata)) return metadata[0];
        string title = NativeClient.GetString(service, "title");
        return string.IsNullOrWhiteSpace(title) ? (string.IsNullOrWhiteSpace(name) ? "网页服务" : name) : title.Trim();
    }

    private static string GatewayDisplayTag(Dictionary<string, object> service)
    {
        string[] metadata;
        if (GatewayServiceMetadata.TryGetValue(NativeClient.GetString(service, "name"), out metadata)) return metadata[1];
        string tag = NativeClient.GetString(service, "tag");
        if (string.IsNullOrWhiteSpace(tag) || string.Equals(tag, "旧服务", StringComparison.Ordinal))
            return NativeClient.GetString(service, "kind") == "http" ? "网页服务" : tag;
        return tag;
    }

    private static string GatewayDisplayDescription(Dictionary<string, object> service)
    {
        string[] metadata;
        if (GatewayServiceMetadata.TryGetValue(NativeClient.GetString(service, "name"), out metadata)) return metadata[2];
        string description = NativeClient.GetString(service, "description");
        return description.StartsWith("从旧版隧道导入", StringComparison.Ordinal) ? "" : description;
    }

    private static bool GatewayServiceOffline(Dictionary<string, object> service)
    {
        object value = service.ContainsKey("online") ? service["online"] : null;
        return value is bool && !(bool)value;
    }

    private static bool GatewayServiceOnline(Dictionary<string, object> service)
    {
        object value = service.ContainsKey("online") ? service["online"] : null;
        return value is bool && (bool)value;
    }

    private static bool GatewayUrlUsable(string url)
    {
        if (string.IsNullOrWhiteSpace(url)) return false;
        Uri parsed;
        return Uri.TryCreate(url, UriKind.Absolute, out parsed)
            && (parsed.Scheme == Uri.UriSchemeHttps || parsed.Scheme == Uri.UriSchemeHttp)
            && !string.IsNullOrWhiteSpace(parsed.Host);
    }

    private async Task EditGatewayServiceAsync(Dictionary<string, object> service)
    {
        GatewayServiceEditorWindow dialog = new GatewayServiceEditorWindow(service) { Owner = this };
        if (dialog.ShowDialog() != true) return;
        Dictionary<string, object> payload = dialog.Result;
        string id = NativeClient.GetString(service ?? new Dictionary<string, object>(), "id");
        bool success = await RunGatewayActionAsync(
            id == "" ? "正在添加服务并应用网络配置…" : "正在保存服务并应用新配置…",
            delegate {
                return id == "" ? client.PostDict("/api/gateway/services", payload, 60000) : client.PutDict("/api/gateway/services/" + Uri.EscapeDataString(id), payload, 60000);
            },
            id == "" ? "服务已添加。" : "服务已更新。"
        );
        if (success) RenderGatewayServices();
    }

    private async Task ToggleGatewayServiceAsync(Dictionary<string, object> service)
    {
        string id = NativeClient.GetString(service, "id");
        if (id == "") return;
        Dictionary<string, object> payload = ServicePayload(service, !NativeClient.GetBool(service, "enabled"));
        await RunGatewayActionAsync(
            NativeClient.GetBool(service, "enabled") ? "正在停用服务…" : "正在启用服务…",
            delegate { return client.PutDict("/api/gateway/services/" + Uri.EscapeDataString(id), payload, 60000); },
            NativeClient.GetBool(service, "enabled") ? "服务已停用。" : "服务已启用。"
        );
    }

    private static Dictionary<string, object> ServicePayload(Dictionary<string, object> service, bool enabled)
    {
        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["kind"] = NativeClient.GetString(service, "kind");
        payload["name"] = NativeClient.GetString(service, "name");
        payload["title"] = NativeClient.GetString(service, "title");
        payload["tag"] = NativeClient.GetString(service, "tag");
        payload["description"] = NativeClient.GetString(service, "description");
        payload["localHost"] = NativeClient.GetString(service, "localHost");
        payload["localPort"] = NativeClient.GetInt(service, "localPort");
        payload["remotePort"] = NativeClient.GetInt(service, "remotePort");
        payload["enabled"] = enabled;
        return payload;
    }

    private UIElement BuildGatewayDomainPage()
    {
        StackPanel root = new StackPanel { Margin = new Thickness(0, 0, 6, 12) };

        Border deviceCard = Card();
        deviceCard.Padding = new Thickness(20, 18, 20, 18);
        deviceCard.Margin = new Thickness(0, 0, 0, 14);
        root.Children.Add(deviceCard);
        StackPanel device = new StackPanel();
        deviceCard.Child = device;
        device.Children.Add(new TextBlock { Text = "设备", Foreground = TextBrush, FontSize = 18, FontWeight = FontWeights.SemiBold });
        device.Children.Add(new TextBlock { Text = "日常只需要维护名称、域名和自动启动。网络细节已收进高级设置。", Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, LineHeight = 18, Margin = new Thickness(0, 4, 0, 15) });

        StackPanel nameField = GatewayFieldBlock("设备名称", "显示在入口页上的名称");
        gatewayDeviceNameInput = GatewayTextBox("");
        nameField.Children.Add(gatewayDeviceNameInput);
        device.Children.Add(nameField);
        StackPanel domainField = GatewayFieldBlock("设备主域名", "例如 xps.example.com");
        domainField.Margin = new Thickness(0, 10, 0, 0);
        gatewayDeviceDomainInput = GatewayTextBox("");
        domainField.Children.Add(gatewayDeviceDomainInput);
        device.Children.Add(domainField);
        StackPanel portField = GatewayFieldBlock("统一入口端口", "网页服务共用一个端口");
        portField.Margin = new Thickness(0, 10, 0, 0);
        gatewayDevicePortInput = GatewayTextBox("7777");
        portField.Children.Add(gatewayDevicePortInput);
        device.Children.Add(portField);
        StackPanel ipv6Field = GatewayFieldBlock("IPv6 检测", "自动检测失败时可手填");
        ipv6Field.Margin = new Thickness(0, 10, 0, 0);
        gatewayIpv6ModeCombo = new ComboBox { Height = 36 };
        gatewayIpv6ModeCombo.Items.Add(new ComboBoxItem { Content = "自动检测公网 IPv6", Tag = "auto" });
        gatewayIpv6ModeCombo.Items.Add(new ComboBoxItem { Content = "手动填写 IPv6", Tag = "manual" });
        gatewayIpv6ModeCombo.SelectedIndex = 0;
        gatewayIpv6ModeCombo.SelectionChanged += delegate {
            if (gatewayManualIpv6Field != null)
                gatewayManualIpv6Field.Visibility = GetSelectedTag(gatewayIpv6ModeCombo) == "manual" ? Visibility.Visible : Visibility.Collapsed;
        };
        ipv6Field.Children.Add(gatewayIpv6ModeCombo);
        device.Children.Add(ipv6Field);

        gatewayManualIpv6Field = GatewayFieldBlock("手动公网 IPv6", "只在自动检测不到时填写");
        gatewayManualIpv6Field.Margin = new Thickness(0, 10, 0, 0);
        gatewayManualIpv6Input = GatewayTextBox("");
        ((StackPanel)gatewayManualIpv6Field).Children.Add(gatewayManualIpv6Input);
        gatewayManualIpv6Field.Visibility = Visibility.Collapsed;
        device.Children.Add(gatewayManualIpv6Field);

        gatewayAutoStartCheck = new CheckBox { Content = "登录 Windows 后自动恢复服务入口", IsChecked = true, Foreground = TextBrush, Margin = new Thickness(0, 14, 0, 0) };
        device.Children.Add(gatewayAutoStartCheck);
        Grid actions = new Grid { Margin = new Thickness(0, 16, 0, 0) };
        actions.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        actions.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        device.Children.Add(actions);
        gatewayDeviceStatusText = new TextBlock { Text = "", Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
        actions.Children.Add(gatewayDeviceStatusText);
        Button save = PrimaryButton("保存设备设置", AccentBrush);
        save.Click += async delegate { await SaveGatewayDeviceAsync(); };
        Grid.SetColumn(save, 1);
        actions.Children.Add(save);

        Border cloudflareCard = Card();
        cloudflareCard.Padding = new Thickness(20, 18, 20, 18);
        cloudflareCard.Margin = new Thickness(0, 0, 0, 14);
        root.Children.Add(cloudflareCard);
        StackPanel cloudflare = new StackPanel();
        cloudflareCard.Child = cloudflare;
        StackPanel cfHeading = new StackPanel { Orientation = Orientation.Horizontal };
        cloudflare.Children.Add(cfHeading);
        cfHeading.Children.Add(new TextBlock { Text = "域名与证书", Foreground = TextBrush, FontSize = 18, FontWeight = FontWeights.SemiBold });
        gatewayCloudflareStatusText = new TextBlock { Text = "未授权", Foreground = MutedBrush, FontSize = 11, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(12, 1, 0, 0) };
        cfHeading.Children.Add(gatewayCloudflareStatusText);
        cloudflare.Children.Add(new TextBlock
        {
            Text = "地址变化会自动同步解析，HTTPS 证书也会自动续期。",
            Foreground = MutedBrush,
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            LineHeight = 18,
            Margin = new Thickness(0, 4, 0, 10)
        });
        gatewayCloudflareDetailText = new TextBlock { Text = "", Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, LineHeight = 18, Margin = new Thickness(0, 0, 0, 10) };
        cloudflare.Children.Add(gatewayCloudflareDetailText);
        Expander tokenDetails = new Expander { Header = "域名授权设置", Foreground = TextBrush, IsExpanded = false, Margin = new Thickness(0, 2, 0, 0) };
        StackPanel tokenContent = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
        tokenDetails.Content = tokenContent;
        tokenContent.Children.Add(new TextBlock { Text = "只有更换域名或授权失效时才需要重新填写。授权码只保存在本机。", Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 8) });
        gatewayCloudflareTokenInput = new PasswordBox { Height = 36 };
        tokenContent.Children.Add(gatewayCloudflareTokenInput);
        Button saveToken = PrimaryButton("验证并保存", AccentBrush);
        saveToken.HorizontalAlignment = HorizontalAlignment.Left;
        saveToken.Margin = new Thickness(0, 9, 0, 0);
        saveToken.Click += async delegate { await SaveGatewayCloudflareTokenAsync(); };
        tokenContent.Children.Add(saveToken);
        cloudflare.Children.Add(tokenDetails);

        Border dnsCard = Card();
        dnsCard.Padding = new Thickness(20, 18, 20, 18);
        dnsCard.Margin = new Thickness(0, 0, 0, 14);
        root.Children.Add(dnsCard);
        StackPanel dns = new StackPanel();
        dnsCard.Child = dns;
        Grid dnsHeading = new Grid();
        dnsHeading.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        dnsHeading.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        dns.Children.Add(dnsHeading);
        StackPanel dnsTitle = new StackPanel();
        dnsHeading.Children.Add(dnsTitle);
        dnsTitle.Children.Add(new TextBlock { Text = "公网地址自动跟随", Foreground = TextBrush, FontSize = 16, FontWeight = FontWeights.SemiBold });
        gatewayDnsStatusText = new TextBlock { Text = "正在读取…", Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 4, 0, 0) };
        dnsTitle.Children.Add(gatewayDnsStatusText);
        Button sync = OutlineButton("立即同步", TextBrush);
        Grid.SetColumn(sync, 1);
        sync.VerticalAlignment = VerticalAlignment.Center;
        sync.Click += async delegate { await SyncGatewayDnsAsync(); };
        dnsHeading.Children.Add(sync);
        Expander dnsDetails = new Expander { Header = "DNS 记录（高级）", Foreground = TextBrush, IsExpanded = false, Margin = new Thickness(0, 12, 0, 0) };
        gatewayDnsRecordPanel = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
        dnsDetails.Content = gatewayDnsRecordPanel;
        dns.Children.Add(dnsDetails);

        Border advancedCard = Card();
        advancedCard.Padding = new Thickness(18, 14, 18, 14);
        root.Children.Add(advancedCard);
        Expander advanced = new Expander { Header = "高级与诊断", Foreground = TextBrush, IsExpanded = false };
        advancedCard.Child = advanced;
        StackPanel advancedContent = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
        advanced.Content = advancedContent;
        WrapPanel advancedActions = new WrapPanel { Margin = new Thickness(0, 0, 0, 10) };
        advancedContent.Children.Add(advancedActions);
        Button runtime = OutlineButton("运行状态与日志", TextBrush);
        runtime.Margin = new Thickness(0, 0, 8, 6);
        runtime.Click += delegate { ShowGatewayWorkspace("runtime"); };
        advancedActions.Children.Add(runtime);
        Button syncSource = OutlineButton("重新连接来源", TextBrush);
        syncSource.Margin = new Thickness(0, 0, 8, 6);
        syncSource.Click += async delegate { await SyncGatewaySourceAsync(); };
        advancedActions.Children.Add(syncSource);
        Button restart = OutlineButton("重启服务", DangerBrush);
        restart.Margin = new Thickness(0, 0, 0, 6);
        restart.Click += async delegate { await RestartGatewayAsync(); };
        advancedActions.Children.Add(restart);
        advancedContent.Children.Add(BuildGatewayFirewallCard());
        advancedContent.Children.Add(BuildGatewayRelayCard());
        return GatewayPageScroll(root);
    }

    private void HydrateGatewayDeviceForm(Dictionary<string, object> device)
    {
        if (gatewayDeviceFormHydrated || gatewayDeviceNameInput == null) return;
        gatewayDeviceNameInput.Text = GatewayDeviceDisplayName(NativeClient.GetString(device, "name"));
        gatewayDeviceDomainInput.Text = NativeClient.GetString(device, "domain");
        gatewayDevicePortInput.Text = NativeClient.GetInt(device, "gatewayPort").ToString();
        string mode = NativeClient.GetString(device, "ipv6Mode");
        SelectComboByTag(gatewayIpv6ModeCombo, mode == "" ? "auto" : mode);
        gatewayManualIpv6Input.Text = NativeClient.GetString(device, "manualIpv6");
        gatewayManualIpv6Field.Visibility = mode == "manual" ? Visibility.Visible : Visibility.Collapsed;
        gatewayAutoStartCheck.IsChecked = !device.ContainsKey("autoStart") || NativeClient.GetBool(device, "autoStart");
        gatewayDeviceFormHydrated = true;
    }

    private async Task SaveGatewayDeviceAsync()
    {
        int port;
        if (!int.TryParse(gatewayDevicePortInput.Text.Trim(), out port) || port < 1 || port > 65535)
        {
            gatewayDeviceStatusText.Text = "端口必须是 1 到 65535。";
            gatewayDeviceStatusText.Foreground = DangerBrush;
            return;
        }
        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["name"] = gatewayDeviceNameInput.Text.Trim();
        payload["domain"] = gatewayDeviceDomainInput.Text.Trim();
        payload["gatewayPort"] = port;
        payload["ipv6Mode"] = GetSelectedTag(gatewayIpv6ModeCombo) == "manual" ? "manual" : "auto";
        payload["manualIpv6"] = gatewayManualIpv6Input.Text.Trim();
        payload["autoStart"] = gatewayAutoStartCheck.IsChecked == true;
        gatewayDeviceStatusText.Text = "正在保存并应用配置…";
        gatewayDeviceStatusText.Foreground = MutedBrush;
        bool success = await RunGatewayActionAsync(
            "正在保存设备设置并应用网络配置…",
            delegate { return client.PutDict("/api/gateway/device", payload, 60000); },
            "设备设置已保存。"
        );
        gatewayDeviceFormHydrated = false;
        gatewayDeviceStatusText.Text = success ? "设备设置已保存。" : "保存失败，请查看上方提示。";
        gatewayDeviceStatusText.Foreground = success ? AccentGreenBrush : DangerBrush;
    }

    private async Task SaveGatewayCloudflareTokenAsync()
    {
        string token = gatewayCloudflareTokenInput.Password.Trim();
        if (token == "")
        {
            ShowGatewayMessage("请先粘贴 Cloudflare Token。", true, false);
            return;
        }
        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["token"] = token;
        payload["domain"] = gatewayDeviceDomainInput.Text.Trim();
        bool success = await RunGatewayActionAsync(
            "正在验证 Cloudflare 授权并准备 DNS / 证书…",
            delegate { return client.PostDict("/api/gateway/cloudflare/token", payload, 60000); },
            "Cloudflare 授权已验证，DNS 与证书配置已启动。"
        );
        if (success) gatewayCloudflareTokenInput.Password = "";
    }

    private void RenderGatewayCloudflareAndDns(Dictionary<string, object> device, Dictionary<string, object> ipv6)
    {
        if (gatewayCloudflareStatusText == null) return;
        Dictionary<string, object> cloudflare = NativeClient.AsDict(gatewayOverviewState.ContainsKey("cloudflare") ? gatewayOverviewState["cloudflare"] : null);
        bool configured = NativeClient.GetBool(cloudflare, "configured");
        gatewayCloudflareStatusText.Text = configured ? "已授权" : "未授权";
        gatewayCloudflareStatusText.Foreground = configured ? AccentGreenBrush : DangerBrush;
        string zone = NativeClient.GetString(cloudflare, "zoneName");
        string cfError = NativeClient.GetString(cloudflare, "lastError");
        string lastSync = FormatGatewayTime(NativeClient.GetString(cloudflare, "lastSyncAt"));
        gatewayCloudflareDetailText.Text = "区域：" + (zone == "" ? "-" : zone)
            + "  ·  TTL：" + NativeClient.GetInt(cloudflare, "ttl")
            + "  ·  最近同步：" + lastSync
            + (cfError == "" ? "" : "\n最近错误：" + cfError);
        gatewayCloudflareDetailText.Foreground = cfError == "" ? MutedBrush : DangerBrush;

        string domain = NativeClient.GetString(device, "domain");
        Dictionary<string, object> target = NativeClient.AsDict(cloudflare.ContainsKey("lastTarget") ? cloudflare["lastTarget"] : null);
        string ipv4 = NativeClient.GetString(target, "ipv4");
        string ipv6Address = NativeClient.GetString(ipv6, "address");
        if (ipv6Address == "") ipv6Address = NativeClient.GetString(target, "ipv6");
        gatewayDnsStatusText.Text = !configured
            ? "尚未完成域名授权。授权后会自动维护解析记录。"
            : "每 5 秒检查一次本机地址，只有地址变化时才更新解析。";
        gatewayDnsRecordPanel.Children.Clear();
        if (domain == "")
        {
            gatewayDnsRecordPanel.Children.Add(new TextBlock { Text = "设置设备主域名后显示 DNS 计划。", Foreground = MutedBrush, FontSize = 12 });
            return;
        }
        AddGatewayDnsRow("A", domain, ipv4, "自动入口 · IPv4 备用");
        AddGatewayDnsRow("A", "*." + domain, ipv4, "网页自动入口 · IPv4 备用");
        AddGatewayDnsRow("A", "v4." + domain, ipv4, "IPv4 专用入口");
        AddGatewayDnsRow("A", "ssh-v4." + domain, ipv4, "SSH IPv4 专用入口");
        AddGatewayDnsRow("AAAA", domain, ipv6Address, "自动入口 · IPv6 直连");
        AddGatewayDnsRow("AAAA", "*." + domain, ipv6Address, "网页自动入口 · IPv6 直连");
        AddGatewayDnsRow("AAAA", "v6." + domain, ipv6Address, "IPv6 专用入口");
        AddGatewayDnsRow("AAAA", "ssh-v6." + domain, ipv6Address, "SSH IPv6 专用入口");
    }

    private void AddGatewayDnsRow(string type, string name, string value, string purpose)
    {
        Border row = new Border { Background = SurfaceBrush, BorderBrush = UiBorderBrush, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(7), Padding = new Thickness(10, 8, 10, 8), Margin = new Thickness(0, 0, 0, 6) };
        Grid grid = new Grid();
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(54) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Child = grid;
        StackPanel left = new StackPanel();
        grid.Children.Add(left);
        left.Children.Add(new TextBlock { Text = type, Foreground = AccentTextBrush, FontSize = 11, FontWeight = FontWeights.SemiBold });
        StackPanel middle = new StackPanel { Margin = new Thickness(8, 0, 10, 0) };
        Grid.SetColumn(middle, 1);
        grid.Children.Add(middle);
        middle.Children.Add(new TextBlock { Text = name, Foreground = TextBrush, FontSize = 11, TextTrimming = TextTrimming.CharacterEllipsis });
        middle.Children.Add(new TextBlock { Text = purpose, Foreground = MutedBrush, FontSize = 11, TextTrimming = TextTrimming.CharacterEllipsis });
        TextBlock address = new TextBlock { Text = value == "" ? "等待检测" : value, Foreground = value == "" ? MutedBrush : TextBrush, FontSize = 11, FontFamily = new FontFamily("Consolas, Microsoft YaHei UI"), VerticalAlignment = VerticalAlignment.Center, TextTrimming = TextTrimming.CharacterEllipsis, MaxWidth = 230 };
        Grid.SetColumn(address, 2);
        grid.Children.Add(address);
        gatewayDnsRecordPanel.Children.Add(row);
    }

    private async Task SyncGatewayDnsAsync()
    {
        await RunGatewayActionAsync(
            "正在检查本机 IPv6 并同步 Cloudflare DNS…",
            delegate { return client.PostDict("/api/gateway/dns/sync", new Dictionary<string, object>(), 60000); },
            "DNS 同步完成。"
        );
    }

    private Border BuildGatewayFirewallCard()
    {
        Border card = Card();
        card.Padding = new Thickness(16, 14, 16, 14);
        card.Margin = new Thickness(0, 4, 0, 10);
        StackPanel content = new StackPanel();
        card.Child = content;
        StackPanel heading = new StackPanel { Orientation = Orientation.Horizontal };
        content.Children.Add(heading);
        heading.Children.Add(new TextBlock { Text = "Windows 防火墙", Foreground = TextBrush, FontSize = 14, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
        GatewayChipInline(heading, out gatewayFirewallPill, out gatewayFirewallPillText, "未检查");
        gatewayFirewallStatusText = new TextBlock { Text = "", Foreground = MutedBrush, FontSize = 11, Margin = new Thickness(0, 6, 0, 0), TextWrapping = TextWrapping.Wrap, LineHeight = 18 };
        content.Children.Add(gatewayFirewallStatusText);
        gatewayFirewallDetailText = new TextBlock { Text = "", Foreground = MutedBrush, FontSize = 11, Margin = new Thickness(0, 4, 0, 0), TextWrapping = TextWrapping.Wrap, LineHeight = 17 };
        content.Children.Add(gatewayFirewallDetailText);
        Button openFirewall = OutlineButton("开放所需端口", TextBrush);
        openFirewall.HorizontalAlignment = HorizontalAlignment.Left;
        openFirewall.Margin = new Thickness(0, 10, 0, 0);
        openFirewall.Click += async delegate { await OpenGatewayFirewallAsync(); };
        content.Children.Add(openFirewall);
        return card;
    }

    private Border BuildGatewayRelayCard()
    {
        Border card = Card();
        card.Padding = new Thickness(16, 14, 16, 14);
        card.Margin = new Thickness(0, 0, 0, 4);
        StackPanel content = new StackPanel();
        card.Child = content;
        content.Children.Add(new TextBlock { Text = "连接通道", Foreground = TextBrush, FontSize = 14, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 8) });
        gatewayRelayPanel = new StackPanel();
        content.Children.Add(gatewayRelayPanel);
        return card;
    }

    private UIElement BuildGatewayRemotePage()
    {
        StackPanel root = new StackPanel { Margin = new Thickness(0, 0, 6, 12) };

        Border rdpCard = Card();
        rdpCard.Padding = new Thickness(20, 18, 20, 18);
        rdpCard.Margin = new Thickness(0, 0, 0, 14);
        root.Children.Add(rdpCard);
        StackPanel rdpContent = new StackPanel();
        rdpCard.Child = rdpContent;
        StackPanel rdpHeading = new StackPanel { Orientation = Orientation.Horizontal };
        rdpContent.Children.Add(rdpHeading);
        rdpHeading.Children.Add(new TextBlock { Text = "远程桌面", Foreground = TextBrush, FontSize = 18, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
        Border rdpPill;
        TextBlock rdpPillText;
        GatewayChipInline(rdpHeading, out rdpPill, out rdpPillText, "Windows 远程桌面");
        rdpPill.Background = AccentSoftBrush;
        rdpPillText.Foreground = AccentTextBrush;
        rdpContent.Children.Add(new TextBlock
        {
            Text = "登录使用这台电脑的 Microsoft 账户邮箱和账户密码，不能使用 PIN。",
            Foreground = MutedBrush,
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            LineHeight = 18,
            Margin = new Thickness(0, 6, 0, 12)
        });
        gatewayRdpDomainBox = GatewayEndpointRow(rdpContent, "自动线路（推荐）", "IPv4 和 IPv6 网络都能连接", "远程桌面自动地址已复制。");
        gatewayRdpCommandBox = GatewayEndpointRow(rdpContent, "IPv6 专用", "强制直连设备的公网 IPv6", "远程桌面 IPv6 地址已复制。");
        gatewayRdpCommandV4Box = GatewayEndpointRow(rdpContent, "IPv4 专用", "强制经 88FRP 节点连接", "远程桌面 IPv4 地址已复制。");
        rdpContent.Children.Add(new TextBlock
        {
            Text = "在 Windows 搜索“远程桌面连接”，粘贴地址后输入账户密码即可。",
            Foreground = MutedBrush,
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            LineHeight = 17,
            Margin = new Thickness(0, 4, 0, 0)
        });

        Border sshCard = Card();
        sshCard.Padding = new Thickness(20, 18, 20, 18);
        root.Children.Add(sshCard);
        StackPanel ssh = new StackPanel();
        sshCard.Child = ssh;
        StackPanel sshHeading = new StackPanel { Orientation = Orientation.Horizontal };
        ssh.Children.Add(sshHeading);
        sshHeading.Children.Add(new TextBlock { Text = "SSH", Foreground = TextBrush, FontSize = 18, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
        gatewaySshEndpointText = new TextBlock { Text = "尚未启用", Foreground = MutedBrush, FontSize = 11, VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 1, 0, 0) };
        sshHeading.Children.Add(gatewaySshEndpointText);
        ssh.Children.Add(new TextBlock
        {
            Text = "把命令中的 <用户名> 换成这台电脑的 Windows 登录名。",
            Foreground = MutedBrush,
            FontSize = 11,
            TextWrapping = TextWrapping.Wrap,
            LineHeight = 18,
            Margin = new Thickness(0, 6, 0, 12)
        });
        gatewaySshAutoBox = GatewayEndpointRow(ssh, "自动线路（推荐）", "按当前网络自动选择 IPv6 或 IPv4", "SSH 自动地址已复制。");
        gatewaySshV6Box = GatewayEndpointRow(ssh, "IPv6 专用", "只解析到设备的公网 IPv6", "SSH IPv6 地址已复制。");
        gatewaySshV4Box = GatewayEndpointRow(ssh, "IPv4 专用", "只解析到 88FRP 的 IPv4 节点", "SSH IPv4 地址已复制。");
        Grid sshFooter = new Grid { Margin = new Thickness(0, 8, 0, 0) };
        sshFooter.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        sshFooter.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        ssh.Children.Add(sshFooter);
        StackPanel sshState = new StackPanel();
        sshFooter.Children.Add(sshState);
        gatewaySshStatusText = new TextBlock { Text = "本地状态读取中", Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap };
        sshState.Children.Add(gatewaySshStatusText);
        gatewaySshRelayText = new TextBlock { Text = "", Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 2, 0, 0) };
        sshState.Children.Add(gatewaySshRelayText);
        Expander sshSettings = new Expander { Header = "SSH 设置", Foreground = TextBrush, IsExpanded = false, Margin = new Thickness(0, 6, 0, 0) };
        StackPanel sshContent = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
        sshSettings.Content = sshContent;
        sshContent.Children.Add(new TextBlock { Text = "只有更换端口或关闭 SSH 时才需要修改。", Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 8) });
        gatewaySshEnabledCheck = new CheckBox { Content = "启用 SSH 入口", Foreground = TextBrush, Margin = new Thickness(0, 0, 0, 10) };
        sshContent.Children.Add(gatewaySshEnabledCheck);
        StackPanel sshFields = new StackPanel();
        StackPanel hostField = GatewayFieldBlock("本地地址", "");
        gatewaySshHostInput = GatewayTextBox("127.0.0.1");
        hostField.Children.Add(gatewaySshHostInput);
        sshFields.Children.Add(hostField);
        StackPanel localField = GatewayFieldBlock("本地端口", "");
        localField.Margin = new Thickness(0, 10, 0, 0);
        gatewaySshPortInput = GatewayTextBox("22");
        localField.Children.Add(gatewaySshPortInput);
        sshFields.Children.Add(localField);
        StackPanel remoteField = GatewayFieldBlock("公网端口", "自动分配");
        remoteField.Margin = new Thickness(0, 10, 0, 0);
        gatewaySshRemotePortInput = GatewayTextBox("");
        remoteField.Children.Add(gatewaySshRemotePortInput);
        sshFields.Children.Add(remoteField);
        sshContent.Children.Add(sshFields);
        Button saveSsh = PrimaryButton("保存 SSH 设置", AccentBrush);
        saveSsh.HorizontalAlignment = HorizontalAlignment.Left;
        saveSsh.Margin = new Thickness(0, 12, 0, 0);
        saveSsh.Click += async delegate { await SaveGatewaySshAsync(); };
        sshContent.Children.Add(saveSsh);
        ssh.Children.Add(sshSettings);
        return GatewayPageScroll(root);
    }

    private static Border GatewayChipInline(StackPanel parent, out Border pill, out TextBlock text, string initial)
    {
        pill = new Border
        {
            Background = SurfaceBrush,
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(1),
            CornerRadius = new CornerRadius(10),
            Padding = new Thickness(7, 2, 7, 2),
            Margin = new Thickness(9, 0, 0, 0),
            VerticalAlignment = VerticalAlignment.Center
        };
        text = new TextBlock { Text = initial, Foreground = MutedBrush, FontSize = 11 };
        pill.Child = text;
        parent.Children.Add(pill);
        return pill;
    }

    private void RenderGatewayRemote()
    {
        if (gatewaySshEnabledCheck == null) return;
        Dictionary<string, object> ssh = NativeClient.AsDict(gatewayOverviewState.ContainsKey("ssh") ? gatewayOverviewState["ssh"] : null);
        if (!gatewaySshFormHydrated)
        {
            gatewaySshEnabledCheck.IsChecked = NativeClient.GetBool(ssh, "enabled");
            gatewaySshHostInput.Text = NativeClient.GetString(ssh, "localHost");
            gatewaySshPortInput.Text = NativeClient.GetInt(ssh, "localPort").ToString();
            int remotePort = NativeClient.GetInt(ssh, "remotePort");
            gatewaySshRemotePortInput.Text = remotePort > 0 ? remotePort.ToString() : "";
            gatewaySshFormHydrated = true;
        }
        bool enabled = NativeClient.GetBool(ssh, "enabled");
        string endpoint = NativeClient.GetString(ssh, "endpoint");
        Dictionary<string, object> sshEndpoints = NativeClient.AsDict(ssh.ContainsKey("endpoints") ? ssh["endpoints"] : null);
        string sshAuto = NativeClient.GetString(sshEndpoints, "auto");
        string sshV6 = NativeClient.GetString(sshEndpoints, "ipv6");
        string sshV4 = NativeClient.GetString(sshEndpoints, "ipv4");
        if (sshAuto == "") sshAuto = endpoint;
        bool online = NativeClient.GetBool(ssh, "online");
        Dictionary<string, object> relay = NativeClient.AsDict(ssh.ContainsKey("relay") ? ssh["relay"] : null);
        string relayStatus = NativeClient.GetString(relay, "status");
        gatewaySshEndpointText.Text = enabled ? (sshAuto == "" ? "已启用，等待域名" : "三条线路已生成") : "尚未启用";
        if (gatewaySshAutoBox != null) gatewaySshAutoBox.Text = enabled ? (sshAuto == "" ? "等待域名" : sshAuto) : "未启用";
        if (gatewaySshV6Box != null) gatewaySshV6Box.Text = enabled ? (sshV6 == "" ? "等待 IPv6" : sshV6) : "未启用";
        if (gatewaySshV4Box != null) gatewaySshV4Box.Text = enabled ? (sshV4 == "" ? "等待 IPv4" : sshV4) : "未启用";
        gatewaySshStatusText.Text = enabled
            ? (online ? "本地 SSH 端口可达" : "本地 SSH 端口暂未响应") + " · 本地端口 " + NativeClient.GetInt(ssh, "localPort")
            : "启用后通过同一个设备域名的 ssh 子域访问。";
        gatewaySshRelayText.Text = relayStatus == "running"
            ? "连接通道正常"
            : relayStatus == "direct" ? "直接连接" : relayStatus == "error" ? "连接异常：" + NativeClient.GetString(relay, "lastError") : (enabled ? "等待连接就绪" : "");
        gatewaySshRelayText.Foreground = relayStatus == "error" ? DangerBrush : MutedBrush;
        Dictionary<string, object> device = NativeClient.AsDict(gatewayOverviewState.ContainsKey("device") ? gatewayOverviewState["device"] : null);
        string domain = NativeClient.GetString(device, "domain");
        Dictionary<string, object> rdpService = null;
        object[] serviceRows = NativeClient.AsArray(gatewayOverviewState.ContainsKey("services") ? gatewayOverviewState["services"] : null);
        foreach (object row in serviceRows)
        {
            Dictionary<string, object> service = NativeClient.AsDict(row);
            if (NativeClient.GetString(service, "kind") == "tcp"
                && NativeClient.GetBool(service, "enabled")
                && NativeClient.GetInt(service, "localPort") == 3389)
            {
                rdpService = service;
                break;
            }
        }
        string rdpDomainEndpoint = rdpService == null ? "" : NativeClient.GetString(rdpService, "tcpEndpoint");
        if (rdpDomainEndpoint == "" && rdpService != null && domain != "")
            rdpDomainEndpoint = domain + ":" + NativeClient.GetInt(rdpService, "remotePort");
        string rdpAuto = rdpDomainEndpoint;
        string rdpV6 = "";
        string rdpV4 = "";
        int rdpPort = rdpService == null ? 0 : NativeClient.GetInt(rdpService, "remotePort");
        Dictionary<string, object> remoteAccess = NativeClient.AsDict(gatewayOverviewState.ContainsKey("remoteAccess") ? gatewayOverviewState["remoteAccess"] : null);
        Dictionary<string, object> rdp = NativeClient.AsDict(remoteAccess.ContainsKey("rdp") ? remoteAccess["rdp"] : null);
        foreach (object row in NativeClient.AsArray(rdp.ContainsKey("targets") ? rdp["targets"] : null))
        {
            Dictionary<string, object> target = NativeClient.AsDict(row);
            string family = NativeClient.GetString(target, "family");
            string targetEndpoint = NativeClient.GetString(target, "endpoint");
            if (family == "auto") rdpAuto = targetEndpoint;
            else if (family == "ipv6") rdpV6 = targetEndpoint;
            else if (family == "ipv4") rdpV4 = targetEndpoint;
        }
        if (rdpV6 == "" && rdpPort > 0 && domain != "") rdpV6 = "v6." + domain + ":" + rdpPort;
        if (rdpV4 == "" && rdpPort > 0 && domain != "") rdpV4 = "v4." + domain + ":" + rdpPort;
        gatewayRdpDomainBox.Text = rdpAuto == "" ? "尚未添加远程桌面服务" : rdpAuto;
        gatewayRdpCommandBox.Text = rdpV6 == "" ? "等待 IPv6 专用地址" : rdpV6;
        gatewayRdpCommandV4Box.Text = rdpV4 == "" ? "等待 IPv4 专用地址" : rdpV4;

        Dictionary<string, object> firewall = NativeClient.AsDict(gatewayOverviewState.ContainsKey("firewall") ? gatewayOverviewState["firewall"] : null);
        bool supported = NativeClient.GetBool(firewall, "supported");
        bool pending = NativeClient.GetBool(firewall, "pending");
        bool firewallEnabled = NativeClient.GetBool(firewall, "firewallEnabled");
        bool tcpCovered = NativeClient.GetBool(firewall, "tcpCovered");
        bool udpCovered = NativeClient.GetBool(firewall, "udpCovered");
        int[] missingTcp = GatewayPortArray(firewall, "missingTcpPorts");
        int[] missingUdp = GatewayPortArray(firewall, "missingUdpPorts");
        bool fullyCovered = tcpCovered && udpCovered;
        bool needsAttention = firewallEnabled && !fullyCovered;
        gatewayFirewallPillText.Text = pending ? "检查中" : !supported ? "不支持" : !firewallEnabled ? "防火墙已关闭" : fullyCovered ? "已放行" : "需补充";
        gatewayFirewallPillText.Foreground = pending || !supported ? MutedBrush : needsAttention ? DangerBrush : AccentGreenBrush;
        gatewayFirewallStatusText.Text = pending
            ? "正在后台检查放行规则，稍后会自动更新。"
            : !supported
            ? "仅 Windows 支持自动检查防火墙。"
            : !firewallEnabled
            ? "Windows 防火墙当前未启用，公网端口不会被本机防火墙拦截。"
            : fullyCovered
            ? "统一入口、远程桌面、SSH 和直连服务的端口均已准确放行。"
            : "当前放行规则缺少部分端口；点击“一键放行”补齐即可，不会关闭 Windows 防火墙。";
        if (needsAttention)
        {
            List<int> ports = new List<int>();
            foreach (int port in missingTcp) if (!ports.Contains(port)) ports.Add(port);
            foreach (int port in missingUdp) if (!ports.Contains(port)) ports.Add(port);
            string missing = string.Join("、", ports);
            if (missing != "") gatewayFirewallStatusText.Text += " 缺少端口：" + missing + "。";
        }
        gatewayFirewallDetailText.Text = NativeClient.GetString(firewall, "detail");

        gatewayRelayPanel.Children.Clear();
        object[] relays = NativeClient.AsArray(NativeClient.AsDict(gatewayOverviewState.ContainsKey("runtime") ? gatewayOverviewState["runtime"] : null).ContainsKey("relays")
            ? NativeClient.AsDict(gatewayOverviewState["runtime"])["relays"] : null);
        if (relays.Length == 0)
        {
            gatewayRelayPanel.Children.Add(new TextBlock { Text = "当前没有额外的连接通道。", Foreground = MutedBrush, FontSize = 11 });
            return;
        }
        foreach (object row in relays)
        {
            Dictionary<string, object> relayItem = NativeClient.AsDict(row);
            string id = NativeClient.GetString(relayItem, "id");
            string status = NativeClient.GetString(relayItem, "status");
            Border item = new Border { Background = SurfaceBrush, BorderBrush = UiBorderBrush, BorderThickness = new Thickness(1), CornerRadius = new CornerRadius(7), Padding = new Thickness(10, 8, 10, 8), Margin = new Thickness(0, 0, 0, 6) };
            Grid line = new Grid();
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
            item.Child = line;
            StackPanel text = new StackPanel();
            line.Children.Add(text);
            text.Children.Add(new TextBlock { Text = RelayDisplayName(id), Foreground = TextBrush, FontSize = 11, FontWeight = FontWeights.SemiBold });
            string targetHost = NativeClient.GetString(relayItem, "targetHost");
            int targetPort = NativeClient.GetInt(relayItem, "targetPort");
            int publicPort = NativeClient.GetInt(relayItem, "publicPort");
            string relayDetail = string.IsNullOrWhiteSpace(targetHost) || targetPort <= 0
                ? "公网端口 " + publicPort
                : "公网端口 " + publicPort + "  →  " + targetHost + ":" + targetPort;
            text.Children.Add(new TextBlock
            {
                Text = relayDetail,
                Foreground = MutedBrush,
                FontSize = 11,
                Margin = new Thickness(0, 2, 0, 0)
            });
            TextBlock statusText = new TextBlock { Text = TranslateStatus(status), Foreground = status == "error" ? DangerBrush : AccentGreenBrush, FontSize = 11, VerticalAlignment = VerticalAlignment.Center };
            Grid.SetColumn(statusText, 1);
            line.Children.Add(statusText);
            gatewayRelayPanel.Children.Add(item);
        }
    }

    private static int[] GatewayPortArray(Dictionary<string, object> source, string key)
    {
        List<int> ports = new List<int>();
        foreach (object value in NativeClient.AsArray(source.ContainsKey(key) ? source[key] : null))
        {
            try
            {
                int port = Convert.ToInt32(value);
                if (port > 0 && port <= 65535 && !ports.Contains(port)) ports.Add(port);
            }
            catch { }
        }
        return ports.ToArray();
    }

    private static string GatewayWebUrl(string value)
    {
        string url = (value ?? "").Trim();
        if (url == "") return url;
        int authorityEnd = url.IndexOf('/', url.IndexOf("://", StringComparison.Ordinal) + 3);
        return authorityEnd < 0 ? url + "/" : url;
    }

    private async Task SaveGatewaySshAsync()
    {
        int localPort;
        int remotePort = 0;
        if (!int.TryParse(gatewaySshPortInput.Text.Trim(), out localPort) || localPort < 1 || localPort > 65535)
        {
            ShowGatewayMessage("SSH 本地端口必须是 1 到 65535。", true, false);
            return;
        }
        string remoteText = gatewaySshRemotePortInput.Text.Trim();
        if (remoteText != "" && (!int.TryParse(remoteText, out remotePort) || remotePort < 1 || remotePort > 65535))
        {
            ShowGatewayMessage("SSH 公网端口必须是 1 到 65535。", true, false);
            return;
        }
        Dictionary<string, object> payload = new Dictionary<string, object>();
        payload["enabled"] = gatewaySshEnabledCheck.IsChecked == true;
        payload["localHost"] = gatewaySshHostInput.Text.Trim();
        payload["localPort"] = localPort;
        payload["remotePort"] = remotePort;
        await RunGatewayActionAsync(
            "正在保存 SSH 设置并重载双栈中继…",
            delegate { return client.PutDict("/api/gateway/ssh", payload, 60000); },
            "SSH 设置已保存。"
        );
        gatewaySshFormHydrated = false;
    }

    private static string RelayDisplayName(string id)
    {
        if (id == "ssh") return "SSH 安全入口";
        if (id.StartsWith("tcp:", StringComparison.Ordinal)) return "远程桌面直连";
        if (id.StartsWith("udp:", StringComparison.Ordinal)) return "UDP 直连服务";
        return "连接通道";
    }

    private async Task OpenGatewayFirewallAsync()
    {
        await RunGatewayActionAsync(
            "正在为统一入口、SSH 和 UDP 添加 Windows 防火墙放行规则…",
            delegate { return client.PostDict("/api/gateway/firewall/open", new Dictionary<string, object>(), 60000); },
            "防火墙规则已添加。"
        );
    }

    private UIElement BuildGatewayRuntimePage()
    {
        StackPanel root = new StackPanel { Margin = new Thickness(0, 0, 6, 12) };

        UniformGrid statusCards = new UniformGrid { Columns = 2, Margin = new Thickness(0, 0, 0, 14) };
        statusCards.SizeChanged += delegate
        {
            if (statusCards == null) return;
            statusCards.Columns = statusCards.ActualWidth < 760 ? 1 : 2;
        };
        Border caddyCard = GatewayRuntimeCard("网页访问与 HTTPS", out gatewayCaddyStatusText, out gatewayCaddyDetailText);
        caddyCard.Margin = new Thickness(0, 0, 7, 0);
        statusCards.Children.Add(caddyCard);
        Border frpcCard = GatewayRuntimeCard("IPv4 备用通道", out gatewayFrpcStatusText, out gatewayFrpcDetailText);
        frpcCard.Margin = new Thickness(7, 0, 0, 0);
        statusCards.Children.Add(frpcCard);
        root.Children.Add(statusCards);

        Border sourceCard = Card();
        sourceCard.Padding = new Thickness(20, 17, 20, 17);
        sourceCard.Margin = new Thickness(0, 0, 0, 14);
        root.Children.Add(sourceCard);
        Grid source = new Grid();
        source.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        source.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        source.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        sourceCard.Child = source;
        StackPanel sourceCopy = new StackPanel();
        source.Children.Add(sourceCopy);
        sourceCopy.Children.Add(new TextBlock { Text = "后台连接", Foreground = TextBrush, FontSize = 17, FontWeight = FontWeights.SemiBold });
        gatewaySourceStatusText = new TextBlock { Text = "读取中", Foreground = MutedBrush, FontSize = 12, Margin = new Thickness(0, 5, 0, 0) };
        sourceCopy.Children.Add(gatewaySourceStatusText);
        gatewaySourceDetailText = new TextBlock { Text = "", Foreground = MutedBrush, FontSize = 11, Margin = new Thickness(0, 3, 0, 0), TextWrapping = TextWrapping.Wrap };
        sourceCopy.Children.Add(gatewaySourceDetailText);
        StackPanel sourceActions = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 10, 0, 0) };
        Grid.SetRow(sourceActions, 1);
        source.Children.Add(sourceActions);
        Button syncSource = OutlineButton("重新连接", TextBrush);
        syncSource.Click += async delegate { await SyncGatewaySourceAsync(); };
        sourceActions.Children.Add(syncSource);
        Button restart = PrimaryButton("重启服务", AccentBrush);
        restart.Click += async delegate { await RestartGatewayAsync(); };
        sourceActions.Children.Add(restart);

        Border logsCard = Card();
        logsCard.Padding = new Thickness(18, 16, 18, 16);
        Grid logsGrid = new Grid();
        logsGrid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        logsGrid.RowDefinitions.Add(new RowDefinition { Height = new GridLength(360) });
        logsCard.Child = logsGrid;
        Grid logHeader = new Grid { Margin = new Thickness(0, 0, 0, 10) };
        logHeader.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        logHeader.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        logsGrid.Children.Add(logHeader);
        StackPanel logTitle = new StackPanel { Orientation = Orientation.Horizontal };
        logHeader.Children.Add(logTitle);
        logTitle.Children.Add(new TextBlock { Text = "最近活动", Foreground = TextBrush, FontSize = 17, FontWeight = FontWeights.SemiBold, VerticalAlignment = VerticalAlignment.Center });
        gatewayLogTypeCombo = new ComboBox { Width = 126, Height = 32, Margin = new Thickness(12, 0, 0, 0), VerticalContentAlignment = VerticalAlignment.Center };
        gatewayLogTypeCombo.Items.Add(new ComboBoxItem { Content = "最近活动", Tag = "audit" });
        gatewayLogTypeCombo.Items.Add(new ComboBoxItem { Content = "网页访问", Tag = "caddy" });
        gatewayLogTypeCombo.Items.Add(new ComboBoxItem { Content = "备用通道", Tag = "frpc" });
        gatewayLogTypeCombo.SelectedIndex = 0;
        gatewayLogTypeCombo.SelectionChanged += delegate { RenderGatewayLogText(); };
        logTitle.Children.Add(gatewayLogTypeCombo);
        Button refresh = PrimaryButton("刷新日志", AccentBrush);
        Grid.SetColumn(refresh, 1);
        refresh.Click += async delegate { await RefreshGatewayLogsAsync(); };
        logHeader.Children.Add(refresh);
        gatewayLogsBox = new TextBox
        {
            IsReadOnly = true,
            AcceptsReturn = true,
            TextWrapping = TextWrapping.Wrap,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
            HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
            Background = SurfaceBrush,
            BorderBrush = UiBorderBrush,
            BorderThickness = new Thickness(1),
            Padding = new Thickness(12),
            FontFamily = new FontFamily("Consolas, Microsoft YaHei UI"),
            FontSize = 11,
            Text = "点击「刷新日志」读取。"
        };
        Grid.SetRow(gatewayLogsBox, 1);
        logsGrid.Children.Add(gatewayLogsBox);
        Expander advanced = new Expander
        {
            Header = "高级诊断（一般不需要）",
            IsExpanded = false,
            Margin = new Thickness(0, 0, 0, 8)
        };
        advanced.Content = logsCard;
        root.Children.Add(advanced);
        return GatewayPageScroll(root);
    }

    private Border GatewayRuntimeCard(string title, out TextBlock status, out TextBlock detail)
    {
        Border card = Card();
        card.Padding = new Thickness(18, 15, 18, 15);
        StackPanel content = new StackPanel();
        card.Child = content;
        content.Children.Add(new TextBlock { Text = title, Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap });
        status = new TextBlock { Text = "读取中", Foreground = TextBrush, FontSize = 22, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 7, 0, 0) };
        content.Children.Add(status);
        detail = new TextBlock { Text = "", Foreground = MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 5, 0, 0) };
        content.Children.Add(detail);
        return card;
    }

    private void RenderGatewayRuntime()
    {
        if (gatewayCaddyStatusText == null) return;
        Dictionary<string, object> runtime = NativeClient.AsDict(gatewayOverviewState.ContainsKey("runtime") ? gatewayOverviewState["runtime"] : null);
        Dictionary<string, object> caddy = NativeClient.AsDict(runtime.ContainsKey("caddy") ? runtime["caddy"] : null);
        Dictionary<string, object> frpc = NativeClient.AsDict(runtime.ContainsKey("frpc") ? runtime["frpc"] : null);
        string caddyStatus = NativeClient.GetString(caddy, "status");
        string frpcStatus = NativeClient.GetString(frpc, "status");
        gatewayCaddyStatusText.Text = RuntimeStatusLabel(caddyStatus);
        gatewayCaddyStatusText.Foreground = caddyStatus == "running" ? AccentGreenBrush : DangerBrush;
        gatewayCaddyDetailText.Text = NativeClient.GetString(caddy, "lastError") == ""
            ? "证书有效，网页服务可以正常打开。"
            : GatewayFriendlyError(NativeClient.GetString(caddy, "lastError"));
        gatewayFrpcStatusText.Text = RuntimeStatusLabel(frpcStatus);
        gatewayFrpcStatusText.Foreground = frpcStatus == "running" ? AccentGreenBrush : DangerBrush;
        int readyRelays = 0;
        object[] relays = NativeClient.AsArray(runtime.ContainsKey("relays") ? runtime["relays"] : null);
        foreach (object row in relays)
        {
            string status = NativeClient.GetString(NativeClient.AsDict(row), "status");
            if (status == "running" || status == "direct") readyRelays++;
        }
        gatewayFrpcDetailText.Text = NativeClient.GetString(frpc, "lastError") == ""
            ? "没有 IPv6 时会自动切换备用通道；" + (relays.Length == 0 ? "当前没有额外连接通道。" : "连接通道 " + readyRelays + "/" + relays.Length + " 就绪。")
            : GatewayFriendlyError(NativeClient.GetString(frpc, "lastError"));

        Dictionary<string, object> source = NativeClient.AsDict(gatewayOverviewState.ContainsKey("source") ? gatewayOverviewState["source"] : null);
        string sourceName = NativeClient.GetString(source, "migratedInstanceName");
        if (sourceName == "") sourceName = NativeClient.GetString(source, "legacyInstanceId");
        bool configAvailable = NativeClient.GetBool(source, "lastBaseConfigAvailable");
        gatewaySourceStatusText.Text = sourceName == "" ? "本机后台" : "已连接：" + GatewayDeviceDisplayName(sourceName);
        gatewaySourceStatusText.Foreground = configAvailable ? TextBrush : DangerBrush;
        gatewaySourceDetailText.Text = configAvailable
            ? "连接正常，凭据不会在本机界面显示。"
            : "连接需要刷新，点右侧“重新连接”即可。";
    }

    private static string RuntimeStatusLabel(string status)
    {
        if (status == "running") return "运行正常";
        if (status == "starting") return "正在启动";
        if (status == "error") return "需要检查";
        return "未启动";
    }

    private static string GatewayFriendlyError(string message)
    {
        if (string.IsNullOrWhiteSpace(message)) return "";
        if (System.Text.RegularExpressions.Regex.IsMatch(message, @"发现旧\s*(Caddy|frpc)\s*进程\s*PID=\d+"))
        {
            return "检测到一个旧的后台进程，但无法确认归属；为避免影响其他程序，已停止自动启动。";
        }
        return System.Text.RegularExpressions.Regex.Replace(message, @"\s*PID=\d+", "");
    }

    private async Task SyncGatewaySourceAsync()
    {
        await RunGatewayActionAsync(
            "正在从 88FRP 同步最新连接来源…",
            delegate { return client.PostDict("/api/gateway/source/sync", new Dictionary<string, object>(), 90000); },
            "连接来源已同步。"
        );
    }

    private async Task RestartGatewayAsync()
    {
        await RunGatewayActionAsync(
            "正在重启统一入口，网页服务会短暂断开…",
            delegate { return client.PostDict("/api/gateway/restart", new Dictionary<string, object>(), 90000); },
            "统一入口已重启。"
        );
    }

    private async Task RefreshGatewayLogsAsync()
    {
        if (gatewayLogsBox == null) return;
        gatewayLogsBox.Text = "正在读取日志…";
        try
        {
            gatewayLogsCache = await Task.Run(delegate { return client.GetDict("/api/gateway/logs?tail=300", 30000); });
            RenderGatewayLogText();
        }
        catch (Exception ex)
        {
            gatewayLogsBox.Text = ex.Message;
        }
    }

    private void RenderGatewayLogText()
    {
        if (gatewayLogsBox == null) return;
        string key = GetSelectedTag(gatewayLogTypeCombo);
        if (key == "") key = "audit";
        string content = NativeClient.GetString(gatewayLogsCache, key);
        if (key == "audit") content = FormatGatewayAuditLog(content);
        gatewayLogsBox.Text = string.IsNullOrWhiteSpace(content) ? "暂无记录。" : content;
        gatewayLogsBox.ScrollToEnd();
    }

    private static string FormatGatewayAuditLog(string content)
    {
        if (string.IsNullOrWhiteSpace(content)) return "";
        StringBuilder text = new StringBuilder();
        foreach (string rawLine in content.Replace("\r\n", "\n").Split('\n'))
        {
            string line = rawLine.Trim();
            if (line == "") continue;
            try
            {
                Dictionary<string, object> item = NativeClient.AsDict(new JavaScriptSerializer().DeserializeObject(line));
                string action = NativeClient.GetString(item, "action");
                string outcome = NativeClient.GetString(item, "outcome");
                string time = FormatGatewayTime(NativeClient.GetString(item, "ts"));
                if (time.Length >= 19) time = time.Substring(11, 8);
                string friendly = GatewayAuditActionLabel(action);
                if (outcome == "failed") friendly += "（失败）";
                text.Append(time).Append("  ").Append(friendly).Append('\n');
            }
            catch
            {
                text.Append(line).Append('\n');
            }
        }
        return text.ToString().TrimEnd();
    }

    private static string GatewayAuditActionLabel(string action)
    {
        switch (action)
        {
            case "cloudflare.dns.sync": return "DNS 记录已自动同步";
            case "caddy.apply": return "网页访问配置已更新";
            case "caddy.start": return "网页访问已启动";
            case "caddy.stop": return "网页访问已停止";
            case "caddy.restart": return "网页访问已重启";
            case "frpc.apply": return "IPv4 备用通道配置已更新";
            case "frpc.start": return "IPv4 备用通道已启动";
            case "frpc.stop": return "IPv4 备用通道已停止";
            case "relay.start": return "远程访问中继已启动";
            case "relay.stop": return "远程访问中继已停止";
            case "gateway.runtime.restart": return "统一入口已重启";
            case "gateway.migrate": return "旧实例已迁移到统一入口";
            case "gateway.service.add": return "已添加服务";
            case "gateway.service.update": return "已更新服务";
            case "gateway.service.delete": return "已删除服务";
            default: return "配置已更新";
        }
    }

    private static string GetSelectedTag(ComboBox combo)
    {
        if (combo == null) return "";
        ComboBoxItem item = combo.SelectedItem as ComboBoxItem;
        if (item == null || item.Tag == null) return "";
        return Convert.ToString(item.Tag);
    }

    private static void SelectComboByTag(ComboBox combo, string tag)
    {
        if (combo == null) return;
        foreach (object item in combo.Items)
        {
            ComboBoxItem option = item as ComboBoxItem;
            if (option != null && string.Equals(Convert.ToString(option.Tag), tag, StringComparison.OrdinalIgnoreCase))
            {
                combo.SelectedItem = option;
                return;
            }
        }
    }

    private static string FormatGatewayTime(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "-";
        DateTime parsed;
        if (!DateTime.TryParse(value, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out parsed)) return value;
        return parsed.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss");
    }
}

internal sealed class GatewayServiceEditorWindow : Window
{
    private readonly ComboBox kindBox = new ComboBox { Height = 36 };
    private readonly TextBox nameBox = new TextBox { Height = 36 };
    private readonly TextBox titleBox = new TextBox { Height = 36 };
    private readonly TextBox hostBox = new TextBox { Height = 36, Text = "127.0.0.1" };
    private readonly TextBox localPortBox = new TextBox { Height = 36 };
    private readonly TextBox remotePortBox = new TextBox { Height = 36 };
    private readonly TextBox tagBox = new TextBox { Height = 36 };
    private readonly TextBox descriptionBox = new TextBox { Height = 64, AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, VerticalContentAlignment = VerticalAlignment.Top };
    private readonly CheckBox enabledBox = new CheckBox { Content = "启用这个服务", IsChecked = true };
    private readonly StackPanel remoteField;
    private readonly TextBlock remotePortLabel;
    private readonly TextBlock message;

    internal Dictionary<string, object> Result { get; private set; }

    internal GatewayServiceEditorWindow(Dictionary<string, object> service)
    {
        Title = service == null ? "添加服务" : "编辑服务";
        Width = 560;
        Height = 650;
        MinWidth = 500;
        MinHeight = 600;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        ResizeMode = ResizeMode.CanResizeWithGrip;
        FontFamily = ClientUiStyles.Font;
        FontSize = 13;
        SetResourceReference(BackgroundProperty, "ClientCard");
        SetResourceReference(ForegroundProperty, "ClientText");
        UseLayoutRounding = true;
        SnapsToDevicePixels = true;

        Grid root = new Grid { Margin = new Thickness(22, 20, 22, 18) };
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        Content = root;
        StackPanel heading = new StackPanel { Margin = new Thickness(0, 0, 0, 14) };
        root.Children.Add(heading);
        heading.Children.Add(new TextBlock { Text = service == null ? "添加服务" : "编辑服务", FontSize = 22, FontWeight = FontWeights.SemiBold });
        heading.Children.Add(new TextBlock { Text = "网页服务共用统一入口；TCP / UDP 直通使用独立公网端口。", Foreground = ClientUiStyles.MutedBrush, FontSize = 12, Margin = new Thickness(0, 5, 0, 0) });

        ScrollViewer scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled };
        Grid.SetRow(scroll, 1);
        root.Children.Add(scroll);
        StackPanel form = new StackPanel();
        scroll.Content = form;
        form.Children.Add(Label("类型"));
        kindBox.Items.Add(new ComboBoxItem { Content = "网页服务（HTTPS 子域名）", Tag = "http" });
        kindBox.Items.Add(new ComboBoxItem { Content = "TCP 直通（远程桌面等）", Tag = "tcp" });
        kindBox.Items.Add(new ComboBoxItem { Content = "UDP 直通（独立公网端口）", Tag = "udp" });
        kindBox.SelectedIndex = 0;
        kindBox.SelectionChanged += delegate { UpdateRemotePortField(); };
        form.Children.Add(kindBox);
        form.Children.Add(Label("服务标识 / 子域名前缀"));
        nameBox.ToolTip = "只能使用小写字母、数字和连字符，例如 alist";
        form.Children.Add(nameBox);
        form.Children.Add(Label("显示名称"));
        form.Children.Add(titleBox);
        Grid hostPort = new Grid { Margin = new Thickness(0, 10, 0, 0) };
        hostPort.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        hostPort.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(150) });
        StackPanel hostField = new StackPanel();
        hostPort.Children.Add(hostField);
        hostField.Children.Add(Label("本机地址"));
        hostField.Children.Add(hostBox);
        StackPanel localPortField = new StackPanel { Margin = new Thickness(10, 0, 0, 0) };
        Grid.SetColumn(localPortField, 1);
        hostPort.Children.Add(localPortField);
        localPortField.Children.Add(Label("本机端口"));
        localPortField.Children.Add(localPortBox);
        form.Children.Add(hostPort);
        remoteField = new StackPanel { Margin = new Thickness(0, 10, 0, 0), Visibility = Visibility.Collapsed };
        form.Children.Add(remoteField);
        remotePortLabel = Label("公网端口");
        remoteField.Children.Add(remotePortLabel);
        remoteField.Children.Add(remotePortBox);
        remoteField.Children.Add(new TextBlock { Text = "该端口会写入 Windows 防火墙和 88FRP 配置。", Foreground = ClientUiStyles.MutedBrush, FontSize = 11, Margin = new Thickness(0, 4, 0, 0) });
        form.Children.Add(Label("标签"));
        tagBox.ToolTip = "例如：服务、媒体、开发工具";
        form.Children.Add(tagBox);
        form.Children.Add(Label("说明"));
        form.Children.Add(descriptionBox);
        enabledBox.Margin = new Thickness(0, 13, 0, 0);
        form.Children.Add(enabledBox);

        Grid footer = new Grid { Margin = new Thickness(0, 15, 0, 0) };
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        footer.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        root.Children.Add(footer);
        Grid.SetRow(footer, 2);
        message = new TextBlock { Foreground = ClientUiStyles.MutedBrush, FontSize = 11, TextWrapping = TextWrapping.Wrap, VerticalAlignment = VerticalAlignment.Center };
        footer.Children.Add(message);
        StackPanel buttons = new StackPanel { Orientation = Orientation.Horizontal };
        Grid.SetColumn(buttons, 1);
        footer.Children.Add(buttons);
        Button cancel = new Button { Content = "取消", MinWidth = 74, Margin = new Thickness(0, 0, 8, 0) };
        cancel.Click += delegate { DialogResult = false; };
        buttons.Children.Add(cancel);
        Button save = new Button { Content = "保存服务", MinWidth = 90, IsDefault = true };
        save.SetResourceReference(BackgroundProperty, "ClientAccent");
        save.Foreground = Brushes.White;
        save.Click += delegate { Save(); };
        buttons.Children.Add(save);

        if (service != null) Hydrate(service);
        Loaded += delegate { nameBox.Focus(); };
    }

    private static TextBlock Label(string text)
    {
        return new TextBlock { Text = text, Foreground = ClientUiStyles.MutedBrush, FontSize = 11, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 11, 0, 5) };
    }

    private string SelectedTag()
    {
        ComboBoxItem item = kindBox.SelectedItem as ComboBoxItem;
        return item == null ? "http" : Convert.ToString(item.Tag);
    }

    private void Hydrate(Dictionary<string, object> service)
    {
        string kind = NativeClient.GetString(service, "kind");
        kindBox.SelectedIndex = kind == "tcp" ? 1 : kind == "udp" ? 2 : 0;
        nameBox.Text = NativeClient.GetString(service, "name");
        titleBox.Text = NativeClient.GetString(service, "title");
        hostBox.Text = NativeClient.GetString(service, "localHost");
        localPortBox.Text = NativeClient.GetInt(service, "localPort").ToString();
        int remotePort = NativeClient.GetInt(service, "remotePort");
        remotePortBox.Text = remotePort > 0 ? remotePort.ToString() : "";
        tagBox.Text = NativeClient.GetString(service, "tag");
        descriptionBox.Text = NativeClient.GetString(service, "description");
        enabledBox.IsChecked = NativeClient.GetBool(service, "enabled");
        UpdateRemotePortField();
    }

    private void UpdateRemotePortField()
    {
        string kind = SelectedTag();
        bool direct = kind == "tcp" || kind == "udp";
        remoteField.Visibility = direct ? Visibility.Visible : Visibility.Collapsed;
        remotePortLabel.Text = kind == "tcp" ? "公网 TCP 端口" : "公网 UDP 端口";
    }

    private void Save()
    {
        int localPort;
        int remotePort = 0;
        string kind = SelectedTag();
        if (nameBox.Text.Trim() == "")
        {
            message.Text = "请填写服务标识。";
            nameBox.Focus();
            return;
        }
        if (!int.TryParse(localPortBox.Text.Trim(), out localPort) || localPort < 1 || localPort > 65535)
        {
            message.Text = "本机端口必须是 1 到 65535。";
            localPortBox.Focus();
            return;
        }
        if (kind != "http" && (!int.TryParse(remotePortBox.Text.Trim(), out remotePort) || remotePort < 1 || remotePort > 65535))
        {
            message.Text = (kind == "tcp" ? "公网 TCP" : "公网 UDP") + "端口必须是 1 到 65535。";
            remotePortBox.Focus();
            return;
        }
        Result = new Dictionary<string, object>();
        Result["kind"] = kind;
        Result["name"] = nameBox.Text.Trim();
        Result["title"] = titleBox.Text.Trim();
        Result["localHost"] = hostBox.Text.Trim();
        Result["localPort"] = localPort;
        Result["remotePort"] = kind == "http" ? 0 : remotePort;
        Result["tag"] = tagBox.Text.Trim();
        Result["description"] = descriptionBox.Text.Trim();
        Result["enabled"] = enabledBox.IsChecked == true;
        DialogResult = true;
    }
}
