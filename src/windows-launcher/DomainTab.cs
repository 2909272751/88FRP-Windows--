using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;


    /// <summary>
    /// 域名绑定页（桌面客户端原生实现）。
    ///
    /// 为什么在客户端里再写一套，而不是内嵌网页：
    /// 内嵌 WebBrowser 走 IE 内核，现代 JS 支持有限，且用户会看到
    /// 一套和客户端风格完全不同的界面。这里的控件全部用客户端已有的
    /// 样式（Card / PrimaryButton / 同一套配色），观感统一。
    ///
    /// 逻辑与网页版共享同一批后端接口（/api/instances/:id/domain-binding*），
    /// 所以两边的配置、开关、账本都是同一份数据，不会不一致。
    /// </summary>
    internal sealed partial class MainWindow
    {
        // ---- 域名绑定页的控件 ----
        private TextBlock domainStatusChip;
        private TextBlock domainRecordText;
        private TextBlock domainRecordSub;
        private TextBox domainZoneInput;
        private PasswordBox domainTokenInput;
        private Button domainSaveTokenButton;
        private TextBlock domainAuthMsg;
        private StackPanel domainChecksPanel;
        private CheckBox domainEnabledCheck;
        private CheckBox domainCanWriteCheck;
        private CheckBox domainAutoFollowCheck;
        private TextBlock domainAutoStatus;
        private bool renderingDomain;
        private bool loadingDomain;
        private readonly Thickness domainCardPadding = new Thickness(18);
        private readonly Thickness domainCardGap = new Thickness(0, 0, 0, 16);
        private readonly Thickness domainRowGap = new Thickness(0, 10, 0, 10);
        private TextBlock domainRoleHint;
        private StackPanel domainLinksPanel;
        private TextBlock domainLinksHeader;
        private Button domainPlanButton;
        private Button domainSyncButton;
        private Button domainCopyAllButton;
        private TextBlock domainPlanResult;
        private Expander domainAuthExpander;

        // 缓存最近一次状态，供「复制全部」拼文本
        private Dictionary<string, object> lastDomainStatus;

        private readonly JavaScriptSerializer domainSerializer = new JavaScriptSerializer();

        /* ================================================================ 构建 */

        private TabItem BuildDomainTab()
        {
            TabItem tab = new TabItem { Header = "域名绑定" };

            DockPanel dock = new DockPanel { Background = CardBrush };

            // 顶部：标题 + 状态徽标
            Grid header = new Grid { Margin = new Thickness(24, 20, 24, 16) };
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            StackPanel headCopy = new StackPanel();
            headCopy.Children.Add(new TextBlock
            {
                Text = "域名绑定",
                FontSize = 16,
                FontWeight = FontWeights.Bold,
                Foreground = TextBrush
            });
            headCopy.Children.Add(new TextBlock
            {
                Text = "把隧道映射到一个域名，节点 IP 变了自动跟着改。",
                FontSize = 12,
                Foreground = MutedBrush,
                Margin = new Thickness(0, 2, 0, 0)
            });
            Grid.SetColumn(headCopy, 0);
            header.Children.Add(headCopy);

            domainStatusChip = new TextBlock
            {
                Text = "未配置",
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = MutedBrush,
                Padding = new Thickness(10, 4, 10, 4),
                Margin = new Thickness(8, 4, 0, 0)
            };
            Border chipBorder = new Border
            {
                Child = domainStatusChip,
                BorderBrush = UiBorderBrush,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10),
                VerticalAlignment = VerticalAlignment.Top
            };
            Grid.SetColumn(chipBorder, 1);
            header.Children.Add(chipBorder);

            DockPanel.SetDock(header, Dock.Top);
            dock.Children.Add(header);

            // 底部：预览 / 立即同步
            StackPanel footer = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                HorizontalAlignment = HorizontalAlignment.Right,
                Margin = new Thickness(24, 12, 24, 20)
            };
            domainPlanButton = OutlineButton("预览变更", AccentTextBrush);
            domainPlanButton.Click += delegate { Safe(delegate { DomainPlan(); }); };
            domainSyncButton = PrimaryButton("立即同步", AccentBrush);
            domainSyncButton.Click += delegate { Safe(delegate { DomainSync(); }); };
            footer.Children.Add(domainPlanButton);
            footer.Children.Add(domainSyncButton);
            DockPanel.SetDock(footer, Dock.Bottom);
            dock.Children.Add(footer);

            // 中间：可滚动内容
            StackPanel body = new StackPanel { Margin = new Thickness(24, 0, 24, 16) };
            body.Children.Add(BuildDomainAuthCard());
            body.Children.Add(BuildDomainTogglesCard());
            body.Children.Add(BuildDomainRecordCard());
            body.Children.Add(BuildDomainLinksCard());

            ScrollViewer scroll = new ScrollViewer
            {
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                Content = body
            };
            dock.Children.Add(scroll);

            tab.Content = dock;

            // 每次切到本页都刷新一次，保证看到最新状态
            // TabItem 没有 Selected 事件；用 TabControl.SelectionChanged 更可靠
            tab.Loaded += delegate
            {
                if (domainTabs != null && domainTabs.SelectedItem == tab) Safe(delegate { LoadDomainBinding(); });
            };

            return tab;
        }

        /// <summary>Cloudflare 授权卡片：默认收起，未授权时自动展开</summary>
        private UIElement BuildDomainAuthCard()
        {
            StackPanel panel = new StackPanel();

            domainZoneInput = new TextBox
            {
                Height = 32,
                FontSize = 13,
                Margin = new Thickness(0, 0, 0, 8),
                Padding = new Thickness(8, 0, 8, 0),
                VerticalContentAlignment = VerticalAlignment.Center
            };
            domainTokenInput = new PasswordBox
            {
                Height = 32,
                FontSize = 13,
                Margin = new Thickness(0, 0, 0, 8),
                Padding = new Thickness(8, 0, 8, 0),
                VerticalContentAlignment = VerticalAlignment.Center
            };

            panel.Children.Add(new TextBlock
            {
                Text = "域名",
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = MutedBrush,
                Margin = new Thickness(0, 0, 0, 4)
            });
            panel.Children.Add(domainZoneInput);
            panel.Children.Add(new TextBlock
            {
                Text = "API Token（Cloudflare → API Tokens → Edit zone DNS 模板）",
                FontSize = 12,
                FontWeight = FontWeights.SemiBold,
                Foreground = MutedBrush,
                Margin = new Thickness(0, 0, 0, 4)
            });
            panel.Children.Add(domainTokenInput);

            StackPanel actions = new StackPanel
            {
                Orientation = Orientation.Horizontal,
                Margin = new Thickness(0, 6, 0, 0)
            };
            domainSaveTokenButton = PrimaryButton("验证并保存", AccentBrush);
            domainSaveTokenButton.Click += delegate { Safe(delegate { DomainSaveToken(); }); };
            actions.Children.Add(domainSaveTokenButton);

            domainAuthMsg = new TextBlock
            {
                FontSize = 12,
                Foreground = MutedBrush,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(10, 0, 0, 0),
                TextWrapping = TextWrapping.Wrap
            };
            actions.Children.Add(domainAuthMsg);
            panel.Children.Add(actions);

            domainChecksPanel = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
            panel.Children.Add(domainChecksPanel);

            domainAuthExpander = new Expander
            {
                Header = "Cloudflare 授权",
                IsExpanded = false,
                Margin = new Thickness(0, 0, 0, 0),
                Content = panel
            };

            Border card = Card();
            card.Padding = domainCardPadding;
            card.Margin = domainCardGap;
            card.Child = domainAuthExpander;
            return card;
        }

        /// <summary>两个开关：总开关 + 本机是否修改解析</summary>
        private UIElement BuildDomainTogglesCard()
        {
            StackPanel panel = new StackPanel();

            domainEnabledCheck = new CheckBox
            {
                Content = "启用域名绑定",
                FontSize = 13,
                IsChecked = true,
                Margin = new Thickness(0, 0, 0, 2)
            };
            domainEnabledCheck.Checked += delegate { Safe(delegate { DomainSaveToggle("enabled", true); }); };
            domainEnabledCheck.Unchecked += delegate { Safe(delegate { DomainSaveToggle("enabled", false); }); };
            panel.Children.Add(domainEnabledCheck);
            panel.Children.Add(new TextBlock
            {
                Text = "关掉后不再改动 DNS，已绑的域名继续有效",
                FontSize = 12,
                Foreground = MutedBrush,
                Margin = new Thickness(20, 0, 0, 10)
            });

            domainAutoFollowCheck = new CheckBox {
                Content = "自动跟随节点 IP", FontSize = 13, Margin = new Thickness(0, 8, 0, 8)
            };
            domainAutoFollowCheck.Checked += delegate { DomainSaveToggle("autoFollow", true); };
            domainAutoFollowCheck.Unchecked += delegate { DomainSaveToggle("autoFollow", false); };
            panel.Children.Add(domainAutoFollowCheck);
            panel.Children.Add(new TextBlock { Text = "每 60 秒检查；网络恢复后自动重试，暂停后仍可手动同步。", FontSize = 12,
                Foreground = MutedBrush, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(20, 0, 0, 18) });

            domainCanWriteCheck = new CheckBox
            {
                Content = "由本机修改解析",
                FontSize = 13,
                IsChecked = true,
                Margin = new Thickness(0, 0, 0, 2)
            };
            domainCanWriteCheck.Checked += delegate { Safe(delegate { DomainSaveToggle("canWrite", true); }); };
            domainCanWriteCheck.Unchecked += delegate { Safe(delegate { DomainSaveToggle("canWrite", false); }); };
            panel.Children.Add(domainCanWriteCheck);

            domainRoleHint = new TextBlock
            {
                Text = "多台设备只能开一台，否则会互相覆盖",
                FontSize = 12,
                Foreground = MutedBrush,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(20, 0, 0, 0)
            };
            panel.Children.Add(domainRoleHint);

            Border card = Card();
            card.Padding = domainCardPadding;
            card.Margin = domainCardGap;
            card.Child = panel;
            return card;
        }

        /// <summary>当前记录卡片</summary>
        private UIElement BuildDomainRecordCard()
        {
            StackPanel panel = new StackPanel();

            panel.Children.Add(new TextBlock
            {
                Text = "当前记录",
                FontSize = 12,
                Foreground = MutedBrush
            });

            domainRecordText = new TextBlock
            {
                Text = "—",
                FontSize = 14,
                FontWeight = FontWeights.Bold,
                Foreground = TextBrush,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 2, 0, 0)
            };
            panel.Children.Add(domainRecordText);

            domainRecordSub = new TextBlock
            {
                Text = "",
                FontSize = 12,
                Foreground = MutedBrush,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 2, 0, 0)
            };
            panel.Children.Add(domainRecordSub);
            domainAutoStatus = new TextBlock { Foreground = MutedBrush, FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) };
            panel.Children.Add(domainAutoStatus);

            domainPlanResult = new TextBlock
            {
                Text = "",
                FontSize = 12,
                Foreground = MutedBrush,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 8, 0, 0)
            };
            panel.Children.Add(domainPlanResult);

            Border card = Card();
            card.Padding = domainCardPadding;
            card.Margin = domainCardGap;
            card.Child = panel;
            return card;
        }

        /// <summary>访问链接列表 + 复制全部</summary>
        private UIElement BuildDomainLinksCard()
        {
            StackPanel outer = new StackPanel();

            Grid header = new Grid { Margin = new Thickness(0, 0, 0, 6) };
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            header.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

            domainLinksHeader = new TextBlock
            {
                Text = "访问链接",
                FontSize = 13,
                FontWeight = FontWeights.Bold,
                Foreground = TextBrush,
                VerticalAlignment = VerticalAlignment.Center
            };
            Grid.SetColumn(domainLinksHeader, 0);
            header.Children.Add(domainLinksHeader);

            domainCopyAllButton = OutlineButton("复制全部", AccentTextBrush);
            domainCopyAllButton.Height = 28;
            domainCopyAllButton.MinWidth = 88;
            domainCopyAllButton.FontSize = 12;
            domainCopyAllButton.Click += delegate { Safe(delegate { DomainCopyAll(); }); };
            Grid.SetColumn(domainCopyAllButton, 1);
            header.Children.Add(domainCopyAllButton);

            outer.Children.Add(header);

            domainLinksPanel = new StackPanel();
            outer.Children.Add(domainLinksPanel);

            Border card = Card();
            card.Padding = domainCardPadding;
            card.Child = outer;
            return card;
        }

        /* ================================================================ 加载 */

        private async void LoadDomainBinding()
        {
            if (string.IsNullOrEmpty(currentInstanceId) || loadingDomain) return;
            string id = currentInstanceId;
            loadingDomain = true;
            Dictionary<string, object> data;
            try { data = await Task.Run(() => client.GetDict("/api/instances/" + id + "/domain-binding")); }
            catch (Exception ex) { domainRecordSub.Text = ex.Message; return; }
            finally { loadingDomain = false; }
            if (currentInstanceId != id) { LoadDomainBinding(); return; }
            if (data == null) return;
            lastDomainStatus = data;

            Dictionary<string, object> config = DomainDict(data, "config");
            bool enabled = DomainBool(config, "enabled", false);
            bool canWrite = DomainBool(config, "canWrite", false);
            string zone = DomainStr(config, "zone");
            bool hasToken = DomainBool(data, "hasToken", false);

            // 开关
            renderingDomain = true;
            try {
                domainEnabledCheck.IsChecked = enabled;
                domainCanWriteCheck.IsChecked = canWrite;
                domainAutoFollowCheck.IsChecked = DomainBool(config, "autoFollow", true);
            } finally { renderingDomain = false; }
            domainAutoStatus.Text = DomainStr(data, "autoStatus") + (DomainStr(data, "lastError") == "" ? "" : " · " + DomainStr(data, "lastError"));
            domainAutoStatus.Foreground = DomainStr(data, "lastError") == "" ? MutedBrush : DangerBrush;
            domainRoleHint.Text = canWrite
                ? "本机会自动修改 DNS 记录。其他设备请关掉这个开关，否则它们会互相覆盖解析。"
                : "本机不改 DNS，只查看状态。适合「一台设备负责改，其他设备跟着用」的场景。";

            // 状态徽标
            if (string.IsNullOrEmpty(zone))
            {
                domainStatusChip.Text = "未配置";
                domainStatusChip.Foreground = MutedBrush;
            }
            else if (!enabled)
            {
                domainStatusChip.Text = "已停用";
                domainStatusChip.Foreground = MutedBrush;
            }
            else
            {
                domainStatusChip.Text = canWrite ? "本机写入" : "只读";
                domainStatusChip.Foreground = canWrite ? AccentGreenBrush : MutedBrush;
            }

            // 授权区：未授权时自动展开引导
            if (string.IsNullOrEmpty(domainZoneInput.Text) && !string.IsNullOrEmpty(zone))
                domainZoneInput.Text = zone;
            if (!hasToken) domainAuthExpander.IsExpanded = true;
            domainAuthExpander.Header = hasToken
                ? "Cloudflare 授权 · 已配置"
                : "Cloudflare 授权 · 需要配置";

            // 记录
            Dictionary<string, object> record = DomainDict(data, "record");
            if (record == null)
            {
                domainRecordText.Text = "没有可发布的隧道";
                domainRecordSub.Text = string.IsNullOrEmpty(DomainStr(data, "nodeAddr"))
                    ? "实例未运行，读不到节点地址"
                    : "同步配置后会显示全部隧道（含未启用）";
            }
            else
            {
                domainRecordText.Text = DomainStr(record, "fqdn") + " → " + DomainStr(record, "content");
                int linkCount = DomainList(data, "links").Count;
                string lastSync = DomainStr(data, "lastSyncAt");
                string when = string.IsNullOrEmpty(lastSync) ? "还没同步过" : DomainParseDate(lastSync).ToString("yyyy-MM-dd HH:mm");
                domainRecordSub.Text = linkCount + " 个服务 · TTL " + DomainStr(record, "ttl") + "s · 上次同步 " + when;
            }

            RenderDomainLinks(DomainList(data, "links"));
        }

        private void RenderDomainLinks(List<Dictionary<string, object>> links)
        {
            domainLinksPanel.Children.Clear();

            if (links.Count == 0)
            {
                domainLinksPanel.Children.Add(new TextBlock
                {
                    Text = "还没有可发布的地址。请先同步隧道配置。",
                    FontSize = 12,
                    Foreground = MutedBrush,
                    Margin = domainRowGap
                });
                return;
            }

            foreach (Dictionary<string, object> link in links)
            {
                string url = DomainStr(link, "url");
                string name = DomainStr(link, "name");
                string kind = DomainStr(link, "kind");
                bool isWeb = kind == "web" || string.IsNullOrEmpty(kind);
                // 未启用的隧道域名也发布了（用户要求全发），但访问会 502。
                // 标出来，否则用户会以为域名绑定坏了。
                bool dormant = DomainBool(link, "enabled", true) == false;
                double rowOpacity = 1.0;

                Grid row = new Grid { Margin = domainRowGap, Opacity = rowOpacity };
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(190) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
                row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });

                StackPanel nameCol = new StackPanel();
                nameCol.Children.Add(new TextBlock
                {
                    Text = name,
                    TextWrapping = TextWrapping.Wrap,
                    Margin = new Thickness(0, 0, 12, 4),
                    FontSize = 13,
                    FontWeight = FontWeights.SemiBold,
                    Foreground = TextBrush
                });
                nameCol.Children.Add(new TextBlock
                {
                    Text = "本地 " + DomainStr(link, "localPort") + " → 端口 " + DomainStr(link, "remotePort"),
                    FontSize = 12,
                    Foreground = MutedBrush
                });
                Grid.SetColumn(nameCol, 0);
                row.Children.Add(nameCol);

                TextBlock urlText = new TextBlock
                {
                    Text = url,
                    FontSize = 12,
                    FontFamily = new FontFamily("Consolas"),
                    Foreground = AccentTextBrush,
                    VerticalAlignment = VerticalAlignment.Center,
                    TextWrapping = TextWrapping.Wrap,
                    ToolTip = url,
                    Margin = new Thickness(0, 0, 8, 0)
                };
                Grid.SetColumn(urlText, 1);
                row.Children.Add(urlText);

                StackPanel acts = new StackPanel { Orientation = Orientation.Horizontal };
                if (dormant)
                {
                    // 未启用的不给「打开」——点开会是 502，反而误导
                    acts.Children.Add(new TextBlock
                    {
                        Text = "未启用",
                        FontSize = 12,
                        FontWeight = FontWeights.Bold,
                        Foreground = new SolidColorBrush(Color.FromRgb(161, 92, 0)),
                        VerticalAlignment = VerticalAlignment.Center,
                        Margin = new Thickness(0, 0, 6, 0)
                    });
                }
                else if (isWeb)
                {
                    Button open = OutlineButton("打开", AccentBrush);
                    open.Height = 32;
                    open.MinWidth = 58;
                    open.FontSize = 12;
                    string target = url;
                    open.Click += delegate { Safe(delegate { DomainOpenInBrowser(target); }); };
                    acts.Children.Add(open);
                }
                else
                {
                    acts.Children.Add(new TextBlock
                    {
                        Text = kind + "，需客户端",
                        FontSize = 12,
                        Foreground = MutedBrush,
                        VerticalAlignment = VerticalAlignment.Center,
                        Margin = new Thickness(0, 0, 6, 0)
                    });
                }

                Button copy = OutlineButton("复制", MutedBrush);
                copy.Height = 32;
                copy.MinWidth = 58;
                copy.FontSize = 12;
                string copyTarget = url;
                copy.Click += delegate { Safe(delegate { DomainCopyToClipboard(copyTarget); }); };
                acts.Children.Add(copy);

                Grid.SetColumn(acts, 2);
                row.Children.Add(acts);

                domainLinksPanel.Children.Add(row);
            }
        }

        /* ================================================================ 操作 */

        private async void DomainSaveToggle(string key, bool value)
        {
            if (renderingDomain || string.IsNullOrEmpty(currentInstanceId)) return;
            string id = currentInstanceId;
            domainEnabledCheck.IsEnabled = domainCanWriteCheck.IsEnabled = domainAutoFollowCheck.IsEnabled = false;
            try {
                var payload = new Dictionary<string, object>(); payload[key] = value;
                await Task.Run(() => client.PutDict("/api/instances/" + id + "/domain-binding", payload));
            } catch (Exception ex) { domainPlanResult.Text = ex.Message; }
            finally {
                domainEnabledCheck.IsEnabled = domainCanWriteCheck.IsEnabled = domainAutoFollowCheck.IsEnabled = true;
                LoadDomainBinding();
            }
        }

        private async void DomainSaveToken()
        {
            string zone = (domainZoneInput.Text ?? "").Trim();
            string token = domainTokenInput.Password ?? "";
            if (zone.Length == 0 || token.Length == 0)
            {
                SetDomainMsg("域名和 Token 都要填", true);
                return;
            }

            SetDomainMsg("验证中…", false);
            domainChecksPanel.Children.Clear();
            domainSaveTokenButton.IsEnabled = false;

            try
            {
                Dictionary<string, object> payload = new Dictionary<string, object>();
                payload["zone"] = zone;
                payload["token"] = token;

                string id = currentInstanceId;
                Dictionary<string, object> result = await Task.Run(() => client.PostDict("/api/instances/" + id + "/domain-binding/token", payload, 60000));
                if (id != currentInstanceId) return;
                Dictionary<string, object> verify = result != null ? DomainDict(result, "verify") : null;

                if (verify != null)
                {
                    RenderDomainChecks(DomainList(verify, "checks"));
                }

                bool saved = result != null && DomainBool(result, "saved", false);
                if (saved)
                {
                    SetDomainMsg("授权已保存", false);
                    domainTokenInput.Password = "";
                    LoadDomainBinding();
                }
                else
                {
                    SetDomainMsg("验证未通过，看下面的明细", true);
                }
            }
            catch (Exception ex) { SetDomainMsg(ex.Message, true); }
            finally
            {
                domainSaveTokenButton.IsEnabled = true;
            }
        }

        private void RenderDomainChecks(List<Dictionary<string, object>> checks)
        {
            domainChecksPanel.Children.Clear();
            foreach (Dictionary<string, object> c in checks)
            {
                bool ok = DomainBool(c, "ok", false);
                StackPanel line = new StackPanel
                {
                    Orientation = Orientation.Horizontal,
                    Margin = new Thickness(0, 2, 0, 2)
                };
                line.Children.Add(new TextBlock
                {
                    Text = ok ? "✓" : "✗",
                    FontSize = 12,
                    FontWeight = FontWeights.Bold,
                    Foreground = ok ? AccentGreenBrush : DangerBrush,
                    Margin = new Thickness(0, 0, 6, 0)
                });
                line.Children.Add(new TextBlock
                {
                    Text = DomainStr(c, "name") + " " + DomainStr(c, "detail"),
                    FontSize = 12,
                    Foreground = MutedBrush,
                    TextWrapping = TextWrapping.Wrap,
                    MaxWidth = 640
                });
                domainChecksPanel.Children.Add(line);
            }
        }

        private async void DomainPlan()
        {
            if (string.IsNullOrEmpty(currentInstanceId)) return;
            domainPlanResult.Text = "检查中…";
            try
            {
                string id = currentInstanceId;
                domainPlanButton.IsEnabled = false;
                Dictionary<string, object> data = await Task.Run(() => client.GetDict("/api/instances/" + id + "/domain-binding/plan", 90000));
                if (id != currentInstanceId) return;
                if (data == null) { domainPlanResult.Text = "没有返回数据"; return; }

                string action = DomainStr(data, "action");
                Dictionary<string, object> record = DomainDict(data, "record");
                domainPlanResult.Text = DomainStr(data, "reason") + "（" + DomainStr(data, "total") + " 项变更）";
            }
            catch (Exception ex)
            {
                domainPlanResult.Text = ex.Message;
            }
            finally { domainPlanButton.IsEnabled = true; }
        }

        private async void DomainSync()
        {
            if (string.IsNullOrEmpty(currentInstanceId)) return;
            domainSyncButton.IsEnabled = false;
            try
            {
                string id = currentInstanceId;
                domainPlanResult.Text = "正在同步解析…";
                Dictionary<string, object> result = await Task.Run(() => client.PostDict("/api/instances/" + id + "/domain-binding/sync", new Dictionary<string, object>(), 90000));
                if (id != currentInstanceId) return;
                if (result != null)
                {
                    bool applied = DomainBool(result, "applied", false);
                    Dictionary<string, object> record = DomainDict(result, "record");
                    domainPlanResult.Text = applied
                        ? "同步完成：新增 " + DomainStr(DomainDict(result, "summary"), "create") + " · 更新 " + DomainStr(DomainDict(result, "summary"), "update") + " · 清理 " + DomainStr(DomainDict(result, "summary"), "delete")
                        : DomainStr(result, "reason");
                }
                LoadDomainBinding();
            }
            catch (Exception ex) { domainPlanResult.Text = ex.Message; }
            finally
            {
                domainSyncButton.IsEnabled = true;
            }
        }

        private void DomainCopyAll()
        {
            if (lastDomainStatus == null) return;

            Dictionary<string, object> config = DomainDict(lastDomainStatus, "config");
            string zone = DomainStr(config, "zone");
            List<Dictionary<string, object>> links = DomainList(lastDomainStatus, "links");

            StringBuilder sb = new StringBuilder();
            sb.AppendLine("88FRP 域名访问链接（" + zone + "）");
            sb.AppendLine();
            foreach (Dictionary<string, object> link in links)
            {
                string name = DomainStr(link, "name");
                string kind = DomainStr(link, "kind");
                bool dormant = DomainBool(link, "enabled", true) == false;
                sb.Append(name.PadRight(16)).Append(" ").Append(DomainStr(link, "url"));
                if (dormant) sb.Append("   [未启用，需在 88FRP 面板开启后才能访问]");
                else if (!string.IsNullOrEmpty(kind) && kind != "web") sb.Append("   [").Append(kind).Append("，需客户端打开]");
                sb.AppendLine();
            }
            sb.AppendLine();
            sb.AppendLine("说明：所有服务共用一条 A 记录，靠端口区分。");

            DomainCopyToClipboard(sb.ToString());
            domainPlanResult.Text = "已复制 " + links.Count + " 条链接";
        }

        private void SetDomainMsg(string text, bool isError)
        {
            domainAuthMsg.Text = text;
            domainAuthMsg.Foreground = isError ? DangerBrush : MutedBrush;
        }

        /* ============================================================ 取值辅助 */

        /// <summary>复制到剪贴板；失败不抛，只在界面提示</summary>
        private void DomainCopyToClipboard(string text)
        {
            try
            {
                Clipboard.SetText(text ?? "");
            }
            catch
            {
                try
                {
                    // Clipboard 偶发 COM 占用，重试一次
                    Thread.Sleep(80);
                    Clipboard.SetText(text ?? "");
                }
                catch
                {
                    SetDomainMsg("复制失败，请手动选中", true);
                }
            }
        }

        /// <summary>用系统默认浏览器打开</summary>
        private static void DomainOpenInBrowser(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
            }
            catch
            {
                // 打不开就算了，用户可自行复制链接
            }
        }

        private static Dictionary<string, object> DomainDict(Dictionary<string, object> src, string key)
        {
            if (src == null || !src.ContainsKey(key)) return null;
            return src[key] as Dictionary<string, object>;
        }

        private static List<Dictionary<string, object>> DomainList(Dictionary<string, object> src, string key)
        {
            List<Dictionary<string, object>> outList = new List<Dictionary<string, object>>();
            if (src == null || !src.ContainsKey(key)) return outList;
            object raw = src[key];
            System.Collections.IEnumerable seq = raw as System.Collections.IEnumerable;
            if (seq == null) return outList;
            foreach (object item in seq)
            {
                Dictionary<string, object> d = item as Dictionary<string, object>;
                if (d != null) outList.Add(d);
            }
            return outList;
        }

        private static string DomainStr(Dictionary<string, object> src, string key)
        {
            if (src == null || !src.ContainsKey(key) || src[key] == null) return "";
            return Convert.ToString(src[key]);
        }

        private static bool DomainBool(Dictionary<string, object> src, string key, bool fallback)
        {
            if (src == null || !src.ContainsKey(key) || src[key] == null) return fallback;
            try { return Convert.ToBoolean(src[key]); }
            catch { return fallback; }
        }

        private static DateTime DomainParseDate(string iso)
        {
            DateTime dt;
            if (DateTime.TryParse(iso, null, System.Globalization.DateTimeStyles.RoundtripKind, out dt)) return dt.ToLocalTime();
            return DateTime.Now;
        }
    }
