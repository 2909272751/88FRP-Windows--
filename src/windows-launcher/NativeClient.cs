using Microsoft.Win32;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

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

        bool createdNew;
        Mutex mutex = new Mutex(true, "Global\\88FRP_Native_Client_Mutex", out createdNew);
        bool backgroundStart = HasArg(args, "--background");
        if (!createdNew)
        {
            if (!backgroundStart) NativeClient.SignalExistingInstance();
            return;
        }

        Directory.CreateDirectory(AppDataDir);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.ThreadException += delegate(object sender, System.Threading.ThreadExceptionEventArgs e)
        {
            MessageBox.Show(e.Exception.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        };
        AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e)
        {
            Exception ex = e.ExceptionObject as Exception;
            MessageBox.Show(ex == null ? "程序发生未知错误。" : ex.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        };
        Application.Run(new MainForm(backgroundStart));
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

internal sealed class MainForm : Form
{
    private readonly NativeClient client = new NativeClient();
    private readonly bool backgroundStart;
    private readonly ListBox instanceList = new ListBox();
    private readonly Label statusValue = new Label();
    private readonly Label pidValue = new Label();
    private readonly Label backendValue = new Label();
    private readonly TextBox secretBox = new TextBox();
    private readonly CheckBox autoSyncBox = new CheckBox();
    private readonly TabControl tabs = new TabControl();
    private readonly TextBox configBox = new TextBox();
    private readonly CheckedListBox tunnelList = new CheckedListBox();
    private readonly TextBox logsBox = new TextBox();
    private readonly NotifyIcon trayIcon = new NotifyIcon();
    private readonly System.Windows.Forms.Timer pollTimer = new System.Windows.Forms.Timer();
    private readonly System.Windows.Forms.Timer watchdogTimer = new System.Windows.Forms.Timer();
    private readonly List<Dictionary<string, object>> tunnels = new List<Dictionary<string, object>>();
    private string currentInstanceId = "";
    private bool closingForExit;
    private Button autoStartButton;
    private readonly int showWindowMessage = NativeClient.ShowWindowMessage;

    private static readonly Color SidebarBg = Color.FromArgb(20, 31, 48);
    private static readonly Color AppBg = Color.FromArgb(246, 248, 251);
    private static readonly Color PanelBg = Color.White;
    private static readonly Color Accent = Color.FromArgb(34, 99, 235);
    private static readonly Color Accent2 = Color.FromArgb(20, 184, 166);
    private static readonly Color TextMain = Color.FromArgb(17, 24, 39);
    private static readonly Color TextMuted = Color.FromArgb(100, 116, 139);
    private static readonly Color Border = Color.FromArgb(226, 232, 240);

    public MainForm(bool backgroundStart)
    {
        this.backgroundStart = backgroundStart;
        Text = "88FRP";
        AutoScaleMode = AutoScaleMode.Dpi;
        Width = 1220;
        Height = 780;
        MinimumSize = new Size(1040, 660);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = AppBg;
        Font = new Font("Microsoft YaHei UI", 9F);
        Icon = NativeClient.LoadAppIcon();

        BuildUi();
        UseGdiTextRendering(this);
        BuildTray();

        Load += delegate
        {
            client.StartBackend();
            client.WaitForBackend();
            RunFirstLaunchGuide();
            RefreshAll();
            pollTimer.Start();
            watchdogTimer.Start();
            if (backgroundStart) HideToTray();
        };
        FormClosing += OnFormClosing;
    }

    private void BuildUi()
    {
        TableLayoutPanel root = new TableLayoutPanel();
        root.Dock = DockStyle.Fill;
        root.ColumnCount = 2;
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 286));
        root.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Controls.Add(root);

        Panel sidebar = new Panel();
        sidebar.Dock = DockStyle.Fill;
        sidebar.BackColor = SidebarBg;
        sidebar.Padding = new Padding(18);
        root.Controls.Add(sidebar, 0, 0);

        Panel brand = new Panel();
        brand.Dock = DockStyle.Top;
        brand.Height = 92;
        sidebar.Controls.Add(brand);

        PictureBox logo = new PictureBox();
        logo.Image = NativeClient.LoadLogo();
        logo.SizeMode = PictureBoxSizeMode.Zoom;
        logo.SetBounds(0, 8, 58, 58);
        brand.Controls.Add(logo);

        Label title = new Label();
        title.Text = "88FRP";
        title.ForeColor = Color.White;
        title.Font = new Font("Segoe UI Semibold", 18F, FontStyle.Bold);
        title.SetBounds(70, 10, 160, 30);
        brand.Controls.Add(title);

        Label sub = new Label();
        sub.Text = "Windows tunnel manager";
        sub.ForeColor = Color.FromArgb(163, 180, 204);
        sub.Font = new Font("Segoe UI", 9F);
        sub.SetBounds(72, 44, 180, 24);
        brand.Controls.Add(sub);

        Button createButton = StyledButton("＋  新建实例", Accent2, Color.White);
        createButton.Dock = DockStyle.Top;
        createButton.Height = 40;
        createButton.Click += delegate { Safe(CreateInstance); };
        sidebar.Controls.Add(createButton);
        createButton.BringToFront();

        Label listTitle = new Label();
        listTitle.Text = "实例";
        listTitle.ForeColor = Color.FromArgb(194, 207, 226);
        listTitle.Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Bold);
        listTitle.Dock = DockStyle.Top;
        listTitle.Height = 34;
        listTitle.Padding = new Padding(2, 14, 0, 0);
        sidebar.Controls.Add(listTitle);
        listTitle.BringToFront();

        instanceList.Dock = DockStyle.Fill;
        instanceList.BorderStyle = BorderStyle.None;
        instanceList.BackColor = SidebarBg;
        instanceList.ForeColor = Color.White;
        instanceList.ItemHeight = 48;
        instanceList.DrawMode = DrawMode.OwnerDrawFixed;
        instanceList.DrawItem += DrawInstanceItem;
        instanceList.SelectedIndexChanged += delegate { Safe(SelectCurrentInstance); };
        sidebar.Controls.Add(instanceList);
        instanceList.BringToFront();

        TableLayoutPanel main = new TableLayoutPanel();
        main.Dock = DockStyle.Fill;
        main.Padding = new Padding(24);
        main.RowCount = 4;
        main.RowStyles.Add(new RowStyle(SizeType.Absolute, 86));
        main.RowStyles.Add(new RowStyle(SizeType.Absolute, 104));
        main.RowStyles.Add(new RowStyle(SizeType.Absolute, 58));
        main.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.Controls.Add(main, 1, 0);

        main.Controls.Add(BuildHeader(), 0, 0);
        main.Controls.Add(BuildStatusCards(), 0, 1);
        main.Controls.Add(BuildSettingsBar(), 0, 2);
        main.Controls.Add(BuildTabs(), 0, 3);

        pollTimer.Interval = 4000;
        pollTimer.Tick += delegate { SafeSilent(delegate { RefreshInstances(true); }); };
        watchdogTimer.Interval = 10000;
        watchdogTimer.Tick += delegate { if (!client.IsBackendHealthy()) client.StartBackend(); };
    }

    private Control BuildHeader()
    {
        TableLayoutPanel header = new TableLayoutPanel();
        header.Dock = DockStyle.Fill;
        header.ColumnCount = 2;
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 520));

        Panel copy = new Panel();
        copy.Dock = DockStyle.Fill;
        Label h1 = new Label();
        h1.Text = "控制台";
        h1.Font = new Font("Microsoft YaHei UI", 22F, FontStyle.Bold);
        h1.ForeColor = TextMain;
        h1.SetBounds(0, 4, 240, 38);
        copy.Controls.Add(h1);
        Label desc = new Label();
        desc.Text = "只运行你选择的隧道，同步后也会记住选择。";
        desc.ForeColor = TextMuted;
        desc.SetBounds(2, 46, 420, 24);
        copy.Controls.Add(desc);
        header.Controls.Add(copy, 0, 0);

        FlowLayoutPanel actions = new FlowLayoutPanel();
        actions.Dock = DockStyle.Fill;
        actions.FlowDirection = FlowDirection.RightToLeft;
        actions.Padding = new Padding(0, 12, 0, 0);
        actions.WrapContents = false;
        header.Controls.Add(actions, 1, 0);

        Button syncButton = StyledButton("同步配置", Accent, Color.White);
        Button restartButton = StyledButton("重启", Color.FromArgb(79, 70, 229), Color.White);
        Button stopButton = StyledButton("停止", Color.White, Color.FromArgb(185, 28, 28));
        Button startButton = StyledButton("启动", Color.FromArgb(22, 163, 74), Color.White);
        syncButton.Click += delegate { Safe(SyncCurrent); };
        restartButton.Click += delegate { Safe(delegate { RuntimeAction("restart"); }); };
        stopButton.Click += delegate { Safe(delegate { RuntimeAction("stop"); }); };
        startButton.Click += delegate { Safe(delegate { RuntimeAction("start"); }); };
        actions.Controls.Add(syncButton);
        actions.Controls.Add(restartButton);
        actions.Controls.Add(stopButton);
        actions.Controls.Add(startButton);
        return header;
    }

    private Control BuildStatusCards()
    {
        TableLayoutPanel cards = new TableLayoutPanel();
        cards.Dock = DockStyle.Fill;
        cards.ColumnCount = 3;
        cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.33F));
        cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.33F));
        cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 33.33F));
        statusValue.Text = "-";
        pidValue.Text = "-";
        backendValue.Text = "检查中";
        cards.Controls.Add(StatusCard("实例状态", statusValue, Accent2), 0, 0);
        cards.Controls.Add(StatusCard("进程 PID", pidValue, Accent), 1, 0);
        cards.Controls.Add(StatusCard("后台核心", backendValue, Color.FromArgb(245, 158, 11)), 2, 0);
        return cards;
    }

    private Control BuildSettingsBar()
    {
        Panel shell = CardPanel();
        shell.Padding = new Padding(16, 12, 16, 10);
        FlowLayoutPanel bar = new FlowLayoutPanel();
        bar.Dock = DockStyle.Fill;
        bar.WrapContents = false;
        shell.Controls.Add(bar);

        bar.Controls.Add(LabelText("密钥"));
        secretBox.Width = 260;
        secretBox.Height = 30;
        secretBox.BorderStyle = BorderStyle.FixedSingle;
        bar.Controls.Add(secretBox);

        autoSyncBox.Text = "自动同步";
        autoSyncBox.AutoSize = true;
        autoSyncBox.Padding = new Padding(16, 6, 8, 0);
        bar.Controls.Add(autoSyncBox);

        autoStartButton = StyledButton(NativeClient.IsAutoStartEnabled() ? "关闭开机自启" : "开启开机自启", Color.White, Accent);
        autoStartButton.Width = 132;
        autoStartButton.Click += delegate { Safe(ToggleAutoStart); };
        bar.Controls.Add(autoStartButton);
        return shell;
    }

    private Control BuildTabs()
    {
        tabs.Dock = DockStyle.Fill;
        tabs.Font = new Font("Microsoft YaHei UI", 10F);

        TabPage configTab = new TabPage("配置文件");
        configTab.BackColor = PanelBg;
        configBox.Multiline = true;
        configBox.ScrollBars = ScrollBars.Both;
        configBox.AcceptsTab = true;
        configBox.Font = new Font("Consolas", 10F);
        configBox.Dock = DockStyle.Fill;
        configBox.BorderStyle = BorderStyle.None;
        Button saveConfigButton = BottomButton("保存配置");
        saveConfigButton.Click += delegate { Safe(SaveConfig); };
        configTab.Controls.Add(configBox);
        configTab.Controls.Add(saveConfigButton);
        tabs.TabPages.Add(configTab);

        TabPage tunnelTab = new TabPage("隧道选择");
        tunnelTab.BackColor = PanelBg;
        Label hint = new Label();
        hint.Text = "勾选要运行的隧道；未勾选的会保留配置但不会启动。新同步隧道默认关闭。";
        hint.Dock = DockStyle.Top;
        hint.Height = 38;
        hint.ForeColor = TextMuted;
        hint.Padding = new Padding(12, 10, 0, 0);
        tunnelList.Dock = DockStyle.Fill;
        tunnelList.CheckOnClick = true;
        tunnelList.BorderStyle = BorderStyle.None;
        tunnelList.Font = new Font("Microsoft YaHei UI", 10F);
        tunnelList.ItemHeight = 30;
        Button saveTunnelsButton = BottomButton("保存隧道选择");
        saveTunnelsButton.Click += delegate { Safe(SaveTunnels); };
        tunnelTab.Controls.Add(tunnelList);
        tunnelTab.Controls.Add(hint);
        tunnelTab.Controls.Add(saveTunnelsButton);
        tabs.TabPages.Add(tunnelTab);

        TabPage logTab = new TabPage("运行日志");
        logTab.BackColor = Color.FromArgb(15, 23, 42);
        logsBox.Multiline = true;
        logsBox.ReadOnly = true;
        logsBox.ScrollBars = ScrollBars.Both;
        logsBox.Font = new Font("Consolas", 10F);
        logsBox.Dock = DockStyle.Fill;
        logsBox.BackColor = Color.FromArgb(15, 23, 42);
        logsBox.ForeColor = Color.FromArgb(226, 232, 240);
        logsBox.BorderStyle = BorderStyle.None;
        Button refreshLogsButton = BottomButton("刷新日志");
        refreshLogsButton.Click += delegate { Safe(LoadLogs); };
        logTab.Controls.Add(logsBox);
        logTab.Controls.Add(refreshLogsButton);
        tabs.TabPages.Add(logTab);
        return tabs;
    }

    private Panel StatusCard(string title, Label valueLabel, Color dotColor)
    {
        Panel card = CardPanel();
        card.Margin = new Padding(0, 0, 14, 14);
        Label dot = new Label();
        dot.BackColor = dotColor;
        dot.SetBounds(16, 18, 10, 10);
        card.Controls.Add(dot);
        Label titleLabel = new Label();
        titleLabel.Text = title;
        titleLabel.ForeColor = TextMuted;
        titleLabel.SetBounds(34, 14, 180, 22);
        card.Controls.Add(titleLabel);
        valueLabel.Font = new Font("Microsoft YaHei UI", 16F, FontStyle.Bold);
        valueLabel.ForeColor = TextMain;
        valueLabel.SetBounds(16, 42, 240, 36);
        card.Controls.Add(valueLabel);
        return card;
    }

    private Panel CardPanel()
    {
        Panel panel = new Panel();
        panel.Dock = DockStyle.Fill;
        panel.BackColor = PanelBg;
        panel.Paint += delegate(object sender, PaintEventArgs e)
        {
            Control c = (Control)sender;
            using (Pen pen = new Pen(Border))
            {
                e.Graphics.DrawRectangle(pen, 0, 0, c.Width - 1, c.Height - 1);
            }
        };
        return panel;
    }

    private Label LabelText(string text)
    {
        Label label = new Label();
        label.Text = text;
        label.ForeColor = TextMuted;
        label.AutoSize = true;
        label.Padding = new Padding(0, 7, 8, 0);
        return label;
    }

    private Button StyledButton(string text, Color back, Color fore)
    {
        Button button = new Button();
        button.Text = text;
        button.Width = 104;
        button.Height = 34;
        button.Margin = new Padding(8, 0, 0, 0);
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderColor = back == Color.White ? Border : back;
        button.FlatAppearance.BorderSize = 1;
        button.BackColor = back;
        button.ForeColor = fore;
        button.Cursor = Cursors.Hand;
        return button;
    }

    private Button BottomButton(string text)
    {
        Button button = StyledButton(text, Accent, Color.White);
        button.Dock = DockStyle.Bottom;
        button.Height = 42;
        button.Width = 160;
        button.Margin = new Padding(0);
        return button;
    }

    private void DrawInstanceItem(object sender, DrawItemEventArgs e)
    {
        if (e.Index < 0) return;
        bool selected = (e.State & DrawItemState.Selected) == DrawItemState.Selected;
        Rectangle rect = e.Bounds;
        using (SolidBrush bg = new SolidBrush(selected ? Color.FromArgb(37, 99, 235) : SidebarBg))
        {
            e.Graphics.FillRectangle(bg, rect);
        }
        InstanceListItem item = instanceList.Items[e.Index] as InstanceListItem;
        string text = item == null ? "" : item.Text;
        using (Font font = new Font("Microsoft YaHei UI", 9F, selected ? FontStyle.Bold : FontStyle.Regular))
        {
            Rectangle textRect = new Rectangle(rect.Left + 12, rect.Top, rect.Width - 20, rect.Height);
            TextRenderer.DrawText(
                e.Graphics,
                text,
                font,
                textRect,
                Color.White,
                TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix
            );
        }
    }

    internal static void UseGdiTextRendering(Control root)
    {
        Label label = root as Label;
        if (label != null) label.UseCompatibleTextRendering = false;

        Button button = root as Button;
        if (button != null) button.UseCompatibleTextRendering = false;

        CheckBox checkBox = root as CheckBox;
        if (checkBox != null) checkBox.UseCompatibleTextRendering = false;

        foreach (Control child in root.Controls) UseGdiTextRendering(child);
    }

    private void BuildTray()
    {
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add("打开 88FRP", null, delegate { ShowFromTray(); });
        menu.Items.Add("打开网页控制台", null, delegate { NativeClient.OpenConsoleFallback(); });
        menu.Items.Add("重启后台", null, delegate { client.RestartBackend(); RefreshAll(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, delegate { closingForExit = true; trayIcon.Visible = false; client.StopBackend(); Close(); });
        trayIcon.Icon = NativeClient.LoadAppIcon();
        trayIcon.Text = "88FRP 正在后台运行";
        trayIcon.Visible = true;
        trayIcon.ContextMenuStrip = menu;
        trayIcon.DoubleClick += delegate { ShowFromTray(); };
    }

    private void OnFormClosing(object sender, FormClosingEventArgs e)
    {
        if (!closingForExit)
        {
            e.Cancel = true;
            HideToTray();
        }
    }

    private void Safe(Action action)
    {
        try
        {
            action();
        }
        catch (Exception ex)
        {
            MessageBox.Show(FriendlyError(ex), Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            backendValue.Text = "错误";
        }
    }

    private void SafeSilent(Action action)
    {
        try
        {
            action();
        }
        catch
        {
        }
    }

    private string FriendlyError(Exception ex)
    {
        string message = ex.Message;
        if (message.IndexOf("HTTP 500", StringComparison.OrdinalIgnoreCase) >= 0 ||
            message.IndexOf("(500)", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            return "操作失败：远程配置接口返回 500。\n\n通常是密钥不正确、远程服务临时异常，或 88FRP 平台没有返回有效配置。\n请检查密钥后再同步。";
        }
        if (message.IndexOf("HTTP 401", StringComparison.OrdinalIgnoreCase) >= 0 ||
            message.IndexOf("HTTP 403", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            return "操作失败：密钥无效或没有权限。\n请检查密钥是否正确。";
        }
        return message;
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == showWindowMessage)
        {
            ShowFromTray();
            return;
        }
        base.WndProc(ref m);
    }

    private void HideToTray()
    {
        Hide();
        trayIcon.ShowBalloonTip(1600, "88FRP", "已保持后台运行，可从托盘图标重新打开。", ToolTipIcon.Info);
    }

    private void ShowFromTray()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
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
        DialogResult result = MessageBox.Show(
            "是否开启开机自启动并保持后台运行？\n\n开启后，登录 Windows 后会自动启动 88FRP，并恢复之前启用的实例和已选择隧道。",
            "88FRP 首次启动设置",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question
        );
        if (result == DialogResult.Yes)
        {
            NativeClient.EnableAutoStart();
            autoStartButton.Text = "关闭开机自启";
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
        RefreshInstances(true);
        if (!string.IsNullOrEmpty(currentInstanceId)) LoadCurrentDetails();
    }

    private void RefreshInstances(bool keepSelection)
    {
        try
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
                int index = instanceList.Items.Add(new InstanceListItem { Id = id, Text = name + "  ·  " + TranslateStatus(status) });
                if (id == selectedId) instanceList.SelectedIndex = index;
            }
            if (instanceList.SelectedIndex < 0 && instanceList.Items.Count > 0) instanceList.SelectedIndex = 0;
        }
        catch (Exception ex)
        {
            backendValue.Text = ex.Message;
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
        autoSyncBox.Checked = NativeClient.GetBool(instance, "autoSyncEnabled");
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
        tunnelList.Items.Clear();
        if (string.IsNullOrEmpty(currentInstanceId)) return;
        Dictionary<string, object> data = client.GetDict("/api/instances/" + currentInstanceId + "/tunnels");
        object[] rows = NativeClient.AsArray(data.ContainsKey("tunnels") ? data["tunnels"] : null);
        foreach (object row in rows)
        {
            Dictionary<string, object> tunnel = NativeClient.AsDict(row);
            tunnels.Add(tunnel);
            string name = NativeClient.GetString(tunnel, "name");
            string meta = NativeClient.GetString(tunnel, "type") + "    本地 " + NativeClient.GetString(tunnel, "localPort") + "  →  远程 " + NativeClient.GetString(tunnel, "remotePort");
            tunnelList.Items.Add(name + "        " + meta, NativeClient.GetBool(tunnel, "enabled"));
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
        using (CreateInstanceForm form = new CreateInstanceForm())
        {
            if (form.ShowDialog(this) != DialogResult.OK) return;
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["name"] = form.InstanceName;
            payload["secretKey"] = form.SecretKey;
            payload["autoSyncEnabled"] = form.AutoSync;
            Dictionary<string, object> created = client.PostDict("/api/instances", payload);
            currentInstanceId = NativeClient.GetString(created, "id");
            RefreshInstances(true);
        }
    }

    private void SaveConfig()
    {
        if (string.IsNullOrEmpty(currentInstanceId)) return;
        Dictionary<string, object> info = new Dictionary<string, object>();
        info["secretKey"] = secretBox.Text.Trim();
        info["autoSyncEnabled"] = autoSyncBox.Checked;
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
        for (int i = 0; i < tunnels.Count; i++) selection[NativeClient.GetString(tunnels[i], "name")] = tunnelList.GetItemChecked(i);
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
        info["autoSyncEnabled"] = autoSyncBox.Checked;
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
            autoStartButton.Text = "开启开机自启";
        }
        else
        {
            NativeClient.EnableAutoStart();
            autoStartButton.Text = "关闭开机自启";
        }
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

internal sealed class CreateInstanceForm : Form
{
    private readonly TextBox nameBox = new TextBox();
    private readonly TextBox secretBox = new TextBox();
    private readonly CheckBox autoSyncBox = new CheckBox();
    public string InstanceName { get { return nameBox.Text.Trim(); } }
    public string SecretKey { get { return secretBox.Text.Trim(); } }
    public bool AutoSync { get { return autoSyncBox.Checked; } }

    public CreateInstanceForm()
    {
        Text = "创建实例";
        AutoScaleMode = AutoScaleMode.Dpi;
        Width = 430;
        Height = 230;
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        Icon = NativeClient.LoadAppIcon();
        MainForm.UseGdiTextRendering(this);

        TableLayoutPanel layout = new TableLayoutPanel();
        layout.Dock = DockStyle.Fill;
        layout.Padding = new Padding(18);
        layout.RowCount = 4;
        layout.ColumnCount = 2;
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 80));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        Controls.Add(layout);
        layout.Controls.Add(new Label { Text = "名称", AutoSize = true }, 0, 0);
        nameBox.Dock = DockStyle.Fill;
        layout.Controls.Add(nameBox, 1, 0);
        layout.Controls.Add(new Label { Text = "密钥", AutoSize = true }, 0, 1);
        secretBox.Dock = DockStyle.Fill;
        layout.Controls.Add(secretBox, 1, 1);
        autoSyncBox.Text = "创建后自动同步";
        autoSyncBox.AutoSize = true;
        layout.Controls.Add(autoSyncBox, 1, 2);

        FlowLayoutPanel actions = new FlowLayoutPanel();
        actions.Dock = DockStyle.Fill;
        actions.FlowDirection = FlowDirection.RightToLeft;
        Button ok = new Button { Text = "创建", DialogResult = DialogResult.OK, Width = 88 };
        Button cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Width = 88 };
        actions.Controls.Add(ok);
        actions.Controls.Add(cancel);
        layout.Controls.Add(actions, 0, 3);
        layout.SetColumnSpan(actions, 2);
        AcceptButton = ok;
        CancelButton = cancel;
        ok.Click += delegate
        {
            if (InstanceName == "")
            {
                MessageBox.Show("请输入实例名称。");
                DialogResult = DialogResult.None;
            }
        };
    }
}

internal static class DpiSupport
{
    private enum ProcessDpiAwareness
    {
        ProcessDpiUnaware = 0,
        ProcessSystemDpiAware = 1,
        ProcessPerMonitorDpiAware = 2
    }

    [DllImport("Shcore.dll")]
    private static extern int SetProcessDpiAwareness(ProcessDpiAwareness awareness);

    [DllImport("user32.dll")]
    private static extern bool SetProcessDPIAware();

    internal static void Enable()
    {
        try
        {
            SetProcessDpiAwareness(ProcessDpiAwareness.ProcessPerMonitorDpiAware);
            return;
        }
        catch
        {
        }

        try
        {
            SetProcessDPIAware();
        }
        catch
        {
        }
    }
}

internal sealed class InstanceListItem
{
    public string Id;
    public string Text;
    public override string ToString() { return Text; }
}

internal sealed class NativeClient
{
    internal static readonly int ShowWindowMessage = RegisterWindowMessage("88FRP_SHOW_NATIVE_WINDOW");
    private readonly JavaScriptSerializer serializer = new JavaScriptSerializer();
    private Process backendProcess;

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern int RegisterWindowMessage(string lpString);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    internal static void SignalExistingInstance()
    {
        PostMessage(new IntPtr(0xffff), ShowWindowMessage, IntPtr.Zero, IntPtr.Zero);
    }

    public static string AppFile(string name)
    {
        return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, name);
    }

    public static Icon LoadAppIcon()
    {
        string path = AppFile("88frp-logo.ico");
        if (File.Exists(path)) return new Icon(path);
        return SystemIcons.Application;
    }

    public static Image LoadLogo()
    {
        string path = AppFile("88frp-logo.png");
        if (File.Exists(path)) return Image.FromFile(path);
        Bitmap bitmap = new Bitmap(64, 64);
        using (Graphics g = Graphics.FromImage(bitmap))
        using (LinearGradientBrush brush = new LinearGradientBrush(new Rectangle(0, 0, 64, 64), Color.FromArgb(37, 99, 235), Color.FromArgb(20, 184, 166), 45F))
        {
            g.FillEllipse(brush, 4, 4, 56, 56);
        }
        return bitmap;
    }

    public void StartBackend()
    {
        if (IsBackendHealthy()) return;
        string backendPath = AppFile("88frp-web.exe");
        if (!File.Exists(backendPath))
        {
            MessageBox.Show("没有找到后台核心文件：" + backendPath, Program.AppName, MessageBoxButtons.OK, MessageBoxIcon.Error);
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
                using (StreamReader reader = new StreamReader(ex.Response.GetResponseStream(), Encoding.UTF8))
                {
                    body = reader.ReadToEnd();
                }
            }

            if (!string.IsNullOrEmpty(body))
            {
                try
                {
                    ReadEnvelope(body);
                }
                catch (Exception parsed)
                {
                    throw parsed;
                }
            }

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
