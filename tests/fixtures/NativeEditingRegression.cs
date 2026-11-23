using System;
using System.Collections.Generic;
using System.Reflection;
using System.Windows;
using System.Windows.Controls;

internal static class NativeEditingRegression
{
    private static object Field(MainWindow window, string name) { return typeof(MainWindow).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(window); }
    private static void Call(MainWindow window, string name) { typeof(MainWindow).GetMethod(name, BindingFlags.Instance | BindingFlags.NonPublic).Invoke(window, name == "RefreshInstances" ? new object[] { true } : null); }
    private static void ApplyOverview(MainWindow window, Dictionary<string, object> overview) { typeof(MainWindow).GetMethod("ApplyGatewayOverview", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(window, new object[] { overview, "" }); }
    private static void Require(bool ok, string message) { if (!ok) throw new Exception(message); }
    [STAThread]
    private static void Main(string[] args)
    {
        Program.ConsolePort = Int32.Parse(args[0]);
        App app = new App();
        MainWindow window = new MainWindow(false);
        try {
            Call(window, "RefreshInstances");
            var inputs = (Dictionary<string, TextBox>)Field(window, "tunnelGroupInputs");
            var checks = (Dictionary<string, CheckBox>)Field(window, "tunnelChecks");
            TextBox editor = inputs["fixture-tunnel"];
            editor.Text = "未保存的中文分组";
            editor.CaretIndex = 4;
            checks["fixture-tunnel"].IsChecked = true;
            ((TextBox)Field(window, "configBox")).Text = "unsaved configuration";
            ((TextBox)Field(window, "secretBox")).Text = "unsaved secret";
            for (int i = 0; i < 4; i++) Call(window, "RefreshInstances");
            Require(Object.ReferenceEquals(editor, inputs["fixture-tunnel"]), "Polling recreated the group editor");
            Require(editor.Text == "未保存的中文分组" && editor.CaretIndex == 4, "Polling discarded text or caret");
            Require(checks["fixture-tunnel"].IsChecked == true, "Polling discarded selection");
            Require(((TextBox)Field(window, "configBox")).Text == "unsaved configuration", "Polling discarded config draft");
            Require(((TextBox)Field(window, "secretBox")).Text == "unsaved secret", "Polling discarded sync draft");
            Require(((TextBlock)Field(window, "pidValue")).Text == "1234", "Runtime status stopped updating");

            var portalView = (StackPanel)Field(window, "gatewayPortalView");
            var onboardingView = (StackPanel)Field(window, "gatewayOnboardingView");
            var loadingView = (Border)Field(window, "gatewayLoadingView");
            var navButtons = (Dictionary<string, Button>)Field(window, "gatewayNavButtons");
            Require(portalView.Visibility == Visibility.Collapsed, "Uninitialized portal was visible before the overview loaded");
            Require(onboardingView.Visibility == Visibility.Collapsed, "Onboarding was visible before the overview loaded");
            Require(loadingView.Visibility == Visibility.Visible, "Gateway loading state was not visible on startup");
            Dictionary<string, object> uninitialized = new Dictionary<string, object>();
            uninitialized["initialized"] = false;
            uninitialized["legacyInstances"] = new object[0];
            ApplyOverview(window, uninitialized);
            Require(onboardingView.Visibility == Visibility.Visible, "Onboarding disappeared for an uninitialized device");
            Require(portalView.Visibility == Visibility.Collapsed, "Portal was visible together with onboarding");
            Require(loadingView.Visibility == Visibility.Collapsed, "Gateway loading state remained after the overview loaded");
            Require(!((Button)Field(window, "gatewayOpenPortalButton")).IsEnabled, "Portal action was enabled before initialization");
            Require(!((Button)Field(window, "gatewayHeroAdminButton")).IsEnabled, "Settings action was enabled before initialization");
            Require(navButtons["portal"].IsEnabled && !navButtons["domain"].IsEnabled, "Device navigation did not follow initialization state");

            Dictionary<string, object> device = new Dictionary<string, object>();
            device["name"] = "Fixture";
            device["domain"] = "xps.example.com";
            device["gatewayPort"] = 7777;
            Dictionary<string, object> caddy = new Dictionary<string, object>();
            caddy["status"] = "running";
            Dictionary<string, object> frpc = new Dictionary<string, object>();
            frpc["status"] = "running";
            Dictionary<string, object> runtime = new Dictionary<string, object>();
            runtime["caddy"] = caddy;
            runtime["frpc"] = frpc;
            Dictionary<string, object> initialized = new Dictionary<string, object>();
            initialized["initialized"] = true;
            initialized["device"] = device;
            initialized["runtime"] = runtime;
            initialized["services"] = new object[0];
            ApplyOverview(window, initialized);
            Require(portalView.Visibility == Visibility.Visible, "Initialized portal did not appear");
            Require(onboardingView.Visibility == Visibility.Collapsed, "Onboarding remained after initialization");
            Require(((Button)Field(window, "gatewayOpenPortalButton")).IsEnabled, "Portal action was not enabled after initialization");
            Require(navButtons["domain"].IsEnabled, "Device navigation remained disabled after initialization");
            Console.WriteLine("PASS: runtime polls preserve editor identity, Chinese text, caret, selection and drafts");
            Console.WriteLine("PASS: gateway first screen follows initialization state");
        } finally { ((System.Windows.Forms.NotifyIcon)Field(window, "trayIcon")).Dispose(); }
    }
}
